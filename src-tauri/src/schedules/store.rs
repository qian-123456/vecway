//! Schedules and schedule runs store (rusqlite).
//! Pure next_run calculation (DST-safe with chrono Local).

use chrono::{DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, TimeZone, Weekday};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::HashSet;

use crate::contracts::{
    AutomationOverlapPolicy, Schedule, ScheduleAgentTrigger, ScheduleCadence, ScheduleDraft,
    ScheduleLifecycle, ScheduleNotify, ScheduleRun, ScheduleRunMode, ScheduleRunPhase,
    ScheduleRunStatus,
};

pub fn parse_time(s: &str) -> Option<(u32, u32)> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some((h, m))
}

/// Map a `LocalResult` to a concrete instant: ambiguous (DST fall-back) picks
/// the earlier occurrence; a gap (DST spring-forward) retries at +1h.
pub(crate) fn from_local_result(
    res: LocalResult<DateTime<Local>>,
    naive: chrono::NaiveDateTime,
) -> Option<DateTime<Local>> {
    match res {
        LocalResult::Single(dt) => Some(dt),
        LocalResult::Ambiguous(dt1, _) => Some(dt1),
        LocalResult::None => {
            naive
                .checked_add_signed(Duration::hours(1))
                .and_then(|alt| match Local.from_local_datetime(&alt) {
                    LocalResult::Single(dt) => Some(dt),
                    LocalResult::Ambiguous(dt1, _) => Some(dt1),
                    LocalResult::None => None,
                })
        }
    }
}

fn resolve_local(naive: chrono::NaiveDateTime) -> Option<DateTime<Local>> {
    let res = Local.from_local_datetime(&naive);
    from_local_result(res, naive)
}

/// Days in a proleptic-Gregorian month (leap-aware).
fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        _ => 28,
    }
}

/// Pure calculation of the earliest next run time strictly after `after`.
/// Respects local timezone and DST transitions. `None` = this cadence can
/// never fire again (a `once` whose instant already passed).
pub fn next_run(cadence: &ScheduleCadence, after: DateTime<Local>) -> Option<DateTime<Local>> {
    match cadence {
        ScheduleCadence::Interval { minutes } => {
            let mins = (*minutes).max(1) as i64;
            Some(after + Duration::minutes(mins))
        }
        ScheduleCadence::Once { at } => DateTime::parse_from_rfc3339(at)
            .ok()
            .map(|dt| dt.with_timezone(&Local))
            .filter(|dt| *dt > after),
        ScheduleCadence::Daily {
            time,
            weekdays,
            every,
            anchor,
        } => {
            let (h, m) = parse_time(time).unwrap_or((9, 0));
            let allowed_weekdays: Option<HashSet<u32>> = if weekdays.is_empty() {
                None
            } else {
                Some(weekdays.iter().map(|&w| w % 7).collect())
            };
            // `every` > 1 repeats on the phase fixed by `anchor` (a local date;
            // defaults to `after`'s date): without weekdays, occurrences are
            // `anchor + k*every` days; with weekdays, whole weeks — weeks start
            // on Monday — are picked every `every` weeks counting from the
            // anchor's week, and the listed weekdays inside them fire. `every`
            // <= 1 keeps the legacy behavior regardless of `anchor`.
            let every = (*every).max(1) as i64;
            let anchor_date = anchor
                .as_deref()
                .and_then(|a| NaiveDate::parse_from_str(a, "%Y-%m-%d").ok())
                .unwrap_or_else(|| after.date_naive());
            let anchor_week = anchor_date.week(Weekday::Mon).first_day();
            // Wide enough to always contain the next occurrence even when the
            // matching instant on the first in-phase day/week already passed.
            let horizon = if allowed_weekdays.is_some() {
                7 * every + 7
            } else {
                (2 * every + 1).max(14)
            };

            let start_date = after.date_naive();
            for day_offset in 0..horizon {
                let candidate_date = start_date + Duration::days(day_offset);
                if let Some(set) = &allowed_weekdays {
                    if !set.contains(&candidate_date.weekday().num_days_from_sunday()) {
                        continue;
                    }
                    if every > 1 {
                        let week = candidate_date.week(Weekday::Mon).first_day();
                        let weeks_since_anchor = (week - anchor_week).num_days() / 7;
                        if weeks_since_anchor < 0 || weeks_since_anchor % every != 0 {
                            continue;
                        }
                    }
                } else if every > 1
                    && (candidate_date < anchor_date
                        || (candidate_date - anchor_date).num_days() % every != 0)
                {
                    continue;
                }

                let Some(naive_dt) = candidate_date.and_hms_opt(h, m, 0) else {
                    continue;
                };

                if let Some(dt) = resolve_local(naive_dt) {
                    if dt > after {
                        return Some(dt);
                    }
                }
            }
            Some(after + Duration::hours(24))
        }
        ScheduleCadence::Monthly {
            day,
            time,
            every,
            anchor,
        } => {
            let (h, m) = parse_time(time).unwrap_or((9, 0));
            let day = (*day).clamp(1, 31);
            let start = after.date_naive();
            // `every` > 1 repeats every `every` months counted from `anchor`'s
            // month (defaults to `after`'s month), keeping the day-clamp.
            let every = (*every).max(1) as i64;
            let anchor_date = anchor
                .as_deref()
                .and_then(|a| NaiveDate::parse_from_str(a, "%Y-%m-%d").ok())
                .unwrap_or(start);
            let anchor_idx = anchor_date.year() * 12 + (anchor_date.month() as i32 - 1);
            // Scan months: legacy scanned 13; `every` > 1 needs up to 2*every+1
            // (an in-phase month whose instant passed pushes to the next).
            let horizon = (2 * every + 1).max(13) as i32;
            let start_idx = start.year() * 12 + (start.month() as i32 - 1);
            for i in 0..horizon {
                let idx = start_idx + i;
                let months_since_anchor = (idx - anchor_idx) as i64;
                if every > 1 && (months_since_anchor < 0 || months_since_anchor % every != 0) {
                    continue;
                }
                let (y, mo) = (idx.div_euclid(12), idx.rem_euclid(12) as u32 + 1);
                let Some(candidate_date) =
                    NaiveDate::from_ymd_opt(y, mo, day.min(days_in_month(y, mo)))
                else {
                    continue;
                };
                if candidate_date < start {
                    continue;
                }
                let Some(naive_dt) = candidate_date.and_hms_opt(h, m, 0) else {
                    continue;
                };
                if let Some(dt) = resolve_local(naive_dt) {
                    if dt > after {
                        return Some(dt);
                    }
                }
            }
            Some(after + Duration::days(31))
        }
    }
}

/// Fire time for a schedule that becomes (or stays) enabled. Unlike `next_run`
/// a `once` whose instant already passed returns the instant itself so the
/// scheduler catches it up immediately; a recurring cadence bounded by
/// `end_at` (inclusive) yields `None` when the next occurrence lands past it.
pub fn next_run_bounded(
    cadence: &ScheduleCadence,
    end_at: Option<&str>,
    now: DateTime<Local>,
) -> Option<DateTime<Local>> {
    let end = end_at.and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    let next = match cadence {
        ScheduleCadence::Once { at } => DateTime::parse_from_rfc3339(at)
            .ok()
            .map(|dt| dt.with_timezone(&Local)),
        _ => next_run(cadence, now),
    };
    match (next, end) {
        (Some(n), Some(e)) if n > e => None,
        (next, _) => next,
    }
}

/// Derive lifecycle from the current occurrence. Run history survives a
/// reschedule; `last_run_at` is cleared when a one-shot gets a new instant.
pub fn derive_lifecycle(s: &Schedule, _has_run: bool, now: DateTime<Local>) -> ScheduleLifecycle {
    let completed = match &s.cadence {
        ScheduleCadence::Once { .. } => s.last_run_at.is_some(),
        _ => {
            let capped = s.max_runs.is_some_and(|max| s.runs_done >= max);
            capped
                || s.end_at
                    .as_deref()
                    .and_then(|e| DateTime::parse_from_rfc3339(e).ok())
                    .map(|end| next_run(&s.cadence, now).map(|n| n > end).unwrap_or(true))
                    .unwrap_or(false)
        }
    };
    if completed {
        ScheduleLifecycle::Completed
    } else if !s.enabled {
        ScheduleLifecycle::Paused
    } else {
        ScheduleLifecycle::Active
    }
}

/// Draft validation shared by create and edit; errors are Chinese UI strings.
fn validate_draft(draft: &ScheduleDraft, prev: Option<&Schedule>) -> Result<(), String> {
    let has_probe = draft
        .probe_command
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    let has_prompt = !draft.prompt.trim().is_empty();
    match draft.agent_trigger {
        ScheduleAgentTrigger::Never => {
            if !has_probe {
                return Err("请填写本地脚本或命令".to_string());
            }
        }
        ScheduleAgentTrigger::OnSignal => {
            if !has_probe || !has_prompt {
                return Err("请填写前置脚本与唤醒后的处理指令".to_string());
            }
        }
        ScheduleAgentTrigger::Always => {
            if !has_prompt {
                return Err("请填写自动化指令".to_string());
            }
        }
    }
    let now = Local::now();
    match &draft.cadence {
        ScheduleCadence::Interval { minutes } => {
            if *minutes < 1 {
                return Err("间隔至少 1 分钟".to_string());
            }
        }
        ScheduleCadence::Daily {
            time,
            every,
            anchor,
            ..
        }
        | ScheduleCadence::Monthly {
            time,
            every,
            anchor,
            ..
        } => {
            if parse_time(time).is_none() {
                return Err("时间格式需为 HH:MM".to_string());
            }
            if !(1..=999).contains(every) {
                return Err("重复间隔需在 1-999 之间".to_string());
            }
            if let Some(anchor) = anchor.as_deref() {
                if NaiveDate::parse_from_str(anchor, "%Y-%m-%d").is_err() {
                    return Err("重复起始日期格式需为 YYYY-MM-DD".to_string());
                }
            }
            if let ScheduleCadence::Monthly { day, .. } = &draft.cadence {
                if !(1..=31).contains(day) {
                    return Err("每月日期需在 1-31 之间".to_string());
                }
            }
        }
        ScheduleCadence::Once { at } => {
            let target =
                DateTime::parse_from_rfc3339(at).map_err(|_| "时间格式需为 RFC3339".to_string())?;
            // An unchanged instant stays valid (e.g. editing a completed once);
            // only a new time must lie in the future.
            let unchanged = matches!(prev, Some(p) if matches!(&p.cadence,
                ScheduleCadence::Once { at: prev_at }
                    if DateTime::parse_from_rfc3339(prev_at).ok() == Some(target)));
            if !unchanged && target <= now {
                return Err("请选择未来的时间".to_string());
            }
        }
    }
    if let Some(end) = draft.end_at.as_deref() {
        let end_dt = DateTime::parse_from_rfc3339(end)
            .map_err(|_| "结束时间格式需为 RFC3339".to_string())?;
        if end_dt <= now {
            return Err("结束时间需晚于现在".to_string());
        }
    }
    if let Some(max_runs) = draft.max_runs {
        if max_runs == 0 {
            return Err("运行次数需至少为 1".to_string());
        }
    }
    Ok(())
}
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn parse_agent_trigger(s: &str) -> ScheduleAgentTrigger {
    match s {
        "on_signal" => ScheduleAgentTrigger::OnSignal,
        "never" => ScheduleAgentTrigger::Never,
        _ => ScheduleAgentTrigger::Always,
    }
}

fn agent_trigger_as_str(t: ScheduleAgentTrigger) -> &'static str {
    match t {
        ScheduleAgentTrigger::Always => "always",
        ScheduleAgentTrigger::OnSignal => "on_signal",
        ScheduleAgentTrigger::Never => "never",
    }
}

fn parse_result_mode(s: &str) -> crate::contracts::ScheduleResultMode {
    match s {
        "llm_summary" => crate::contracts::ScheduleResultMode::LlmSummary,
        _ => crate::contracts::ScheduleResultMode::Structured,
    }
}

fn result_mode_as_str(m: crate::contracts::ScheduleResultMode) -> &'static str {
    match m {
        crate::contracts::ScheduleResultMode::Structured => "structured",
        crate::contracts::ScheduleResultMode::LlmSummary => "llm_summary",
    }
}

fn parse_run_phase(s: &str) -> ScheduleRunPhase {
    match s {
        "probe_quiet" => ScheduleRunPhase::ProbeQuiet,
        "probe_only" => ScheduleRunPhase::ProbeOnly,
        "awaiting" => ScheduleRunPhase::Awaiting,
        _ => ScheduleRunPhase::Agent,
    }
}

fn run_phase_as_str(p: ScheduleRunPhase) -> &'static str {
    match p {
        ScheduleRunPhase::ProbeQuiet => "probe_quiet",
        ScheduleRunPhase::ProbeOnly => "probe_only",
        ScheduleRunPhase::Agent => "agent",
        ScheduleRunPhase::Awaiting => "awaiting",
    }
}

fn row_to_schedule(r: &Row) -> rusqlite::Result<Schedule> {
    let run_mode_str: String = r.get(4)?;
    let cadence_str: String = r.get(5)?;
    let enabled_int: i32 = r.get(9)?;
    let notify_str: String = r.get(16)?;
    let new_chat_int: i32 = r.get(17)?;
    let agent_trigger_str: String = r.get(23)?;

    let run_mode = match run_mode_str.as_str() {
        "worktree" => ScheduleRunMode::Worktree,
        _ => ScheduleRunMode::Local,
    };
    let notify = match notify_str.as_str() {
        "important" => ScheduleNotify::Important,
        "none" => ScheduleNotify::None,
        _ => ScheduleNotify::All,
    };
    let cadence: ScheduleCadence =
        serde_json::from_str(&cadence_str).unwrap_or(ScheduleCadence::Interval { minutes: 60 });

    let schedule = Schedule {
        id: r.get(0)?,
        name: r.get(1)?,
        prompt: r.get(2)?,
        cwd: r.get(3)?,
        mode: crate::contracts::SpaceMode::from_str_lossy(&r.get::<_, String>(20)?),
        run_mode,
        cadence,
        model: r.get(6)?,
        thinking: r.get(7)?,
        approval_mode: r.get(8)?,
        enabled: enabled_int != 0,
        next_run_at: r.get(10)?,
        last_run_at: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
        last_run_status: r
            .get::<_, Option<String>>(15)?
            .as_deref()
            .map(parse_run_status),
        end_at: r.get(14)?,
        notify,
        new_chat_each_run: new_chat_int != 0,
        max_runs: r
            .get::<_, Option<i64>>(18)?
            .and_then(|v| u32::try_from(v).ok()),
        runs_done: r.get::<_, i64>(19)?.max(0) as u32,
        lifecycle: ScheduleLifecycle::Active,
        probe_command: r.get(21)?,
        probe_description: r.get(22)?,
        agent_trigger: parse_agent_trigger(&agent_trigger_str),
        last_run_phase: r
            .get::<_, Option<String>>(24)?
            .as_deref()
            .map(parse_run_phase),
        last_run_session_id: r.get(25)?,
        result_mode: parse_result_mode(&r.get::<_, String>(26)?),
        invokes_external_model: r.get::<_, i32>(27)? != 0,
    };
    let lifecycle = derive_lifecycle(&schedule, false, Local::now());
    Ok(Schedule {
        lifecycle,
        ..schedule
    })
}

fn parse_run_status(s: &str) -> ScheduleRunStatus {
    match s {
        "running" => ScheduleRunStatus::Running,
        "ok" => ScheduleRunStatus::Ok,
        "skipped" => ScheduleRunStatus::Skipped,
        _ => ScheduleRunStatus::Error,
    }
}

fn row_to_run(r: &Row) -> rusqlite::Result<ScheduleRun> {
    let status_str: String = r.get(3)?;
    let status = parse_run_status(&status_str);
    let phase_str: String = r.get(7)?;

    Ok(ScheduleRun {
        id: r.get(0)?,
        schedule_id: r.get(1)?,
        session_id: r.get(2)?,
        status,
        started_at: r.get(4)?,
        finished_at: r.get(5)?,
        summary: r.get(6)?,
        phase: parse_run_phase(&phase_str),
        probe_output: r.get(8)?,
        worktree_repo_root: r.get(9)?,
        worktree_path: r.get(10)?,
        worktree_branch: r.get(11)?,
    })
}

const SCHEDULE_SELECT: &str = "\
    SELECT s.id, s.name, s.prompt, s.cwd, s.run_mode, s.cadence, s.model, s.thinking, s.approval_mode, \
           s.enabled, s.next_run_at, s.last_run_at, s.created_at, s.updated_at, s.end_at, \
           lr.status, s.notify, s.new_chat_each_run, s.max_runs, s.runs_done, s.mode, \
           s.probe_command, s.probe_description, s.agent_trigger, \
           lr.phase, lr.session_id, s.result_mode, s.invokes_external_model \
    FROM schedules s \
    LEFT JOIN schedule_runs lr ON lr.id = (\
        SELECT r.id FROM schedule_runs r WHERE r.schedule_id = s.id ORDER BY r.started_at DESC LIMIT 1\
    )";

const RUN_COLS: &str =
    "id, schedule_id, session_id, status, started_at, finished_at, summary, phase, probe_output, worktree_repo_root, worktree_path, worktree_branch";

pub fn list(conn: &Connection) -> Result<Vec<Schedule>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("{SCHEDULE_SELECT} ORDER BY s.created_at DESC"))?;
    let rows = stmt.query_map([], row_to_schedule)?;
    rows.collect()
}

/// Atomically persist `<data_dir>/automations/catalog.json` from a pre-fetched
/// schedule list so callers can release the DB mutex before JSON serialization
/// and filesystem I/O.
pub fn write_catalog_snapshot_items(items: &[Schedule]) {
    static SNAP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = crate::paths::automations_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let summary: Vec<serde_json::Value> = items
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "name": s.name,
                "enabled": s.enabled,
                "lifecycle": s.lifecycle,
                "cwd": s.cwd,
                "cadence": s.cadence,
                "agentTrigger": s.agent_trigger,
                "resultMode": s.result_mode,
                "invokesExternalModel": s.invokes_external_model,
                "model": s.model,
                "thinking": s.thinking,
                "probeDescription": s.probe_description,
                "probeCommand": s.probe_command,
                "nextRunAt": s.next_run_at,
                "lastRunStatus": s.last_run_status,
            })
        })
        .collect();
    let Ok(body) = serde_json::to_string_pretty(&summary) else {
        return;
    };
    let target = dir.join("catalog.json");
    let seq = SNAP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!("catalog.{}.{seq}.tmp", std::process::id()));
    if std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, &target).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Atomically persist `<data_dir>/automations/catalog.json` so the OMP automation
/// extension can inspect existing automations synchronously without spawning a DB reader.
pub fn write_catalog_snapshot(conn: &Connection) {
    let Ok(items) = list(conn) else {
        return;
    };
    write_catalog_snapshot_items(&items);
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Schedule>, rusqlite::Error> {
    conn.query_row(
        &format!("{SCHEDULE_SELECT} WHERE s.id = ?1"),
        params![id],
        row_to_schedule,
    )
    .optional()
}

/// Normalize a draft cadence for storage: `every` > 1 needs an `anchor` (a
/// local date fixing the repeat phase) — a missing anchor defaults to
/// `today`; `every` <= 1 never stores one (it has no effect).
fn normalize_cadence(cadence: &ScheduleCadence, today: NaiveDate) -> ScheduleCadence {
    let mut cadence = cadence.clone();
    if let ScheduleCadence::Daily { every, anchor, .. }
    | ScheduleCadence::Monthly { every, anchor, .. } = &mut cadence
    {
        *anchor = if *every > 1 {
            anchor
                .take()
                .or_else(|| Some(today.format("%Y-%m-%d").to_string()))
        } else {
            None
        };
    }
    cadence
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateScheduleError {
    Conflict(String),
    Invalid(String),
}

impl From<String> for CreateScheduleError {
    fn from(msg: String) -> Self {
        Self::Invalid(msg)
    }
}

struct PreparedScheduleFields {
    run_mode_str: &'static str,
    notify_str: &'static str,
    cadence: ScheduleCadence,
    cadence_json: String,
    end_at: Option<String>,
    max_runs: Option<u32>,
    probe_command: Option<String>,
    probe_description: Option<String>,
    agent_trigger_str: &'static str,
    result_mode_str: &'static str,
    invokes_external_model_int: i32,
}

fn prepare_schedule_fields(draft: &ScheduleDraft, now: DateTime<Local>) -> PreparedScheduleFields {
    let run_mode_str = match draft.run_mode {
        ScheduleRunMode::Worktree => "worktree",
        ScheduleRunMode::Local => "local",
    };
    let notify_str = match draft.notify {
        ScheduleNotify::Important => "important",
        ScheduleNotify::None => "none",
        ScheduleNotify::All => "all",
    };
    // Fill/normalize `anchor` before persisting so `next_run` always sees a
    // stable phase (and stored cadences round-trip through `keep` checks).
    let cadence = normalize_cadence(&draft.cadence, now.date_naive());
    let cadence_json = serde_json::to_string(&cadence).unwrap_or_default();
    // `end_at` and `max_runs` are recurring-only; `once` ignores both (contract).
    let end_at = match &cadence {
        ScheduleCadence::Once { .. } => None,
        _ => draft.end_at.clone(),
    };
    let max_runs = match &cadence {
        ScheduleCadence::Once { .. } => None,
        _ => draft.max_runs,
    };
    let probe_command = draft
        .probe_command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let probe_description = draft
        .probe_description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    PreparedScheduleFields {
        run_mode_str,
        notify_str,
        cadence,
        cadence_json,
        end_at,
        max_runs,
        probe_command,
        probe_description,
        agent_trigger_str: agent_trigger_as_str(draft.agent_trigger),
        result_mode_str: result_mode_as_str(draft.result_mode),
        invokes_external_model_int: draft.invokes_external_model as i32,
    }
}

fn insert_schedule_row(
    conn: &Connection,
    draft: &ScheduleDraft,
    fields: &PreparedScheduleFields,
    ts: &str,
    now: DateTime<Local>,
) -> Result<Schedule, CreateScheduleError> {
    let id = draft
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let next_run_at = if draft.enabled {
        next_run_bounded(&fields.cadence, fields.end_at.as_deref(), now).map(|dt| dt.to_rfc3339())
    } else {
        None
    };
    let enabled = (draft.enabled && next_run_at.is_some()) as i32;

    conn.execute(
        "INSERT INTO schedules(id, name, prompt, cwd, run_mode, cadence, model, thinking, approval_mode, enabled, next_run_at, last_run_at, end_at, notify, new_chat_each_run, max_runs, created_at, updated_at, mode, probe_command, probe_description, agent_trigger, result_mode, invokes_external_model)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13, ?14, ?15, ?16, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
        params![
            id,
            draft.name,
            draft.prompt,
            draft.cwd,
            fields.run_mode_str,
            fields.cadence_json,
            draft.model,
            draft.thinking,
            draft.approval_mode,
            enabled,
            next_run_at,
            fields.end_at,
            fields.notify_str,
            draft.new_chat_each_run as i32,
            fields.max_runs,
            ts,
            draft.mode.as_str(),
            fields.probe_command,
            fields.probe_description,
            fields.agent_trigger_str,
            fields.result_mode_str,
            fields.invokes_external_model_int,
        ],
    )
    .map_err(|e| match &e {
        rusqlite::Error::SqliteFailure(err, msg)
            if err.code == rusqlite::ErrorCode::ConstraintViolation
                || msg
                    .as_deref()
                    .is_some_and(|m| m.contains("UNIQUE constraint failed")) =>
        {
            CreateScheduleError::Conflict("自动化 ID 已存在".to_string())
        }
        _ => CreateScheduleError::Invalid(e.to_string()),
    })?;

    get(conn, &id)
        .map_err(|e| CreateScheduleError::Invalid(e.to_string()))?
        .ok_or_else(|| CreateScheduleError::Invalid("自动化不存在".to_string()))
}

/// Insert a brand-new schedule atomically, preserving an unused caller-supplied
/// `draft.id` and mapping primary-key constraint violations to `Conflict`.
pub fn create_new(
    conn: &Connection,
    draft: &ScheduleDraft,
) -> Result<Schedule, CreateScheduleError> {
    validate_draft(draft, None).map_err(CreateScheduleError::Invalid)?;
    let now = Local::now();
    let ts = now_rfc3339();
    let fields = prepare_schedule_fields(draft, now);
    insert_schedule_row(conn, draft, &fields, &ts, now)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateScheduleError {
    Conflict(String),
    NotFound(String),
    Invalid(String),
}

impl From<String> for UpdateScheduleError {
    fn from(msg: String) -> Self {
        Self::Invalid(msg)
    }
}

fn update_existing_schedule(
    conn: &Connection,
    id: &str,
    prev: &Schedule,
    draft: &ScheduleDraft,
    ts: &str,
    now: DateTime<Local>,
) -> Result<Schedule, String> {
    let fields = prepare_schedule_fields(draft, now);
    let cadence = &fields.cadence;
    let end_at = &fields.end_at;
    let max_runs = fields.max_runs;
    let rescheduled_once = match (&prev.cadence, cadence) {
        (ScheduleCadence::Once { at: old }, ScheduleCadence::Once { at: new }) => {
            DateTime::parse_from_rfc3339(old).ok() != DateTime::parse_from_rfc3339(new).ok()
        }
        (_, ScheduleCadence::Once { .. }) => true,
        _ => false,
    };
    if rescheduled_once && has_active_run(conn, id).map_err(|e| e.to_string())? {
        return Err("任务仍在运行，请结束后再改期".to_string());
    }
    if draft.enabled && !prev.enabled {
        // Re-enabling a completed once is refused unless `at` moved to a
        // new (future) instant — that is a reschedule, not a re-enable.
        if let ScheduleCadence::Once { at } = &draft.cadence {
            let same_instant = matches!(&prev.cadence,
                ScheduleCadence::Once { at: prev_at }
                    if DateTime::parse_from_rfc3339(prev_at).ok()
                        == DateTime::parse_from_rfc3339(at).ok());
            let ran = prev.last_run_at.is_some();
            if ran && same_instant {
                return Err("一次性任务已执行，请复制或重新创建".to_string());
            }
        }
    }

    // Editing while capped at `max_runs` stays completed; raising/removing
    // the cap re-derives a fresh fire time (`runs_done` is kept).
    let cap_reached = max_runs.is_some_and(|max| prev.runs_done >= max);
    let next_run_at = if !draft.enabled || cap_reached {
        None
    } else {
        // Keep the stored instant when nothing timing-related changed.
        let keep = prev.enabled
            && prev.cadence == *cadence
            && prev.end_at == *end_at
            && prev.next_run_at.is_some();
        if keep {
            prev.next_run_at.clone()
        } else {
            next_run_bounded(cadence, end_at.as_deref(), now).map(|dt| dt.to_rfc3339())
        }
    };
    // A schedule that can never fire again (once ran / once time passed /
    // recurring past end_at or its run cap) is stored disabled → `completed`.
    let enabled = (draft.enabled && next_run_at.is_some()) as i32;

    conn.execute(
        "UPDATE schedules
         SET name = ?2, prompt = ?3, cwd = ?4, run_mode = ?5, cadence = ?6,
             model = ?7, thinking = ?8, approval_mode = ?9, enabled = ?10,
             next_run_at = ?11, end_at = ?12, updated_at = ?13,
             notify = ?14, new_chat_each_run = ?15, max_runs = ?16,
             last_run_at = CASE WHEN ?17 THEN NULL ELSE last_run_at END, mode = ?18,
             probe_command = ?19, probe_description = ?20, agent_trigger = ?21,
             result_mode = ?22, invokes_external_model = ?23
         WHERE id = ?1",
        params![
            id,
            draft.name,
            draft.prompt,
            draft.cwd,
            fields.run_mode_str,
            fields.cadence_json,
            draft.model,
            draft.thinking,
            draft.approval_mode,
            enabled,
            next_run_at,
            end_at,
            ts,
            fields.notify_str,
            draft.new_chat_each_run as i32,
            max_runs,
            rescheduled_once,
            draft.mode.as_str(),
            fields.probe_command,
            fields.probe_description,
            fields.agent_trigger_str,
            fields.result_mode_str,
            fields.invokes_external_model_int,
        ],
    )
    .map_err(|e| e.to_string())?;

    get(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "自动化不存在".to_string())
}

/// Update an existing schedule atomically after checking an optional `expected_updated_at`
/// revision token inside the DB connection lock.
pub fn upsert_checked(
    conn: &Connection,
    draft: &ScheduleDraft,
    expected_updated_at: Option<&str>,
) -> Result<Schedule, UpdateScheduleError> {
    let id = draft
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| UpdateScheduleError::Invalid("缺少自动化 ID".to_string()))?;
    let prev = get(conn, id)
        .map_err(|e| UpdateScheduleError::Invalid(e.to_string()))?
        .ok_or_else(|| UpdateScheduleError::NotFound("自动化不存在".to_string()))?;
    if let Some(exp) = expected_updated_at.map(str::trim).filter(|s| !s.is_empty()) {
        if prev.updated_at != exp {
            return Err(UpdateScheduleError::Conflict(
                "自动化配置已在其他端更新，请刷新后再保存".to_string(),
            ));
        }
    }
    validate_draft(draft, Some(&prev)).map_err(UpdateScheduleError::Invalid)?;
    let now = Local::now();
    let ts = now_rfc3339();
    update_existing_schedule(conn, id, &prev, draft, &ts, now).map_err(UpdateScheduleError::Invalid)
}

pub fn upsert(conn: &Connection, draft: &ScheduleDraft) -> Result<Schedule, String> {
    let ts = now_rfc3339();
    let prev = draft
        .id
        .as_ref()
        .map(|id| get(conn, id))
        .transpose()
        .map_err(|e| e.to_string())?
        .flatten();

    validate_draft(draft, prev.as_ref())?;

    let now = Local::now();
    if let (Some(id), Some(prev)) = (draft.id.as_ref(), prev.as_ref()) {
        return update_existing_schedule(conn, id, prev, draft, &ts, now);
    }

    let fields = prepare_schedule_fields(draft, now);
    insert_schedule_row(conn, draft, &fields, &ts, now).map_err(|e| match e {
        CreateScheduleError::Conflict(msg) | CreateScheduleError::Invalid(msg) => msg,
    })
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if has_active_run(&tx, id).map_err(|e| e.to_string())? {
        return Err("任务仍在运行，请结束后再删除".to_string());
    }
    tx.execute("DELETE FROM schedules WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<Schedule, String> {
    let prev = get(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "自动化不存在".to_string())?;
    let next_run_at = if enabled {
        if matches!(prev.cadence, ScheduleCadence::Once { .. }) && prev.last_run_at.is_some() {
            return Err("一次性任务已执行，请复制或重新创建".to_string());
        }
        // A schedule that already reached its run cap stays completed; raising
        // or clearing `max_runs` goes through `schedules_save` instead.
        if prev.max_runs.is_some_and(|max| prev.runs_done >= max) {
            return Err("已达到运行次数上限，请先编辑任务".to_string());
        }
        let next = next_run_bounded(&prev.cadence, prev.end_at.as_deref(), Local::now())
            .ok_or_else(|| {
                if matches!(prev.cadence, ScheduleCadence::Once { .. }) {
                    "一次性任务已执行，请复制或重新创建".to_string()
                } else {
                    "结束时间已过，请先修改结束时间".to_string()
                }
            })?;
        Some(next.to_rfc3339())
    } else {
        None
    };
    let ts = now_rfc3339();

    conn.execute(
        "UPDATE schedules SET enabled = ?2, next_run_at = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, enabled as i32, next_run_at, ts],
    )
    .map_err(|e| e.to_string())?;

    get(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "自动化不存在".to_string())
}

/// Advance a schedule after a run was dispatched: stamps `last_run_at` and
/// computes the next fire time. A `once` that ran or a recurring schedule
/// whose `end_at` is passed becomes `enabled=0, next_run_at=NULL`.
pub fn advance_after_run(
    conn: &Connection,
    schedule: &Schedule,
    fired_at: DateTime<Local>,
) -> Result<(), rusqlite::Error> {
    // A `once` always completes after dispatching (even a manual run before
    // `at`); recurring cadences stop when the next occurrence lands past `end_at`.
    let next = match &schedule.cadence {
        ScheduleCadence::Once { .. } => None,
        _ => next_run(&schedule.cadence, fired_at).and_then(|n| {
            match schedule
                .end_at
                .as_deref()
                .and_then(|e| DateTime::parse_from_rfc3339(e).ok())
            {
                Some(end) if n > end => None,
                _ => Some(n),
            }
        }),
    };
    let ts = now_rfc3339();
    match next {
        Some(next) => conn.execute(
            "UPDATE schedules SET last_run_at = ?2, next_run_at = ?3, updated_at = ?4 WHERE id = ?1",
            params![schedule.id, fired_at.to_rfc3339(), next.to_rfc3339(), ts],
        )?,
        None => conn.execute(
            "UPDATE schedules SET last_run_at = ?2, enabled = 0, next_run_at = NULL, updated_at = ?3 WHERE id = ?1",
            params![schedule.id, fired_at.to_rfc3339(), ts],
        )?,
    };
    Ok(())
}

/// Record that a run actually started: stamps `last_run_at` and increments
/// `runs_done`. When the increment reaches `max_runs` the schedule completes
/// (`enabled=0, next_run_at=NULL`); a `once` never stores a cap so its
/// existing completion path is unchanged. Skipped runs never reach this
/// (they were not started).
pub fn record_run_start(conn: &Connection, id: &str, at: &str) -> Result<(), rusqlite::Error> {
    let ts = now_rfc3339();
    conn.execute(
        "UPDATE schedules SET last_run_at = ?2, runs_done = runs_done + 1, updated_at = ?3 WHERE id = ?1",
        params![id, at, ts],
    )?;
    conn.execute(
        "UPDATE schedules SET enabled = 0, next_run_at = NULL, updated_at = ?2
         WHERE id = ?1 AND max_runs IS NOT NULL AND runs_done >= max_runs",
        params![id, ts],
    )?;
    Ok(())
}

/// Claim and count a run in one transaction while the caller holds the DB lock.
/// Automatic dispatch also checks the exact due occurrence, not its old snapshot.
pub fn claim_run(
    conn: &Connection,
    schedule_id: &str,
    run_id: &str,
    expected_next: Option<&str>,
) -> Result<(Schedule, ScheduleRun, AutomationOverlapPolicy), String> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let schedule = get(&tx, schedule_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "自动化不存在".to_string())?;
    let policy = crate::db::load_automation_overlap_policy(&tx);
    let now = Local::now();
    if let Some(expected) = expected_next {
        let due = DateTime::parse_from_rfc3339(expected)
            .map(|at| at <= now)
            .unwrap_or(false);
        if !schedule.enabled || schedule.next_run_at.as_deref() != Some(expected) || !due {
            return Err("任务的计划时间已改变".to_string());
        }
    }
    let fired_at = if policy == AutomationOverlapPolicy::Skip {
        now
    } else {
        expected_next
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Local))
            .unwrap_or(now)
    };
    if schedule
        .max_runs
        .is_some_and(|max| schedule.runs_done >= max)
    {
        return Err("已达到运行次数上限，请先编辑任务".to_string());
    }
    if matches!(schedule.cadence, ScheduleCadence::Once { .. }) && schedule.last_run_at.is_some() {
        return Err("一次性任务已执行，请先改期或复制任务".to_string());
    }
    let active = has_active_run(&tx, schedule_id).map_err(|e| e.to_string())?;
    if expected_next.is_none() && active {
        return Err("该任务上一次运行仍在进行中".to_string());
    }
    if let Some(expected) = expected_next {
        let serial = policy != AutomationOverlapPolicy::Parallel;
        let awaiting = if serial {
            find_open_awaiting_session(&tx, schedule_id).map_err(|e| e.to_string())?
        } else {
            None
        };
        let pending: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schedule_pending WHERE schedule_id = ?1)",
                params![schedule_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let active_waiting: Option<String> = if active {
            tx.query_row(
                "SELECT COALESCE(summary, '等待人工确认') FROM schedule_runs
                 WHERE schedule_id = ?1 AND status = 'running' AND phase = 'awaiting' LIMIT 1",
                params![schedule_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        } else {
            None
        };
        if serial && (active || awaiting.is_some() || pending) {
            let reason = if let Some(reason) = active_waiting.as_deref() {
                reason
            } else if awaiting.is_some() {
                "等待人工确认"
            } else if active {
                "上一次运行仍在进行中"
            } else {
                "此前触发仍在排队"
            };
            match policy {
                AutomationOverlapPolicy::Skip => {
                    let summary = format!("{reason}，已跳过");
                    let sid = awaiting.as_deref().filter(|s| !s.is_empty());
                    create_run(
                        &tx,
                        run_id,
                        schedule_id,
                        sid,
                        ScheduleRunStatus::Skipped,
                        Some(&summary),
                    )
                    .map_err(|e| e.to_string())?;
                    update_run_with_phase(
                        &tx,
                        run_id,
                        sid,
                        ScheduleRunStatus::Skipped,
                        Some(&now_rfc3339()),
                        Some(&summary),
                        if awaiting.is_some() {
                            ScheduleRunPhase::Awaiting
                        } else {
                            ScheduleRunPhase::Agent
                        },
                        None,
                    )
                    .map_err(|e| e.to_string())?;
                }
                AutomationOverlapPolicy::Coalesce | AutomationOverlapPolicy::Queue => {
                    if policy == AutomationOverlapPolicy::Queue || !pending {
                        tx.execute(
                            "INSERT INTO schedule_pending(schedule_id, scheduled_at, reason) VALUES(?1, ?2, ?3)",
                            params![schedule_id, expected, reason],
                        ).map_err(|e| e.to_string())?;
                    }
                }
                AutomationOverlapPolicy::Parallel => unreachable!(),
            }
            advance_after_run(&tx, &schedule, fired_at).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            return Err(reason.to_string());
        }
    }
    let run = create_run(
        &tx,
        run_id,
        schedule_id,
        None,
        ScheduleRunStatus::Running,
        None,
    )
    .map_err(|e| e.to_string())?;
    if expected_next.is_some() || matches!(schedule.cadence, ScheduleCadence::Once { .. }) {
        advance_after_run(&tx, &schedule, fired_at).map_err(|e| e.to_string())?;
    }
    record_run_start(&tx, schedule_id, &run.started_at).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((schedule, run, policy))
}

/// Claim the oldest accepted occurrence using the current global policy.
/// Policy changes never discard or re-coalesce accepted rows; they survive
/// restarts and do not advance cadence twice. Existing run-cap behavior remains.
pub fn claim_pending_run(
    conn: &Connection,
    schedule_id: &str,
    run_id: &str,
) -> Result<Option<(Schedule, ScheduleRun, AutomationOverlapPolicy)>, String> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(schedule) = get(&tx, schedule_id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let policy = crate::db::load_automation_overlap_policy(&tx);
    let pending_id: Option<i64> = tx
        .query_row(
            "SELECT id FROM schedule_pending WHERE schedule_id = ?1 ORDER BY id LIMIT 1",
            params![schedule_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(pending_id) = pending_id else {
        return Ok(None);
    };
    if schedule
        .max_runs
        .is_some_and(|max| schedule.runs_done >= max)
    {
        tx.execute(
            "DELETE FROM schedule_pending WHERE schedule_id = ?1",
            params![schedule_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(None);
    }
    if policy != AutomationOverlapPolicy::Parallel
        && (has_active_run(&tx, schedule_id).map_err(|e| e.to_string())?
            || find_open_awaiting_session(&tx, schedule_id)
                .map_err(|e| e.to_string())?
                .is_some())
    {
        return Ok(None);
    }
    let run = create_run(
        &tx,
        run_id,
        schedule_id,
        None,
        ScheduleRunStatus::Running,
        None,
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM schedule_pending WHERE id = ?1",
        params![pending_id],
    )
    .map_err(|e| e.to_string())?;
    record_run_start(&tx, schedule_id, &run.started_at).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some((schedule, run, policy)))
}

pub fn pending_schedule_ids(conn: &Connection) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT schedule_id FROM schedule_pending GROUP BY schedule_id ORDER BY MIN(id)",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}
/// Due = parsed instant of `next_run_at` <= `before`.
/// Pre-filters enabled due schedules directly in SQL (without touching
/// `schedule_runs`), verifies exact RFC3339 instants in Rust across DST/UTC
/// offsets, and only joins latest-run metadata for schedules that are due.
pub fn find_due(conn: &Connection, before: &str) -> Result<Vec<Schedule>, rusqlite::Error> {
    let Ok(cutoff) = DateTime::parse_from_rfc3339(before) else {
        return Ok(Vec::new());
    };
    let cutoff_utc = cutoff
        .with_timezone(&chrono::Utc)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    // 0.00002 days (~1.7s) buffer ensures sub-millisecond rounding in SQLite's
    // julianday() never excludes a borderline due instant; Rust performs the exact check.
    let mut stmt = conn.prepare(
        "SELECT id, next_run_at FROM schedules
         WHERE enabled = 1 AND next_run_at IS NOT NULL
           AND (julianday(next_run_at) IS NULL OR julianday(next_run_at) <= julianday(?1) + 0.00002)",
    )?;
    let candidates = stmt.query_map(params![cutoff_utc], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut due_ids = Vec::new();
    for row in candidates {
        let (id, next_run_at) = row?;
        let is_due = DateTime::parse_from_rfc3339(&next_run_at)
            .ok()
            .is_some_and(|dt| dt <= cutoff);
        if is_due {
            due_ids.push(id);
        }
    }
    drop(stmt);
    if due_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut due = Vec::with_capacity(due_ids.len());
    for chunk in due_ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!("{SCHEDULE_SELECT} WHERE s.id IN ({placeholders})");
        let mut fetch_stmt = conn.prepare(&sql)?;
        let rows =
            fetch_stmt.query_map(rusqlite::params_from_iter(chunk.iter()), row_to_schedule)?;
        for row in rows {
            due.push(row?);
        }
    }
    Ok(due)
}

pub fn earliest_next_run(conn: &Connection) -> Result<Option<DateTime<Local>>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT next_run_at FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL",
    )?;
    let vals = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut min: Option<DateTime<chrono::FixedOffset>> = None;
    for v in vals {
        if let Ok(dt) = DateTime::parse_from_rfc3339(&v?) {
            if min.is_none_or(|m| dt < m) {
                min = Some(dt);
            }
        }
    }
    Ok(min.map(|dt| dt.with_timezone(&Local)))
}

pub fn create_run(
    conn: &Connection,
    id: &str,
    schedule_id: &str,
    session_id: Option<&str>,
    status: ScheduleRunStatus,
    summary: Option<&str>,
) -> Result<ScheduleRun, rusqlite::Error> {
    let ts = now_rfc3339();
    let status_str = match status {
        ScheduleRunStatus::Running => "running",
        ScheduleRunStatus::Ok => "ok",
        ScheduleRunStatus::Error => "error",
        ScheduleRunStatus::Skipped => "skipped",
    };

    conn.execute(
        "INSERT INTO schedule_runs(id, schedule_id, session_id, status, started_at, finished_at, summary, phase, probe_output, owner_pid)
         VALUES(?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL, ?8)",
        params![id, schedule_id, session_id, status_str, ts, summary, run_phase_as_str(ScheduleRunPhase::Agent), std::process::id()],
    )?;

    Ok(ScheduleRun {
        id: id.to_string(),
        schedule_id: schedule_id.to_string(),
        session_id: session_id.map(str::to_string),
        status,
        started_at: ts,
        finished_at: None,
        summary: summary.map(str::to_string),
        phase: ScheduleRunPhase::Agent,
        probe_output: None,
        worktree_repo_root: None,
        worktree_path: None,
        worktree_branch: None,
    })
}

pub fn set_run_worktree(
    conn: &Connection,
    run_id: &str,
    worktree_repo_root: &str,
    worktree_path: &str,
    worktree_branch: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE schedule_runs
         SET worktree_repo_root = ?2,
             worktree_path = ?3,
             worktree_branch = ?4
         WHERE id = ?1",
        params![run_id, worktree_repo_root, worktree_path, worktree_branch],
    )?;
    Ok(())
}

#[allow(dead_code)]
pub fn update_run(
    conn: &Connection,
    run_id: &str,
    session_id: Option<&str>,
    status: ScheduleRunStatus,
    finished_at: Option<&str>,
    summary: Option<&str>,
) -> Result<(), rusqlite::Error> {
    update_run_with_phase(
        conn,
        run_id,
        session_id,
        status,
        finished_at,
        summary,
        ScheduleRunPhase::Agent,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn update_run_with_phase(
    conn: &Connection,
    run_id: &str,
    session_id: Option<&str>,
    status: ScheduleRunStatus,
    finished_at: Option<&str>,
    summary: Option<&str>,
    phase: ScheduleRunPhase,
    probe_output: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let status_str = match status {
        ScheduleRunStatus::Running => "running",
        ScheduleRunStatus::Ok => "ok",
        ScheduleRunStatus::Error => "error",
        ScheduleRunStatus::Skipped => "skipped",
    };

    conn.execute(
        "UPDATE schedule_runs
         SET session_id = COALESCE(?2, session_id),
             status = ?3,
             finished_at = ?4,
             summary = ?5,
             phase = ?6,
             probe_output = COALESCE(?7, probe_output)
         WHERE id = ?1",
        params![
            run_id,
            session_id,
            status_str,
            finished_at,
            summary,
            run_phase_as_str(phase),
            probe_output,
        ],
    )?;
    Ok(())
}

pub fn list_runs(
    conn: &Connection,
    schedule_id: &str,
    limit: u32,
) -> Result<Vec<ScheduleRun>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLS} FROM schedule_runs WHERE schedule_id = ?1 ORDER BY started_at DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![schedule_id, limit], row_to_run)?;
    rows.collect()
}

pub fn list_awaiting_runs(
    conn: &Connection,
    schedule_id: &str,
) -> Result<Vec<ScheduleRun>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLS} FROM schedule_runs WHERE schedule_id = ?1 AND phase = 'awaiting'
         AND status NOT IN ('running', 'skipped') ORDER BY started_at, id"
    ))?;
    let rows = stmt.query_map(params![schedule_id], row_to_run)?;
    rows.collect()
}

pub fn has_active_run(conn: &Connection, schedule_id: &str) -> Result<bool, rusqlite::Error> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM schedule_runs WHERE schedule_id = ?1 AND status = 'running'",
        params![schedule_id],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

/// Return any unresolved paused run, regardless of its Inbox acknowledgement.
pub fn find_open_awaiting_session(
    conn: &Connection,
    schedule_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT COALESCE(session_id, '') FROM schedule_runs
         WHERE schedule_id = ?1 AND phase = 'awaiting' AND status != 'skipped'
         ORDER BY started_at, id LIMIT 1",
        params![schedule_id],
        |r| r.get(0),
    )
    .optional()
}

fn process_alive(owner: Option<u32>) -> bool {
    #[cfg(unix)]
    {
        owner.is_some_and(|pid| {
            let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
            result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        })
    }
    #[cfg(not(unix))]
    {
        owner.is_some()
    }
}

/// Reserve a uniquely identified continuation attempt without releasing the
/// original run. A dead process's unfinished attempt can be replaced.
pub fn begin_awaiting_resume(
    conn: &Connection,
    schedule_id: &str,
    run_id: &str,
    session_id: &str,
    attempt: &str,
) -> Result<(), String> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let owner: Option<Option<u32>> = tx
        .query_row(
            "SELECT resume_owner_pid FROM schedule_runs WHERE id = ?1 AND schedule_id = ?2
         AND session_id = ?3 AND phase = 'awaiting' AND status NOT IN ('running', 'skipped')",
            params![run_id, schedule_id, session_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(owner) = owner else {
        return Err("该运行不存在或不再等待确认".to_string());
    };
    if process_alive(owner) {
        return Err("该运行已有恢复任务".to_string());
    }
    tx.execute(
        "UPDATE schedule_runs SET resume_attempt = ?2, resume_owner_pid = ?3 WHERE id = ?1",
        params![run_id, attempt, std::process::id()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn abandon_awaiting_resume(
    conn: &Connection,
    run_id: &str,
    attempt: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE schedule_runs SET resume_attempt = NULL, resume_owner_pid = NULL
         WHERE id = ?1 AND resume_attempt = ?2",
        params![run_id, attempt],
    )?;
    Ok(())
}

/// Called only after the dedicated request's correlated successful result.
pub fn finish_awaiting_resume(
    conn: &Connection,
    run_id: &str,
    session_id: &str,
    attempt: &str,
) -> rusqlite::Result<bool> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    let changed = tx.execute(
        "UPDATE schedule_runs SET phase = 'agent', status = 'ok', finished_at = ?4,
         summary = '确认后继续运行已完成', resume_attempt = NULL, resume_owner_pid = NULL
         WHERE id = ?1 AND session_id = ?2 AND resume_attempt = ?3 AND phase = 'awaiting'",
        params![run_id, session_id, attempt, now_rfc3339()],
    )?;
    if changed > 0 {
        tx.execute("UPDATE todos SET status = 'done', updated_at = ?2 WHERE dedupe_key = ?1 AND status = 'open'",
            params![format!("sched:{run_id}"), now_rfc3339()])?;
    }
    tx.commit()?;
    Ok(changed > 0)
}

/// Explicit user override. This does not stop or complete the old session.
pub fn release_awaiting(conn: &Connection, schedule_id: &str, run_id: &str) -> Result<(), String> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let changed = tx.execute(
        "UPDATE schedule_runs
         SET phase = 'agent', status = 'error', resume_attempt = NULL, resume_owner_pid = NULL,
             finished_at = ?3, summary = '用户明确解除等待，原运行未确认完成'
         WHERE id = ?1 AND schedule_id = ?2 AND phase = 'awaiting' AND status != 'running' AND status != 'skipped'",
        params![run_id, schedule_id, now_rfc3339()],
    ).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("该运行不存在或不再等待确认".to_string());
    }
    tx.execute(
        "UPDATE todos SET status = 'done', updated_at = ?2 WHERE dedupe_key = ?1 AND status = 'open'",
        params![format!("sched:{run_id}"), now_rfc3339()],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Settle runs left `running` by a previous app process (crash, force quit,
/// power loss) so they cannot block the schedule forever: `has_active_run`
/// would keep reporting a run in progress and every later trigger would be
/// skipped. Called once at scheduler startup, before the catch-up pass.
/// Returns how many runs were closed.
pub fn recover_stale_runs(conn: &Connection, at: &str) -> Result<usize, rusqlite::Error> {
    let mut stmt =
        conn.prepare("SELECT id, owner_pid FROM schedule_runs WHERE status = 'running'")?;
    let runs = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<u32>>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut count = 0;
    for (id, owner) in runs {
        if !process_alive(owner) {
            count += conn.execute(
                "UPDATE schedule_runs SET status = 'error', finished_at = ?2,
                 summary = COALESCE(NULLIF(TRIM(summary), ''), '应用异常退出，本次运行未完成')
                 WHERE id = ?1 AND status = 'running'",
                params![id, at],
            )?;
        }
    }
    Ok(count)
}

/// File path of the session used by this schedule's most recent run that has
/// one — the resume target when `new_chat_each_run` is false (local mode).
pub fn last_run_session_file(
    conn: &Connection,
    schedule_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT m.file_path FROM schedule_runs r
         JOIN session_meta m ON m.session_id = r.session_id
         WHERE r.schedule_id = ?1 AND r.session_id IS NOT NULL AND m.file_path IS NOT NULL
         ORDER BY r.started_at DESC LIMIT 1",
        params![schedule_id],
        |r| r.get(0),
    )
    .optional()
}

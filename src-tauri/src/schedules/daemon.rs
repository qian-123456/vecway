//! Headless automation daemon (`--ompws-automation-daemon`) and macOS LaunchAgent sync.
//!
//! When the user enables `automation_background_enabled` (default on) in the main app data dir
//! (`~/.omp-workspace`), Vecway installs a single LaunchAgent plist that wakes once every 60s
//! and invokes `omp-workspace --ompws-automation-daemon`.
//!
//! Safety & overhead invariants:
//! - Isolated `OMPWS_DATA_DIR` dev/worktree instances never modify `~/Library/LaunchAgents`.
//! - If the GUI app holds `gui.lock`, the headless runner exits immediately (`0`).
//! - If no automations are due (`find_due` empty), the daemon exits immediately (<5ms).
//! - If an unattended turn requests user confirmation (`select`/`confirm`/`input`/`editor` or `ask`),
//!   the daemon safely pauses the run (`phase = Awaiting`), stops the idle `omp` child process,
//!   persists an Inbox todo, and posts a macOS notification.

use std::fs::{File, OpenOptions};
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::{params, Connection};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::contracts::{
    AutomationOverlapPolicy, PendingKind, Schedule, ScheduleAgentTrigger, ScheduleNotify,
    ScheduleRunMode, ScheduleRunPhase, ScheduleRunStatus, Settings, TodoKind, TodoSource,
};
use crate::rpc::frame::ChunkReassembler;
use crate::schedules::probe::{self, ProbeOutcome};
use crate::schedules::{runner, store};
use crate::todos::store::NewTodo;

pub const LAUNCH_AGENT_LABEL: &str = "ai.omp.workspace.automation";
pub const DAEMON_FLAG: &str = "--ompws-automation-daemon";

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const RUN_TIMEOUT: Duration = Duration::from_secs(3600);
const PROBE_TIMEOUT: Duration = Duration::from_secs(300);

static GUI_LOCK: OnceLock<Option<File>> = OnceLock::new();

#[cfg(unix)]
pub fn try_lock_exclusive(path: &Path) -> Option<File> {
    use std::os::fd::AsRawFd;

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .ok()?;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        Some(file)
    } else {
        None
    }
}

#[cfg(not(unix))]
pub fn try_lock_exclusive(_path: &Path) -> Option<File> {
    None
}

/// Hold `<data_dir>/gui.lock` for the lifetime of the GUI process so background
/// LaunchAgent ticks immediately defer to the active app scheduler.
pub fn hold_gui_lock() {
    let lock_path = crate::paths::data_dir().join("gui.lock");
    let _ = GUI_LOCK.get_or_init(|| try_lock_exclusive(&lock_path));
}

pub fn is_gui_running_at(data_dir: &Path) -> bool {
    let lock_path = data_dir.join("gui.lock");
    if !lock_path.exists() {
        return false;
    }
    try_lock_exclusive(&lock_path).is_none()
}

fn xml_escape(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn build_launch_agent_plist(exe_path: &Path, log_path: &Path) -> String {
    let exe = xml_escape(&exe_path.to_string_lossy());
    let log = xml_escape(&log_path.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LAUNCH_AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{exe}</string>
		<string>{DAEMON_FLAG}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>60</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
</dict>
</plist>
"#
    )
}

#[cfg(target_os = "macos")]
fn launchctl_uid_target() -> String {
    let uid = unsafe { libc::geteuid() };
    format!("gui/{uid}")
}

fn invoke_launchctl_bootout(plist_path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let target = launchctl_uid_target();
        let _ = std::process::Command::new("/bin/launchctl")
            .args(["bootout", &target])
            .arg(plist_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = plist_path;
}

fn invoke_launchctl_bootstrap(plist_path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let target = launchctl_uid_target();
        let ok = std::process::Command::new("/bin/launchctl")
            .args(["bootstrap", &target])
            .arg(plist_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            let _ = std::process::Command::new("/bin/launchctl")
                .args(["load", "-w"])
                .arg(plist_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = plist_path;
}

/// Install, update, or remove the dedicated Vecway LaunchAgent plist under `launch_agents_dir`.
/// Returns `Ok(true)` when disk state changed.
pub fn sync_launch_agent_in(
    launch_agents_dir: &Path,
    exe_path: &Path,
    log_path: &Path,
    enabled: bool,
    invoke_launchctl: bool,
) -> Result<bool, String> {
    let plist_path = launch_agents_dir.join(format!("{LAUNCH_AGENT_LABEL}.plist"));
    if !enabled {
        if plist_path.exists() {
            if invoke_launchctl {
                invoke_launchctl_bootout(&plist_path);
            }
            std::fs::remove_file(&plist_path).map_err(|e| e.to_string())?;
            return Ok(true);
        }
        return Ok(false);
    }

    std::fs::create_dir_all(launch_agents_dir).map_err(|e| e.to_string())?;
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let content = build_launch_agent_plist(exe_path, log_path);
    if std::fs::read_to_string(&plist_path).is_ok_and(|cur| cur == content) {
        return Ok(false);
    }

    let tmp = plist_path.with_extension(format!("plist.{}.tmp", std::process::id()));
    std::fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &plist_path).map_err(|e| e.to_string())?;
    if invoke_launchctl {
        invoke_launchctl_bootout(&plist_path);
        invoke_launchctl_bootstrap(&plist_path);
    }
    Ok(true)
}

/// Sync `~/Library/LaunchAgents/ai.omp.workspace.automation.plist` on macOS production
/// instances only (isolated `OMPWS_DATA_DIR` dev worktrees and tests never touch user plists).
pub fn sync_launch_agent(enabled: bool) {
    if !cfg!(target_os = "macos") || !crate::paths::is_default_data_dir() {
        return;
    }
    let Ok(exe_path) = std::env::current_exe() else {
        return;
    };
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let agents_dir = home.join("Library").join("LaunchAgents");
    let log_path = crate::paths::logs_dir().join("automation-daemon.log");

    std::thread::spawn(move || {
        if let Err(e) = sync_launch_agent_in(&agents_dir, &exe_path, &log_path, enabled, true) {
            tracing::warn!("sync launch agent failed: {e}");
        }
    });
}

fn should_notify_os(
    settings: &Settings,
    ok: bool,
    paused_awaiting: bool,
    policy: ScheduleNotify,
) -> bool {
    if !paused_awaiting && ok && policy != ScheduleNotify::All {
        return false;
    }
    if policy == ScheduleNotify::None && ok && !paused_awaiting {
        return false;
    }
    if let (Some(from), Some(to)) = (&settings.notify_quiet_from, &settings.notify_quiet_to) {
        let now = chrono::Local::now().format("%H:%M").to_string();
        if crate::notify::in_quiet_hours(&now, from.trim(), to.trim()) {
            return false;
        }
    }
    true
}

fn send_os_notification(settings: &Settings, title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    {
        let esc = |s: &str| {
            s.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace(['\r', '\n'], " ")
        };
        let mut script = format!(
            "display notification \"{}\" with title \"{}\"",
            esc(body),
            esc(title)
        );
        if settings.notify_sound {
            script.push_str(" sound name \"default\"");
        }
        let _ = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (settings, title, body);
}

fn truncate_summary(text: &str) -> String {
    if text.chars().count() > 500 {
        format!("{}…", text.chars().take(500).collect::<String>())
    } else {
        text.to_string()
    }
}

#[allow(clippy::too_many_arguments)]
fn record_headless_error(
    conn: &Connection,
    settings: &Settings,
    schedule: &Schedule,
    run_id: &str,
    session_id: Option<&str>,
    err_msg: &str,
    phase: ScheduleRunPhase,
    probe_output: Option<&str>,
    probe_error: bool,
) {
    let now = store::now_rfc3339();
    let _ = store::update_run_with_phase(
        conn,
        run_id,
        session_id,
        ScheduleRunStatus::Error,
        Some(&now),
        Some(err_msg),
        phase,
        probe_output,
    );
    if runner::should_create_inbox_todo(schedule.notify, false, false) {
        let mut payload = serde_json::json!({
            "scheduleId": schedule.id,
            "runId": run_id,
            "ok": false,
        });
        if probe_error {
            payload["probeError"] = serde_json::json!(true);
        }
        let new_todo = NewTodo {
            kind: TodoKind::ScheduleRun,
            source: TodoSource::Schedule,
            session_id: session_id.map(str::to_string),
            title: format!("自动化「{}」运行失败", schedule.name),
            detail: err_msg.to_string(),
            payload,
        };
        let _ = crate::todos::store::upsert(conn, &format!("sched:{run_id}"), &new_todo, true);
    }
    if should_notify_os(settings, false, false, schedule.notify) {
        send_os_notification(
            settings,
            &format!("自动化「{}」运行失败", schedule.name),
            err_msg,
        );
    }
}

fn record_headless_session_meta(
    conn: &Connection,
    session_id: &str,
    session_file: Option<&str>,
    schedule: &Schedule,
    pending_kind: Option<PendingKind>,
    unread: bool,
) {
    let label = format!("⏰ {}", schedule.name);
    let _ = crate::catalog::store::mark_created_by_app(conn, session_id);
    let _ = crate::catalog::store::set_mode_group(conn, session_id, Some(schedule.mode), None);
    let _ = conn.execute(
        "UPDATE session_meta
         SET file_path = COALESCE(?2, file_path),
             label = COALESCE(NULLIF(TRIM(label), ''), ?3)
         WHERE session_id = ?1",
        params![session_id, session_file, label],
    );
    let _ = crate::catalog::store::set_unread(conn, session_id, unread);
    let _ = crate::catalog::store::set_pending(conn, session_id, pending_kind);
}

fn assistant_stop_reason(frame: &Value) -> Option<&str> {
    frame
        .get("messages")?
        .as_array()?
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))?
        .get("stopReason")?
        .as_str()
}

async fn execute_claimed_schedule(
    conn: &Connection,
    settings: &Settings,
    schedule: Schedule,
    run_id: String,
    policy: AutomationOverlapPolicy,
) {
    let base_path = Path::new(&schedule.cwd);
    if !base_path.exists() || !base_path.is_dir() {
        record_headless_error(
            conn,
            settings,
            &schedule,
            &run_id,
            None,
            &format!("工作目录不存在：{}", schedule.cwd),
            ScheduleRunPhase::Agent,
            None,
            false,
        );
        return;
    }

    let isolated_cwd = if policy == AutomationOverlapPolicy::Parallel
        && schedule.run_mode == ScheduleRunMode::Worktree
    {
        match runner::create_schedule_worktree(base_path, &schedule.name, &run_id) {
            Ok(path) => Some(path),
            Err(e) => {
                record_headless_error(
                    conn,
                    settings,
                    &schedule,
                    &run_id,
                    None,
                    &format!("创建独立 worktree 失败：{e}"),
                    ScheduleRunPhase::Agent,
                    None,
                    false,
                );
                return;
            }
        }
    } else {
        None
    };

    let probe_cmd = schedule
        .probe_command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut probe_context: Option<String> = None;
    if let Some(cmd) = probe_cmd {
        let probe_cwd = if let Some(path) = &isolated_cwd {
            path.clone()
        } else if schedule.agent_trigger == ScheduleAgentTrigger::Never
            && matches!(schedule.run_mode, ScheduleRunMode::Worktree)
        {
            match runner::create_schedule_worktree(base_path, &schedule.name, &run_id) {
                Ok(p) => p,
                Err(e) => {
                    record_headless_error(
                        conn,
                        settings,
                        &schedule,
                        &run_id,
                        None,
                        &format!("创建独立 worktree 失败：{e}"),
                        ScheduleRunPhase::ProbeOnly,
                        None,
                        true,
                    );
                    return;
                }
            }
        } else {
            schedule.cwd.clone()
        };

        let timeout = if schedule.agent_trigger == ScheduleAgentTrigger::Never {
            RUN_TIMEOUT
        } else {
            PROBE_TIMEOUT
        };
        let (_code, _timed_out, _dur, outcome, _raw) = probe::execute_probe(
            Path::new(&probe_cwd),
            cmd,
            schedule.agent_trigger,
            Some(&schedule.id),
            timeout,
        )
        .await;

        match outcome {
            ProbeOutcome::Quiet => {
                let now = store::now_rfc3339();
                let _ = store::update_run_with_phase(
                    conn,
                    &run_id,
                    None,
                    ScheduleRunStatus::Ok,
                    Some(&now),
                    Some("脚本正常，无新变化"),
                    ScheduleRunPhase::ProbeQuiet,
                    None,
                );
                return;
            }
            ProbeOutcome::ScriptOk { output } => {
                let now = store::now_rfc3339();
                let detail = if output.trim().is_empty() {
                    "脚本执行完成".to_string()
                } else {
                    truncate_summary(output.trim())
                };
                let _ = store::update_run_with_phase(
                    conn,
                    &run_id,
                    None,
                    ScheduleRunStatus::Ok,
                    Some(&now),
                    Some(&detail),
                    ScheduleRunPhase::ProbeOnly,
                    Some(&output),
                );
                if runner::should_create_inbox_todo(schedule.notify, true, false) {
                    let new_todo = NewTodo {
                        kind: TodoKind::ScheduleRun,
                        source: TodoSource::Schedule,
                        session_id: None,
                        title: format!("自动化「{}」已完成", schedule.name),
                        detail: detail.clone(),
                        payload: serde_json::json!({
                            "scheduleId": schedule.id,
                            "runId": run_id,
                            "ok": true,
                            "probeOnly": true,
                        }),
                    };
                    let _ = crate::todos::store::upsert(
                        conn,
                        &format!("sched:{run_id}"),
                        &new_todo,
                        true,
                    );
                }
                if should_notify_os(settings, true, false, schedule.notify) {
                    send_os_notification(
                        settings,
                        &format!("自动化「{}」已完成", schedule.name),
                        &detail,
                    );
                }
                return;
            }
            ProbeOutcome::Failed { output } => {
                let err_msg = if output.trim().is_empty() {
                    "本地脚本执行失败".to_string()
                } else {
                    truncate_summary(output.trim())
                };
                record_headless_error(
                    conn,
                    settings,
                    &schedule,
                    &run_id,
                    None,
                    &err_msg,
                    ScheduleRunPhase::ProbeOnly,
                    Some(&output),
                    true,
                );
                return;
            }
            ProbeOutcome::WakeAgent { context } => {
                if !context.trim().is_empty() {
                    probe_context = Some(context);
                }
            }
        }
    } else if schedule.agent_trigger == ScheduleAgentTrigger::Never {
        record_headless_error(
            conn,
            settings,
            &schedule,
            &run_id,
            None,
            "未配置本地脚本或命令",
            ScheduleRunPhase::ProbeOnly,
            None,
            true,
        );
        return;
    }

    let effective_cwd = if let Some(path) = isolated_cwd {
        path
    } else {
        match schedule.run_mode {
            ScheduleRunMode::Worktree => {
                match runner::create_schedule_worktree(base_path, &schedule.name, &run_id) {
                    Ok(p) => p,
                    Err(e) => {
                        record_headless_error(
                            conn,
                            settings,
                            &schedule,
                            &run_id,
                            None,
                            &format!("创建独立 worktree 失败：{e}"),
                            ScheduleRunPhase::Agent,
                            probe_context.as_deref(),
                            false,
                        );
                        return;
                    }
                }
            }
            ScheduleRunMode::Local => schedule.cwd.clone(),
        }
    };

    let resume_file = if policy != AutomationOverlapPolicy::Parallel
        && !schedule.new_chat_each_run
        && matches!(schedule.run_mode, ScheduleRunMode::Local)
    {
        store::last_run_session_file(conn, &schedule.id)
            .ok()
            .flatten()
            .filter(|f| Path::new(f).is_file())
    } else {
        None
    };

    let outcome = run_headless_omp_turn(
        settings,
        &schedule,
        &effective_cwd,
        resume_file.as_deref(),
        probe_context.as_deref(),
    )
    .await;

    let session_id = outcome.session_id.clone();
    let session_file = outcome.session_file.clone();
    if let Some(sid) = session_id.as_deref() {
        let pending = if outcome.paused_awaiting {
            outcome.awaiting_kind
        } else if !outcome.ok {
            Some(PendingKind::Error)
        } else {
            None
        };
        record_headless_session_meta(conn, sid, session_file.as_deref(), &schedule, pending, true);
    }

    let now = store::now_rfc3339();
    if outcome.paused_awaiting {
        let detail = if outcome.awaiting_kind == Some(PendingKind::Question) {
            "运行过程中需要你的回答，已安全暂停。打开 Vecway 即可继续处理。"
        } else {
            "运行过程中需要你的审批，已安全暂停。打开 Vecway 即可继续处理。"
        };
        let _ = store::update_run_with_phase(
            conn,
            &run_id,
            session_id.as_deref(),
            ScheduleRunStatus::Ok,
            Some(&now),
            Some(detail),
            ScheduleRunPhase::Awaiting,
            probe_context.as_deref(),
        );
        let new_todo = NewTodo {
            kind: TodoKind::ScheduleRun,
            source: TodoSource::Schedule,
            session_id: session_id.clone(),
            title: format!("自动化「{}」等你确认", schedule.name),
            detail: detail.to_string(),
            payload: serde_json::json!({
                "scheduleId": schedule.id,
                "runId": run_id,
                "ok": true,
                "awaiting": true,
                "awaitingKind": outcome.awaiting_kind,
            }),
        };
        let _ = crate::todos::store::upsert(conn, &format!("sched:{run_id}"), &new_todo, true);
        if should_notify_os(settings, true, true, schedule.notify) {
            send_os_notification(
                settings,
                &format!("自动化「{}」等你确认", schedule.name),
                "需要你的审批或回答，已安全暂停",
            );
        }
        return;
    }

    if let Some(err) = outcome.fatal_error {
        record_headless_error(
            conn,
            settings,
            &schedule,
            &run_id,
            session_id.as_deref(),
            &err,
            ScheduleRunPhase::Agent,
            probe_context.as_deref(),
            false,
        );
        return;
    }

    let last_text = session_file
        .as_deref()
        .and_then(|p| crate::mobile::last::last_assistant_text(Path::new(p)));
    let detail = if let Some(t) = last_text {
        truncate_summary(&t)
    } else if outcome.ok {
        "自动化执行完成".to_string()
    } else {
        "自动化执行失败".to_string()
    };

    let status = if outcome.ok {
        ScheduleRunStatus::Ok
    } else {
        ScheduleRunStatus::Error
    };
    let _ = store::update_run_with_phase(
        conn,
        &run_id,
        session_id.as_deref(),
        status,
        Some(&now),
        Some(&detail),
        ScheduleRunPhase::Agent,
        probe_context.as_deref(),
    );

    if runner::should_create_inbox_todo(schedule.notify, outcome.ok, false) {
        let title = if outcome.ok {
            format!("自动化「{}」已完成", schedule.name)
        } else {
            format!("自动化「{}」运行失败", schedule.name)
        };
        let new_todo = NewTodo {
            kind: TodoKind::ScheduleRun,
            source: TodoSource::Schedule,
            session_id,
            title,
            detail: detail.clone(),
            payload: serde_json::json!({
                "scheduleId": schedule.id,
                "runId": run_id,
                "ok": outcome.ok,
            }),
        };
        let _ = crate::todos::store::upsert(conn, &format!("sched:{run_id}"), &new_todo, true);
    }

    if should_notify_os(settings, outcome.ok, false, schedule.notify) {
        let title = if outcome.ok {
            format!("自动化「{}」已完成", schedule.name)
        } else {
            format!("自动化「{}」运行失败", schedule.name)
        };
        send_os_notification(settings, &title, &detail);
    }
}

struct HeadlessTurnOutcome {
    session_id: Option<String>,
    session_file: Option<String>,
    ok: bool,
    paused_awaiting: bool,
    awaiting_kind: Option<PendingKind>,
    fatal_error: Option<String>,
}

async fn run_headless_omp_turn(
    settings: &Settings,
    schedule: &Schedule,
    cwd: &str,
    resume_file: Option<&str>,
    probe_context: Option<&str>,
) -> HeadlessTurnOutcome {
    crate::todos::omp::init_login_path().await;
    let path_env = crate::todos::omp::augmented_path();
    let exe = crate::todos::omp::resolve_binary(&settings.omp_binary, &path_env);
    let approval_mode = schedule
        .approval_mode
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&settings.default_approval_mode);

    let mut cmd = tokio::process::Command::new(&exe);
    cmd.kill_on_drop(true)
        .arg("--mode")
        .arg("rpc")
        .arg("--approval-mode")
        .arg(approval_mode)
        .arg("--cwd")
        .arg(cwd)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("PATH", &path_env);

    #[cfg(unix)]
    cmd.process_group(0);

    for (k, v) in crate::privacy::spawn_env() {
        cmd.env(k, v);
    }

    let model = schedule.model.as_deref().or_else(|| {
        if resume_file.is_some() {
            return None;
        }
        settings
            .new_session_model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
    });
    if let Some(m) = model {
        cmd.arg("--model")
            .arg(crate::todos::omp::normalize_model_selector(m));
    }

    cmd.args(crate::rpc::prompt_shape_args(
        resume_file,
        None,
        None,
        settings,
    ));
    if let Some(rf) = resume_file {
        cmd.arg("--resume").arg(rf);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return HeadlessTurnOutcome {
                session_id: None,
                session_file: None,
                ok: false,
                paused_awaiting: false,
                awaiting_kind: None,
                fatal_error: Some(format!("后台启动 omp 失败：{e}")),
            };
        }
    };

    let Some(mut stdin) = child.stdin.take() else {
        return HeadlessTurnOutcome {
            session_id: None,
            session_file: None,
            ok: false,
            paused_awaiting: false,
            awaiting_kind: None,
            fatal_error: Some("无法获取 omp 标准输入".to_string()),
        };
    };
    let Some(stdout) = child.stdout.take() else {
        return HeadlessTurnOutcome {
            session_id: None,
            session_file: None,
            ok: false,
            paused_awaiting: false,
            awaiting_kind: None,
            fatal_error: Some("无法获取 omp 标准输出".to_string()),
        };
    };

    let mut lines = BufReader::new(stdout).lines();
    let mut reassembler = ChunkReassembler::default();
    let mut session_id: Option<String> = None;
    let mut session_file: Option<String> = None;

    let _ = stdin
        .write_all(b"{\"id\":\"init\",\"type\":\"get_state\"}\n")
        .await;
    let _ = stdin.flush().await;

    let handshake_deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        let next = tokio::time::timeout_at(handshake_deadline, lines.next_line()).await;
        match next {
            Ok(Ok(Some(line))) => {
                let Ok(raw) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Ok(Some(frame)) = reassembler.feed(raw) else {
                    continue;
                };
                if frame.get("type").and_then(Value::as_str) == Some("ready") {
                    if let Some(max) = frame
                        .get("capabilities")
                        .and_then(|c| c.get("maxReassembledFrameBytes"))
                        .and_then(Value::as_u64)
                    {
                        reassembler.set_max_reassembled(max as usize);
                    }
                    continue;
                }
                if frame.get("type").and_then(Value::as_str) == Some("response")
                    && frame.get("id").and_then(Value::as_str) == Some("init")
                {
                    let data = frame.get("data").unwrap_or(&frame);
                    session_id = data
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    session_file = data
                        .get("sessionFile")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    break;
                }
            }
            _ => break,
        }
    }

    if let Some(level) = schedule
        .thinking
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let cmd_json = serde_json::json!({
            "id": "think",
            "type": "set_thinking_level",
            "level": level,
        });
        let _ = stdin.write_all(format!("{cmd_json}\n").as_bytes()).await;
    }

    let effective_prompt = match probe_context.map(str::trim).filter(|s| !s.is_empty()) {
        Some(ctx) => format!(
            "<automation_check_output>\n{ctx}\n</automation_check_output>\n\n{}",
            schedule.prompt
        ),
        None => schedule.prompt.clone(),
    };
    let prompt_json = serde_json::json!({
        "id": "run",
        "type": "prompt",
        "message": effective_prompt,
    });
    if let Err(e) = stdin.write_all(format!("{prompt_json}\n").as_bytes()).await {
        stop_child_cleanly(&mut child, Some(stdin)).await;
        return HeadlessTurnOutcome {
            session_id,
            session_file,
            ok: false,
            paused_awaiting: false,
            awaiting_kind: None,
            fatal_error: Some(format!("发送提示词失败：{e}")),
        };
    }
    let _ = stdin.flush().await;

    let mut ok = false;
    let mut paused_awaiting = false;
    let mut awaiting_kind = None;
    let deadline = tokio::time::Instant::now() + RUN_TIMEOUT;
    loop {
        let next = tokio::time::timeout_at(deadline, lines.next_line()).await;
        let line = match next {
            Ok(Ok(Some(l))) => l,
            Ok(Ok(None)) => break,
            Ok(Err(_)) | Err(_) => {
                ok = false;
                break;
            }
        };
        let Ok(raw) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Ok(Some(frame)) = reassembler.feed(raw) else {
            continue;
        };
        let ty = frame.get("type").and_then(Value::as_str).unwrap_or("");
        if session_id.is_none() {
            if let Some(sid) = frame.get("sessionId").and_then(Value::as_str) {
                session_id = Some(sid.to_string());
            }
        }
        if session_file.is_none() {
            if let Some(sf) = frame.get("sessionFile").and_then(Value::as_str) {
                session_file = Some(sf.to_string());
            }
        }
        match ty {
            "extension_ui_request" => {
                let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
                if matches!(method, "select" | "confirm" | "input" | "editor") {
                    paused_awaiting = true;
                    awaiting_kind = Some(if method == "confirm" {
                        PendingKind::Approval
                    } else {
                        PendingKind::Question
                    });
                    break;
                }
            }
            "tool_execution_start" => {
                if frame.get("toolName").and_then(Value::as_str) == Some("ask") {
                    paused_awaiting = true;
                    awaiting_kind = Some(PendingKind::Question);
                    break;
                }
            }
            "agent_end" if crate::catalog::status::agent_end_settles(&frame) => {
                let stop = assistant_stop_reason(&frame);
                ok = !matches!(stop, Some("error" | "aborted"));
                break;
            }
            "session_settled" => {
                ok = true;
                break;
            }
            _ => {}
        }
    }

    stop_child_cleanly(&mut child, Some(stdin)).await;
    HeadlessTurnOutcome {
        session_id,
        session_file,
        ok,
        paused_awaiting,
        awaiting_kind,
        fatal_error: None,
    }
}

async fn stop_child_cleanly(
    child: &mut tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
) {
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .is_ok()
    {
        return;
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Entrypoint for `omp-workspace --ompws-automation-daemon`.
/// Exits cleanly with 0 in <5ms when GUI owns the scheduler, daemon is locked,
/// background execution is disabled, or no automations are due.
pub fn run_cli() -> i32 {
    if crate::paths::ensure_dirs().is_err() {
        return 1;
    }
    let data_dir = crate::paths::data_dir();
    if is_gui_running_at(&data_dir) {
        return 0;
    }
    let Some(_daemon_lock) = try_lock_exclusive(&data_dir.join("automation-daemon.lock")) else {
        return 0;
    };

    let Ok(conn) = crate::db::open() else {
        return 1;
    };
    let conn = std::rc::Rc::new(conn);
    let settings = crate::db::load_settings(&conn);
    if !settings.automation_background_enabled {
        return 0;
    }

    let _ = store::recover_stale_runs(&conn, &store::now_rfc3339());
    let initial_due =
        store::find_due(&conn, &chrono::Local::now().to_rfc3339()).unwrap_or_default();
    let initial_pending = store::pending_schedule_ids(&conn).unwrap_or_default();
    if initial_due.is_empty() && initial_pending.is_empty() {
        return 0;
    }

    let _ = crate::db::ensure_global_workspace(&conn);
    crate::rpc::install_bundled_extensions();

    let Ok(rt) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        return 1;
    };

    let local = tokio::task::LocalSet::new();
    rt.block_on(local.run_until(async {
        let mut jobs = tokio::task::JoinSet::new();
        let mut pending_initial_due = Some(initial_due);
        let mut pending_initial_queued = Some(initial_pending);
        loop {
            let mut progressed = false;
            while jobs.try_join_next().is_some() {}
            if !is_gui_running_at(&data_dir) {
                let due = pending_initial_due.take().unwrap_or_else(|| {
                    store::find_due(&conn, &chrono::Local::now().to_rfc3339()).unwrap_or_default()
                });
                for schedule in due {
                    let Some(next) = schedule.next_run_at.as_deref() else {
                        continue;
                    };
                    let run_id = uuid::Uuid::new_v4().to_string();
                    if let Ok((claimed, _, policy)) =
                        store::claim_run(&conn, &schedule.id, &run_id, Some(next))
                    {
                        progressed = true;
                        // All LocalSet tasks run cooperatively on this thread and never hold
                        // SQLite transactions across `.await`, so reusing `Rc<Connection>`
                        // avoids opening a fresh connection per candidate schedule.
                        let job_conn = std::rc::Rc::clone(&conn);
                        let settings = crate::db::load_settings(&job_conn);
                        jobs.spawn_local(async move {
                            execute_claimed_schedule(&job_conn, &settings, claimed, run_id, policy)
                                .await;
                        });
                    } else if store::get(&conn, &schedule.id)
                        .ok()
                        .flatten()
                        .is_some_and(|current| current.next_run_at.as_deref() != Some(next))
                    {
                        progressed = true;
                    }
                }
                let pending_ids = pending_initial_queued
                    .take()
                    .unwrap_or_else(|| store::pending_schedule_ids(&conn).unwrap_or_default());
                for id in pending_ids {
                    let run_id = uuid::Uuid::new_v4().to_string();
                    if let Ok(Some((claimed, _, policy))) =
                        store::claim_pending_run(&conn, &id, &run_id)
                    {
                        progressed = true;
                        let job_conn = std::rc::Rc::clone(&conn);
                        let settings = crate::db::load_settings(&job_conn);
                        jobs.spawn_local(async move {
                            execute_claimed_schedule(&job_conn, &settings, claimed, run_id, policy)
                                .await;
                        });
                    }
                }
            }
            if jobs.is_empty() {
                if progressed {
                    continue;
                }
                break;
            }
            tokio::select! {
                _ = jobs.join_next() => {}
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
        }
    }));
    store::write_catalog_snapshot(&conn);
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn plist_escapes_xml_and_sets_background_interval() {
        let exe = PathBuf::from("/Applications/Vec&Way.app/Contents/MacOS/omp-workspace");
        let log = PathBuf::from("/tmp/log<1>.log");
        let xml = build_launch_agent_plist(&exe, &log);
        assert!(xml.contains(LAUNCH_AGENT_LABEL));
        assert!(xml.contains(DAEMON_FLAG));
        assert!(xml.contains("Vec&amp;Way.app"));
        assert!(xml.contains("log&lt;1&gt;.log"));
        assert!(xml.contains("<key>StartInterval</key>\n\t<integer>60</integer>"));
    }

    #[test]
    fn sync_launch_agent_in_writes_is_idempotent_and_removes_on_disable() {
        let tmp = std::env::temp_dir().join(format!("ompws-la-{}", uuid::Uuid::new_v4()));
        let agents = tmp.join("LaunchAgents");
        let log = tmp.join("logs/daemon.log");
        let exe = PathBuf::from("/usr/local/bin/omp-workspace");

        assert!(sync_launch_agent_in(&agents, &exe, &log, true, false).unwrap());
        assert!(!sync_launch_agent_in(&agents, &exe, &log, true, false).unwrap());
        let plist = agents.join(format!("{LAUNCH_AGENT_LABEL}.plist"));
        assert!(plist.is_file());

        assert!(sync_launch_agent_in(&agents, &exe, &log, false, false).unwrap());
        assert!(!plist.exists());
        assert!(!sync_launch_agent_in(&agents, &exe, &log, false, false).unwrap());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn exclusive_lock_prevents_concurrent_holder_and_detects_running_gui() {
        let tmp = std::env::temp_dir().join(format!("ompws-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let lock = tmp.join("gui.lock");
        assert!(!is_gui_running_at(&tmp));

        let guard = try_lock_exclusive(&lock).expect("first lock succeeds");
        assert!(try_lock_exclusive(&lock).is_none());
        assert!(is_gui_running_at(&tmp));

        drop(guard);
        assert!(!is_gui_running_at(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

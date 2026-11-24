//! Scheduled task execution runner.

use std::path::Path;
use std::time::Duration;

use crate::contracts::{
    AutomationOverlapPolicy, Schedule, ScheduleAgentTrigger, ScheduleNotify, ScheduleResultMode,
    ScheduleRun, ScheduleRunMode, ScheduleRunPhase, ScheduleRunStatus, SessionStatus, StartOpts,
    TodoKind, TodoSource,
};
use crate::schedules::probe::{self, ProbeOutcome};
use crate::schedules::store;
use crate::state::{AppEvent, AppState};
use crate::todos::store::NewTodo;

/// Upper bound for one scheduled run's wait for the turn to finish.
const RUN_TIMEOUT: Duration = Duration::from_secs(3600);
const PROBE_TIMEOUT: Duration = Duration::from_secs(300);

fn truncate_summary(text: &str) -> String {
    if text.chars().count() > 500 {
        format!("{}…", text.chars().take(500).collect::<String>())
    } else {
        text.to_string()
    }
}

/// Whether a finished run should produce an inbox todo under the schedule's
/// notify policy. `needed_attention` = the run entered AwaitingApproval or
/// AwaitingAnswer at any point (callers pass `false` when the run never
/// reached a session); a failed run always counts as important.
pub(crate) fn should_create_inbox_todo(
    notify: ScheduleNotify,
    ok: bool,
    needed_attention: bool,
) -> bool {
    match notify {
        ScheduleNotify::All => true,
        ScheduleNotify::Important => !ok || needed_attention,
        ScheduleNotify::None => false,
    }
}

/// Result of attempting to claim and dispatch a due schedule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DispatchOutcome {
    /// Claim succeeded and execution was spawned.
    Dispatched,
    /// Claim did not dispatch a run, but the schedule advanced or is no longer
    /// due at the expected instant (e.g. Skip/Coalesce/Queue or concurrent edit).
    Advanced,
    /// Claim failed while the schedule remains enabled and due at the expected
    /// instant (e.g. SQLite write-lock contention).
    Stalled,
}

/// Async due-schedule dispatcher used by the background scheduler loop:
/// offloads the blocking DB claim off Tokio workers and distinguishes normal
/// advancement (Skip/Coalesce/Queue) from stalled claim contention.
pub(crate) async fn dispatch_due_schedule(state: AppState, schedule: Schedule) -> DispatchOutcome {
    let Some(expected_next) = schedule.next_run_at.clone() else {
        return DispatchOutcome::Advanced;
    };
    let run_id = uuid::Uuid::new_v4().to_string();
    let db = state.db.clone();
    let schedule_id = schedule.id.clone();
    let run_id_for_db = run_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let guard = db.lock();
        match store::claim_run(&guard, &schedule_id, &run_id_for_db, Some(&expected_next)) {
            Ok(claimed) => Ok(claimed),
            Err(err) => {
                let still_due =
                    store::get(&guard, &schedule_id)
                        .ok()
                        .flatten()
                        .is_some_and(|cur| {
                            cur.enabled
                                && cur.next_run_at.as_deref() == Some(expected_next.as_str())
                        });
                Err((err, still_due))
            }
        }
    })
    .await;

    match outcome {
        Ok(Ok((claimed_schedule, _, policy))) => {
            tauri::async_runtime::spawn(async move {
                execute_run_with_existing_run(state, claimed_schedule, run_id, true, policy).await;
                crate::schedules::scheduler::notify_scheduler();
            });
            DispatchOutcome::Dispatched
        }
        Ok(Err((e, false))) => {
            tracing::debug!("Schedule {} not dispatched (advanced): {e}", schedule.id);
            DispatchOutcome::Advanced
        }
        Ok(Err((e, true))) => {
            tracing::warn!("Schedule {} claim stalled: {e}", schedule.id);
            DispatchOutcome::Stalled
        }
        Err(e) => {
            tracing::warn!("Schedule {} claim task join failed: {e}", schedule.id);
            DispatchOutcome::Stalled
        }
    }
}

/// Async pending-run dispatcher that offloads DB locking to `spawn_blocking`.
pub(crate) async fn spawn_pending_async(state: AppState, schedule_id: String) {
    let run_id = uuid::Uuid::new_v4().to_string();
    let db = state.db.clone();
    let schedule_id_for_db = schedule_id.clone();
    let run_id_for_db = run_id.clone();
    let claimed = tokio::task::spawn_blocking(move || {
        let guard = db.lock();
        store::claim_pending_run(&guard, &schedule_id_for_db, &run_id_for_db)
    })
    .await;
    match claimed {
        Ok(Ok(Some((schedule, _, policy)))) => {
            crate::state::emit_schedules_changed(&state);
            tauri::async_runtime::spawn(async move {
                execute_run_with_existing_run(state, schedule, run_id, true, policy).await;
                crate::schedules::scheduler::notify_scheduler();
            });
        }
        Ok(Ok(None)) => {}
        Ok(Err(e)) => tracing::warn!("Cannot claim queued automation {schedule_id}: {e}"),
        Err(e) => tracing::warn!("Cannot claim queued automation {schedule_id}: {e}"),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ResumeResult {
    Unrelated,
    Failed,
    CompletedUnsettled,
    CompletedSettled,
}

pub(crate) fn classify_resume_result(frame: &serde_json::Value, request_id: &str) -> ResumeResult {
    if frame.get("type").and_then(serde_json::Value::as_str) != Some("prompt_result")
        || frame.get("id").and_then(serde_json::Value::as_str) != Some(request_id)
    {
        return ResumeResult::Unrelated;
    }
    if frame
        .get("agentInvoked")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
        || frame.get("status").and_then(serde_json::Value::as_str) != Some("completed")
    {
        return ResumeResult::Failed;
    }
    match frame
        .get("sessionSettled")
        .and_then(serde_json::Value::as_bool)
    {
        Some(true) => ResumeResult::CompletedSettled,
        Some(false) => ResumeResult::CompletedUnsettled,
        None => ResumeResult::Failed,
    }
}

/// Continue one paused automation with an exclusive, request-correlated turn.
pub async fn resume_awaiting(
    state: AppState,
    schedule_id: String,
    run_id: String,
) -> Result<(), String> {
    let session_id = {
        let db = state.db.clone();
        let sid_key = schedule_id.clone();
        let rid_key = run_id.clone();
        tokio::task::spawn_blocking(move || {
            let guard = db.lock();
            store::list_awaiting_runs(&guard, &sid_key)
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|run| run.id == rid_key)
                .and_then(|run| run.session_id)
                .ok_or_else(|| "等待中的运行没有可恢复的会话".to_string())
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let (handle, attempt) = crate::rpc::reserve_automation_resume(&state, &session_id).await?;
    let reserved = {
        let db = state.db.clone();
        let sid_key = schedule_id.clone();
        let rid_key = run_id.clone();
        let sess_key = session_id.clone();
        let att_key = attempt.clone();
        tokio::task::spawn_blocking(move || {
            let guard = db.lock();
            store::begin_awaiting_resume(&guard, &sid_key, &rid_key, &sess_key, &att_key)
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
    };
    if let Err(e) = reserved {
        crate::rpc::clear_automation_resume_guard(handle.pid, &attempt);
        return Err(e);
    }
    let mut events = state.bus.subscribe();
    let response = crate::rpc::send_automation_resume(
        &state,
        &handle,
        &attempt,
        "请继续执行刚才因后台无人值守而暂停的步骤；如需我审批或回答问题，请现在直接提出。",
    )
    .await;
    let request_id = match response {
        Ok(response) => match response.get("id").and_then(serde_json::Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => {
                let db = state.db.clone();
                let rid = run_id.clone();
                let att = attempt.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let _ = store::abandon_awaiting_resume(&db.lock(), &rid, &att);
                })
                .await;
                crate::rpc::clear_automation_resume_guard(handle.pid, &attempt);
                return Err("恢复请求缺少关联标识，仍保持等待".to_string());
            }
        },
        Err(e) => {
            let db = state.db.clone();
            let rid = run_id.clone();
            let att = attempt.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = store::abandon_awaiting_resume(&db.lock(), &rid, &att);
            })
            .await;
            crate::rpc::clear_automation_resume_guard(handle.pid, &attempt);
            return Err(e);
        }
    };
    tauri::async_runtime::spawn(async move {
        let mut completed = false;
        let mut settled = false;
        while let Ok(event) = events.recv().await {
            match event {
                AppEvent::RpcFrame {
                    session_id: sid,
                    frame,
                } if sid == session_id => {
                    if !crate::rpc::automation_resume_owned(handle.pid, &attempt)
                        || !crate::rpc::get_handle(&session_id)
                            .is_some_and(|current| std::sync::Arc::ptr_eq(&current, &handle))
                    {
                        break;
                    }
                    match frame.get("type").and_then(serde_json::Value::as_str) {
                        Some("prompt_result") => {
                            match classify_resume_result(&frame, &request_id) {
                                ResumeResult::Unrelated => {}
                                ResumeResult::Failed => break,
                                ResumeResult::CompletedUnsettled => completed = true,
                                ResumeResult::CompletedSettled => {
                                    settled = true;
                                    break;
                                }
                            }
                        }
                        Some("session_settled") if completed => {
                            settled = true;
                            break;
                        }
                        _ => {}
                    }
                }
                AppEvent::RpcProcess {
                    session_id: sid,
                    running: false,
                    ..
                } if sid == session_id => break,
                _ => {}
            }
        }
        let (changed, snapshot_items) = {
            let db = state.db.clone();
            let rid = run_id.clone();
            let sess = session_id.clone();
            let att = attempt.clone();
            tokio::task::spawn_blocking(move || {
                let guard = db.lock();
                let changed = if settled {
                    match store::finish_awaiting_resume(&guard, &rid, &sess, &att) {
                        Ok(changed) => changed,
                        Err(e) => {
                            tracing::warn!("persist completed automation continuation: {e}");
                            let _ = store::abandon_awaiting_resume(&guard, &rid, &att);
                            false
                        }
                    }
                } else {
                    let _ = store::abandon_awaiting_resume(&guard, &rid, &att);
                    false
                };
                let items = if changed {
                    store::list(&guard).ok()
                } else {
                    None
                };
                (changed, items)
            })
            .await
            .unwrap_or((false, None))
        };
        crate::rpc::clear_automation_resume_guard(handle.pid, &attempt);
        crate::state::emit_schedules_changed(&state);
        if changed {
            crate::todos::notify_changed(&state);
            if let Some(items) = snapshot_items {
                let _ = tokio::task::spawn_blocking(move || {
                    store::write_catalog_snapshot_items(&items);
                })
                .await;
            }
            crate::schedules::scheduler::notify_scheduler();
        }
    });
    Ok(())
}

/// Manual and automatic runs share existence, cap and active-run guards.
pub(crate) fn create_schedule_worktree(
    base_path: &Path,
    name: &str,
    run_id: &str,
) -> Result<String, String> {
    // Non-ASCII names (e.g. Chinese) slug to "", so always prefix.
    let slug = crate::git::worktree::slugify(name);
    let run_id_short = &run_id[..run_id.len().min(8)];
    let wt_name = if slug.is_empty() {
        format!("sched-{run_id_short}")
    } else {
        format!("sched-{slug}-{run_id_short}")
    };
    crate::git::worktree::create(base_path, &wt_name, None, None).map(|info| info.path)
}

pub async fn run_now(state: AppState, id: String) -> Result<ScheduleRun, String> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let db = state.db.clone();
    let run_id_for_db = run_id.clone();
    let (schedule, run, policy) = tokio::task::spawn_blocking(move || {
        let guard = db.lock();
        store::claim_run(&guard, &id, &run_id_for_db, None)
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::state::emit_schedules_changed(&state);
    tauri::async_runtime::spawn(async move {
        execute_run_with_existing_run(state, schedule, run_id, false, policy).await;
        crate::schedules::scheduler::notify_scheduler();
    });
    Ok(run)
}

async fn execute_run_with_existing_run(
    state: AppState,
    schedule: Schedule,
    run_id: String,
    automatic: bool,
    policy: AutomationOverlapPolicy,
) {
    let base_path = Path::new(&schedule.cwd);
    if !base_path.exists() || !base_path.is_dir() {
        finish_with_error(
            &state,
            &schedule,
            &run_id,
            None,
            &format!("工作目录不存在：{}", schedule.cwd),
        );
        return;
    }

    // Worktree parallel runs isolate the probe as well as the agent; local
    // mode intentionally keeps the user's selected directory.
    let isolated_cwd = if automatic
        && policy == AutomationOverlapPolicy::Parallel
        && schedule.run_mode == ScheduleRunMode::Worktree
    {
        match create_schedule_worktree(base_path, &schedule.name, &run_id) {
            Ok(path) => Some(path),
            Err(e) => {
                finish_with_error(
                    &state,
                    &schedule,
                    &run_id,
                    None,
                    &format!("创建独立 worktree 失败：{e}"),
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
        // For `OnSignal` / `Always` with a probe, run the lightweight check in `base_path`
        // BEFORE creating a fresh git worktree so quiet checks do not spawn empty worktrees.
        let probe_cwd = if let Some(path) = &isolated_cwd {
            path.clone()
        } else if schedule.agent_trigger == ScheduleAgentTrigger::Never
            && matches!(schedule.run_mode, ScheduleRunMode::Worktree)
        {
            match create_schedule_worktree(base_path, &schedule.name, &run_id) {
                Ok(p) => p,
                Err(e) => {
                    finish_with_error(
                        &state,
                        &schedule,
                        &run_id,
                        None,
                        &format!("创建独立 worktree 失败：{e}"),
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
                {
                    let db = state.db.lock();
                    let _ = store::update_run_with_phase(
                        &db,
                        &run_id,
                        None,
                        ScheduleRunStatus::Ok,
                        Some(&now),
                        Some("脚本正常，无新变化"),
                        ScheduleRunPhase::ProbeQuiet,
                        None,
                    );
                }
                crate::state::emit_schedules_changed(&state);
                return;
            }
            ProbeOutcome::ScriptOk { output } => {
                let now = store::now_rfc3339();
                let structured = probe::parse_structured_result(&output);
                let mut status_kind = structured
                    .as_ref()
                    .and_then(|s| s.status.as_deref())
                    .map(|s| s.trim().to_ascii_lowercase())
                    .unwrap_or_else(|| "ok".to_string());
                let linked_session = structured
                    .as_ref()
                    .and_then(|s| s.session_id.as_deref())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let mut detail = structured
                    .as_ref()
                    .and_then(|s| s.summary.as_deref())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(truncate_summary);

                if schedule.result_mode == ScheduleResultMode::LlmSummary
                    && !output.trim().is_empty()
                {
                    let prompt = format!(
                        "Summarize this automation script output for the user in 1-2 concise sentences (same language as the automation name).\n\
                         Return ONLY a JSON object: {{\"status\":\"ok\"|\"skipped\"|\"warning\"|\"error\",\"summary\":\"...\"}}\n\
                         - Use \"skipped\" if the script decided not to act or aborted due to environment/safety checks.\n\
                         - Use \"warning\" if it partially succeeded or noted anomalies.\n\
                         - Use \"error\" if it reported a failure.\n\
                         Automation name: {}\n\
                         Raw output:\n{}",
                        schedule.name,
                        truncate_summary(&output),
                    );
                    if let Ok(raw_summary) = crate::todos::omp::run_print(
                        &state,
                        "smol",
                        &prompt,
                        Duration::from_secs(45),
                    )
                    .await
                    {
                        if let Some(parsed) = probe::parse_structured_result(&raw_summary) {
                            if let Some(st) = parsed
                                .status
                                .as_deref()
                                .map(|s| s.trim().to_ascii_lowercase())
                            {
                                if matches!(st.as_str(), "ok" | "skipped" | "warning" | "error") {
                                    status_kind = st;
                                }
                            }
                            if let Some(s) = parsed
                                .summary
                                .as_deref()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                            {
                                detail = Some(truncate_summary(s));
                            }
                        } else if !raw_summary.trim().is_empty() {
                            detail = Some(truncate_summary(raw_summary.trim()));
                        }
                    }
                }

                let final_detail = detail.unwrap_or_else(|| {
                    let first_line = output
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("")
                        .trim();
                    if first_line.is_empty() {
                        "脚本执行完成".to_string()
                    } else {
                        truncate_summary(first_line)
                    }
                });
                let stored_output = structured
                    .as_ref()
                    .and_then(|s| s.details.as_deref())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| output.clone());

                if status_kind == "error" {
                    finish_with_error_phase(
                        &state,
                        &schedule,
                        &run_id,
                        linked_session.as_deref(),
                        &final_detail,
                        ScheduleRunPhase::ProbeOnly,
                        Some(&stored_output),
                        true,
                    );
                    return;
                }

                let (run_status, is_warning) = match status_kind.as_str() {
                    "skipped" => (ScheduleRunStatus::Skipped, false),
                    "warning" => (ScheduleRunStatus::Ok, true),
                    _ => (ScheduleRunStatus::Ok, false),
                };
                let display_detail = if is_warning && !final_detail.starts_with("⚠") {
                    format!("⚠ {final_detail}")
                } else {
                    final_detail
                };
                let create_todo = run_status != ScheduleRunStatus::Skipped
                    && should_create_inbox_todo(schedule.notify, true, is_warning);
                {
                    let db = state.db.lock();
                    let _ = store::update_run_with_phase(
                        &db,
                        &run_id,
                        linked_session.as_deref(),
                        run_status,
                        Some(&now),
                        Some(&display_detail),
                        ScheduleRunPhase::ProbeOnly,
                        Some(&stored_output),
                    );
                    if create_todo {
                        let new_todo = NewTodo {
                            kind: TodoKind::ScheduleRun,
                            source: TodoSource::Schedule,
                            session_id: linked_session.clone(),
                            title: format!("自动化「{}」已完成", schedule.name),
                            detail: display_detail,
                            payload: serde_json::json!({
                                "scheduleId": schedule.id,
                                "runId": run_id,
                                "ok": true,
                                "probeOnly": true,
                            }),
                        };
                        let _ = crate::todos::store::upsert(
                            &db,
                            &format!("sched:{run_id}"),
                            &new_todo,
                            true,
                        );
                    }
                }
                if create_todo {
                    crate::todos::notify_changed(&state);
                }
                crate::state::emit_schedules_changed(&state);
                return;
            }
            ProbeOutcome::Failed { output } => {
                let err_msg = if output.trim().is_empty() {
                    "本地脚本执行失败".to_string()
                } else {
                    truncate_summary(output.trim())
                };
                finish_with_error_phase(
                    &state,
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
        finish_with_error_phase(
            &state,
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
                match create_schedule_worktree(base_path, &schedule.name, &run_id) {
                    Ok(p) => p,
                    Err(e) => {
                        finish_with_error_phase(
                            &state,
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

    let label = format!("⏰ {}", schedule.name);

    // `new_chat_each_run == false` continues the previous run's session —
    // local mode only; worktree runs always start fresh.
    let resume_file = if (!automatic || policy != AutomationOverlapPolicy::Parallel)
        && !schedule.new_chat_each_run
        && matches!(schedule.run_mode, ScheduleRunMode::Local)
    {
        let db = state.db.lock();
        store::last_run_session_file(&db, &schedule.id).unwrap_or(None)
    } else {
        None
    };
    let resume_file = resume_file.filter(|f| {
        let exists = Path::new(f).is_file();
        if !exists {
            tracing::warn!(
                "schedule {}: resume file {f} missing; starting a fresh session",
                schedule.id
            );
        }
        exists
    });

    let mut opts = StartOpts {
        cwd: effective_cwd,
        model: schedule.model.clone(),
        approval_mode: schedule.approval_mode.clone(),
        label: Some(label),
        mode: if resume_file.is_none() {
            Some(schedule.mode)
        } else {
            None
        },
        resume_file,
        ..Default::default()
    };

    let mut bus_rx = state.bus.subscribe();

    let info = match crate::rpc::start(&state, &opts).await {
        Ok(info) => info,
        Err(e) if opts.resume_file.is_some() => {
            // Resume refused (e.g. SESSION_HELD: another process owns the file)
            // or the file is unreadable — fall back to a fresh session.
            tracing::warn!(
                "schedule {}: resume failed ({e}); starting a fresh session",
                schedule.id
            );
            opts.resume_file = None;
            opts.mode = Some(schedule.mode);
            match crate::rpc::start(&state, &opts).await {
                Ok(info) => info,
                Err(e) => {
                    finish_with_error(
                        &state,
                        &schedule,
                        &run_id,
                        None,
                        &format!("启动会话失败：{e}"),
                    );
                    return;
                }
            }
        }
        Err(e) => {
            finish_with_error(
                &state,
                &schedule,
                &run_id,
                None,
                &format!("启动会话失败：{e}"),
            );
            return;
        }
    };

    let session_id = info.session_id.clone();
    {
        let db = state.db.lock();
        let _ = store::update_run_with_phase(
            &db,
            &run_id,
            Some(&session_id),
            ScheduleRunStatus::Running,
            None,
            None,
            ScheduleRunPhase::Agent,
            probe_context.as_deref(),
        );
    }
    // Apply the schedule's thinking level (same RPC the interactive composer sends).
    if let Some(level) = schedule
        .thinking
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(handle) = crate::rpc::get_handle(&session_id) {
            let cmd = serde_json::json!({ "type": "set_thinking_level", "level": level });
            if let Err(e) = crate::rpc::send_command(&handle, cmd).await {
                tracing::warn!("schedule run {run_id}: set_thinking_level failed: {e}");
            }
        }
    }
    crate::state::emit_schedules_changed(&state);

    let effective_prompt = match probe_context
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(ctx) => format!(
            "<automation_check_output>\n{ctx}\n</automation_check_output>\n\n{}",
            schedule.prompt
        ),
        None => schedule.prompt.clone(),
    };

    if let Err(e) = crate::rpc::send_prompt(&state, &session_id, &effective_prompt).await {
        stop_session_process(&session_id).await;
        finish_with_error_phase(
            &state,
            &schedule,
            &run_id,
            Some(&session_id),
            &format!("发送提示词失败：{e}"),
            ScheduleRunPhase::Agent,
            probe_context.as_deref(),
            false,
        );
        return;
    }

    let mut ok = false;
    let mut paused_awaiting = false;
    let mut waiting_for_user = false;
    let mut awaiting_kind = "approval";
    // Status events emitted while the session was starting (e.g. → Idle) are
    // already queued on `bus_rx`; only Idle/Review observed after the turn
    // actually started working count as completion.
    let mut started = false;
    // Tracks whether the run ever stopped for approval/an answer — makes a
    // finished run "important" under `ScheduleNotify::Important`.
    let mut needed_attention = false;
    let target_sid = session_id.clone();
    // One absolute deadline for the whole wait. Re-creating the sleep inside the
    // loop would restart it on every unrelated bus event, so a busy app could
    // keep a stuck run alive past the documented one-hour cap.
    let mut deadline = tokio::time::Instant::now() + RUN_TIMEOUT;
    loop {
        tokio::select! {
            ev = bus_rx.recv() => {
                match ev {
                    Ok(AppEvent::SessionStatusChanged { session_id: sid, new, .. }) if sid == target_sid => {
                        match new {
                            SessionStatus::Review => {
                                ok = true;
                                break;
                            }
                            SessionStatus::Idle if started => {
                                ok = true;
                                break;
                            }
                            SessionStatus::Error | SessionStatus::Interrupted => {
                                ok = false;
                                break;
                            }
                            SessionStatus::AwaitingApproval | SessionStatus::AwaitingAnswer => {
                                waiting_for_user = true;
                                awaiting_kind = if new == SessionStatus::AwaitingAnswer { "question" } else { "approval" };
                                needed_attention = true;
                                started = true;
                                {
                                    let db = state.db.lock();
                                    let reason = if awaiting_kind == "question" { "等待回答" } else { "等待审批" };
                                    let _ = store::update_run_with_phase(&db, &run_id, Some(&session_id),
                                        ScheduleRunStatus::Running, None, Some(reason),
                                        ScheduleRunPhase::Awaiting, probe_context.as_deref());
                                }
                                if !main_window_visible(&state) {
                                    paused_awaiting = true;
                                    break;
                                }
                            }
                            SessionStatus::Working => {
                                if waiting_for_user {
                                    deadline = tokio::time::Instant::now() + RUN_TIMEOUT;
                                    let db = state.db.lock();
                                    let _ = store::update_run_with_phase(&db, &run_id, Some(&session_id),
                                        ScheduleRunStatus::Running, None, None,
                                        ScheduleRunPhase::Agent, probe_context.as_deref());
                                }
                                waiting_for_user = false;
                                started = true;
                            },
                            _ => {}
                        }
                    }
                    Ok(AppEvent::RpcProcess { session_id: sid, running, exit_code }) if sid == target_sid => {
                        if !running {
                            // Only a clean `exit 0` counts as success; a signal
                            // kill reports `None` and must not read as success.
                            ok = exit_code == Some(0);
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break;
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep_until(deadline), if !waiting_for_user => {
                ok = false;
                break;
            }
        }
    }

    tokio::time::sleep(Duration::from_millis(150)).await;
    // The run is over (ok, error, timeout, or paused awaiting human confirmation): don't leave its omp process behind.
    stop_session_process(&session_id).await;

    if paused_awaiting {
        let now = store::now_rfc3339();
        let detail = if awaiting_kind == "question" {
            "运行过程中需要你的回答，已安全暂停。打开 Vecway 即可继续处理。"
        } else {
            "运行过程中需要你的审批，已安全暂停。打开 Vecway 即可继续处理。"
        };
        let notify_sound = {
            let s = state.settings.read();
            let in_quiet = match (&s.notify_quiet_from, &s.notify_quiet_to) {
                (Some(from), Some(to)) => {
                    let cur = chrono::Local::now().format("%H:%M").to_string();
                    crate::notify::in_quiet_hours(&cur, from.trim(), to.trim())
                }
                _ => false,
            };
            (!in_quiet).then_some(s.notify_sound)
        };
        {
            let db = state.db.lock();
            let _ = store::update_run_with_phase(
                &db,
                &run_id,
                Some(&session_id),
                ScheduleRunStatus::Ok,
                Some(&now),
                Some(detail),
                ScheduleRunPhase::Awaiting,
                probe_context.as_deref(),
            );
            let new_todo = NewTodo {
                kind: TodoKind::ScheduleRun,
                source: TodoSource::Schedule,
                session_id: Some(session_id.clone()),
                title: format!("自动化「{}」等你确认", schedule.name),
                detail: detail.to_string(),
                payload: serde_json::json!({
                    "scheduleId": schedule.id,
                    "runId": run_id,
                    "ok": true,
                    "awaiting": true,
                    "awaitingKind": awaiting_kind,
                }),
            };
            let _ = crate::todos::store::upsert(&db, &format!("sched:{run_id}"), &new_todo, true);
        }
        if let Some(sound) = notify_sound {
            let _ = crate::notify::send(
                &state,
                &format!("自动化「{}」等你确认", schedule.name),
                "需要你的审批或回答，已安全暂停",
                sound,
            );
        }
        crate::todos::notify_changed(&state);
        crate::state::emit_schedules_changed(&state);
        return;
    }

    let file_path: Option<String> = {
        let db = state.db.lock();
        db.query_row(
            "SELECT file_path FROM session_meta WHERE session_id = ?1",
            rusqlite::params![&session_id],
            |r| r.get(0),
        )
        .ok()
    };

    let last_text = file_path.and_then(|p| crate::mobile::last::last_assistant_text(Path::new(&p)));

    let detail = if let Some(t) = last_text {
        truncate_summary(&t)
    } else if ok {
        "自动化执行完成".to_string()
    } else {
        "自动化执行失败".to_string()
    };

    let now = store::now_rfc3339();
    let status = if ok {
        ScheduleRunStatus::Ok
    } else {
        ScheduleRunStatus::Error
    };

    {
        let db = state.db.lock();
        let _ = store::update_run_with_phase(
            &db,
            &run_id,
            Some(&session_id),
            status,
            Some(&now),
            Some(&detail),
            ScheduleRunPhase::Agent,
            probe_context.as_deref(),
        );

        let create_todo = should_create_inbox_todo(schedule.notify, ok, needed_attention);
        if create_todo {
            let title = if ok {
                format!("自动化「{}」已完成", schedule.name)
            } else {
                format!("自动化「{}」运行失败", schedule.name)
            };

            let new_todo = NewTodo {
                kind: TodoKind::ScheduleRun,
                source: TodoSource::Schedule,
                session_id: Some(session_id),
                title,
                detail,
                payload: serde_json::json!({
                    "scheduleId": schedule.id,
                    "runId": run_id,
                    "ok": ok,
                }),
            };

            let _ = crate::todos::store::upsert(&db, &format!("sched:{run_id}"), &new_todo, true);
        }
    }

    if should_create_inbox_todo(schedule.notify, ok, needed_attention) {
        crate::todos::notify_changed(&state);
    }
    crate::state::emit_schedules_changed(&state);
}

fn main_window_visible(state: &AppState) -> bool {
    use tauri::Manager as _;
    state
        .app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

async fn stop_session_process(session_id: &str) {
    if let Some(handle) = crate::rpc::get_handle(session_id) {
        if let Err(e) = crate::rpc::stop(&handle).await {
            tracing::warn!("schedule: stop {session_id} failed: {e}");
        }
    }
}

fn finish_with_error(
    state: &AppState,
    schedule: &Schedule,
    run_id: &str,
    session_id: Option<&str>,
    err_msg: &str,
) {
    finish_with_error_phase(
        state,
        schedule,
        run_id,
        session_id,
        err_msg,
        ScheduleRunPhase::Agent,
        None,
        false,
    );
}

#[allow(clippy::too_many_arguments)]
fn finish_with_error_phase(
    state: &AppState,
    schedule: &Schedule,
    run_id: &str,
    session_id: Option<&str>,
    err_msg: &str,
    phase: ScheduleRunPhase,
    probe_output: Option<&str>,
    probe_error: bool,
) {
    let now = store::now_rfc3339();
    {
        let db = state.db.lock();
        let _ = store::update_run_with_phase(
            &db,
            run_id,
            session_id,
            ScheduleRunStatus::Error,
            Some(&now),
            Some(err_msg),
            phase,
            probe_output,
        );

        // Errors count as important under every policy except `none`.
        if should_create_inbox_todo(schedule.notify, false, false) {
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

            let _ = crate::todos::store::upsert(&db, &format!("sched:{run_id}"), &new_todo, true);
        }
    }

    if should_create_inbox_todo(schedule.notify, false, false) {
        crate::todos::notify_changed(state);
    }
    crate::state::emit_schedules_changed(state);
}

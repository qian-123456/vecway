//! Tauri commands for automations management.

use std::path::Path;
use std::time::Duration;

use tauri::{Emitter, State};

use crate::contracts::{
    AutomationAuthorResult, ProbeTestResult, Schedule, ScheduleAgentTrigger, ScheduleDraft,
    ScheduleRun,
};
use crate::schedules::probe::{self, ProbeOutcome};
use crate::schedules::{author, runner, scheduler, store};
use crate::state::AppState;

#[tauri::command]
pub async fn schedules_list(state: State<'_, AppState>) -> Result<Vec<Schedule>, String> {
    store::list(&state.db.lock()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn schedules_save(
    state: State<'_, AppState>,
    schedule: ScheduleDraft,
) -> Result<Schedule, String> {
    let saved = {
        let db = state.db.lock();
        let res = store::upsert(&db, &schedule)?;
        store::write_catalog_snapshot(&db);
        res
    };
    scheduler::notify_scheduler();
    let _ = state.app.emit("schedules:changed", ());
    Ok(saved)
}

#[tauri::command]
pub async fn schedules_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    {
        let db = state.db.lock();
        store::delete(&db, &id).map_err(|e| e.to_string())?;
        store::write_catalog_snapshot(&db);
    }
    scheduler::notify_scheduler();
    let _ = state.app.emit("schedules:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn schedules_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<Schedule, String> {
    let updated = {
        let db = state.db.lock();
        let res = store::set_enabled(&db, &id, enabled)?;
        store::write_catalog_snapshot(&db);
        res
    };
    scheduler::notify_scheduler();
    let _ = state.app.emit("schedules:changed", ());
    Ok(updated)
}

#[tauri::command]
pub async fn schedules_run_now(
    state: State<'_, AppState>,
    id: String,
) -> Result<ScheduleRun, String> {
    runner::run_now((*state).clone(), id).await
}

#[tauri::command]
pub async fn schedules_resume_awaiting(
    state: State<'_, AppState>,
    schedule_id: String,
    run_id: String,
) -> Result<(), String> {
    runner::resume_awaiting((*state).clone(), schedule_id, run_id).await
}

/// Explicitly release one paused run; this does not stop its session.
#[tauri::command]
pub async fn schedules_release_awaiting(
    state: State<'_, AppState>,
    schedule_id: String,
    run_id: String,
) -> Result<(), String> {
    let (session_id, attempt) = {
        let db = state.db.lock();
        let session_id = store::list_awaiting_runs(&db, &schedule_id)
            .map_err(|e| e.to_string())?.into_iter()
            .find(|run| run.id == run_id).and_then(|run| run.session_id);
        let attempt: Option<String> = db.query_row(
            "SELECT resume_attempt FROM schedule_runs WHERE id = ?1 AND schedule_id = ?2",
            rusqlite::params![run_id, schedule_id], |row| row.get(0),
        ).ok().flatten();
        store::release_awaiting(&db, &schedule_id, &run_id)?;
        store::write_catalog_snapshot(&db);
        (session_id, attempt)
    };
    if let (Some(handle), Some(attempt)) = (
        session_id.as_deref().and_then(crate::rpc::get_handle), attempt.as_deref(),
    ) {
        crate::rpc::clear_automation_resume_guard(handle.pid, attempt);
    }
    crate::todos::notify_changed(&state);
    scheduler::notify_scheduler();
    let _ = state.app.emit("schedules:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn schedules_list_awaiting(
    state: State<'_, AppState>,
    schedule_id: String,
) -> Result<Vec<ScheduleRun>, String> {
    store::list_awaiting_runs(&state.db.lock(), &schedule_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn schedule_runs(
    state: State<'_, AppState>,
    schedule_id: String,
    limit: Option<u32>,
) -> Result<Vec<ScheduleRun>, String> {
    store::list_runs(&state.db.lock(), &schedule_id, limit.unwrap_or(20)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn schedules_test_probe(
    cwd: String,
    probe_command: String,
    agent_trigger: ScheduleAgentTrigger,
    schedule_id: Option<String>,
) -> Result<ProbeTestResult, String> {
    let dir = Path::new(cwd.trim());
    if !dir.exists() || !dir.is_dir() {
        return Err(format!("工作目录不存在：{cwd}"));
    }
    let cmd = probe_command.trim();
    if cmd.is_empty() {
        return Err("请填写本地脚本或命令".to_string());
    }
    let (exit_code, timed_out, duration_ms, outcome, combined) = probe::execute_probe(
        dir,
        cmd,
        agent_trigger,
        schedule_id.as_deref(),
        Duration::from_secs(30),
    )
    .await;
    let (outcome_str, output) = match outcome {
        ProbeOutcome::Quiet => ("quiet", combined),
        ProbeOutcome::WakeAgent { context } => ("signal", context),
        ProbeOutcome::ScriptOk { output } => ("ok", output),
        ProbeOutcome::Failed { output } => ("error", output),
    };
    Ok(ProbeTestResult {
        exit_code,
        timed_out,
        duration_ms,
        output,
        outcome: outcome_str.to_string(),
    })
}

#[tauri::command]
pub async fn schedules_generate_draft(
    state: State<'_, AppState>,
    request: String,
    cwd: String,
    current: Option<ScheduleDraft>,
) -> Result<AutomationAuthorResult, String> {
    author::generate_draft(&state, &request, &cwd, current).await
}

//! Tauri commands for automations management.

use std::path::Path;
use std::time::Duration;

use tauri::State;

use crate::contracts::{
    AutomationAuthorResult, ProbeTestResult, Schedule, ScheduleAgentTrigger, ScheduleDraft,
    ScheduleRun,
};
use crate::schedules::probe::{self, ProbeOutcome};
use crate::schedules::{author, runner, scheduler, store};
use crate::state::AppState;

async fn blocking_db<T, F>(state: &AppState, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
{
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || f(&db.lock()))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

async fn blocking_db_with_snapshot<T, E, F>(state: &AppState, f: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<String> + Send + 'static,
    F: FnOnce(&rusqlite::Connection) -> Result<T, E> + Send + 'static,
{
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let (res, snapshot_items) = {
            let guard = db.lock();
            let res = f(&guard)?;
            let items = store::list(&guard).ok();
            (res, items)
        };
        // Serialize JSON and atomically write catalog.json AFTER releasing the DB mutex.
        if let Some(items) = snapshot_items {
            store::write_catalog_snapshot_items(&items);
        }
        Ok(res)
    })
    .await
    .map_err(|e| E::from(format!("task failed: {e}")))?
}

#[tauri::command]
pub async fn schedules_list(state: State<'_, AppState>) -> Result<Vec<Schedule>, String> {
    blocking_db(&state, |db| store::list(db).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn schedules_save(
    state: State<'_, AppState>,
    schedule: ScheduleDraft,
) -> Result<Schedule, String> {
    let saved = blocking_db_with_snapshot(&state, move |db| store::upsert(db, &schedule)).await?;
    scheduler::notify_scheduler();
    crate::state::emit_schedules_changed(&state);
    Ok(saved)
}

/// Create a brand-new schedule (preserving an unused `schedule.id`, rejecting duplicates).
pub async fn schedules_create_unique(
    state: &AppState,
    schedule: ScheduleDraft,
) -> Result<Schedule, store::CreateScheduleError> {
    let saved = blocking_db_with_snapshot(state, move |db| store::create_new(db, &schedule)).await?;
    scheduler::notify_scheduler();
    crate::state::emit_schedules_changed(state);
    Ok(saved)
}

#[tauri::command]
pub async fn schedules_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    blocking_db_with_snapshot(&state, move |db| store::delete(db, &id)).await?;
    scheduler::notify_scheduler();
    crate::state::emit_schedules_changed(&state);
    Ok(())
}

#[tauri::command]
pub async fn schedules_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<Schedule, String> {
    let updated =
        blocking_db_with_snapshot(&state, move |db| store::set_enabled(db, &id, enabled)).await?;
    scheduler::notify_scheduler();
    crate::state::emit_schedules_changed(&state);
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
    let (session_id, attempt) = blocking_db_with_snapshot(&state, move |db| {
        let session_id = store::list_awaiting_runs(db, &schedule_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|run| run.id == run_id)
            .and_then(|run| run.session_id);
        let attempt: Option<String> = db
            .query_row(
                "SELECT resume_attempt FROM schedule_runs WHERE id = ?1 AND schedule_id = ?2",
                rusqlite::params![run_id, schedule_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        store::release_awaiting(db, &schedule_id, &run_id)?;
        Ok::<_, String>((session_id, attempt))
    })
    .await?;
    if let (Some(handle), Some(attempt)) = (
        session_id.as_deref().and_then(crate::rpc::get_handle),
        attempt.as_deref(),
    ) {
        crate::rpc::clear_automation_resume_guard(handle.pid, attempt);
    }
    crate::todos::notify_changed(&state);
    scheduler::notify_scheduler();
    crate::state::emit_schedules_changed(&state);
    Ok(())
}

#[tauri::command]
pub async fn schedules_list_awaiting(
    state: State<'_, AppState>,
    schedule_id: String,
) -> Result<Vec<ScheduleRun>, String> {
    blocking_db(&state, move |db| {
        store::list_awaiting_runs(db, &schedule_id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn schedule_runs(
    state: State<'_, AppState>,
    schedule_id: String,
    limit: Option<u32>,
) -> Result<Vec<ScheduleRun>, String> {
    blocking_db(&state, move |db| {
        store::list_runs(db, &schedule_id, limit.unwrap_or(20)).map_err(|e| e.to_string())
    })
    .await
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

pub async fn schedules_generate_draft_with_options(
    state: &AppState,
    request: String,
    cwd: String,
    current: Option<ScheduleDraft>,
    preview: bool,
) -> Result<AutomationAuthorResult, String> {
    author::generate_draft_with_options(state, &request, &cwd, current, preview).await
}

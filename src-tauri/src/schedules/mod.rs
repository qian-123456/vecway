//! Automations module (two-stage probe -> agent workflows).

pub mod author;
pub mod commands;
pub mod daemon;
pub mod probe;
pub mod runner;
pub mod scheduler;
pub mod store;
#[cfg(test)]
mod tests;

use crate::state::AppState;

pub fn init(state: AppState) {
    {
        let db = state.db.lock();
        store::write_catalog_snapshot(&db);
    }
    let state_for_sync = state.clone();
    tauri::async_runtime::spawn(async move {
        crate::settings::reconcile_launch_agent(&state_for_sync).await;
    });
    scheduler::start(state);
}

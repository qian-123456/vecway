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
    daemon::sync_launch_agent(state.settings.read().automation_background_enabled);
    scheduler::start(state);
}

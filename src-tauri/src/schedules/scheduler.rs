//! Background scheduler: sleeps until the earliest next_run_at, wakes on schedule updates.

use chrono::Local;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::schedules::{runner, store};
use crate::state::AppState;

static SCHEDULER_NOTIFY: OnceLock<Arc<tokio::sync::Notify>> = OnceLock::new();

pub fn get_notify() -> Arc<tokio::sync::Notify> {
    SCHEDULER_NOTIFY
        .get_or_init(|| Arc::new(tokio::sync::Notify::new()))
        .clone()
}
pub fn notify_scheduler() {
    get_notify().notify_one();
}

const CLAIM_BACKOFF_INITIAL: Duration = Duration::from_millis(100);
const CLAIM_BACKOFF_MAX: Duration = Duration::from_secs(5);

/// Compute bounded exponential backoff after `failures` consecutive unproductive
/// due-claim passes (`0` = no delay, then `100ms`, `200ms`, ..., capped at `5s`).
pub(crate) fn claim_backoff(failures: u32) -> Duration {
    if failures == 0 {
        return Duration::ZERO;
    }
    let shift = (failures - 1).min(10);
    CLAIM_BACKOFF_INITIAL
        .saturating_mul(1u32 << shift)
        .min(CLAIM_BACKOFF_MAX)
}

async fn with_db<T, F>(state: &AppState, f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce(&rusqlite::Connection) -> T + Send + 'static,
{
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || f(&db.lock()))
        .await
        .ok()
}

/// Start the scheduler background loop.
pub fn start(state: AppState) {
    let notify = get_notify();

    tauri::async_runtime::spawn(async move {
        // 0. Settle runs a previous process left `running` (crash / force quit):
        // `has_active_run` treats them as in progress, which would block every
        // later automatic and manual trigger of that schedule forever.
        let recovered = with_db(&state, |db| {
            store::recover_stale_runs(db, &store::now_rfc3339())
        })
        .await;
        match recovered {
            Some(Ok(0)) | None => {}
            Some(Ok(n)) => {
                tracing::info!("Settled {n} interrupted scheduled run(s)");
                crate::state::emit_schedules_changed(&state);
            }
            Some(Err(e)) => tracing::warn!("recover interrupted scheduled runs: {e}"),
        }

        // 1. Startup catch-up: any enabled schedule that missed its run while the app was closed.
        let now = Local::now().to_rfc3339();
        let missed_schedules = with_db(&state, move |db| {
            store::find_due(db, &now).unwrap_or_default()
        })
        .await
        .unwrap_or_default();

        if !missed_schedules.is_empty() {
            tracing::info!(
                "Running {} missed scheduled tasks on startup",
                missed_schedules.len()
            );
            let mut any_changed = false;
            for s in missed_schedules {
                if !matches!(
                    runner::dispatch_due_schedule(state.clone(), s).await,
                    runner::DispatchOutcome::Stalled
                ) {
                    any_changed = true;
                }
            }
            if any_changed {
                crate::state::emit_schedules_changed(&state);
            }
        }

        // 2. Main sleep-and-wake loop.
        let mut claim_failures: u32 = 0;
        loop {
            // A daemon may have crashed after the GUI started; only dead
            // owners are recovered, so live cross-process runs remain intact.
            if let Some(Err(e)) = with_db(&state, |db| {
                store::recover_stale_runs(db, &store::now_rfc3339())
            })
            .await
            {
                tracing::warn!("recover interrupted scheduled runs: {e}");
            }

            let pending = with_db(&state, |db| {
                store::pending_schedule_ids(db).unwrap_or_default()
            })
            .await
            .unwrap_or_default();
            for id in pending {
                runner::spawn_pending_async(state.clone(), id).await;
            }

            let earliest = with_db(&state, |db| store::earliest_next_run(db).unwrap_or(None))
                .await
                .flatten();

            match earliest {
                Some(target_time) => {
                    let now = Local::now();
                    if target_time <= now {
                        let now_str = now.to_rfc3339();
                        let due_schedules = with_db(&state, move |db| {
                            store::find_due(db, &now_str).unwrap_or_default()
                        })
                        .await
                        .unwrap_or_default();

                        let mut stalled = due_schedules.is_empty();
                        let mut any_changed = false;
                        for s in due_schedules {
                            match runner::dispatch_due_schedule(state.clone(), s).await {
                                runner::DispatchOutcome::Dispatched
                                | runner::DispatchOutcome::Advanced => {
                                    any_changed = true;
                                }
                                runner::DispatchOutcome::Stalled => {
                                    stalled = true;
                                }
                            }
                        }

                        if any_changed {
                            crate::state::emit_schedules_changed(&state);
                        }

                        if stalled {
                            claim_failures = claim_failures.saturating_add(1);
                            let delay = claim_backoff(claim_failures);
                            tokio::select! {
                                _ = tokio::time::sleep(delay) => {}
                                _ = notify.notified() => {}
                            }
                        } else {
                            claim_failures = 0;
                            tokio::task::yield_now().await;
                        }
                        continue;
                    }

                    claim_failures = 0;
                    let diff_ms = (target_time - now).num_milliseconds();
                    let sleep_duration = if diff_ms <= 0 {
                        Duration::from_millis(200)
                    } else {
                        Duration::from_millis(diff_ms as u64).min(Duration::from_secs(5))
                    };

                    tokio::select! {
                        _ = tokio::time::sleep(sleep_duration) => {}
                        _ = notify.notified() => {}
                    }
                }
                None => {
                    claim_failures = 0;
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                        _ = notify.notified() => {}
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_backoff_doubles_and_caps() {
        assert_eq!(claim_backoff(0), Duration::ZERO);
        assert_eq!(claim_backoff(1), Duration::from_millis(100));
        assert_eq!(claim_backoff(2), Duration::from_millis(200));
        assert_eq!(claim_backoff(3), Duration::from_millis(400));
        assert_eq!(claim_backoff(4), Duration::from_millis(800));
        assert_eq!(claim_backoff(5), Duration::from_millis(1600));
        assert_eq!(claim_backoff(6), Duration::from_millis(3200));
        assert_eq!(claim_backoff(7), CLAIM_BACKOFF_MAX);
        assert_eq!(claim_backoff(100), CLAIM_BACKOFF_MAX);
        assert_eq!(claim_backoff(u32::MAX), CLAIM_BACKOFF_MAX);
    }

    #[tokio::test]
    async fn claim_backoff_sleeps_and_wakes_on_notify() {
        let notify = Arc::new(tokio::sync::Notify::new());
        let start = tokio::time::Instant::now();
        let delay = claim_backoff(1);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = notify.notified() => panic!("unexpected notify"),
        }
        assert!(start.elapsed() >= Duration::from_millis(80));

        let notify_wake = notify.clone();
        let wake_start = tokio::time::Instant::now();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            notify_wake.notify_one();
        });
        tokio::select! {
            _ = tokio::time::sleep(claim_backoff(10)) => panic!("should wake on notify"),
            _ = notify.notified() => {}
        }
        assert!(wake_start.elapsed() < Duration::from_secs(1));
    }
}

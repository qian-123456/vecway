//! [A] Background loops: watcher, external process detection (lsof + status files),
//! and AppState event bus subscription.

use notify_debouncer_full::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tracing::warn;

use super::cat;
use super::external;
use super::status::{self, LiveEvent};
use super::store;
use crate::paths;
use crate::state::{AppEvent, AppState};

static EXTERNAL_NOTIFY: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
static EXTERNAL_DIRTY: AtomicBool = AtomicBool::new(false);

pub fn notify_external_check() {
    EXTERNAL_DIRTY.store(true, Ordering::Release);
    if let Some(notify) = EXTERNAL_NOTIFY.get() {
        notify.notify_one();
    }
}

fn cooldown_remaining(last_sweep: Instant, now: Instant, min_cooldown: Duration) -> Duration {
    min_cooldown.saturating_sub(now.saturating_duration_since(last_sweep))
}
pub fn spawn_all(state: AppState) {
    // Subscribe to the bus synchronously so no startup events are missed.
    let bus_rx = state.bus.subscribe();

    let s1 = state.clone();
    tauri::async_runtime::spawn(async move {
        // Initial catalog build (double-checked under `scan_lock`; global workspace
        // rows are ensured inside `rebuild_blocking` off the async worker).
        super::ensure_ready(&s1).await;
    });

    let s2 = state.clone();
    tauri::async_runtime::spawn(async move {
        run_watcher(s2).await;
    });

    let s3 = state.clone();
    tauri::async_runtime::spawn(async move {
        run_external_loop(s3).await;
    });

    let s4 = state.clone();
    tauri::async_runtime::spawn(async move {
        run_bus_loop(s4, bus_rx).await;
    });

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if let Ok(summary) =
            tokio::task::spawn_blocking(crate::storage::clean_expired_status_records_blocking).await
        {
            if summary.count > 0 {
                tracing::info!(
                    count = summary.count,
                    bytes = summary.bytes,
                    "cleaned expired status files at startup"
                );
            }
        }
    });
}

async fn run_watcher(state: AppState) {
    let sessions_dir = paths::omp_sessions_dir();
    let status_dir = paths::status_dir();
    let _ = std::fs::create_dir_all(&sessions_dir);
    let _ = std::fs::create_dir_all(&status_dir);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WatchBatch>();

    let watch_root = sessions_dir.clone();
    let status_root = status_dir.clone();
    let debouncer_res = new_debouncer(
        Duration::from_millis(300),
        None,
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let batch = classify_events(
                    &watch_root,
                    &status_root,
                    events.iter().flat_map(|ev| ev.paths.iter()),
                );
                if !batch.is_empty() {
                    let _ = tx.send(batch);
                }
            }
        },
    );

    let mut debouncer = match debouncer_res {
        Ok(d) => d,
        Err(e) => {
            warn!("failed to create session file debouncer: {e}");
            return;
        }
    };

    if let Err(e) = debouncer.watch(&sessions_dir, RecursiveMode::Recursive) {
        warn!("failed to watch sessions dir {sessions_dir:?}: {e}");
    }
    if let Err(e) = debouncer.watch(&status_dir, RecursiveMode::NonRecursive) {
        warn!("failed to watch status dir {status_dir:?}: {e}");
    }

    while let Some(mut batch) = rx.recv().await {
        // Coalesce rapid bursts of file modifications
        tokio::time::sleep(Duration::from_millis(50)).await;
        while let Ok(more) = rx.try_recv() {
            batch.merge(more);
        }
        let notify_external = !batch.is_empty();
        if batch.full {
            super::search::request_rescan();
            super::rebuild(&state).await;
        } else if !batch.sessions.is_empty() {
            super::search::request_paths(batch.sessions.iter().cloned().collect());
            super::refresh_paths(&state, batch.sessions.into_iter().collect()).await;
        }
        if notify_external {
            notify_external_check();
        }
    }
}

/// Watcher events reduced to what the catalog must do.
#[derive(Default)]
struct WatchBatch {
    /// Something other than a plain change to a known-shaped session file
    /// or status file (e.g. unexpected locations): rescan everything.
    full: bool,
    /// Changed `<sessions>/<bucket>/<name>.jsonl` files.
    sessions: std::collections::HashSet<std::path::PathBuf>,
    /// Changed `.json` files under `<status_dir>`.
    status_changed: bool,
}

impl WatchBatch {
    fn is_empty(&self) -> bool {
        !self.full && self.sessions.is_empty() && !self.status_changed
    }
    fn merge(&mut self, other: WatchBatch) {
        self.full |= other.full;
        self.sessions.extend(other.sessions);
        self.status_changed |= other.status_changed;
    }
}

fn classify_events<'a>(
    sessions_dir: &std::path::Path,
    status_dir: &std::path::Path,
    paths: impl Iterator<Item = &'a std::path::PathBuf>,
) -> WatchBatch {
    let mut batch = WatchBatch::default();
    for p in paths {
        let ext = p.extension().and_then(|x| x.to_str());
        if !matches!(ext, Some("jsonl" | "json")) {
            continue;
        }
        if ext == Some("json") && p.starts_with(status_dir) {
            batch.status_changed = true;
        } else if ext == Some("jsonl") && super::scan::is_session_file(sessions_dir, p) {
            batch.sessions.insert(p.clone());
        } else if ext == Some("jsonl") && p.starts_with(sessions_dir) {
            // Subagent / artifact logs below a session dir: not catalog input.
        } else {
            batch.full = true;
        }
    }
    batch
}

async fn run_external_loop(state: AppState) {
    let notify = EXTERNAL_NOTIFY.get_or_init(tokio::sync::Notify::new);
    let sessions_dir = paths::omp_sessions_dir();
    let status_dir = paths::status_dir();
    let own_pid = std::process::id();

    // Idle backoff reaches 60s; watcher notifications wake this loop early but
    // obey a strict MIN_COOLDOWN floor so rapid transcript/status writes never
    // trigger back-to-back lsof/ps storms.
    const MIN_COOLDOWN: Duration = Duration::from_secs(4);
    const MIN_DELAY: Duration = Duration::from_secs(5);
    const MAX_DELAY: Duration = Duration::from_secs(60);
    const STEP: Duration = Duration::from_secs(10);

    let mut current_delay = MIN_DELAY;

    loop {
        EXTERNAL_DIRTY.store(false, Ordering::Release);
        let owned_pids: std::collections::HashSet<u32> = crate::rpc::registry()
            .read()
            .values()
            .map(|handle| handle.pid)
            .collect();
        let s_dir = sessions_dir.clone();
        let st_dir = status_dir.clone();
        let new_ext = tokio::task::spawn_blocking(move || {
            let holders = external::lsof_holders(&s_dir);
            let status_files = external::read_status_files(&st_dir);
            let status_alive = external::status_validator(external::process_birth);
            let external_status: Vec<_> = status_files
                .into_iter()
                .filter(|status| !owned_pids.contains(&status.pid))
                .collect();
            external::external_map(holders, &external_status, &status_alive, own_pid)
        })
        .await
        .unwrap_or_default();

        // Terminal squeezes GUI offline: an external holder on a file we also
        // hold via an app-owned RPC child means a single-writer conflict; step
        // down to read-only observation.
        let conflicting: Vec<_> = crate::rpc::registry()
            .read()
            .values()
            .filter(|h| {
                let file = h.session_file.read();
                !file.is_empty()
                    && new_ext
                        .get(file.as_str())
                        .is_some_and(|&pid| pid != h.pid && pid != own_pid)
            })
            .cloned()
            .collect();
        for handle in conflicting {
            let session_id = handle.session_id.read().clone();
            warn!("external holder detected for {session_id}; stopping app-owned RPC");
            let _ = crate::rpc::stop_external_conflict(&handle).await;
            crate::rpc::set_suspended(&state, &session_id, true);
        }

        // Forks and side chats write independent files. A parent link is not
        // evidence of a second writer and must never stop the parent's RPC.
        let changed = {
            let mut c = cat().lock();
            if c.external != new_ext {
                c.external = new_ext.clone();
                true
            } else {
                false
            }
        };

        if changed {
            super::recompute_async(&state, None).await;
        }

        let last_sweep = Instant::now();

        // Adaptive backoff:
        // If external sessions exist or state changed, stay at 5s to promptly detect exit/takeover.
        // If idle (no external sessions and no change), progressively back off to 60s.
        if !new_ext.is_empty() || changed {
            current_delay = MIN_DELAY;
        } else {
            current_delay = (current_delay + STEP).min(MAX_DELAY);
        }

        let next_periodic = tokio::time::Instant::now() + current_delay;
        loop {
            if EXTERNAL_DIRTY.load(Ordering::Acquire) {
                current_delay = MIN_DELAY;
                let rem = cooldown_remaining(last_sweep, Instant::now(), MIN_COOLDOWN);
                if !rem.is_zero() {
                    tokio::time::sleep(rem).await;
                }
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep_until(next_periodic) => {
                    break;
                }
                _ = notify.notified() => {
                    // Re-check EXTERNAL_DIRTY so stale permits already covered
                    // by the completed sweep do not trigger a redundant run.
                }
            }
        }
    }
}

async fn run_bus_loop(state: AppState, mut bus: tokio::sync::broadcast::Receiver<AppEvent>) {
    loop {
        let ev = match bus.recv().await {
            Ok(e) => e,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                warn!("catalog bus lagged by {n} events");
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        };

        let (session_id, live_ev, refresh_file) = match ev {
            AppEvent::RpcFrame { session_id, frame } => {
                // status::apply only inspects lifecycle/dialog frames; skip
                // high-frequency streaming deltas before locking the catalog.
                let kind = frame.get("type").and_then(serde_json::Value::as_str);
                if !matches!(
                    kind,
                    Some("agent_start" | "message_end" | "extension_ui_request" | "agent_end")
                ) {
                    continue;
                }
                let refresh_file = matches!(kind, Some("message_end" | "agent_end"));
                (
                    session_id,
                    LiveEvent::Frame(frame.as_ref().clone()),
                    refresh_file,
                )
            }
            AppEvent::RpcProcess {
                session_id,
                running,
                exit_code,
            } => (session_id, LiveEvent::Process { running, exit_code }, false),
            AppEvent::UiResponded {
                session_id,
                request_id,
            } => (session_id, LiveEvent::UiResponded { request_id }, false),
            AppEvent::PromptSent { session_id } => (session_id, LiveEvent::PromptSent, true),
            AppEvent::SessionAccepted { session_id } => (session_id, LiveEvent::Accepted, false),
            _ => continue,
        };

        let change = {
            let mut c = cat().lock();
            // Deleted session: a process-exit event may land after purge; never
            // resurrect its runtime or persist a new session_meta row.
            if c.deleted.contains(&session_id) {
                continue;
            }
            let cur_pending = c.metas.get(&session_id).and_then(|m| m.pending);
            let rt = c.runtime.entry(session_id.clone()).or_default();
            let mut change = status::apply(rt, cur_pending, &live_ev);
            // A settle (the only event that marks unread) consumes the quiet flag.
            if change.unread.is_some() && c.quiet.remove(&session_id) {
                status::silence_settle(&mut change);
            }
            change
        };

        if change.pending.is_some() || change.unread.is_some() {
            let st = state.clone();
            let sid = session_id.clone();
            let new_pending = change.pending;
            let new_unread = change.unread;
            let _ = tokio::task::spawn_blocking(move || {
                let db = st.db.lock();
                if let Some(new_p) = new_pending {
                    if let Err(e) = store::set_pending(&db, &sid, new_p) {
                        warn!("bus set_pending {sid}: {e}");
                    }
                }
                if let Some(u) = new_unread {
                    if let Err(e) = store::set_unread(&db, &sid, u) {
                        warn!("bus set_unread {sid}: {e}");
                    }
                }
            })
            .await;
        }
        if change.pending.is_some() || change.unread.is_some() || change.runtime {
            if refresh_file {
                let path = {
                    let c = cat().lock();
                    c.by_id.get(&session_id).map(|s| s.path.clone())
                }
                .or_else(|| {
                    crate::rpc::get_handle(&session_id).and_then(|h| {
                        let p = h.session_file.read().clone();
                        (!p.is_empty()).then(|| std::path::PathBuf::from(p))
                    })
                });
                if let Some(p) = path {
                    super::refresh_paths(&state, vec![p]).await;
                }
            }
            super::recompute_async(&state, Some(vec![session_id])).await;
        }
    }
}

#[cfg(test)]
mod watch_tests {
    use super::classify_events;
    use std::path::PathBuf;

    #[test]
    fn classify_routes_session_subagent_and_status_events() {
        let dir = PathBuf::from("/s");
        let status_dir = PathBuf::from("/status");
        let session = PathBuf::from("/s/b/one.jsonl");
        let subagent = PathBuf::from("/s/b/one/sub.jsonl");
        let status = PathBuf::from("/status/x.json");
        let other = PathBuf::from("/s/b/readme.txt");

        let b = classify_events(&dir, &status_dir, [&session, &subagent, &other].into_iter());
        assert!(!b.full);
        assert!(!b.status_changed);
        assert_eq!(b.sessions.len(), 1);
        assert!(b.sessions.contains(&session));

        let sb = classify_events(&dir, &status_dir, [&status].into_iter());
        assert!(!sb.full);
        assert!(sb.status_changed);
        assert!(sb.sessions.is_empty());
        assert!(!sb.is_empty());

        assert!(classify_events(&dir, &status_dir, [&other, &subagent].into_iter()).is_empty());
        // Outside the sessions/status dirs (e.g. a symlinked root or stray json): rescan everything.
        let elsewhere = PathBuf::from("/private/s/b/one.jsonl");
        let stray_json = PathBuf::from("/other/x.json");
        assert!(classify_events(&dir, &status_dir, [&elsewhere].into_iter()).full);
        assert!(classify_events(&dir, &status_dir, [&stray_json].into_iter()).full);
    }

    #[test]
    fn external_cooldown_remaining_clamps_to_zero() {
        use super::cooldown_remaining;
        use std::time::{Duration, Instant};

        let min = Duration::from_secs(4);
        let t0 = Instant::now();
        assert_eq!(cooldown_remaining(t0, t0, min), min);
        assert_eq!(
            cooldown_remaining(t0, t0 + Duration::from_secs(1), min),
            Duration::from_secs(3)
        );
        assert_eq!(
            cooldown_remaining(t0, t0 + Duration::from_secs(4), min),
            Duration::ZERO
        );
        assert_eq!(
            cooldown_remaining(t0, t0 + Duration::from_secs(10), min),
            Duration::ZERO
        );
    }
}

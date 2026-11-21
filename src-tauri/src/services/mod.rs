//! [C] Local port/process listing, stop, reminders.
//! Cross-module API per docs/ARCHITECTURE.md §9.

pub mod clipboard;
pub mod commands;
pub mod files;
pub mod perf;
pub mod permissions;
pub mod scan;
pub mod trash;

use std::future::Future;
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::Emitter;

use crate::contracts::ServiceInfo;
use crate::state::{AppEvent, AppState};

const BASE_POLL: Duration = Duration::from_secs(10);
const MAX_POLL: Duration = Duration::from_secs(60);
const STEP_POLL: Duration = Duration::from_secs(10);
const UI_ACTIVE_WINDOW: Duration = Duration::from_secs(60);

static SERVICES_NOTIFY: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

pub fn notify_services_check() {
    SERVICES_NOTIFY.notify_one();
}
/// Reuse a scan this fresh instead of re-running lsof.
const CACHE_TTL: Duration = Duration::from_secs(2);

static STATE: OnceLock<AppState> = OnceLock::new();

struct CachedScan {
    dev: Vec<ServiceInfo>,
    all: Vec<ServiceInfo>,
}

type ScanCache = Mutex<Option<(Instant, Arc<CachedScan>)>>;

static CACHE: LazyLock<ScanCache> = LazyLock::new(Default::default);
static SCAN_FLIGHT: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));
static ACTIVE_UNTIL: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(Default::default);
fn is_active_until(until: Option<Instant>, now: Instant) -> bool {
    until.is_some_and(|u| now < u)
}

/// Arm the active subscriber window; returns whether it was already active.
fn mark_ui_active(now: Instant) -> bool {
    let mut slot = ACTIVE_UNTIL.lock();
    let was_active = is_active_until(*slot, now);
    *slot = Some(now + UI_ACTIVE_WINDOW);
    was_active
}

fn is_ui_active(now: Instant) -> bool {
    is_active_until(*ACTIVE_UNTIL.lock(), now)
}
fn next_poll_delay(current: Duration, changed: bool, ui_active: bool) -> Duration {
    if changed || ui_active {
        BASE_POLL
    } else {
        (current + STEP_POLL).min(MAX_POLL)
    }
}

/// Single-flight TTL cache: concurrent cold callers share one `fetch()` and
/// subsequent callers within `ttl` reuse the cached value without spawning lsof.
async fn single_flight_cached<T, F, Fut>(
    cache: &Mutex<Option<(Instant, Arc<T>)>>,
    flight: &tokio::sync::Mutex<()>,
    ttl: Duration,
    force_refresh: bool,
    fetch: F,
) -> Arc<T>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    if !force_refresh {
        if let Some((at, entry)) = cache.lock().as_ref() {
            if at.elapsed() < ttl {
                return entry.clone();
            }
        }
    }
    let _guard = flight.lock().await;
    if !force_refresh {
        if let Some((at, entry)) = cache.lock().as_ref() {
            if at.elapsed() < ttl {
                return entry.clone();
            }
        }
    }
    let value = Arc::new(fetch().await);
    *cache.lock() = Some((Instant::now(), value.clone()));
    value
}

/// Poll listening ports while an active UI/subscriber window is open, sharing
/// the 2-second single-flight cache with on-demand `list` calls. When no
/// subscriber is active (including at startup before the services panel opens),
/// this loop parks without running `lsof`/`ps`. Emits `services:changed` on diff.
pub fn init(state: AppState) {
    let _ = STATE.set(state.clone());
    tauri::async_runtime::spawn(async move {
        // ServiceInfo has no PartialEq; compare serialized snapshots.
        let mut last: Option<String> = None;
        let mut delay = BASE_POLL;
        loop {
            if !is_ui_active(Instant::now()) {
                SERVICES_NOTIFY.notified().await;
                delay = BASE_POLL;
                continue;
            }
            let scan = scan_cached(false).await;
            let key = serde_json::to_string(&scan.dev).unwrap_or_default();
            let changed = last.as_deref() != Some(key.as_str());
            if changed {
                let _ = state.app.emit("services:changed", &scan.dev);
                state.emit(AppEvent::ServicesChanged);
                last = Some(key);
            }
            let active = is_ui_active(Instant::now());
            if !active {
                delay = BASE_POLL;
                continue;
            }
            delay = next_poll_delay(delay, changed, active);

            tokio::select! {
                _ = tokio::time::sleep(delay) => {},
                _ = SERVICES_NOTIFY.notified() => {
                    delay = BASE_POLL;
                }
            }
        }
    });
}

async fn session_cwds() -> Vec<(String, String)> {
    match STATE.get() {
        Some(state) => crate::catalog::id_cwds(state).await,
        None => Vec::new(),
    }
}

async fn run_scan() -> CachedScan {
    let sessions = session_cwds().await;
    let (dev, all) = tokio::task::spawn_blocking(move || {
        let pgids = crate::git::tm::app_pgids();
        scan::to_services_split(scan::scan(), &sessions, &pgids)
    })
    .await
    .unwrap_or_default();
    CachedScan { dev, all }
}

async fn scan_cached(force_refresh: bool) -> Arc<CachedScan> {
    single_flight_cached(&CACHE, &SCAN_FLIGHT, CACHE_TTL, force_refresh, run_scan).await
}

/// Listening services; `all=false` keeps only dev-like processes.
pub async fn list(all: bool) -> Vec<ServiceInfo> {
    let was_active = mark_ui_active(Instant::now());
    let scan = scan_cached(false).await;
    if !was_active {
        notify_services_check();
    }
    if all {
        scan.all.clone()
    } else {
        scan.dev.clone()
    }
}

/// Stop a listening process: SIGTERM, wait ≤3 s, then SIGKILL.
/// Only pids currently listening on a TCP port may be stopped. When the
/// listener belongs to a time-machine run the whole process group is killed
/// so the hosting shell and sibling children do not linger.
pub async fn stop(pid: u32) -> Result<(), String> {
    if pid <= 1 || pid == std::process::id() || pid == parent_pid() {
        return Err("拒绝停止该进程".into());
    }
    if !scan_cached(true).await.all.iter().any(|s| s.pid == pid) {
        return Err("该进程不在监听端口列表中".into());
    }
    tokio::task::spawn_blocking(move || {
        let pgid = unsafe { libc::getpgid(pid as i32) };
        if pgid > 1 && crate::git::tm::app_pgids().contains(&pgid) {
            crate::git::tm::kill_group(pgid);
            Ok(())
        } else {
            kill_pid(pid)
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    *CACHE.lock() = None;
    if let Some(state) = STATE.get() {
        let scan = scan_cached(true).await;
        let _ = state.app.emit("services:changed", &scan.dev);
        state.emit(AppEvent::ServicesChanged);
        notify_services_check();
    }
    Ok(())
}

fn parent_pid() -> u32 {
    // SAFETY: getppid has no failure mode.
    unsafe { libc::getppid() as u32 }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only probes for existence.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn kill_pid(pid: u32) -> Result<(), String> {
    let pid = pid as i32;
    // SAFETY: signal delivery to a user-selected listening process.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return Err(format!("停止失败：{}", std::io::Error::last_os_error()));
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if alive(pid) {
        // SAFETY: as above.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_poll_delay_handles_active_ui_changes_and_idle_backoff() {
        assert_eq!(next_poll_delay(MAX_POLL, false, true), BASE_POLL);
        assert_eq!(
            next_poll_delay(Duration::from_secs(30), false, true),
            BASE_POLL
        );

        assert_eq!(next_poll_delay(MAX_POLL, true, false), BASE_POLL);
        assert_eq!(
            next_poll_delay(Duration::from_secs(40), true, false),
            BASE_POLL
        );

        let mut d = BASE_POLL;
        for expected in [20, 30, 40, 50, 60, 60] {
            d = next_poll_delay(d, false, false);
            assert_eq!(d, Duration::from_secs(expected));
        }
    }

    #[tokio::test]
    async fn single_flight_coalesces_concurrent_cold_scans_and_reuses_cache() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        type TestCache = Arc<Mutex<Option<(Instant, Arc<usize>)>>>;
        let cache: TestCache = Arc::new(Mutex::new(None));
        let flight = Arc::new(tokio::sync::Mutex::new(()));
        let calls = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(tokio::sync::Barrier::new(8));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let cache = cache.clone();
            let flight = flight.clone();
            let calls = calls.clone();
            let barrier = barrier.clone();
            handles.push(tokio::spawn(async move {
                barrier.wait().await;
                *single_flight_cached(&cache, &flight, CACHE_TTL, false, || {
                    let calls = calls.clone();
                    async move {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        calls.fetch_add(1, Ordering::SeqCst) + 1
                    }
                })
                .await
            }));
        }
        let results: Vec<usize> = futures_util::future::join_all(handles)
            .await
            .into_iter()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(results.iter().all(|&v| v == 1));

        // Within TTL, background or UI callers share the cached scan without re-running fetch.
        let cached = *single_flight_cached(&cache, &flight, CACHE_TTL, false, || {
            let calls = calls.clone();
            async move { calls.fetch_add(1, Ordering::SeqCst) + 1 }
        })
        .await;
        assert_eq!(cached, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Force-refresh bypasses the cache and updates it for subsequent callers.
        let forced = *single_flight_cached(&cache, &flight, CACHE_TTL, true, || {
            let calls = calls.clone();
            async move { calls.fetch_add(1, Ordering::SeqCst) + 1 }
        })
        .await;
        assert_eq!(forced, 2);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn inactive_subscriber_window_gates_background_polling() {
        let t0 = Instant::now();
        assert!(!is_active_until(None, t0));
        let until = Some(t0 + UI_ACTIVE_WINDOW);
        assert!(is_active_until(until, t0));
        assert!(is_active_until(
            until,
            t0 + UI_ACTIVE_WINDOW - Duration::from_secs(1)
        ));
        assert!(!is_active_until(until, t0 + UI_ACTIVE_WINDOW));
    }
}

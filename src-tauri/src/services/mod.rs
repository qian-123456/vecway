//! [C] Local port/process listing, stop, reminders.
//! Cross-module API per docs/ARCHITECTURE.md §9.

pub mod clipboard;
pub mod commands;
pub mod files;
pub mod permissions;
pub mod perf;
pub mod scan;
pub mod trash;

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::Emitter;

use crate::contracts::ServiceInfo;
use crate::state::{AppEvent, AppState};

const BASE_POLL: Duration = Duration::from_secs(10);
const MAX_POLL: Duration = Duration::from_secs(60);
const STEP_POLL: Duration = Duration::from_secs(10);
const UI_ACTIVE_WINDOW: Duration = Duration::from_secs(60);

static SERVICES_NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();

pub fn notify_services_check() {
    if let Some(notify) = SERVICES_NOTIFY.get() {
        notify.notify_one();
    }
}
/// Reuse a scan this fresh instead of re-running lsof.
const CACHE_TTL: Duration = Duration::from_secs(2);

static STATE: OnceLock<AppState> = OnceLock::new();

type ScanCache = Mutex<Option<(Instant, bool, Vec<ServiceInfo>)>>;

fn cache() -> &'static ScanCache {
    static C: OnceLock<ScanCache> = OnceLock::new();
    C.get_or_init(Default::default)
}

static ACTIVE_UNTIL: std::sync::LazyLock<Mutex<Option<Instant>>> =
    std::sync::LazyLock::new(Default::default);

fn mark_ui_active(now: Instant) {
    *ACTIVE_UNTIL.lock() = Some(now + UI_ACTIVE_WINDOW);
}

fn is_ui_active(now: Instant) -> bool {
    ACTIVE_UNTIL.lock().is_some_and(|until| now < until)
}

fn next_poll_delay(current: Duration, changed: bool, ui_active: bool) -> Duration {
    if changed || ui_active {
        BASE_POLL
    } else {
        (current + STEP_POLL).min(MAX_POLL)
    }
}

/// Poll listening ports with adaptive backoff: 10s when snapshots change or
/// the UI recently polled `list`, backing off up to 60s when unchanged.
/// Emits `services:changed` on diff.
pub fn init(state: AppState) {
    let _ = STATE.set(state.clone());
    let notify = SERVICES_NOTIFY.get_or_init(tokio::sync::Notify::new);
    tauri::async_runtime::spawn(async move {
        // ServiceInfo has no PartialEq; compare serialized snapshots.
        let mut last: Option<String> = None;
        let mut delay = BASE_POLL;
        loop {
            let now = fresh_list(false).await;
            let key = serde_json::to_string(&now).unwrap_or_default();
            let changed = last.as_deref() != Some(key.as_str());
            if changed {
                let _ = state.app.emit("services:changed", &now);
                state.emit(AppEvent::ServicesChanged);
                last = Some(key);
            }
            delay = next_poll_delay(delay, changed, is_ui_active(Instant::now()));

            tokio::select! {
                _ = tokio::time::sleep(delay) => {},
                _ = notify.notified() => {
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

async fn fresh_list(all: bool) -> Vec<ServiceInfo> {
    let sessions = session_cwds().await;
    let rows = tokio::task::spawn_blocking(move || {
        let pgids = crate::git::tm::app_pgids();
        scan::to_services(scan::scan(), all, &sessions, &pgids)
    })
    .await
    .unwrap_or_default();
    *cache().lock() = Some((Instant::now(), all, rows.clone()));
    rows
}

/// Listening services; `all=false` keeps only dev-like processes.
pub async fn list(all: bool) -> Vec<ServiceInfo> {
    mark_ui_active(Instant::now());
    if let Some((at, cached_all, rows)) = cache().lock().as_ref() {
        if at.elapsed() < CACHE_TTL && *cached_all == all {
            return rows.clone();
        }
    }
    fresh_list(all).await
}

/// Stop a listening process: SIGTERM, wait ≤3 s, then SIGKILL.
/// Only pids currently listening on a TCP port may be stopped. When the
/// listener belongs to a time-machine run the whole process group is killed
/// so the hosting shell and sibling children do not linger.
pub async fn stop(pid: u32) -> Result<(), String> {
    if pid <= 1 || pid == std::process::id() || pid == parent_pid() {
        return Err("拒绝停止该进程".into());
    }
    if !fresh_list(true).await.iter().any(|s| s.pid == pid) {
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
    *cache().lock() = None;
    if let Some(state) = STATE.get() {
        let rows = fresh_list(false).await;
        let _ = state.app.emit("services:changed", &rows);
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
}

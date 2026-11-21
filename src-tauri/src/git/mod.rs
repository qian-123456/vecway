//! [C] Git status/log/diff/worktrees/time machine.
//! Cross-module API per docs/ARCHITECTURE.md §9.

pub mod base_sync;
pub mod checkpoints_ext;
pub mod cmd;
pub mod commands;
pub mod history;
pub mod status;
pub mod tm;
pub mod turns;
pub mod worktree;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

use crate::contracts::GitBadge;
use crate::state::AppState;

const BADGE_TTL: Duration = Duration::from_secs(5);
const ROOT_TTL: Duration = Duration::from_secs(30);

type Cache<T> = Mutex<HashMap<PathBuf, (Instant, T)>>;

static BADGE_CACHE: LazyLock<Cache<Option<GitBadge>>> = LazyLock::new(Default::default);

#[derive(Default)]
struct RepoInfoCacheState {
    entries: HashMap<PathBuf, (Instant, Option<worktree::RepoInfo>)>,
    in_flight: HashSet<PathBuf>,
}

static REPO_INFO_CACHE: LazyLock<(Mutex<RepoInfoCacheState>, Condvar)> =
    LazyLock::new(|| (Mutex::new(RepoInfoCacheState::default()), Condvar::new()));

struct InFlightGuard<'a> {
    key: PathBuf,
    state: &'a (Mutex<RepoInfoCacheState>, Condvar),
    armed: bool,
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let mut guard = self.state.0.lock();
            guard.in_flight.remove(&self.key);
            self.state.1.notify_all();
        }
    }
}

/// Cached (≤30s) single-flight `worktree::probe_repo_info` shared across
/// `badge()`, `repo_root()`, `status::summary()`, and `git_repo_root` so cold
/// callers for the same `cwd` run `git rev-parse` once instead of twice.
pub(crate) fn repo_info_cached_result(cwd: &Path) -> Result<Option<worktree::RepoInfo>, String> {
    let state = &*REPO_INFO_CACHE;
    {
        let mut guard = state.0.lock();
        loop {
            if let Some((at, v)) = guard.entries.get(cwd) {
                if at.elapsed() < ROOT_TTL {
                    return Ok(v.clone());
                }
            }
            if guard.in_flight.contains(cwd) {
                state.1.wait(&mut guard);
                continue;
            }
            guard.in_flight.insert(cwd.to_path_buf());
            break;
        }
    }

    let mut release = InFlightGuard {
        key: cwd.to_path_buf(),
        state,
        armed: true,
    };
    let result = worktree::probe_repo_info(cwd);
    {
        let mut guard = state.0.lock();
        if let Ok(value) = &result {
            if guard.entries.len() > 2048 {
                guard.entries.retain(|_, (at, _)| at.elapsed() < ROOT_TTL);
            }
            guard
                .entries
                .insert(cwd.to_path_buf(), (Instant::now(), value.clone()));
        }
        guard.in_flight.remove(cwd);
        release.armed = false;
        state.1.notify_all();
    }
    result
}

pub(crate) fn repo_info_cached(cwd: &Path) -> Option<worktree::RepoInfo> {
    repo_info_cached_result(cwd).ok().flatten()
}

/// Invalidate cached repo/badge metadata for `cwd` after repo/worktree mutations.
pub(crate) fn invalidate_cache(cwd: &Path) {
    let canon = worktree::canon(cwd);
    {
        let mut badges = BADGE_CACHE.lock();
        badges.remove(cwd);
        badges.remove(&canon);
    }
    {
        let mut info = REPO_INFO_CACHE.0.lock();
        info.entries.remove(cwd);
        info.entries.remove(&canon);
    }
}

fn cached<T: Clone>(cache: &Cache<T>, key: &Path, ttl: Duration, compute: impl FnOnce() -> T) -> T {
    if let Some((at, v)) = cache.lock().get(key) {
        if at.elapsed() < ttl {
            return v.clone();
        }
    }
    let v = compute();
    let mut map = cache.lock();
    if map.len() > 2048 {
        map.retain(|_, (at, _)| at.elapsed() < ttl);
    }
    map.insert(key.to_path_buf(), (Instant::now(), v.clone()));
    v
}

/// Background setup for module C: install the bundled turn-checkpoints
/// extension into `checkpoints_extension_path()` (app sessions load it via
/// `omp -e` when `turn_checkpoints` is enabled in settings).
pub fn init(_state: AppState) {
    checkpoints_ext::install();
}

fn compute_badge(cwd: &Path) -> Option<GitBadge> {
    let info = repo_info_cached(cwd)?;
    let st = status::status(cwd, false)?;
    let worktree = info
        .is_linked_worktree()
        .then(|| {
            info.toplevel
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        })
        .flatten();
    Some(GitBadge {
        branch: st.branch,
        dirty: st.entries.len() as u32,
        worktree,
    })
}

/// Fast (cached ≤5s) git badge for a directory.
pub fn badge(cwd: &Path) -> Option<GitBadge> {
    cached(&BADGE_CACHE, cwd, BADGE_TTL, || compute_badge(cwd))
}

/// Main repo root, resolves worktrees via git-common-dir.
pub fn repo_root(cwd: &Path) -> Option<String> {
    repo_info_cached(cwd).map(|i| i.main_root().to_string_lossy().into_owned())
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn badge_warms_repo_info_cache_for_repo_root() {
        let dir = std::env::temp_dir().join(format!("vecway-git-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        cmd::git_ok(&dir, &["init", "-q", "-b", "main"]).unwrap();
        invalidate_cache(&dir);

        assert!(!REPO_INFO_CACHE.0.lock().entries.contains_key(&dir));
        let b = badge(&dir).unwrap();
        assert_eq!(b.branch.as_deref(), Some("main"));
        // `badge()` already populated the shared `REPO_INFO_CACHE`, so `repo_root()`
        // reuses it without spawning another `git rev-parse`.
        assert!(REPO_INFO_CACHE.0.lock().entries.contains_key(&dir));
        let expected_root = worktree::canon(&dir).to_string_lossy().into_owned();
        assert_eq!(repo_root(&dir).as_deref(), Some(expected_root.as_str()));

        invalidate_cache(&dir);
        assert!(!REPO_INFO_CACHE.0.lock().entries.contains_key(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

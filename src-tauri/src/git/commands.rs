//! [C] Tauri commands: git + time machine (docs/ARCHITECTURE.md §7).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use tauri::Emitter;

use super::{badge, base_sync, checkpoints_ext, history, status, tm, turns, worktree};
use crate::contracts::{
    BaseSyncResult, BranchInfo, GitBadge, GitHistory, GitSummary, MergePreview, PrUrlInfo, TmRun,
    TurnCheckpoint, TurnUndoResult, WorktreeInfo,
};
use crate::state::AppState;

/// Run blocking git work off the async runtime.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

/// `(session_id, cwd)` pairs from the catalog (empty while A is a stub).
async fn session_cwds(state: &AppState) -> Vec<(String, String)> {
    crate::catalog::id_cwds(state).await
}

/// Must be read while the mutation gate prevents app/terminal startup and cwd
/// reassignment. Explicit cleanup permits known idle associations; orphan
/// reclamation must refuse every current association, not just live ones.
async fn removal_session_cwds(state: &AppState, orphan_only: bool) -> Vec<(String, String)> {
    let mut sessions: Vec<_> = crate::catalog::list(state)
        .await
        .into_iter()
        .filter(|meta| {
            orphan_only
                || meta.live
                || meta.external_pid.is_some()
                || crate::terminal::commands::omp_terminal_open(&meta.id)
        })
        .map(|meta| (meta.id, meta.cwd))
        .collect();
    sessions.extend(
        crate::rpc::registry()
            .read()
            .values()
            .filter(|handle| handle.alive.load(std::sync::atomic::Ordering::SeqCst))
            .map(|handle| (handle.session_id.read().clone(), handle.cwd.clone())),
    );
    sessions.extend(crate::mobile::api::draft::active_cwds().await);
    sessions.extend(crate::rpc::in_flight_startup_cwds());
    sessions.extend(active_terminal_cwds());
    sessions
}

static ACTIVE_TERMINAL_CWDS: LazyLock<std::sync::Mutex<std::collections::HashMap<u64, String>>> =
    LazyLock::new(Default::default);
static TERMINAL_OWNERSHIP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// RAII guard keeping an in-flight or active terminal's cwd registered in
/// `ACTIVE_TERMINAL_CWDS` until PTY spawn fails, the child exits, or the terminal closes.
pub(crate) struct TerminalOwnershipGuard {
    id: u64,
}

impl Drop for TerminalOwnershipGuard {
    fn drop(&mut self) {
        ACTIVE_TERMINAL_CWDS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

/// Atomically verify `cwd` is not inside a reserved worktree and register an
/// active terminal ownership guard for it. Callers MUST hold `catalog::session_mutation_lock()`.
pub(crate) fn try_register_terminal_ownership(cwd: &str) -> Result<TerminalOwnershipGuard, String> {
    if is_worktree_reserved(cwd) {
        return Err("该工作树正在合并或清理，请稍后再试".to_string());
    }
    let id = TERMINAL_OWNERSHIP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let key = norm_worktree_key(cwd);
    ACTIVE_TERMINAL_CWDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, key);
    Ok(TerminalOwnershipGuard { id })
}

pub(crate) fn active_terminal_cwds() -> Vec<(String, String)> {
    ACTIVE_TERMINAL_CWDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(id, cwd)| (format!("terminal:{id}"), cwd.clone()))
        .collect()
}

fn has_active_terminal_inside(target: &Path) -> bool {
    ACTIVE_TERMINAL_CWDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .any(|cwd| Path::new(cwd).starts_with(target))
}

pub(crate) static RESERVED_WORKTREES: LazyLock<std::sync::Mutex<HashSet<String>>> =
    LazyLock::new(Default::default);

fn canonical_or_ancestor(path: &Path) -> PathBuf {
    if let Ok(canon) = std::fs::canonicalize(path) {
        return canon;
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path;
    while let Some(parent) = cur.parent() {
        if let Some(name) = cur.file_name() {
            missing.push(name.to_os_string());
        }
        if let Ok(mut canon) = std::fs::canonicalize(parent) {
            for part in missing.into_iter().rev() {
                canon.push(part);
            }
            return canon;
        }
        cur = parent;
    }
    path.to_path_buf()
}

fn norm_worktree_key(path: &str) -> String {
    let canon = canonical_or_ancestor(Path::new(path));
    let raw = canon.to_string_lossy();
    let trimmed = if raw.len() > 1 {
        raw.trim_end_matches('/')
    } else {
        raw.as_ref()
    };
    match trimmed.strip_prefix("/private/") {
        Some(rest) => format!("/{rest}"),
        None => trimmed.to_string(),
    }
}

/// True if `path` equals or lies inside a worktree currently reserved for merge/cleanup.
pub(crate) fn is_worktree_reserved(path: &str) -> bool {
    let key = norm_worktree_key(path);
    let candidate = Path::new(&key);
    let guard = RESERVED_WORKTREES.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .iter()
        .any(|reserved| candidate.starts_with(Path::new(reserved)))
}

/// RAII reservation guard holding a worktree path in `RESERVED_WORKTREES` until
/// commit/merge/removal completes or errors out.
pub(crate) struct WorktreeReservationGuard {
    key: String,
}

impl WorktreeReservationGuard {
    pub(crate) fn matches(&self, path: &str) -> bool {
        self.key == norm_worktree_key(path)
    }
}

impl Drop for WorktreeReservationGuard {
    fn drop(&mut self) {
        RESERVED_WORKTREES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

/// Atomically reserve `path` when neither it nor any ancestor/descendant is already reserved.
/// Callers that coordinate with session startup MUST hold `catalog::session_mutation_lock()`.
pub(crate) fn try_reserve_worktree(path: &str) -> Result<WorktreeReservationGuard, String> {
    let key = norm_worktree_key(path);
    let candidate = Path::new(&key);
    if has_active_terminal_inside(candidate) {
        return Err("工作树仍被终端使用，已拒绝操作".to_string());
    }
    let mut guard = RESERVED_WORKTREES.lock().unwrap_or_else(|e| e.into_inner());
    if guard.iter().any(|existing| {
        let ex = Path::new(existing);
        candidate.starts_with(ex) || ex.starts_with(candidate)
    }) {
        return Err("该工作树正在合并或清理，请稍后再试".to_string());
    }
    guard.insert(key.clone());
    Ok(WorktreeReservationGuard { key })
}

/// Paths of registered project workspaces.
fn workspace_paths(state: &AppState) -> Vec<String> {
    let db = state.db.lock();
    let Ok(mut stmt) = db.prepare("SELECT path FROM workspaces WHERE kind = 'project'") else {
        return Vec::new();
    };
    stmt.query_map([], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn git_summary(
    _state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<GitSummary, String> {
    blocking(move || Ok(status::summary(&PathBuf::from(cwd)))).await
}

/// Sidebar badge for a directory (branch, dirty count, worktree name).
/// Fast: the underlying probe is cached for ~5s.
#[tauri::command]
pub async fn git_badge(
    _state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<Option<GitBadge>, String> {
    blocking(move || Ok(badge(&PathBuf::from(cwd)))).await
}

/// Main repo root for a directory (resolves linked worktrees).
pub(crate) async fn repo_root_for_cwd(cwd: String) -> Result<Option<String>, String> {
    blocking(move || {
        let path = crate::services::files::resolve(&cwd)?;
        if !path.is_dir() {
            return Err(format!("directory does not exist: {}", path.display()));
        }
        super::repo_info_cached_result(&path)
            .map(|opt| opt.map(|info| info.main_root().to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
pub async fn git_repo_root(
    _state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<Option<String>, String> {
    repo_root_for_cwd(cwd).await
}

#[tauri::command]
pub async fn git_log(
    _state: tauri::State<'_, AppState>,
    cwd: String,
    limit: u32,
) -> Result<GitHistory, String> {
    blocking(move || Ok(history::history(&PathBuf::from(cwd), limit))).await
}

pub(crate) async fn diff_for_cwd(
    cwd: String,
    path: Option<String>,
    sha: Option<String>,
) -> Result<String, String> {
    blocking(move || history::diff(&PathBuf::from(cwd), path.as_deref(), sha.as_deref())).await
}

#[tauri::command]
pub async fn git_diff(
    _state: tauri::State<'_, AppState>,
    cwd: String,
    path: Option<String>,
    sha: Option<String>,
) -> Result<String, String> {
    diff_for_cwd(cwd, path, sha).await
}

#[tauri::command]
pub async fn git_create_worktree(
    _state: tauri::State<'_, AppState>,
    repo: String,
    name: String,
    branch: Option<String>,
    base: Option<String>,
) -> Result<WorktreeInfo, String> {
    blocking(move || {
        worktree::create(
            &PathBuf::from(repo),
            &name,
            branch.as_deref(),
            base.as_deref(),
        )
    })
    .await
}

pub(crate) async fn list_worktrees_for_app(
    state: &AppState,
    repo: String,
) -> Result<Vec<WorktreeInfo>, String> {
    let root = blocking(move || {
        super::repo_info_cached_result(Path::new(&repo)).map(|info| info.map(|i| i.main_root()))
    })
    .await?;
    let Some(root) = root else {
        return Ok(Vec::new());
    };
    let sessions = session_cwds(state).await;
    blocking(move || worktree::list(&root, &sessions)).await
}

#[tauri::command]
pub async fn git_list_worktrees(
    state: tauri::State<'_, AppState>,
    repo: String,
) -> Result<Vec<WorktreeInfo>, String> {
    list_worktrees_for_app(&state, repo).await
}

async fn remove_worktree_inner(
    state: &AppState,
    repo: String,
    path: String,
    delete_branch: bool,
    force: bool,
    orphan_only: Option<bool>,
) -> Result<(), String> {
    // An orphan listing is only a preview: re-read ownership at mutation time.
    let sessions = removal_session_cwds(state, orphan_only.unwrap_or(false)).await;
    blocking(move || {
        worktree::remove_checked(
            &PathBuf::from(repo),
            &PathBuf::from(path),
            delete_branch,
            force,
            &sessions,
        )
    })
    .await
}

pub(crate) async fn remove_worktree_for_app(
    state: &AppState,
    repo: String,
    path: String,
    delete_branch: bool,
    force: bool,
    orphan_only: Option<bool>,
) -> Result<(), String> {
    let _mutation = crate::catalog::session_mutation_lock().lock().await;
    let _reservation = try_reserve_worktree(&path)?;
    remove_worktree_inner(state, repo, path, delete_branch, force, orphan_only).await
}

pub(crate) async fn remove_reserved_worktree_for_app(
    state: &AppState,
    reservation: &WorktreeReservationGuard,
    repo: String,
    path: String,
    delete_branch: bool,
    force: bool,
    orphan_only: Option<bool>,
) -> Result<(), String> {
    if !reservation.matches(&path) {
        return Err("工作树已变化，请刷新后再确认".to_string());
    }
    let _mutation = crate::catalog::session_mutation_lock().lock().await;
    remove_worktree_inner(state, repo, path, delete_branch, force, orphan_only).await
}

/// Check worktree occupancy and atomically reserve the worktree under `session_mutation_lock`
/// BEFORE any Git commit, merge, or removal write begins. The returned RAII guard must be
/// held across commit, merge, and worktree removal.
pub(crate) async fn reserve_worktree_for_app(
    st: &AppState,
    worktree_path: &str,
) -> Result<WorktreeReservationGuard, String> {
    let _mutation = crate::catalog::session_mutation_lock().lock().await;
    let sessions = removal_session_cwds(st, false).await;
    let target = PathBuf::from(worktree_path);
    blocking(move || worktree::ensure_unused(&target, &sessions, &tm::list())).await?;
    try_reserve_worktree(worktree_path)
}

#[tauri::command]
pub async fn git_remove_worktree(
    state: tauri::State<'_, AppState>,
    repo: String,
    path: String,
    delete_branch: bool,
    force: bool,
    orphan_only: Option<bool>,
) -> Result<(), String> {
    remove_worktree_for_app(&state, repo, path, delete_branch, force, orphan_only).await
}

#[tauri::command]
pub async fn git_scan_orphans(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<WorktreeInfo>, String> {
    let sessions = session_cwds(&state).await;
    // Without session data every worktree would look orphaned; report none.
    if sessions.is_empty() {
        return Ok(Vec::new());
    }
    let paths = workspace_paths(&state);
    blocking(move || Ok(worktree::orphans(&paths, &sessions))).await
}

/// `mode`: "soft" | "hard".
#[tauri::command]
pub async fn git_reset_to(
    _state: tauri::State<'_, AppState>,
    repo: String,
    sha: String,
    mode: String,
) -> Result<(), String> {
    blocking(move || history::reset_to(&PathBuf::from(repo), &sha, &mode)).await
}

#[tauri::command]
pub async fn tm_run(
    state: tauri::State<'_, AppState>,
    repo: String,
    sha: String,
    command: Option<String>,
) -> Result<TmRun, String> {
    let _mutation = crate::catalog::session_mutation_lock().lock().await;
    let app = state.app.clone();
    let sink: tm::LogSink = Arc::new(move |run_id: &str, line: &str| {
        let _ = app.emit(
            "tm:log",
            serde_json::json!({ "runId": run_id, "line": line }),
        );
    });
    blocking(move || tm::run(&PathBuf::from(repo), &sha, command.as_deref(), sink)).await
}

#[tauri::command]
pub async fn tm_list(_state: tauri::State<'_, AppState>) -> Result<Vec<TmRun>, String> {
    Ok(tm::list())
}

#[tauri::command]
pub async fn tm_stop(
    state: tauri::State<'_, AppState>,
    run_id: String,
    remove_worktree: bool,
) -> Result<(), String> {
    let _mutation = crate::catalog::session_mutation_lock().lock().await;
    if remove_worktree {
        let sessions = removal_session_cwds(&state, false).await;
        if let Some(run) = tm::list().into_iter().find(|run| run.id == run_id) {
            // Stopping this run is intentional, but never remove another
            // session's directory as a side effect of stopping it.
            worktree::ensure_unused(std::path::Path::new(&run.worktree), &sessions, &[])?;
        }
    }
    blocking(move || tm::stop(&run_id, remove_worktree)).await
}

pub fn restore_file(repo: &std::path::Path, path: &str) -> Result<(), String> {
    let status_out = super::cmd::git(repo, &["status", "--porcelain", "--", path])?;
    let text = status_out.text();
    if text.trim_start().starts_with("??") {
        super::cmd::git_ok(repo, &["clean", "-f", "-d", "--", path])?;
    } else {
        let res = super::cmd::git(repo, &["restore", "--staged", "--worktree", "--", path])?;
        if !res.ok() {
            super::cmd::git_ok(repo, &["restore", "--", path])?;
        }
    }
    Ok(())
}

pub fn list_branches(repo: &std::path::Path) -> Result<Vec<String>, String> {
    let out = super::cmd::git_ok(repo, &["branch", "-a", "--format=%(HEAD) %(refname:short)"])?;
    let mut current_branch: Option<String> = None;
    let mut other_branches: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let is_head = trimmed.starts_with('*');
        let raw_name = trimmed.trim_start_matches('*').trim();
        if raw_name.is_empty() || raw_name.contains("HEAD") {
            continue;
        }
        let clean_name = if let Some(stripped) = raw_name.strip_prefix("origin/") {
            stripped
        } else {
            raw_name
        };
        if clean_name.is_empty() {
            continue;
        }

        if is_head {
            current_branch = Some(clean_name.to_string());
            seen.insert(clean_name.to_string());
        } else if !seen.contains(clean_name) {
            seen.insert(clean_name.to_string());
            other_branches.push(clean_name.to_string());
        }
    }

    let mut result = Vec::new();
    if let Some(curr) = current_branch {
        result.push(curr);
    }
    result.extend(other_branches);
    Ok(result)
}

#[tauri::command]
pub async fn git_restore_file(
    _state: tauri::State<'_, AppState>,
    repo: String,
    path: String,
) -> Result<(), String> {
    blocking(move || restore_file(&PathBuf::from(repo), &path)).await
}

#[tauri::command]
pub async fn git_list_branches(
    _state: tauri::State<'_, AppState>,
    repo: String,
) -> Result<Vec<String>, String> {
    blocking(move || list_branches(&PathBuf::from(repo))).await
}

pub fn list_branches_detailed(repo: &std::path::Path) -> Result<Vec<BranchInfo>, String> {
    let mut worktree_branch_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let Ok(wt_out) = super::cmd::git_ok(repo, &["worktree", "list", "--porcelain"]) {
        let mut cur_path: Option<String> = None;
        for line in wt_out.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                cur_path = Some(p.trim().to_string());
            } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                if let Some(p) = &cur_path {
                    worktree_branch_map.insert(b.trim().to_string(), p.clone());
                }
            } else if line.trim().is_empty() {
                cur_path = None;
            }
        }
    }

    let merged_set: std::collections::HashSet<String> =
        super::cmd::git_ok(repo, &["branch", "--merged"])
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().trim_start_matches('*').trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

    let out = super::cmd::git_ok(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)|%(refname:short)|%(upstream:short)|%(upstream:track)|%(committerdate:relative)|%(subject)|%(objectname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;

    let mut result = Vec::new();
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.splitn(7, '|').collect();
        if parts.len() < 7 {
            continue;
        }
        let refname = parts[0];
        let shortname = parts[1];
        let upstream = parts[2];
        let track = parts[3];
        let date_rel = parts[4];
        let subject = parts[5];
        let short_sha = parts[6];

        if shortname.ends_with("/HEAD") || shortname == "HEAD" {
            continue;
        }

        let is_remote = refname.starts_with("refs/remotes/");
        let (name, display_name, remote, is_current_wt, wt_path) = if is_remote {
            let mut parts_remote = shortname.splitn(2, '/');
            let rem = parts_remote.next().unwrap_or("origin");
            let disp = parts_remote.next().unwrap_or(shortname);
            (
                shortname.to_string(),
                disp.to_string(),
                Some(rem.to_string()),
                false,
                None,
            )
        } else {
            let clean_name = shortname.to_string();
            let wt = worktree_branch_map.get(&clean_name).cloned();
            let is_cur = wt.is_some();
            (clean_name.clone(), clean_name, None, is_cur, wt)
        };

        let mut ahead = 0u32;
        let mut behind = 0u32;
        if track.contains("ahead") {
            if let Some(pos) = track.find("ahead ") {
                let rest = &track[pos + 6..];
                let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                ahead = num_str.parse().unwrap_or(0);
            }
        }
        if track.contains("behind") {
            if let Some(pos) = track.find("behind ") {
                let rest = &track[pos + 7..];
                let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                behind = num_str.parse().unwrap_or(0);
            }
        }

        let is_merged = !is_remote && merged_set.contains(&name);

        result.push(BranchInfo {
            name,
            display_name,
            is_remote,
            remote,
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
            is_current_worktree: is_current_wt,
            worktree_path: wt_path,
            last_commit_sha: if short_sha.is_empty() {
                None
            } else {
                Some(short_sha.to_string())
            },
            last_commit_message: if subject.is_empty() {
                None
            } else {
                Some(subject.to_string())
            },
            last_commit_time: if date_rel.is_empty() {
                None
            } else {
                Some(date_rel.to_string())
            },
            ahead,
            behind,
            is_merged,
        });
    }

    Ok(result)
}

#[tauri::command]
pub async fn git_list_branches_detailed(
    _state: tauri::State<'_, AppState>,
    repo: String,
) -> Result<Vec<BranchInfo>, String> {
    blocking(move || list_branches_detailed(&PathBuf::from(repo))).await
}

pub fn delete_branch(
    repo: &std::path::Path,
    branch: &str,
    is_remote: bool,
    force: bool,
) -> Result<(), String> {
    if is_remote {
        let (remote, branch_name) = if let Some((r, b)) = branch.split_once('/') {
            (r, b)
        } else {
            ("origin", branch)
        };
        super::cmd::git_ok(repo, &["push", remote, "--delete", branch_name])?;
    } else {
        if let Ok(wt_out) = super::cmd::git_ok(repo, &["worktree", "list", "--porcelain"]) {
            for line in wt_out.lines() {
                if let Some(b) = line.strip_prefix("branch refs/heads/") {
                    if b.trim() == branch {
                        return Err(format!(
                            "分支「{}」正在被工作树使用，请先清理该工作树后再删除",
                            branch
                        ));
                    }
                }
            }
        }
        let flag = if force { "-D" } else { "-d" };
        super::cmd::git_ok(repo, &["branch", flag, branch])?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_delete_branch(
    _state: tauri::State<'_, AppState>,
    repo: String,
    branch: String,
    is_remote: bool,
    force: bool,
) -> Result<(), String> {
    blocking(move || delete_branch(&PathBuf::from(repo), &branch, is_remote, force)).await
}

pub fn sync_branch(repo: &std::path::Path, branch: &str, action: &str) -> Result<String, String> {
    match action {
        "fetch" => super::cmd::git_ok(repo, &["fetch", "--all", "--prune"]),
        "pull" => super::cmd::git_ok(repo, &["pull"]),
        "push" => {
            let has_upstream = super::cmd::git(
                repo,
                &["rev-parse", "--abbrev-ref", &format!("{branch}@{{u}}")],
            )
            .map(|r| r.ok())
            .unwrap_or(false);
            if has_upstream {
                super::cmd::git_ok(repo, &["push"])
            } else {
                super::cmd::git_ok(repo, &["push", "-u", "origin", branch])
            }
        }
        _ => Err(format!("不支持的同步操作: {}", action)),
    }
}

#[tauri::command]
pub async fn git_sync_branch(
    _state: tauri::State<'_, AppState>,
    repo: String,
    branch: String,
    action: String,
) -> Result<String, String> {
    blocking(move || sync_branch(&PathBuf::from(repo), &branch, &action)).await
}

pub fn merge_preview(
    repo: &std::path::Path,
    target_branch: &str,
    source_branch: &str,
) -> Result<MergePreview, String> {
    let ahead_count = super::cmd::git_ok(
        repo,
        &[
            "rev-list",
            "--count",
            &format!("{}..{}", target_branch, source_branch),
        ],
    )
    .ok()
    .and_then(|s| s.trim().parse::<u32>().ok())
    .unwrap_or(0);

    let behind_count = super::cmd::git_ok(
        repo,
        &[
            "rev-list",
            "--count",
            &format!("{}..{}", source_branch, target_branch),
        ],
    )
    .ok()
    .and_then(|s| s.trim().parse::<u32>().ok())
    .unwrap_or(0);

    let merge_tree_res = super::cmd::git(
        repo,
        &["merge-tree", "--write-tree", target_branch, source_branch],
    )?;
    if merge_tree_res.ok() {
        Ok(MergePreview {
            can_merge: true,
            has_conflicts: false,
            conflicting_files: Vec::new(),
            commits_ahead: ahead_count,
            commits_behind: behind_count,
            target_branch: target_branch.to_string(),
            source_branch: source_branch.to_string(),
        })
    } else {
        let mut conflicts = Vec::new();
        for line in merge_tree_res.text().lines() {
            let trimmed = line.trim();
            if trimmed.contains("CONFLICT") {
                conflicts.push(trimmed.to_string());
            }
        }
        Ok(MergePreview {
            can_merge: false,
            has_conflicts: true,
            conflicting_files: conflicts,
            commits_ahead: ahead_count,
            commits_behind: behind_count,
            target_branch: target_branch.to_string(),
            source_branch: source_branch.to_string(),
        })
    }
}

#[tauri::command]
pub async fn git_merge_preview(
    _state: tauri::State<'_, AppState>,
    repo: String,
    target_branch: String,
    source_branch: String,
) -> Result<MergePreview, String> {
    blocking(move || merge_preview(&PathBuf::from(repo), &target_branch, &source_branch)).await
}

pub(crate) async fn merge_branch_for_repo(
    repo: String,
    source_branch: String,
) -> Result<String, String> {
    blocking(move || super::cmd::git_ok(&PathBuf::from(repo), &["merge", &source_branch])).await
}

#[tauri::command]
pub async fn git_merge_branch(
    _state: tauri::State<'_, AppState>,
    repo: String,
    source_branch: String,
) -> Result<String, String> {
    merge_branch_for_repo(repo, source_branch).await
}

pub(crate) async fn diff_base_for_cwd(cwd: String) -> Result<String, String> {
    blocking(move || base_sync::diff_base(&PathBuf::from(cwd))).await
}

#[tauri::command]
pub async fn git_diff_base(
    _state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<String, String> {
    diff_base_for_cwd(cwd).await
}

#[tauri::command]
pub async fn git_rebase_onto_base(
    _state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<String, String> {
    blocking(move || base_sync::rebase_onto_base(&PathBuf::from(cwd))).await
}

#[tauri::command]
pub async fn git_discard_all(
    _state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<(), String> {
    blocking(move || base_sync::discard_all(&PathBuf::from(cwd))).await
}

#[tauri::command]
pub async fn git_sync_with_base(
    _state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<BaseSyncResult, String> {
    blocking(move || base_sync::sync_with_base(&PathBuf::from(cwd))).await
}

pub fn get_pr_url(
    repo: &std::path::Path,
    source_branch: &str,
    target_branch: Option<&str>,
) -> Result<PrUrlInfo, String> {
    let target = target_branch.unwrap_or("main");
    let remote_url_res = super::cmd::git_ok(repo, &["remote", "get-url", "origin"]);
    let remote_url = match remote_url_res {
        Ok(u) => u.trim().to_string(),
        Err(_) => {
            return Ok(PrUrlInfo {
                pr_url: None,
                remote_url: None,
                is_github: false,
            })
        }
    };

    let is_github = remote_url.contains("github.com");
    if !is_github {
        return Ok(PrUrlInfo {
            pr_url: None,
            remote_url: Some(remote_url),
            is_github: false,
        });
    }

    let repo_path = if let Some(stripped) = remote_url.strip_prefix("git@github.com:") {
        stripped.trim_end_matches(".git")
    } else if let Some(pos) = remote_url.find("github.com/") {
        remote_url[pos + 11..].trim_end_matches(".git")
    } else {
        return Ok(PrUrlInfo {
            pr_url: None,
            remote_url: Some(remote_url),
            is_github: true,
        });
    };

    let pr_url = format!(
        "https://github.com/{}/compare/{}...{}?expand=1",
        repo_path, target, source_branch
    );
    Ok(PrUrlInfo {
        pr_url: Some(pr_url),
        remote_url: Some(remote_url),
        is_github: true,
    })
}

#[tauri::command]
pub async fn git_get_pr_url(
    _state: tauri::State<'_, AppState>,
    repo: String,
    source_branch: String,
    target_branch: Option<String>,
) -> Result<PrUrlInfo, String> {
    blocking(move || {
        get_pr_url(
            &PathBuf::from(repo),
            &source_branch,
            target_branch.as_deref(),
        )
    })
    .await
}

/// Everything `git add -A && git commit` would record, as a stat + patch against HEAD
/// (new files included). Works on a throwaway copy of the index, so the real staging
/// area is never touched.
pub fn pending_diff(dir: &std::path::Path) -> Result<String, String> {
    use super::cmd::{git_cmd, git_ok, run, GIT_TIMEOUT};
    let index = git_ok(
        dir,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )?;
    let index = PathBuf::from(index.trim());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let tmp = std::env::temp_dir().join(format!("omp-pending-{}-{nanos}.idx", std::process::id()));
    if index.is_file() {
        std::fs::copy(&index, &tmp).map_err(|e| format!("复制暂存区失败: {e}"))?;
    }
    let in_tmp = |args: &[&str]| -> Result<String, String> {
        let mut cmd = git_cmd(dir);
        cmd.env("GIT_INDEX_FILE", &tmp).args(args);
        let out = run(cmd, GIT_TIMEOUT)?;
        if out.ok() {
            Ok(out.text())
        } else {
            Err(out.err_msg())
        }
    };
    let result = in_tmp(&["add", "-A"])
        .and_then(|_| in_tmp(&["diff", "--cached", "--no-color", "--stat", "--patch"]));
    let _ = std::fs::remove_file(&tmp);
    result
}
/// Scoped variant of `pending_diff` restricted to validated literal pathspecs.
pub fn pending_diff_for_paths(
    dir: &std::path::Path,
    pathspecs: &[String],
) -> Result<String, String> {
    use super::cmd::{git_cmd, run, GIT_TIMEOUT};
    if pathspecs.is_empty() {
        return Err("没有检测到任何改动".to_string());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let tmp = std::env::temp_dir().join(format!(
        "omp-pending-scoped-{}-{nanos}.idx",
        std::process::id()
    ));
    let in_tmp = |args: &[&str]| -> Result<String, String> {
        let mut cmd = git_cmd(dir);
        cmd.env("GIT_INDEX_FILE", &tmp).args(args);
        let out = run(cmd, GIT_TIMEOUT)?;
        if out.ok() {
            Ok(out.text())
        } else {
            Err(out.err_msg())
        }
    };
    let result = (|| {
        if super::status::has_head(dir) {
            in_tmp(&["read-tree", "HEAD"])?;
        }
        for chunk in pathspecs.chunks(200) {
            let mut args = vec!["add", "-A", "--"];
            args.extend(chunk.iter().map(String::as_str));
            in_tmp(&args)?;
        }
        in_tmp(&["diff", "--cached", "--no-color", "--stat", "--patch"])
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

async fn suggest_commit_from_diff(
    state: &AppState,
    diff: String,
    recent: String,
) -> Result<String, String> {
    // The stat block comes first, so the file list survives truncation.
    let capped_diff: String = diff.chars().take(8000).collect();
    let prompt = format!(
        "Write a git commit message for the changes below.\n\
         Rules:\n\
         - English, imperative mood, lowercase summary, no trailing period.\n\
         - Reuse the scope names of the recent commits below when they fit.\n\
         - Add bullets only for large changes, at most 5 short ones.\n\n\
         Reply with exactly one JSON object that matches this JSON Schema, and nothing else:\n\
         {COMMIT_DRAFT_SCHEMA}\n\n\
         Recent commits:\n{recent}\n\
         Changes (may be truncated):\n{capped_diff}"
    );

    // Commit messages always use omp's `commit` role (Settings ▸ model roles),
    // independent of any other model setting.
    let model_to_use = "commit";
    let suggestion =
        crate::todos::omp::run_print(state, model_to_use, &prompt, Duration::from_secs(60)).await?;
    parse_commit_draft(&suggestion)
}

pub async fn git_commit_suggest_scoped(
    state: &AppState,
    repo_dir: PathBuf,
    pathspecs: Vec<String>,
) -> Result<String, String> {
    let (diff, recent) = blocking(move || {
        let diff = pending_diff_for_paths(&repo_dir, &pathspecs)?;
        if diff.trim().is_empty() {
            return Err("没有检测到任何改动".to_string());
        }
        let recent = super::cmd::git_ok(&repo_dir, &["log", "-10", "--no-merges", "--format=%s"])
            .unwrap_or_default();
        Ok((diff, recent))
    })
    .await?;
    suggest_commit_from_diff(state, diff, recent).await
}

pub async fn git_commit_suggest_impl(state: &AppState, cwd: &str) -> Result<String, String> {
    let dir = PathBuf::from(cwd);
    let (diff, recent) = blocking(move || {
        let diff = pending_diff(&dir)?;
        if diff.trim().is_empty() {
            return Err("没有检测到任何改动".to_string());
        }
        let recent = super::cmd::git_ok(&dir, &["log", "-10", "--no-merges", "--format=%s"])
            .unwrap_or_default();
        Ok((diff, recent))
    })
    .await?;
    suggest_commit_from_diff(state, diff, recent).await
}

#[tauri::command]
pub async fn git_commit_suggest(
    state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<String, String> {
    git_commit_suggest_impl(&state, &cwd).await
}

/// JSON Schema the model must answer with. `omp -p` cannot enforce a schema,
/// so `parse_commit_draft` re-validates every field.
const COMMIT_DRAFT_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["type", "summary"],
  "additionalProperties": false,
  "properties": {
    "type": {"enum": ["feat", "fix", "refactor", "docs", "test", "chore", "perf", "style", "build", "ci", "revert"]},
    "scope": {"type": "string", "description": "optional, e.g. git, chat"},
    "summary": {"type": "string", "maxLength": 60},
    "bullets": {"type": "array", "maxItems": 5, "items": {"type": "string"}}
  }
}"#;

const COMMIT_TYPES: &[&str] = &[
    "feat", "fix", "refactor", "docs", "test", "chore", "perf", "style", "build", "ci", "revert",
];

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitDraft {
    #[serde(rename = "type")]
    kind: String,
    scope: Option<String>,
    summary: String,
    #[serde(default)]
    bullets: Vec<String>,
}

/// Find the last JSON object in `reply` that fits `CommitDraft` (the model may
/// wrap it in prose or a code fence), validate it, and render the message.
pub fn parse_commit_draft(reply: &str) -> Result<String, String> {
    let draft = reply
        .match_indices('{')
        .filter_map(|(i, _)| {
            serde_json::Deserializer::from_str(&reply[i..])
                .into_iter::<CommitDraft>()
                .next()?
                .ok()
        })
        .next_back()
        .ok_or_else(|| "模型没有按约定的 JSON 格式返回，请重试".to_string())?;

    if !COMMIT_TYPES.contains(&draft.kind.as_str()) {
        return Err(format!("模型返回了未知的提交类型：{}", draft.kind));
    }
    let summary = draft.summary.trim().trim_end_matches('.').trim();
    if summary.is_empty() || summary.contains('\n') {
        return Err("模型返回的提交摘要为空或含换行，请重试".to_string());
    }
    let scope = draft
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let head = match scope {
        Some(s) => format!("{}({s}): {summary}", draft.kind),
        None => format!("{}: {summary}", draft.kind),
    };
    // No length cap: the prompt asks for a short summary, but an over-long one is
    // still a usable message. The UI clips it for display only.
    let bullets: Vec<String> = draft
        .bullets
        .iter()
        .map(|b| b.trim().trim_start_matches("- ").trim())
        .filter(|b| !b.is_empty())
        .take(5)
        .map(|b| format!("- {b}"))
        .collect();
    Ok(if bullets.is_empty() {
        head
    } else {
        format!("{head}\n\n{}", bullets.join("\n"))
    })
}

/// Save every uncommitted change (new files included) as one commit.
pub(crate) async fn commit_all_for_cwd(cwd: String, message: String) -> Result<String, String> {
    blocking(move || {
        let dir = PathBuf::from(&cwd);
        let msg = message.trim();
        if msg.is_empty() {
            return Err("提交信息不能为空".to_string());
        }
        super::cmd::git_ok(&dir, &["add", "-A"]).map_err(|e| format!("git add 失败: {e}"))?;
        super::cmd::git_ok(&dir, &["commit", "-m", msg])
            .map_err(|e| format!("git commit 失败: {e}"))
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    _state: tauri::State<'_, AppState>,
    cwd: String,
    message: String,
) -> Result<String, String> {
    commit_all_for_cwd(cwd, message).await
}

/// Turn checkpoints of one session file (oldest first), enriched with
/// `restorable`/`undone` from the repo's `refs/omp/*`.
#[tauri::command]
pub async fn git_session_turns(
    _state: tauri::State<'_, AppState>,
    session_file: String,
) -> Result<Vec<TurnCheckpoint>, String> {
    blocking(move || turns::session_turns(&PathBuf::from(session_file))).await
}

/// Turn checkpoints of every session assigned to the worktree containing
/// `cwd`, oldest first.
#[tauri::command]
pub async fn git_worktree_turns(
    state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<Vec<TurnCheckpoint>, String> {
    let sessions = session_cwds(&state).await;
    blocking(move || turns::worktree_turns(&PathBuf::from(cwd), &sessions)).await
}

/// Undo a turn of a session: restore it AND every later non-undone turn
/// (newest first — the workspace returns to its state before that turn
/// started), roll back HEAD while each turn's commits are still on top, then
/// mark each turn undone.
#[tauri::command]
pub async fn git_undo_turn(
    _state: tauri::State<'_, AppState>,
    cwd: String,
    session_file: String,
    turn_id: String,
    force: bool,
) -> Result<TurnUndoResult, String> {
    blocking(move || {
        turns::undo_turn(
            &PathBuf::from(cwd),
            &PathBuf::from(session_file),
            &turn_id,
            force,
        )
    })
    .await
}

/// Auto-commit rule text the checkpoints extension injects (consent card).
#[tauri::command]
pub async fn checkpoints_rule() -> Result<String, String> {
    Ok(checkpoints_ext::RULE.to_string())
}

pub(super) fn validate_folder_segment(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err("文件夹名称不合法".to_string());
    }
    Ok(trimmed.to_string())
}

pub(super) fn derive_repo_folder_name(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let trimmed = if trimmed
        .as_bytes()
        .get(trimmed.len().saturating_sub(4)..)
        .is_some_and(|tail| tail.eq_ignore_ascii_case(b".git"))
    {
        trimmed[..trimmed.len() - 4].trim_end_matches('/')
    } else {
        trimmed
    };
    let seg = trimmed.rsplit(['/', ':']).next()?;
    validate_folder_segment(seg).ok()
}

pub(super) fn create_project_dir_internal(
    parent_dir: &str,
    name: &str,
    init_git: bool,
) -> Result<String, String> {
    let parent = crate::services::files::resolve(parent_dir)?;
    if !parent.is_dir() {
        return Err(format!("父目录不存在或不是文件夹：{}", parent.display()));
    }
    let seg = validate_folder_segment(name)?;
    let target = parent.join(&seg);
    crate::services::files::ensure_not_protected(&target)?;
    if target.exists() {
        return Err(format!("目标文件夹已存在：{}", target.display()));
    }
    std::fs::create_dir(&target).map_err(|e| format!("创建文件夹失败：{e}"))?;
    if init_git {
        if let Err(e) = super::cmd::git_ok(&target, &["init"]) {
            let _ = std::fs::remove_dir(&target);
            return Err(format!("初始化 Git 仓库失败：{e}"));
        }
        super::invalidate_cache(&target);
    }
    Ok(target
        .canonicalize()
        .unwrap_or(target)
        .to_string_lossy()
        .into_owned())
}

pub(super) fn git_clone_repo_internal(
    url: &str,
    parent_dir: &str,
    folder_name: Option<&str>,
    timeout: Duration,
) -> Result<String, String> {
    let trimmed_url = url.trim();
    if trimmed_url.is_empty() {
        return Err("仓库地址不能为空".to_string());
    }
    if trimmed_url.starts_with('-') {
        return Err("仓库地址不合法".to_string());
    }
    let parent = crate::services::files::resolve(parent_dir)?;
    if !parent.is_dir() {
        return Err(format!("父目录不存在或不是文件夹：{}", parent.display()));
    }
    let dir_name = match folder_name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(custom) => validate_folder_segment(custom)?,
        None => derive_repo_folder_name(trimmed_url)
            .ok_or_else(|| "无法从仓库地址推断文件夹名称，请手动填写".to_string())?,
    };
    let target = parent.join(&dir_name);
    crate::services::files::ensure_not_protected(&target)?;
    if target.exists() {
        return Err(format!("目标文件夹已存在：{}", target.display()));
    }
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(&parent)
        .env("PATH", crate::todos::omp::augmented_path())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["clone", "--", trimmed_url, &dir_name]);
    let out = super::cmd::run(cmd, timeout)?;
    if !out.ok() {
        return Err(out.err_msg());
    }
    super::invalidate_cache(&target);
    Ok(target
        .canonicalize()
        .unwrap_or(target)
        .to_string_lossy()
        .into_owned())
}

/// Create a new project folder under `parent_dir` and optionally initialize Git.
#[tauri::command]
pub async fn create_project_dir(
    parent_dir: String,
    name: String,
    init_git: bool,
) -> Result<String, String> {
    blocking(move || create_project_dir_internal(&parent_dir, &name, init_git)).await
}

/// Clone a Git repository into `parent_dir` and return the created directory path.
#[tauri::command]
pub async fn git_clone_repo(
    url: String,
    parent_dir: String,
    folder_name: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        git_clone_repo_internal(
            &url,
            &parent_dir,
            folder_name.as_deref(),
            Duration::from_secs(120),
        )
    })
    .await
}

#[cfg(test)]
mod reservation_tests {
    use super::*;

    #[test]
    fn worktree_reservation_blocks_concurrent_and_nested_access_and_releases_on_drop() {
        let base = std::env::temp_dir().join(format!("omp-wt-res-{}", uuid::Uuid::new_v4()));
        let sub = base.join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        let base_str = base.to_string_lossy().into_owned();
        let sub_str = sub.to_string_lossy().into_owned();

        assert!(!is_worktree_reserved(&base_str));
        assert!(!is_worktree_reserved(&sub_str));

        let guard = try_reserve_worktree(&base_str).expect("first reservation must succeed");
        assert!(is_worktree_reserved(&base_str));
        assert!(is_worktree_reserved(&sub_str));

        let dup_err = try_reserve_worktree(&base_str)
            .err()
            .expect("concurrent reservation on same worktree must fail");
        assert!(dup_err.contains("正在合并或清理"));
        let sub_err = try_reserve_worktree(&sub_str)
            .err()
            .expect("nested path reservation must fail");
        assert!(sub_err.contains("正在合并或清理"));

        drop(guard);
        assert!(!is_worktree_reserved(&base_str));
        assert!(!is_worktree_reserved(&sub_str));

        let guard2 = try_reserve_worktree(&base_str).expect("reservation must succeed after drop");
        drop(guard2);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn terminal_ownership_blocks_worktree_reservation_until_dropped() {
        let base = std::env::temp_dir().join(format!("omp-term-own-{}", uuid::Uuid::new_v4()));
        let sub = base.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        let base_str = base.to_string_lossy().into_owned();
        let sub_str = sub.to_string_lossy().into_owned();

        let term_guard =
            try_register_terminal_ownership(&sub_str).expect("terminal ownership must register");
        assert!(active_terminal_cwds()
            .iter()
            .any(|(_, cwd)| cwd == &norm_worktree_key(&sub_str)));
        assert!(worktree::ensure_unused(&base, &active_terminal_cwds(), &[]).is_err());

        let res_err = try_reserve_worktree(&base_str)
            .err()
            .expect("active terminal inside worktree must block reservation");
        assert!(res_err.contains("终端"));

        drop(term_guard);
        assert!(worktree::ensure_unused(&base, &active_terminal_cwds(), &[]).is_ok());
        let wt_guard = try_reserve_worktree(&base_str)
            .expect("reservation must succeed once terminal guard drops");
        let term_err = try_register_terminal_ownership(&sub_str)
            .err()
            .expect("reserved worktree must reject new terminal ownership");
        assert!(term_err.contains("正在合并或清理"));

        drop(wt_guard);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn worktree_create_honors_active_reservation() {
        let repo = std::env::temp_dir().join(format!("omp-wt-create-res-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| -> bool {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !git(&["init", "-q", "-b", "main"]) {
            let _ = std::fs::remove_dir_all(&repo);
            return;
        }
        assert!(git(&["config", "user.name", "t"]));
        assert!(git(&["config", "user.email", "t@example.com"]));
        assert!(git(&["config", "commit.gpgsign", "false"]));
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        assert!(git(&["add", "-A"]));
        assert!(git(&["commit", "-q", "-m", "init"]));

        let planned = repo.join(worktree::WORKTREES_DIR).join("sched-reuse");
        let planned_str = planned.to_string_lossy().into_owned();
        let reservation = try_reserve_worktree(&planned_str).expect("reserve planned path");

        let err = worktree::create(&repo, "sched-reuse", Some("feature/reused"), None)
            .err()
            .expect("worktree creation must be rejected while path is reserved");
        assert!(err.contains("正在合并或清理"), "unexpected error: {err}");
        assert!(!planned.exists());

        drop(reservation);
        let created = worktree::create(&repo, "sched-reuse", Some("feature/reused"), None)
            .expect("worktree creation succeeds after reservation drops");
        assert_eq!(created.branch.as_deref(), Some("feature/reused"));

        let _ = worktree::remove(&repo, Path::new(&created.path), true, true);
        let _ = std::fs::remove_dir_all(&repo);
    }
}

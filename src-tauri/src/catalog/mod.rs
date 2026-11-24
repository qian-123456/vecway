//! [A] Session scan/parse/watch/status/workspaces/usage.
//! Cross-module API per docs/ARCHITECTURE.md §9.
//!
//! Layout: `parse` (head/tail readers), `scan` (listing cache + meta builder),
//! `status` (status machine), `store` (SQLite), `external` (lsof/status files),
//! `transcript` (get_transcript), `usage` (session_usage), `tasks` (background loops).

pub(crate) mod activity;
pub mod commands;
pub(crate) mod external;
pub(crate) mod fs_id;
pub(crate) mod parse;
mod scan;
pub mod search;
pub(crate) mod status;
pub(crate) mod store;
mod tasks;
pub(crate) mod transcript;
mod usage;

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter as _;

use crate::contracts::{PendingKind, SessionMeta, SessionStatus};
use crate::paths;
use crate::state::{AppEvent, AppState};
use crate::storage::sessions;
use crate::storage::sessions::Disposal;
use scan::{FileMap, GitInfo, Scanned};
use status::{DeriveInput, Phase, Runtime};
use store::MetaRow;

/// Git facts are refreshed at most this often per cwd.
const GIT_TTL: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Catalog {
    files: FileMap,
    /// Newest scanned file per session id, kept in sync with `files`.
    by_id: HashMap<String, Arc<Scanned>>,
    runtime: HashMap<String, Runtime>,
    /// Session file path -> external omp pid.
    external: HashMap<String, u32>,
    git: HashMap<String, (Instant, GitInfo)>,
    metas: HashMap<String, SessionMeta>,
    ready: bool,
    /// Ids deleted through `catalog::delete` — guards the bus loop against a
    /// process-exit event that lands after we purged the session's state.
    deleted: std::collections::VecDeque<String>,
    /// Sessions whose current turn the user does not need to read (a side
    /// chat's hand-back summary): its settle must not mark unread / review.
    /// Consumed by the first settling `agent_end`.
    quiet: std::collections::HashSet<String>,
}

impl Catalog {
    fn upsert_file(&mut self, s: Arc<Scanned>) {
        let id = s.head.id.clone();
        let path = s.path.clone();
        let mtime = s.mtime;
        self.files.insert(path.clone(), s.clone());
        match self.by_id.get(&id) {
            Some(cur) if cur.path == path && mtime < cur.mtime => {
                if let Some(best) = self
                    .files
                    .values()
                    .filter(|f| f.head.id == id)
                    .max_by_key(|f| f.mtime)
                    .cloned()
                {
                    self.by_id.insert(id, best);
                }
            }
            Some(cur) if cur.path != path && cur.mtime >= mtime => {}
            _ => {
                self.by_id.insert(id, s);
            }
        }
    }
}
/// Max remembered deleted ids; only recent ones can race a late exit event.
const DELETED_CAP: usize = 512;

fn cat() -> &'static Mutex<Catalog> {
    static CAT: OnceLock<Mutex<Catalog>> = OnceLock::new();
    CAT.get_or_init(Default::default)
}

fn scan_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}

/// Serialize app session creation, pin changes and destructive cleanup. Lock
/// order: RPC resume lock -> mutation gate -> scan lock -> DB/catalog locks.
/// Never acquire this from process-exit or catalog event callbacks.
pub(crate) fn session_mutation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));
    &LOCK
}

/// Spawn scanner/watcher/status tasks.
pub fn init(state: AppState) {
    search::init(&state);
    tasks::spawn_all(state);
}

pub async fn list(state: &AppState) -> Vec<SessionMeta> {
    ensure_ready(state).await;
    let mut list: Vec<SessionMeta> = cat().lock().metas.values().cloned().collect();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    list
}

/// Arm (`true`) or disarm (`false`) the "quiet turn" flag of a session: while
/// armed, the next settling `agent_end` leaves no unread/review mark.
pub(crate) fn set_quiet_turn(session_id: &str, quiet: bool) {
    let mut c = cat().lock();
    if quiet {
        c.quiet.insert(session_id.to_string());
    } else {
        c.quiet.remove(session_id);
    }
}

/// `(session id, cwd)` pairs in `list` order (newest first), skipping empty
/// cwds. Clones only the two strings instead of every full `SessionMeta`.
pub(crate) async fn id_cwds(state: &AppState) -> Vec<(String, String)> {
    ensure_ready(state).await;
    let c = cat().lock();
    let mut refs: Vec<&SessionMeta> = c.metas.values().filter(|m| !m.cwd.is_empty()).collect();
    refs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    refs.into_iter()
        .map(|m| (m.id.clone(), m.cwd.clone()))
        .collect()
}

pub async fn get(state: &AppState, session_id: &str) -> Option<SessionMeta> {
    ensure_ready(state).await;
    if let Some(meta) = cat().lock().metas.get(session_id).cloned() {
        return Some(meta);
    }
    live_handle_meta(state, session_id).await
}

/// Resolve metadata for a live RPC session that has not yet been written/indexed
/// on disk (for example, right after `rpc::start` or draft materialization via `/plan`).
async fn live_handle_meta(state: &AppState, session_id: &str) -> Option<SessionMeta> {
    if cat().lock().deleted.iter().any(|id| id == session_id) {
        return None;
    }
    let handle = crate::rpc::get_handle(session_id)?;
    if !handle.is_usable() {
        return None;
    }
    let info = handle.info();
    if !info.session_file.is_empty() && std::path::Path::new(&info.session_file).is_file() {
        recompute_async(state, Some(vec![session_id.to_string()])).await;
        if let Some(meta) = cat().lock().metas.get(session_id).cloned() {
            return Some(meta);
        }
    }
    let st = state.clone();
    let sid = session_id.to_string();
    let row = tokio::task::spawn_blocking(move || {
        let db = st.db.lock();
        store::load_meta_row(&db, &sid)
    })
    .await
    .ok()?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let title = row
        .custom_name
        .clone()
        .unwrap_or_else(|| "新会话".to_string());
    let label = row
        .seq
        .map(|n| format!("#{n}"))
        .unwrap_or_else(|| row.label.clone().unwrap_or_default());
    let status = if handle.streaming.load(std::sync::atomic::Ordering::SeqCst) {
        SessionStatus::Working
    } else {
        SessionStatus::Idle
    };
    Some(SessionMeta {
        id: info.session_id,
        tool: "omp".into(),
        file: info.session_file,
        cwd: row.cwd_override.unwrap_or(info.cwd),
        title,
        label,
        created_at: now.clone(),
        updated_at: now,
        parent_id: row.parent_session_id,
        fork_depth: row.fork_depth,
        kind: row.kind,
        status,
        unread: row.unread,
        pending: row.pending,
        live: true,
        external_pid: None,
        pinned: row.pinned,
        archived: row.archived,
        workspace_id: row.workspace_id,
        repo_root: None,
        git: None,
        result: None,
        last_assistant: None,
        model: None,
        attention: None,
        mode: row.mode,
        group_id: row.group_id,
        created_by_app: row.created_by_app,
    })
}

/// Internal to A; listed in §9 only so nobody else writes `pending_kind`.
#[allow(dead_code)] // Reserved cross-module API documented in architecture §9.
pub async fn set_pending(state: &AppState, session_id: &str, pending: Option<PendingKind>) {
    let st = state.clone();
    let sid = session_id.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        let db = st.db.lock();
        if let Err(e) = store::set_pending(&db, &sid, pending) {
            tracing::warn!("set_pending {sid}: {e}");
        }
    })
    .await;
    recompute_async(state, Some(vec![session_id.to_string()])).await;
}

/// Persist a resume-directory override (`session_meta.cwd_override`) — chosen
/// when the original worktree dir is gone — then recompute the session so
/// `meta.cwd`, git facts and workspace membership follow the new cwd.
pub async fn set_cwd_override(state: &AppState, session_id: &str, cwd: &str) {
    let st = state.clone();
    let sid = session_id.to_string();
    let cwd = cwd.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        let db = st.db.lock();
        if let Err(e) = store::set_cwd_override(&db, &sid, Some(&cwd)) {
            tracing::warn!("set_cwd_override {sid}: {e}");
        }
    })
    .await;
    recompute_async(state, Some(vec![session_id.to_string()])).await;
}

/// Double-checked cold-start gate: only the first caller under `lock` runs
/// `build`; concurrent waiters see `is_ready() == true` after acquiring `lock`
/// and return immediately without repeating the scan.
async fn ensure_ready_with<F, Fut>(
    lock: &tokio::sync::Mutex<()>,
    is_ready: impl Fn() -> bool,
    build: F,
) where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ()>,
{
    if is_ready() {
        return;
    }
    let _guard = lock.lock().await;
    if is_ready() {
        return;
    }
    build().await;
}

/// Ensure the initial catalog rebuild has finished, deduplicating concurrent
/// cold-start callers under `scan_lock`.
pub(crate) async fn ensure_ready(state: &AppState) {
    let st = state.clone();
    ensure_ready_with(
        scan_lock(),
        || cat().lock().ready,
        move || async move {
            if let Err(e) = tokio::task::spawn_blocking(move || rebuild_blocking(&st)).await {
                tracing::error!("catalog rebuild panicked: {e}");
            }
        },
    )
    .await;
}

/// Full rescan (only changed files are re-parsed), then recompute every meta.
pub(crate) async fn rebuild(state: &AppState) {
    let _guard = scan_lock().lock().await;
    let st = state.clone();
    if let Err(e) = tokio::task::spawn_blocking(move || rebuild_blocking(&st)).await {
        tracing::error!("catalog rebuild panicked: {e}");
    }
}

/// Apply post-transaction filesystem repairs and emit frontend notifications for
/// relocated workspaces (memory dir rename, git worktree repair, UI refresh).
pub(crate) fn apply_relocation_side_effects(state: &AppState, outcomes: &[store::RelocateOutcome]) {
    if outcomes.is_empty() {
        return;
    }
    let payloads: Vec<crate::contracts::WorkspaceRelocation> = outcomes
        .iter()
        .map(|o| {
            for old_p in &o.migrated_old_paths {
                fs_id::migrate_memory_dirs(old_p, &o.relocation.new_path);
            }
            fs_id::repair_git_worktrees(&o.relocation.new_path);
            o.relocation.clone()
        })
        .collect();
    let _ = state.app.emit("workspaces:relocated", &payloads);
    let _ = state.app.emit("backlog:changed", ());
    crate::state::emit_schedules_changed(state);
}

/// Remap a raw transcript header cwd through workspace path aliases when
/// catalog metadata is not yet available (e.g. cold-start `find_session_file`).
pub(crate) fn remap_cwd_using_db(state: &AppState, raw_cwd: &str) -> String {
    let (mut workspaces, aliases) = {
        let db = state.db.lock();
        (
            store::list_workspaces_raw(&db).unwrap_or_default(),
            store::list_workspace_aliases(&db).unwrap_or_default(),
        )
    };
    if aliases.is_empty() {
        return raw_cwd.to_string();
    }
    store::fill_workspace_missing(&mut workspaces);
    let global_dir = paths::global_dir().to_string_lossy().into_owned();
    let row = MetaRow::default();
    let head = parse::HeadInfo {
        cwd: raw_cwd.to_string(),
        ..Default::default()
    };
    let candidate = scan::effective_cwd_with_aliases(&head, &row, &workspaces, &aliases);
    if candidate != raw_cwd {
        return candidate;
    }
    // Try remaining modes if the row wasn't Code.
    for mode in [
        crate::contracts::SpaceMode::Work,
        crate::contracts::SpaceMode::Study,
        crate::contracts::SpaceMode::Research,
    ] {
        if scan::path_within(raw_cwd, &global_dir) {
            break;
        }
        let remapped = scan::remap_cwd_with_aliases(raw_cwd, mode, &workspaces, &aliases);
        if remapped != raw_cwd {
            return remapped;
        }
    }
    raw_cwd.to_string()
}

fn rebuild_blocking(state: &AppState) {
    let t0 = Instant::now();
    let dir = paths::omp_sessions_dir();
    let (prev, ready) = {
        let c = cat().lock();
        (c.files.clone(), c.ready)
    };
    {
        let db = state.db.lock();
        let _ = crate::db::ensure_global_workspace(&db);
    }
    let relocations = store::reconcile_workspaces_unlocked(&state.db);
    if !relocations.is_empty() {
        apply_relocation_side_effects(state, &relocations);
    }
    let files = scan::list_files(&dir);
    let listed = files.len();
    let (map, changed) = scan::scan_files(files, &prev);
    let t_scan = t0.elapsed();
    // Git facts key on the *effective* cwd (a persisted cwd_override or
    // workspace path alias wins over the transcript header's cwd).
    let (overrides, mut workspaces, aliases): (
        HashMap<String, MetaRow>,
        Vec<crate::contracts::Workspace>,
        Vec<store::WorkspaceAlias>,
    ) = {
        let db = state.db.lock();
        (
            store::load_meta_rows(&db).unwrap_or_default(),
            store::list_workspaces_raw(&db).unwrap_or_default(),
            store::list_workspace_aliases(&db).unwrap_or_default(),
        )
    };
    store::fill_workspace_missing(&mut workspaces);
    let empty_row = MetaRow::default();
    refresh_git(
        map.values()
            .map(|s| {
                scan::effective_cwd_with_aliases(
                    &s.head,
                    overrides.get(&s.head.id).unwrap_or(&empty_row),
                    &workspaces,
                    &aliases,
                )
            })
            .collect(),
        false,
    );
    if !changed.is_empty() {
        let db = state.db.lock();
        match db.unchecked_transaction() {
            Ok(tx) => {
                for path in &changed {
                    note_changed(&tx, &map[path], prev.get(path).map(|p| &**p), ready);
                }
                if let Err(e) = tx.commit() {
                    tracing::warn!("catalog note_changed commit: {e}");
                }
            }
            Err(e) => {
                tracing::warn!("catalog note_changed tx: {e}");
                for path in &changed {
                    note_changed(&db, &map[path], prev.get(path).map(|p| &**p), ready);
                }
            }
        };
    }
    let by_id = index_by_id(&map);
    {
        let mut c = cat().lock();
        c.files = map;
        c.by_id = by_id;
    }
    recompute_inner(state, None, false);
    cat().lock().ready = true;
    let total = t0.elapsed();
    let msg = format!(
        "catalog scan: {listed} files, {} parsed in {t_scan:?}, total {total:?}",
        changed.len()
    );
    if ready {
        tracing::debug!("{msg}");
    } else {
        tracing::info!("{msg}");
    }
}

/// Ensure the row of a (re)parsed file and flag a new completed turn written
/// by a non-app process as unread.
fn note_changed(db: &rusqlite::Connection, s: &Scanned, prev: Option<&Scanned>, ready: bool) {
    if let Err(e) = store::ensure_row(db, &s.head.id, &s.path.to_string_lossy()) {
        tracing::warn!("ensure_row {}: {e}", s.head.id);
    }
    if ready && !crate::rpc::is_live(&s.head.id) {
        let old = prev.and_then(|p| p.last_turn_ts().map(str::to_string));
        if let Some(ts) = s.last_turn_ts() {
            if old.as_deref() != Some(ts) {
                let _ = store::set_unread(db, &s.head.id, true);
            }
        }
    }
}

/// Apply watcher events for `paths`. Re-parses only the changed, already
/// indexed session files and recomputes just those sessions; anything the
/// incremental path cannot express (new, deleted or unparsable files, a
/// session id change) falls back to a full rebuild.
pub(crate) async fn refresh_paths(state: &AppState, paths: Vec<PathBuf>) {
    let _guard = scan_lock().lock().await;
    let st = state.clone();
    let r = tokio::task::spawn_blocking(move || {
        if !refresh_paths_blocking(&st, &paths) {
            rebuild_blocking(&st);
        }
    })
    .await;
    if let Err(e) = r {
        tracing::error!("catalog refresh panicked: {e}");
    }
}

/// Returns false when a full rebuild is required.
fn refresh_paths_blocking(state: &AppState, paths: &[PathBuf]) -> bool {
    let (known, ready) = {
        let c = cat().lock();
        let known: Vec<(PathBuf, Option<Arc<Scanned>>)> = paths
            .iter()
            .map(|p| (p.clone(), c.files.get(p).cloned()))
            .collect();
        (known, c.ready)
    };
    if !ready {
        return false;
    }
    let mut updated: Vec<(Arc<Scanned>, Arc<Scanned>)> = Vec::new();
    for (path, prev) in known {
        let Some(prev) = prev else { return false };
        let Ok(md) = std::fs::metadata(&path) else {
            return false;
        };
        let mtime = md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if !md.is_file() {
            return false;
        }
        if md.len() == prev.size && mtime == prev.mtime {
            continue;
        }
        match scan::parse_file(&path, md.len(), mtime, Some(&prev)) {
            Some(s) if s.head.id == prev.head.id => updated.push((prev, Arc::new(s))),
            _ => return false,
        }
    }
    if updated.is_empty() {
        return true;
    }
    {
        let db = state.db.lock();
        match db.unchecked_transaction() {
            Ok(tx) => {
                for (prev, s) in &updated {
                    note_changed(&tx, s, Some(prev), ready);
                }
                if let Err(e) = tx.commit() {
                    tracing::warn!("catalog refresh note_changed commit: {e}");
                }
            }
            Err(e) => {
                tracing::warn!("catalog refresh note_changed tx: {e}");
                for (prev, s) in &updated {
                    note_changed(&db, s, Some(prev), ready);
                }
            }
        };
    }
    let mut ids: Vec<String> = Vec::with_capacity(updated.len());
    {
        let mut c = cat().lock();
        for (_, s) in updated {
            ids.push(s.head.id.clone());
            c.upsert_file(s);
        }
    }
    ids.sort();
    ids.dedup();
    recompute_blocking(state, Some(ids));
    true
}

/// Newest file per session id.
fn index_by_id(files: &FileMap) -> HashMap<String, Arc<Scanned>> {
    let mut idx: HashMap<String, Arc<Scanned>> = HashMap::with_capacity(files.len());
    for s in files.values() {
        match idx.get(&s.head.id) {
            Some(cur) if cur.mtime >= s.mtime => {}
            _ => {
                idx.insert(s.head.id.clone(), s.clone());
            }
        }
    }
    idx
}

fn git_needs_refresh(cached_at: Option<Instant>, force: bool) -> bool {
    force
        || match cached_at {
            Some(at) => at.elapsed() >= GIT_TTL,
            None => true,
        }
}

/// Refresh cached git facts for `cwds`; returns the cwds whose facts changed.
fn refresh_git(cwds: Vec<String>, force: bool) -> Vec<String> {
    let todo: Vec<String> = {
        let c = cat().lock();
        let uniq: HashSet<String> = cwds.into_iter().collect();
        uniq.into_iter()
            .filter(|cwd| git_needs_refresh(c.git.get(cwd).map(|(at, _)| *at), force))
            .collect()
    };
    if todo.is_empty() {
        return Vec::new();
    }
    let chunk = todo.len().div_ceil(8).max(1);
    let results: Vec<(String, GitInfo)> = std::thread::scope(|scope| {
        let handles: Vec<_> = todo
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    part.iter()
                        .map(|cwd| {
                            let p = std::path::Path::new(cwd);
                            let info = if !cwd.is_empty() && p.is_dir() {
                                GitInfo {
                                    badge: crate::git::badge(p),
                                    repo_root: crate::git::repo_root(p),
                                }
                            } else {
                                GitInfo::default()
                            };
                            (cwd.clone(), info)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });
    let mut c = cat().lock();
    let now = Instant::now();
    let mut changed = Vec::new();
    for (cwd, info) in results {
        let differs = c.git.get(&cwd).is_none_or(|(_, old)| *old != info);
        if differs {
            changed.push(cwd.clone());
        }
        c.git.insert(cwd, (now, info));
    }
    // Bound the cache like `git::badge_cache`: drop entries past the TTL once
    // it outgrows any realistic session count (fresh ones were just inserted).
    if c.git.len() > 4096 {
        c.git.retain(|_, (at, _)| at.elapsed() < GIT_TTL);
    }
    changed
}

fn parse_ts(s: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(s).ok()
}

/// `a` is at or after `b` (both ISO timestamps).
fn ts_at_or_after(a: Option<&str>, b: Option<&str>) -> bool {
    match (a.and_then(parse_ts), b.and_then(parse_ts)) {
        (Some(a), Some(b)) => a >= b,
        _ => false,
    }
}

pub(crate) async fn recompute_async(state: &AppState, ids: Option<Vec<String>>) {
    // If any requested id is not yet indexed, fall back to a full rebuild so
    // newly created session files are picked up.
    let needs_rebuild = match &ids {
        Some(ids) => {
            let c = cat().lock();
            ids.iter().any(|id| !c.by_id.contains_key(id))
        }
        None => false,
    };
    if needs_rebuild {
        rebuild(state).await;
        return;
    }
    let st = state.clone();
    let _ = tokio::task::spawn_blocking(move || recompute_blocking(&st, ids)).await;
}

/// Recompute metas for `ids` (None = all), persist derived pending, emit diffs.
fn recompute_blocking(state: &AppState, ids: Option<Vec<String>>) {
    recompute_inner(state, ids, true);
}

/// [`recompute_blocking`]; `refresh` = false skips the git-facts refresh when
/// the caller just refreshed the same cwds.
fn recompute_inner(state: &AppState, ids: Option<Vec<String>>, refresh: bool) {
    scan::reset_canon_cache();
    let full = ids.is_none();
    // Collect live targets directly from the maintained `by_id` index without
    // rebuilding a full session map.
    let targets: Vec<Arc<Scanned>> = {
        let c = cat().lock();
        match &ids {
            None => c
                .by_id
                .values()
                .filter(|s| !c.deleted.contains(&s.head.id))
                .cloned()
                .collect(),
            Some(ids) => ids
                .iter()
                .filter_map(|id| c.by_id.get(id).cloned())
                .filter(|s| !c.deleted.contains(&s.head.id))
                .collect(),
        }
    };
    let live: HashSet<String> = targets
        .iter()
        .filter(|s| crate::rpc::is_live(&s.head.id))
        .map(|s| s.head.id.clone())
        .collect();

    // DB phase: rows (+ batched seq assignment for labels without "#<n>"), workspaces, and aliases.
    let (mut rows, mut workspaces, aliases) = {
        let db = state.db.lock();
        let mut rows = match &ids {
            None => store::load_meta_rows(&db).unwrap_or_default(),
            Some(ids) => ids
                .iter()
                .map(|id| (id.clone(), store::load_meta_row(&db, id)))
                .collect(),
        };
        let mut need_seq: Vec<(String, String)> = Vec::new();
        for s in &targets {
            let id = &s.head.id;
            let row = rows.entry(id.clone()).or_default();
            let needs_seq = row.seq.is_none()
                && row.label.as_deref().is_none_or(str::is_empty)
                && scan::title_number(s, row).is_none();
            if needs_seq {
                need_seq.push((id.clone(), s.path.to_string_lossy().into_owned()));
            }
        }
        if !need_seq.is_empty() {
            let refs: Vec<(&str, &str)> = need_seq
                .iter()
                .map(|(id, file)| (id.as_str(), file.as_str()))
                .collect();
            match store::assign_seqs_batch(&db, &refs) {
                Ok(assigned) => {
                    for (id, seq) in assigned {
                        if let Some(row) = rows.get_mut(&id) {
                            row.seq = Some(seq);
                        }
                    }
                }
                Err(e) => tracing::warn!("assign_seqs_batch: {e}"),
            }
        }
        (
            rows,
            store::list_workspaces_raw(&db).unwrap_or_default(),
            store::list_workspace_aliases(&db).unwrap_or_default(),
        )
    };
    store::fill_workspace_missing(&mut workspaces);

    // Refresh git facts for the effective cwd of each target (override- and alias-aware).
    // (Skipped right after a full rebuild, which already refreshed every cwd.)
    if refresh {
        let empty_row = MetaRow::default();
        let cwds = targets
            .iter()
            .map(|s| {
                scan::effective_cwd_with_aliases(
                    &s.head,
                    rows.get(&s.head.id).unwrap_or(&empty_row),
                    &workspaces,
                    &aliases,
                )
            })
            .collect();
        refresh_git(cwds, false);
    }
    // Persist a unique cross-space project owner before publishing session
    // metadata. Never overwrite a concurrent change to the stored assignment.
    let global_dir = paths::global_dir().to_string_lossy().into_owned();
    let moves: Vec<_> = {
        let c = cat().lock();
        targets
            .iter()
            .filter_map(|s| {
                let row = rows.get(&s.head.id)?;
                let cwd = scan::effective_cwd_with_aliases(&s.head, row, &workspaces, &aliases);
                let repo_root = c.git.get(&cwd).and_then(|g| g.1.repo_root.as_deref());
                let mode =
                    scan::unassigned_code_owner(row, &workspaces, repo_root, &cwd, &global_dir)?;
                Some((s.head.id.clone(), mode))
            })
            .collect()
    };
    if !moves.is_empty() {
        let db = state.db.lock();
        for (id, mode) in moves {
            let Some(row) = rows.get_mut(&id) else {
                continue;
            };
            match scan::persist_code_owner(&db, &id, row, mode) {
                Ok(true) => {}
                Ok(false) => *row = store::load_meta_row(&db, &id),
                Err(e) => tracing::warn!("migrate session workspace {id}: {e}"),
            }
        }
    }
    // Compute phase (global dirs are derived per-mode inside build_meta).
    let mut pending_writes = Vec::new();
    let mut changed = Vec::new();
    let mut status_changes = Vec::new();
    let mut removed = Vec::new();
    {
        let mut c = cat().lock();
        for s in &targets {
            let id = &s.head.id;
            if c.deleted.contains(id) {
                continue;
            }
            let row = rows.remove(id).unwrap_or_default();
            let parent_id = row.parent_session_id.clone().or_else(|| {
                let p = s.head.parent_session.as_deref()?;
                if c.by_id.contains_key(p) {
                    return Some(p.to_string());
                }
                c.files.get(&PathBuf::from(p)).map(|ps| ps.head.id.clone())
            });
            let eff_cwd = scan::effective_cwd_with_aliases(&s.head, &row, &workspaces, &aliases);
            let git = c.git.get(&eff_cwd).map(|g| g.1.clone()).unwrap_or_default();
            let mut meta =
                scan::build_meta_with_aliases(s, &row, &git, &workspaces, &aliases, parent_id);
            let rt = c.runtime.get(id).cloned().unwrap_or_default();
            if let Some(act_ts) = rt.last_activity_at.as_deref().and_then(parse_ts) {
                let act_utc = act_ts.with_timezone(&chrono::Utc);
                if parse_ts(&meta.updated_at)
                    .is_none_or(|cur| act_utc > cur.with_timezone(&chrono::Utc))
                {
                    meta.updated_at = act_utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                }
            }
            let is_live = !rt.exited && (rt.live || live.contains(id));
            let path = s.path.to_string_lossy();
            let external_pid = if is_live {
                None
            } else {
                c.external.get(path.as_ref()).copied()
            };
            let tail_ts = s.tail.last_msg.as_ref().map(|m| m.ts.as_str());
            let (status, pending) = status::derive(&DeriveInput {
                live: is_live,
                runtime: rt,
                pending: row.pending,
                suspended: row.suspended,
                external: external_pid.is_some(),
                tail: Some(s.tail.state()),
                tail_accepted: ts_at_or_after(row.accepted_at.as_deref(), tail_ts),
                pending_superseded: row.pending_since.is_some()
                    && !ts_at_or_after(row.pending_since.as_deref(), tail_ts),
            });
            meta.status = status;
            meta.pending = pending;
            meta.live = is_live;
            meta.external_pid = external_pid;
            // A freshly changed pending gets pending_since = now when written,
            // so it is necessarily unseen.
            let error_since = if pending == row.pending {
                row.pending_since.as_deref().unwrap_or(&meta.updated_at)
            } else {
                "9999-12-31T23:59:59.999Z"
            };
            meta.attention = status::attention(
                meta.status,
                pending,
                meta.unread,
                row.last_seen_at.as_deref(),
                error_since,
            );
            if pending != row.pending {
                pending_writes.push((id.clone(), pending));
            }
            let old = c.metas.get(id);
            let differs = old.is_none_or(|o| !same_meta(o, &meta));
            if let Some(o) = old {
                if o.status != meta.status {
                    status_changes.push((id.clone(), o.status, meta.status));
                }
            }
            if differs {
                changed.push(meta.clone());
                c.metas.insert(id.clone(), meta);
            }
        }
        if full {
            removed = c
                .metas
                .keys()
                .filter(|id| !c.by_id.contains_key(*id))
                .cloned()
                .collect();
            for id in &removed {
                c.metas.remove(id);
            }
        }
    }

    if !pending_writes.is_empty() {
        let db = state.db.lock();
        match db.unchecked_transaction() {
            Ok(tx) => {
                for (id, p) in &pending_writes {
                    if let Err(e) = store::set_pending(&tx, id, *p) {
                        tracing::warn!("persist pending {id}: {e}");
                    }
                }
                if let Err(e) = tx.commit() {
                    tracing::warn!("persist pending commit: {e}");
                }
            }
            Err(e) => {
                tracing::warn!("persist pending tx: {e}");
                for (id, p) in &pending_writes {
                    if let Err(e) = store::set_pending(&db, id, *p) {
                        tracing::warn!("persist pending {id}: {e}");
                    }
                }
            }
        };
    }
    emit_changes(state, changed, removed, status_changes);
}

fn same_meta(a: &SessionMeta, b: &SessionMeta) -> bool {
    a == b
}

fn emit_changes(
    state: &AppState,
    changed: Vec<SessionMeta>,
    removed: Vec<String>,
    status_changes: Vec<(String, SessionStatus, SessionStatus)>,
) {
    if changed.is_empty() && removed.is_empty() {
        return;
    }
    let mut ids: Vec<String> = changed.iter().map(|m| m.id.clone()).collect();
    ids.extend(removed.iter().cloned());
    if !changed.is_empty() {
        let _ = state.app.emit("sessions:updated", &changed);
    }
    if !removed.is_empty() {
        let _ = state.app.emit("sessions:removed", &removed);
    }
    for (session_id, old, new) in status_changes {
        state.emit(AppEvent::SessionStatusChanged {
            session_id,
            old,
            new,
        });
    }
    state.emit(AppEvent::SessionsChanged { ids });
}

/// Session file path for an id (from the scan cache). Falls back to the live
/// RPC handle: omp writes the transcript lazily on the first message, so a
/// just-spawned session may have no file on disk yet — the handle already
/// knows its destined path.
pub(crate) fn file_of(session_id: &str) -> Option<PathBuf> {
    let c = cat().lock();
    if let Some(m) = c.metas.get(session_id) {
        return Some(PathBuf::from(&m.file));
    }
    if let Some(s) = c.by_id.get(session_id) {
        return Some(s.path.clone());
    }
    drop(c);
    crate::rpc::get_handle(session_id)
        .map(|h| PathBuf::from(h.session_file.read().clone()))
        .filter(|p| !p.as_os_str().is_empty())
}

/// Permanently delete a session. A live but idle runtime (not `Working`, no
/// open dialogs) is stopped via `rpc::stop` first; a busy one is refused. Then
/// remove its transcript files and `session_meta` row and emit
/// `sessions:removed`. Sessions with no transcript on disk yet are still
/// deletable while live — the handle's destined `session_file` is removed too
/// (NotFound tolerated).
pub(crate) async fn delete(state: &AppState, session_id: &str) -> Result<(), String> {
    delete_with(state, session_id, Disposal::Permanent).await
}

/// Timeout for the destructive-cleanup `lsof` ownership check.
const CLEANUP_LSOF_TIMEOUT: Duration = Duration::from_secs(5);

/// Cleanup is destructive: unlike periodic discovery, a failed ownership
/// probe is not evidence that no terminal owns the transcript.
fn cleanup_holders_from_parts(
    code: Option<i32>,
    stdout: &[u8],
    stderr: &str,
    sessions_dir: &std::path::Path,
) -> Result<HashMap<String, external::Holder>, String> {
    if !stderr.is_empty() || !matches!(code, Some(0) | Some(1)) {
        return Err(format!(
            "无法核验终端会话占用，已跳过清理：{}",
            stderr.trim()
        ));
    }
    // lsof exit 1 with no diagnostic means no matching open files.
    Ok(external::parse_lsof(
        &String::from_utf8_lossy(stdout),
        &sessions_dir.to_string_lossy(),
    ))
}

#[cfg(test)]
fn cleanup_holders_from_output(
    output: std::process::Output,
    sessions_dir: &std::path::Path,
) -> Result<HashMap<String, external::Holder>, String> {
    let stderr = String::from_utf8_lossy(&output.stderr);
    cleanup_holders_from_parts(output.status.code(), &output.stdout, &stderr, sessions_dir)
}

fn cleanup_external_holders(
    sessions_dir: &std::path::Path,
) -> Result<HashMap<String, external::Holder>, String> {
    let mut cmd = std::process::Command::new(crate::services::scan::lsof_bin());
    cmd.args(["-w", "-n", "-P", "-c", "omp", "-F", "pRn"])
        .env("PATH", "/usr/sbin:/usr/bin:/bin:/sbin");
    let out = crate::git::cmd::run(cmd, CLEANUP_LSOF_TIMEOUT)
        .map_err(|e| format!("无法核验终端会话占用，已跳过清理：{e}"))?;
    cleanup_holders_from_parts(out.code, &out.stdout, &out.stderr, sessions_dir)
}

/// [`delete`] with a choice of disposal. Besides the transcript it removes the
/// session's lock file and artifacts dir (`<stem>/`: subagent logs, tool
/// output); `Disposal::Trash` moves them to the macOS Trash instead.
pub(crate) async fn delete_with(
    state: &AppState,
    session_id: &str,
    disposal: Disposal,
) -> Result<(), String> {
    ensure_ready(state).await;

    let sessions_dir = paths::omp_sessions_dir();
    // Run slow external ownership probes off the async worker and outside
    // `session_mutation_lock` / `scan_lock` so other catalog & session ops are
    // never blocked while `lsof` runs.
    let external_probe: Option<(HashMap<String, external::Holder>, Vec<external::StatusFile>)> =
        if disposal == Disposal::Trash {
            if crate::rpc::get_handle(session_id)
                .is_some_and(|h| h.alive.load(std::sync::atomic::Ordering::SeqCst))
            {
                return Err("正在运行".into());
            }
            if crate::terminal::commands::omp_terminal_open(session_id) {
                return Err("正被终端里的 omp 使用".into());
            }
            let s_dir = sessions_dir.clone();
            let st_dir = paths::status_dir();
            let probed = tokio::task::spawn_blocking(move || {
                let holders = cleanup_external_holders(&s_dir)?;
                let alive_status: Vec<external::StatusFile> = external::read_status_files(&st_dir)
                    .into_iter()
                    .filter(|s| s.state != "exited" && external::pid_alive(s.pid))
                    .collect();
                Ok::<_, String>((holders, alive_status))
            })
            .await
            .map_err(|e| format!("无法核验终端会话占用，已跳过清理：{e}"))??;
            Some(probed)
        } else {
            None
        };

    let mutation_guard = session_mutation_lock().lock().await;

    // A live process mid-turn or waiting on a dialog owns state we cannot
    // silently drop; anything else is safe to stop and delete.
    let mut was_live = false;
    let mut handle_file = None;
    if let Some(handle) = crate::rpc::get_handle(session_id) {
        if handle.alive.load(std::sync::atomic::Ordering::SeqCst) {
            if disposal == Disposal::Trash {
                return Err("正在运行".into());
            }
            let busy = cat()
                .lock()
                .runtime
                .get(session_id)
                .is_some_and(|rt| rt.phase == Phase::Working || !rt.dialogs.is_empty());
            if busy {
                return Err("会话仍在运行，请先停止当前回合".to_string());
            }
            // Capture before stop: the monitor clears registry state on exit.
            let f = PathBuf::from(handle.session_file.read().clone());
            if !f.as_os_str().is_empty() {
                handle_file = Some(f);
            }
            crate::rpc::stop(&handle).await?;
            was_live = true;
        }
    }

    // Close any PTY terminal opened for this session before its files go.
    if disposal == Disposal::Trash {
        if crate::terminal::commands::omp_terminal_open(session_id) {
            return Err("正被终端里的 omp 使用".into());
        }
    } else {
        crate::terminal::commands::close_session_term(session_id);
    }

    // Serialize the file/row/cache mutation against scans: a scan that read
    // `c.files` before the deletion would otherwise commit the removed session
    // back into the catalog (and re-insert its `session_meta` row) after we
    // purged it. `rebuild`/`refresh_paths` hold the same lock for their whole
    // read-parse-commit cycle.
    let scan_guard = scan_lock().lock().await;

    // Collect every transcript file for this session id.
    let (paths, meta_file) = {
        let c = cat().lock();
        let files: Vec<PathBuf> = c
            .files
            .values()
            .filter(|s| s.head.id == session_id)
            .map(|s| s.path.clone())
            .collect();
        let meta_file = c.metas.get(session_id).map(|m| PathBuf::from(&m.file));
        (files, meta_file)
    };
    if paths.is_empty() && meta_file.is_none() && !was_live {
        return Err(format!("session not found: {session_id}"));
    }

    let st = state.clone();
    let sid = session_id.to_string();
    let gone = tokio::task::spawn_blocking(move || -> Result<HashSet<String>, String> {
        let cleanup_facts = if disposal == Disposal::Trash {
            // Recheck pinned & app-live state under the mutation/scan gates.
            let pinned: bool = st
                .db
                .lock()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM session_meta WHERE session_id = ?1 AND pinned != 0)",
                    [&sid],
                    |row| row.get(0),
                )
                .map_err(|e| format!("读取置顶状态失败: {e}"))?;
            let (holders, status) = external_probe.unwrap_or_default();
            let external_pid = paths.iter().chain(meta_file.iter()).find_map(|path| {
                let file = path.to_string_lossy();
                holders
                    .get(file.as_ref())
                    .map(|holder| holder.pid)
                    .or_else(|| {
                        status
                            .iter()
                            .find(|s| s.session_file.as_str() == file.as_ref())
                            .map(|s| s.pid)
                    })
            });
            let live = crate::rpc::get_handle(&sid).is_some();
            Some((live, pinned, external_pid))
        } else {
            None
        };
        let mut gone = HashSet::new();
        for path in paths
            .iter()
            .chain(meta_file.iter())
            .chain(handle_file.iter())
        {
            // Missing files are fine (NotFound tolerated by the remover).
            if let Some((live, pinned, external_pid)) = cleanup_facts {
                sessions::remove_files_if_unused(
                    path,
                    &sessions_dir,
                    disposal,
                    live,
                    pinned,
                    external_pid,
                )?;
            } else {
                sessions::remove_files(path, &sessions_dir, disposal)?;
            }
            gone.insert(path.to_string_lossy().to_string());
        }
        {
            let db = st.db.lock();
            store::delete_row(&db, &sid)
                .map_err(|e| format!("delete session_meta {sid}: {e}"))?;
        }
        Ok(gone)
    })
    .await
    .map_err(|e| format!("delete session {session_id}: {e}"))??;

    {
        let mut c = cat().lock();
        c.files
            .retain(|p, _| !gone.contains(&p.to_string_lossy().to_string()));
        c.by_id.remove(session_id);
        c.metas.remove(session_id);
        c.runtime.remove(session_id);
        c.external.retain(|p, _| !gone.contains(p));
        if !c.deleted.contains(&session_id.to_string()) {
            if c.deleted.len() >= DELETED_CAP {
                c.deleted.pop_front();
            }
            c.deleted.push_back(session_id.to_string());
        }
    }
    drop(scan_guard);
    drop(mutation_guard);
    crate::rpc::remove_resume_lock(session_id);
    emit_changes(state, Vec::new(), vec![session_id.to_string()], Vec::new());
    Ok(())
}

#[cfg(test)]
mod refresh_tests {
    use super::*;

    #[test]
    fn git_refresh_respects_expiry_and_force() {
        let now = Instant::now();
        assert!(git_needs_refresh(None, false));
        assert!(!git_needs_refresh(Some(now), false));
        assert!(git_needs_refresh(Some(now), true));
        assert!(git_needs_refresh(Some(now - GIT_TTL), false));
    }
    #[tokio::test]
    async fn cleanup_gate_blocks_start_and_pin_until_disposal_finishes() {
        let cleanup = session_mutation_lock().lock().await;
        let mutations = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let mut pending = Vec::new();
        let mut started = Vec::new();
        for _ in ["start", "pin"] {
            let mutations = mutations.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            started.push(rx);
            pending.push(tokio::spawn(async move {
                let _ = tx.send(());
                let _mutation = session_mutation_lock().lock().await;
                mutations.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }));
        }
        for ready in started {
            ready.await.unwrap();
        }
        assert_eq!(mutations.load(std::sync::atomic::Ordering::SeqCst), 0);
        drop(cleanup);
        for task in pending {
            task.await.unwrap();
        }
        assert_eq!(mutations.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
    #[cfg(unix)]
    fn lsof_output(code: i32, stdout: &str, stderr: &str) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
        std::process::Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_external_probe_refuses_failure_or_partial_observation() {
        let dir = std::path::Path::new("/sessions");
        assert!(cleanup_holders_from_output(lsof_output(2, "", "permission denied"), dir).is_err());
        assert!(cleanup_holders_from_output(lsof_output(0, "", "partial results"), dir).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_external_probe_accepts_confirmed_empty_or_current_holder() {
        let dir = std::path::Path::new("/sessions");
        assert!(cleanup_holders_from_output(lsof_output(1, "", ""), dir)
            .unwrap()
            .is_empty());
        let current = cleanup_holders_from_output(
            lsof_output(0, "p123\nR1\nn/sessions/project/s.jsonl\n", ""),
            dir,
        )
        .unwrap();
        assert_eq!(current["/sessions/project/s.jsonl"].pid, 123);
    }

    #[tokio::test]
    async fn ensure_ready_coalesces_concurrent_cold_rebuilds() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        let lock = Arc::new(tokio::sync::Mutex::new(()));
        let ready = Arc::new(AtomicBool::new(false));
        let builds = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(tokio::sync::Barrier::new(8));

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let lock = lock.clone();
            let ready = ready.clone();
            let builds = builds.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                let r_check = ready.clone();
                let r_set = ready.clone();
                let b = builds.clone();
                ensure_ready_with(
                    &lock,
                    move || r_check.load(Ordering::Acquire),
                    move || async move {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        b.fetch_add(1, Ordering::SeqCst);
                        r_set.store(true, Ordering::Release);
                    },
                )
                .await;
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        assert_eq!(builds.load(Ordering::SeqCst), 1);

        // Once ready, subsequent calls bypass the build completely.
        let r_check = ready.clone();
        let b = builds.clone();
        ensure_ready_with(
            &lock,
            move || r_check.load(Ordering::Acquire),
            move || async move {
                b.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert_eq!(builds.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn catalog_upsert_file_keeps_by_id_pointing_to_newest_file() {
        use std::time::{Duration, UNIX_EPOCH};

        let mk = |path: &str, secs: u64| {
            Arc::new(Scanned {
                path: PathBuf::from(path),
                size: 10,
                mtime: UNIX_EPOCH + Duration::from_secs(secs),
                head: parse::HeadInfo {
                    id: "s1".to_string(),
                    ..Default::default()
                },
                head_hash: 1,
                tail: parse::TailInfo::default(),
                first_user: None,
            })
        };

        let mut cat = Catalog::default();
        cat.upsert_file(mk("/sessions/a/old.jsonl", 10));
        assert_eq!(cat.by_id["s1"].path, PathBuf::from("/sessions/a/old.jsonl"));
        cat.upsert_file(mk("/sessions/a/new.jsonl", 20));
        assert_eq!(cat.by_id["s1"].path, PathBuf::from("/sessions/a/new.jsonl"));
        // Older sibling does not overwrite newer entry.
        cat.upsert_file(mk("/sessions/a/older.jsonl", 5));
        assert_eq!(cat.by_id["s1"].path, PathBuf::from("/sessions/a/new.jsonl"));
        // Clock rollback on active file re-selects the newest remaining file.
        cat.upsert_file(mk("/sessions/a/new.jsonl", 1));
        assert_eq!(cat.by_id["s1"].path, PathBuf::from("/sessions/a/old.jsonl"));
    }
}

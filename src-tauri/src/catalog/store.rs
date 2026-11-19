//! SQLite access for `session_meta` and `workspaces` (schema in db.rs, §6).

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::fs_id::{self, DirIdentity};
use crate::contracts::{
    PendingKind, SessionGroup, SessionMetaPatch, SpaceMode, Workspace, WorkspaceKind,
    WorkspaceRelocation,
};

/// One `session_meta` row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MetaRow {
    pub custom_name: Option<String>,
    pub label: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    pub parent_session_id: Option<String>,
    pub fork_depth: u8,
    pub workspace_id: Option<String>,
    pub unread: bool,
    pub pending: Option<PendingKind>,
    pub pending_since: Option<String>,
    pub accepted_at: Option<String>,
    pub suspended: bool,
    pub seq: Option<i64>,
    /// Resume-directory override (§3): set when the user chose to continue a
    /// session whose original worktree dir was deleted in the repo's main dir.
    pub cwd_override: Option<String>,
    /// Last time the user viewed the session (`mark_seen`).
    pub last_seen_at: Option<String>,
    /// Space the session belongs to; Code when the column is absent/'code'.
    pub mode: SpaceMode,
    /// SessionGroup inside the mode's 无项目 area (global sessions only).
    pub group_id: Option<String>,
    /// "side" | "fork" | None; legacy side chats (fork_depth > 0 created by
    /// the app, kind NULL) are projected as "side".
    pub kind: Option<String>,
    /// App created or took over the session (`session_meta.created_by_app`).
    pub created_by_app: bool,
}

pub fn pending_to_str(p: PendingKind) -> &'static str {
    match p {
        PendingKind::Approval => "approval",
        PendingKind::Question => "question",
        PendingKind::Review => "review",
        PendingKind::Error => "error",
        PendingKind::Interrupted => "interrupted",
    }
}

pub fn pending_from_str(s: &str) -> Option<PendingKind> {
    Some(match s {
        "approval" => PendingKind::Approval,
        "question" => PendingKind::Question,
        "review" => PendingKind::Review,
        "error" => PendingKind::Error,
        "interrupted" => PendingKind::Interrupted,
        _ => return None,
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn load_meta_rows(conn: &Connection) -> rusqlite::Result<HashMap<String, MetaRow>> {
    query_rows(conn, None)
}

pub fn load_meta_row(conn: &Connection, id: &str) -> MetaRow {
    query_rows(conn, Some(id))
        .ok()
        .and_then(|mut m| m.remove(id))
        .unwrap_or_default()
}

fn query_rows(conn: &Connection, id: Option<&str>) -> rusqlite::Result<HashMap<String, MetaRow>> {
    // A plain `session_id = ?1` lets SQLite seek the primary key; the
    // `?1 IS NULL OR …` form would scan.
    let filter = if id.is_some() {
        "WHERE session_id = ?1"
    } else {
        ""
    };
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT session_id, custom_name, label, pinned, archived, parent_session_id, fork_depth,
                workspace_id, unread, pending_kind, pending_since, accepted_at, suspended, seq,
                cwd_override, last_seen_at, mode, group_id,
                COALESCE(kind, CASE WHEN fork_depth > 0 AND created_by_app = 1 THEN 'side' END),
                created_by_app
         FROM session_meta {filter}"
    ))?;
    let rows = if let Some(id) = id {
        stmt.query_map(params![id], map_row)?
    } else {
        stmt.query_map([], map_row)?
    };
    rows.collect()
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(String, MetaRow)> {
    let pending: Option<String> = r.get(9)?;
    Ok((
        r.get::<_, String>(0)?,
        MetaRow {
            custom_name: r.get(1)?,
            label: r.get(2)?,
            pinned: r.get::<_, i64>(3)? != 0,
            archived: r.get::<_, i64>(4)? != 0,
            parent_session_id: r.get(5)?,
            fork_depth: r.get::<_, i64>(6)?.clamp(0, 3) as u8,
            workspace_id: r.get(7)?,
            unread: r.get::<_, i64>(8)? != 0,
            pending: pending.as_deref().and_then(pending_from_str),
            pending_since: r.get(10)?,
            accepted_at: r.get(11)?,
            suspended: r.get::<_, i64>(12)? != 0,
            seq: r.get(13)?,
            cwd_override: r.get(14)?,
            last_seen_at: r.get(15)?,
            mode: SpaceMode::from_str_lossy(&r.get::<_, String>(16)?),
            group_id: r.get(17)?,
            kind: r.get(18)?,
            created_by_app: r.get::<_, i64>(19)? != 0,
        },
    ))
}

/// Persist (or clear with None) the resume-directory override; the catalog
/// uses it as the session's effective cwd on the next recompute.
pub fn set_cwd_override(conn: &Connection, id: &str, cwd: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_meta(session_id, cwd_override) VALUES(?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET cwd_override = excluded.cwd_override",
        params![id, cwd],
    )?;
    Ok(())
}

/// Ensure a row exists and record the current file path.
pub fn ensure_row(conn: &Connection, id: &str, file: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_meta(session_id, file_path) VALUES(?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET file_path = excluded.file_path
         WHERE session_meta.file_path IS NOT excluded.file_path",
        params![id, file],
    )?;
    Ok(())
}

/// Assign the next local sequence number (`#L<seq>`) if the row has none.
pub fn assign_seq(conn: &Connection, id: &str) -> rusqlite::Result<i64> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT seq FROM session_meta WHERE session_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(seq) = existing {
        return Ok(seq);
    }
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM session_meta",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE session_meta SET seq = ?2 WHERE session_id = ?1",
        params![id, next],
    )?;
    Ok(next)
}

pub fn set_pending(
    conn: &Connection,
    id: &str,
    pending: Option<PendingKind>,
) -> rusqlite::Result<()> {
    let since = pending.map(|_| now());
    conn.execute(
        "INSERT INTO session_meta(session_id, pending_kind, pending_since) VALUES(?1, ?2, ?3)
         ON CONFLICT(session_id) DO UPDATE SET pending_kind = excluded.pending_kind,
           pending_since = excluded.pending_since",
        params![id, pending.map(pending_to_str), since],
    )?;
    Ok(())
}

pub fn set_unread(conn: &Connection, id: &str, unread: bool) -> rusqlite::Result<()> {
    let seen = (!unread).then(now);
    conn.execute(
        "INSERT INTO session_meta(session_id, unread, last_seen_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(session_id) DO UPDATE SET unread = excluded.unread,
           last_seen_at = COALESCE(excluded.last_seen_at, session_meta.last_seen_at)",
        params![id, unread as i64, seen],
    )?;
    Ok(())
}

/// Clear pending, stamp `accepted_at`, optionally archive.
pub fn accept(conn: &Connection, id: &str, archive: bool) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_meta(session_id, accepted_at, archived) VALUES(?1, ?2, ?3)
         ON CONFLICT(session_id) DO UPDATE SET pending_kind = NULL, pending_since = NULL,
           accepted_at = excluded.accepted_at, unread = 0,
           archived = MAX(session_meta.archived, excluded.archived)",
        params![id, now(), archive as i64],
    )?;
    Ok(())
}

/// Viewing a session: clear unread + stamp `last_seen_at`; a pending Review
/// (or derived Review status, `review_status`) is accepted like
/// `accept(id, false)`. Returns whether the session was accepted.
pub fn mark_seen(conn: &Connection, id: &str, review_status: bool) -> rusqlite::Result<bool> {
    set_unread(conn, id, false)?;
    let review = review_status || load_meta_row(conn, id).pending == Some(PendingKind::Review);
    if review {
        accept(conn, id, false)?;
    }
    Ok(review)
}

/// Apply a user patch. `workspaceId: ""` clears the explicit override;
/// `customName: ""` clears the custom name.
pub fn apply_patch(conn: &Connection, id: &str, patch: &SessionMetaPatch) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_meta(session_id) VALUES(?1) ON CONFLICT(session_id) DO NOTHING",
        params![id],
    )?;
    if let Some(name) = &patch.custom_name {
        let name = name.trim();
        conn.execute(
            "UPDATE session_meta SET custom_name = ?2 WHERE session_id = ?1",
            params![id, (!name.is_empty()).then_some(name)],
        )?;
    }
    if let Some(p) = patch.pinned {
        conn.execute(
            "UPDATE session_meta SET pinned = ?2 WHERE session_id = ?1",
            params![id, p as i64],
        )?;
    }
    if let Some(a) = patch.archived {
        conn.execute(
            "UPDATE session_meta SET archived = ?2 WHERE session_id = ?1",
            params![id, a as i64],
        )?;
    }
    if let Some(ws) = &patch.workspace_id {
        conn.execute(
            "UPDATE session_meta SET workspace_id = ?2 WHERE session_id = ?1",
            params![id, (!ws.is_empty()).then_some(ws.as_str())],
        )?;
    }
    Ok(())
}

/// Permanently delete a `session_meta` row (file deletion handled by caller).
pub fn delete_row(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM session_meta WHERE session_id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Mark a session app-owned (created, opened or continued by this app).
/// Idempotent; never touches other columns of an existing row.
pub fn mark_created_by_app(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_meta(session_id, created_by_app) VALUES(?1, 1)
         ON CONFLICT(session_id) DO UPDATE SET created_by_app = 1",
        params![id],
    )?;
    Ok(())
}

/// Record a session's space and (pre-validated) group at creation
/// (`StartOpts`). `None` leaves the column untouched, so resume/restart
/// spawns never clobber the stored mode/group.
pub fn set_mode_group(
    conn: &Connection,
    id: &str,
    mode: Option<SpaceMode>,
    group_id: Option<&str>,
) -> rusqlite::Result<()> {
    if mode.is_none() && group_id.is_none() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO session_meta(session_id) VALUES(?1) ON CONFLICT(session_id) DO NOTHING",
        params![id],
    )?;
    if let Some(m) = mode {
        conn.execute(
            "UPDATE session_meta SET mode = ?2 WHERE session_id = ?1",
            params![id, m.as_str()],
        )?;
    }
    if let Some(g) = group_id {
        conn.execute(
            "UPDATE session_meta SET group_id = ?2 WHERE session_id = ?1",
            params![id, g],
        )?;
    }
    Ok(())
}

// ---- workspaces ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceAlias {
    pub old_path: String,
    pub mode: SpaceMode,
    pub workspace_id: String,
}

#[derive(Debug, Clone)]
pub struct RelocateOutcome {
    pub workspace: Workspace,
    pub relocation: WorkspaceRelocation,
    pub migrated_old_paths: Vec<String>,
}

fn kind_from_str(s: &str) -> WorkspaceKind {
    if s == "global" {
        WorkspaceKind::Global
    } else {
        WorkspaceKind::Project
    }
}

fn compute_path_missing(kind: WorkspaceKind, path: &str) -> bool {
    kind == WorkspaceKind::Project && !Path::new(path).is_dir()
}

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |r| r.get(0),
    )
}

fn identity_params(id: Option<DirIdentity>) -> (Option<i64>, Option<i64>) {
    match id {
        Some(d) => (Some(d.dev as i64), Some(d.ino as i64)),
        None => (None, None),
    }
}

fn identity_from_cols(dev: Option<i64>, ino: Option<i64>) -> Option<DirIdentity> {
    match (dev, ino) {
        (Some(d), Some(i)) if d >= 0 && i >= 0 => Some(DirIdentity {
            dev: d as u64,
            ino: i as u64,
        }),
        _ => None,
    }
}

pub fn list_workspaces(conn: &Connection) -> rusqlite::Result<Vec<Workspace>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, name, kind, sort, mode FROM workspaces
         ORDER BY (kind = 'global') DESC, sort, name",
    )?;
    let rows = stmt.query_map([], |r| {
        let path: String = r.get(1)?;
        let kind = kind_from_str(&r.get::<_, String>(3)?);
        let path_missing = compute_path_missing(kind, &path);
        Ok(Workspace {
            id: r.get(0)?,
            path,
            name: r.get(2)?,
            kind,
            sort: r.get(4)?,
            mode: SpaceMode::from_str_lossy(&r.get::<_, String>(5)?),
            path_missing,
        })
    })?;
    rows.collect()
}

pub fn list_workspace_aliases(conn: &Connection) -> rusqlite::Result<Vec<WorkspaceAlias>> {
    if !table_exists(conn, "workspace_aliases")? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare("SELECT old_path, mode, workspace_id FROM workspace_aliases")?;
    let rows = stmt.query_map([], |r| {
        Ok(WorkspaceAlias {
            old_path: r.get(0)?,
            mode: SpaceMode::from_str_lossy(&r.get::<_, String>(1)?),
            workspace_id: r.get(2)?,
        })
    })?;
    rows.collect()
}

/// Normalize a workspace path: trim whitespace and trailing path separators
/// (preserving root `/` and Windows drive roots like `C:\`).
pub fn normalize_path(path: &str) -> String {
    let p = path.trim();
    let b = p.as_bytes();
    if b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        return p.to_string();
    }
    let trimmed = p.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        "/".to_string()
    } else if trimmed.len() == 2 && trimmed.as_bytes()[1] == b':' {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    }
}

fn rewrite_path_column(
    tx: &Connection,
    table: &str,
    id_col: &str,
    path_col: &str,
    old_prefix: &str,
    new_prefix: &str,
    exact_only: bool,
) -> rusqlite::Result<()> {
    if !table_exists(tx, table)? {
        return Ok(());
    }
    let select_sql = format!("SELECT {id_col}, {path_col} FROM {table} WHERE {path_col} IS NOT NULL");
    let mut stmt = tx.prepare(&select_sql)?;
    let updates: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .filter_map(|(row_id, current)| {
            let next = if exact_only {
                (current == old_prefix).then(|| new_prefix.to_string())
            } else {
                fs_id::remap_path_prefix(&current, old_prefix, new_prefix)
            }?;
            (next != current).then_some((row_id, next))
        })
        .collect();
    if updates.is_empty() {
        return Ok(());
    }
    let update_sql = format!("UPDATE {table} SET {path_col} = ?2 WHERE {id_col} = ?1");
    let mut up = tx.prepare(&update_sql)?;
    for (row_id, next) in updates {
        up.execute(params![row_id, next])?;
    }
    Ok(())
}

fn rewrite_project_path_references(
    tx: &Connection,
    old_path: &str,
    new_path: &str,
) -> rusqlite::Result<()> {
    rewrite_path_column(
        tx,
        "session_meta",
        "session_id",
        "cwd_override",
        old_path,
        new_path,
        false,
    )?;
    let other_ws_uses_old: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE path = ?1 AND kind = 'project')",
        params![old_path],
        |r| r.get(0),
    )?;
    if !other_ws_uses_old || !Path::new(old_path).is_dir() {
        rewrite_path_column(tx, "backlog", "id", "project_dir", old_path, new_path, false)?;
        rewrite_path_column(tx, "schedules", "id", "cwd", old_path, new_path, false)?;
        rewrite_path_column(tx, "model_templates", "id", "scope", old_path, new_path, true)?;
        rewrite_path_column(
            tx,
            "model_switch_rules",
            "id",
            "scope",
            old_path,
            new_path,
            true,
        )?;
        rewrite_path_column(
            tx,
            "model_switch_log",
            "id",
            "scope",
            old_path,
            new_path,
            true,
        )?;
    }
    Ok(())
}

/// Relocate an existing project workspace (`id`) to `new_path`, recording its
/// previous path in `workspace_aliases`, merging any duplicate workspace already
/// occupying `(new_path, mode)`, and rewriting app-stored project paths in one
/// SQLite transaction.
pub fn relocate_workspace_tx(
    conn: &Connection,
    id: &str,
    new_path: &str,
) -> Result<RelocateOutcome, String> {
    let new_path = normalize_path(new_path);
    let existing: Option<(String, String, String, i64, String)> = conn
        .query_row(
            "SELECT path, name, kind, sort, mode FROM workspaces WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((old_path, old_name, kind_s, sort, mode_s)) = existing else {
        return Err("工作区不存在".to_string());
    };
    if kind_s == "global" {
        return Err("全局工作区不可重新定位".to_string());
    }
    let mode = SpaceMode::from_str_lossy(&mode_s);
    let new_name = Path::new(&new_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| new_path.clone());
    let dir_id = fs_id::read_dir_identity(Path::new(&new_path));
    let (dev, ino) = identity_params(dir_id);

    if old_path == new_path {
        conn.execute(
            "UPDATE workspaces SET dir_dev = ?2, dir_ino = ?3 WHERE id = ?1",
            params![id, dev, ino],
        )
        .map_err(|e| e.to_string())?;
        let ws = Workspace {
            id: id.to_string(),
            path: new_path.clone(),
            name: old_name.clone(),
            kind: WorkspaceKind::Project,
            sort,
            mode,
            path_missing: compute_path_missing(WorkspaceKind::Project, &new_path),
        };
        return Ok(RelocateOutcome {
            relocation: WorkspaceRelocation {
                workspace_id: ws.id.clone(),
                old_path,
                new_path,
                old_name: old_name.clone(),
                new_name: old_name,
                mode,
            },
            workspace: ws,
            migrated_old_paths: Vec::new(),
        });
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let dup_id: Option<String> = tx
        .query_row(
            "SELECT id FROM workspaces WHERE path = ?1 AND mode = ?2 AND id != ?3",
            params![new_path, mode.as_str(), id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(dup) = dup_id {
        tx.execute(
            "UPDATE session_meta SET workspace_id = ?1 WHERE workspace_id = ?2",
            params![id, dup],
        )
        .map_err(|e| e.to_string())?;
        if table_exists(&tx, "workspace_aliases").map_err(|e| e.to_string())? {
            tx.execute(
                "UPDATE workspace_aliases SET workspace_id = ?1 WHERE workspace_id = ?2",
                params![id, dup],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("DELETE FROM workspaces WHERE id = ?1", params![dup])
            .map_err(|e| e.to_string())?;
    }

    tx.execute(
        "UPDATE workspaces SET path = ?2, name = ?3, dir_dev = ?4, dir_ino = ?5 WHERE id = ?1",
        params![id, new_path, new_name, dev, ino],
    )
    .map_err(|e| e.to_string())?;

    if table_exists(&tx, "workspace_aliases").map_err(|e| e.to_string())? {
        tx.execute(
            "INSERT INTO workspace_aliases(old_path, mode, workspace_id, created_at)
             VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(old_path, mode) DO UPDATE SET workspace_id = excluded.workspace_id",
            params![old_path, mode.as_str(), id, now()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM workspace_aliases WHERE old_path = ?1 AND mode = ?2",
            params![new_path, mode.as_str()],
        )
        .map_err(|e| e.to_string())?;
    }

    rewrite_project_path_references(&tx, &old_path, &new_path).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let ws = Workspace {
        id: id.to_string(),
        path: new_path.clone(),
        name: new_name.clone(),
        kind: WorkspaceKind::Project,
        sort,
        mode,
        path_missing: compute_path_missing(WorkspaceKind::Project, &new_path),
    };
    Ok(RelocateOutcome {
        relocation: WorkspaceRelocation {
            workspace_id: ws.id.clone(),
            old_path: old_path.clone(),
            new_path,
            old_name,
            new_name,
            mode,
        },
        workspace: ws,
        migrated_old_paths: vec![old_path],
    })
}

/// Reconcile workspaces against disk (Layer 1 & Layer 2):
/// - Backfills/refreshes `(dir_dev, dir_ino)` for existing directories.
/// - Auto-relocates missing workspaces when Layer 2 (`/.vol` / parent scan /
///   same-inode duplicate row) finds the moved/renamed directory.
pub fn reconcile_workspaces(conn: &Connection) -> Vec<RelocateOutcome> {
    struct WsRow {
        id: String,
        path: String,
        mode: SpaceMode,
        identity: Option<DirIdentity>,
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, path, mode, dir_dev, dir_ino FROM workspaces WHERE kind = 'project' ORDER BY sort, created_at",
    ) else {
        return Vec::new();
    };
    let rows: Vec<WsRow> = match stmt.query_map([], |r| {
        Ok(WsRow {
            id: r.get(0)?,
            path: r.get(1)?,
            mode: SpaceMode::from_str_lossy(&r.get::<_, String>(2)?),
            identity: identity_from_cols(r.get(3)?, r.get(4)?),
        })
    }) {
        Ok(it) => it.filter_map(Result::ok).collect(),
        Err(_) => return Vec::new(),
    };
    drop(stmt);

    let mut live_by_id: HashMap<(SpaceMode, u64, u64), (String, String)> = HashMap::new();
    let mut missing = Vec::new();
    for row in rows {
        if Path::new(&row.path).is_dir() {
            let actual = fs_id::read_dir_identity(Path::new(&row.path));
            if let Some(id_now) = actual {
                if row.identity != Some(id_now) {
                    let (dev, ino) = identity_params(Some(id_now));
                    let _ = conn.execute(
                        "UPDATE workspaces SET dir_dev = ?2, dir_ino = ?3 WHERE id = ?1",
                        params![row.id, dev, ino],
                    );
                }
                live_by_id
                    .entry((row.mode, id_now.dev, id_now.ino))
                    .or_insert((row.id, row.path));
            }
        } else {
            missing.push(row);
        }
    }

    let mut outcomes = Vec::new();
    for row in missing {
        let Some(stored) = row.identity else {
            continue;
        };
        let target = if let Some((dup_id, dup_path)) =
            live_by_id.get(&(row.mode, stored.dev, stored.ino))
        {
            if dup_id == &row.id {
                continue;
            }
            Some(Path::new(dup_path).to_path_buf())
        } else {
            fs_id::resolve_moved_dir(Path::new(&row.path), stored)
        };
        let Some(new_path) = target else {
            continue;
        };
        let new_str = new_path.to_string_lossy().into_owned();
        if let Ok(outcome) = relocate_workspace_tx(conn, &row.id, &new_str) {
            live_by_id.insert(
                (row.mode, stored.dev, stored.ino),
                (row.id.clone(), outcome.workspace.path.clone()),
            );
            outcomes.push(outcome);
        }
    }
    outcomes
}

/// Add a project workspace to `mode` while automatically linking/relocating a
/// missing workspace with the same filesystem directory identity (Layer 2).
pub fn add_workspace_with_reconcile(
    conn: &Connection,
    path: &str,
    mode: SpaceMode,
) -> rusqlite::Result<(Workspace, Option<RelocateOutcome>)> {
    let path = normalize_path(path);
    let incoming_id = fs_id::read_dir_identity(Path::new(&path));
    if let Some(ws) = list_workspaces(conn)?
        .into_iter()
        .find(|w| w.path == path && w.mode == mode)
    {
        if let Some(id_now) = incoming_id {
            let (dev, ino) = identity_params(Some(id_now));
            let _ = conn.execute(
                "UPDATE workspaces SET dir_dev = ?2, dir_ino = ?3 WHERE id = ?1",
                params![ws.id, dev, ino],
            );
        }
        return Ok((ws, None));
    }

    // Layer 2: check if a missing workspace in this mode has the exact same dir inode.
    if let Some(id_now) = incoming_id {
        let mut stmt = conn.prepare(
            "SELECT id, path FROM workspaces WHERE kind = 'project' AND mode = ?1 AND dir_dev = ?2 AND dir_ino = ?3 ORDER BY sort, created_at",
        )?;
        let (dev, ino) = identity_params(Some(id_now));
        let candidate: Option<String> = stmt
            .query_map(params![mode.as_str(), dev, ino], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .filter_map(Result::ok)
            .find(|(_, old_p)| !Path::new(old_p).is_dir())
            .map(|(id, _)| id);
        drop(stmt);
        if let Some(missing_id) = candidate {
            if let Ok(outcome) = relocate_workspace_tx(conn, &missing_id, &path) {
                return Ok((outcome.workspace.clone(), Some(outcome)));
            }
        }
    }

    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let sort: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort), 0) + 1 FROM workspaces WHERE mode = ?1",
        params![mode.as_str()],
        |r| r.get(0),
    )?;
    let (dev, ino) = identity_params(incoming_id);
    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        path: path.clone(),
        name,
        kind: WorkspaceKind::Project,
        sort,
        mode,
        path_missing: compute_path_missing(WorkspaceKind::Project, &path),
    };
    conn.execute(
        "INSERT INTO workspaces(id, path, name, kind, sort, mode, dir_dev, dir_ino, created_at)
		 VALUES(?1, ?2, ?3, 'project', ?4, ?5, ?6, ?7, ?8)",
        params![ws.id, ws.path, ws.name, ws.sort, mode.as_str(), dev, ino, now()],
    )?;
    if table_exists(conn, "workspace_aliases")? {
        conn.execute(
            "DELETE FROM workspace_aliases WHERE old_path = ?1 AND mode = ?2",
            params![ws.path, mode.as_str()],
        )?;
    }
    Ok((ws, None))
}

/// Add a project workspace to `mode`. The same disk directory may exist in
/// several modes (unique on (path, mode)); re-adding the same (path, mode)
/// returns the existing row.
#[cfg(test)]
pub fn add_workspace(
    conn: &Connection,
    path: &str,
    mode: SpaceMode,
) -> rusqlite::Result<Workspace> {
    add_workspace_with_reconcile(conn, path, mode).map(|(ws, _)| ws)
}

/// Remove a project workspace (the Global row cannot be removed).
pub fn remove_workspace(conn: &Connection, id: &str) -> Result<(), String> {
    let kind: Option<String> = conn
        .query_row(
            "SELECT kind FROM workspaces WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match kind.as_deref() {
        None => return Err("工作区不存在".to_string()),
        Some("global") => return Err("全局工作区不可移除".to_string()),
        _ => {}
    }
    conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if table_exists(conn, "workspace_aliases").map_err(|e| e.to_string())? {
        conn.execute(
            "DELETE FROM workspace_aliases WHERE workspace_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "UPDATE session_meta SET workspace_id = NULL WHERE workspace_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn reorder_workspaces(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE workspaces SET sort = ?2 WHERE id = ?1 AND kind != 'global'",
            params![id, i as i64],
        )?;
    }
    Ok(())
}

// ---- session groups (per-mode 无项目 categories) ----

pub fn list_session_groups(conn: &Connection) -> rusqlite::Result<Vec<SessionGroup>> {
    let mut stmt =
        conn.prepare("SELECT id, mode, name, sort FROM session_groups ORDER BY mode, sort, name")?;
    let rows = stmt.query_map([], |r| {
        Ok(SessionGroup {
            id: r.get(0)?,
            mode: SpaceMode::from_str_lossy(&r.get::<_, String>(1)?),
            name: r.get(2)?,
            sort: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn get_session_group(conn: &Connection, id: &str) -> rusqlite::Result<Option<SessionGroup>> {
    conn.query_row(
        "SELECT id, mode, name, sort FROM session_groups WHERE id = ?1",
        params![id],
        |r| {
            Ok(SessionGroup {
                id: r.get(0)?,
                mode: SpaceMode::from_str_lossy(&r.get::<_, String>(1)?),
                name: r.get(2)?,
                sort: r.get(3)?,
            })
        },
    )
    .optional()
}

pub fn create_session_group(
    conn: &Connection,
    mode: SpaceMode,
    name: &str,
) -> Result<SessionGroup, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("分组名不能为空".to_string());
    }
    let sort: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort), 0) + 1 FROM session_groups WHERE mode = ?1",
            params![mode.as_str()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let group = SessionGroup {
        id: uuid::Uuid::new_v4().to_string(),
        mode,
        name: name.to_string(),
        sort,
    };
    conn.execute(
        "INSERT INTO session_groups(id, mode, name, sort, created_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![group.id, mode.as_str(), group.name, group.sort, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(group)
}

pub fn rename_session_group(
    conn: &Connection,
    id: &str,
    name: &str,
) -> Result<SessionGroup, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("分组名不能为空".to_string());
    }
    let changed = conn
        .execute(
            "UPDATE session_groups SET name = ?2 WHERE id = ?1",
            params![id, name],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("分组不存在".to_string());
    }
    get_session_group(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "分组不存在".to_string())
}

/// Delete a group; its sessions become ungrouped (never deleted).
pub fn delete_session_group(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM session_groups WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("分组不存在".to_string());
    }
    conn.execute(
        "UPDATE session_meta SET group_id = NULL WHERE group_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn reorder_session_groups(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE session_groups SET sort = ?2 WHERE id = ?1",
            params![id, i as i64],
        )?;
    }
    Ok(())
}

/// Assign (`Some`) or unassign (`None`) a session's group. Group existence,
/// mode match and global-workspace membership are validated by the caller.
pub fn set_session_group(
    conn: &Connection,
    session_id: &str,
    group_id: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_meta(session_id, group_id) VALUES(?1, ?2)
		 ON CONFLICT(session_id) DO UPDATE SET group_id = excluded.group_id",
        params![session_id, group_id],
    )?;
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// The §6 tables catalog uses (db.rs keeps its migration private).
    /// Mirrors the post-v10 schema.
    pub fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workspaces(id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'code', dir_dev INTEGER, dir_ino INTEGER, created_at TEXT NOT NULL, UNIQUE(path, mode));
             CREATE TABLE workspace_aliases(old_path TEXT NOT NULL, mode TEXT NOT NULL, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(old_path, mode));
             CREATE TABLE session_meta(
               session_id TEXT PRIMARY KEY, file_path TEXT, custom_name TEXT, label TEXT,
               pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
               parent_session_id TEXT, fork_depth INTEGER NOT NULL DEFAULT 0,
               workspace_id TEXT, unread INTEGER NOT NULL DEFAULT 0, pending_kind TEXT, pending_since TEXT,
               accepted_at TEXT, last_seen_at TEXT, suspended INTEGER NOT NULL DEFAULT 0, created_by_app INTEGER NOT NULL DEFAULT 0,
               seq INTEGER, cwd_override TEXT, mode TEXT NOT NULL DEFAULT 'code', group_id TEXT, kind TEXT);
             CREATE TABLE session_groups(
               id TEXT PRIMARY KEY, mode TEXT NOT NULL, name TEXT NOT NULL,
               sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
             INSERT INTO workspaces(id, path, name, kind, sort, mode, created_at) VALUES('global', '/g', '🌐 全局', 'global', -1, 'code', 'now');
             INSERT INTO workspaces(id, path, name, kind, sort, mode, created_at) VALUES('global:work', '/g-work', '🌐 全局', 'global', -1, 'work', 'now');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn mark_seen_accepts_review() {
        let c = test_conn();
        set_pending(&c, "s1", Some(PendingKind::Review)).unwrap();
        set_unread(&c, "s1", true).unwrap();
        assert!(mark_seen(&c, "s1", false).unwrap());
        let r = load_meta_row(&c, "s1");
        assert_eq!((r.pending, r.unread), (None, false));
        assert!(r.accepted_at.is_some() && r.last_seen_at.is_some());
        assert!(!r.archived);
        // Non-review: only unread cleared, pending kept.
        set_pending(&c, "s2", Some(PendingKind::Error)).unwrap();
        set_unread(&c, "s2", true).unwrap();
        assert!(!mark_seen(&c, "s2", false).unwrap());
        let r = load_meta_row(&c, "s2");
        assert_eq!((r.pending, r.unread), (Some(PendingKind::Error), false));
        assert!(r.accepted_at.is_none());
    }

    #[test]
    fn cwd_override_roundtrip() {
        let c = test_conn();
        ensure_row(&c, "s1", "/f1").unwrap();
        assert_eq!(load_meta_row(&c, "s1").cwd_override, None);
        set_cwd_override(&c, "s1", Some("/repo")).unwrap();
        assert_eq!(
            load_meta_row(&c, "s1").cwd_override.as_deref(),
            Some("/repo")
        );
        set_cwd_override(&c, "s1", None).unwrap();
        assert_eq!(load_meta_row(&c, "s1").cwd_override, None);
        // Upsert on a missing row creates it.
        set_cwd_override(&c, "s2", Some("/main")).unwrap();
        assert_eq!(
            load_meta_row(&c, "s2").cwd_override.as_deref(),
            Some("/main")
        );
    }
    #[test]
    fn meta_roundtrip_and_patch() {
        let c = test_conn();
        ensure_row(&c, "s1", "/f1").unwrap();
        assert_eq!(assign_seq(&c, "s1").unwrap(), 1);
        assert_eq!(assign_seq(&c, "s1").unwrap(), 1);
        ensure_row(&c, "s2", "/f2").unwrap();
        assert_eq!(assign_seq(&c, "s2").unwrap(), 2);
        apply_patch(
            &c,
            "s1",
            &SessionMetaPatch {
                custom_name: Some(" 名字 ".into()),
                pinned: Some(true),
                archived: None,
                workspace_id: Some("w1".into()),
            },
        )
        .unwrap();
        set_pending(&c, "s1", Some(PendingKind::Review)).unwrap();
        set_unread(&c, "s1", true).unwrap();
        let row = load_meta_row(&c, "s1");
        assert_eq!(row.custom_name.as_deref(), Some("名字"));
        assert!(row.pinned && row.unread);
        assert_eq!(row.workspace_id.as_deref(), Some("w1"));
        assert_eq!(row.pending, Some(PendingKind::Review));
        accept(&c, "s1", true).unwrap();
        let row = load_meta_row(&c, "s1");
        assert!(row.pending.is_none() && row.archived && !row.unread && row.accepted_at.is_some());
        apply_patch(
            &c,
            "s1",
            &SessionMetaPatch {
                workspace_id: Some(String::new()),
                custom_name: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
        let row = load_meta_row(&c, "s1");
        assert!(row.workspace_id.is_none() && row.custom_name.is_none());
    }

    #[test]
    fn workspaces_crud() {
        let c = test_conn();
        let a = add_workspace(&c, "/repo/a/", SpaceMode::Code).unwrap();
        assert_eq!((a.path.as_str(), a.name.as_str()), ("/repo/a", "a"));
        assert_eq!(
            add_workspace(&c, "/repo/a", SpaceMode::Code).unwrap().id,
            a.id
        );
        let b = add_workspace(&c, "/repo/b", SpaceMode::Code).unwrap();
        reorder_workspaces(&c, &[b.id.clone(), a.id.clone()]).unwrap();
        let list = list_workspaces(&c).unwrap();
        let ids: Vec<_> = list.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["global", "global:work", b.id.as_str(), a.id.as_str()]
        );
        assert!(remove_workspace(&c, "global").is_err());
        apply_patch(
            &c,
            "s",
            &SessionMetaPatch {
                workspace_id: Some(a.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        remove_workspace(&c, &a.id).unwrap();
        assert!(load_meta_row(&c, "s").workspace_id.is_none());
        assert_eq!(list_workspaces(&c).unwrap().len(), 3);
    }

    /// The same disk directory may be a project in several modes; each mode
    /// gets its own workspace row and its own global row.
    #[test]
    fn same_path_in_two_modes() {
        let c = test_conn();
        let a = add_workspace(&c, "/repo/a", SpaceMode::Code).unwrap();
        let w = add_workspace(&c, "/repo/a", SpaceMode::Work).unwrap();
        assert_ne!(a.id, w.id);
        assert_eq!(w.mode, SpaceMode::Work);
        // Re-adding in either mode returns that mode's existing row.
        assert_eq!(
            add_workspace(&c, "/repo/a", SpaceMode::Code).unwrap().id,
            a.id
        );
        assert_eq!(
            add_workspace(&c, "/repo/a", SpaceMode::Work).unwrap().id,
            w.id
        );
    }

    /// Group CRUD + ungroup-on-delete; cross-mode assignment is rejected at
    /// the command layer but `set_session_group` round-trips the column.
    #[test]
    fn session_groups_crud() {
        let c = test_conn();
        let g = create_session_group(&c, SpaceMode::Work, " 清理电脑 ").unwrap();
        assert_eq!((g.mode, g.name.as_str()), (SpaceMode::Work, "清理电脑"));
        assert!(create_session_group(&c, SpaceMode::Work, "  ").is_err());
        let g2 = create_session_group(&c, SpaceMode::Work, "通用").unwrap();
        let g_code = create_session_group(&c, SpaceMode::Code, "code-g").unwrap();
        let renamed = rename_session_group(&c, &g.id, "改名").unwrap();
        assert_eq!(renamed.name, "改名");
        // sort is per-mode: work groups got 1,2; code group starts at 1.
        assert_eq!(g_code.sort, 1);
        reorder_session_groups(&c, &[g2.id.clone(), g.id.clone()]).unwrap();
        let list = list_session_groups(&c).unwrap();
        let work_ids: Vec<_> = list
            .iter()
            .filter(|x| x.mode == SpaceMode::Work)
            .map(|x| x.id.as_str())
            .collect();
        assert_eq!(work_ids, vec![g2.id.as_str(), g.id.as_str()]);
        // Assign then ungroup-on-delete.
        set_session_group(&c, "s1", Some(&g.id)).unwrap();
        assert_eq!(
            load_meta_row(&c, "s1").group_id.as_deref(),
            Some(g.id.as_str())
        );
        set_mode_group(&c, "s1", Some(SpaceMode::Work), None).unwrap();
        assert_eq!(load_meta_row(&c, "s1").mode, SpaceMode::Work);
        delete_session_group(&c, &g.id).unwrap();
        assert!(load_meta_row(&c, "s1").group_id.is_none());
        // The row's stored mode survives the ungroup.
        assert_eq!(load_meta_row(&c, "s1").mode, SpaceMode::Work);
        assert!(delete_session_group(&c, &g.id).is_err());
        // Ungroup path: Some -> None.
        set_session_group(&c, "s1", Some(&g2.id)).unwrap();
        set_session_group(&c, "s1", None).unwrap();
        assert!(load_meta_row(&c, "s1").group_id.is_none());
    }

    /// set_mode_group: None leaves columns untouched (resume spawns), Some wins.
    #[test]
    fn set_mode_group_upsert_semantics() {
        let c = test_conn();
        set_mode_group(&c, "s1", Some(SpaceMode::Study), Some("g1")).unwrap();
        let row = load_meta_row(&c, "s1");
        assert_eq!(row.mode, SpaceMode::Study);
        assert_eq!(row.group_id.as_deref(), Some("g1"));
        // Resume-style call: no mode/group -> untouched.
        set_mode_group(&c, "s1", None, None).unwrap();
        let row = load_meta_row(&c, "s1");
        assert_eq!(row.mode, SpaceMode::Study);
        assert_eq!(row.group_id.as_deref(), Some("g1"));
        // Fresh row without args defaults to code.
        set_mode_group(&c, "s2", None, None).unwrap();
        assert_eq!(load_meta_row(&c, "s2").mode, SpaceMode::Code);
    }

    /// Legacy session without any session_meta row reads as code.
    #[test]
    fn missing_row_defaults_to_code() {
        let c = test_conn();
        let row = load_meta_row(&c, "ghost");
        assert_eq!(row.mode, SpaceMode::Code);
        assert_eq!(row.group_id, None);
    }

    #[test]
    fn reconcile_tracks_rename_and_merges_duplicate() {
        let base = std::env::temp_dir().join(format!("vecway-ws-reloc-{}", uuid::Uuid::new_v4()));
        let old_dir = base.join("omp-workspace");
        let new_dir = base.join("Vecway");
        std::fs::create_dir_all(&old_dir).unwrap();

        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        let ws = add_workspace(&c, &old_dir.to_string_lossy(), SpaceMode::Code).unwrap();
        assert!(!ws.path_missing);

        c.execute(
            "INSERT INTO backlog(id, text, kind, status, created_at, updated_at, project_dir)
             VALUES('b1', 'idea', 'idea', 'open', 'now', 'now', ?1)",
            [old_dir.to_string_lossy().as_ref()],
        )
        .unwrap();
        c.execute(
            "INSERT INTO schedules(id, name, prompt, cwd, run_mode, cadence, created_at, updated_at, mode)
             VALUES('sch1', 's', 'p', ?1, 'local', '{}', 'now', 'now', 'code')",
            [format!("{}/.worktrees/feat", old_dir.to_string_lossy())],
        )
        .unwrap();
        c.execute(
            "INSERT INTO model_templates(id, name, roles, created_at, updated_at, scope)
             VALUES('t1', 'T', '{}', 'now', 'now', ?1)",
            [old_dir.to_string_lossy().as_ref()],
        )
        .unwrap();

        // Rename on disk; Layer 2 reconcile_workspaces detects via inode and updates everything.
        std::fs::rename(&old_dir, &new_dir).unwrap();
        let outcomes = reconcile_workspaces(&c);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].workspace.id, ws.id);
        assert_eq!(outcomes[0].workspace.name, "Vecway");
        assert_eq!(
            outcomes[0].workspace.path,
            new_dir.to_string_lossy().as_ref()
        );
        let aliases = list_workspace_aliases(&c).unwrap();
        assert_eq!(aliases.len(), 1);
        assert_eq!(aliases[0].old_path, old_dir.to_string_lossy().as_ref());
        assert_eq!(aliases[0].workspace_id, ws.id);

        let b_dir: String = c
            .query_row("SELECT project_dir FROM backlog WHERE id='b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(b_dir, new_dir.to_string_lossy().as_ref());
        let s_cwd: String = c
            .query_row("SELECT cwd FROM schedules WHERE id='sch1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            s_cwd,
            format!("{}/.worktrees/feat", new_dir.to_string_lossy())
        );
        let t_scope: String = c
            .query_row("SELECT scope FROM model_templates WHERE id='t1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(t_scope, new_dir.to_string_lossy().as_ref());

        // Rename again and simulate user adding new folder manually before reconcile runs.
        let newer_dir = base.join("Vecway-2");
        std::fs::rename(&new_dir, &newer_dir).unwrap();
        let (relinked, reloc) =
            add_workspace_with_reconcile(&c, &newer_dir.to_string_lossy(), SpaceMode::Code)
                .unwrap();
        assert!(reloc.is_some());
        assert_eq!(relinked.id, ws.id);
        assert_eq!(relinked.name, "Vecway-2");
        // Both prior paths remain aliases of the single preserved workspace id.
        let all_aliases = list_workspace_aliases(&c).unwrap();
        assert_eq!(all_aliases.len(), 2);

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn relocate_workspace_merges_duplicate_and_rewrites_cwd_override() {
        let base = std::env::temp_dir().join(format!("vecway-ws-merge-{}", uuid::Uuid::new_v4()));
        let old_dir = base.join("old-name");
        let new_dir = base.join("new-name");
        std::fs::create_dir_all(&new_dir).unwrap();

        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        let old_ws = add_workspace(&c, &old_dir.to_string_lossy(), SpaceMode::Code).unwrap();
        let dup_ws = add_workspace(&c, &new_dir.to_string_lossy(), SpaceMode::Code).unwrap();
        assert!(old_ws.path_missing);
        assert!(!dup_ws.path_missing);

        apply_patch(
            &c,
            "s-old",
            &SessionMetaPatch {
                workspace_id: Some(old_ws.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        set_cwd_override(&c, "s-old", Some(&old_dir.to_string_lossy())).unwrap();
        apply_patch(
            &c,
            "s-dup",
            &SessionMetaPatch {
                workspace_id: Some(dup_ws.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();

        let outcome = relocate_workspace_tx(&c, &old_ws.id, &new_dir.to_string_lossy()).unwrap();
        assert_eq!(outcome.workspace.id, old_ws.id);
        assert_eq!(outcome.workspace.sort, old_ws.sort);
        assert!(!outcome.workspace.path_missing);
        let list = list_workspaces(&c)
            .unwrap()
            .into_iter()
            .filter(|w| w.kind == WorkspaceKind::Project)
            .collect::<Vec<_>>();
        assert_eq!(list.len(), 1);
        assert_eq!(load_meta_row(&c, "s-dup").workspace_id.as_deref(), Some(old_ws.id.as_str()));
        assert_eq!(
            load_meta_row(&c, "s-old").cwd_override.as_deref(),
            Some(new_dir.to_string_lossy().as_ref())
        );

        std::fs::remove_dir_all(&base).unwrap();
    }
}

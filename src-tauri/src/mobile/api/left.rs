//! Mobile API: left-drawer pages (sessions tree, inbox, search, schedules,
//! skills, settings summary). JSON is camelCase; errors are `{ "error": ".." }`.
//! Mirrors the desktop sidebar (`features/sessions/grouping.ts`), inbox
//! (`features/inbox/attention.ts`), schedules and skills pages, reusing the
//! existing backend modules (`catalog`, `schedules`, `skills`, `settings`).
//!
//! ## Routes
//! Sessions
//! - `GET /left/sessions?mode=code|work|study|research|chat` (default `code`) →
//!   `SessionTree`: `{mode, pinned: SessionMeta[], globalGroup: WorkspaceGroup|null,
//!   workspaceGroups: WorkspaceGroup[], unassignedGroups: {key,cwd,label,sessions}[],
//!   deletedSessions: SessionMeta[], archived: SessionMeta[], sessionGroups:
//!   SessionGroup[], totalVisible}`. `WorkspaceGroup` = `{workspace, isGlobal,
//!   subgroups, deletedSubgroups, totalCount, pinnedCount}`; a subgroup is
//!   `{key, kind: "worktree"|"branch"|"default", label, deleted, isMain, path?,
//!   createCwd?, sessions, totalCount}` — same bucketing as desktop (live git
//!   worktrees incl. empty ones, then badge/branch buckets; sessions of deleted
//!   worktrees land in `deletedSubgroups`). Pinned sessions are listed only in
//!   `pinned`, not repeated inside groups. Zero-message side chats are hidden;
//!   archive cascades to child side chats (unless live/pinned/pending/working).
//! - `GET /left/dirs` → `{dirs: [{path, label, kind: "workspace"|"worktree"|"global",
//!   workspaceId, mode}], homeDir: string|null}` — allowed directories plus the actual server home.
//! - `POST /left/sessions` `{cwd}` → `LiveSessionInfo` `{sessionId, sessionFile, pid, cwd}`.
//!   `cwd` must be inside a registered workspace/worktree (or the global dir);
//!   mode is derived (`chat` for the global dir, else the workspace's mode).
//! - `PATCH /left/sessions/{id}` `{customName?, pinned?, archived?, workspaceId?}` → `SessionMeta`
//!   (`customName: ""` clears the name; 404 unknown id). `workspaceId` = 归入工作区: a registered
//!   non-global workspace id of the session's own space, or `""` to restore automatic assignment.
//! - `POST /left/workspaces` `{path}` → `Workspace` (添加为工作区). `path` must be the cwd of an
//!   existing session (so the phone cannot register arbitrary directories); the space is that session's.
//!
//! Inbox
//! - `GET /left/inbox` → `{windowHours, badge, order: ["awaiting","error","unread","running"],
//!   awaiting, error, unread, running: SessionMeta[]}` (window rules of `groupInbox`).
//! - `POST /left/inbox/{id}/seen` → `{ok: true}` (mark seen; 404 unknown id).
//! - `POST /left/inbox/{id}/unread` `{unread: bool}` → `{ok: true, unread}`. Persists the
//!   requested flag; false has the same review-acceptance semantics as `seen`. Unknown id is 404;
//!   marking a process-free draft unread is 400 because it has no transcript.
//! - `POST /left/inbox/read-all` → `{ok: true, count}` (marks every listed unread/error session seen).
//!
//! Search
//! - `GET /left/search?q=&mode=&archived=0|1` → `{sessions: SessionMeta[] (≤100),
//!   branches: [{branch, workspaceId, count, sessionIds (≤5 newest)}]}`. AND-token match over
//!   title/label/branch/worktree/model/last answer/cwd (relative to its workspace);
//!   `mode` omitted = all spaces; archived hidden unless `archived=1`. Blank `q` → empty.
//!
//! Schedules (cwd confined to `GET /left/dirs`; 404 on unknown schedule id)
//! - `GET /left/schedules` → `Schedule[]`.
//! - `POST /left/schedules` `ScheduleDraft` (id ignored) → `Schedule`.
//! - `PUT /left/schedules/{id}` `ScheduleDraft` → `Schedule`.
//! - `DELETE /left/schedules/{id}` → `{ok: true}`.
//! - `POST /left/schedules/{id}/enabled` `{enabled}` → `Schedule`.
//! - `POST /left/schedules/{id}/run` → `ScheduleRun` (run now; the UI must confirm first).
//! - `GET /left/schedules/{id}/runs?limit=20` → `ScheduleRun[]`.
//! - `POST /left/schedules/{id}/runs/{run_id}/release-awaiting` explicitly releases a paused run.
//! - `GET /left/schedules/{id}/awaiting` → unresolved paused runs.
//! - `POST /left/schedules/{id}/runs/{run_id}/resume-awaiting` starts a correlated continuation.
//!
//! Skills
//! - `GET /left/skills?cwd=` → `{skills: (SkillItem + {enabled, disabledReason: null|{kind,..}})[],
//!   extensions: ExtensionItem[], skillsEnabled, configError: string|null}`; `cwd` (optional,
//!   must be in `/left/dirs`) adds that project's skills.
//! - `GET /left/skills/content?path=<SkillItem.path>&cwd=` → `{text}` (SKILL.md, ≤256KiB; 404 unless
//!   `path` is a catalog skill's path; pass the same `cwd` as the list for project skills).
//! - `POST /left/skills/toggle` `{name, enabled, cwd?}` → `{ok: true}` (404 unknown skill;
//!   writes `disabledExtensions` `skill:<name>` like desktop; effective for new sessions).
//! - `POST /left/extensions/toggle` `{path, enabled, cwd?}` → `{ok: true}` (404 unknown extension).
//!
//! Settings (editable subset of the global OMP config + read-only status)
//! - `GET /left/settings` → `{appVersion, mobile: {running, port, lanUrl, tunnelUrl,
//!   ipv6Running, ipv6Url}, defaultModel: string|null, defaultModelSource:
//!   "modelRoles.default"|"newSessionModel"|null, omp: {<key>: value|null}, ompError: string|null}`.
//!   `omp` holds current values of the allowlisted keys (`MOBILE_SETTINGS`: defaultThinkingLevel,
//!   hideThinkingBlock, steeringMode, followUpMode, interruptMode, ask.enabled, ask.timeout,
//!   ask.notify, bash.autoBackground.enabled, tools.maxTimeout, compaction.enabled,
//!   compaction.autoContinue, retry.enabled, retry.maxRetries, retry.maxDelayMs,
//!   retry.waitForUsageReset); `ompError` is set (and `omp` empty) when omp config is unreadable.
//!   Also `defaultApprovalMode` (`always-ask|write|yolo`) and `capsuleVisible` (desktop settings).
//! - `GET /left/settings/desktop` → `{defaultApprovalMode, capsuleVisible}`.
//! - `POST /left/settings/approval-mode` `{mode: "always-ask"|"write"|"yolo"}` → `{ok,
//!   defaultApprovalMode, capsuleVisible}`; anything else → 400. Applies to sessions started later.
//! - `POST /left/settings/set` `{key, value}` → `{ok, key, value}` (value = fresh value). Strict
//!   allowlist + type/enum/range validation; anything else → 400. Writes via `omp config set`
//!   (global config), behind the normal mobile auth. Mobile service enable/disable stays
//!   desktop-only (turning it off from the phone would cut the session).
//!
//! ## Intentionally not mirrored from desktop
//! Session delete/fork/takeover, workspace add/remove/reorder, chat session-group CRUD (groups
//! are returned read-only), drag ordering/frozen order, archive "clean worktree" flow and the busy-
//! archive confirmation (UI must confirm), skill trash/read/usage stats and per-source
//! toggles, schedule run-detail/transcripts.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager as _;

use crate::catalog::store;
use crate::contracts::{
    Attention, ScheduleDraft, SessionGroup, SessionMeta, SessionMetaPatch, SessionStatus,
    SpaceMode, Workspace, WorkspaceKind,
};
use crate::mobile::backend::Backend;
use crate::mobile::server::{ApiError, Ctx};
use crate::schedules::{runner, store as sched_store};
use crate::state::AppState;

type ApiResult<T> = Result<Json<T>, ApiError>;

pub fn routes<B: Backend>() -> Router<Arc<Ctx<B>>> {
    Router::new()
        .route(
            "/left/sessions",
            get(session_tree::<B>).post(new_session::<B>),
        )
        .route("/left/dirs", get(list_dirs::<B>))
        .route("/left/drafts/{id}/discard", post(discard_draft::<B>))
        .route("/left/sessions/{id}", patch(patch_session::<B>))
        .route("/left/inbox", get(inbox::<B>))
        .route("/left/inbox/read-all", post(inbox_read_all::<B>))
        .route("/left/inbox/{id}/seen", post(inbox_seen::<B>))
        .route("/left/inbox/{id}/unread", post(inbox_unread::<B>))
        .route("/left/search", get(search::<B>))
        .route(
            "/left/schedules",
            get(schedules_list::<B>).post(schedules_create::<B>),
        )
        .route("/left/schedules/probe-test", post(schedules_probe_test::<B>))
        .route(
            "/left/schedules/generate-draft",
            post(schedules_generate_draft::<B>),
        )
        .route(
            "/left/schedules/{id}",
            axum::routing::put(schedules_update::<B>).delete(schedules_delete::<B>),
        )
        .route("/left/schedules/{id}/enabled", post(schedules_enabled::<B>))
        .route("/left/schedules/{id}/run", post(schedules_run::<B>))
        .route("/left/schedules/{id}/runs", get(schedules_runs::<B>))
        .route(
            "/left/schedules/{id}/worktree",
            get(schedules_worktree::<B>),
        )
        .route(
            "/left/schedules/{id}/worktree/merge",
            post(schedules_worktree_merge::<B>),
        )
        .route(
            "/left/schedules/{id}/worktree/discard",
            post(schedules_worktree_discard::<B>),
        )
        .route(
            "/left/schedules/{id}/runs/{run_id}/release-awaiting",
            post(schedules_release_awaiting::<B>),
        )
        .route(
            "/left/schedules/{id}/awaiting",
            get(schedules_awaiting::<B>),
        )
        .route(
            "/left/schedules/{id}/runs/{run_id}/resume-awaiting",
            post(schedules_resume_awaiting::<B>),
        )
        .route("/left/skills", get(skills_list::<B>))
        .route("/left/skills/content", get(skill_content::<B>))
        .route("/left/skills/toggle", post(skill_toggle::<B>))
        .route("/left/extensions/toggle", post(extension_toggle::<B>))
        .route("/left/settings", get(settings_summary::<B>))
        .route("/left/settings/set", post(setting_set::<B>))
        .route("/left/settings/desktop", get(desktop_settings::<B>))
        .route("/left/settings/approval-mode", post(approval_mode_set::<B>))
        .route("/left/settings/automation", post(automation_settings_set::<B>))
        .route("/left/roles", get(roles_get::<B>))
        .route("/left/roles/set", post(roles_set::<B>))
        .route("/left/providers", get(providers_get::<B>))
        .route("/left/providers/save", post(providers_save::<B>))
        .route("/left/providers/test", post(providers_test::<B>))
        .route("/left/fallbacks", get(fallbacks_get::<B>))
        .route("/left/fallbacks/set", post(fallbacks_set::<B>))
        .route("/left/context-windows", get(context_windows_get::<B>))
        .route("/left/context-windows/set", post(context_windows_set::<B>))
        .route("/left/workspaces", post(add_workspace::<B>))
}

// ---------- errors / helpers ----------

fn bad_request(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}
fn conflict(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::CONFLICT, msg.into())
}
fn not_found(msg: &str) -> ApiError {
    ApiError(StatusCode::NOT_FOUND, msg.to_string())
}
fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}
fn bad_gateway(e: String) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, e)
}

fn app<B: Backend>(ctx: &Ctx<B>) -> Result<&AppState, ApiError> {
    ctx.backend.app_state().ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "app state unavailable".into(),
        )
    })
}

fn ok_json() -> Json<Value> {
    Json(json!({ "ok": true }))
}

// ---------- path / time helpers (pure) ----------

/// Strip trailing slashes and the macOS `/private` prefix so `/private/var/x`
/// and `/var/x` compare equal.
fn norm_path(p: &str) -> String {
    let clean = p.trim_end_matches('/');
    match clean.strip_prefix("/private/") {
        Some(rest) => format!("/{rest}"),
        None => clean.to_string(),
    }
}

/// `child` equals `parent` or lies below it (component-wise, `/` separated).
fn is_inside(child: &str, parent: &str) -> bool {
    let (c, p) = (child.trim_end_matches('/'), parent.trim_end_matches('/'));
    if p.is_empty() {
        return false;
    }
    c == p || c.strip_prefix(p).is_some_and(|rest| rest.starts_with('/'))
}

fn is_inside_canon(child: &str, parent: &str) -> bool {
    is_inside(child, parent) || is_inside(&norm_path(child), &norm_path(parent))
}

fn basename(p: &str) -> String {
    p.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Worktree name from a cwd laid out as `<repo>/.worktrees/<n>` or
/// `<repo>/.cache/wt-<n>` (used when git metadata is gone).
fn infer_worktree_name(cwd: &str) -> Option<String> {
    let parts: Vec<&str> = cwd.split(['/', '\\']).collect();
    for (i, seg) in parts.iter().enumerate() {
        let Some(next) = parts.get(i + 1).filter(|n| !n.is_empty()) else {
            continue;
        };
        if *seg == ".worktrees" || (*seg == ".cache" && next.starts_with("wt-")) {
            return Some((*next).to_string());
        }
    }
    None
}

fn parse_ts(s: &str) -> i64 {
    DateTime::parse_from_rfc3339(s)
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

fn session_ts(s: &SessionMeta) -> i64 {
    parse_ts(if s.updated_at.is_empty() {
        &s.created_at
    } else {
        &s.updated_at
    })
}

fn sort_recent(list: &mut [SessionMeta]) {
    if list.len() <= 1 {
        return;
    }
    // Pre-parse each RFC3339 timestamp once instead of inside every comparator call.
    let mut order: Vec<(i64, usize)> = list
        .iter()
        .enumerate()
        .map(|(idx, s)| (session_ts(s), idx))
        .collect();
    order.sort_by(|&(ta, ia), &(tb, ib)| tb.cmp(&ta).then_with(|| list[ia].id.cmp(&list[ib].id)));
    // Permute `list` in-place in O(n) without cloning SessionMeta.
    let mut target_of = vec![0usize; list.len()];
    for (dst, &(_, src)) in order.iter().enumerate() {
        target_of[src] = dst;
    }
    for i in 0..list.len() {
        while target_of[i] != i {
            let dst = target_of[i];
            list.swap(i, dst);
            target_of.swap(i, dst);
        }
    }
}

fn is_busy_status(s: SessionStatus) -> bool {
    matches!(
        s,
        SessionStatus::Working | SessionStatus::AwaitingApproval | SessionStatus::AwaitingAnswer
    )
}

/// Unsent side-chat stub: a fork row blank in every content signal.
fn is_empty_side_chat(s: &SessionMeta) -> bool {
    s.kind.as_deref() == Some("side")
        && s.parent_id.is_some()
        && s.status == SessionStatus::Idle
        && s.pending.is_none()
        && !s.unread
        && s.title.trim().is_empty()
        && s.label.trim().is_empty()
        && s.last_assistant.is_none()
}

/// Archived directly, or via an archived ancestor (never for live / pinned /
/// pending / busy children).
fn is_archived_cascaded(s: &SessionMeta, by_id: &HashMap<&str, &SessionMeta>) -> bool {
    if s.archived {
        return true;
    }
    // Full forks are independent sessions: archiving the parent never cascades.
    if s.live
        || s.pinned
        || s.pending.is_some()
        || is_busy_status(s.status)
        || s.kind.as_deref() == Some("fork")
    {
        return false;
    }
    let mut seen = vec![s.id.as_str()];
    let mut cur = s;
    while let Some(pid) = cur.parent_id.as_deref() {
        if seen.contains(&pid) {
            break;
        }
        seen.push(pid);
        let Some(parent) = by_id.get(pid) else { break };
        if parent.archived {
            return true;
        }
        cur = parent;
    }
    false
}

/// AND-matching of whitespace separated tokens, as `matchesSearch` on desktop.
fn matches_search(s: &SessionMeta, query: &str, workspace_path: Option<&str>) -> bool {
    let q = query.trim().to_lowercase();
    let tokens: Vec<&str> = q.split_whitespace().collect();
    if tokens.is_empty() {
        return true;
    }
    let cwd_term = if s.cwd.is_empty() {
        String::new()
    } else {
        match workspace_path.filter(|w| is_inside_canon(&s.cwd, w)) {
            Some(w) => {
                let rel = norm_path(&s.cwd)
                    .strip_prefix(&norm_path(w))
                    .map(|r| r.trim_start_matches('/').to_string())
                    .unwrap_or_default();
                if rel.is_empty() {
                    basename(&s.cwd)
                } else {
                    format!("{rel} {}", basename(&s.cwd))
                }
            }
            None => basename(&s.cwd),
        }
    }
    .to_lowercase();
    let git = s.git.as_ref();
    let fields = [
        s.title.to_lowercase(),
        s.label.to_lowercase(),
        git.and_then(|g| g.branch.clone())
            .unwrap_or_default()
            .to_lowercase(),
        git.and_then(|g| g.worktree.clone())
            .unwrap_or_default()
            .to_lowercase(),
        s.model.clone().unwrap_or_default().to_lowercase(),
        s.last_assistant.clone().unwrap_or_default().to_lowercase(),
        cwd_term,
    ];
    tokens.iter().all(|t| fields.iter().any(|f| f.contains(t)))
}

// ---------- session tree ----------

/// Live git worktree of a repo (first entry of the list = main checkout).
#[derive(Debug, Clone)]
struct Wt {
    path: String,
    branch: Option<String>,
    session_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Subgroup {
    key: String,
    kind: &'static str,
    label: String,
    deleted: bool,
    is_main: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    create_cwd: Option<String>,
    sessions: Vec<SessionMeta>,
    total_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceGroup {
    workspace: Workspace,
    is_global: bool,
    subgroups: Vec<Subgroup>,
    deleted_subgroups: Vec<Subgroup>,
    total_count: usize,
    pinned_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnassignedGroup {
    key: String,
    cwd: String,
    label: String,
    sessions: Vec<SessionMeta>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionTree {
    mode: SpaceMode,
    pinned: Vec<SessionMeta>,
    global_group: Option<WorkspaceGroup>,
    workspace_groups: Vec<WorkspaceGroup>,
    unassigned_groups: Vec<UnassignedGroup>,
    deleted_sessions: Vec<SessionMeta>,
    archived: Vec<SessionMeta>,
    session_groups: Vec<SessionGroup>,
    total_visible: usize,
}

struct Bucket {
    key: String,
    kind: &'static str,
    label: String,
    deleted: bool,
    is_main: bool,
    items: Vec<SessionMeta>,
}

/// Port of desktop `createSubgroups` (sessions already filtered, non-pinned).
fn build_subgroups(sessions: &[&SessionMeta], wts: Option<&[Wt]>) -> Vec<Subgroup> {
    let wts_slice = wts.unwrap_or(&[]);
    let has_live_list = !wts_slice.is_empty();
    // Deepest worktree first so nested worktree dirs win over the main checkout.
    let mut live: Vec<(&Wt, String, bool)> = wts_slice
        .iter()
        .map(|w| {
            (
                w,
                norm_path(&w.path),
                infer_worktree_name(&w.path).is_some(),
            )
        })
        .collect();
    live.sort_by_key(|(w, _, _)| std::cmp::Reverse(w.path.len()));

    let mut session_to_wt: HashMap<&str, &str> = HashMap::new();
    for w in wts_slice {
        for id in &w.session_ids {
            session_to_wt.entry(id.as_str()).or_insert(w.path.as_str());
        }
    }
    let mut wt_items: HashMap<&str, Vec<SessionMeta>> = HashMap::new();
    let mut buckets: Vec<Bucket> = Vec::new();
    let mut bucket_index: HashMap<String, usize> = HashMap::new();

    'sessions: for s in sessions {
        // 1. explicit session id attachment (O(1) lookup)
        if let Some(&wt_path) = session_to_wt.get(s.id.as_str()) {
            wt_items.entry(wt_path).or_default().push((*s).clone());
            continue;
        }
        // 2. deepest cwd containment
        if has_live_list {
            let in_wt_dir = infer_worktree_name(&s.cwd).is_some();
            let norm_cwd = norm_path(&s.cwd);
            if let Some((w, _, _)) = live.iter().find(|(w, np, is_wt_dir)| {
                (is_inside(&s.cwd, &w.path) || is_inside(&norm_cwd, np))
                    && (!in_wt_dir || *is_wt_dir)
            }) {
                wt_items.entry(&w.path).or_default().push((*s).clone());
                continue 'sessions;
            }
        }
        // 3. badge / inferred buckets
        let inferred = infer_worktree_name(&s.cwd);
        let git = s.git.as_ref();
        let (key, kind, label, deleted, is_main) =
            if let (true, Some(name)) = (has_live_list, inferred.as_ref()) {
                (format!("wt:{name}"), "worktree", name.clone(), true, false)
            } else if let Some(wt) = git.and_then(|g| g.worktree.as_ref()) {
                let label = wt
                    .rsplit(['/', '\\'])
                    .next()
                    .filter(|l| !l.is_empty())
                    .unwrap_or(wt)
                    .to_string();
                (format!("wt:{wt}"), "worktree", label, false, false)
            } else if let Some(br) = git.and_then(|g| g.branch.as_ref()) {
                // Before the worktree list is known (non-git / failed lookup), branch
                // buckets are treated as main so the layout stays stable.
                (
                    format!("br:{br}"),
                    "branch",
                    br.clone(),
                    false,
                    wts.is_none(),
                )
            } else if let Some(name) = inferred {
                (format!("wt:{name}"), "worktree", name, true, false)
            } else {
                (
                    "default".to_string(),
                    "default",
                    "其他".to_string(),
                    false,
                    false,
                )
            };
        if let Some(&idx) = bucket_index.get(&key) {
            buckets[idx].items.push((*s).clone());
        } else {
            let idx = buckets.len();
            bucket_index.insert(key.clone(), idx);
            buckets.push(Bucket {
                key,
                kind,
                label,
                deleted,
                is_main,
                items: vec![(*s).clone()],
            });
        }
    }

    let mut out: Vec<Subgroup> = Vec::new();
    let mut live_subs: Vec<Subgroup> = wts_slice
        .iter()
        .enumerate()
        .map(|(i, w)| {
            let mut items = wt_items.remove(w.path.as_str()).unwrap_or_default();
            sort_recent(&mut items);
            Subgroup {
                key: format!("wtp:{}", w.path),
                kind: "worktree",
                label: w.branch.clone().unwrap_or_else(|| basename(&w.path)),
                deleted: false,
                is_main: i == 0,
                path: Some(w.path.clone()),
                create_cwd: Some(w.path.clone()),
                total_count: items.len(),
                sessions: items,
            }
        })
        .collect();
    live_subs.sort_by(|a, b| {
        b.is_main
            .cmp(&a.is_main)
            .then_with(|| a.label.cmp(&b.label))
    });
    out.extend(live_subs);
    out.extend(buckets.into_iter().map(|mut b| {
        sort_recent(&mut b.items);
        Subgroup {
            key: b.key,
            kind: b.kind,
            label: b.label,
            deleted: b.deleted,
            is_main: b.is_main,
            path: None,
            create_cwd: b.items.first().map(|s| s.cwd.clone()),
            total_count: b.items.len(),
            sessions: b.items,
        }
    }));
    out.sort_by(|a, b| {
        a.deleted
            .cmp(&b.deleted)
            .then_with(|| b.is_main.cmp(&a.is_main))
            .then_with(|| (b.kind == "default").cmp(&(a.kind == "default")))
            .then_with(|| a.label.cmp(&b.label))
    });
    out
}

fn build_tree(
    metas: &[SessionMeta],
    workspaces: &[Workspace],
    session_groups: Vec<SessionGroup>,
    mode: SpaceMode,
    wts: &HashMap<String, Vec<Wt>>,
) -> SessionTree {
    let by_id: HashMap<&str, &SessionMeta> = metas.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut archived: Vec<SessionMeta> = Vec::new();
    let mut visible: Vec<&SessionMeta> = Vec::new();
    for s in metas
        .iter()
        .filter(|s| s.mode == mode && !is_empty_side_chat(s))
    {
        if is_archived_cascaded(s, &by_id) {
            archived.push(s.clone());
        } else {
            visible.push(s);
        }
    }
    sort_recent(&mut archived);

    let mode_ws: Vec<&Workspace> = workspaces.iter().filter(|w| w.mode == mode).collect();
    let global_ws = mode_ws
        .iter()
        .find(|w| w.kind == WorkspaceKind::Global)
        .copied();
    let mut project_ws: Vec<&Workspace> = mode_ws
        .iter()
        .filter(|w| w.kind != WorkspaceKind::Global)
        .copied()
        .collect();
    project_ws.sort_by(|a, b| a.sort.cmp(&b.sort).then_with(|| a.name.cmp(&b.name)));

    let known_ws: HashSet<&str> = mode_ws.iter().map(|w| w.id.as_str()).collect();
    let is_deleted_wt = |s: &SessionMeta| {
        s.git
            .as_ref()
            .is_none_or(|g| g.worktree.is_none() && g.branch.is_none())
            && infer_worktree_name(&s.cwd).is_some()
    };

    // Single-pass index: partition visible sessions into pinned, per-workspace
    // buckets, deleted worktrees, and unassigned roots in O(sessions + workspaces).
    let mut pinned: Vec<SessionMeta> = Vec::new();
    let mut ws_items: HashMap<&str, Vec<&SessionMeta>> = HashMap::with_capacity(mode_ws.len());
    let mut ws_pinned: HashMap<&str, usize> = HashMap::with_capacity(mode_ws.len());
    let mut deleted_sessions: Vec<SessionMeta> = Vec::new();
    let mut unassigned_by_root: HashMap<String, (i64, Vec<SessionMeta>)> = HashMap::new();

    for &s in &visible {
        let ws_id = s.workspace_id.as_deref().filter(|id| known_ws.contains(id));
        if s.pinned {
            pinned.push(s.clone());
            if let Some(id) = ws_id {
                *ws_pinned.entry(id).or_insert(0) += 1;
            }
            continue;
        }
        if let Some(id) = ws_id {
            ws_items.entry(id).or_default().push(s);
        } else if is_deleted_wt(s) {
            deleted_sessions.push(s.clone());
        } else {
            let root = s.repo_root.clone().unwrap_or_else(|| s.cwd.clone());
            let ts = session_ts(s);
            unassigned_by_root
                .entry(root)
                .and_modify(|(newest, items)| {
                    *newest = (*newest).max(ts);
                    items.push(s.clone());
                })
                .or_insert_with(|| (ts, vec![s.clone()]));
        }
    }
    sort_recent(&mut pinned);

    let mut make_group = |ws: &Workspace, is_global: bool| -> WorkspaceGroup {
        let items = ws_items.remove(ws.id.as_str()).unwrap_or_default();
        let pinned_count = ws_pinned.get(ws.id.as_str()).copied().unwrap_or(0);
        let subs = build_subgroups(&items, wts.get(&ws.id).map(Vec::as_slice));
        let (deleted_subgroups, subgroups): (Vec<_>, Vec<_>) =
            subs.into_iter().partition(|s| s.deleted);
        WorkspaceGroup {
            workspace: ws.clone(),
            is_global,
            subgroups,
            deleted_subgroups,
            total_count: items.len() + pinned_count,
            pinned_count,
        }
    };

    let global_group = global_ws.map(|w| make_group(w, true));
    let workspace_groups: Vec<WorkspaceGroup> =
        project_ws.iter().map(|w| make_group(w, false)).collect();

    let mut unassigned_map: Vec<(String, i64, Vec<SessionMeta>)> = unassigned_by_root
        .into_iter()
        .map(|(root, (newest, items))| (root, newest, items))
        .collect();
    sort_recent(&mut deleted_sessions);
    unassigned_map.sort_by_key(|(_, newest, _)| std::cmp::Reverse(*newest));
    let unassigned_groups: Vec<UnassignedGroup> = unassigned_map
        .into_iter()
        .map(|(cwd, _, mut sessions)| {
            sort_recent(&mut sessions);
            UnassignedGroup {
                label: {
                    let b = basename(&cwd);
                    if b.is_empty() {
                        cwd.clone()
                    } else {
                        b
                    }
                },
                key: cwd.clone(),
                cwd,
                sessions,
            }
        })
        .collect();

    SessionTree {
        mode,
        pinned,
        global_group,
        workspace_groups,
        unassigned_groups,
        deleted_sessions,
        archived,
        session_groups,
        total_visible: visible.len(),
    }
}

/// Lightweight worktree listing (path + branch only, no `git status` or `rev-list`).
fn list_worktree_entries_blocking(path: &str) -> Option<Vec<(PathBuf, Option<String>)>> {
    let root = crate::git::worktree::repo_info(FsPath::new(path))?.main_root();
    let entries = crate::git::worktree::list_entries(&root).ok()?;
    Some(
        entries
            .into_iter()
            .filter(|e| !e.bare)
            .map(|e| {
                let canon =
                    std::fs::canonicalize(&e.path).unwrap_or_else(|_| PathBuf::from(&e.path));
                (canon, e.branch)
            })
            .collect(),
    )
}

/// Live worktrees of the repo at `path` with canonicalized session attachment,
/// avoiding expensive per-worktree `git status` / `rev-list` subprocesses.
fn list_worktrees_blocking(path: &str, canon_sessions: &[(String, PathBuf)]) -> Option<Vec<Wt>> {
    let entries = list_worktree_entries_blocking(path)?;
    let all_paths: Vec<&PathBuf> = entries.iter().map(|(p, _)| p).collect();
    let mut by_wt: Vec<Vec<String>> = vec![Vec::new(); entries.len()];
    for (id, scwd) in canon_sessions {
        // Deepest worktree containing `scwd` wins.
        let best = all_paths
            .iter()
            .enumerate()
            .filter(|(_, wp)| scwd.starts_with(wp))
            .max_by_key(|(_, wp)| wp.components().count())
            .map(|(idx, _)| idx);
        if let Some(idx) = best {
            by_wt[idx].push(id.clone());
        }
    }
    Some(
        entries
            .into_iter()
            .zip(by_wt)
            .map(|((p, branch), session_ids)| Wt {
                path: p.to_string_lossy().into_owned(),
                branch,
                session_ids,
            })
            .collect(),
    )
}

#[derive(Deserialize)]
struct TreeQuery {
    mode: Option<SpaceMode>,
}

async fn session_tree<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Query(q): Query<TreeQuery>,
) -> ApiResult<SessionTree> {
    let st = app(&ctx)?;
    let mode = q.mode.unwrap_or_default();
    let mut metas = ctx.backend.sessions().await;
    metas.extend(super::draft::all_metas().await);
    let (workspaces, groups) = {
        let db = st.db.lock();
        (
            store::list_workspaces(&db).map_err(internal)?,
            store::list_session_groups(&db).map_err(internal)?,
        )
    };
    let target_ws: Vec<(String, String)> = workspaces
        .iter()
        .filter(|w| w.mode == mode && w.kind != WorkspaceKind::Global)
        .map(|w| (w.id.clone(), w.path.clone()))
        .collect();
    let mut wts: HashMap<String, Vec<Wt>> = HashMap::new();
    if !target_ws.is_empty() {
        // Only canonicalize distinct cwds of sessions in this mode, once.
        let mode_pairs: Vec<(String, String)> = metas
            .iter()
            .filter(|s| s.mode == mode && !is_empty_side_chat(s))
            .map(|s| (s.id.clone(), s.cwd.clone()))
            .collect();
        let canon_sessions: Arc<Vec<(String, PathBuf)>> = tokio::task::spawn_blocking(move || {
            let mut cache: HashMap<String, PathBuf> = HashMap::new();
            mode_pairs
                .into_iter()
                .map(|(id, cwd)| {
                    let canon = cache
                        .entry(cwd)
                        .or_insert_with_key(|raw| {
                            std::fs::canonicalize(raw).unwrap_or_else(|_| PathBuf::from(raw))
                        })
                        .clone();
                    (id, canon)
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| internal(e.to_string()))?
        .into();
        let handles: Vec<_> = target_ws
            .into_iter()
            .map(|(id, path)| {
                let canon_sessions = canon_sessions.clone();
                let h = tokio::task::spawn_blocking(move || {
                    list_worktrees_blocking(&path, &canon_sessions)
                });
                (id, h)
            })
            .collect();
        for (id, h) in handles {
            if let Ok(Some(list)) = h.await {
                wts.insert(id, list);
            }
        }
    }
    Ok(Json(build_tree(&metas, &workspaces, groups, mode, &wts)))
}

// ---------- allowed directories ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    path: String,
    label: String,
    kind: &'static str,
    workspace_id: String,
    mode: SpaceMode,
    #[serde(skip)]
    canon: PathBuf,
}

/// Registered workspaces plus their live worktrees (deduplicated by path).
/// Uses lightweight `git worktree list` entries without enumerating sessions or git status.
async fn allowed_dirs_db(
    db: &parking_lot::Mutex<rusqlite::Connection>,
) -> Result<Vec<DirEntry>, ApiError> {
    let workspaces = {
        let db = db.lock();
        store::list_workspaces(&db).map_err(internal)?
    };
    let mut handles = Vec::new();
    for w in &workspaces {
        if w.kind == WorkspaceKind::Global {
            continue;
        }
        let path = w.path.clone();
        handles.push(tokio::task::spawn_blocking(move || {
            list_worktree_entries_blocking(&path)
        }));
    }
    let mut handles = handles.into_iter();
    let mut out: Vec<DirEntry> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut push = |e: DirEntry| {
        if seen_paths.insert(e.path.clone()) {
            out.push(e);
        }
    };
    for w in &workspaces {
        let global = w.kind == WorkspaceKind::Global;
        push(DirEntry {
            path: w.path.clone(),
            label: w.name.clone(),
            kind: if global { "global" } else { "workspace" },
            workspace_id: w.id.clone(),
            mode: w.mode,
            canon: std::fs::canonicalize(&w.path).unwrap_or_else(|_| PathBuf::from(&w.path)),
        });
        if global {
            continue;
        }
        let Some(handle) = handles.next() else {
            continue;
        };
        if let Ok(Some(list)) = handle.await {
            for (wt_canon, wt_branch) in list.into_iter().skip(1) {
                let wt_path = wt_canon.to_string_lossy().into_owned();
                let label = format!(
                    "{} · {}",
                    w.name,
                    wt_branch.unwrap_or_else(|| basename(&wt_path))
                );
                push(DirEntry {
                    canon: wt_canon,
                    path: wt_path,
                    label,
                    kind: "worktree",
                    workspace_id: w.id.clone(),
                    mode: w.mode,
                });
            }
        }
    }
    Ok(out)
}

async fn allowed_dirs(st: &AppState) -> Result<Vec<DirEntry>, ApiError> {
    allowed_dirs_db(&st.db).await
}

/// Deepest allowed directory containing `cwd` (both canonical).
fn resolve_dir<'a>(cwd: &FsPath, dirs: &'a [DirEntry]) -> Option<&'a DirEntry> {
    dirs.iter()
        .filter(|d| cwd.starts_with(&d.canon))
        .max_by_key(|d| d.canon.components().count())
}

/// Validates `cwd` is an existing directory inside an allowed root.
async fn confine_cwd<'a>(
    cwd: &str,
    dirs: &'a [DirEntry],
) -> Result<(&'a DirEntry, String), ApiError> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Err(bad_request("目录不能为空"));
    }
    let canon = std::fs::canonicalize(cwd).map_err(|_| bad_request("目录不存在"))?;
    if !canon.is_dir() {
        return Err(bad_request("目录不存在"));
    }
    let entry = resolve_dir(&canon, dirs).ok_or_else(|| bad_request("目录不在已登记的工作区内"))?;
    Ok((entry, cwd.to_string()))
}

/// Validate an optional client-provided `cwd` against registered workspaces and
/// their live worktrees. Canonicalizes `cwd` so symlinks escaping a workspace
/// are rejected, and checks workspace roots directly before enumerating git
/// worktrees.
async fn authorize_optional_cwd(
    st: &AppState,
    cwd: Option<&str>,
) -> Result<Option<String>, ApiError> {
    let Some(raw) = cwd.map(str::trim).filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    let canon = std::fs::canonicalize(raw).map_err(|_| bad_request("目录不存在"))?;
    if !canon.is_dir() {
        return Err(bad_request("目录不存在"));
    }
    // Fast path: match directly against registered workspace roots without spawning git.
    let workspaces = {
        let db = st.db.lock();
        store::list_workspaces(&db).map_err(internal)?
    };
    let matches_workspace = workspaces.iter().any(|w| {
        let ws_canon = std::fs::canonicalize(&w.path).unwrap_or_else(|_| PathBuf::from(&w.path));
        canon.starts_with(&ws_canon)
    });
    if matches_workspace {
        return Ok(Some(canon.to_string_lossy().into_owned()));
    }
    // Slow path: allow live git worktrees of registered workspaces (e.g. sibling dirs).
    let dirs = allowed_dirs(st).await?;
    if resolve_dir(&canon, &dirs).is_some() {
        return Ok(Some(canon.to_string_lossy().into_owned()));
    }
    Err(bad_request("目录不在已登记的工作区内"))
}

async fn list_dirs<B: Backend>(State(ctx): State<Arc<Ctx<B>>>) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let dirs = allowed_dirs(st).await?;
    let home_dir = dirs::home_dir().map(|path| path.to_string_lossy().into_owned());
    Ok(Json(json!({ "dirs": dirs, "homeDir": home_dir })))
}

// ---------- session actions ----------

const MAX_APPEND_SYSTEM_PROMPT_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewSessionBody {
    cwd: String,
    model: Option<NewSessionModel>,
    thinking: Option<String>,
    append_system_prompt: Option<String>,
    #[serde(default)]
    automation_mode: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewSessionModel {
    provider: String,
    model_id: String,
}

async fn discard_draft<B: Backend>(
    State(_ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    if !super::draft::discard(&id).await {
        return Err(not_found("草稿不存在"));
    }
    Ok(Json(json!({"ok": true})))
}

type NewSelection = (Option<(String, String)>, Option<String>);

/// Validate the optional model / thinking choice of `POST /left/sessions`.
fn parse_new_selection(body: &NewSessionBody) -> Result<NewSelection, ApiError> {
    let model = match &body.model {
        Some(m) => {
            let (p, id) = (m.provider.trim(), m.model_id.trim());
            if p.is_empty() || id.is_empty() || p.len() > 200 || id.len() > 400 {
                return Err(bad_request("模型参数无效"));
            }
            Some((p.to_string(), id.to_string()))
        }
        None => None,
    };
    let thinking = match body
        .thinking
        .as_deref()
        .map(|t| t.trim().to_ascii_lowercase())
    {
        Some(t) if !t.is_empty() => {
            if t.len() > 32
                || !t
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(bad_request("思考等级无效"));
            }
            Some(t)
        }
        _ => None,
    };
    Ok((model, thinking))
}

fn parse_append_system_prompt(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.contains('\0') {
        return Err(bad_request("系统提示词不能包含空字符"));
    }
    if raw.len() > MAX_APPEND_SYSTEM_PROMPT_BYTES {
        return Err(bad_request("系统提示词不能超过 32 KiB"));
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

async fn new_session<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<NewSessionBody>,
) -> ApiResult<Value> {
    let dirs = allowed_dirs_db(&ctx.db).await?;
    let (entry, cwd) = confine_cwd(&body.cwd, &dirs).await?;
    let mode = if entry.kind == "global" {
        SpaceMode::Chat
    } else {
        entry.mode
    };
    let (model, thinking) = parse_new_selection(&body)?;
    let append_system_prompt = parse_append_system_prompt(body.append_system_prompt.as_deref())?;
    let info = super::draft::create_with_context(
        cwd,
        mode,
        None,
        Some(entry.workspace_id.clone()),
        append_system_prompt,
        body.automation_mode,
    )
    .await;
    if let Some((provider, model_id)) = model {
        super::draft::set_model(&info.session_id, provider, model_id).await;
    }
    if let Some(level) = thinking {
        super::draft::set_thinking(&info.session_id, level).await;
    }
    Ok(Json(serde_json::to_value(info).map_err(internal)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchSessionBody {
    custom_name: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
struct AddWorkspaceBody {
    path: String,
}

async fn add_workspace<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<AddWorkspaceBody>,
) -> ApiResult<Workspace> {
    let st = app(&ctx)?;
    let want = norm_path(body.path.trim());
    if want.is_empty() {
        return Err(bad_request("目录不能为空"));
    }
    let metas = ctx.backend.sessions().await;
    let Some(src) = metas.iter().find(|s| norm_path(&s.cwd) == want) else {
        return Err(bad_request("该目录下没有会话"));
    };
    let state = st.app.state::<AppState>();
    let ws = crate::catalog::commands::add_workspace(state, src.cwd.clone(), Some(src.mode))
        .await
        .map_err(bad_gateway)?;
    Ok(Json(ws))
}

async fn patch_session<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
    Json(body): Json<PatchSessionBody>,
) -> ApiResult<SessionMeta> {
    let st = app(&ctx)?;
    if super::draft::is_draft(&id) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "新会话还没有内容，请先发送第一条消息".into(),
        ));
    }
    let Some(current) = ctx.backend.session(&id).await else {
        return Err(not_found("会话不存在"));
    };
    if let Some(wid) = body.workspace_id.as_deref().filter(|w| !w.is_empty()) {
        let ok = {
            let db = st.db.lock();
            store::list_workspaces(&db).map_err(internal)?
        }
        .iter()
        .any(|w| w.id == wid && w.kind != WorkspaceKind::Global && w.mode == current.mode);
        if !ok {
            return Err(bad_request("工作区不存在或不属于该会话所在空间"));
        }
    }
    if body
        .custom_name
        .as_ref()
        .is_some_and(|n| n.chars().count() > 200)
    {
        return Err(bad_request("名称过长"));
    }
    let patch = SessionMetaPatch {
        custom_name: body.custom_name,
        pinned: body.pinned,
        archived: body.archived,
        workspace_id: body.workspace_id,
    };
    let state = st.app.state::<AppState>();
    let meta = crate::catalog::commands::update_session_meta(state, id, patch)
        .await
        .map_err(bad_gateway)?;
    Ok(Json(meta))
}

// ---------- inbox ----------

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboxGroups {
    awaiting: Vec<SessionMeta>,
    error: Vec<SessionMeta>,
    unread: Vec<SessionMeta>,
    running: Vec<SessionMeta>,
    /// awaiting + error + unread (running excluded).
    badge: usize,
}

/// Port of `groupInbox`: archived never show; awaiting/running never expire;
/// error/unread drop out once older than the window.
fn group_inbox(metas: &[SessionMeta], now: DateTime<Utc>, window_hours: u32) -> InboxGroups {
    let cutoff = now.timestamp_millis() - i64::from(window_hours.clamp(1, 720)) * 3_600_000;
    let mut g = InboxGroups::default();
    for s in metas.iter().filter(|s| !s.archived && s.created_by_app) {
        let Some(kind) = s.attention else { continue };
        let expired = !matches!(kind, Attention::Awaiting | Attention::Running)
            && DateTime::parse_from_rfc3339(&s.updated_at)
                .is_ok_and(|t| t.timestamp_millis() < cutoff);
        if expired {
            continue;
        }
        match kind {
            Attention::Awaiting => g.awaiting.push(s.clone()),
            Attention::Error => g.error.push(s.clone()),
            Attention::Unread => g.unread.push(s.clone()),
            Attention::Running => g.running.push(s.clone()),
        }
    }
    for list in [&mut g.awaiting, &mut g.error, &mut g.unread, &mut g.running] {
        sort_recent(list);
    }
    g.badge = g.awaiting.len() + g.error.len() + g.unread.len();
    g
}

async fn inbox<B: Backend>(State(ctx): State<Arc<Ctx<B>>>) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let hours = st.settings.read().inbox_window_hours;
    let metas = ctx.backend.sessions().await;
    let g = group_inbox(&metas, Utc::now(), hours);
    let mut v = serde_json::to_value(&g).map_err(internal)?;
    v["windowHours"] = json!(hours.clamp(1, 720));
    v["order"] = json!(["awaiting", "error", "unread", "running"]);
    Ok(Json(v))
}

async fn mark_seen(st: &AppState, id: &str) -> Result<(), ApiError> {
    crate::catalog::commands::mark_seen(st.app.state::<AppState>(), id.to_string())
        .await
        .map_err(bad_gateway)
}

async fn inbox_seen<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    if super::draft::is_draft(&id) {
        // Nothing to mark: a draft has no transcript yet.
        return Ok(ok_json());
    }
    if ctx.backend.session(&id).await.is_none() {
        return Err(not_found("会话不存在"));
    }
    mark_seen(st, &id).await?;
    Ok(ok_json())
}

#[derive(Deserialize)]
struct UnreadBody {
    unread: bool,
}

async fn inbox_unread<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
    Json(body): Json<UnreadBody>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let session = super::draft::find_session(&ctx.backend, &id)
        .await
        .ok_or_else(|| not_found("会话不存在"))?;
    if super::draft::is_draft(&session.id) {
        if body.unread {
            return Err(bad_request("草稿尚无可标记未读的内容"));
        }
    } else if body.unread {
        {
            let _mutation = crate::catalog::session_mutation_lock().lock().await;
            let db = st.db.lock();
            store::set_unread(&db, &id, true).map_err(internal)?;
        }
        crate::catalog::recompute_async(st, Some(vec![id])).await;
    } else {
        mark_seen(st, &id).await?;
    }
    Ok(Json(json!({ "ok": true, "unread": body.unread })))
}

async fn inbox_read_all<B: Backend>(State(ctx): State<Arc<Ctx<B>>>) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let hours = st.settings.read().inbox_window_hours;
    let metas = ctx.backend.sessions().await;
    let g = group_inbox(&metas, Utc::now(), hours);
    let mut count = 0;
    for s in g.unread.iter().chain(g.error.iter()) {
        mark_seen(st, &s.id).await?;
        count += 1;
    }
    Ok(Json(json!({ "ok": true, "count": count })))
}

// ---------- search ----------

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    mode: Option<SpaceMode>,
    archived: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchHit {
    branch: String,
    workspace_id: Option<String>,
    count: usize,
    session_ids: Vec<String>,
}

const MAX_SEARCH_SESSIONS: usize = 100;

fn search_sessions(
    metas: &[SessionMeta],
    workspaces: &[Workspace],
    q: &str,
    mode: Option<SpaceMode>,
    include_archived: bool,
) -> (Vec<SessionMeta>, Vec<BranchHit>) {
    if q.trim().is_empty() {
        return (Vec::new(), Vec::new());
    }
    let by_id: HashMap<&str, &SessionMeta> = metas.iter().map(|s| (s.id.as_str(), s)).collect();
    let ws_path: HashMap<&str, &str> = workspaces
        .iter()
        .map(|w| (w.id.as_str(), w.path.as_str()))
        .collect();
    let candidates: Vec<&SessionMeta> = metas
        .iter()
        .filter(|s| mode.is_none_or(|m| s.mode == m))
        .filter(|s| !is_empty_side_chat(s))
        .filter(|s| include_archived || !is_archived_cascaded(s, &by_id))
        .collect();
    let mut hits: Vec<SessionMeta> = candidates
        .iter()
        .filter(|s| {
            let wp = s
                .workspace_id
                .as_deref()
                .and_then(|id| ws_path.get(id).copied());
            matches_search(s, q, wp)
        })
        .map(|s| (*s).clone())
        .collect();
    sort_recent(&mut hits);
    hits.truncate(MAX_SEARCH_SESSIONS);

    // Branch hits: every query token must appear in the branch name.
    let tokens: Vec<String> = q.split_whitespace().map(str::to_lowercase).collect();
    let mut branches: Vec<(BranchHit, i64)> = Vec::new();
    for s in &candidates {
        let Some(branch) = s.git.as_ref().and_then(|g| g.branch.as_ref()) else {
            continue;
        };
        let lower = branch.to_lowercase();
        if !tokens.iter().all(|t| lower.contains(t)) {
            continue;
        }
        let ts = session_ts(s);
        match branches
            .iter_mut()
            .find(|(b, _)| b.branch == *branch && b.workspace_id == s.workspace_id)
        {
            Some((b, newest)) => {
                b.count += 1;
                *newest = (*newest).max(ts);
            }
            None => branches.push((
                BranchHit {
                    branch: branch.clone(),
                    workspace_id: s.workspace_id.clone(),
                    count: 1,
                    session_ids: Vec::new(),
                },
                ts,
            )),
        }
    }
    // Fill newest session ids per branch (candidates are unsorted).
    let mut ordered: Vec<&&SessionMeta> = candidates.iter().collect();
    ordered.sort_by_key(|s| std::cmp::Reverse(session_ts(s)));
    for s in ordered {
        let Some(branch) = s.git.as_ref().and_then(|g| g.branch.as_ref()) else {
            continue;
        };
        if let Some((b, _)) = branches
            .iter_mut()
            .find(|(b, _)| b.branch == *branch && b.workspace_id == s.workspace_id)
        {
            if b.session_ids.len() < 5 {
                b.session_ids.push(s.id.clone());
            }
        }
    }
    branches.sort_by_key(|(_, newest)| std::cmp::Reverse(*newest));
    (hits, branches.into_iter().map(|(b, _)| b).collect())
}

async fn search<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let metas = ctx.backend.sessions().await;
    let workspaces = {
        let db = st.db.lock();
        store::list_workspaces(&db).map_err(internal)?
    };
    let include_archived = matches!(q.archived.as_deref(), Some("1" | "true"));
    let (sessions, branches) = search_sessions(
        &metas,
        &workspaces,
        q.q.as_deref().unwrap_or(""),
        q.mode,
        include_archived,
    );
    Ok(Json(json!({ "sessions": sessions, "branches": branches })))
}

// ---------- schedules ----------

fn validate_schedule_id(id: &str) -> Result<(), ApiError> {
    if id.is_empty()
        || id.len() > 128
        || id.contains("..")
        || id.starts_with('.')
        || id.ends_with('.')
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(bad_request("非法标识符"));
    }
    Ok(())
}

fn schedule_exists(st: &AppState, id: &str) -> Result<(), ApiError> {
    let found = {
        let db = st.db.lock();
        sched_store::get(&db, id).map_err(internal)?
    };
    found.map(|_| ()).ok_or_else(|| not_found("自动化不存在"))
}

async fn validate_draft(
    db: &parking_lot::Mutex<rusqlite::Connection>,
    draft: &mut ScheduleDraft,
) -> Result<(), ApiError> {
    if draft.name.trim().is_empty() {
        return Err(bad_request("请填写自动化名称"));
    }
    if let Some(raw_mode) = draft.approval_mode.take() {
        let trimmed = raw_mode.trim();
        if !trimmed.is_empty() {
            check_approval_mode(trimmed).map_err(bad_request)?;
            draft.approval_mode = Some(trimmed.to_string());
        }
    }
    let has_probe = draft
        .probe_command
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    if draft.agent_trigger != crate::contracts::ScheduleAgentTrigger::Never
        && draft.prompt.trim().is_empty()
    {
        return Err(bad_request("请填写提示词"));
    }
    if draft.agent_trigger != crate::contracts::ScheduleAgentTrigger::Always && !has_probe {
        return Err(bad_request("请填写本地脚本"));
    }
    let dirs = allowed_dirs_db(db).await?;
    confine_cwd(&draft.cwd, &dirs).await.map(|_| ())
}

async fn schedules_list<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
) -> ApiResult<Vec<crate::contracts::Schedule>> {
    let st = app(&ctx)?;
    let list = {
        let db = st.db.lock();
        sched_store::list(&db).map_err(internal)?
    };
    Ok(Json(list))
}

async fn schedules_create<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(mut draft): Json<ScheduleDraft>,
) -> ApiResult<crate::contracts::Schedule> {
    let requested_id = draft
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(id) = &requested_id {
        validate_schedule_id(id)?;
    }
    draft.id = requested_id;
    validate_draft(&ctx.db, &mut draft).await?;
    let st = app(&ctx)?;
    let saved = crate::schedules::commands::schedules_create_unique(st, draft)
        .await
        .map_err(|e| match e {
            crate::schedules::store::CreateScheduleError::Conflict(msg) => conflict(msg),
            crate::schedules::store::CreateScheduleError::Invalid(msg) => bad_request(msg),
        })?;
    Ok(Json(saved))
}

async fn schedules_update<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
    Json(mut draft): Json<ScheduleDraft>,
) -> ApiResult<crate::contracts::Schedule> {
    validate_schedule_id(&id)?;
    let st = app(&ctx)?;
    schedule_exists(st, &id)?;
    draft.id = Some(id);
    validate_draft(&ctx.db, &mut draft).await?;
    let saved = crate::schedules::commands::schedules_save(st.app.state::<AppState>(), draft)
        .await
        .map_err(bad_request)?;
    Ok(Json(saved))
}
async fn schedules_delete<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    schedule_exists(st, &id)?;
    crate::schedules::commands::schedules_delete(st.app.state::<AppState>(), id)
        .await
        .map_err(bad_request)?;
    Ok(ok_json())
}

#[derive(Deserialize)]
struct EnabledBody {
    enabled: bool,
}

async fn schedules_enabled<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
    Json(body): Json<EnabledBody>,
) -> ApiResult<crate::contracts::Schedule> {
    let st = app(&ctx)?;
    schedule_exists(st, &id)?;
    let updated = crate::schedules::commands::schedules_set_enabled(
        st.app.state::<AppState>(),
        id,
        body.enabled,
    )
    .await
    .map_err(bad_request)?;
    Ok(Json(updated))
}

async fn schedules_run<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
) -> ApiResult<crate::contracts::ScheduleRun> {
    let st = app(&ctx)?;
    schedule_exists(st, &id)?;
    let run = runner::run_now(st.clone(), id).await.map_err(bad_request)?;
    Ok(Json(run))
}

async fn schedules_release_awaiting<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path((id, run_id)): Path<(String, String)>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    schedule_exists(st, &id)?;
    crate::schedules::commands::schedules_release_awaiting(st.app.state::<AppState>(), id, run_id)
        .await
        .map_err(bad_request)?;
    Ok(ok_json())
}

async fn schedules_resume_awaiting<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path((id, run_id)): Path<(String, String)>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    schedule_exists(st, &id)?;
    crate::schedules::commands::schedules_resume_awaiting(st.app.state::<AppState>(), id, run_id)
        .await
        .map_err(bad_request)?;
    Ok(ok_json())
}

async fn schedules_awaiting<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
) -> ApiResult<Vec<crate::contracts::ScheduleRun>> {
    let st = app(&ctx)?;
    schedule_exists(st, &id)?;
    let runs = {
        let db = st.db.lock();
        sched_store::list_awaiting_runs(&db, &id).map_err(internal)?
    };
    Ok(Json(runs))
}

#[derive(Deserialize)]
struct RunsQuery {
    limit: Option<u32>,
}

async fn schedules_runs<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
    Query(q): Query<RunsQuery>,
) -> ApiResult<Vec<crate::contracts::ScheduleRun>> {
    let st = app(&ctx)?;
    schedule_exists(st, &id)?;
    let runs = {
        let db = st.db.lock();
        sched_store::list_runs(&db, &id, q.limit.unwrap_or(20).clamp(1, 100)).map_err(internal)?
    };
    Ok(Json(runs))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeTestBody {
    cwd: String,
    probe_command: String,
    #[serde(default)]
    agent_trigger: crate::contracts::ScheduleAgentTrigger,
    schedule_id: Option<String>,
}

async fn schedules_probe_test<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<ProbeTestBody>,
) -> ApiResult<crate::contracts::ProbeTestResult> {
    let dirs = allowed_dirs_db(&ctx.db).await?;
    let (_, cwd) = confine_cwd(&body.cwd, &dirs).await?;
    if body.probe_command.trim().is_empty() {
        return Err(bad_request("请填写本地脚本或命令"));
    }
    let schedule_id = match body
        .schedule_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(id) => {
            validate_schedule_id(id)?;
            Some(id.to_string())
        }
        None => None,
    };
    let result = crate::schedules::commands::schedules_test_probe(
        cwd,
        body.probe_command,
        body.agent_trigger,
        schedule_id,
    )
    .await
    .map_err(bad_request)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateDraftBody {
    request: String,
    cwd: String,
    current: Option<ScheduleDraft>,
    #[serde(default)]
    preview: bool,
}

async fn schedules_generate_draft<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<GenerateDraftBody>,
) -> ApiResult<crate::contracts::AutomationAuthorResult> {
    if body.request.trim().is_empty() {
        return Err(bad_request("请先输入想让 AI 生成的自动化描述"));
    }
    let dirs = allowed_dirs_db(&ctx.db).await?;
    let (_, cwd) = confine_cwd(&body.cwd, &dirs).await?;
    if let Some(id) = body
        .current
        .as_ref()
        .and_then(|c| c.id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        validate_schedule_id(id)?;
    }
    let st = app(&ctx)?;
    let result = crate::schedules::commands::schedules_generate_draft_with_options(
        st,
        body.request,
        cwd,
        body.current,
        body.preview,
    )
    .await
    .map_err(bad_gateway)?;
    Ok(Json(result))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AutomationWorktreeState {
    repo_root: String,
    worktree_path: String,
    branch: String,
    ahead: u32,
    dirty: u32,
    committed_diff: String,
    uncommitted_diff: String,
    combined_diff: String,
    added_lines: u32,
    removed_lines: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

fn count_diff_lines(diff: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++ ") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("--- ") {
            removed += 1;
        }
    }
    (added, removed)
}

static WORKTREE_MUTATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorktreeActionBody {
    run_id: Option<String>,
    branch: Option<String>,
    worktree_path: Option<String>,
}

impl WorktreeActionBody {
    fn has_target_fields(&self) -> bool {
        [&self.run_id, &self.branch, &self.worktree_path]
            .into_iter()
            .any(|v| v.as_deref().map(str::trim).is_some_and(|s| !s.is_empty()))
    }
}

fn worktree_matches_run(
    wt: &crate::contracts::WorktreeInfo,
    run: &crate::contracts::ScheduleRun,
) -> bool {
    let run_prefix: String = run.id.chars().take(8).collect();
    if run_prefix.chars().count() < 6 {
        return false;
    }
    wt.branch.as_deref().is_some_and(|b| {
        let b = b.trim();
        let tail = b.strip_prefix("omp/").unwrap_or(b);
        tail.starts_with("sched-") && tail.ends_with(&run_prefix)
    })
}

fn find_automation_worktree<'a, 'b>(
    repo_root: &str,
    run_mode: crate::contracts::ScheduleRunMode,
    worktrees: &'a [crate::contracts::WorktreeInfo],
    runs: &'b [crate::contracts::ScheduleRun],
) -> Option<(&'a crate::contracts::WorktreeInfo, &'b crate::contracts::ScheduleRun)> {
    if run_mode != crate::contracts::ScheduleRunMode::Worktree {
        return None;
    }
    let main_path = norm_path(repo_root);
    let candidates: Vec<&crate::contracts::WorktreeInfo> = worktrees
        .iter()
        .filter(|wt| norm_path(&wt.path) != main_path)
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let mut fallback: Option<(&crate::contracts::WorktreeInfo, &crate::contracts::ScheduleRun)> =
        None;
    for run in runs {
        let Some(wt) = candidates
            .iter()
            .copied()
            .find(|wt| worktree_matches_run(wt, run))
        else {
            continue;
        };
        if wt.ahead > 0 || wt.dirty > 0 {
            return Some((wt, run));
        }
        if fallback.is_none() {
            fallback = Some((wt, run));
        }
    }
    fallback
}

struct InspectedWorktree {
    state: AutomationWorktreeState,
    wt_session_ids: Vec<String>,
}

async fn inspect_schedule_worktree_detail<B: Backend>(
    ctx: &Ctx<B>,
    id: &str,
) -> Result<
    (
        crate::contracts::Schedule,
        Option<InspectedWorktree>,
        Vec<crate::contracts::ScheduleRun>,
        Vec<SessionMeta>,
    ),
    ApiError,
> {
    validate_schedule_id(id)?;
    let (schedule, runs) = {
        let db = ctx.db.lock();
        let schedule = sched_store::get(&db, id)
            .map_err(internal)?
            .ok_or_else(|| not_found("自动化不存在"))?;
        let runs = sched_store::list_runs(&db, id, 30).map_err(internal)?;
        (schedule, runs)
    };
    if schedule.run_mode != crate::contracts::ScheduleRunMode::Worktree {
        return Ok((schedule, None, runs, Vec::new()));
    }
    let cwd = schedule.cwd.trim();
    if cwd.is_empty() {
        return Ok((schedule, None, runs, Vec::new()));
    }
    let Ok(Some(repo_root)) = crate::git::commands::repo_root_for_cwd(cwd.to_string()).await else {
        return Ok((schedule, None, runs, Vec::new()));
    };
    let session_list = ctx.backend.sessions().await;
    let worktrees = match ctx.backend.app_state() {
        Some(st) => crate::git::commands::list_worktrees_for_app(st, repo_root.clone())
            .await
            .unwrap_or_default(),
        None => {
            let pairs: Vec<(String, String)> = session_list
                .iter()
                .map(|s| (s.id.clone(), s.cwd.clone()))
                .collect();
            let root = PathBuf::from(&repo_root);
            tokio::task::spawn_blocking(move || crate::git::worktree::list(&root, &pairs))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default()
        }
    };
    let Some((wt, run)) =
        find_automation_worktree(&repo_root, schedule.run_mode, &worktrees, &runs)
    else {
        return Ok((schedule, None, runs, session_list));
    };
    let Some(branch) = wt
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
    else {
        return Ok((schedule, None, runs, session_list));
    };

    let (committed_diff, uncommitted_diff) = tokio::join!(
        async {
            if wt.ahead > 0 {
                crate::git::commands::diff_base_for_cwd(wt.path.clone())
                    .await
                    .unwrap_or_default()
            } else {
                String::new()
            }
        },
        async {
            if wt.dirty > 0 {
                crate::git::commands::diff_for_cwd(wt.path.clone(), None, None)
                    .await
                    .unwrap_or_default()
            } else {
                String::new()
            }
        },
    );
    let combined_diff = [committed_diff.trim(), uncommitted_diff.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let (added_lines, removed_lines) = count_diff_lines(&combined_diff);

    Ok((
        schedule,
        Some(InspectedWorktree {
            state: AutomationWorktreeState {
                repo_root,
                worktree_path: wt.path.clone(),
                branch,
                ahead: wt.ahead,
                dirty: wt.dirty,
                committed_diff,
                uncommitted_diff,
                combined_diff,
                added_lines,
                removed_lines,
                run_id: Some(run.id.clone()),
                session_id: run.session_id.clone(),
            },
            wt_session_ids: wt.session_ids.clone(),
        }),
        runs,
        session_list,
    ))
}

async fn inspect_schedule_worktree<B: Backend>(
    ctx: &Ctx<B>,
    id: &str,
) -> Result<(crate::contracts::Schedule, Option<AutomationWorktreeState>), ApiError> {
    let (schedule, inspected, _, _) = inspect_schedule_worktree_detail(ctx, id).await?;
    Ok((schedule, inspected.map(|i| i.state)))
}

fn verify_worktree_target(
    wt: &AutomationWorktreeState,
    target: &WorktreeActionBody,
) -> Result<(), ApiError> {
    if let Some(expected_run) = target
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if wt.run_id.as_deref() != Some(expected_run) {
            return Err(conflict("工作树已变化，请刷新后再确认"));
        }
    }
    if let Some(expected_branch) = target
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if wt.branch != expected_branch {
            return Err(conflict("工作树已变化，请刷新后再确认"));
        }
    }
    if let Some(expected_path) = target
        .worktree_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if norm_path(&wt.worktree_path) != norm_path(expected_path) {
            return Err(conflict("工作树已变化，请刷新后再确认"));
        }
    }
    Ok(())
}

fn ensure_worktree_idle(
    wt: &AutomationWorktreeState,
    wt_session_ids: &[String],
    runs: &[crate::contracts::ScheduleRun],
    session_list: &[SessionMeta],
) -> Result<(), ApiError> {
    let has_running_run = runs
        .iter()
        .any(|r| r.status == crate::contracts::ScheduleRunStatus::Running);
    if has_running_run {
        return Err(conflict(
            "该工作树仍有正在运行的任务或活跃会话，请等待结束后再操作",
        ));
    }
    let wt_norm = norm_path(&wt.worktree_path);
    let live_ids: HashSet<&str> = session_list
        .iter()
        .filter(|s| s.live)
        .map(|s| s.id.as_str())
        .collect();
    let has_live_session = session_list
        .iter()
        .any(|s| s.live && norm_path(&s.cwd) == wt_norm)
        || wt_session_ids
            .iter()
            .any(|sid| live_ids.contains(sid.as_str()));
    if has_live_session {
        return Err(conflict(
            "该工作树仍有正在运行的任务或活跃会话，请等待结束后再操作",
        ));
    }
    Ok(())
}

async fn prepare_worktree_mutation<B: Backend>(
    ctx: &Ctx<B>,
    id: &str,
    target: Option<WorktreeActionBody>,
) -> Result<(crate::contracts::Schedule, AutomationWorktreeState), ApiError> {
    let (schedule, inspected_opt, runs, session_list) =
        inspect_schedule_worktree_detail(ctx, id).await?;
    let Some(inspected) = inspected_opt else {
        if target.as_ref().is_some_and(WorktreeActionBody::has_target_fields) {
            return Err(conflict("工作树已变化，请刷新后再确认"));
        }
        return Err(not_found("未找到该自动化关联的隔离工作树"));
    };
    if let Some(target) = target.as_ref() {
        verify_worktree_target(&inspected.state, target)?;
    }
    ensure_worktree_idle(
        &inspected.state,
        &inspected.wt_session_ids,
        &runs,
        &session_list,
    )?;
    Ok((schedule, inspected.state))
}

async fn schedules_worktree<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
) -> ApiResult<Option<AutomationWorktreeState>> {
    let (_schedule, state) = inspect_schedule_worktree(&ctx, &id).await?;
    Ok(Json(state))
}

async fn merge_automation_worktree_step<F, Fut>(
    schedule_name: &str,
    wt: AutomationWorktreeState,
    remove_wt: F,
) -> Result<(), ApiError>
where
    F: FnOnce(String, String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    if wt.dirty > 0 {
        crate::git::commands::commit_all_for_cwd(
            wt.worktree_path.clone(),
            format!("chore(automation): {schedule_name}"),
        )
        .await
        .map_err(bad_request)?;
    }
    crate::git::commands::merge_branch_for_repo(wt.repo_root.clone(), wt.branch.clone())
        .await
        .map_err(bad_request)?;
    remove_wt(wt.repo_root, wt.worktree_path)
        .await
        .map_err(bad_request)?;
    Ok(())
}

async fn schedules_worktree_merge<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
    body: Option<Json<WorktreeActionBody>>,
) -> ApiResult<Value> {
    let _guard = WORKTREE_MUTATION_LOCK.lock().await;
    let (schedule, wt) = prepare_worktree_mutation(&ctx, &id, body.map(|Json(b)| b)).await?;
    let st = app(&ctx)?;
    merge_automation_worktree_step(&schedule.name, wt, |repo, path| async move {
        crate::git::commands::remove_worktree_for_app(st, repo, path, true, false, Some(false))
            .await
    })
    .await?;
    Ok(ok_json())
}

async fn schedules_worktree_discard<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Path(id): Path<String>,
    body: Option<Json<WorktreeActionBody>>,
) -> ApiResult<Value> {
    let _guard = WORKTREE_MUTATION_LOCK.lock().await;
    let (_schedule, wt) = prepare_worktree_mutation(&ctx, &id, body.map(|Json(b)| b)).await?;
    let st = app(&ctx)?;
    crate::git::commands::remove_worktree_for_app(
        st,
        wt.repo_root,
        wt.worktree_path,
        true,
        true,
        Some(false),
    )
    .await
    .map_err(bad_request)?;
    Ok(ok_json())
}

// ---------- skills ----------

/// Slice of OMP config deciding which skills reach a new session.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillConfig {
    skills_enabled: bool,
    disabled_extensions: Vec<String>,
    ignored: Vec<String>,
    include: Vec<String>,
    source_toggles: HashMap<String, bool>,
}

impl Default for SkillConfig {
    fn default() -> Self {
        Self {
            skills_enabled: true,
            disabled_extensions: Vec::new(),
            ignored: Vec::new(),
            include: Vec::new(),
            source_toggles: HashMap::new(),
        }
    }
}

fn str_list(v: &Option<Value>) -> Vec<String> {
    v.as_ref()
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_skill_config(entries: &[crate::settings::OmpConfigEntry]) -> SkillConfig {
    let mut cfg = SkillConfig::default();
    for e in entries {
        match e.key.as_str() {
            "skills.enabled" => {
                if let Some(b) = e.value.as_ref().and_then(Value::as_bool) {
                    cfg.skills_enabled = b;
                }
            }
            "skills.ignoredSkills" => cfg.ignored = str_list(&e.value),
            "skills.includeSkills" => cfg.include = str_list(&e.value),
            "disabledExtensions" => cfg.disabled_extensions = str_list(&e.value),
            k if k.starts_with("skills.enable") => {
                if let Some(b) = e.value.as_ref().and_then(Value::as_bool) {
                    cfg.source_toggles.insert(k.to_string(), b);
                }
            }
            _ => {}
        }
    }
    cfg
}

/// Anchored glob (`*`, `?`; `**` ≡ `*`), case-sensitive.
fn glob_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || (p[pi] != '*' && p[pi] == n[ni])) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn source_toggle_key(provider: &str, source: &str) -> Option<&'static str> {
    Some(match (provider, source) {
        ("native", "user") => "skills.enablePiUser",
        ("native", "project") => "skills.enablePiProject",
        ("claude", "user") => "skills.enableClaudeUser",
        ("claude", "project") => "skills.enableClaudeProject",
        ("agents", "user") => "skills.enableAgentsUser",
        ("agents", "project") => "skills.enableAgentsProject",
        ("codex", "user") => "skills.enableCodexUser",
        _ => return None,
    })
}

/// OMP's session-start filter pipeline for one skill; `Err(reason)` = disabled.
fn skill_enablement(
    name: &str,
    provider: &str,
    source: &str,
    cfg: &SkillConfig,
) -> Result<(), Value> {
    if !cfg.skills_enabled {
        return Err(json!({ "kind": "all_off" }));
    }
    if cfg
        .disabled_extensions
        .iter()
        .any(|e| e == &format!("skill:{name}"))
    {
        return Err(json!({ "kind": "disabled" }));
    }
    if let Some(key) = source_toggle_key(provider, source) {
        if cfg.source_toggles.get(key) == Some(&false) {
            return Err(json!({ "kind": "source", "key": key }));
        }
    }
    if cfg.ignored.iter().any(|p| p == name) {
        return Err(json!({ "kind": "ignored", "pattern": name, "exact": true }));
    }
    if let Some(p) = cfg.ignored.iter().find(|p| glob_match(p, name)) {
        return Err(json!({ "kind": "ignored", "pattern": p, "exact": false }));
    }
    if !cfg.include.is_empty() && !cfg.include.iter().any(|p| glob_match(p, name)) {
        return Err(json!({ "kind": "not_included" }));
    }
    Ok(())
}

/// New `(disabledExtensions, ignoredSkills)` for a skill toggle; the ignored
/// list is `Some` only when an exact-name entry must be cleared.
fn apply_skill_toggle(
    disabled: &[String],
    ignored: &[String],
    name: &str,
    enabled: bool,
) -> (Vec<String>, Option<Vec<String>>) {
    let marker = format!("skill:{name}");
    let mut next: Vec<String> = disabled.iter().filter(|e| **e != marker).cloned().collect();
    if !enabled {
        next.push(marker);
    }
    let clear_ignored = enabled && ignored.iter().any(|p| p == name);
    let ign = clear_ignored.then(|| ignored.iter().filter(|p| *p != name).cloned().collect());
    (next, ign)
}

fn apply_extension_toggle(
    disabled: &[String],
    name: &str,
    path: &str,
    enabled: bool,
) -> Vec<String> {
    let module = format!("extension-module:{name}");
    let mut next: Vec<String> = disabled
        .iter()
        .filter(|e| !enabled || (**e != name && **e != module && **e != path))
        .cloned()
        .collect();
    if !enabled && !next.iter().any(|e| e == name) {
        next.push(name.to_string());
    }
    next
}

async fn read_skill_config(st: &AppState) -> Result<SkillConfig, String> {
    let list = crate::settings::omp_config_list(st.app.state::<AppState>()).await?;
    if !list.found {
        return Err(list.error.unwrap_or_else(|| "无法读取 OMP 配置".into()));
    }
    Ok(parse_skill_config(&list.entries))
}

async fn set_list_setting(st: &AppState, key: &str, list: &[String]) -> Result<(), ApiError> {
    let value = serde_json::to_string(list).map_err(internal)?;
    crate::settings::omp_config_set(st.app.state::<AppState>(), key.to_string(), value)
        .await
        .map_err(bad_gateway)
}

/// Serializes read-modify-write cycles of OMP list settings.
static SKILL_CFG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
struct CwdQuery {
    cwd: Option<String>,
}

async fn catalog_for<B: Backend>(
    _ctx: &Ctx<B>,
    st: &AppState,
    cwd: Option<&str>,
) -> Result<crate::contracts::SkillsCatalog, ApiError> {
    let cwd = authorize_optional_cwd(st, cwd).await?;
    crate::skills::commands::skills_list(cwd)
        .await
        .map_err(bad_gateway)
}

#[derive(Deserialize)]
struct SkillContentQuery {
    path: String,
    cwd: Option<String>,
}

/// Largest SKILL.md returned to the phone.
const MAX_SKILL_BYTES: u64 = 256 * 1024;

/// `GET /left/skills/content?path=<SkillItem.path>&cwd=` → `{text}`. `path` must equal the
/// path of a skill in the catalog (project skills need the same `cwd` as `/left/skills`).
async fn skill_content<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Query(q): Query<SkillContentQuery>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let catalog = catalog_for(&ctx, st, q.cwd.as_deref()).await?;
    let skill = catalog
        .skills
        .iter()
        .find(|s| s.path == q.path)
        .ok_or_else(|| not_found("技能不存在"))?;
    let path = PathBuf::from(&skill.path);
    let text = tokio::task::spawn_blocking(move || {
        let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if len > MAX_SKILL_BYTES {
            return Err("技能文件超过 256KB".to_string());
        }
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| internal(e.to_string()))?
    .map_err(bad_request)?;
    Ok(Json(json!({ "text": text })))
}

async fn skills_list<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Query(q): Query<CwdQuery>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let catalog = catalog_for(&ctx, st, q.cwd.as_deref()).await?;
    let (cfg, config_error) = match read_skill_config(st).await {
        Ok(c) => (c, None),
        Err(e) => (SkillConfig::default(), Some(e)),
    };
    let skills: Vec<Value> = catalog
        .skills
        .iter()
        .map(|s| {
            let mut v = serde_json::to_value(s).unwrap_or(Value::Null);
            let provider = v["provider"].as_str().unwrap_or("").to_string();
            let verdict = skill_enablement(&s.name, &provider, &s.source, &cfg);
            v["enabled"] = json!(verdict.is_ok());
            v["disabledReason"] = verdict.err().unwrap_or(Value::Null);
            v
        })
        .collect();
    Ok(Json(json!({
        "skills": skills,
        "extensions": catalog.extensions,
        "skillsEnabled": cfg.skills_enabled,
        "configError": config_error,
    })))
}

#[derive(Deserialize)]
struct SkillToggleBody {
    name: String,
    enabled: bool,
    cwd: Option<String>,
}

async fn skill_toggle<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<SkillToggleBody>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let catalog = catalog_for(&ctx, st, body.cwd.as_deref()).await?;
    if !catalog.skills.iter().any(|s| s.name == body.name) {
        return Err(not_found("技能不存在"));
    }
    let _guard = SKILL_CFG_LOCK.lock().await;
    let cfg = read_skill_config(st).await.map_err(bad_gateway)?;
    let (disabled, ignored) = apply_skill_toggle(
        &cfg.disabled_extensions,
        &cfg.ignored,
        &body.name,
        body.enabled,
    );
    set_list_setting(st, "disabledExtensions", &disabled).await?;
    if let Some(ignored) = ignored {
        set_list_setting(st, "skills.ignoredSkills", &ignored).await?;
    }
    Ok(ok_json())
}

#[derive(Deserialize)]
struct ExtensionToggleBody {
    path: String,
    enabled: bool,
    cwd: Option<String>,
}

async fn extension_toggle<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<ExtensionToggleBody>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let catalog = catalog_for(&ctx, st, body.cwd.as_deref()).await?;
    let ext = catalog
        .extensions
        .iter()
        .find(|e| e.path == body.path)
        .ok_or_else(|| not_found("扩展不存在"))?;
    let _guard = SKILL_CFG_LOCK.lock().await;
    let cfg = read_skill_config(st).await.map_err(bad_gateway)?;
    let disabled =
        apply_extension_toggle(&cfg.disabled_extensions, &ext.name, &ext.path, body.enabled);
    set_list_setting(st, "disabledExtensions", &disabled).await?;
    Ok(ok_json())
}

// ---------- settings ----------

async fn settings_summary<B: Backend>(State(ctx): State<Arc<Ctx<B>>>) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let status = crate::mobile::status(st);
    let roles = crate::settings_model_roles::omp_model_roles_read(None, None)
        .await
        .ok()
        .and_then(|s| s.global.model_roles.get("default").cloned())
        .filter(|m| !m.trim().is_empty());
    let (model, source) = match roles {
        Some(m) => (Some(m), Some("modelRoles.default")),
        None => match st
            .settings
            .read()
            .new_session_model
            .clone()
            .filter(|m| !m.trim().is_empty())
        {
            Some(m) => (Some(m), Some("newSessionModel")),
            None => (None, None),
        },
    };
    let (omp, omp_error) = match read_mobile_settings(st).await {
        Ok(m) => (Value::Object(m), None),
        Err(e) => (json!({}), Some(e)),
    };
    let auto_snap = {
        let s = st.settings.read();
        automation_settings_snapshot(&s)
    };
    let (default_approval_mode, capsule_visible) = {
        let s = st.settings.read();
        (s.default_approval_mode.clone(), s.capsule_visible)
    };
    let mut out = json!({
        "appVersion": st.app.package_info().version.to_string(),
        "mobile": {
            "running": status.running,
            "port": status.port,
            "lanUrl": status.lan_url,
            "lanTlsRunning": status.lan_tls_running,
            "lanTlsPort": status.lan_tls_port,
            "lanTlsUrl": status.lan_tls_url,
            "tunnelUrl": status.tunnel_url,
            "ipv6Running": status.ipv6_running,
            "ipv6Url": status.ipv6_url,
            "certSha256": status.cert_sha256,
        },
        "defaultModel": model,
        "defaultModelSource": source,
        "defaultApprovalMode": default_approval_mode,
        "capsuleVisible": capsule_visible,
        "omp": omp,
        "ompError": omp_error,
    });
    if let (Some(obj), Some(auto_obj)) = (out.as_object_mut(), auto_snap.as_object()) {
        for (k, v) in auto_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    Ok(Json(out))
}

/// Approval modes the phone may select for new omp processes (`--approval-mode`).
const APPROVAL_MODES: &[&str] = &["always-ask", "write", "yolo"];

fn check_approval_mode(mode: &str) -> Result<(), String> {
    if APPROVAL_MODES.contains(&mode) {
        Ok(())
    } else {
        Err(format!("审批模式必须是：{}", APPROVAL_MODES.join(" / ")))
    }
}

fn automation_settings_snapshot(s: &crate::contracts::Settings) -> Value {
    json!({
        "automationBackgroundEnabled": s.automation_background_enabled,
        "automationOverlapPolicy": s.automation_overlap_policy,
        "automationDefaultResultMode": s.automation_default_result_mode,
        "automationDefaultModel": s.automation_default_model,
        "automationDefaultThinking": s.automation_default_thinking,
        "automationPromptMockTest": s.automation_prompt_mock_test,
        "automationPromptRealOnceTest": s.automation_prompt_real_once_test,
        "automationPromptRealLoopTest": s.automation_prompt_real_loop_test,
        "automationPromptAdjust": s.automation_prompt_adjust,
    })
}

fn desktop_settings_json(st: &AppState) -> Value {
    let s = st.settings.read();
    let mut out = json!({
        "defaultApprovalMode": s.default_approval_mode,
        "capsuleVisible": s.capsule_visible,
    });
    if let (Some(obj), Some(auto_obj)) = (
        out.as_object_mut(),
        automation_settings_snapshot(&s).as_object(),
    ) {
        for (k, v) in auto_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    out
}

/// `GET /left/settings/desktop` → `{defaultApprovalMode, capsuleVisible, ...9 automation settings}`.
async fn desktop_settings<B: Backend>(State(ctx): State<Arc<Ctx<B>>>) -> ApiResult<Value> {
    Ok(Json(desktop_settings_json(app(&ctx)?)))
}

fn parse_automation_result_mode(
    value: &Value,
) -> Result<crate::contracts::ScheduleResultMode, String> {
    match value.as_str() {
        Some("structured") => Ok(crate::contracts::ScheduleResultMode::Structured),
        Some("llm_summary") => Ok(crate::contracts::ScheduleResultMode::LlmSummary),
        _ => Err("automationDefaultResultMode 的取值必须是：structured / llm_summary".into()),
    }
}

fn parse_optional_string_patch(key: &str, value: &Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(format!("{key} 必须是字符串或 null")),
    }
}

fn parse_automation_settings_patch(
    raw: Value,
) -> Result<crate::settings::AutomationSettingsPatch, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "请求体必须是 JSON 对象".to_string())?;
    let mut patch = crate::settings::AutomationSettingsPatch::default();
    for (key, value) in obj {
        match key.as_str() {
            "automationBackgroundEnabled" => {
                patch.automation_background_enabled = Some(
                    value
                        .as_bool()
                        .ok_or_else(|| "automationBackgroundEnabled 必须是布尔值".to_string())?,
                );
            }
            "automationOverlapPolicy" => {
                patch.automation_overlap_policy = Some(automation_overlap_policy(value)?);
            }
            "automationDefaultResultMode" => {
                patch.automation_default_result_mode = Some(parse_automation_result_mode(value)?);
            }
            "automationDefaultModel" => {
                patch.automation_default_model = Some(parse_optional_string_patch(key, value)?);
            }
            "automationDefaultThinking" => {
                patch.automation_default_thinking = Some(parse_optional_string_patch(key, value)?);
            }
            "automationPromptMockTest" => {
                patch.automation_prompt_mock_test = Some(parse_optional_string_patch(key, value)?);
            }
            "automationPromptRealOnceTest" => {
                patch.automation_prompt_real_once_test =
                    Some(parse_optional_string_patch(key, value)?);
            }
            "automationPromptRealLoopTest" => {
                patch.automation_prompt_real_loop_test =
                    Some(parse_optional_string_patch(key, value)?);
            }
            "automationPromptAdjust" => {
                patch.automation_prompt_adjust = Some(parse_optional_string_patch(key, value)?);
            }
            other => {
                return Err(format!("未知的自动化设置字段：{other}"));
            }
        }
    }
    Ok(patch)
}

fn emit_settings_changed(st: &AppState) {
    use tauri::Emitter as _;
    let _ = st.app.emit("settings:changed", ());
}

async fn automation_settings_set<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(raw): Json<Value>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let patch = parse_automation_settings_patch(raw).map_err(bad_request)?;
    let saved = crate::settings::update_automation_settings(st, patch)
        .await
        .map_err(bad_request)?;
    crate::state::emit_schedules_changed(st);
    emit_settings_changed(st);
    Ok(Json(automation_settings_snapshot(&saved)))
}
#[derive(Deserialize)]
struct ApprovalModeBody {
    mode: String,
}

/// `POST /left/settings/approval-mode {mode}` → `{ok, defaultApprovalMode, capsuleVisible}`.
/// Only the desktop `defaultApprovalMode` changes; running sessions keep theirs.
async fn approval_mode_set<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<ApprovalModeBody>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    check_approval_mode(&body.mode).map_err(bad_request)?;
    crate::settings::set_default_approval_mode(st, &body.mode)
        .await
        .map_err(bad_request)?;
    emit_settings_changed(st);
    let mut out = desktop_settings_json(st);
    out["ok"] = json!(true);
    Ok(Json(out))
}

/// Value shape of one phone-editable OMP key.
enum SettingKind {
    Bool,
    Enum(&'static [&'static str]),
    /// Whole number within `min..=max`.
    Int(i64, i64),
}

/// Strict allowlist of OMP config keys writable from the phone. Every key was verified
/// against `omp config list` (type + enum values). Anything else is rejected with 400.
const MOBILE_SETTINGS: &[(&str, SettingKind)] = &[
    (
        "tools.approvalMode",
        SettingKind::Enum(&["always-ask", "write", "yolo"]),
    ),
    ("hideThinkingBlock", SettingKind::Bool),
    ("steeringMode", SettingKind::Enum(&["all", "one-at-a-time"])),
    ("followUpMode", SettingKind::Enum(&["all", "one-at-a-time"])),
    ("interruptMode", SettingKind::Enum(&["immediate", "wait"])),
    ("ask.enabled", SettingKind::Bool),
    ("ask.timeout", SettingKind::Int(0, 3600)),
    ("ask.notify", SettingKind::Enum(&["on", "off"])),
    ("bash.autoBackground.enabled", SettingKind::Bool),
    ("tools.maxTimeout", SettingKind::Int(0, 86_400)),
    ("compaction.enabled", SettingKind::Bool),
    ("compaction.autoContinue", SettingKind::Bool),
    ("retry.enabled", SettingKind::Bool),
    ("retry.maxRetries", SettingKind::Int(0, 100)),
    ("retry.maxDelayMs", SettingKind::Int(0, 3_600_000)),
    ("retry.waitForUsageReset", SettingKind::Bool),
];

/// Validates `value` against the allowlist and returns the string handed to
/// `omp config set`. Unknown keys and mistyped / out-of-range values are errors.
fn validate_mobile_setting(key: &str, value: &Value) -> Result<String, String> {
    let (_, kind) = MOBILE_SETTINGS
        .iter()
        .find(|(k, _)| *k == key)
        .ok_or_else(|| format!("不允许在手机端修改该设置：{key}"))?;
    match kind {
        SettingKind::Bool => value
            .as_bool()
            .map(|b| b.to_string())
            .ok_or_else(|| format!("{key} 需要开关值（true/false）")),
        SettingKind::Enum(options) => match value.as_str() {
            Some(s) if options.contains(&s) => Ok(s.to_string()),
            _ => Err(format!("{key} 的取值必须是：{}", options.join(" / "))),
        },
        SettingKind::Int(min, max) => match value.as_i64() {
            Some(n) if (*min..=*max).contains(&n) => Ok(n.to_string()),
            _ => Err(format!("{key} 需要 {min} 到 {max} 之间的整数")),
        },
    }
}

/// Current values of the allowlisted keys (`None` for unset keys).
async fn read_mobile_settings(st: &AppState) -> Result<serde_json::Map<String, Value>, String> {
    let list = crate::settings::omp_config_list(st.app.state::<AppState>()).await?;
    if !list.found {
        return Err(list.error.unwrap_or_else(|| "无法读取 OMP 配置".into()));
    }
    let mut out = serde_json::Map::new();
    for (key, _) in MOBILE_SETTINGS {
        if let Some(e) = list.entries.iter().find(|e| e.key == *key) {
            out.insert((*key).to_string(), e.value.clone().unwrap_or(Value::Null));
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
struct SettingSetBody {
    key: String,
    value: Value,
}

/// App-settings allowlist entry, intentionally separate from OMP config keys.
fn automation_overlap_policy(
    value: &Value,
) -> Result<crate::contracts::AutomationOverlapPolicy, String> {
    use crate::contracts::AutomationOverlapPolicy;
    match value.as_str() {
        Some("skip") => Ok(AutomationOverlapPolicy::Skip),
        Some("coalesce") => Ok(AutomationOverlapPolicy::Coalesce),
        Some("queue") => Ok(AutomationOverlapPolicy::Queue),
        Some("parallel") => Ok(AutomationOverlapPolicy::Parallel),
        _ => Err("automationOverlapPolicy 的取值必须是：skip / coalesce / queue / parallel".into()),
    }
}

#[cfg(test)]
#[test]
fn global_automation_policy_allowlist_accepts_only_wire_values() {
    for value in ["skip", "coalesce", "queue", "parallel"] {
        let policy = automation_overlap_policy(&json!(value)).unwrap();
        assert_eq!(serde_json::to_value(policy).unwrap(), json!(value));
        // This preference must never be forwarded to `omp config set`.
        assert!(validate_mobile_setting("automationOverlapPolicy", &json!(value)).is_err());
    }
    for value in [
        json!(true),
        json!(1),
        Value::Null,
        json!("Queue"),
        json!("queue "),
        json!(""),
    ] {
        assert!(automation_overlap_policy(&value).is_err());
    }
}

async fn setting_set<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<SettingSetBody>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    if body.key == "automationOverlapPolicy" {
        let policy = automation_overlap_policy(&body.value).map_err(bad_request)?;
        crate::settings::set_automation_overlap_policy(st, policy)
            .await
            .map_err(bad_request)?;
        crate::state::emit_schedules_changed(st);
        emit_settings_changed(st);
        return Ok(Json(
            json!({ "ok": true, "key": body.key, "value": policy }),
        ));
    }
    let value = validate_mobile_setting(&body.key, &body.value).map_err(bad_request)?;
    crate::settings::omp_config_set(st.app.state::<AppState>(), body.key.clone(), value)
        .await
        .map_err(bad_gateway)?;
    emit_settings_changed(st);
    let fresh = read_mobile_settings(st)
        .await
        .ok()
        .and_then(|m| m.get(&body.key).cloned())
        .unwrap_or(body.value);
    Ok(Json(json!({ "ok": true, "key": body.key, "value": fresh })))
}

// ---------- mobile settings: roles / providers / fallbacks / context-windows ----------

async fn roles_get<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Query(q): Query<CwdQuery>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let cwd = authorize_optional_cwd(st, q.cwd.as_deref()).await?;
    let snapshot = crate::settings_model_roles::omp_model_roles_read(cwd, None)
        .await
        .map_err(bad_gateway)?;
    let models = crate::catalog::commands::list_models(st.app.state::<AppState>(), None)
        .await
        .map_err(bad_gateway)?;
    Ok(Json(json!({
        "snapshot": snapshot,
        "models": models.models,
        "catalogSource": models.source,
        "catalogCompleteness": models.completeness,
    })))
}

#[derive(Deserialize)]
struct RoleSetBody {
    cwd: Option<String>,
    scope: String,
    table: String,
    name: String,
    value: Option<String>,
}

async fn roles_set<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<RoleSetBody>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let cwd = authorize_optional_cwd(st, body.cwd.as_deref()).await?;
    let next = crate::settings_model_roles::omp_model_roles_set(
        cwd, body.scope, body.table, body.name, body.value, None,
    )
    .await
    .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "snapshot": next })))
}

async fn providers_get<B: Backend>(State(_ctx): State<Arc<Ctx<B>>>) -> ApiResult<Value> {
    let list = crate::providers::commands::provider_rows()
        .await
        .map_err(bad_gateway)?;
    Ok(Json(json!({ "providers": list })))
}

/// Mobile edits only a custom provider's Base URL and/or its key (written as
/// plaintext into models.yml).
#[derive(Deserialize)]
struct ProviderSaveBody {
    id: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
}

async fn providers_save<B: Backend>(
    State(_ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<ProviderSaveBody>,
) -> ApiResult<Value> {
    use crate::contracts::{ProviderOrigin, ProviderUpsert};
    use crate::providers::commands::{provider_rows, provider_set_key, provider_upsert};
    let rows = provider_rows().await.map_err(bad_request)?;
    let row = rows
        .into_iter()
        .find(|r| r.id == body.id)
        .ok_or_else(|| bad_request("供应商不存在".to_string()))?;
    let mut new_key = body.api_key.filter(|k| !k.trim().is_empty());
    let new_url = body
        .base_url
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty() && Some(u) != row.base_url.as_ref());
    let mut saved = row.clone();
    if let (Some(url), ProviderOrigin::Custom, Some(api)) = (new_url, row.origin, row.api.clone()) {
        let key_for_upsert = new_key.take();
        let auth_none = if key_for_upsert.is_some() {
            false
        } else {
            row.auth_none
        };
        saved = provider_upsert(
            ProviderUpsert {
                original_id: Some(row.id.clone()),
                id: row.id.clone(),
                display_name: row.display_name.clone(),
                base_url: url,
                api,
                models: row.models.clone(),
                auth_none,
                discovery_type: row.discovery_type.clone(),
            },
            key_for_upsert,
        )
        .await
        .map_err(bad_request)?;
    }
    if let Some(key) = new_key {
        saved = provider_set_key(row.id.clone(), key)
            .await
            .map_err(bad_request)?;
    }
    Ok(Json(json!({ "ok": true, "provider": saved })))
}

#[derive(Deserialize)]
struct ProviderTestBody {
    id: String,
    #[serde(default)]
    model_id: Option<String>,
}

async fn providers_test<B: Backend>(
    State(_ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<ProviderTestBody>,
) -> ApiResult<Value> {
    let res = if let Some(m) = body.model_id {
        crate::providers::commands::provider_test_model(body.id, m).await
    } else {
        crate::providers::commands::provider_test(body.id).await
    }
    .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "result": res })))
}

fn validate_chain_scalar(raw: &str, label: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if trimmed.chars().count() > 256 {
        return Err(format!("{label}过长"));
    }
    if trimmed
        .chars()
        .any(|c| c == '"' || c == '\\' || c.is_control())
    {
        return Err(format!("{label}包含非法字符"));
    }
    Ok(trimmed.to_string())
}

fn parse_fallback_chains(raw: &Value) -> Result<BTreeMap<String, Vec<String>>, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "回退链配置必须是 JSON 对象".to_string())?;
    let mut out = BTreeMap::new();
    for (k, v) in obj {
        let key = validate_chain_scalar(k, "回退链源模型")?;
        let arr = v
            .as_array()
            .ok_or_else(|| format!("回退链 {key} 的目标列表必须是数组"))?;
        let mut items = Vec::with_capacity(arr.len());
        for item in arr {
            let s = item
                .as_str()
                .ok_or_else(|| format!("回退链 {key} 的目标必须是字符串"))?;
            items.push(validate_chain_scalar(s, "回退链目标模型")?);
        }
        out.insert(key, items);
    }
    Ok(out)
}

/// Compute lossless `ChainStep` edits (creates & updates before deletes so the
/// `retry.fallbackChains` header stays intact while entries remain).
fn build_chain_steps(
    current: &BTreeMap<String, Vec<String>>,
    desired: &BTreeMap<String, Vec<String>>,
) -> Vec<Vec<crate::settings_model_roles::ChainStep>> {
    use crate::settings_model_roles::ChainStep;
    let mut steps = Vec::new();
    for (key, new_items) in desired {
        match current.get(key) {
            None => steps.push(vec![ChainStep {
                key: key.clone(),
                before: None,
                after: Some(new_items.clone()),
            }]),
            Some(old_items) if old_items != new_items => steps.push(vec![ChainStep {
                key: key.clone(),
                before: Some(old_items.clone()),
                after: Some(new_items.clone()),
            }]),
            Some(_) => {}
        }
    }
    for (key, old_items) in current {
        if !desired.contains_key(key) {
            steps.push(vec![ChainStep {
                key: key.clone(),
                before: Some(old_items.clone()),
                after: None,
            }]);
        }
    }
    steps
}

async fn fallbacks_get<B: Backend>(
    State(ctx): State<Arc<Ctx<B>>>,
    Query(q): Query<CwdQuery>,
) -> ApiResult<Value> {
    let st = app(&ctx)?;
    let cwd = authorize_optional_cwd(st, q.cwd.as_deref()).await?;
    let global_chains = tokio::task::spawn_blocking(crate::settings_model_roles::read_chains)
        .await
        .map_err(|e| bad_gateway(e.to_string()))?
        .map_err(bad_gateway)?;

    let project_chains = if let Some(cwd) = cwd {
        if let Ok(p_cfg) = crate::settings::omp_project_config_read(cwd).await {
            if p_cfg.exists {
                serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&p_cfg.content)
                    .ok()
                    .and_then(|v| {
                        v.get("retry")
                            .and_then(|r| r.get("fallbackChains"))
                            .cloned()
                    })
                    .and_then(|c| serde_json::to_value(c).ok())
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    Ok(Json(json!({
        "global": global_chains,
        "project": project_chains,
    })))
}

#[derive(Deserialize)]
struct FallbackSetBody {
    chains: Value,
}

async fn fallbacks_set<B: Backend>(
    State(_ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<FallbackSetBody>,
) -> ApiResult<Value> {
    let desired = parse_fallback_chains(&body.chains).map_err(bad_request)?;
    tokio::task::spawn_blocking(move || {
        crate::settings_model_roles::edit_chains(|current| build_chain_steps(current, &desired))
    })
    .await
    .map_err(|e| bad_gateway(e.to_string()))?
    .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true })))
}

async fn context_windows_get<B: Backend>(State(_ctx): State<Arc<Ctx<B>>>) -> ApiResult<Value> {
    let overrides = crate::providers::models_yml_write::omp_models_context_window_overrides()
        .await
        .map_err(bad_gateway)?;
    Ok(Json(json!({ "overrides": overrides })))
}

#[derive(Deserialize)]
struct ContextWindowsSetBody {
    entries: Vec<crate::contracts::ModelContextWindowEdit>,
}

async fn context_windows_set<B: Backend>(
    State(_ctx): State<Arc<Ctx<B>>>,
    Json(body): Json<ContextWindowsSetBody>,
) -> ApiResult<Value> {
    crate::providers::models_yml_write::omp_models_set_context_windows(body.entries, None)
        .await
        .map_err(bad_request)?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::GitBadge;

    #[tokio::test]
    async fn new_session_selection_lands_on_the_draft() {
        let body: NewSessionBody = serde_json::from_value(json!({
            "cwd": "/x",
            "model": {"provider": "anthropic", "modelId": "opus"},
            "thinking": " High "
        }))
        .unwrap();
        let (model, thinking) = parse_new_selection(&body).unwrap();
        assert_eq!(model, Some(("anthropic".into(), "opus".into())));
        assert_eq!(thinking.as_deref(), Some("high"));

        let info = super::super::draft::create(
            "/tmp/left-selection-test".into(),
            SpaceMode::Code,
            None,
            None,
        )
        .await;
        let (p, m) = model.unwrap();
        super::super::draft::set_model(&info.session_id, p, m).await;
        super::super::draft::set_thinking(&info.session_id, thinking.unwrap()).await;
        let sel = super::super::draft::selection(&info.session_id)
            .await
            .unwrap();
        assert_eq!(sel.model, Some(("anthropic".into(), "opus".into())));
        assert_eq!(sel.thinking.as_deref(), Some("high"));
        super::super::draft::discard(&info.session_id).await;

        for bad in [
            json!({"cwd": "/x", "model": {"provider": "", "modelId": "m"}}),
            json!({"cwd": "/x", "thinking": "a b"}),
        ] {
            let body: NewSessionBody = serde_json::from_value(bad).unwrap();
            assert!(parse_new_selection(&body).is_err());
        }
        let none: NewSessionBody = serde_json::from_value(json!({"cwd": "/x"})).unwrap();
        assert_eq!(parse_new_selection(&none).unwrap(), (None, None));
    }

    #[test]
    fn approval_mode_allowlist_matches_settings_validation() {
        for mode in APPROVAL_MODES {
            let s = crate::contracts::Settings {
                default_approval_mode: (*mode).to_string(),
                ..Default::default()
            };
            assert!(crate::settings::validate(&s).is_ok(), "{mode}");
        }
        for bad in ["", "ask", "YOLO", "yolo ", "always_ask", "never"] {
            assert!(check_approval_mode(bad).is_err(), "{bad}");
        }
        assert!(check_approval_mode("yolo").is_ok());
    }

    #[test]
    fn mobile_setting_allowlist_rejects_unknown_keys() {
        for key in [
            "modelRoles",
            "extensions",
            "shellPath",
            "ask.enabled ",
            "",
            "-x",
        ] {
            assert!(validate_mobile_setting(key, &json!(true)).is_err(), "{key}");
        }
    }

    #[test]
    fn mobile_setting_validates_types_and_ranges() {
        assert_eq!(
            validate_mobile_setting("hideThinkingBlock", &json!(true)).unwrap(),
            "true"
        );
        assert!(validate_mobile_setting("hideThinkingBlock", &json!("true")).is_err());
        assert_eq!(
            validate_mobile_setting("steeringMode", &json!("all")).unwrap(),
            "all"
        );
        assert!(validate_mobile_setting("steeringMode", &json!("both")).is_err());
        assert!(validate_mobile_setting("steeringMode", &json!(1)).is_err());
        assert_eq!(
            validate_mobile_setting("retry.maxRetries", &json!(0)).unwrap(),
            "0"
        );
        assert!(validate_mobile_setting("retry.maxRetries", &json!(-1)).is_err());
        assert!(validate_mobile_setting("retry.maxRetries", &json!(101)).is_err());
        assert!(validate_mobile_setting("retry.maxRetries", &json!(1.5)).is_err());
        assert!(validate_mobile_setting("ask.timeout", &json!("5")).is_err());
    }

    #[test]
    fn mobile_setting_allowlist_has_no_duplicates() {
        let mut keys: Vec<_> = MOBILE_SETTINGS.iter().map(|(k, _)| *k).collect();
        keys.sort_unstable();
        let n = keys.len();
        keys.dedup();
        assert_eq!(n, keys.len());
    }

    fn meta(id: &str, cwd: &str, ts: &str) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            cwd: cwd.into(),
            title: id.into(),
            updated_at: ts.into(),
            created_at: ts.into(),
            ..Default::default()
        }
    }

    fn git(m: &mut SessionMeta, branch: Option<&str>, wt: Option<&str>) {
        m.git = Some(GitBadge {
            branch: branch.map(Into::into),
            dirty: 0,
            worktree: wt.map(Into::into),
        });
    }

    #[test]
    fn inside_is_component_wise() {
        assert!(is_inside("/a/b", "/a/b"));
        assert!(is_inside("/a/b/c", "/a/b/"));
        assert!(!is_inside("/a/bc", "/a/b"));
        assert!(!is_inside("/a", ""));
        assert!(is_inside_canon("/private/tmp/x/y", "/tmp/x"));
    }

    #[test]
    fn infers_worktree_names() {
        assert_eq!(
            infer_worktree_name("/r/.worktrees/feat/sub"),
            Some("feat".into())
        );
        assert_eq!(
            infer_worktree_name("/r/.cache/wt-abc"),
            Some("wt-abc".into())
        );
        assert_eq!(infer_worktree_name("/r/.cache/other"), None);
        assert_eq!(infer_worktree_name("/r/.worktrees"), None);
    }

    #[test]
    fn search_is_and_over_tokens_and_cwd_is_relative() {
        let mut s = meta("a", "/ws/app/pkg", "2026-01-01T00:00:00Z");
        s.title = "Fix login".into();
        git(&mut s, Some("feat/auth"), None);
        assert!(matches_search(&s, "login auth", Some("/ws/app")));
        assert!(matches_search(&s, "pkg", Some("/ws/app")));
        assert!(!matches_search(&s, "login nothere", Some("/ws/app")));
        // The shared absolute prefix must not match.
        assert!(!matches_search(&s, "ws", Some("/ws/app")));
        assert!(matches_search(&s, "  ", None));
    }

    #[test]
    fn archive_cascades_to_idle_children_only() {
        let mut parent = meta("p", "/x", "2026-01-01T00:00:00Z");
        parent.archived = true;
        let mut idle = meta("c", "/x", "2026-01-01T00:00:00Z");
        idle.parent_id = Some("p".into());
        let mut busy = meta("d", "/x", "2026-01-01T00:00:00Z");
        busy.parent_id = Some("p".into());
        busy.status = SessionStatus::Working;
        let all = [parent.clone(), idle.clone(), busy.clone()];
        let by_id: HashMap<&str, &SessionMeta> = all.iter().map(|s| (s.id.as_str(), s)).collect();
        assert!(is_archived_cascaded(&parent, &by_id));
        assert!(is_archived_cascaded(&idle, &by_id));
        assert!(!is_archived_cascaded(&busy, &by_id));
    }

    #[test]
    fn empty_side_chat_detection() {
        let mut s = meta("f", "/x", "2026-01-01T00:00:00Z");
        s.title = String::new();
        s.parent_id = Some("p".into());
        s.kind = Some("side".into());
        assert!(is_empty_side_chat(&s));
        s.unread = true;
        assert!(!is_empty_side_chat(&s));
    }

    #[test]
    fn subgroups_attach_by_deepest_cwd_and_flag_deleted() {
        let wts = vec![
            Wt {
                path: "/r".into(),
                branch: Some("main".into()),
                session_ids: vec![],
            },
            Wt {
                path: "/r/.worktrees/feat".into(),
                branch: Some("feat".into()),
                session_ids: vec![],
            },
        ];
        let a = meta("a", "/r/src", "2026-01-02T00:00:00Z");
        let b = meta("b", "/r/.worktrees/feat/x", "2026-01-03T00:00:00Z");
        let c = meta("c", "/r/.worktrees/gone", "2026-01-04T00:00:00Z");
        let subs = build_subgroups(&[&a, &b, &c], Some(&wts));
        let find = |k: &str| subs.iter().find(|s| s.key == k).unwrap();
        assert_eq!(find("wtp:/r").sessions[0].id, "a");
        assert_eq!(find("wtp:/r/.worktrees/feat").sessions[0].id, "b");
        assert!(find("wt:gone").deleted);
        assert!(subs.last().unwrap().deleted);
        assert!(subs[0].is_main);
    }

    #[test]
    fn subgroups_fall_back_to_branch_buckets_without_worktree_list() {
        let mut a = meta("a", "/r", "2026-01-02T00:00:00Z");
        git(&mut a, Some("dev"), None);
        let b = meta("b", "/r", "2026-01-01T00:00:00Z");
        let subs = build_subgroups(&[&a, &b], None);
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].key, "br:dev");
        assert!(subs[0].is_main);
        assert_eq!(subs[1].kind, "default");
    }

    #[test]
    fn inbox_window_rules() {
        let now = DateTime::parse_from_rfc3339("2026-01-10T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mk = |id: &str, k: Attention, ts: &str| {
            let mut s = meta(id, "/x", ts);
            s.attention = Some(k);
            s.created_by_app = true;
            s
        };
        let metas = [
            mk("old-aw", Attention::Awaiting, "2025-01-01T00:00:00Z"),
            mk("old-un", Attention::Unread, "2025-01-01T00:00:00Z"),
            mk("new-un", Attention::Unread, "2026-01-09T23:00:00Z"),
            mk("run", Attention::Running, "2025-01-01T00:00:00Z"),
            {
                let mut s = mk("arch", Attention::Error, "2026-01-09T23:00:00Z");
                s.archived = true;
                s
            },
            {
                // Plain-CLI session: never part of the app inbox.
                let mut s = mk("cli", Attention::Awaiting, "2026-01-09T23:00:00Z");
                s.created_by_app = false;
                s
            },
        ];
        let g = group_inbox(&metas, now, 24);
        assert_eq!(g.awaiting.len(), 1);
        assert_eq!(g.unread.len(), 1);
        assert_eq!(g.unread[0].id, "new-un");
        assert_eq!(g.running.len(), 1);
        assert!(g.error.is_empty());
        assert_eq!(g.badge, 2);
    }

    #[test]
    fn glob_matching() {
        assert!(glob_match("foo*", "foobar"));
        assert!(glob_match("f?o", "foo"));
        assert!(glob_match("*", ""));
        assert!(glob_match("a**c", "abbbc"));
        assert!(!glob_match("foo", "foobar"));
        assert!(!glob_match("a?", "a"));
    }

    #[test]
    fn skill_enablement_pipeline() {
        let mut cfg = SkillConfig::default();
        assert!(skill_enablement("x", "native", "user", &cfg).is_ok());
        cfg.disabled_extensions = vec!["skill:x".into()];
        assert_eq!(
            skill_enablement("x", "native", "user", &cfg).unwrap_err()["kind"],
            "disabled"
        );
        cfg.disabled_extensions.clear();
        cfg.source_toggles
            .insert("skills.enablePiUser".into(), false);
        assert_eq!(
            skill_enablement("x", "native", "user", &cfg).unwrap_err()["kind"],
            "source"
        );
        assert!(skill_enablement("x", "github", "project", &cfg).is_ok());
        cfg.source_toggles.clear();
        cfg.ignored = vec!["t*".into()];
        let e = skill_enablement("tool", "native", "user", &cfg).unwrap_err();
        assert_eq!(
            (e["kind"].as_str(), e["exact"].as_bool()),
            (Some("ignored"), Some(false))
        );
        cfg.ignored.clear();
        cfg.include = vec!["only".into()];
        assert_eq!(
            skill_enablement("x", "native", "user", &cfg).unwrap_err()["kind"],
            "not_included"
        );
        cfg.skills_enabled = false;
        assert_eq!(
            skill_enablement("only", "native", "user", &cfg).unwrap_err()["kind"],
            "all_off"
        );
    }

    #[test]
    fn toggle_helpers() {
        let (d, i) = apply_skill_toggle(&["skill:a".into()], &["a".into(), "b".into()], "a", true);
        assert!(d.is_empty());
        assert_eq!(i, Some(vec!["b".to_string()]));
        let (d, i) = apply_skill_toggle(&["skill:a".into()], &[], "a", false);
        assert_eq!(d, vec!["skill:a".to_string()]);
        assert!(i.is_none());
        let off = apply_extension_toggle(&[], "ext", "/p/ext", false);
        assert_eq!(off, vec!["ext".to_string()]);
        let on = apply_extension_toggle(
            &[
                "ext".into(),
                "extension-module:ext".into(),
                "/p/ext".into(),
                "keep".into(),
            ],
            "ext",
            "/p/ext",
            true,
        );
        assert_eq!(on, vec!["keep".to_string()]);
    }

    #[test]
    fn resolve_dir_prefers_deepest_root() {
        let mk = |p: &str, kind: &'static str| DirEntry {
            path: p.into(),
            label: p.into(),
            kind,
            workspace_id: "w".into(),
            mode: SpaceMode::Code,
            canon: PathBuf::from(p),
        };
        let dirs = [mk("/r", "workspace"), mk("/r/.worktrees/f", "worktree")];
        assert_eq!(
            resolve_dir(FsPath::new("/r/.worktrees/f/x"), &dirs)
                .unwrap()
                .kind,
            "worktree"
        );
        assert_eq!(
            resolve_dir(FsPath::new("/r/y"), &dirs).unwrap().kind,
            "workspace"
        );
        assert!(resolve_dir(FsPath::new("/rr"), &dirs).is_none());
        assert!(resolve_dir(FsPath::new("/"), &dirs).is_none());
    }

    #[test]
    fn sort_recent_orders_descending_by_timestamp_and_breaks_ties_by_id() {
        let mut list = vec![
            meta("b", "/x", "2026-01-01T00:00:00Z"),
            meta("c", "/x", "2026-01-03T00:00:00Z"),
            meta("a", "/x", "2026-01-01T00:00:00Z"),
            meta("d", "/x", "2026-01-02T00:00:00Z"),
        ];
        sort_recent(&mut list);
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["c", "d", "a", "b"]);
    }

    #[tokio::test]
    async fn confine_cwd_rejects_unregistered_dirs_and_symlink_escapes() {
        let base = std::env::temp_dir().join(format!("omp-left-confine-{}", uuid::Uuid::new_v4()));
        let ws = base.join("ws");
        let inside = ws.join("sub");
        let outside = base.join("outside");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let ws_canon = std::fs::canonicalize(&ws).unwrap();
        let dirs = vec![DirEntry {
            path: ws.to_string_lossy().into_owned(),
            label: "ws".into(),
            kind: "workspace",
            workspace_id: "w1".into(),
            mode: SpaceMode::Code,
            canon: ws_canon,
        }];

        assert!(confine_cwd(&inside.to_string_lossy(), &dirs).await.is_ok());
        assert!(confine_cwd(&outside.to_string_lossy(), &dirs)
            .await
            .is_err());

        #[cfg(unix)]
        {
            let escape = ws.join("escape-link");
            std::os::unix::fs::symlink(&outside, &escape).unwrap();
            assert!(confine_cwd(&escape.to_string_lossy(), &dirs).await.is_err());
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fallback_chain_parsing_and_step_diffing() {
        assert!(parse_fallback_chains(&json!(["not-object"])).is_err());
        assert!(parse_fallback_chains(&json!({"": ["a/b"]})).is_err());
        assert!(parse_fallback_chains(&json!({"a/b": "not-array"})).is_err());
        assert!(parse_fallback_chains(&json!({"a/b": ["bad\"quote"]})).is_err());

        let current = BTreeMap::from([
            ("m1".to_string(), vec!["f1".to_string()]),
            ("m2".to_string(), vec!["f2".to_string()]),
        ]);
        let desired = parse_fallback_chains(&json!({
            "m2": ["f2", "f3"],
            "m3": ["f4"],
        }))
        .unwrap();
        let steps = build_chain_steps(&current, &desired);
        // Creates/updates precede deletes.
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0][0].key, "m2");
        assert_eq!(steps[0][0].after, Some(vec!["f2".into(), "f3".into()]));
        assert_eq!(steps[1][0].key, "m3");
        assert_eq!(steps[1][0].before, None);
        assert_eq!(steps[2][0].key, "m1");
        assert_eq!(steps[2][0].after, None);
    }

    #[test]
    fn automation_settings_patch_parser_validates_all_9_fields() {
        let ok = parse_automation_settings_patch(json!({
            "automationBackgroundEnabled": false,
            "automationOverlapPolicy": "coalesce",
            "automationDefaultResultMode": "llm_summary",
            "automationDefaultModel": "openai/gpt-5",
            "automationDefaultThinking": "medium",
            "automationPromptMockTest": "m",
            "automationPromptRealOnceTest": "o",
            "automationPromptRealLoopTest": "l",
            "automationPromptAdjust": null,
        }))
        .unwrap();
        assert_eq!(ok.automation_background_enabled, Some(false));
        assert_eq!(ok.automation_prompt_adjust, Some(None));

        assert!(parse_automation_settings_patch(json!({
            "automationDefaultResultMode": "invalid"
        }))
        .is_err());
        assert!(parse_automation_settings_patch(json!({
            "automationBackgroundEnabled": "true"
        }))
        .is_err());
        assert!(parse_automation_settings_patch(json!({
            "unknownField": 1
        }))
        .is_err());

        let mut s = crate::contracts::Settings::default();
        crate::settings::apply_automation_patch(&mut s, ok);
        let snap = automation_settings_snapshot(&s);
        assert_eq!(snap["automationBackgroundEnabled"], false);
        assert_eq!(snap["automationOverlapPolicy"], "coalesce");
        assert_eq!(snap["automationDefaultResultMode"], "llm_summary");
        assert_eq!(snap["automationDefaultModel"], "openai/gpt-5");
        assert_eq!(snap["automationDefaultThinking"], "medium");
        assert_eq!(snap["automationPromptMockTest"], "m");
        assert_eq!(snap["automationPromptRealOnceTest"], "o");
        assert_eq!(snap["automationPromptRealLoopTest"], "l");
        assert_eq!(snap["automationPromptAdjust"], Value::Null);
    }

    #[tokio::test]
    async fn validate_draft_checks_approval_mode_and_preserves_full_fields() {
        let base = std::env::temp_dir().join(format!("omp-left-sched-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, path, name, kind, sort, mode, created_at)
             VALUES('w1', ?1, 'ws', 'project', 0, 'code', '2026-01-01T00:00:00Z')",
            rusqlite::params![base.to_string_lossy().as_ref()],
        )
        .unwrap();
        let db = parking_lot::Mutex::new(conn);

        let mut bad_draft = ScheduleDraft {
            id: Some("staged-1".into()),
            name: "Probe".into(),
            prompt: "".into(),
            cwd: base.to_string_lossy().into_owned(),
            mode: SpaceMode::Code,
            run_mode: crate::contracts::ScheduleRunMode::Local,
            cadence: crate::contracts::ScheduleCadence::Interval { minutes: 5 },
            model: None,
            thinking: None,
            approval_mode: Some("invalid-mode".into()),
            notify: crate::contracts::ScheduleNotify::All,
            new_chat_each_run: true,
            end_at: None,
            max_runs: None,
            enabled: true,
            probe_command: Some("echo ok".into()),
            probe_description: Some("desc".into()),
            agent_trigger: crate::contracts::ScheduleAgentTrigger::Never,
            result_mode: crate::contracts::ScheduleResultMode::LlmSummary,
            invokes_external_model: true,
        };
        assert!(validate_draft(&db, &mut bad_draft).await.is_err());

        bad_draft.approval_mode = Some("write".into());
        validate_draft(&db, &mut bad_draft).await.unwrap();
        assert_eq!(bad_draft.approval_mode.as_deref(), Some("write"));

        // Empty approval mode normalizes to None.
        bad_draft.approval_mode = Some("  ".into());
        validate_draft(&db, &mut bad_draft).await.unwrap();
        assert!(bad_draft.approval_mode.is_none());

        assert!(validate_schedule_id("../escape").is_err());
        assert!(validate_schedule_id("auto-123_ok").is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn automation_worktree_merge_commits_merges_and_aborts_cleanly_on_conflict() {
        let base = std::env::temp_dir().join(format!("omp-left-wt-merge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let git = |dir: &FsPath, args: &[&str]| -> bool {
            std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !git(&base, &["init", "-q", "-b", "main"]) {
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        assert!(git(&base, &["config", "user.name", "t"]));
        assert!(git(&base, &["config", "user.email", "t@example.com"]));
        assert!(git(&base, &["config", "commit.gpgsign", "false"]));
        std::fs::write(base.join("shared.txt"), "base\n").unwrap();
        assert!(git(&base, &["add", "-A"]));
        assert!(git(&base, &["commit", "-q", "-m", "init"]));

        // 1. Clean merge commits dirty worktree changes and removes the worktree.
        let wt1 = crate::git::worktree::create(&base, "sched-demo-run12345", None, None).unwrap();
        std::fs::write(FsPath::new(&wt1.path).join("new.txt"), "from-auto\n").unwrap();
        let state1 = AutomationWorktreeState {
            repo_root: base.to_string_lossy().into_owned(),
            worktree_path: wt1.path.clone(),
            branch: wt1.branch.clone().unwrap(),
            ahead: 0,
            dirty: 1,
            committed_diff: String::new(),
            uncommitted_diff: String::new(),
            combined_diff: String::new(),
            added_lines: 1,
            removed_lines: 0,
            run_id: Some("run12345-0000".into()),
            session_id: None,
        };
        merge_automation_worktree_step("Nightly Check", state1, |repo, path| async move {
            crate::git::worktree::remove(FsPath::new(&repo), FsPath::new(&path), true, false)
        })
        .await
        .unwrap();
        assert!(!FsPath::new(&wt1.path).exists());
        assert_eq!(std::fs::read_to_string(base.join("new.txt")).unwrap(), "from-auto\n");

        // 2. Conflicting merge must abort BEFORE removing the worktree.
        let wt2 = crate::git::worktree::create(&base, "sched-demo-run67890", None, None).unwrap();
        std::fs::write(FsPath::new(&wt2.path).join("shared.txt"), "worktree-side\n").unwrap();
        std::fs::write(base.join("shared.txt"), "main-side\n").unwrap();
        assert!(git(&base, &["add", "shared.txt"]));
        assert!(git(&base, &["commit", "-q", "-m", "main edit"]));

        let removed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let removed_flag = removed.clone();
        let state2 = AutomationWorktreeState {
            repo_root: base.to_string_lossy().into_owned(),
            worktree_path: wt2.path.clone(),
            branch: wt2.branch.clone().unwrap(),
            ahead: 0,
            dirty: 1,
            committed_diff: String::new(),
            uncommitted_diff: String::new(),
            combined_diff: String::new(),
            added_lines: 1,
            removed_lines: 1,
            run_id: Some("run67890-0000".into()),
            session_id: None,
        };
        let err = merge_automation_worktree_step("Conflict Check", state2, move |repo, path| {
            let flag = removed_flag.clone();
            async move {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                crate::git::worktree::remove(FsPath::new(&repo), FsPath::new(&path), true, false)
            }
        })
        .await
        .unwrap_err();
        assert!(!err.1.is_empty());
        assert!(!removed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(FsPath::new(&wt2.path).exists());

        let _ = git(&base, &["merge", "--abort"]);
        // 3. Discard force-removes dirty unmerged worktree and deletes its branch.
        crate::git::worktree::remove(&base, FsPath::new(&wt2.path), true, true).unwrap();
        assert!(!FsPath::new(&wt2.path).exists());
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn find_automation_worktree_requires_worktree_mode_sched_branch_and_prefers_actionable() {
        use crate::contracts::{
            ScheduleRun, ScheduleRunMode, ScheduleRunPhase, ScheduleRunStatus, WorktreeInfo,
        };
        let mk_run = |id: &str| ScheduleRun {
            id: id.into(),
            schedule_id: "s1".into(),
            session_id: Some(format!("sess-{id}")),
            status: ScheduleRunStatus::Ok,
            started_at: "2026-01-01T00:00:00Z".into(),
            finished_at: None,
            summary: None,
            phase: ScheduleRunPhase::Agent,
            probe_output: None,
        };
        let runs = vec![mk_run("runnewer-000"), mk_run("runolder-000")];
        let worktrees = vec![
            WorktreeInfo {
                path: "/repo".into(),
                branch: Some("main".into()),
                head: "h0".into(),
                dirty: 0,
                session_ids: vec![],
                ahead: 0,
                behind: 0,
            },
            // Ordinary linked checkout NOT created by automation: must NEVER be claimed even if session_ids match.
            WorktreeInfo {
                path: "/repo/.worktrees/feature-x".into(),
                branch: Some("omp/feature-x".into()),
                head: "h1".into(),
                dirty: 3,
                session_ids: vec!["sess-runnewer-000".into()],
                ahead: 2,
                behind: 0,
            },
            // Newer clean automation worktree.
            WorktreeInfo {
                path: "/repo/.worktrees/sched-a-runnewer".into(),
                branch: Some("omp/sched-a-runnewer".into()),
                head: "h2".into(),
                dirty: 0,
                session_ids: vec![],
                ahead: 0,
                behind: 0,
            },
            // Older dirty/ahead automation worktree: must NOT be hidden by newer clean worktree.
            WorktreeInfo {
                path: "/repo/.worktrees/sched-a-runolder".into(),
                branch: Some("omp/sched-a-runolder".into()),
                head: "h3".into(),
                dirty: 1,
                session_ids: vec![],
                ahead: 1,
                behind: 0,
            },
        ];

        // H1: Local mode never claims any worktree.
        assert!(
            find_automation_worktree("/repo", ScheduleRunMode::Local, &worktrees, &runs)
                .is_none()
        );

        // M9: Worktree mode picks older actionable worktree over newer clean worktree.
        let (picked, picked_run) =
            find_automation_worktree("/repo", ScheduleRunMode::Worktree, &worktrees, &runs)
                .unwrap();
        assert_eq!(picked.path, "/repo/.worktrees/sched-a-runolder");
        assert_eq!(picked_run.id, "runolder-000");

        // H1: Without sched-<run_prefix> branch proof, ordinary linked checkout is never claimed.
        let non_sched_only = &worktrees[..2];
        assert!(
            find_automation_worktree("/repo", ScheduleRunMode::Worktree, non_sched_only, &runs)
                .is_none()
        );
    }

    #[test]
    fn generate_draft_body_defaults_preview_to_false_and_parses_true() {
        let plain: GenerateDraftBody =
            serde_json::from_value(json!({ "request": "check", "cwd": "/repo" })).unwrap();
        assert!(!plain.preview);
        let preview: GenerateDraftBody = serde_json::from_value(
            json!({ "request": "check", "cwd": "/repo", "preview": true }),
        )
        .unwrap();
        assert!(preview.preview);
    }
}

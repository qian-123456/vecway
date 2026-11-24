//! Process-free mobile new-session drafts.
//!
//! A draft owns its model/thinking choices and, after the first meaningful
//! input, at most one omp process. The first successful prompt replaces the
//! draft id with omp's real session id in the mobile UI.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock};

use crate::contracts::{LiveSessionInfo, SessionMeta, SessionStatus, SpaceMode, StartOpts};
use crate::mobile::backend::Backend;
use crate::mobile::server::{ApiError, Ctx};
use crate::state::AppState;

const DRAFT_PREFIX: &str = "mobile-draft-";
const GUARD_OWNER: &str = "mobile-draft";

#[derive(Default, Clone)]
pub struct Selection {
    pub model: Option<(String, String)>,
    pub thinking: Option<String>,
    pub automation_mode: bool,
}

struct Draft {
    id: String,
    cwd: String,
    mode: SpaceMode,
    group_id: Option<String>,
    workspace_id: Option<String>,
    append_system_prompt: Option<String>,
    automation_mode: bool,
    created_at: String,
    selection: Selection,
    dirty: bool,
    sending: bool,
    activity: Option<crate::rpc::SessionActivityGuard>,
    start: Arc<tokio::sync::Mutex<Option<LiveSessionInfo>>>,
}

type Entry = Arc<parking_lot::Mutex<Draft>>;

#[derive(Default)]
struct Registry {
    drafts: HashMap<String, Entry>,
}

static REGISTRY: LazyLock<parking_lot::Mutex<Registry>> =
    LazyLock::new(|| parking_lot::Mutex::new(Registry::default()));

fn registry() -> &'static parking_lot::Mutex<Registry> {
    &REGISTRY
}

/// Every draft as a session row, so unsent drafts stay navigable in lists.
pub async fn all_metas() -> Vec<SessionMeta> {
    let ids: Vec<String> = registry().lock().drafts.keys().cloned().collect();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(m) = meta(&id).await {
            out.push(m);
        }
    }
    out
}

/// `(draft_id, cwd)` pairs for drafts that are actively handing off, spawning a
/// prewarmed session, or holding a live session activity guard.
pub async fn active_cwds() -> Vec<(String, String)> {
    let entries: Vec<Entry> = registry().lock().drafts.values().cloned().collect();
    let mut out = Vec::new();
    for entry in entries {
        let (id, cwd, busy, start) = {
            let d = entry.lock();
            (
                d.id.clone(),
                d.cwd.clone(),
                d.sending || d.activity.is_some(),
                d.start.clone(),
            )
        };
        let spawning_or_live = if busy {
            true
        } else {
            match start.try_lock() {
                Err(_) => true,
                Ok(slot) => slot.is_some(),
            }
        };
        if spawning_or_live {
            out.push((id, cwd));
        }
    }
    out
}

/// Drop a draft the user abandoned and release its prewarmed process.
pub async fn discard(id: &str) -> bool {
    let Some(entry) = registry().lock().drafts.remove(id) else {
        return false;
    };
    let start = entry.lock().start.clone();
    let info = start.lock().await.clone();
    entry.lock().activity = None;
    if let Some(info) = info {
        if let Some(handle) = crate::rpc::get_handle(&info.session_id) {
            let _ = crate::rpc::stop(&handle).await;
        }
    }
    true
}

/// Session metadata for a real session or, failing that, a live draft.
/// Every route that takes a session id resolves it through here so a draft
/// is never reported as 「会话不存在」.
pub async fn find_session<B: Backend>(backend: &B, id: &str) -> Option<SessionMeta> {
    match backend.session(id).await {
        Some(m) => Some(m),
        None => meta(id).await,
    }
}

pub fn is_draft(id: &str) -> bool {
    registry().lock().drafts.contains_key(id)
}

fn entry(id: &str) -> Option<Entry> {
    registry().lock().drafts.get(id).cloned()
}

pub async fn meta(id: &str) -> Option<SessionMeta> {
    let entry = entry(id)?;
    let start = entry.lock().start.clone();
    let live = start.lock().await.is_some();
    let d = entry.lock();
    Some(SessionMeta {
        id: d.id.clone(),
        tool: "omp".into(),
        cwd: d.cwd.clone(),
        title: "新会话".into(),
        created_at: d.created_at.clone(),
        updated_at: d.created_at.clone(),
        status: SessionStatus::Idle,
        live,
        mode: d.mode,
        group_id: d.group_id.clone(),
        workspace_id: d.workspace_id.clone(),
        created_by_app: true,
        model: d.selection.model.as_ref().map(|(p, m)| format!("{p}/{m}")),
        ..Default::default()
    })
}

/// Reuse only a genuinely blank, closed draft in exactly the same context.
pub async fn create(
    cwd: String,
    mode: SpaceMode,
    group_id: Option<String>,
    workspace_id: Option<String>,
) -> LiveSessionInfo {
    create_with_context(cwd, mode, group_id, workspace_id, None, false).await
}

/// Create a new draft with optional hidden system prompt and automation-mode launch context.
/// Drafts carrying either never reuse a plain blank draft (nor are reused by one).
pub async fn create_with_context(
    cwd: String,
    mode: SpaceMode,
    group_id: Option<String>,
    workspace_id: Option<String>,
    append_system_prompt: Option<String>,
    automation_mode: bool,
) -> LiveSessionInfo {
    let append_system_prompt = append_system_prompt
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let has_context = append_system_prompt.is_some() || automation_mode;
    if !has_context {
        let candidates: Vec<Entry> = registry().lock().drafts.values().cloned().collect();
        for existing in candidates {
            let (matches, start) = {
                let d = existing.lock();
                (
                    !d.dirty
                        && d.activity.is_none()
                        && !d.sending
                        && !d.automation_mode
                        && d.append_system_prompt.is_none()
                        && d.cwd == cwd
                        && d.mode == mode
                        && d.group_id == group_id,
                    d.start.clone(),
                )
            };
            if matches && start.lock().await.is_none() {
                let d = existing.lock();
                return LiveSessionInfo {
                    session_id: d.id.clone(),
                    cwd: d.cwd.clone(),
                    ..Default::default()
                };
            }
        }
    }
    let id = format!("{DRAFT_PREFIX}{}", uuid::Uuid::new_v4());
    let draft = Draft {
        id: id.clone(),
        cwd: cwd.clone(),
        mode,
        group_id,
        workspace_id,
        append_system_prompt,
        automation_mode,
        created_at: chrono::Utc::now().to_rfc3339(),
        selection: Selection {
            model: None,
            thinking: None,
            automation_mode,
        },
        dirty: false,
        sending: false,
        activity: None,
        start: Arc::new(tokio::sync::Mutex::new(None)),
    };
    registry()
        .lock()
        .drafts
        .insert(id.clone(), Arc::new(parking_lot::Mutex::new(draft)));
    LiveSessionInfo {
        session_id: id,
        cwd,
        ..Default::default()
    }
}

async fn spawn<B: Backend>(ctx: &Ctx<B>, entry: &Entry) -> Result<LiveSessionInfo, String> {
    let (opts, start) = {
        let d = entry.lock();
        (
            StartOpts {
                cwd: d.cwd.clone(),
                mode: Some(d.mode),
                group_id: d.group_id.clone(),
                append_system_prompt: d.append_system_prompt.clone(),
                ..Default::default()
            },
            d.start.clone(),
        )
    };
    // This lock is the single flight for both prewarm and immediate send.
    let mut slot = start.lock().await;
    if let Some(info) = slot.as_ref() {
        return Ok(info.clone());
    }
    {
        let _mutation = crate::catalog::session_mutation_lock().lock().await;
        if crate::git::commands::is_worktree_reserved(&opts.cwd) {
            return Err("该工作树正在合并或清理，请稍后再试".to_string());
        }
    }
    let info = ctx.backend.start_process(&opts).await?;
    let guard = crate::rpc::retain_session_activity(&info.session_id, GUARD_OWNER);
    entry.lock().activity = Some(guard);
    *slot = Some(info.clone());
    Ok(info)
}

/// Update editing state without ever failing a local-only UI transition.
/// Nonblank drafts retain their prewarm while inactive. A blank inactive one
/// is stopped conservatively, but its draft id and settings remain.
pub async fn set_active<B: Backend>(ctx: Arc<Ctx<B>>, id: &str, active: bool, meaningful: bool) {
    let Some(entry) = entry(id) else { return };
    let (dirty, sending) = {
        let mut d = entry.lock();
        d.dirty = meaningful || d.selection.model.is_some() || d.selection.thinking.is_some();
        (d.dirty, d.sending)
    };
    if sending {
        return;
    }
    if active && dirty {
        // Prewarm off the request path; `spawn` is single-flight with send.
        tokio::spawn(async move {
            let _ = spawn(&ctx, &entry).await;
        });
    } else if !dirty {
        let start = entry.lock().start.clone();
        let info = start.lock().await.clone();
        if let Some(info) = info {
            if let Some(handle) = crate::rpc::get_handle(&info.session_id) {
                if !crate::rpc::stop_unused_draft(&handle).await {
                    return;
                }
            }
            *start.lock().await = None;
        }
        entry.lock().activity = None;
    } else if active {
        let start = entry.lock().start.clone();
        let info = start.lock().await.clone();
        if let Some(info) = info {
            crate::rpc::touch_session(&info.session_id);
        }
    }
}

pub async fn selection(id: &str) -> Option<Selection> {
    Some(entry(id)?.lock().selection.clone())
}

pub async fn default_model(state: Option<&AppState>, id: &str) -> Option<String> {
    let cwd = entry(id)?.lock().cwd.clone();
    if let Ok(s) = crate::settings_model_roles::omp_model_roles_read(Some(cwd), None).await {
        if let Some(project) = s.project {
            if let Some(m) = project
                .model_roles
                .get("default")
                .filter(|m| !m.trim().is_empty())
            {
                return Some(m.clone());
            }
        }
        if let Some(m) = s
            .global
            .model_roles
            .get("default")
            .filter(|m| !m.trim().is_empty())
        {
            return Some(m.clone());
        }
    }
    state?
        .settings
        .read()
        .new_session_model
        .clone()
        .filter(|m| !m.trim().is_empty())
}

pub async fn set_model(id: &str, provider: String, model: String) -> bool {
    let Some(entry) = entry(id) else { return false };
    let mut d = entry.lock();
    d.selection.model = Some((provider, model));
    d.dirty = true;
    true
}

pub async fn set_thinking(id: &str, level: String) -> bool {
    let Some(entry) = entry(id) else { return false };
    let mut d = entry.lock();
    d.selection.thinking = Some(level);
    d.dirty = true;
    true
}

pub async fn set_automation_mode(id: &str, enabled: bool) -> bool {
    let Some(entry) = entry(id) else { return false };
    let mut d = entry.lock();
    d.automation_mode = enabled;
    d.selection.automation_mode = enabled;
    true
}

/// RAII guard holding `Draft.sending = true` until handoff completes or the
/// future is dropped/cancelled.
struct ClaimGuard {
    entry: Entry,
    armed: bool,
}

impl ClaimGuard {
    fn new(entry: Entry) -> Self {
        Self { entry, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ClaimGuard {
    fn drop(&mut self) {
        if self.armed {
            self.entry.lock().sending = false;
        }
    }
}

/// Mark the draft as sending. Only one concurrent send may own a draft; a
/// duplicate is rejected instead of delivering the prompt twice.
fn claim(id: &str) -> Result<Option<ClaimGuard>, ApiError> {
    let Some(entry) = entry(id) else {
        return Ok(None);
    };
    {
        let mut d = entry.lock();
        if d.sending {
            return Err(ApiError(
                axum::http::StatusCode::CONFLICT,
                "消息正在发送".into(),
            ));
        }
        d.sending = true;
    }
    Ok(Some(ClaimGuard::new(entry)))
}

/// Await the one start shared by prewarm/send, apply the newest settings, then
/// run `send`. Draft state is removed only after the command succeeds; on
/// failure or cancellation the claim is released for a retry.
pub async fn handoff<B, F, Fut, T>(
    ctx: &Ctx<B>,
    id: &str,
    send: F,
) -> Result<Option<(String, T)>, ApiError>
where
    B: Backend,
    F: FnOnce(String, Selection) -> Fut,
    Fut: Future<Output = Result<T, ApiError>>,
{
    let Some(mut guard) = claim(id)? else {
        return Ok(None);
    };
    let info = spawn(ctx, &guard.entry)
        .await
        .map_err(|e| ApiError(axum::http::StatusCode::BAD_GATEWAY, e))?;
    let real = info.session_id.clone();
    let selection = guard.entry.lock().selection.clone();
    let result = send(real.clone(), selection).await?;
    guard.disarm();
    registry().lock().drafts.remove(id);
    // Dropping the entry releases the activity guard; the real
    // session is then governed by normal recycling.
    guard.entry.lock().activity = None;
    Ok(Some((real, result)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The registry is process-global and other tests create drafts too, so
    // this test uses its own cwd namespace and removes only its own drafts.
    #[tokio::test]
    async fn registry_reuse_selection_and_single_send() {
        let a = create("/tmp/draft-unit-a".into(), SpaceMode::Code, None, None).await;
        let b = create("/tmp/draft-unit-a".into(), SpaceMode::Code, None, None).await;
        let c = create("/tmp/draft-unit-b".into(), SpaceMode::Code, None, None).await;
        let d = create("/tmp/draft-unit-a".into(), SpaceMode::Work, None, None).await;
        let g = create(
            "/tmp/draft-unit-a".into(),
            SpaceMode::Code,
            Some("g".into()),
            None,
        )
        .await;
        assert_eq!(a.session_id, b.session_id);
        assert_ne!(a.session_id, c.session_id);
        assert_ne!(a.session_id, d.session_id);
        assert_ne!(a.session_id, g.session_id);
        assert_eq!(a.pid, 0);
        assert!(a.session_file.is_empty());
        assert!(is_draft(&a.session_id));

        // Selection: later choices win and are kept independently.
        assert!(set_model(&a.session_id, "p".into(), "m1".into()).await);
        assert!(set_model(&a.session_id, "p".into(), "m2".into()).await);
        assert!(set_thinking(&a.session_id, "high".into()).await);
        let sel = selection(&a.session_id).await.unwrap();
        assert_eq!(sel.model, Some(("p".into(), "m2".into())));
        assert_eq!(sel.thinking.as_deref(), Some("high"));
        let meta = meta(&a.session_id).await.unwrap();
        assert_eq!(meta.model.as_deref(), Some("p/m2"));
        assert!(!meta.live);

        // An edited draft is not reused for a new blank one.
        let e = create("/tmp/draft-unit-a".into(), SpaceMode::Code, None, None).await;
        assert_ne!(a.session_id, e.session_id);

        // Only one send may own a draft at a time; dropping the guard releases it.
        let claim_guard = claim(&a.session_id).unwrap().unwrap();
        assert!(claim(&a.session_id).is_err());
        drop(claim_guard);
        let _claim_again = claim(&a.session_id).unwrap().unwrap();
        assert!(claim(&a.session_id).is_err());
        drop(_claim_again);
        assert!(claim("mobile-draft-missing").unwrap().is_none());
        for id in [
            &a.session_id,
            &c.session_id,
            &d.session_id,
            &g.session_id,
            &e.session_id,
        ] {
            discard(id).await;
        }
    }

    #[tokio::test]
    async fn context_drafts_do_not_reuse_or_get_reused_by_plain_blank_drafts() {
        let plain1 = create("/tmp/draft-ctx-a".into(), SpaceMode::Code, None, None).await;
        let with_prompt = create_with_context(
            "/tmp/draft-ctx-a".into(),
            SpaceMode::Code,
            None,
            None,
            Some("hidden instructions".into()),
            false,
        )
        .await;
        let with_auto = create_with_context(
            "/tmp/draft-ctx-a".into(),
            SpaceMode::Code,
            None,
            None,
            None,
            true,
        )
        .await;
        assert_ne!(with_prompt.session_id, plain1.session_id);
        assert_ne!(with_auto.session_id, plain1.session_id);
        assert_ne!(with_auto.session_id, with_prompt.session_id);

        // Another plain blank draft reuses plain1, never with_prompt/with_auto.
        let plain2 = create("/tmp/draft-ctx-a".into(), SpaceMode::Code, None, None).await;
        assert_eq!(plain2.session_id, plain1.session_id);

        // Even after discarding plain1, a new plain draft never reuses context drafts.
        discard(&plain1.session_id).await;
        let plain3 = create("/tmp/draft-ctx-a".into(), SpaceMode::Code, None, None).await;
        assert_ne!(plain3.session_id, with_prompt.session_id);
        assert_ne!(plain3.session_id, with_auto.session_id);

        assert!(!selection(&plain3.session_id).await.unwrap().automation_mode);
        assert!(
            selection(&with_auto.session_id)
                .await
                .unwrap()
                .automation_mode
        );

        for id in [
            &with_prompt.session_id,
            &with_auto.session_id,
            &plain3.session_id,
        ] {
            discard(id).await;
        }
    }
}

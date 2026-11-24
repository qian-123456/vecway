//! Router tests with a mock backend: pairing → cookie → /api, auth rejection, SSE.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt as _;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};
use tower::ServiceExt as _;

use super::auth;
use super::backend::Backend;
use super::server::{self, Ctx};
use crate::contracts::{PendingKind, PendingUiRequest, SessionMeta, SessionStatus, Todo};
use crate::state::AppEvent;

struct Mock {
    calls: Mutex<Vec<String>>,
    bus: broadcast::Sender<AppEvent>,
    file: String,
    /// Extra pending dialogs of session "a", removed once answered.
    extra_pending: Mutex<Vec<Value>>,
    /// HTTP status the fake push service answers with.
    push_status: Mutex<u16>,
    voice_calls: Mutex<Vec<super::api::voice::AudioPayload>>,
    cwd_override: Mutex<Option<String>>,
    repo_root_override: Mutex<Option<String>>,
    started_opts: Mutex<Vec<crate::contracts::StartOpts>>,
    delivered_prompts: Mutex<Vec<(String, String, bool)>>,
    extra_sessions: Mutex<Vec<SessionMeta>>,
    voice_result: Mutex<Result<Value, (StatusCode, Value)>>,
}

impl Backend for Mock {
    async fn sessions(&self) -> Vec<SessionMeta> {
        let mk = |id: &str, updated: &str, archived: bool| SessionMeta {
            id: id.into(),
            label: format!("#{id}"),
            title: format!("title {id}"),
            updated_at: updated.into(),
            status: SessionStatus::AwaitingAnswer,
            pending: Some(PendingKind::Question),
            archived,
            file: self.file.clone(),
            cwd: self.cwd_override.lock().clone().unwrap_or_else(|| {
                std::path::Path::new(&self.file)
                    .parent()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            }),
            repo_root: self.repo_root_override.lock().clone(),
            ..Default::default()
        };
        let mut out = vec![
            mk("a", "2026-01-01T00:00:00Z", false),
            mk("b", "2026-02-01T00:00:00Z", false),
            mk("z", "2026-03-01T00:00:00Z", true),
        ];
        out.extend(self.extra_sessions.lock().iter().cloned());
        out
    }
    async fn session(&self, id: &str) -> Option<SessionMeta> {
        self.sessions().await.into_iter().find(|s| s.id == id)
    }
    async fn todos(&self) -> Vec<Todo> {
        let todo: Todo = serde_json::from_value(json!({
            "id": "t1", "kind": "approval", "source": "system", "status": "open",
            "sessionId": "a", "title": "Allow tool: bash", "detail": "", "payload": {"uiRequest": {"id": "r1"}},
            "priority": 50, "createdAt": "x", "updatedAt": "x"
        }))
        .unwrap();
        vec![todo]
    }
    async fn todo_act(&self, id: &str, action: &str) -> Result<(), String> {
        self.calls.lock().push(format!("act {id} {action}"));
        Ok(())
    }
    async fn pending_ui(&self, id: &str) -> Vec<PendingUiRequest> {
        let mut out = vec![PendingUiRequest {
            session_id: id.into(),
            request: json!({"id": "r1", "method": "input"}),
            received_at: "x".into(),
        }];
        if id == "a" {
            out.extend(self.extra_pending.lock().iter().map(|r| PendingUiRequest {
                session_id: id.into(),
                request: r.clone(),
                received_at: "x".into(),
            }));
        }
        out
    }
    async fn ui_respond(&self, id: &str, response: Value) -> Result<(), String> {
        self.calls.lock().push(format!("respond {id} {response}"));
        let rid = response["id"].as_str().unwrap_or_default().to_string();
        self.extra_pending
            .lock()
            .retain(|r| r["id"].as_str() != Some(rid.as_str()));
        Ok(())
    }
    async fn send_prompt(&self, id: &str, text: &str) -> Result<(), String> {
        self.calls.lock().push(format!("prompt {id} {text}"));
        Ok(())
    }
    async fn resume(&self, _id: &str) -> Result<Value, String> {
        Err("not implemented".into())
    }
    async fn start_process(
        &self,
        opts: &crate::contracts::StartOpts,
    ) -> Result<crate::contracts::LiveSessionInfo, String> {
        self.started_opts.lock().push(opts.clone());
        self.calls.lock().push(format!("start {}", opts.cwd));
        Ok(crate::contracts::LiveSessionInfo {
            session_id: "mock-real-1".into(),
            cwd: opts.cwd.clone(),
            ..Default::default()
        })
    }
    async fn deliver_prompt(
        &self,
        id: &str,
        d: super::backend::PromptDelivery,
    ) -> Result<bool, String> {
        let model = d
            .selection
            .model
            .map(|(p, m)| format!(" {p}/{m}"))
            .unwrap_or_default();
        self.delivered_prompts.lock().push((
            id.to_string(),
            d.message.clone(),
            d.selection.automation_mode,
        ));
        self.calls
            .lock()
            .push(format!("deliver {id} {}{model}", d.message));
        Ok(false)
    }
    async fn push_http(&self, req: super::push::PushHttp) -> Result<u16, String> {
        self.calls.lock().push(format!("push {}", req.endpoint));
        Ok(*self.push_status.lock())
    }
    async fn transcribe_audio(
        &self,
        audio: super::api::voice::AudioPayload,
    ) -> super::api::voice::VoiceResult {
        self.voice_calls.lock().push(audio);
        self.voice_result
            .lock()
            .clone()
            .map(axum::Json)
            .map_err(|(status, body)| (status, axum::Json(body)))
    }
    fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.bus.subscribe()
    }
}

struct Harness {
    ctx: Arc<Ctx<Mock>>,
    shutdown: watch::Sender<bool>,
    dir: std::path::PathBuf,
}

fn harness() -> Harness {
    let dir = std::env::temp_dir().join(format!("ompws-mobile-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("s.jsonl");
    std::fs::write(
        &file,
        r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"full last answer"}]}}"#,
    )
    .unwrap();
    let (bus, _) = broadcast::channel(16);
    let (tx, rx) = watch::channel(false);
    let ctx = Arc::new(Ctx {
        backend: Mock {
            calls: Mutex::new(Vec::new()),
            bus,
            file: file.to_string_lossy().to_string(),
            extra_pending: Mutex::new(Vec::new()),
            push_status: Mutex::new(201),
            voice_calls: Mutex::new(Vec::new()),
            voice_result: Mutex::new(Ok(json!({ "text": "受控转写" }))),
            cwd_override: Mutex::new(None),
            repo_root_override: Mutex::new(None),
            started_opts: Mutex::new(Vec::new()),
            delivered_prompts: Mutex::new(Vec::new()),
            extra_sessions: Mutex::new(Vec::new()),
        },
        db: Arc::new(parking_lot::Mutex::new(auth::test_db())),
        shutdown: rx,
    });
    Harness {
        ctx,
        shutdown: tx,
        dir,
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn call(h: &Harness, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
    let res = server::router(h.ctx.clone()).oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8_lossy(&body).to_string())
}

fn get(uri: &str, cookie: Option<&str>) -> Request<Body> {
    let mut b = Request::get(uri);
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, c);
    }
    b.body(Body::empty()).unwrap()
}

fn post(uri: &str, cookie: &str, body: Value) -> Request<Body> {
    Request::post(uri)
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn pair_request(code: &str) -> Request<Body> {
    Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(format!("code={code}")))
        .unwrap()
}

#[tokio::test]
async fn pairing_get_and_head_do_not_consume_code() {
    let h = harness();
    let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let uri = format!("/pair?code={code}");
    for req in [
        get(&uri, None),
        Request::head(&uri).body(Body::empty()).unwrap(),
    ] {
        let (status, headers, body) = call(&h, req).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!headers.contains_key(header::SET_COOKIE));
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(headers[header::REFERRER_POLICY], "same-origin");
        assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
        if !body.is_empty() {
            assert!(body.contains("<form method=post action=/pair>"));
            assert!(body.contains(&format!("value='{code}'")));
        }
    }
    assert_eq!(call(&h, pair_request(&code)).await.0, StatusCode::SEE_OTHER);
    assert_eq!(call(&h, pair_request(&code)).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pairing_same_origin_form_redirects_and_sets_cookie() {
    let h = harness();
    let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let req = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::HOST, "192.168.1.5:7788")
        .header(header::ORIGIN, "http://192.168.1.5:7788")
        .header(
            header::REFERER,
            format!("http://192.168.1.5:7788/pair?code={code}"),
        )
        .header("sec-fetch-site", "same-origin")
        .body(Body::from(format!("code={code}")))
        .unwrap();
    let (status, headers, _) = call(&h, req).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/");
    let cookie = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Lax"));
    let cookie = cookie.split(';').next().unwrap();
    assert_eq!(
        call(&h, get("/api/sessions", Some(cookie))).await.0,
        StatusCode::OK
    );
    assert_eq!(call(&h, pair_request(&code)).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pairing_json_result_is_for_this_code_not_an_existing_cookie() {
    let h = harness();
    let cookie = pair(&h).await;
    assert_eq!(
        call(&h, post("/pair", &cookie, json!({"code":"invalid"})))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let (status, headers, _) = call(&h, post("/pair", &cookie, json!({"code":code}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers.contains_key(header::SET_COOKIE));
}

#[tokio::test]
async fn pairing_rejects_untrusted_sources_without_consuming_code() {
    for json in [false, true] {
        for (origin, site) in [
            ("http://192.168.1.5:7788", "cross-site"),
            ("https://evil.example", "same-origin"),
            ("null", "same-origin"),
        ] {
            let h = harness();
            let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
            let mut req = if json {
                post("/pair", "", json!({"code":code}))
            } else {
                pair_request(&code)
            };
            let headers = req.headers_mut();
            headers.insert(header::HOST, "192.168.1.5:7788".parse().unwrap());
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            headers.insert(
                header::REFERER,
                "http://192.168.1.5:7788/pair".parse().unwrap(),
            );
            headers.insert("sec-fetch-site", site.parse().unwrap());
            let (status, headers, body) = call(&h, req).await;
            assert_eq!(status, StatusCode::FORBIDDEN);
            assert!(!headers.contains_key(header::SET_COOKIE));
            assert!(!headers.contains_key(header::CONTENT_DISPOSITION));
            if json {
                assert_eq!(headers[header::CONTENT_TYPE], "application/json");
                let error: Value = serde_json::from_str(&body).unwrap();
                assert!(error["error"].as_str().is_some_and(|s| !s.is_empty()));
            } else {
                assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
                assert_eq!(headers[header::CACHE_CONTROL], "no-store");
                assert!(body.starts_with("<!doctype html>"));
                assert!(body.contains("<meta charset=utf-8>"));
                assert!(!body.is_ascii());
                assert!(!body.contains('\u{fffd}'));
            }
            assert_eq!(call(&h, pair_request(&code)).await.0, StatusCode::SEE_OTHER);
        }
    }
}

#[tokio::test]
async fn foreground_presence_endpoint_tracks_viewing_and_background() {
    let h = harness();
    let cookie = pair(&h).await;
    let token = cookie.split_once('=').unwrap().1;
    let device = auth::hash_token(token);
    let _stream = super::push::SseGuard::new(device.clone());
    assert!(!super::push::is_viewing_session(&device, "a"));
    assert_eq!(
        call(
            &h,
            post(
                "/api/presence",
                &cookie,
                json!({"sessionId":"a", "visible":true})
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(super::push::is_viewing_session(&device, "a"));
    assert!(!super::push::is_viewing_session(&device, "b"));
    assert_eq!(
        call(
            &h,
            post(
                "/api/presence",
                &cookie,
                json!({"sessionId":"a", "visible":false})
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(!super::push::is_viewing_session(&device, "a"));
    assert_eq!(
        call(
            &h,
            post(
                "/api/presence",
                &cookie,
                json!({"sessionId":null, "visible":true})
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(!super::push::is_viewing_session(&device, "a"));
    super::push::clear_presence(&device);
}

/// Pair via /pair and return the `name=value` cookie pair.
async fn pair(h: &Harness) -> String {
    let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let (status, headers, _) = call(h, pair_request(&code)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/");
    let set = headers[header::SET_COOKIE].to_str().unwrap().to_string();
    assert!(set.contains("HttpOnly"));
    // Code is one-time.
    let (again, _, _) = call(h, pair_request(&code)).await;
    assert_eq!(again, StatusCode::FORBIDDEN);
    set.split(';').next().unwrap().to_string()
}

#[tokio::test]
async fn index_is_public_and_api_requires_auth() {
    let h = harness();
    // Public either way; 503 hint page when the frontend bundle is not built.
    let (s, _, body) = call(&h, get("/", None)).await;
    assert!(s == StatusCode::OK || s == StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("<html"));
    let (s, _, _) = call(&h, get("/api/sessions", None)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _, _) = call(&h, get("/api/sessions", Some("ompws_token=bogus"))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _, _) = call(&h, pair_request("nope")).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn paired_device_uses_api() {
    let h = harness();
    let cookie = pair(&h).await;

    let (s, _, body) = call(&h, get("/api/sessions", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK);
    let list: Vec<Value> = serde_json::from_str(&body).unwrap();
    let ids: Vec<&str> = list.iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["b", "a"], "archived hidden, newest first");
    assert_eq!(list[0]["status"], "awaiting_answer");
    assert_eq!(list[0]["pending"], "question");
    assert!(list[0].get("updatedAt").is_some());

    let (s, _, body) = call(&h, get("/api/todos", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.contains("\"t1\""));

    let (s, _, _) = call(
        &h,
        post("/api/todos/t1/act", &cookie, json!({"action": "done"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = call(
        &h,
        post("/api/todos/t1/act", &cookie, json!({"action": "nuke"})),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _, body) = call(&h, get("/api/sessions/a/pending-ui", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.contains("\"r1\""));

    let (s, _, _) = call(
        &h,
        post(
            "/api/sessions/a/ui-respond",
            &cookie,
            json!({"response": {"id": "r1", "value": "Approve"}}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = call(
        &h,
        post(
            "/api/sessions/a/ui-respond",
            &cookie,
            json!({"response": {}}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _, _) = call(
        &h,
        post("/api/sessions/a/prompt", &cookie, json!({"text": " 继续 "})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = call(
        &h,
        post("/api/sessions/a/prompt", &cookie, json!({"text": "  "})),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _, body) = call(&h, post("/api/sessions/a/resume", &cookie, json!({}))).await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);
    assert!(body.contains("not implemented"));

    let (s, _, body) = call(&h, get("/api/sessions/a/last", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["text"],
        "full last answer"
    );
    let (s, _, _) = call(&h, get("/api/sessions/missing/last", Some(&cookie))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let calls = h.ctx.backend.calls.lock().clone();
    assert_eq!(calls[0], "act t1 done");
    assert!(calls[1].starts_with("respond a "));
    assert!(calls[1].contains("\"type\":\"extension_ui_response\""));
    assert_eq!(calls[2], "prompt a 继续");

    // Bearer works too; revocation locks the device out.
    let token = cookie.split_once('=').unwrap().1.to_string();
    let req = Request::get("/api/todos")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::OK);
    auth::revoke_all(&h.ctx.db.lock()).unwrap();
    assert_eq!(
        call(&h, get("/api/todos", Some(&cookie))).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn device_name_and_revocation_affect_only_the_authenticated_device() {
    let h = harness();
    let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let req = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::USER_AGENT, "same browser")
        .body(Body::from(
            json!({"code": code, "name": "My phone"}).to_string(),
        ))
        .unwrap();
    let (status, headers, _) = call(&h, req).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let cookie = headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let other = pair(&h).await;
    let token = cookie.split_once('=').unwrap().1;
    let id = auth::device_id_for_token(&h.ctx.db.lock(), token).unwrap();
    let device = auth::list_devices(&h.ctx.db.lock())
        .unwrap()
        .into_iter()
        .find(|d| d.id == id)
        .unwrap();
    assert_eq!(device.name, "My phone");
    assert_eq!(device.user_agent.as_deref(), Some("same browser"));
    let (status, _, current) = call(&h, get("/api/device", Some(&cookie))).await;
    assert_eq!(status, StatusCode::OK);
    let current: Value = serde_json::from_str(&current).unwrap();
    assert_eq!(current["id"], id);
    assert_eq!(current["userAgent"], "same browser");
    assert_eq!(
        call(&h, post("/api/device/name", &cookie, json!({"name":"New"})))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        auth::list_devices(&h.ctx.db.lock())
            .unwrap()
            .into_iter()
            .find(|d| d.id == id)
            .unwrap()
            .name,
        "New"
    );
    assert_eq!(
        call(&h, post("/api/device/name", &cookie, json!({"name":"  "})))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        auth::device_for_token(&h.ctx.db.lock(), token)
            .unwrap()
            .unwrap()
            .name,
        "浏览器"
    );
    assert_eq!(
        call(&h, post("/api/device/name", "", json!({"name":"X"})))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let hash = auth::revoke_device(&h.ctx.db.lock(), &id).unwrap().unwrap();
    auth::notify_revoked(&hash);
    assert_eq!(
        call(&h, get("/api/todos", Some(&cookie))).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&h, get("/api/todos", Some(&other))).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn unnamed_pairing_keeps_raw_agent_and_empty_rename_restores_default() {
    let h = harness();
    let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let req = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::USER_AGENT, "Mozilla/5.0 (Linux; Android 14)")
        .body(Body::from(json!({"code": code, "name": "  "}).to_string()))
        .unwrap();
    let (status, headers, _) = call(&h, req).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let cookie = headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let token = cookie.split_once('=').unwrap().1;
    let device = auth::device_for_token(&h.ctx.db.lock(), token)
        .unwrap()
        .unwrap();
    let default_name = device.name;
    assert_eq!(
        device.user_agent.as_deref(),
        Some("Mozilla/5.0 (Linux; Android 14)")
    );
    assert_eq!(
        call(
            &h,
            post("/api/device/name", cookie, json!({"name":"Travel phone"}))
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        auth::device_for_token(&h.ctx.db.lock(), token)
            .unwrap()
            .unwrap()
            .name,
        "Travel phone"
    );
    assert_eq!(
        call(&h, post("/api/device/name", cookie, json!({"name":""})))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        auth::device_for_token(&h.ctx.db.lock(), token)
            .unwrap()
            .unwrap()
            .name,
        default_name
    );
}

#[tokio::test]
async fn device_revocation_closes_only_its_event_stream_and_clears_presence() {
    let h = harness();
    let first = pair(&h).await;
    let second = pair(&h).await;
    let first_token = first.split_once('=').unwrap().1;
    let hash = auth::hash_token(first_token);
    let mut first_body = server::router(h.ctx.clone())
        .oneshot(get("/api/events", Some(&first)))
        .await
        .unwrap()
        .into_body();
    let mut second_body = server::router(h.ctx.clone())
        .oneshot(get("/api/events", Some(&second)))
        .await
        .unwrap()
        .into_body();
    first_body.frame().await.unwrap().unwrap();
    second_body.frame().await.unwrap().unwrap();
    super::push::update_presence(&hash, Some("a".into()), true);
    let id = auth::device_id_for_token(&h.ctx.db.lock(), first_token).unwrap();
    assert_eq!(
        auth::revoke_device(&h.ctx.db.lock(), &id).unwrap(),
        Some(hash.clone())
    );
    auth::notify_revoked(&hash);
    assert!(super::push::get_presence(&hash).is_none());
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), first_body.frame())
            .await
            .unwrap()
            .is_none()
    );
    let _ = h.ctx.backend.bus.send(AppEvent::TodosChanged);
    let next = tokio::time::timeout(std::time::Duration::from_secs(1), second_body.frame())
        .await
        .unwrap();
    assert!(next.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_terminal_owner_closes_its_stream_but_not_an_identical_agent() {
    let h = harness();
    // Both pairing requests omit User-Agent and therefore receive the same default.
    let first = pair(&h).await;
    let second = pair(&h).await;
    let first_token = first.split_once('=').unwrap().1;
    let second_token = second.split_once('=').unwrap().1;
    let first_device = auth::device_for_token(&h.ctx.db.lock(), first_token)
        .unwrap()
        .unwrap();
    let second_device = auth::device_for_token(&h.ctx.db.lock(), second_token)
        .unwrap()
        .unwrap();
    assert_eq!(first_device.user_agent, second_device.user_agent);
    assert_ne!(first_device.id, second_device.id);

    let (status, _, body) = call(&h, post("/api/terminal", &first, json!({"sessionId":"a"}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let opened: Value = serde_json::from_str(&body).unwrap();
    let term_id = opened["termId"].as_str().unwrap();
    let terminal_path = format!("/api/terminal/{term_id}/stream");
    let terminal = server::router(h.ctx.clone())
        .oneshot(get(&terminal_path, Some(&first)))
        .await
        .unwrap();
    assert_eq!(terminal.status(), StatusCode::OK);
    let mut terminal_body = terminal.into_body();
    let mut other_body = server::router(h.ctx.clone())
        .oneshot(get("/api/events", Some(&second)))
        .await
        .unwrap()
        .into_body();
    other_body.frame().await.unwrap().unwrap();

    let hash = auth::revoke_device(&h.ctx.db.lock(), &first_device.id)
        .unwrap()
        .unwrap();
    super::work::device_revoked(&first_device.id);
    auth::notify_revoked(&hash);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while let Some(frame) = terminal_body.frame().await {
            frame.unwrap();
        }
    })
    .await
    .expect("revoked terminal stream closes");
    assert_eq!(
        call(&h, get(&terminal_path, Some(&first))).await.0,
        StatusCode::UNAUTHORIZED
    );
    let _ = h.ctx.backend.bus.send(AppEvent::TodosChanged);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), other_body.frame())
            .await
            .unwrap()
            .is_some()
    );

    let close = Request::delete(format!("/api/terminal/{term_id}"))
        .header(header::COOKIE, &second)
        .body(Body::empty())
        .unwrap();
    assert_eq!(call(&h, close).await.0, StatusCode::OK);
}

#[tokio::test]
async fn revoke_all_clears_pairing_subscriptions_and_presence() {
    let h = harness();
    let cookie = pair(&h).await;
    let token = cookie.split_once('=').unwrap().1;
    let hash = auth::hash_token(token);
    super::push::update_presence(&hash, Some("a".into()), true);
    {
        let db = h.ctx.db.lock();
        db.execute(
            "INSERT INTO push_subscriptions VALUES ('endpoint', 'p', 'a', ?1, 't')",
            [&hash],
        )
        .unwrap();
        auth::create_pairing(&db, chrono::Utc::now()).unwrap();
        auth::revoke_all(&db).unwrap();
        let subscriptions: i64 = db
            .query_row("SELECT COUNT(*) FROM push_subscriptions", [], |r| r.get(0))
            .unwrap();
        let codes: i64 = db
            .query_row("SELECT COUNT(*) FROM pairing_codes", [], |r| r.get(0))
            .unwrap();
        assert_eq!((subscriptions, codes), (0, 0));
    }
    assert!(super::push::get_presence(&hash).is_none());
    assert_eq!(
        call(&h, get("/api/todos", Some(&cookie))).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn sse_streams_bus_events_until_shutdown() {
    let h = harness();
    let cookie = pair(&h).await;
    let res = server::router(h.ctx.clone())
        .oneshot(get("/api/events", Some(&cookie)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], "text/event-stream");
    let mut body = res.into_body();

    let bus = h.ctx.backend.bus.clone();
    let _ = bus.send(AppEvent::ServicesChanged); // ignored
    let _ = bus.send(AppEvent::TodosChanged);
    let _ = bus.send(AppEvent::SessionStatusChanged {
        session_id: "a".into(),
        old: SessionStatus::Working,
        new: SessionStatus::Review,
    });

    let mut text = String::new();
    while !text.contains("event: session") {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame())
            .await
            .expect("sse frame")
            .unwrap()
            .unwrap();
        if let Ok(data) = frame.into_data() {
            text.push_str(&String::from_utf8_lossy(&data));
        }
    }
    assert!(text.contains("event: hello"));
    assert!(text.contains("event: todos"));
    assert!(text.contains("\"new\":\"review\""));
    assert!(!text.contains("services"));

    h.shutdown.send(true).unwrap();
    let end = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(Ok(_)) = body.frame().await {}
    })
    .await;
    assert!(end.is_ok(), "stream ends on shutdown");
}

/// The phone page only receives the rpc frame types it renders; the whitelist
/// is the exact set of frame types the phone UI consumes.
#[test]
fn sse_rpc_whitelist_covers_every_consumed_frame_type() {
    let forwarded = [
        "agent_start",
        "agent_end",
        "turn_start",
        "turn_end",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
        "auto_retry_start",
        "auto_retry_end",
        "retry_fallback_applied",
        "retry_fallback_succeeded",
        "auto_compaction_start",
        "auto_compaction_end",
        "queue_update",
    ];
    for ty in forwarded {
        assert!(server::rpc_frame_allowed(ty), "{ty} must be forwarded");
    }
    // Unlisted frames stay off the phone.
    for ty in ["command_output", "message_start", "tool_stream_update", ""] {
        assert!(!server::rpc_frame_allowed(ty), "{ty} must be dropped");
    }
    // Frames without a type never reach the wire either.
    let untyped = AppEvent::RpcFrame {
        session_id: "a".into(),
        frame: std::sync::Arc::new(json!({"noType": true})),
    };
    assert!(server::sse_event(&untyped).is_none());
}

/// Real TCP server exercised with curl: pair → cookie jar → /api.
#[tokio::test]
async fn curl_end_to_end() {
    if std::process::Command::new("curl")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let h = harness();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_task = tokio::spawn(server::serve(listener, h.ctx.clone()));
    let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let jar = h.dir.join("jar.txt");
    let base = format!("http://127.0.0.1:{port}");

    let curl = |args: Vec<String>| async move {
        tokio::process::Command::new("curl")
            .args(["-s", "-S", "--max-time", "5"])
            .args(args)
            .output()
            .await
            .unwrap()
    };
    let pair_url = format!("{base}/pair?code={code}");
    let out = curl(vec!["-i".into(), pair_url.clone()]).await;
    assert!(out.status.success());
    let response = String::from_utf8(out.stdout).unwrap();
    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
    let headers = headers.to_ascii_lowercase();
    assert!(headers.starts_with("http/1.1 200"));
    assert!(headers.lines().any(|h| h == "referrer-policy: same-origin"));
    assert!(headers
        .lines()
        .any(|h| h == "content-type: text/html; charset=utf-8"));
    assert!(body.contains(&format!("value='{code}'")));

    let out = curl(vec![
        "-i".into(),
        "-H".into(),
        "Origin: null".into(),
        "-e".into(),
        pair_url.clone(),
        "-d".into(),
        format!("code={code}"),
        format!("{base}/pair"),
    ])
    .await;
    assert!(out.status.success());
    let response = String::from_utf8(out.stdout).unwrap();
    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
    let headers = headers.to_ascii_lowercase();
    assert!(headers.starts_with("http/1.1 403"));
    assert!(headers
        .lines()
        .any(|h| h == "content-type: text/html; charset=utf-8"));
    assert!(!headers.contains("set-cookie:"));
    assert!(!headers.contains("content-disposition:"));
    assert!(body.starts_with("<!doctype html>"));
    assert!(!body.is_ascii());

    let jar_s = jar.to_string_lossy().to_string();
    let out = curl(vec![
        "-c".into(),
        jar_s.clone(),
        "-L".into(),
        "-o".into(),
        "/dev/null".into(),
        "-w".into(),
        "%{http_code} %{url_effective}".into(),
        "-H".into(),
        format!("Origin: {base}"),
        "-e".into(),
        pair_url,
        "-d".into(),
        format!("code={code}"),
        format!("{base}/pair"),
    ])
    .await;
    assert!(out.status.success());
    let summary = String::from_utf8_lossy(&out.stdout).to_string();
    // 503 hint page when the frontend bundle is not built.
    assert!(
        summary == format!("200 {base}/") || summary == format!("503 {base}/"),
        "followed redirect to /: {summary}"
    );

    let out = curl(vec![
        "-b".into(),
        jar_s.clone(),
        format!("{base}/api/sessions"),
    ])
    .await;
    let list: Vec<Value> = serde_json::from_slice(&out.stdout).expect("json sessions");
    assert_eq!(list.len(), 2);

    let out = curl(vec![
        "-b".into(),
        jar_s,
        "-X".into(),
        "POST".into(),
        "-H".into(),
        "content-type: application/json".into(),
        "-d".into(),
        r#"{"text":"hello from curl"}"#.into(),
        format!("{base}/api/sessions/b/prompt"),
    ])
    .await;
    assert_eq!(String::from_utf8_lossy(&out.stdout), r#"{"ok":true}"#);

    let out = curl(vec![
        "-o".into(),
        "/dev/null".into(),
        "-w".into(),
        "%{http_code}".into(),
        format!("{base}/api/sessions"),
    ])
    .await;
    assert_eq!(String::from_utf8_lossy(&out.stdout), "401");

    h.shutdown.send(true).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), server_task)
        .await
        .expect("server stops")
        .unwrap();
    assert!(h
        .ctx
        .backend
        .calls
        .lock()
        .contains(&"prompt b hello from curl".to_string()));
}

#[tokio::test]
async fn csrf_rejects_cross_site_requests() {
    let h = harness();
    let cookie = pair(&h).await;

    // Cross-site Origin on a mutation → 403.
    let req = Request::post("/api/sessions/a/prompt")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, "192.168.1.5:7788")
        .header(header::ORIGIN, "https://evil.example")
        .body(Body::from(json!({"text":"hi"}).to_string()))
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::FORBIDDEN);

    // Sec-Fetch-Site: cross-site → 403.
    let req = Request::post("/api/sessions/a/prompt")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .header("sec-fetch-site", "cross-site")
        .body(Body::from(json!({"text":"hi"}).to_string()))
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::FORBIDDEN);

    // Same-origin Origin matching Host → allowed.
    let req = Request::post("/api/sessions/a/prompt")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, "192.168.1.5:7788")
        .header(header::ORIGIN, "http://192.168.1.5:7788")
        .body(Body::from(json!({"text":"hi"}).to_string()))
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::OK);

    // GETs are not CSRF-checked.
    let req = Request::get("/api/sessions")
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, "https://evil.example")
        .body(Body::empty())
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::OK);
}

#[tokio::test]
async fn rejects_invalid_or_archived_session_targets() {
    let h = harness();
    let cookie = pair(&h).await;

    // Illegal characters / traversal in the session id → 400.
    for bad in ["bad%20id", "..%2F..%2Fetc", "a!b"] {
        let (s, _, _) = call(&h, get(&format!("/api/sessions/{bad}/last"), Some(&cookie))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "id {bad}");
    }

    // Unknown session → 404 on mutations and reads.
    let (s, _, _) = call(&h, get("/api/sessions/ghost/pending-ui", Some(&cookie))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _, _) = call(
        &h,
        post("/api/sessions/ghost/prompt", &cookie, json!({"text": "hi"})),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Archived session → 400 on mutations.
    let (s, _, _) = call(
        &h,
        post("/api/sessions/z/prompt", &cookie, json!({"text": "hi"})),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _, _) = call(&h, post("/api/sessions/z/resume", &cookie, json!({}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // ui-respond must reference a live pending request id.
    let (s, _, _) = call(
        &h,
        post(
            "/api/sessions/a/ui-respond",
            &cookie,
            json!({"response": {"id": "not-pending"}}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn sse_ends_when_device_revoked() {
    let h = harness();
    let cookie = pair(&h).await;
    let res = server::router(h.ctx.clone())
        .oneshot(get("/api/events", Some(&cookie)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = res.into_body();

    auth::revoke_all(&h.ctx.db.lock()).unwrap();
    // Any bus event triggers the revocation check and ends the stream.
    let _ = h.ctx.backend.bus.send(AppEvent::TodosChanged);

    let end = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(Ok(_)) = body.frame().await {}
    })
    .await;
    assert!(end.is_ok(), "stream ends after revocation");
}

#[test]
fn qr_svg_renders() {
    let svg = super::qr_svg("http://192.168.1.2:7788/pair?code=abc").unwrap();
    assert!(svg.starts_with("<?xml") || svg.contains("<svg"));
}

#[test]
fn test_ipv6_address_selection() {
    use super::ipv6::{is_eligible_global_unicast, select_best_address, CandidateAddress};
    use std::net::Ipv6Addr;
    use std::str::FromStr;

    // Rejection of non-global unicast
    assert!(!is_eligible_global_unicast(
        &Ipv6Addr::from_str("::1").unwrap()
    ));
    assert!(!is_eligible_global_unicast(
        &Ipv6Addr::from_str("fe80::1").unwrap()
    ));
    assert!(!is_eligible_global_unicast(
        &Ipv6Addr::from_str("fd00::1").unwrap()
    ));
    assert!(!is_eligible_global_unicast(
        &Ipv6Addr::from_str("fc00::1").unwrap()
    ));
    assert!(!is_eligible_global_unicast(
        &Ipv6Addr::from_str("2001:db8::1").unwrap()
    ));
    assert!(!is_eligible_global_unicast(
        &Ipv6Addr::from_str("2001:0:1234::1").unwrap()
    ));
    assert!(!is_eligible_global_unicast(
        &Ipv6Addr::from_str("2002:1234::1").unwrap()
    ));

    // Acceptance of global unicast (2000::/3)
    let addr_temp = Ipv6Addr::from_str("2408:4005:1000::1").unwrap();
    let addr_stable = Ipv6Addr::from_str("2408:4005:1000::2").unwrap();
    assert!(is_eligible_global_unicast(&addr_temp));
    assert!(is_eligible_global_unicast(&addr_stable));

    // Prefers stable global over temporary
    let candidates = vec![
        CandidateAddress {
            addr: addr_temp,
            is_temporary: true,
            is_deprecated: false,
        },
        CandidateAddress {
            addr: addr_stable,
            is_temporary: false,
            is_deprecated: false,
        },
    ];
    let selected = select_best_address(candidates).unwrap();
    assert_eq!(selected, addr_stable);

    // Prefers non-deprecated over deprecated
    let addr_dep = Ipv6Addr::from_str("2408:4005:1000::3").unwrap();
    let candidates = vec![
        CandidateAddress {
            addr: addr_dep,
            is_temporary: false,
            is_deprecated: true,
        },
        CandidateAddress {
            addr: addr_temp,
            is_temporary: true,
            is_deprecated: false,
        },
    ];
    let selected = select_best_address(candidates).unwrap();
    assert_eq!(selected, addr_temp);

    // All rejected when only non-eligible addresses present
    let candidates = vec![
        CandidateAddress {
            addr: Ipv6Addr::from_str("fe80::1").unwrap(),
            is_temporary: false,
            is_deprecated: false,
        },
        CandidateAddress {
            addr: Ipv6Addr::from_str("fd00::1").unwrap(),
            is_temporary: false,
            is_deprecated: false,
        },
    ];
    assert!(select_best_address(candidates).is_none());
}

#[test]
fn test_csrf_origin_host_matching() {
    use axum::http::HeaderMap;

    let check = |origin: Option<&str>, host: Option<&str>, tls: bool, xfp: Option<&str>| -> bool {
        let mut headers = HeaderMap::new();
        if let Some(o) = origin {
            headers.insert(header::ORIGIN, o.parse().unwrap());
        }
        if let Some(h) = host {
            headers.insert(header::HOST, h.parse().unwrap());
        }
        if let Some(p) = xfp {
            headers.insert("x-forwarded-proto", p.parse().unwrap());
        }
        server::verify_csrf(&headers, tls).is_ok()
    };

    // LAN: explicit port on both sides, plain HTTP.
    assert!(check(
        Some("http://192.168.1.10:7788"),
        Some("192.168.1.10:7788"),
        false,
        None
    ));
    assert!(check(
        Some("http://localhost:7788"),
        Some("localhost:7788"),
        false,
        None
    ));

    // cloudflared tunnel: https implied on both sides (x-forwarded-proto, no port).
    assert!(check(
        Some("https://foo.trycloudflare.com"),
        Some("foo.trycloudflare.com"),
        false,
        Some("https")
    ));

    // IPv6 direct: bracketed literal over TLS with explicit port.
    assert!(check(
        Some("https://[2408:4005:1000::1]:7789"),
        Some("[2408:4005:1000::1]:7789"),
        true,
        None
    ));

    // Reject: origin's implicit https port (443) vs explicit Host port 7789.
    assert!(!check(
        Some("https://home.example.com"),
        Some("home.example.com:7789"),
        false,
        None
    ));
    assert!(!check(
        Some("https://[2408:4005:1000::1]"),
        Some("[2408:4005:1000::1]:7789"),
        true,
        None
    ));

    // Reject: scheme mismatch (https origin over plain-HTTP host).
    assert!(!check(
        Some("https://192.168.1.10:7788"),
        Some("192.168.1.10:7788"),
        false,
        None
    ));

    // Reject: different IPv6 host.
    assert!(!check(
        Some("https://[2408:4005:2000::2]:7789"),
        Some("[2408:4005:1000::1]:7789"),
        true,
        None
    ));

    // Reject: different port.
    assert!(!check(
        Some("https://[2408:4005:1000::1]:8888"),
        Some("[2408:4005:1000::1]:7789"),
        true,
        None
    ));

    // Reject: different IPv4 host.
    assert!(!check(
        Some("http://192.168.1.11:7788"),
        Some("192.168.1.10:7788"),
        false,
        None
    ));

    // Reject: Origin without a scheme.
    assert!(!check(
        Some("192.168.1.10:7788"),
        Some("192.168.1.10:7788"),
        false,
        None
    ));
}

#[test]
fn test_csrf_ignores_x_forwarded_host() {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(header::ORIGIN, "http://evil.com".parse().unwrap());
    headers.insert(header::HOST, "192.168.1.10:7788".parse().unwrap());
    headers.insert("x-forwarded-host", "evil.com".parse().unwrap());
    assert!(server::verify_csrf(&headers, false).is_err());
}

#[tokio::test]
async fn test_tls_pairing_sets_secure_cookie() {
    let h = harness();

    // Plain HTTP pairing does NOT set Secure
    let (code1, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let (status, headers, _) = call(&h, pair_request(&code1)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let cookie = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(!cookie.contains("Secure"));

    // Pairing over TLS (via TlsConnection extension layer) sets Secure
    let (code2, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let tls_router = server::router(h.ctx.clone()).layer(axum::Extension(server::TlsConnection));
    let res = tls_router.oneshot(pair_request(&code2)).await.unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    let cookie = res.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(cookie.contains("; Secure"));

    // Pairing behind reverse proxy with x-forwarded-proto: https also sets Secure
    let (code3, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let mut req = pair_request(&code3);
    req.headers_mut()
        .insert("x-forwarded-proto", "https".parse().unwrap());
    let res = server::router(h.ctx.clone()).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    let cookie = res.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(cookie.contains("; Secure"));
}

/// Every route that takes a session id must treat a live draft as a real,
/// empty session (never 「会话不存在」), including after the first prompt.
#[tokio::test]
async fn draft_ids_are_accepted_by_every_session_route() {
    let h = harness();
    let cookie = pair(&h).await;
    let cwd = std::env::temp_dir().join(format!("ompws-draft-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&cwd).unwrap();
    let info = super::api::draft::create(
        cwd.to_string_lossy().to_string(),
        crate::contracts::SpaceMode::Code,
        None,
        None,
    )
    .await;
    let id = info.session_id;
    assert!(id.starts_with("mobile-draft-"));

    let (s, _, body) = call(
        &h,
        get(&format!("/api/sessions/{id}/transcript"), Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "transcript: {body}");
    let page: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(page["items"], json!([]));

    let (s, _, body) = call(
        &h,
        get(&format!("/api/sessions/{id}/pending-ui"), Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "pending-ui: {body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!([]));

    let (s, _, body) = call(
        &h,
        get(&format!("/api/sessions/{id}/composer-state"), Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "composer-state: {body}");
    let st: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(st["live"], false);
    assert_eq!(st["contextTokens"], Value::Null);

    let (s, _, body) = call(
        &h,
        get(&format!("/api/sessions/{id}/slash-commands"), Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "slash-commands: {body}");
    assert!(serde_json::from_str::<Value>(&body)
        .unwrap()
        .as_array()
        .is_some_and(|a| !a.is_empty()));

    for path in ["plan", "subagents", "last"] {
        let (s, _, body) = call(
            &h,
            get(&format!("/api/sessions/{id}/{path}"), Some(&cookie)),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{path}: {body}");
    }
    let (s, _, body) = call(&h, get(&format!("/api/sessions/{id}/files"), Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK, "files: {body}");

    // First prompt hands the draft off to the real session id.
    let (s, _, body) = call(
        &h,
        post(
            &format!("/api/sessions/{id}/prompt-ex"),
            &cookie,
            json!({"text": "hello", "images": []}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "prompt-ex: {body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["sessionId"], "mock-real-1");
    assert!(!super::api::draft::is_draft(&id), "draft consumed");
    assert!(h
        .ctx
        .backend
        .calls
        .lock()
        .iter()
        .any(|c| c == "deliver mock-real-1 hello"));
    let _ = std::fs::remove_dir_all(&cwd);
}

#[tokio::test]
async fn batch_approve_answers_only_tool_approvals() {
    let h = harness();
    let cookie = pair(&h).await;
    *h.ctx.backend.extra_pending.lock() = vec![
        json!({"id": "t1", "method": "select", "title": "Allow tool: bash\nCommand: ls", "options": ["Approve Once", "Approve", "Deny"]}),
        json!({"id": "t2", "method": "confirm", "title": "Proceed?"}),
        json!({"id": "q1", "method": "select", "title": "Pick a color", "options": ["Red", "Blue"]}),
        json!({"id": "t3", "method": "select", "title": "Allow tool: rm", "options": ["Yes", "No"]}),
    ];
    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/a/ui-respond-all",
            &cookie,
            json!({"action": "approve", "ids": ["r1", "t1", "t2", "q1", "t3"]}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    // t1 + t2 handled; r1 (input), q1 (question), t3 (no exact labels) skipped.
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v,
        json!({"handled": 2, "skipped": 3, "handledIds": ["t1", "t2"]})
    );
    let calls = h.ctx.backend.calls.lock().clone();
    assert_eq!(calls.len(), 2);
    assert!(
        calls[0].contains("\"value\":\"Approve Once\"") && calls[0].contains("\"confirmed\":true")
    );
    assert!(calls[1].contains("\"id\":\"t2\"") && calls[1].contains("\"confirmed\":true"));

    // Deny uses the exact Deny label and confirmed:false.
    *h.ctx.backend.extra_pending.lock() = vec![
        json!({"id": "t4", "method": "select", "title": "Allow tool: bash", "options": ["Approve", "Deny"]}),
    ];
    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/a/ui-respond-all",
            &cookie,
            json!({"action": "deny", "ids": ["r1", "t4"]}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!({"handled": 1, "skipped": 1, "handledIds": ["t4"]})
    );
    let last = h.ctx.backend.calls.lock().last().cloned().unwrap();
    assert!(last.contains("\"value\":\"Deny\"") && last.contains("\"cancelled\":true"));

    let (s, _, _) = call(
        &h,
        post(
            "/api/sessions/a/ui-respond-all",
            &cookie,
            json!({"action": "nuke", "ids": []}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _, _) = call(
        &h,
        post(
            "/api/sessions/z/ui-respond-all",
            &cookie,
            json!({"action": "approve", "ids": []}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "archived");
    let (s, _, _) = call(
        &h,
        post(
            "/api/sessions/nope/ui-respond-all",
            &cookie,
            json!({"action": "approve", "ids": []}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn batch_approval_requires_seen_ids_and_never_answers_new_arrivals() {
    let h = harness();
    let cookie = pair(&h).await;
    *h.ctx.backend.extra_pending.lock() = vec![
        json!({"id":"seen", "method":"confirm"}),
        json!({"id":"arrived-later", "method":"confirm"}),
    ];
    let (s, _, _) = call(
        &h,
        post(
            "/api/sessions/a/ui-respond-all",
            &cookie,
            json!({"action":"approve"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(h.ctx.backend.calls.lock().is_empty());
    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/a/ui-respond-all",
            &cookie,
            json!({"action":"approve", "ids":["seen", "seen", "gone"]}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!({"handled":1,"skipped":1,"handledIds":["seen"]})
    );
    assert_eq!(h.ctx.backend.calls.lock().len(), 1);
    assert_eq!(h.ctx.backend.extra_pending.lock()[0]["id"], "arrived-later");
    let (_, _, body) = call(
        &h,
        post(
            "/api/sessions/a/ui-respond-all",
            &cookie,
            json!({"action":"deny", "ids":[]}),
        ),
    )
    .await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["handled"], 0);
    assert_eq!(h.ctx.backend.calls.lock().len(), 1);
}

#[tokio::test]
async fn push_endpoints_subscribe_test_unsubscribe() {
    use base64::Engine as _;
    let h = harness();
    let (s, _, _) = call(&h, get("/api/push/public-key", None)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let cookie = pair(&h).await;

    let (s, _, body) = call(&h, get("/api/push/public-key", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK);
    let key = serde_json::from_str::<Value>(&body).unwrap()["publicKey"]
        .as_str()
        .unwrap()
        .to_string();
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&key)
        .unwrap();
    assert_eq!((raw.len(), raw[0]), (65, 4));
    let (_, _, again) = call(&h, get("/api/push/public-key", Some(&cookie))).await;
    assert!(again.contains(&key), "stable across calls");

    // Test before subscribing: nothing to send to.
    let (s, _, _) = call(&h, post("/api/push/test", &cookie, json!({}))).await;
    assert_eq!(s, StatusCode::CONFLICT);

    let ua = ring::agreement::EphemeralPrivateKey::generate(
        &ring::agreement::ECDH_P256,
        &ring::rand::SystemRandom::new(),
    )
    .unwrap();
    let enc = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    let sub = json!({
        "endpoint": "https://fcm.googleapis.com/fcm/send/abc",
        "keys": {"p256dh": enc(ua.compute_public_key().unwrap().as_ref()), "auth": enc(&[3u8; 16])},
    });
    let (s, _, _) = call(&h, post("/api/push/subscribe", &cookie, sub.clone())).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = call(
        &h,
        post(
            "/api/push/subscribe",
            &cookie,
            json!({"endpoint": "https://127.0.0.1/x", "keys": sub["keys"]}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _, body) = call(&h, post("/api/push/test", &cookie, json!({}))).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        (v["sent"].as_u64(), v["removed"].as_u64()),
        (Some(1), Some(0))
    );
    assert!(h
        .ctx
        .backend
        .calls
        .lock()
        .iter()
        .any(|c| c == "push https://fcm.googleapis.com/fcm/send/abc"));

    // 410 Gone deletes the subscription.
    *h.ctx.backend.push_status.lock() = 410;
    let (_, _, body) = call(&h, post("/api/push/test", &cookie, json!({}))).await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["removed"], 1);
    let (s, _, _) = call(&h, post("/api/push/test", &cookie, json!({}))).await;
    assert_eq!(s, StatusCode::CONFLICT);

    // Unsubscribe is idempotent.
    call(&h, post("/api/push/subscribe", &cookie, sub.clone())).await;
    let un = json!({"endpoint": "https://fcm.googleapis.com/fcm/send/abc"});
    let (_, _, body) = call(&h, post("/api/push/unsubscribe", &cookie, un.clone())).await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["removed"], 1);
    let (s, _, body) = call(&h, post("/api/push/unsubscribe", &cookie, un)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["removed"], 0);
}

#[tokio::test]
async fn presence_and_quota_and_voice_endpoints() {
    let h = harness();
    // Unauthorized
    let (s, _, _) = call(&h, get("/api/quota", None)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _, _) = call(&h, post("/api/presence", "", json!({}))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _, _) = call(&h, post("/api/voice/transcribe", "", json!({}))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let cookie = pair(&h).await;

    // 1. Quota endpoint
    let (s, _, body) = call(&h, get("/api/quota", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert!(v.get("providers").is_some());
    assert!(v.get("updatedAt").is_some());

    // 2. Presence endpoint
    let (s, _, body) = call(
        &h,
        post(
            "/api/presence",
            &cookie,
            json!({ "sessionId": "s-test", "visible": true }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["ok"], true);

    // 3. A genuinely empty body is rejected before the transcription backend.
    let req = Request::post("/api/voice/transcribe")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "audio/webm")
        .body(Body::empty())
        .unwrap();
    let (s, _, body) = call(&h, req).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!({"error": {"code": "empty_audio", "message": "音频数据为空"}}),
    );
    assert!(h.ctx.backend.voice_calls.lock().is_empty());
}

fn voice_request(cookie: &str, content_type: Option<&str>, body: impl Into<Body>) -> Request<Body> {
    let mut req = Request::post("/api/voice/transcribe").header(header::COOKIE, cookie);
    if let Some(content_type) = content_type {
        req = req.header(header::CONTENT_TYPE, content_type);
    }
    req.body(body.into()).unwrap()
}

#[tokio::test]
async fn voice_rejections_never_call_transcription_backend() {
    let h = harness();
    let (status, _, _) = call(
        &h,
        voice_request("", Some("audio/webm"), Body::from("voice")),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let cookie = pair(&h).await;
    for (content_type, body, status, code, message) in [
        (
            Some("audio/webm"),
            Body::empty(),
            StatusCode::BAD_REQUEST,
            "empty_audio",
            "音频数据为空",
        ),
        (
            None,
            Body::empty(),
            StatusCode::BAD_REQUEST,
            "empty_audio",
            "音频数据为空",
        ),
        (
            Some("application/json"),
            Body::from("{}"),
            StatusCode::BAD_REQUEST,
            "invalid_audio_type",
            "请求内容必须为音频数据",
        ),
        (
            Some("application/problem+json; charset=utf-8"),
            Body::from("{}"),
            StatusCode::BAD_REQUEST,
            "invalid_audio_type",
            "请求内容必须为音频数据",
        ),
        (
            Some("audio/webm"),
            Body::from(vec![0_u8; super::api::voice::MAX_AUDIO_SIZE + 1]),
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "音频文件大小超出 25MB 限制",
        ),
    ] {
        let (actual_status, _, body) = call(&h, voice_request(&cookie, content_type, body)).await;
        assert_eq!(actual_status, status, "{body}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"error": {"code": code, "message": message}}),
        );
        assert!(h.ctx.backend.voice_calls.lock().is_empty());
    }
}

#[tokio::test]
async fn voice_raw_audio_preserves_payload_and_mime_once() {
    let h = harness();
    let cookie = pair(&h).await;
    let audio = b"RIFF\x00\x00\x00\x00WAVEfmt ";
    for (index, (content_type, expected_type, filename)) in [
        (
            Some("audio/webm;codecs=opus"),
            "audio/webm;codecs=opus",
            "audio.webm",
        ),
        (Some("audio/mp4"), "audio/mp4", "audio.mp4"),
        (Some("audio/ogg"), "audio/ogg", "audio.ogg"),
        (Some("audio/wav"), "audio/wav", "audio.wav"),
        (Some("application/octet-stream"), "audio/wav", "audio.wav"),
        (None, "audio/wav", "audio.wav"),
    ]
    .into_iter()
    .enumerate()
    {
        let (status, headers, body) = call(
            &h,
            voice_request(&cookie, content_type, Body::from(audio.as_slice())),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"text": "受控转写"})
        );
        let calls = h.ctx.backend.voice_calls.lock();
        assert_eq!(calls.len(), index + 1);
        assert_eq!(calls[index].bytes.as_ref(), audio);
        assert_eq!(calls[index].content_type, expected_type);
        assert_eq!(calls[index].filename, filename);
    }
}

#[tokio::test]
async fn voice_multipart_preserves_audio_and_rejects_non_audio() {
    let h = harness();
    let cookie = pair(&h).await;
    for (content_type, bytes, expected_status) in [
        ("audio/ogg;codecs=opus", "OggS\u{0}\u{2}", StatusCode::OK),
        ("application/json", "{}", StatusCode::BAD_REQUEST),
    ] {
        let body = format!(
            "--voice-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.ogg\"\r\nContent-Type: {content_type}\r\n\r\n{bytes}\r\n--voice-boundary--\r\n"
        );
        let (status, _, body) = call(
            &h,
            voice_request(
                &cookie,
                Some("multipart/form-data; boundary=voice-boundary"),
                Body::from(body),
            ),
        )
        .await;
        assert_eq!(status, expected_status, "{body}");
        if expected_status == StatusCode::OK {
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"text": "受控转写"})
            );
        } else {
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"error": {"code": "invalid_audio_type", "message": "请求内容必须为音频数据"}}),
            );
        }
    }
    let calls = h.ctx.backend.voice_calls.lock();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].bytes.as_ref(), b"OggS\x00\x02");
    assert_eq!(calls[0].filename, "recording.ogg");
    assert_eq!(calls[0].content_type, "audio/ogg;codecs=opus");
}

#[tokio::test]
async fn voice_backend_errors_preserve_exact_status_and_structure() {
    let h = harness();
    let cookie = pair(&h).await;
    for (index, status) in [
        StatusCode::BAD_REQUEST,
        StatusCode::BAD_GATEWAY,
        StatusCode::GATEWAY_TIMEOUT,
    ]
    .into_iter()
    .enumerate()
    {
        let error = json!({"error": {"code": "controlled_error", "message": "受控失败详情"}});
        *h.ctx.backend.voice_result.lock() = Err((status, error.clone()));
        let (actual_status, headers, body) = call(
            &h,
            voice_request(&cookie, Some("audio/webm"), Body::from("voice")),
        )
        .await;
        assert_eq!(actual_status, status);
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), error);
        assert_eq!(h.ctx.backend.voice_calls.lock().len(), index + 1);
    }
}

#[tokio::test]
async fn tree_endpoints_refuse_offline_sessions() {
    let h = harness();
    let cookie = pair(&h).await;
    // No live omp process in the mock harness: both endpoints say so clearly
    // and never touch state.
    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/a/navigate-tree",
            &cookie,
            json!({"entryId": "e1"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT, "{body}");
    assert!(body.contains("会话未在运行"), "{body}");
    let (s, _, body) = call(&h, get("/api/sessions/a/tree", Some(&cookie))).await;
    assert_eq!(s, StatusCode::CONFLICT, "{body}");
    assert!(body.contains("会话未在运行"), "{body}");
    // Unknown session id: 404 from the shared loader, before the live check.
    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/nope/navigate-tree",
            &cookie,
            json!({"entryId": "e1"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{body}");
    assert!(body.contains("会话不存在"), "{body}");
}

#[tokio::test]
async fn sse_tree_navigated_maps_to_touch() {
    let h = harness();
    let cookie = pair(&h).await;
    let res = server::router(h.ctx.clone())
        .oneshot(get("/api/events", Some(&cookie)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = res.into_body();
    let _ = h.ctx.backend.bus.send(AppEvent::TreeNavigated {
        session_id: "a".into(),
    });
    let mut text = String::new();
    while !text.contains("event: touch") {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame())
            .await
            .expect("sse frame")
            .unwrap()
            .unwrap();
        if let Ok(data) = frame.into_data() {
            text.push_str(&String::from_utf8_lossy(&data));
        }
    }
    assert!(text.contains("\"sessionId\":\"a\""));
    h.shutdown.send(true).unwrap();
}

#[tokio::test]
async fn bearer_and_cookie_csrf_rules_are_split_strictly() {
    let h = harness();
    let cookie = pair(&h).await;
    let token = cookie.split_once('=').unwrap().1.to_string();
    let bearer = format!("Bearer {token}");
    let body_json = || Body::from(json!({"text":"hi"}).to_string());

    // 1. Cookie + cross-origin → 403.
    let req = Request::post("/api/sessions/a/prompt")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, "192.168.1.5:7788")
        .header(header::ORIGIN, "https://evil.example")
        .body(body_json())
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::FORBIDDEN);

    // 2. Bearer without auth cookie + stripped Origin/Referer → 200.
    let req = Request::post("/api/sessions/a/prompt")
        .header(header::AUTHORIZATION, &bearer)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, "192.168.1.5:7790")
        .header(header::USER_AGENT, "Vecway-iOS/0.2.0 (iPhone)")
        .body(body_json())
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::OK);

    // 3. Bearer without auth cookie + native WebView Origin (`vecway://app`) → 200.
    let req = Request::post("/api/sessions/a/prompt")
        .header(header::AUTHORIZATION, &bearer)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, "192.168.1.5:7790")
        .header(header::ORIGIN, "vecway://app")
        .body(body_json())
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::OK);

    // 4. Bearer without auth cookie + explicit Sec-Fetch-Site: cross-site → 403.
    let req = Request::post("/api/sessions/a/prompt")
        .header(header::AUTHORIZATION, &bearer)
        .header(header::CONTENT_TYPE, "application/json")
        .header("sec-fetch-site", "cross-site")
        .body(body_json())
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::FORBIDDEN);

    // 5. Bearer WITH auth cookie + cross-origin Origin → 403 (strict CSRF preserved).
    let req = Request::post("/api/sessions/a/prompt")
        .header(header::AUTHORIZATION, &bearer)
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, "192.168.1.5:7790")
        .header(header::ORIGIN, "https://evil.example")
        .body(body_json())
        .unwrap();
    assert_eq!(call(&h, req).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pairing_return_token_requires_https_preserves_code_and_supports_bearer_lifecycle() {
    let h = harness();
    let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();

    // Plaintext HTTP POST /pair with returnToken: true → 403 JSON, NO Set-Cookie, code NOT consumed.
    let plain_req = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::USER_AGENT, "Vecway-iOS/0.2.0 (iPhone)")
        .body(Body::from(
            json!({"code": code, "returnToken": true}).to_string(),
        ))
        .unwrap();
    let (status, headers, body) = call(&h, plain_req).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!headers.contains_key(header::SET_COOKIE));
    let err_json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        err_json["error"].as_str(),
        Some("App 令牌配对仅允许通过 HTTPS/TLS 连接")
    );

    // Same code over TLS succeeds with 200, Cache-Control: no-store, NO Set-Cookie, and {token, device}.
    let tls_router = server::router(h.ctx.clone()).layer(axum::Extension(server::TlsConnection));
    let tls_req = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::USER_AGENT, "Vecway-iOS/0.2.0 (iPhone)")
        .body(Body::from(
            json!({"code": code, "name": "My iPhone", "returnToken": true}).to_string(),
        ))
        .unwrap();
    let res = tls_router.clone().oneshot(tls_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!res.headers().contains_key(header::SET_COOKIE));
    let body_bytes = res.into_body().collect().await.unwrap().to_bytes();
    let paired: Value = serde_json::from_slice(&body_bytes).unwrap();
    let token = paired["token"].as_str().expect("token string").to_string();
    assert!(!token.is_empty());
    assert_eq!(paired["device"]["name"].as_str(), Some("My iPhone"));
    assert_eq!(
        paired["device"]["userAgent"].as_str(),
        Some("Vecway-iOS/0.2.0 (iPhone)")
    );
    let device_id = paired["device"]["id"]
        .as_str()
        .expect("device id")
        .to_string();

    // Reusing the same code over TLS returns 403 JSON (single-use).
    let reuse_req = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"code": code, "returnToken": true}).to_string(),
        ))
        .unwrap();
    let res = tls_router.clone().oneshot(reuse_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let reuse_bytes = res.into_body().collect().await.unwrap().to_bytes();
    let reuse_json: Value = serde_json::from_slice(&reuse_bytes).unwrap();
    assert!(reuse_json["error"].as_str().is_some_and(|s| !s.is_empty()));

    // Missing code with returnToken: true over TLS returns 403 JSON.
    let missing_req = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"returnToken": true}).to_string()))
        .unwrap();
    let res = tls_router.oneshot(missing_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let missing_bytes = res.into_body().collect().await.unwrap().to_bytes();
    let missing_json: Value = serde_json::from_slice(&missing_bytes).unwrap();
    assert!(missing_json["error"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));

    // x-forwarded-proto: https (Cloudflare Tunnel) also permits returnToken: true.
    let (tunnel_code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let tunnel_req = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-proto", "https")
        .header(header::USER_AGENT, "Vecway-iOS/0.2.0 (iPad)")
        .body(Body::from(
            json!({"code": tunnel_code, "returnToken": true}).to_string(),
        ))
        .unwrap();
    let (st, hdrs, bdy) = call(&h, tunnel_req).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs[header::CACHE_CONTROL], "no-store");
    assert!(!hdrs.contains_key(header::SET_COOKIE));
    let tunnel_paired: Value = serde_json::from_str(&bdy).unwrap();
    assert_eq!(tunnel_paired["device"]["name"].as_str(), Some("iPad"));

    // Cloudflare CF-Visitor: {"scheme":"https"} or multi-hop x-forwarded-proto also permits returnToken: true.
    let (cf_code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let cf_req = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .header("cf-visitor", r#"{"scheme":"https"}"#)
        .header(header::USER_AGENT, "Vecway-iOS/0.2.0 (iPhone)")
        .body(Body::from(
            json!({"code": cf_code, "returnToken": true}).to_string(),
        ))
        .unwrap();
    assert_eq!(call(&h, cf_req).await.0, StatusCode::OK);

    // Returned Bearer token works on GET /api/device, POST /api/sessions/a/prompt, and GET /api/events SSE.
    let bearer = format!("Bearer {token}");
    let dev_req = Request::get("/api/device")
        .header(header::AUTHORIZATION, &bearer)
        .body(Body::empty())
        .unwrap();
    let (st, _, dev_body) = call(&h, dev_req).await;
    assert_eq!(st, StatusCode::OK);
    let dev_json: Value = serde_json::from_str(&dev_body).unwrap();
    assert_eq!(dev_json["id"].as_str(), Some(device_id.as_str()));

    let post_req = Request::post("/api/sessions/a/prompt")
        .header(header::AUTHORIZATION, &bearer)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"text": "via bearer"}).to_string()))
        .unwrap();
    assert_eq!(call(&h, post_req).await.0, StatusCode::OK);

    let sse_req = Request::get("/api/events")
        .header(header::AUTHORIZATION, &bearer)
        .body(Body::empty())
        .unwrap();
    let sse_res = server::router(h.ctx.clone())
        .oneshot(sse_req)
        .await
        .unwrap();
    assert_eq!(sse_res.status(), StatusCode::OK);
    let mut sse_body = sse_res.into_body();
    sse_body.frame().await.unwrap().unwrap();

    // Revoking the device closes its SSE stream immediately and turns subsequent requests into 401.
    let hash = auth::hash_token(&token);
    assert_eq!(
        auth::revoke_device(&h.ctx.db.lock(), &device_id).unwrap(),
        Some(hash.clone())
    );
    auth::notify_revoked(&hash);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), sse_body.frame())
            .await
            .unwrap()
            .is_none(),
        "revoked Bearer SSE stream must close immediately"
    );

    let revoked_get = Request::get("/api/device")
        .header(header::AUTHORIZATION, &bearer)
        .body(Body::empty())
        .unwrap();
    assert_eq!(call(&h, revoked_get).await.0, StatusCode::UNAUTHORIZED);

    let revoked_post = Request::post("/api/sessions/a/prompt")
        .header(header::AUTHORIZATION, &bearer)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"text": "after revoke"}).to_string()))
        .unwrap();
    assert_eq!(call(&h, revoked_post).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn pairing_without_return_token_preserves_web_cookie_behavior() {
    let h = harness();
    // JSON without returnToken → 204 + Set-Cookie.
    let (code1, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let req1 = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"code": code1}).to_string()))
        .unwrap();
    let (status1, headers1, body1) = call(&h, req1).await;
    assert_eq!(status1, StatusCode::NO_CONTENT);
    assert!(headers1.contains_key(header::SET_COOKIE));
    assert!(body1.is_empty());

    // JSON with explicit returnToken: false → 204 + Set-Cookie.
    let (code2, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let req2 = Request::post("/pair")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"code": code2, "returnToken": false}).to_string(),
        ))
        .unwrap();
    let (status2, headers2, _) = call(&h, req2).await;
    assert_eq!(status2, StatusCode::NO_CONTENT);
    assert!(headers2.contains_key(header::SET_COOKIE));

    // Form POST → 303 + Set-Cookie + Location: /.
    let (code3, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let (status3, headers3, _) = call(&h, pair_request(&code3)).await;
    assert_eq!(status3, StatusCode::SEE_OTHER);
    assert_eq!(headers3[header::LOCATION], "/");
    assert!(headers3.contains_key(header::SET_COOKIE));
}

#[derive(Debug)]
struct PinCaptureVerifier {
    expected_sha256: String,
    captured_sha256: Arc<Mutex<Option<String>>>,
}

impl rustls::client::danger::ServerCertVerifier for PinCaptureVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let actual = super::tls::compute_fingerprint(end_entity.as_ref());
        *self.captured_sha256.lock() = Some(actual.clone());
        if actual == self.expected_sha256 {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("certificate pin mismatch".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

async fn tls_http_request(
    addr: std::net::SocketAddr,
    expected_sha256: &str,
    raw_request: &str,
) -> Result<(String, String, Option<String>), std::io::Error> {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let captured = Arc::new(Mutex::new(None));
    let verifier = Arc::new(PinCaptureVerifier {
        expected_sha256: expected_sha256.to_string(),
        captured_sha256: captured.clone(),
    });
    let client_config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .dangerous()
    .with_custom_certificate_verifier(verifier)
    .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client_config));
    let tcp = tokio::net::TcpStream::connect(addr).await?;
    let server_name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
    let mut tls = connector.connect(server_name, tcp).await?;
    tls.write_all(raw_request.as_bytes()).await?;
    tls.flush().await?;
    let mut buf = Vec::new();
    match tls.read_to_end(&mut buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof && !buf.is_empty() => {}
        Err(e) => return Err(e),
    }
    let response = String::from_utf8_lossy(&buf).to_string();
    let (head, body) = response
        .split_once("\r\n\r\n")
        .map(|(h, b)| (h.to_string(), b.to_string()))
        .unwrap_or((response, String::new()));
    let fp = captured.lock().clone();
    Ok((head, body, fp))
}

#[tokio::test]
async fn serve_tls_loopback_matches_cert_fingerprint_and_pairs_return_token() {
    let h = harness();
    let tls_dir = h.dir.join("mobile-tls");
    let ident = super::tls::ensure_tls_identity_in(&tls_dir, None).unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(ident.server_config.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_task = tokio::spawn(server::serve_tls(listener, acceptor, h.ctx.clone()));

    // Wrong certificate pin must fail the TLS handshake before any HTTP bytes are sent.
    let wrong_pin = "00:".repeat(31) + "00";
    let wrong_req = format!(
        "GET /api/device HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        addr.port()
    );
    assert!(
        tls_http_request(addr, &wrong_pin, &wrong_req)
            .await
            .is_err(),
        "mismatched cert pin must abort TLS handshake"
    );

    // Matching pin succeeds: verify leaf DER SHA-256 == ident.cert_sha256 and POST /pair returnToken.
    let (code, _) = auth::create_pairing(&h.ctx.db.lock(), chrono::Utc::now()).unwrap();
    let pair_body = json!({"code": code, "returnToken": true}).to_string();
    let pair_req = format!(
        "POST /pair HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nUser-Agent: Vecway-iOS/0.2.0 (iPhone)\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        addr.port(),
        pair_body.len(),
        pair_body
    );
    let (head, body, peer_fp) = tls_http_request(addr, &ident.cert_sha256, &pair_req)
        .await
        .expect("pinned TLS pair request succeeds");
    assert_eq!(peer_fp.as_deref(), Some(ident.cert_sha256.as_str()));
    let head_lower = head.to_ascii_lowercase();
    assert!(head_lower.starts_with("http/1.1 200"), "{head}");
    assert!(
        head_lower.lines().any(|l| l == "cache-control: no-store"),
        "{head}"
    );
    assert!(!head_lower.contains("set-cookie:"), "{head}");
    let paired: Value = serde_json::from_str(&body).expect("json body");
    let token = paired["token"].as_str().expect("token");
    let device_id = paired["device"]["id"].as_str().expect("device id");
    assert_eq!(paired["device"]["name"].as_str(), Some("iPhone"));

    // Subsequent authenticated request over real TLS with Authorization: Bearer works.
    let dev_req = format!(
        "GET /api/device HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
        addr.port(),
        token
    );
    let (dev_head, dev_body, _) = tls_http_request(addr, &ident.cert_sha256, &dev_req)
        .await
        .expect("pinned TLS GET /api/device succeeds");
    assert!(dev_head.to_ascii_lowercase().starts_with("http/1.1 200"));
    let dev_json: Value = serde_json::from_str(&dev_body).expect("device json");
    assert_eq!(dev_json["id"].as_str(), Some(device_id));

    h.shutdown.send(true).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), server_task)
        .await
        .expect("tls server stops")
        .unwrap();
}

#[test]
fn pairing_url_encodes_dual_use_app_fragment_and_deep_link() {
    use crate::contracts::PairingTarget;
    use base64::Engine as _;

    let fp = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    let (dual, app) = super::build_pairing_urls(
        "http://192.168.1.10:7788",
        "CODE_abc-123",
        PairingTarget::Lan,
        Some("https://192.168.1.10:7790"),
        Some(fp),
        Some("https://[2408:4005::1]:7789"),
        Some("https://demo.trycloudflare.com"),
    );
    let (prefix, encoded) = dual
        .split_once("#app=")
        .expect("dual-use URL has #app= fragment");
    assert_eq!(prefix, "http://192.168.1.10:7788/pair?code=CODE_abc-123");
    let raw_json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .expect("valid base64url_nopad");
    let payload: Value = serde_json::from_slice(&raw_json).expect("compact JSON");
    assert_eq!(
        payload,
        json!({
            "v": 1,
            "t": "lan",
            "lt": "https://192.168.1.10:7790",
            "fp": fp,
            "v6": "https://[2408:4005::1]:7789",
            "tn": "https://demo.trycloudflare.com"
        })
    );

    let app_url = app.expect("app_url present");
    assert!(app_url.starts_with("vecway://pair?v=1&code=CODE_abc-123&t=lan&"));
    assert!(app_url.contains("&lt=https%3A%2F%2F192.168.1.10%3A7790"));
    assert!(app_url.contains("&fp=AA%3ABB%3ACC"));
    assert!(app_url.contains("&v6=https%3A%2F%2F%5B2408%3A4005%3A%3A1%5D%3A7789"));
    assert!(app_url.contains("&tn=https%3A%2F%2Fdemo.trycloudflare.com"));

    // Absent optional keys are omitted cleanly from both #app= JSON and vecway://pair.
    let (dual_tn, app_tn) = super::build_pairing_urls(
        "https://demo.trycloudflare.com/",
        "T_CODE",
        PairingTarget::Tunnel,
        None,
        None,
        None,
        Some("https://demo.trycloudflare.com"),
    );
    let (tn_prefix, tn_b64) = dual_tn.split_once("#app=").unwrap();
    assert_eq!(tn_prefix, "https://demo.trycloudflare.com/pair?code=T_CODE");
    let tn_payload: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(tn_b64)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        tn_payload,
        json!({
            "v": 1,
            "t": "tunnel",
            "tn": "https://demo.trycloudflare.com"
        })
    );
    let app_tn = app_tn.unwrap();
    assert_eq!(
        app_tn,
        "vecway://pair?v=1&code=T_CODE&t=tunnel&tn=https%3A%2F%2Fdemo.trycloudflare.com"
    );

    // IPv6 target sets t="ipv6" and omits absent tunnel.
    let (dual_v6, app_v6) = super::build_pairing_urls(
        "https://home.example.com:7789",
        "V6_CODE",
        PairingTarget::Ipv6,
        Some("https://192.168.1.10:7790"),
        Some(fp),
        Some("https://home.example.com:7789"),
        None,
    );
    let (_, v6_b64) = dual_v6.split_once("#app=").unwrap();
    let v6_payload: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(v6_b64)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(v6_payload["t"].as_str(), Some("ipv6"));
    assert!(v6_payload.get("tn").is_none());
    assert!(!app_v6.unwrap().contains("&tn="));

    // No https:// channel (or insecure http:// candidate) omits #app= and app_url completely.
    let (plain_only, no_app) = super::build_pairing_urls(
        "http://192.168.1.10:7788",
        "PLAIN",
        PairingTarget::Lan,
        Some("http://192.168.1.10:7790"),
        Some(fp),
        None,
        None,
    );
    assert_eq!(plain_only, "http://192.168.1.10:7788/pair?code=PLAIN");
    assert!(no_app.is_none());
}

async fn call_bytes(
    h: &Harness,
    req: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, axum::body::Bytes) {
    let res = server::router(h.ctx.clone()).oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, body)
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Read as _;
    let mut dec = flate2::read::GzDecoder::new(bytes);
    let mut out = Vec::new();
    dec.read_to_end(&mut out).expect("valid gzip stream");
    out
}

#[tokio::test]
async fn gzip_compresses_large_json_and_static_js_with_vary_and_skips_q0_and_small() {
    let h = harness();
    let cookie = pair(&h).await;
    let large_text = "vecway mobile gzip payload "
        .repeat(120)
        .trim_end()
        .to_string();
    let entry = json!({
        "id": "e1",
        "type": "message",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": large_text }]
        }
    });
    std::fs::write(&h.ctx.backend.file, format!("{entry}\n")).unwrap();

    // Large JSON API response compresses when client accepts gzip.
    let req = Request::get("/api/sessions/a/transcript")
        .header(header::COOKIE, &cookie)
        .header(header::ACCEPT_ENCODING, "deflate, gzip")
        .body(Body::empty())
        .unwrap();
    let (status, headers, body) = call_bytes(&h, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_ENCODING], "gzip");
    assert_eq!(headers[header::VARY], "Accept-Encoding");
    assert_eq!(headers[header::CONTENT_LENGTH], body.len().to_string());
    let plain = gunzip(&body);
    assert!(body.len() < plain.len());
    let page: Value = serde_json::from_slice(&plain).unwrap();
    assert_eq!(page["items"][0]["text"].as_str(), Some(large_text.as_str()));

    // `gzip;q=0` explicitly opts out of gzip while retaining Vary.
    let q0_req = Request::get("/api/sessions/a/transcript")
        .header(header::COOKIE, &cookie)
        .header(header::ACCEPT_ENCODING, "gzip;q=0")
        .body(Body::empty())
        .unwrap();
    let (q0_status, q0_headers, q0_body) = call_bytes(&h, q0_req).await;
    assert_eq!(q0_status, StatusCode::OK);
    assert!(!q0_headers.contains_key(header::CONTENT_ENCODING));
    assert_eq!(q0_headers[header::VARY], "Accept-Encoding");
    let q0_page: Value = serde_json::from_slice(&q0_body).unwrap();
    assert_eq!(
        q0_page["items"][0]["text"].as_str(),
        Some(large_text.as_str())
    );

    // Small JSON responses (< 1024 bytes) skip gzip while still setting Vary.
    let small_req = Request::get("/api/device")
        .header(header::COOKIE, &cookie)
        .header(header::ACCEPT_ENCODING, "gzip")
        .body(Body::empty())
        .unwrap();
    let (small_status, small_headers, small_body) = call_bytes(&h, small_req).await;
    assert_eq!(small_status, StatusCode::OK);
    assert!(!small_headers.contains_key(header::CONTENT_ENCODING));
    assert_eq!(small_headers[header::VARY], "Accept-Encoding");
    assert!(small_body.len() < 1024);

    // Static JS compresses via the same gzip middleware; binary assets are untouched.
    let large_js = "export function mobileChunk() { return 'vecway-mobile'; }\n".repeat(60);
    let large_js_expected = large_js.clone();
    let static_app = axum::Router::new()
        .route(
            "/static/app.js",
            axum::routing::get(move || {
                let js = large_js.clone();
                async move {
                    (
                        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                        js,
                    )
                }
            }),
        )
        .route(
            "/static/logo.png",
            axum::routing::get(|| async {
                ([(header::CONTENT_TYPE, "image/png")], vec![0x89u8; 2048])
            }),
        )
        .layer(axum::middleware::from_fn(server::gzip_middleware));

    let js_res = static_app
        .clone()
        .oneshot(
            Request::get("/static/app.js")
                .header(header::ACCEPT_ENCODING, "br, gzip;q=0.8")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(js_res.status(), StatusCode::OK);
    assert_eq!(js_res.headers()[header::CONTENT_ENCODING], "gzip");
    assert_eq!(js_res.headers()[header::VARY], "Accept-Encoding");
    let js_cl = js_res.headers()[header::CONTENT_LENGTH]
        .to_str()
        .unwrap()
        .to_string();
    let js_body = js_res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(js_cl, js_body.len().to_string());
    assert!(js_body.len() < large_js_expected.len());
    assert_eq!(gunzip(&js_body), large_js_expected.as_bytes());

    let png_res = static_app
        .oneshot(
            Request::get("/static/logo.png")
                .header(header::ACCEPT_ENCODING, "gzip")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(png_res.status(), StatusCode::OK);
    assert!(!png_res.headers().contains_key(header::CONTENT_ENCODING));
    assert!(!png_res.headers().contains_key(header::VARY));
    let png_body = png_res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(png_body.len(), 2048);
}

#[tokio::test]
async fn gzip_never_compresses_or_buffers_sse_events() {
    let h = harness();
    let cookie = pair(&h).await;
    let req = Request::get("/api/events")
        .header(header::COOKIE, &cookie)
        .header(header::ACCEPT_ENCODING, "gzip, deflate")
        .body(Body::empty())
        .unwrap();
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        server::router(h.ctx.clone()).oneshot(req),
    )
    .await
    .expect("SSE response must return immediately without body buffering")
    .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], "text/event-stream");
    assert!(!res.headers().contains_key(header::CONTENT_ENCODING));
    assert!(!res.headers().contains_key(header::VARY));

    let mut body = res.into_body();
    let _ = h.ctx.backend.bus.send(AppEvent::TodosChanged);
    let mut text = String::new();
    while !text.contains("event: todos") {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(3), body.frame())
            .await
            .expect("live SSE frame without buffering")
            .unwrap()
            .unwrap();
        if let Ok(data) = frame.into_data() {
            text.push_str(&String::from_utf8_lossy(&data));
        }
    }
    assert!(text.contains("event: hello"));
    assert!(text.contains("event: todos"));

    h.shutdown.send(true).unwrap();
    let end = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while let Some(Ok(_)) = body.frame().await {}
    })
    .await;
    assert!(end.is_ok(), "SSE stream ends cleanly on shutdown");
}

#[tokio::test]
async fn transcript_tail_pagination_and_legacy_backwards_compatibility() {
    let h = harness();
    let cookie = pair(&h).await;

    let line = |id: &str, role: &str, text: &str| {
        format!(
            "{}\n",
            json!({
                "id": id,
                "type": "message",
                "message": {
                    "role": role,
                    "content": [{ "type": "text", "text": text }]
                }
            })
        )
    };
    let initial = [
        line("e0", "user", "msg-0"),
        line("h1", "developer", "hidden-system"),
        line("e1", "assistant", "msg-1"),
        line("e2", "user", "msg-2"),
        line("e3", "assistant", "msg-3"),
        line("e4", "user", "msg-4"),
    ]
    .concat();
    std::fs::write(&h.ctx.backend.file, &initial).unwrap();
    let initial_len = initial.len() as u64;

    let item_ids = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_string())
            .collect()
    };

    // Legacy call without `limit` returns all visible items without pagination metadata.
    let (s, _, body) = call(&h, get("/api/sessions/a/transcript", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let legacy: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(item_ids(&legacy), vec!["e0", "e1", "e2", "e3", "e4"]);
    assert_eq!(legacy["nextOffset"].as_u64(), Some(initial_len));
    assert_eq!(legacy["tailId"].as_str(), Some("e4"));
    assert!(legacy.get("hasMore").is_none());
    assert!(legacy.get("oldestIndex").is_none());
    assert!(legacy.get("totalItems").is_none());

    // Tail window (`?limit=2`) returns the last 2 visible items and keeps EOF `nextOffset`.
    let (s, _, body) = call(&h, get("/api/sessions/a/transcript?limit=2", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let p1: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(item_ids(&p1), vec!["e3", "e4"]);
    assert_eq!(p1["hasMore"], json!(true));
    assert_eq!(p1["oldestIndex"], json!(3));
    assert_eq!(p1["totalItems"], json!(5));
    assert_eq!(p1["nextOffset"].as_u64(), Some(initial_len));
    assert_eq!(p1["tailId"].as_str(), Some("e4"));

    // Load older page (`?before=3&limit=2`).
    let (s, _, body) = call(
        &h,
        get("/api/sessions/a/transcript?before=3&limit=2", Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let p2: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(item_ids(&p2), vec!["e1", "e2"]);
    assert_eq!(p2["hasMore"], json!(true));
    assert_eq!(p2["oldestIndex"], json!(1));
    assert_eq!(p2["totalItems"], json!(5));

    // Load final older page (`?before=1&limit=2`).
    let (s, _, body) = call(
        &h,
        get("/api/sessions/a/transcript?before=1&limit=2", Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let p3: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(item_ids(&p3), vec!["e0"]);
    assert_eq!(p3["hasMore"], json!(false));
    assert_eq!(p3["oldestIndex"], json!(0));
    assert_eq!(p3["totalItems"], json!(5));

    // `before=0` returns empty page cleanly.
    let (s, _, body) = call(
        &h,
        get("/api/sessions/a/transcript?before=0&limit=2", Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let p_empty: Value = serde_json::from_str(&body).unwrap();
    assert!(item_ids(&p_empty).is_empty());
    assert_eq!(p_empty["hasMore"], json!(false));
    assert_eq!(p_empty["oldestIndex"], json!(0));
    assert_eq!(p_empty["totalItems"], json!(5));

    // Incremental append (`from > 0`) uses EOF `nextOffset` and ignores `limit`.
    let appended = line("e5", "assistant", "msg-5");
    std::fs::write(&h.ctx.backend.file, format!("{initial}{appended}")).unwrap();
    let (s, _, body) = call(
        &h,
        get(
            &format!("/api/sessions/a/transcript?from={initial_len}&tail=e4&limit=2"),
            Some(&cookie),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let inc: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(item_ids(&inc), vec!["e5"]);
    assert_eq!(inc["reset"], json!(false));
    assert_eq!(inc["tailId"].as_str(), Some("e5"));
    assert_eq!(
        inc["nextOffset"].as_u64(),
        Some(initial_len + appended.len() as u64)
    );
    assert!(inc.get("hasMore").is_none());
}

#[test]
fn tls_server_config_advertises_h2_and_http11_alpn() {
    let dir = std::env::temp_dir().join(format!("omp-tls-alpn-{}", uuid::Uuid::new_v4()));
    let ident = super::tls::ensure_tls_identity_in(&dir, None).unwrap();
    assert_eq!(
        ident.server_config.alpn_protocols,
        vec![b"h2".to_vec(), b"http/1.1".to_vec()]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn pairing_url_includes_lan_tls_and_fingerprint_for_tunnel_target_and_trims_slashes() {
    use crate::contracts::PairingTarget;
    use base64::Engine as _;

    let fp = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    let (dual, app) = super::build_pairing_urls(
        "https://demo.trycloudflare.com/",
        "TN_CODE",
        PairingTarget::Tunnel,
        Some("https://192.168.1.10:7790/"),
        Some(fp),
        None,
        Some("https://demo.trycloudflare.com/"),
    );
    let (_, encoded) = dual.split_once("#app=").expect("dual URL has #app=");
    let payload: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        payload,
        json!({
            "v": 1,
            "t": "tunnel",
            "lt": "https://192.168.1.10:7790",
            "fp": fp,
            "tn": "https://demo.trycloudflare.com"
        })
    );
    let app_url = app.expect("app URL present");
    assert!(app_url.contains("&lt=https%3A%2F%2F192.168.1.10%3A7790"));
    assert!(app_url.contains("&fp=AA%3ABB%3ACC"));
    assert!(app_url.contains("&tn=https%3A%2F%2Fdemo.trycloudflare.com"));
}

#[tokio::test]
async fn transcript_preserves_parent_chain_across_dropped_hidden_items() {
    let h = harness();
    let cookie = pair(&h).await;
    let lines = [
        json!({
            "id": "u1",
            "parentId": null,
            "type": "message",
            "message": { "role": "user", "content": [{ "type": "text", "text": "hi" }] }
        }),
        json!({
            "id": "h-custom-msg",
            "parentId": "u1",
            "type": "custom_message",
            "customType": "context",
            "content": "hidden custom message",
            "display": false
        }),
        json!({
            "id": "h-digest",
            "parentId": "h-custom-msg",
            "type": "custom",
            "customType": "system-prompt-digest",
            "data": { "hash": "abc" }
        }),
        json!({
            "id": "a1",
            "parentId": "h-digest",
            "type": "message",
            "message": { "role": "assistant", "content": [{ "type": "text", "text": "hello!" }] }
        }),
    ]
    .into_iter()
    .map(|v| format!("{v}\n"))
    .collect::<String>();
    std::fs::write(&h.ctx.backend.file, lines).unwrap();

    let (status, _, body) = call(&h, get("/api/sessions/a/transcript", Some(&cookie))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let page: Value = serde_json::from_str(&body).unwrap();
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "hidden items must stay omitted: {body}");
    assert_eq!(items[0]["id"], "u1");
    assert_eq!(items[1]["id"], "a1");
    assert_eq!(
        items[1]["parentId"].as_str(),
        Some("u1"),
        "assistant parentId must bypass dropped hidden entries: {body}"
    );
}

#[tokio::test]
async fn draft_handoff_cancellation_releases_claim_for_retry() {
    let h = harness();
    let draft = super::api::draft::create(
        h.dir.to_string_lossy().into_owned(),
        crate::contracts::SpaceMode::Code,
        None,
        None,
    )
    .await;
    let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
    let (_never_tx, never_rx) = tokio::sync::oneshot::channel::<()>();

    let mut fut = Box::pin(super::api::draft::handoff(
        &h.ctx,
        &draft.session_id,
        |_real, _sel| async move {
            let _ = started_tx.send(());
            let _ = never_rx.await;
            Ok::<_, server::ApiError>(())
        },
    ));
    tokio::select! {
        _ = &mut fut => panic!("handoff should still be pending"),
        _ = started_rx => {}
    }
    let conflict = super::api::draft::handoff(&h.ctx, &draft.session_id, |_real, _sel| async {
        Ok::<_, server::ApiError>("dup")
    })
    .await
    .unwrap_err();
    assert_eq!(conflict.0, StatusCode::CONFLICT);
    // Dropping the in-flight `handoff` future must release the `sending` claim.
    drop(fut);

    let retried = super::api::draft::handoff(&h.ctx, &draft.session_id, |_real, _sel| async {
        Ok::<_, server::ApiError>("ok")
    })
    .await
    .expect("retry after cancelled handoff must not fail with 409 CONFLICT");
    assert_eq!(retried, Some(("mock-real-1".into(), "ok")));
}

#[tokio::test]
async fn git_actions_work_for_session_rooted_in_repo_subdirectory() {
    use crate::git::cmd::git_ok;

    let h = harness();
    let cookie = pair(&h).await;
    let repo = h.dir.join("repo");
    let subdir = repo.join("packages").join("app");
    std::fs::create_dir_all(&subdir).unwrap();
    let g = |args: &[&str]| git_ok(&repo, args).unwrap();
    g(&["init", "-q"]);
    g(&["config", "user.name", "t"]);
    g(&["config", "user.email", "t@example.com"]);
    g(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("root.txt"), "root\n").unwrap();
    std::fs::write(subdir.join("file.txt"), "one\n").unwrap();
    g(&["add", "-A"]);
    g(&["commit", "-q", "-m", "init"]);
    std::fs::write(subdir.join("file.txt"), "one\ntwo\n").unwrap();
    std::fs::write(repo.join("root.txt"), "root\nchanged\n").unwrap();

    // 1. Session in subdirectory with `repo_root` pointing to the repository root.
    *h.ctx.backend.cwd_override.lock() = Some(subdir.to_string_lossy().into_owned());
    *h.ctx.backend.repo_root_override.lock() = Some(repo.to_string_lossy().into_owned());

    let (s, _, body) = call(&h, get("/api/sessions/a/git/status", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let st: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(st["isRepo"], true);

    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/a/git/stage",
            &cookie,
            json!({ "paths": ["packages/app/file.txt"] }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");

    let (s, _, body) = call(
        &h,
        get(
            "/api/sessions/a/git/diff?path=packages/app/file.txt&staged=true",
            Some(&cookie),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let staged_diff: Value = serde_json::from_str(&body).unwrap();
    assert!(staged_diff["diff"].as_str().unwrap().contains("+two"));

    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/a/git/unstage",
            &cookie,
            json!({ "paths": ["packages/app/file.txt"] }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");

    let (s, _, body) = call(
        &h,
        get(
            "/api/sessions/a/git/diff?path=packages/app/file.txt&staged=false",
            Some(&cookie),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let unstaged_diff: Value = serde_json::from_str(&body).unwrap();
    assert!(unstaged_diff["diff"].as_str().unwrap().contains("+two"));

    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/a/git/stage",
            &cookie,
            json!({ "paths": ["packages/app/file.txt"] }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");

    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/a/git/commit",
            &cookie,
            json!({ "message": "update subdir file" }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    assert_eq!(
        g(&["log", "-1", "--format=%s"]).trim(),
        "update subdir file"
    );

    // 2. Without `repo_root`, paths inside `sc.cwd` succeed while paths outside `sc.roots` are forbidden.
    *h.ctx.backend.repo_root_override.lock() = None;
    std::fs::write(subdir.join("file.txt"), "one\ntwo\nthree\n").unwrap();

    let (s, _, body) = call(&h, get("/api/sessions/a/git/status", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let filtered: Value = serde_json::from_str(&body).unwrap();
    let paths: Vec<&str> = filtered["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"packages/app/file.txt"));
    assert!(!paths.contains(&"root.txt"));

    let (s, _, body) = call(
        &h,
        post(
            "/api/sessions/a/git/stage",
            &cookie,
            json!({ "paths": ["packages/app/file.txt"] }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");

    let (s, _, _) = call(
        &h,
        post(
            "/api/sessions/a/git/stage",
            &cookie,
            json!({ "paths": ["root.txt"] }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    let (s, _, _) = call(
        &h,
        get(
            "/api/sessions/a/git/diff?path=root.txt&staged=false",
            Some(&cookie),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

fn migrated_harness() -> Harness {
    let dir = std::env::temp_dir().join(format!("ompws-mobile-mig-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("s.jsonl");
    std::fs::write(
        &file,
        r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"full last answer"}]}}"#,
    )
    .unwrap();
    let db = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::migrate(&db).unwrap();
    let (bus, _) = broadcast::channel(16);
    let (tx, rx) = watch::channel(false);
    let ctx = Arc::new(Ctx {
        backend: Mock {
            calls: Mutex::new(Vec::new()),
            bus,
            file: file.to_string_lossy().to_string(),
            extra_pending: Mutex::new(Vec::new()),
            push_status: Mutex::new(201),
            voice_calls: Mutex::new(Vec::new()),
            voice_result: Mutex::new(Ok(json!({ "text": "受控转写" }))),
            cwd_override: Mutex::new(None),
            repo_root_override: Mutex::new(None),
            started_opts: Mutex::new(Vec::new()),
            delivered_prompts: Mutex::new(Vec::new()),
            extra_sessions: Mutex::new(Vec::new()),
        },
        db: Arc::new(parking_lot::Mutex::new(db)),
        shutdown: rx,
    });
    Harness {
        ctx,
        shutdown: tx,
        dir,
    }
}

#[tokio::test]
async fn transcript_preserves_automation_tool_details_and_caps_long_ids() {
    let h = harness();
    let cookie = pair(&h).await;
    let long_id = "d".repeat(320);
    let lines = [
        json!({
            "type": "message",
            "id": "tr1",
            "parentId": null,
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {
                "role": "user",
                "toolCallId": "tc1",
                "toolName": "vecway_automation",
                "content": [{"type": "text", "text": "Staged draft"}],
                "details": {
                    "draftId": "draft-123",
                    "action": "propose",
                    "scheduleId": "sched-456",
                    "diff": "+added",
                    "extraNoise": "must-be-dropped"
                }
            }
        })
        .to_string(),
        json!({
            "type": "message",
            "id": "tr2",
            "parentId": "tr1",
            "timestamp": "2026-01-01T00:00:01Z",
            "message": {
                "role": "user",
                "toolCallId": "tc2",
                "toolName": "vecway_automation",
                "content": [{"type": "text", "text": "Long id"}],
                "details": { "draftId": long_id }
            }
        })
        .to_string(),
    ]
    .join("\n")
        + "\n";
    std::fs::write(&h.ctx.backend.file, lines).unwrap();

    let (s, _, body) = call(&h, get("/api/sessions/a/transcript", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let page: Value = serde_json::from_str(&body).unwrap();
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let d0 = &items[0]["toolResult"]["details"];
    assert_eq!(d0["draftId"], "draft-123");
    assert_eq!(d0["action"], "propose");
    assert_eq!(d0["scheduleId"], "sched-456");
    assert_eq!(d0["diff"], "+added");
    assert!(d0.get("extraNoise").is_none());

    let d1_id = items[1]["toolResult"]["details"]["draftId"]
        .as_str()
        .unwrap();
    assert!(d1_id.chars().count() < 320);
    assert!(d1_id.ends_with("…"));
}

#[tokio::test]
async fn sse_forwards_schedules_and_automation_plan_set_status_only() {
    assert!(server::sse_event(&AppEvent::SchedulesChanged).is_some());

    let allow_auto = AppEvent::RpcFrame {
        session_id: "a".into(),
        frame: Arc::new(json!({
            "type": "extension_ui_request",
            "method": "setStatus",
            "statusKey": "ompws-automation",
            "statusText": "{\"v\":1,\"mode\":\"active\",\"drafts\":[]}"
        })),
    };
    assert!(server::sse_event(&allow_auto).is_some());

    let allow_plan = AppEvent::RpcFrame {
        session_id: "a".into(),
        frame: Arc::new(json!({
            "type": "extension_ui_request",
            "method": "setStatus",
            "statusKey": "ompws-plan",
            "statusText": "{\"v\":1,\"enabled\":true}"
        })),
    };
    assert!(server::sse_event(&allow_plan).is_some());

    for blocked in [
        json!({
            "type": "extension_ui_request",
            "method": "setStatus",
            "statusKey": "other-ext",
            "statusText": "{}"
        }),
        json!({
            "type": "extension_ui_request",
            "method": "select",
            "statusKey": "ompws-automation",
            "options": ["a"]
        }),
    ] {
        let ev = AppEvent::RpcFrame {
            session_id: "a".into(),
            frame: Arc::new(blocked),
        };
        assert!(server::sse_event(&ev).is_none());
    }

    // Verify live SSE stream delivery.
    let h = harness();
    let cookie = pair(&h).await;
    let res = server::router(h.ctx.clone())
        .oneshot(get("/api/events", Some(&cookie)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = res.into_body();
    let bus = h.ctx.backend.bus.clone();
    let _ = bus.send(AppEvent::SchedulesChanged);
    let _ = bus.send(allow_auto);

    let mut text = String::new();
    while !text.contains("ompws-automation") {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame())
            .await
            .expect("sse frame")
            .unwrap()
            .unwrap();
        if let Ok(data) = frame.into_data() {
            text.push_str(&String::from_utf8_lossy(&data));
        }
    }
    assert!(text.contains("event: schedules"));
    assert!(text.contains("event: rpc"));
    assert!(text.contains("ompws-automation"));
    h.shutdown.send(true).unwrap();
}

#[tokio::test]
async fn new_session_automation_context_and_automation_action_route() {
    let h = migrated_harness();
    let cookie = pair(&h).await;
    let ws = h.dir.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    h.ctx.db.lock().execute(
        "INSERT INTO workspaces(id, path, name, kind, sort, mode, created_at)
         VALUES('w1', ?1, 'ws', 'project', 0, 'code', '2026-01-01T00:00:00Z')",
        rusqlite::params![ws.to_string_lossy().as_ref()],
    )
    .unwrap();

    // Oversized or NUL appendSystemPrompt is rejected.
    let (s, _, _) = call(
        &h,
        post(
            "/api/left/sessions",
            &cookie,
            json!({
                "cwd": ws.to_string_lossy(),
                "appendSystemPrompt": "x".repeat(32 * 1024 + 1)
            }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _, _) = call(
        &h,
        post(
            "/api/left/sessions",
            &cookie,
            json!({
                "cwd": ws.to_string_lossy(),
                "appendSystemPrompt": "bad\0prompt"
            }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Plain blank draft vs automation-context draft never share IDs.
    let (s, _, body) = call(
        &h,
        post(
            "/api/left/sessions",
            &cookie,
            json!({ "cwd": ws.to_string_lossy() }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let plain_id = serde_json::from_str::<Value>(&body).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let (s, _, body) = call(
        &h,
        post(
            "/api/left/sessions",
            &cookie,
            json!({
                "cwd": ws.to_string_lossy(),
                "appendSystemPrompt": "Hidden automation guidelines",
                "automationMode": true
            }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let auto_id = serde_json::from_str::<Value>(&body).unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(plain_id, auto_id);

    // composer-state reflects active automationMode before first prompt.
    let (s, _, body) = call(
        &h,
        get(&format!("/api/sessions/{auto_id}/composer-state"), Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let cs: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(cs["automationState"]["mode"], "active");

    // Invalid POST /sessions/{id}/automation payloads fail with 400.
    let (s, _, _) = call(
        &h,
        post(
            &format!("/api/sessions/{auto_id}/automation"),
            &cookie,
            json!({ "action": "bogus" }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _, _) = call(
        &h,
        post(
            &format!("/api/sessions/{auto_id}/automation"),
            &cookie,
            json!({ "action": "resolve", "resolution": "saved" }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // First prompt materializes draft and forwards appendSystemPrompt + automationMode.
    let (s, _, body) = call(
        &h,
        post(
            &format!("/api/sessions/{auto_id}/prompt-ex"),
            &cookie,
            json!({ "text": "create daily check", "images": [] }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["sessionId"],
        "mock-real-1"
    );
    let started = h.ctx.backend.started_opts.lock();
    assert_eq!(
        started.last().unwrap().append_system_prompt.as_deref(),
        Some("Hidden automation guidelines")
    );
    let delivered = h.ctx.backend.delivered_prompts.lock();
    let last_deliv = delivered.last().unwrap();
    assert_eq!(last_deliv.1, "create daily check");
    assert!(last_deliv.2);

    super::api::draft::discard(&plain_id).await;
}

#[tokio::test]
async fn probe_test_and_generate_draft_enforce_dir_confinement() {
    let h = migrated_harness();
    let cookie = pair(&h).await;
    let ws = h.dir.join("ws");
    let outside = h.dir.join("outside");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    h.ctx.db.lock().execute(
        "INSERT INTO workspaces(id, path, name, kind, sort, mode, created_at)
         VALUES('w1', ?1, 'ws', 'project', 0, 'code', '2026-01-01T00:00:00Z')",
        rusqlite::params![ws.to_string_lossy().as_ref()],
    )
    .unwrap();

    // Unauthenticated probe-test is rejected.
    let (s, _, _) = call(
        &h,
        Request::post("/api/left/schedules/probe-test")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "cwd": ws.to_string_lossy(), "probeCommand": "echo hi", "agentTrigger": "on_signal" }).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // Outside directory rejected for both probe-test and generate-draft.
    let (s, _, _) = call(
        &h,
        post(
            "/api/left/schedules/probe-test",
            &cookie,
            json!({ "cwd": outside.to_string_lossy(), "probeCommand": "echo hi", "agentTrigger": "on_signal" }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _, _) = call(
        &h,
        post(
            "/api/left/schedules/generate-draft",
            &cookie,
            json!({ "cwd": outside.to_string_lossy(), "request": "check logs" }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _, _) = call(
        &h,
        post(
            "/api/left/schedules/generate-draft",
            &cookie,
            json!({ "cwd": ws.to_string_lossy(), "request": "   " }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Inside registered workspace runs probeCommand and returns ProbeTestResult.
    let (s, _, body) = call(
        &h,
        post(
            "/api/left/schedules/probe-test",
            &cookie,
            json!({
                "cwd": ws.to_string_lossy(),
                "probeCommand": "echo ok-probe",
                "agentTrigger": "on_signal"
            }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let res: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(res["outcome"], "signal");
    assert!(res["output"].as_str().unwrap().contains("ok-probe"));
}

#[tokio::test]
async fn schedule_worktree_inspect_is_scoped_by_schedule_id() {
    let h = migrated_harness();
    let cookie = pair(&h).await;
    let repo = h.dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |dir: &std::path::Path, args: &[&str]| -> bool {
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if !git(&repo, &["init", "-q", "-b", "main"]) {
        return;
    }
    assert!(git(&repo, &["config", "user.name", "t"]));
    assert!(git(&repo, &["config", "user.email", "t@example.com"]));
    assert!(git(&repo, &["config", "commit.gpgsign", "false"]));
    std::fs::write(repo.join("base.txt"), "base\n").unwrap();
    assert!(git(&repo, &["add", "-A"]));
    assert!(git(&repo, &["commit", "-q", "-m", "init"]));

    let wt = crate::git::worktree::create(&repo, "sched-demo-run12345", None, None).unwrap();
    let wt_path = std::path::Path::new(&wt.path);
    std::fs::write(wt_path.join("committed.txt"), "c1\n").unwrap();
    assert!(git(wt_path, &["add", "-A"]));
    assert!(git(wt_path, &["commit", "-q", "-m", "auto commit"]));
    std::fs::write(wt_path.join("dirty.txt"), "d1\n").unwrap();

    {
        let db = h.ctx.db.lock();
        let insert_sched = |id: &str| {
            db.execute(
                "INSERT INTO schedules(id, name, prompt, cwd, run_mode, cadence, enabled, created_at, updated_at)
                 VALUES(?1, ?1, 'p', ?2, 'worktree', '{\"kind\":\"interval\",\"minutes\":10}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![id, repo.to_string_lossy().as_ref()],
            )
            .unwrap();
        };
        insert_sched("sched-owner");
        insert_sched("sched-other");
        db.execute(
            "INSERT INTO schedule_runs(id, schedule_id, session_id, status, started_at)
             VALUES('run12345-aaaa', 'sched-owner', NULL, 'ok', '2026-01-01T00:01:00Z')",
            [],
        )
        .unwrap();
    }

    // Unknown schedule returns 404.
    let (s, _, _) = call(
        &h,
        get("/api/left/schedules/does-not-exist/worktree", Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Unrelated schedule cannot inspect sched-owner's worktree.
    let (s, _, body) = call(
        &h,
        get("/api/left/schedules/sched-other/worktree", Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), Value::Null);

    // Owning schedule receives full worktree state & diffs.
    let (s, _, body) = call(
        &h,
        get("/api/left/schedules/sched-owner/worktree", Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let wt_state: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(wt_state["branch"], wt.branch.unwrap());
    assert_eq!(wt_state["ahead"], 1);
    assert_eq!(wt_state["dirty"], 1);
    assert_eq!(wt_state["runId"], "run12345-aaaa");
    assert!(wt_state["committedDiff"].as_str().unwrap().contains("+c1"));
    assert!(wt_state["uncommittedDiff"].as_str().unwrap().contains("+d1"));
    assert_eq!(wt_state["addedLines"], 2);

    // H1: A local-mode schedule whose run ran inside an ordinary linked worktree must NOT claim it.
    let linked = crate::git::worktree::create(&repo, "ordinary-feature", None, None).unwrap();
    let linked_path = std::path::Path::new(&linked.path);
    std::fs::write(linked_path.join("local-work.txt"), "hi\n").unwrap();
    h.ctx.backend.extra_sessions.lock().push(SessionMeta {
        id: "sess-local-1".into(),
        cwd: linked.path.clone(),
        live: false,
        ..Default::default()
    });
    {
        let db = h.ctx.db.lock();
        db.execute(
            "INSERT INTO schedules(id, name, prompt, cwd, run_mode, cadence, enabled, created_at, updated_at)
             VALUES('sched-local', 'local', 'p', ?1, 'local', '{\"kind\":\"interval\",\"minutes\":10}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![repo.to_string_lossy().as_ref()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO schedule_runs(id, schedule_id, session_id, status, started_at)
             VALUES('runlocal-1111', 'sched-local', 'sess-local-1', 'ok', '2026-01-01T00:02:00Z')",
            [],
        )
        .unwrap();
    }
    let (s, _, body) = call(
        &h,
        get("/api/left/schedules/sched-local/worktree", Some(&cookie)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), Value::Null);

    // H2: Mismatched target fields on merge/discard must fail with 409 Conflict before any git mutation.
    for endpoint in [
        "/api/left/schedules/sched-owner/worktree/merge",
        "/api/left/schedules/sched-owner/worktree/discard",
    ] {
        let (s, _, body) = call(
            &h,
            post(
                endpoint,
                &cookie,
                json!({
                    "runId": "wrong-run-id",
                    "branch": wt_state["branch"],
                    "worktreePath": wt_state["worktreePath"]
                }),
            ),
        )
        .await;
        assert_eq!(s, StatusCode::CONFLICT, "{endpoint}: {body}");
        assert!(body.contains("工作树已变化"), "{body}");
    }

    // H3: Running schedule run must reject merge/discard with 409 BEFORE git commit/merge/remove.
    {
        let db = h.ctx.db.lock();
        db.execute(
            "UPDATE schedule_runs SET status = 'running' WHERE id = 'run12345-aaaa'",
            [],
        )
        .unwrap();
    }
    for endpoint in [
        "/api/left/schedules/sched-owner/worktree/merge",
        "/api/left/schedules/sched-owner/worktree/discard",
    ] {
        let (s, _, body) = call(
            &h,
            post(
                endpoint,
                &cookie,
                json!({
                    "runId": "run12345-aaaa",
                    "branch": wt_state["branch"],
                    "worktreePath": wt_state["worktreePath"]
                }),
            ),
        )
        .await;
        assert_eq!(s, StatusCode::CONFLICT, "{endpoint}: {body}");
        assert!(body.contains("正在运行的任务或活跃会话"), "{body}");
    }
    assert!(wt_path.join("dirty.txt").exists());
    assert!(wt_path.exists());

    // H3: Even after the run finishes, a live session owning the worktree must reject merge/discard with 409.
    {
        let db = h.ctx.db.lock();
        db.execute(
            "UPDATE schedule_runs SET status = 'ok' WHERE id = 'run12345-aaaa'",
            [],
        )
        .unwrap();
    }
    h.ctx.backend.extra_sessions.lock().push(SessionMeta {
        id: "sess-live-wt".into(),
        cwd: wt_path.to_string_lossy().into_owned(),
        live: true,
        ..Default::default()
    });
    let (s, _, body) = call(
        &h,
        post(
            "/api/left/schedules/sched-owner/worktree/merge",
            &cookie,
            json!({
                "runId": "run12345-aaaa",
                "branch": wt_state["branch"],
                "worktreePath": wt_state["worktreePath"]
            }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT, "{body}");
    assert!(body.contains("正在运行的任务或活跃会话"), "{body}");
    assert!(wt_path.join("dirty.txt").exists());
    assert!(wt_path.exists());

    // Also verify empty POST body parses cleanly via Option<Json<WorktreeActionBody>>.
    let (s, _, body) = call(
        &h,
        Request::post("/api/left/schedules/sched-owner/worktree/discard")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT, "{body}");
    assert!(body.contains("正在运行的任务或活跃会话"), "{body}");

    let _ = crate::git::worktree::remove(&repo, linked_path, true, true);
    let _ = crate::git::worktree::remove(&repo, wt_path, true, true);
}

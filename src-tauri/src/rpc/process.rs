//! RpcProcess: spawn `omp --mode rpc-ui`, protocol handshake, stdout reader,
//! stdin writer, request/response correlation.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdout};
use tokio::sync::{mpsc, oneshot, watch};
use tracing::instrument::WithSubscriber;
use tracing::Instrument;

use crate::contracts::{LiveSessionInfo, PendingUiRequest, Settings, StartOpts};
use crate::diagnostics::{self, DiagnosticEvent};
use crate::rpc::frame::{ChunkReassembler, MAX_REASSEMBLED_CEILING};
use crate::rpc::frame_batch::{slim_rpc_frame, FrameBatcher, DEFAULT_BATCH_WINDOW};
use crate::state::{AppEvent, AppState};
use crate::{paths, rpc};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const CMD_TIMEOUT: Duration = Duration::from_secs(120);
/// Compaction/handoff summarise the whole context with a model call and can
/// legitimately run for many minutes.
const LONG_CMD_TIMEOUT: Duration = Duration::from_secs(900);
/// Grace period between stdin close and SIGKILL on stop.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// How long `monitor` waits for the stdout reader to drain after the child
/// exits before it fails outstanding requests itself.
const STDOUT_DRAIN: Duration = Duration::from_secs(2);
/// Bounded capacity for outbound JSONL commands per session.
pub(crate) const STDIN_QUEUE_CAPACITY: usize = 256;
/// Minimum stdout line budget even when `ready` negotiates a small chunk limit.
const MIN_STDOUT_LINE_BYTES: usize = 1024 * 1024;
/// Maximum startup stderr bytes retained for crash diagnostics (tail-preserving).
const MAX_STARTUP_STDERR_BYTES: usize = 64 * 1024;
/// Maximum bytes kept from any single stderr line.
const MAX_STDERR_LINE_BYTES: usize = 16 * 1024;
/// Maximum unknown-session frames buffered before `get_state` resolves `session_id`.
const MAX_PENDING_FRAMES: usize = 256;
/// Maximum estimated bytes buffered in `pending_frames`.
const MAX_PENDING_FRAME_BYTES: usize = 4 * 1024 * 1024;
static REQ_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Request-id → response channel map. Responses echo the command `id`.
#[derive(Default)]
pub struct PendingMap {
    map: parking_lot::Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl PendingMap {
    pub fn insert(&self, id: String) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        self.map.lock().insert(id, tx);
        rx
    }

    /// Resolve a pending request. Returns false when the id is unknown
    /// (e.g. a same-id late `prompt` error after an early ack, or unsolicited).
    pub fn resolve(&self, id: &str, value: Value) -> bool {
        self.resolve_with(id, || value)
    }

    /// Resolve a pending request, computing/cloning `value` only if `id` is
    /// actually awaiting a response (and outside the map lock).
    pub fn resolve_with(&self, id: &str, make_value: impl FnOnce() -> Value) -> bool {
        let tx = self.map.lock().remove(id);
        if let Some(tx) = tx {
            let _ = tx.send(make_value());
            return true;
        }
        false
    }

    pub fn remove(&self, id: &str) {
        self.map.lock().remove(id);
    }

    /// Fail every outstanding request (process exit / stdin closed).
    pub fn fail_all(&self, msg: &str) {
        let pending = std::mem::take(&mut *self.map.lock());
        for (id, tx) in pending {
            let _ = tx.send(json!({
                "id": id,
                "type": "response",
                "success": false,
                "error": msg,
            }));
        }
    }

    /// Number of requests still waiting for a response. A non-empty map means
    /// the process is mid-command, so idle suspension must leave it alone.
    pub fn len(&self) -> usize {
        self.map.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.lock().is_empty()
    }
}

/// UI-request methods that wait for a host answer (track for rpc_pending_ui).
const DIALOG_METHODS: [&str; 4] = ["select", "confirm", "input", "editor"];

/// One queued outbound JSONL command for the child's stdin writer.
pub(crate) struct StdinMessage {
    pub(crate) line: String,
    /// Set to `true` before returning a command timeout (or dropping the caller
    /// future) so the stdin writer skips timed-out commands instead of sending
    /// them late.
    pub(crate) cancelled: Option<Arc<AtomicBool>>,
}

impl StdinMessage {
    pub(crate) fn new(line: String, cancelled: Option<Arc<AtomicBool>>) -> Self {
        Self { line, cancelled }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
    }
}

struct CancelOnDrop {
    cancelled: Arc<AtomicBool>,
    armed: bool,
}

impl CancelOnDrop {
    fn new(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            cancelled,
            armed: true,
        }
    }

    fn cancel_now(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.armed = false;
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.cancelled.store(true, Ordering::Release);
        }
    }
}

fn estimate_json_bytes(v: &Value) -> usize {
    match v {
        Value::Null => 4,
        Value::Bool(_) => 5,
        Value::Number(_) => 16,
        Value::String(s) => s.len() + 2,
        Value::Array(items) => {
            2 + items
                .iter()
                .map(|item| estimate_json_bytes(item) + 1)
                .sum::<usize>()
        }
        Value::Object(map) => {
            2 + map
                .iter()
                .map(|(k, val)| k.len() + 4 + estimate_json_bytes(val))
                .sum::<usize>()
        }
    }
}

/// Bounded queue for frames emitted before `get_state` populates `session_id`.
#[derive(Default)]
pub struct PendingFrameBuffer {
    frames: VecDeque<(Value, usize)>,
    bytes: usize,
}

impl PendingFrameBuffer {
    pub fn push(&mut self, frame: Value) -> bool {
        self.push_with_limits(frame, MAX_PENDING_FRAMES, MAX_PENDING_FRAME_BYTES)
    }

    fn push_with_limits(&mut self, frame: Value, max_frames: usize, max_bytes: usize) -> bool {
        let size = estimate_json_bytes(&frame);
        if max_frames == 0 || size > max_bytes {
            return false;
        }
        while self.frames.len() >= max_frames || self.bytes.saturating_add(size) > max_bytes {
            let Some((_, dropped_bytes)) = self.frames.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(dropped_bytes);
        }
        self.bytes = self.bytes.saturating_add(size);
        self.frames.push_back((frame, size));
        true
    }

    pub fn take(&mut self) -> Vec<Value> {
        self.bytes = 0;
        self.frames.drain(..).map(|(frame, _)| frame).collect()
    }

    pub fn clear(&mut self) {
        self.frames.clear();
        self.frames.shrink_to_fit();
        self.bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

/// Tail-preserving bounded startup stderr collector.
struct BoundedStderr {
    lines: VecDeque<String>,
    bytes: usize,
    max_bytes: usize,
    truncated: bool,
}

impl BoundedStderr {
    fn new(max_bytes: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            bytes: 0,
            max_bytes: max_bytes.max(1),
            truncated: false,
        }
    }

    fn push_line(&mut self, mut line: String) {
        let max_line = self.max_bytes.saturating_sub(1);
        if line.len() > max_line {
            let mut cut = line.len().saturating_sub(max_line);
            while cut < line.len() && !line.is_char_boundary(cut) {
                cut += 1;
            }
            line = line[cut..].to_string();
            self.truncated = true;
        }
        let added = line.len() + 1;
        while self.bytes.saturating_add(added) > self.max_bytes {
            let Some(old) = self.lines.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(old.len() + 1);
            self.truncated = true;
        }
        self.bytes = self.bytes.saturating_add(added);
        self.lines.push_back(line);
    }

    fn clear(&mut self) {
        self.lines.clear();
        self.lines.shrink_to_fit();
        self.bytes = 0;
        self.truncated = false;
    }

    fn render(&self) -> String {
        let mut out = String::with_capacity(self.bytes + if self.truncated { 24 } else { 0 });
        if self.truncated {
            out.push_str("... (stderr truncated)\n");
        }
        for line in &self.lines {
            out.push_str(line);
            out.push('\n');
        }
        out
    }
}

pub struct SessionHandle {
    pub session_id: parking_lot::RwLock<String>,
    pub session_file: parking_lot::RwLock<String>,
    pub cwd: String,
    pub pid: u32,
    /// Bounded outbound JSONL command channel (one command per line).
    #[cfg(not(test))]
    pub(crate) stdin_queue: mpsc::Sender<StdinMessage>,
    /// Bounded outbound JSONL command channel used by spawned processes and bounded tests.
    #[cfg(test)]
    pub(crate) stdin_queue: Option<mpsc::Sender<StdinMessage>>,
    /// Test-only fallback channel kept for external unit tests constructing
    /// `SessionHandle { stdin_tx, ..SessionHandle::for_test() }`.
    #[cfg(test)]
    pub stdin_tx: mpsc::UnboundedSender<String>,
    /// Signalled to close stdin → graceful omp exit.
    pub shutdown: watch::Sender<bool>,
    pub pending: PendingMap,
    pub pending_ui: parking_lot::Mutex<Vec<PendingUiRequest>>,
    /// Last `ompws-plan` status published by the bundled plan extension
    /// (parsed `statusText` JSON); `None` until the extension reports.
    pub plan_status: parking_lot::Mutex<Option<Value>>,
    pub pending_frames: parking_lot::Mutex<PendingFrameBuffer>,
    /// Flips to `true` when the stdout reader reached EOF. Pending requests are
    /// only failed after this, so a response printed just before exit still
    /// resolves its caller instead of racing the exit notification.
    pub stdout_closed: watch::Sender<bool>,
    /// Flips to `true` after the child exited and `publish_exit` completed.
    pub(crate) exited: watch::Sender<bool>,
    /// Serializes final stdout frames with the published process-exit boundary.
    /// OS exit stops commands immediately, but buffered output must still drain.
    pub output_closed: parking_lot::Mutex<bool>,
    pub streaming: AtomicBool,
    pub alive: AtomicBool,
    /// Last frame or host command, not elapsed wall-clock time alone. Internal
    /// idle probes must not move this clock.
    pub last_activity: parking_lot::Mutex<Instant>,
    /// Monotonic user/background activity version. Idle timers capture it and
    /// must recheck it after their delay and after the authoritative probe.
    pub activity_version: AtomicU64,
    /// Serializes every host command against conditional suspension. Without
    /// this, a prompt can slip between the idle check and stdin close.
    pub dispatch_lock: tokio::sync::Mutex<()>,
    /// Cached only as a cheap rejection; `get_state` is authoritative at stop.
    pub awaiting_async_work: AtomicBool,
    pub settled: AtomicBool,
    pub active_subagents: parking_lot::Mutex<HashSet<String>>,
    /// Identity of the omp binary exec'd at spawn (`omp_fingerprint`); None if unknown.
    pub omp_fingerprint: Option<String>,
    /// `privacy::native_hash()` at spawn (native secrets.yml snapshot the process loaded).
    pub native_hash: String,
}

impl SessionHandle {
    #[cfg(test)]
    pub fn for_test() -> Self {
        let (stdin_tx, _rx) = mpsc::unbounded_channel();
        let (shutdown, _srx) = watch::channel(false);
        let (stdout_closed, _orx) = watch::channel(true);
        let (exited, _erx) = watch::channel(true);
        Self {
            session_id: parking_lot::RwLock::new("s1".to_string()),
            session_file: parking_lot::RwLock::new("/tmp/s1.jsonl".to_string()),
            cwd: "/tmp".to_string(),
            pid: 0,
            stdin_queue: None,
            stdin_tx,
            shutdown,
            pending: PendingMap::default(),
            pending_ui: parking_lot::Mutex::new(Vec::new()),
            plan_status: parking_lot::Mutex::new(None),
            pending_frames: parking_lot::Mutex::new(PendingFrameBuffer::default()),
            stdout_closed,
            exited,
            output_closed: parking_lot::Mutex::new(false),
            streaming: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            last_activity: parking_lot::Mutex::new(Instant::now()),
            activity_version: AtomicU64::new(1),
            dispatch_lock: tokio::sync::Mutex::new(()),
            awaiting_async_work: AtomicBool::new(false),
            settled: AtomicBool::new(true),
            active_subagents: parking_lot::Mutex::new(HashSet::new()),
            omp_fingerprint: None,
            native_hash: String::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test_bounded(
        capacity: usize,
    ) -> (Self, mpsc::Receiver<StdinMessage>, watch::Receiver<bool>) {
        let (stdin_queue, rx) = mpsc::channel(capacity.max(1));
        let (shutdown, shutdown_rx) = watch::channel(false);
        let mut handle = Self::for_test();
        handle.stdin_queue = Some(stdin_queue);
        handle.shutdown = shutdown;
        (handle, rx, shutdown_rx)
    }

    pub fn info(&self) -> LiveSessionInfo {
        LiveSessionInfo {
            session_id: self.session_id.read().clone(),
            session_file: self.session_file.read().clone(),
            pid: self.pid,
            cwd: self.cwd.clone(),
        }
    }

    pub fn is_shutting_down(&self) -> bool {
        *self.shutdown.borrow()
    }

    pub fn is_usable(&self) -> bool {
        self.alive.load(Ordering::SeqCst) && !self.is_shutting_down()
    }

    pub fn touch(&self) {
        *self.last_activity.lock() = Instant::now();
        self.activity_version.fetch_add(1, Ordering::SeqCst);
    }

    fn enqueue_stdin(&self, msg: StdinMessage) -> Result<(), String> {
        #[cfg(test)]
        let queue = self.stdin_queue.as_ref();
        #[cfg(not(test))]
        let queue = Some(&self.stdin_queue);

        if let Some(tx) = queue {
            match tx.try_send(msg) {
                Ok(()) => Ok(()),
                Err(mpsc::error::TrySendError::Full(_)) => Err(stdin_full(self)),
                Err(mpsc::error::TrySendError::Closed(_)) => Err(stdin_closed(self)),
            }
        } else {
            #[cfg(test)]
            {
                self.stdin_tx.send(msg.line).map_err(|_| stdin_closed(self))
            }
            #[cfg(not(test))]
            {
                unreachable!()
            }
        }
    }

    fn refresh_settled(&self) {
        self.settled.store(
            !self.streaming.load(Ordering::SeqCst)
                && !self.awaiting_async_work.load(Ordering::SeqCst),
            Ordering::SeqCst,
        );
    }

    /// Wait until the stdout reader reports EOF, at most `timeout`.
    async fn wait_stdout_closed(&self, timeout: Duration) {
        let mut rx = self.stdout_closed.subscribe();
        if *rx.borrow() {
            return;
        }
        let _ = tokio::time::timeout(timeout, rx.wait_for(|closed| *closed)).await;
    }

    /// Wait until `monitor` observes process exit and finishes `publish_exit`,
    /// at most `timeout`. Returns `true` if exit completed.
    pub(crate) async fn wait_exited(&self, timeout: Duration) -> bool {
        let mut rx = self.exited.subscribe();
        if *rx.borrow() {
            return true;
        }
        let _ = tokio::time::timeout(timeout, rx.wait_for(|done| *done)).await;
        *self.exited.borrow()
    }

    /// Fail outstanding requests only after stdout drained: a response the
    /// child printed just before exiting must resolve its caller first.
    async fn fail_pending_after_drain(&self, msg: &str) {
        self.wait_stdout_closed(STDOUT_DRAIN).await;
        self.pending.fail_all(msg);
    }
}

/// Opaque identity of the file `bin` resolves to under `path` (the PATH given
/// to the child): canonical path + mtime + size. Stat only; None if unresolvable.
pub(crate) fn omp_fingerprint(bin: &str, path: &str) -> Option<String> {
    let exe = crate::todos::omp::resolve_binary(bin, path);
    let canonical = std::fs::canonicalize(&exe).ok()?;
    let meta = std::fs::metadata(&canonical).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some(format!("{}|{mtime}|{}", canonical.display(), meta.len()))
}

/// Fingerprint of the omp binary a new session spawned now would exec.
pub(crate) async fn current_omp_fingerprint(settings: &Settings) -> Option<String> {
    let path = augmented_path().await;
    omp_fingerprint(&settings.omp_binary, &path)
}

/// Sessions whose spawn fingerprint is known and differs from `current`.
/// Unknown spawn fingerprints, or an unknown current one, are never stale.
pub(crate) fn stale_session_ids<'a>(
    current: Option<&str>,
    sessions: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
) -> Vec<String> {
    let Some(current) = current else {
        return Vec::new();
    };
    let mut ids: Vec<String> = sessions
        .into_iter()
        .filter(|(_, fp)| fp.is_some_and(|fp| fp != current))
        .map(|(id, _)| id.to_string())
        .collect();
    ids.sort();
    ids
}

/// Parse an `ompws-plan` `setStatus` frame into its `statusText` JSON object.
pub(crate) fn plan_status_from_frame(frame: &Value) -> Option<Value> {
    if frame.get("statusKey").and_then(Value::as_str) != Some("ompws-plan") {
        return None;
    }
    let text = frame.get("statusText").and_then(Value::as_str)?;
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(Value::is_object)
}

/// Apply one inbound logical frame to handle state (no emission).
/// Testable without a running process.
pub(crate) fn apply_frame(handle: &SessionHandle, frame: &Value) {
    let ty = frame.get("type").and_then(Value::as_str).unwrap_or("");
    // Drain final command responses after OS exit, never reopen live activity.
    if ty != "response" && !handle.alive.load(Ordering::SeqCst) {
        return;
    }
    crate::mobile::work::frame(handle, frame);
    // Responses to the reaper's own probes do not represent session activity.
    if ty != "response" {
        handle.touch();
    }
    match ty {
        "response" => {
            if let Some(id) = frame.get("id").and_then(Value::as_str) {
                handle.pending.resolve_with(id, || frame.clone());
            }
        }
        "extension_ui_request" => {
            let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
            if DIALOG_METHODS.contains(&method) {
                let session_id = handle.session_id.read().clone();
                handle.pending_ui.lock().push(PendingUiRequest {
                    session_id,
                    request: frame.clone(),
                    received_at: chrono::Utc::now().to_rfc3339(),
                });
            } else if method == "setStatus" {
                if let Some(plan) = plan_status_from_frame(frame) {
                    *handle.plan_status.lock() = Some(plan);
                }
            } else if method == "cancel" {
                // Cancels a previously issued request: match targetId or id.
                let target = frame
                    .get("targetId")
                    .and_then(Value::as_str)
                    .or_else(|| frame.get("id").and_then(Value::as_str))
                    .map(str::to_string);
                if let Some(target) = target {
                    handle.pending_ui.lock().retain(|r| {
                        r.request.get("id").and_then(Value::as_str) != Some(target.as_str())
                    });
                }
            }
        }
        "agent_start" => {
            handle.streaming.store(true, Ordering::SeqCst);
            handle.awaiting_async_work.store(false, Ordering::SeqCst);
            handle.settled.store(false, Ordering::SeqCst);
        }
        "agent_end" if crate::catalog::status::agent_end_settles(frame) => {
            handle.pending_ui.lock().clear();
            handle.streaming.store(false, Ordering::SeqCst);
            handle.awaiting_async_work.store(
                frame.get("awaitingAsyncWork").and_then(Value::as_bool) == Some(true),
                Ordering::SeqCst,
            );
            handle.refresh_settled();
        }
        "session_settled" => {
            handle.pending_ui.lock().clear();
            handle.streaming.store(false, Ordering::SeqCst);
            handle.awaiting_async_work.store(false, Ordering::SeqCst);
            handle.settled.store(true, Ordering::SeqCst);
        }
        "subagent_lifecycle" => {
            let payload = frame.get("payload").unwrap_or(frame);
            let Some(id) = payload.get("id").and_then(Value::as_str) else {
                return;
            };
            match payload.get("status").and_then(Value::as_str) {
                Some("completed" | "failed" | "aborted") => {
                    handle.active_subagents.lock().remove(id);
                }
                _ => {
                    handle.active_subagents.lock().insert(id.to_string());
                }
            }
        }
        _ => {}
    }
}

/// Outbound events from a session process (frontend `rpc:*` + bus events).
/// Abstracted so tests can run a real process without a Tauri AppHandle.
pub(crate) enum OutEvent {
    Frame {
        session_id: String,
        frame: Value,
    },
    Process {
        session_id: String,
        running: bool,
        exit_code: Option<i32>,
    },
}

pub(crate) type OutSink = Arc<dyn Fn(OutEvent) + Send + Sync + 'static>;

/// Production sink: `rpc:frame`/`rpc:process` to the webview + AppEvent on the bus.
pub(crate) fn sink_from_state(state: &AppState) -> OutSink {
    let state = state.clone();
    let raw_sink: OutSink = Arc::new(move |ev| match ev {
        OutEvent::Frame { session_id, frame } => {
            #[derive(Clone, serde::Serialize)]
            #[serde(rename_all = "camelCase")]
            struct RpcFrameOut<'a> {
                session_id: &'a str,
                frame: &'a Value,
            }
            let frame = Arc::new(frame);
            let _ = state.app.emit(
                "rpc:frame",
                RpcFrameOut {
                    session_id: &session_id,
                    frame: &frame,
                },
            );
            state.emit(AppEvent::RpcFrame { session_id, frame });
        }
        OutEvent::Process {
            session_id,
            running,
            exit_code,
        } => {
            let _ = state.app.emit(
                "rpc:process",
                json!({ "sessionId": session_id, "running": running, "exitCode": exit_code }),
            );
            state.emit(AppEvent::RpcProcess {
                session_id,
                running,
                exit_code,
            });
        }
    });
    let batcher = Arc::new(FrameBatcher::new(DEFAULT_BATCH_WINDOW, raw_sink));
    Arc::new(move |ev| batcher.push_slimmed(ev))
}

/// Emit a frame to the frontend (`rpc:frame`) and the bus (`AppEvent::RpcFrame`).
/// Takes ownership of `frame` and strips redundant tool `details` once in place
/// before buffering or delivery, avoiding deep `Value::clone()` on the hot path.
fn emit_frame(sink: &OutSink, handle: &SessionHandle, frame: Value) {
    let frame = slim_rpc_frame(frame);
    let output_closed = handle.output_closed.lock();
    if *output_closed {
        return;
    }
    let session_id = handle.session_id.read().clone();
    if session_id.is_empty() {
        let mut guard = handle.pending_frames.lock();
        let session_id = handle.session_id.read().clone();
        if session_id.is_empty() {
            if !guard.push(frame) {
                tracing::warn!("rpc: dropping oversized unknown-session frame");
            }
            return;
        }
        drop(guard);
        emit_identified_frame(sink, handle, session_id, frame);
        return;
    }
    emit_identified_frame(sink, handle, session_id, frame);
}

/// Keep replacement registration ordered with the last frame from its predecessor.
fn emit_identified_frame(sink: &OutSink, handle: &SessionHandle, session_id: String, frame: Value) {
    let registry = rpc::registry().read();
    if registry
        .get(&session_id)
        .is_some_and(|existing| !std::ptr::eq(existing.as_ref(), handle))
    {
        return;
    }
    sink(OutEvent::Frame { session_id, frame });
}

fn drain_pending_frames(sink: &OutSink, handle: &SessionHandle) {
    let frames = handle.pending_frames.lock().take();
    for frame in frames {
        emit_frame(sink, handle, frame);
    }
}

/// macOS GUI apps get a minimal PATH — merge the login-shell PATH once and
/// prepend the usual user bins.
async fn augmented_path() -> String {
    static CACHED: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    CACHED
        .get_or_init(|| async {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
            let mut parts: Vec<String> = vec![
                home.join(".local/bin").to_string_lossy().to_string(),
                home.join(".bun/bin").to_string_lossy().to_string(),
                "/opt/homebrew/bin".to_string(),
                "/usr/local/bin".to_string(),
            ];
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let login_path = tokio::time::timeout(Duration::from_secs(3), async {
                tokio::process::Command::new(shell)
                    .args(["-lc", "echo $PATH"])
                    .output()
                    .await
            })
            .await
            .ok()
            .and_then(Result::ok)
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
            if let Some(path) = login_path.or_else(|| std::env::var("PATH").ok()) {
                parts.push(path);
            }
            parts.join(":")
        })
        .await
        .clone()
}

/// Prompt-cache key a session transcript already uses, read from its `session`
/// header (`providerPromptCacheKey`). `fall_back_to_id` (forks) also accepts the
/// header's own `id`, which omp uses as the key when none is recorded. The
/// header sits within the first few lines (a `title` row may precede it).
fn transcript_cache_key(file: &str, fall_back_to_id: bool) -> Option<String> {
    use std::io::BufRead;
    let reader = std::io::BufReader::new(std::fs::File::open(file).ok()?);
    for line in reader.lines().take(4) {
        let Ok(v) = serde_json::from_str::<Value>(&line.ok()?) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let field = |k: &str| {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        return field("providerPromptCacheKey").or_else(|| {
            if fall_back_to_id {
                field("id")
            } else {
                None
            }
        });
    }
    None
}

/// Prompt-shaping arguments shared by every app launch path for one transcript
/// (`build_command` here and `term_open_session`'s `omp --resume` terminal).
///
/// omp keys its provider prompt cache on the exact system prompt + tool shape
/// it sends, and it drops a transcript's inherited cache key as soon as a
/// cache-shape flag (`--model`, `--append-system-prompt`, `--plugin-dir`, …) is
/// present. Two launch paths for the same session must therefore produce the
/// *same* prompt-shaping argv or the first turn after switching views cold-misses
/// the whole prefix (transcript `system-prompt-digest` changes).
///
/// `append_system_prompt` is the RPC-only hidden-instruction channel (side chats);
/// the terminal cannot reproduce it because `StartOpts` is not persisted, so a
/// side chat's terminal gets the shared shape without it (documented tradeoff).
pub fn prompt_shape_args(
    resume_file: Option<&str>,
    fork_file: Option<&str>,
    append_system_prompt: Option<&str>,
    settings: &Settings,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    // omp falls back to the NEW session's id as the provider prompt-cache key
    // whenever any cache-shape flag is present, which sends a forked/resumed
    // session to a cold cache. Pin the key the source transcript already used.
    if let Some(key) = fork_file
        .and_then(|f| transcript_cache_key(f, true))
        .or_else(|| resume_file.and_then(|f| transcript_cache_key(f, false)))
    {
        args.push("--prompt-cache-key".to_string());
        args.push(key);
    }
    // Visualize skill plugin: loaded for app sessions unless the user opted
    // out (§settings.visualize_enabled). Registers the `visualize` skill +
    // `/skill:visualize` command in omp. A short standing hint tells the model
    // to use it proactively; the skill alone is only used when asked.
    let viz_dir = crate::visualize::spawn_plugin_dir(settings.visualize_enabled);
    let automation_ext = paths::automation_extension_path();
    let has_automation_ext = automation_ext.exists();
    let mut append_prompt = append_system_prompt
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or_default()
        .to_string();
    if viz_dir.is_some() {
        if !append_prompt.is_empty() {
            append_prompt.push_str("\n\n");
        }
        append_prompt.push_str(crate::prompts::VISUALIZE_HINT.trim());
    }
    if !append_prompt.is_empty() {
        args.push("--append-system-prompt".to_string());
        args.push(append_prompt);
    }
    // Extension list and order are part of the prompt shape: the status extension
    // reports progress (§8), checkpoints is opt-in (§8), privacy placeholders,
    // plan mode (`/plan`), and automations (`vecway_automation`) follow when installed.
    let status_ext = paths::extension_path();
    if status_ext.exists() {
        args.push("-e".to_string());
        args.push(status_ext.to_string_lossy().into_owned());
    }
    if settings.turn_checkpoints == Some(true) {
        let ext = paths::checkpoints_extension_path();
        if ext.exists() {
            args.push("-e".to_string());
            args.push(ext.to_string_lossy().into_owned());
        }
    }
    let privacy_ext = paths::privacy_extension_path();
    if privacy_ext.exists() {
        args.push("-e".to_string());
        args.push(privacy_ext.to_string_lossy().into_owned());
    }
    let plan_ext = paths::plan_extension_path();
    if plan_ext.exists() {
        args.push("-e".to_string());
        args.push(plan_ext.to_string_lossy().into_owned());
    }
    if has_automation_ext {
        args.push("-e".to_string());
        args.push(automation_ext.to_string_lossy().into_owned());
    }
    if let Some(dir) = viz_dir {
        args.push("--plugin-dir".to_string());
        args.push(dir.to_string_lossy().into_owned());
    }
    args
}

fn build_command(opts: &StartOpts, settings: &Settings) -> Result<tokio::process::Command, String> {
    let approval_mode = opts
        .approval_mode
        .clone()
        .unwrap_or_else(|| settings.default_approval_mode.clone());
    let mut cmd = tokio::process::Command::new(&settings.omp_binary);
    cmd.kill_on_drop(true);
    cmd.arg("--mode")
        .arg("rpc-ui")
        .arg("--approval-mode")
        .arg(approval_mode)
        .arg("--cwd")
        .arg(&opts.cwd)
        .current_dir(&opts.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let effective_model = opts.model.as_deref().or_else(|| {
        if opts.resume_file.is_some() {
            return None;
        }
        let m = settings.new_session_model.as_deref()?.trim();
        if m.is_empty() {
            None
        } else {
            Some(m)
        }
    });
    if let Some(model) = effective_model {
        cmd.arg("--model")
            .arg(crate::todos::omp::normalize_model_selector(model));
    }
    if let Some(file) = &opts.fork_file {
        cmd.arg("--fork").arg(file);
    }
    cmd.args(prompt_shape_args(
        opts.resume_file.as_deref(),
        opts.fork_file.as_deref(),
        opts.append_system_prompt.as_deref(),
        settings,
    ));
    if let Some(file) = &opts.resume_file {
        cmd.arg("--resume").arg(file);
    } else if opts.plan_yolo == Some(true) {
        cmd.arg("--plan-yolo");
    }
    Ok(cmd)
}

fn process_event(
    handle: &SessionHandle,
    name: &'static str,
    source: &'static str,
) -> DiagnosticEvent {
    let mut event = DiagnosticEvent::new(name, source);
    let session = handle.session_id.read();
    event.session_id = uuid::Uuid::parse_str(&session)
        .ok()
        .map(|_| session.clone());
    event.child_pid = Some(handle.pid);
    event
}

fn io_code(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => "io_permission_denied",
        std::io::ErrorKind::NotFound => "io_not_found",
        _ => "io_other",
    }
}

/// Only request boundaries inherit their caller's operation; background IO never does.
struct CommandObservation {
    started: Instant,
    command: &'static str,
    polling: bool,
    request_id: Option<String>,
    phase: &'static str,
    code: Option<&'static str>,
    upstream_code: Option<&'static str>,
}

impl CommandObservation {
    fn new(command: &Value) -> Self {
        let name = command.get("type").and_then(Value::as_str).unwrap_or("");
        Self {
            started: Instant::now(),
            command: diagnostics::command_name(name),
            polling: matches!(name, "get_state" | "get_subagents"),
            request_id: None,
            phase: "validate",
            code: None,
            upstream_code: None,
        }
    }

    fn event(&self, handle: &SessionHandle, name: &'static str) -> DiagnosticEvent {
        let mut event = process_event(handle, name, "rpc");
        event.command = Some(self.command.into());
        event.request_id = self.request_id.clone();
        event.phase = Some(self.phase.into());
        event
    }

    fn dispatched(&mut self, handle: &SessionHandle, id: &str) {
        self.phase = "dispatch";
        self.request_id = Some(id.into());
        if !self.polling {
            diagnostics::emit(self.event(handle, "rpc.command_started"));
        }
    }

    fn rejected(&mut self, handle: &SessionHandle, response: &Value) {
        self.code = Some("upstream_rejected");
        self.upstream_code = response.get("code").and_then(Value::as_str).map(|code| {
            if code == "session_busy" {
                "session_busy"
            } else {
                "other"
            }
        });
        // These are host-generated cancellation responses, not upstream failures.
        if *handle.shutdown.borrow()
            && matches!(
                response.get("error").and_then(Value::as_str),
                Some("session is stopping" | "spawn aborted")
            )
        {
            self.code = None;
            self.upstream_code = None;
        }
    }

    fn finished(&self, handle: &SessionHandle, result: &Result<Value, String>) {
        if self.polling && result.is_ok() && self.started.elapsed() < Duration::from_secs(2) {
            return;
        }
        let mut event = self.event(handle, "rpc.command_finished");
        let cancelled = *handle.shutdown.borrow()
            && result.as_ref().err().is_some_and(|error| {
                matches!(error.as_str(), "session is stopping" | "spawn aborted")
            });
        event.outcome = Some(
            if cancelled {
                "observed"
            } else if result.is_ok() {
                "ok"
            } else {
                "error"
            }
            .into(),
        );
        event.code = if cancelled {
            None
        } else {
            self.code.map(str::to_owned).or_else(|| {
                result
                    .as_ref()
                    .err()
                    .map(|error| diagnostics::classify_error(error).into())
            })
        };
        event.upstream_code = self.upstream_code.map(str::to_owned);
        event.duration_ms = Some(self.started.elapsed().as_secs_f64() * 1000.0);
        diagnostics::emit(event);
    }
}

/// Send one command, correlating the response by generated id.
/// `success:false` → `Err(error)`.
///
/// Holds `dispatch_lock` only while checking process liveness, inserting the
/// pending correlation id, and enqueuing onto stdin. Releasing the lock before
/// awaiting the response allows concurrent host commands (such as an abort or
/// model switch) to be dispatched while a long command (e.g. `compact`) runs.
pub async fn send_command(handle: &Arc<SessionHandle>, command: Value) -> Result<Value, String> {
    send_command_inner(handle, command, None, None).await
}

/// Send one command with an explicit caller timeout (used by idle maintenance
/// probes so they never stall user operations or wait 120 seconds).
pub(crate) async fn send_command_with_timeout(
    handle: &Arc<SessionHandle>,
    command: Value,
    timeout: Duration,
) -> Result<Value, String> {
    send_command_inner(handle, command, None, Some(timeout)).await
}

pub(crate) async fn send_automation_resume(
    handle: &Arc<SessionHandle>,
    command: Value,
    attempt: &str,
) -> Result<Value, String> {
    send_command_inner(handle, command, Some(attempt), None).await
}

async fn send_command_inner(
    handle: &Arc<SessionHandle>,
    mut command: Value,
    automation_resume: Option<&str>,
    timeout_override: Option<Duration>,
) -> Result<Value, String> {
    let mut observation = CommandObservation::new(&command);
    let result = async {
        if !command.is_object() {
            return Err("command must be a JSON object".into());
        }
        let (id, rx, timeout, mut cancel_guard) = {
            let _dispatch = handle.dispatch_lock.lock().await;
            if !handle.is_usable() {
                return Err("session process is not running".into());
            }
            let guarded = rpc::automation_resume_guarded(handle.pid);
            if automation_resume
                .is_some_and(|attempt| !rpc::automation_resume_owned(handle.pid, attempt))
            {
                return Err("自动化恢复保护已失效".into());
            }
            if guarded
                && automation_resume.is_none()
                && !matches!(
                    command.get("type").and_then(Value::as_str),
                    Some("get_state" | "get_entries" | "get_subagents" | "abort")
                )
            {
                return Err("自动化恢复运行中，暂不能执行此操作".into());
            }
            let id = format!("req_{}", REQ_COUNTER.fetch_add(1, Ordering::Relaxed));
            command["id"] = json!(id);
            let rx = handle.pending.insert(id.clone());
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancel_guard = CancelOnDrop::new(cancelled.clone());
            observation.dispatched(handle, &id);
            if let Err(err) =
                handle.enqueue_stdin(StdinMessage::new(command.to_string(), Some(cancelled)))
            {
                handle.pending.remove(&id);
                return Err(err);
            }
            observation.phase = "response";
            if matches!(
                command.get("type").and_then(Value::as_str),
                Some("abort" | "abort_and_prompt" | "abort_and_restore_queue")
            ) {
                super::lifecycle::record(handle, command["type"].as_str().unwrap_or("abort"), None);
            }
            crate::mobile::work::dispatched(handle, &command);
            if !matches!(
                command.get("type").and_then(Value::as_str),
                Some("get_state" | "get_subagents")
            ) {
                handle.touch();
            }
            let timeout = timeout_override.unwrap_or_else(|| {
                match command.get("type").and_then(Value::as_str) {
                    Some("compact" | "handoff") => LONG_CMD_TIMEOUT,
                    _ => CMD_TIMEOUT,
                }
            });
            (id, rx, timeout, cancel_guard)
        };

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(resp)) => {
                cancel_guard.disarm();
                if resp.get("success").and_then(Value::as_bool) == Some(false) {
                    observation.rejected(handle, &resp);
                    let msg = resp
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("command failed");
                    // Upstream refusal codes (e.g. `session_busy` for navigate_tree)
                    // arrive as a top-level `code`; surface them so callers can map
                    // them to friendly errors.
                    let err = match resp.get("code").and_then(Value::as_str) {
                        Some(code) => format!("{code}: {msg}"),
                        None => msg.to_string(),
                    };
                    return Err(err);
                }
                Ok(resp)
            }
            Ok(Err(_)) => {
                cancel_guard.disarm();
                Err("response channel dropped".into())
            }
            Err(_) => {
                cancel_guard.cancel_now();
                handle.pending.remove(&id);
                Err("command timed out".into())
            }
        }
    }
    .await;
    observation.finished(handle, &result);
    result
}

/// Dispatch while the caller owns `dispatch_lock`.
pub(crate) async fn send_command_locked(
    handle: &Arc<SessionHandle>,
    mut command: Value,
) -> Result<Value, String> {
    let mut observation = CommandObservation::new(&command);
    let result = async {
        if !command.is_object() {
            return Err("command must be a JSON object".into());
        }
        if !handle.is_usable() {
            return Err("session process is not running".into());
        }
        let id = format!("req_{}", REQ_COUNTER.fetch_add(1, Ordering::Relaxed));
        command["id"] = json!(id);
        let rx = handle.pending.insert(id.clone());
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut cancel_guard = CancelOnDrop::new(cancelled.clone());
        observation.dispatched(handle, &id);
        if let Err(err) =
            handle.enqueue_stdin(StdinMessage::new(command.to_string(), Some(cancelled)))
        {
            handle.pending.remove(&id);
            return Err(err);
        }
        observation.phase = "response";
        // A long command may produce no inbound frames for minutes (`compact`),
        // so the send itself counts as activity for the idle reaper.
        // The suspender's internal probes are deliberately not user activity.
        if !matches!(
            command.get("type").and_then(Value::as_str),
            Some("get_state" | "get_subagents")
        ) {
            handle.touch();
        }
        let timeout = match command.get("type").and_then(Value::as_str) {
            Some("compact" | "handoff") => LONG_CMD_TIMEOUT,
            _ => CMD_TIMEOUT,
        };
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(resp)) => {
                cancel_guard.disarm();
                if resp.get("success").and_then(Value::as_bool) == Some(false) {
                    observation.rejected(handle, &resp);
                    let err = resp
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("command failed");
                    return Err(err.to_string());
                }
                Ok(resp)
            }
            Ok(Err(_)) => {
                cancel_guard.disarm();
                Err("response channel dropped".into())
            }
            Err(_) => {
                cancel_guard.cancel_now();
                handle.pending.remove(&id);
                Err("command timed out".into())
            }
        }
    }
    .await;
    observation.finished(handle, &result);
    result
}

/// Write a fire-and-forget frame (extension_ui_response etc.).
pub async fn send_raw(handle: &Arc<SessionHandle>, frame: Value) -> Result<(), String> {
    let _dispatch = handle.dispatch_lock.lock().await;
    if !handle.is_usable() {
        return Err("session process is not running".into());
    }
    let mut requests = handle.pending_ui.lock();
    let response_id = (frame.get("type").and_then(Value::as_str) == Some("extension_ui_response"))
        .then(|| frame.get("id").and_then(Value::as_str).unwrap_or(""));
    if let Some(id) = response_id {
        if id.is_empty()
            || !requests
                .iter()
                .any(|r| r.request.get("id").and_then(Value::as_str) == Some(id))
        {
            return Err("UI request is no longer pending".into());
        }
    }
    handle.enqueue_stdin(StdinMessage::new(frame.to_string(), None))?;
    handle.touch();
    if let Some(id) = response_id {
        requests.retain(|r| r.request.get("id").and_then(Value::as_str) != Some(id));
    }
    Ok(())
}

/// Spawn + handshake (ready → negotiate v2 → get_state → subagent sub →
/// optional new_session{parentSession} + get_state). Returns a handle that is
/// NOT yet in the registry — `rpc::start` registers it.
pub async fn spawn(state: &AppState, opts: &StartOpts) -> Result<Arc<SessionHandle>, String> {
    let settings = state.settings.read().clone();
    spawn_with_sink(opts, &settings, sink_from_state(state)).await
}

fn stdin_closed(handle: &SessionHandle) -> String {
    let mut event = process_event(handle, "rpc.io_failed", "stdin");
    event.phase = Some("dispatch".into());
    event.code = Some("stdin_closed".into());
    event.outcome = Some("error".into());
    diagnostics::emit(event);
    "session stdin closed".into()
}

fn stdin_full(handle: &SessionHandle) -> String {
    let mut event = process_event(handle, "rpc.io_failed", "stdin");
    event.phase = Some("dispatch".into());
    event.code = Some("io_other".into());
    event.outcome = Some("error".into());
    diagnostics::emit(event);
    "session stdin queue full".into()
}

fn observe_spawn_stage(
    handle: &SessionHandle,
    phase: &'static str,
    started: Instant,
    result: &Result<Value, String>,
) {
    if let Err(error) = result {
        let mut event = process_event(handle, "rpc.spawn_failed", "rpc");
        event.phase = Some(phase.into());
        event.outcome = Some("error".into());
        event.duration_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
        event.code = Some(diagnostics::classify_error(error).into());
        diagnostics::emit(event);
    }
}

fn startup_failure(reason: &str, exit: &str, cwd: &str, stderr: &str) -> String {
    // Only the upstream error class identifies this recovery path. Model names,
    // generic provider errors and stack/source mentions must not trigger it.
    let model_unavailable = stderr.lines().any(|line| {
        let line = line.trim_start();
        let line = line
            .strip_prefix("[Uncaught Exception] ")
            .or_else(|| line.strip_prefix("[Unhandled Rejection] "))
            .or_else(|| line.strip_prefix("error: "))
            .unwrap_or(line);
        line.strip_prefix("SessionModelRestoreError: Could not restore model ")
            .is_some_and(|selector| !selector.trim().is_empty())
    });
    let prefix = if model_unavailable {
        "SESSION_MODEL_UNAVAILABLE:"
    } else {
        ""
    };
    format!("{prefix}{reason}; {exit}; cwd: {cwd}\n{stderr}")
}

/// Inner spawn used by tests (custom sink) and by `spawn`.
pub async fn spawn_with_sink(
    opts: &StartOpts,
    settings: &Settings,
    sink: OutSink,
) -> Result<Arc<SessionHandle>, String> {
    let started = Instant::now();
    let mut phase = "spawn";
    let mut child_pid = None;
    let exit_status = Arc::new(parking_lot::Mutex::new((None, None)));
    let mut failure_code = None;
    let mut event = DiagnosticEvent::new("rpc.spawn_started", "rpc");
    event.phase = Some(phase.into());
    diagnostics::emit(event);
    let result = async {
        let mut cmd = build_command(opts, settings)?;
        let path = augmented_path().await;
        cmd.env("PATH", &path);
        // Same resolution std uses for the child (program looked up in the child's PATH).
        let omp_fingerprint = omp_fingerprint(&settings.omp_binary, &path);
        let mut native_hash = String::new();
        for (key, value) in crate::privacy::spawn_env() {
            if key == "OMPWS_PRIVACY_NATIVE_HASH" {
                native_hash.clone_from(&value);
            }
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(|e| {
            failure_code = Some(io_code(&e));
            format!("spawn omp failed ({path}): {e}")
        })?;
        let pid = child.id().unwrap_or(0);
        child_pid = Some(pid);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "omp stdout not piped".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "omp stdin not piped".to_string())?;
        let startup_stderr = Arc::new(parking_lot::Mutex::new(BoundedStderr::new(
            MAX_STARTUP_STDERR_BYTES,
        )));
        let recording_stderr = Arc::new(AtomicBool::new(true));
        let (stderr_done_tx, stderr_done_rx) = oneshot::channel();
        if let Some(stderr) = child.stderr.take() {
            let output = startup_stderr.clone();
            let recording = recording_stderr.clone();
            tokio::spawn(
                async move {
                    let mut reader = BufReader::new(stderr);
                    let mut line_buf = Vec::new();
                    while let Ok(Some(line)) =
                        read_bounded_stderr_line(&mut reader, &mut line_buf, MAX_STDERR_LINE_BYTES)
                            .await
                    {
                        tracing::debug!(target: "omp-stderr", "{line}");
                        if recording.load(Ordering::Relaxed) {
                            output.lock().push_line(line);
                        }
                    }
                    let _ = stderr_done_tx.send(());
                }
                .instrument(tracing::Span::none())
                .with_current_subscriber(),
            );
        }

        let (stdin_queue_tx, stdin_rx) = mpsc::channel::<StdinMessage>(STDIN_QUEUE_CAPACITY);
        #[cfg(test)]
        let (test_stdin_tx, _test_stdin_rx) = mpsc::unbounded_channel::<String>();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (stdout_closed_tx, _) = watch::channel(false);
        let (exited_tx, _) = watch::channel(false);
        let (ready_tx, ready_rx) = oneshot::channel::<Value>();

        let handle = Arc::new(SessionHandle {
            session_id: parking_lot::RwLock::new(String::new()),
            session_file: parking_lot::RwLock::new(String::new()),
            cwd: opts.cwd.clone(),
            pid,
            #[cfg(not(test))]
            stdin_queue: stdin_queue_tx,
            #[cfg(test)]
            stdin_queue: Some(stdin_queue_tx),
            #[cfg(test)]
            stdin_tx: test_stdin_tx,
            shutdown: shutdown_tx,
            pending: PendingMap::default(),
            pending_ui: parking_lot::Mutex::new(Vec::new()),
            plan_status: parking_lot::Mutex::new(None),
            pending_frames: parking_lot::Mutex::new(PendingFrameBuffer::default()),
            stdout_closed: stdout_closed_tx,
            exited: exited_tx,
            output_closed: parking_lot::Mutex::new(false),
            streaming: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            last_activity: parking_lot::Mutex::new(Instant::now()),
            activity_version: AtomicU64::new(1),
            dispatch_lock: tokio::sync::Mutex::new(()),
            awaiting_async_work: AtomicBool::new(false),
            settled: AtomicBool::new(false),
            active_subagents: parking_lot::Mutex::new(HashSet::new()),
            omp_fingerprint,
            native_hash,
        });

        // stdin writer task: drains the bounded channel, skips timed-out items,
        // and exits on shutdown/close.
        let writer_handle = handle.clone();
        let stdin_task = tokio::spawn(
            write_stdin_loop(stdin, stdin_rx, shutdown_rx, writer_handle)
                .instrument(tracing::Span::none())
                .with_current_subscriber(),
        );

        // stdout reader task.
        let reader_handle = handle.clone();
        let reader_sink = sink.clone();
        let reader_task = tokio::spawn(
            read_loop(reader_sink, reader_handle, stdout, ready_tx)
                .instrument(tracing::Span::none())
                .with_current_subscriber(),
        );

        // Monitor task owns the child; emits rpc:process on exit and cleans up.
        let monitor_handle = handle.clone();
        let monitor_sink = sink.clone();
        let (exit_tx, exit_rx) = oneshot::channel();
        let monitor_task = tokio::spawn(
            monitor(
                monitor_sink,
                monitor_handle,
                child,
                exit_tx,
                exit_status.clone(),
            )
            .instrument(tracing::Span::none())
            .with_current_subscriber(),
        );

        struct SpawnGuard {
            handle: Arc<SessionHandle>,
            stdin_task: tokio::task::JoinHandle<()>,
            reader_task: tokio::task::JoinHandle<()>,
            monitor_task: tokio::task::JoinHandle<()>,
            armed: bool,
        }

        impl Drop for SpawnGuard {
            fn drop(&mut self) {
                if self.armed {
                    super::lifecycle::record(&self.handle, "spawn_aborted", None);
                    let _ = self.handle.shutdown.send(true);
                    let was_alive = self.handle.alive.swap(false, Ordering::SeqCst);
                    self.handle.pending.fail_all("spawn aborted");
                    self.stdin_task.abort();
                    self.reader_task.abort();
                    let pid = self.handle.pid;
                    if pid > 1 && was_alive {
                        // SAFETY: best-effort kill of child process if spawn failed before completion.
                        unsafe {
                            libc::kill(pid as libc::pid_t, libc::SIGKILL);
                        }
                    }
                    self.monitor_task.abort();
                    self.handle.exited.send_replace(true);
                }
            }
        }

        let mut guard = SpawnGuard {
            handle: handle.clone(),
            stdin_task,
            reader_task,
            monitor_task,
            armed: true,
        };

        // Handshake.
        phase = "ready";
        let ready = match tokio::time::timeout(READY_TIMEOUT, ready_rx).await {
            Ok(Ok(ready)) => ready,
            result => {
                failure_code = Some(if result.is_err() {
                    "startup_timeout"
                } else {
                    "spawn_failed"
                });
                let reason = if result.is_err() {
                    "omp did not emit a ready frame"
                } else {
                    "omp stdout closed before ready"
                };
                let exit = tokio::time::timeout(Duration::from_secs(1), exit_rx)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_else(|| "process has not exited".to_string());
                let _ = tokio::time::timeout(Duration::from_secs(1), stderr_done_rx).await;
                let stderr = startup_stderr.lock().render();
                return Err(startup_failure(reason, &exit, &opts.cwd, &stderr));
            }
        };
        recording_stderr.store(false, Ordering::Relaxed);
        startup_stderr.lock().clear();
        if ready
            .get("supportedProtocolVersions")
            .and_then(Value::as_array)
            .is_some_and(|v| v.contains(&json!(2)))
        {
            phase = "negotiate";
            let negotiation = send_command(
                &handle,
                json!({"type": "negotiate_protocol", "protocolVersion": 2}),
            )
            .await;
            observe_spawn_stage(&handle, phase, started, &negotiation);
        }
        phase = "get_state";
        let state_resp = send_command(&handle, json!({"type": "get_state"})).await?;
        let state_resp = if opts.resume_file.is_some() && opts.model.is_some() {
            // --model bypasses restore validation, but a concrete CLI override
            // alone is not persisted. Let omp record its resolved model through
            // the official RPC before this handle can be registered or prompted.
            phase = "restore_model";
            let model = state_resp.get("data").unwrap_or(&state_resp).get("model");
            let provider = model
                .and_then(|model| model.get("provider"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or("omp did not report the resumed model provider")?;
            let model_id = model
                .and_then(|model| model.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or("omp did not report the resumed model id")?;
            send_command(
                &handle,
                json!({"type": "set_model", "provider": provider, "modelId": model_id}),
            )
            .await?;
            phase = "get_state";
            send_command(&handle, json!({"type": "get_state"})).await?
        } else {
            state_resp
        };
        apply_state(&handle, &state_resp);
        drain_pending_frames(&sink, &handle);
        phase = "subscription";
        let subscription = send_command(
            &handle,
            json!({"type": "set_subagent_subscription", "level": "progress"}),
        )
        .await;
        observe_spawn_stage(&handle, phase, started, &subscription);
        if let Some(parent) = &opts.parent_session_id {
            // `--fork` already copied the parent transcript; a blank `new_session`
            // would discard it and break prefix caching.
            if opts.fork_file.is_none() {
                phase = "new_session";
                send_command(
                    &handle,
                    json!({"type": "new_session", "parentSession": parent}),
                )
                .await?;
            }
            phase = "get_state";
            let state_resp = send_command(&handle, json!({"type": "get_state"})).await?;
            apply_state(&handle, &state_resp);
            drain_pending_frames(&sink, &handle);
        }
        guard.armed = false;
        Ok(handle)
    }
    .await;
    let mut event = DiagnosticEvent::new(
        if result.is_ok() {
            "rpc.spawn_ready"
        } else {
            "rpc.spawn_failed"
        },
        "rpc",
    );
    event.child_pid = child_pid;
    event.phase = Some(phase.into());
    event.duration_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
    event.outcome = Some(if result.is_ok() { "ok" } else { "error" }.into());
    if let Ok(handle) = &result {
        event.session_id = process_event(handle, "rpc.spawn_ready", "rpc").session_id;
    } else {
        event.code = Some(
            failure_code
                .unwrap_or_else(|| {
                    result
                        .as_ref()
                        .err()
                        .map_or("spawn_failed", |error| diagnostics::classify_error(error))
                })
                .into(),
        );
        let status = *exit_status.lock();
        event.exit_code = status.0;
        event.exit_signal = status.1;
    }
    diagnostics::emit(event);
    result
}
pub(crate) fn apply_state(handle: &SessionHandle, resp: &Value) {
    let data = resp.get("data").unwrap_or(resp);
    if let Some(id) = data.get("sessionId").and_then(Value::as_str) {
        *handle.session_id.write() = id.to_string();
    }
    if let Some(file) = data.get("sessionFile").and_then(Value::as_str) {
        *handle.session_file.write() = file.to_string();
    }
    if let Some(streaming) = data.get("isStreaming").and_then(Value::as_bool) {
        handle.streaming.store(streaming, Ordering::SeqCst);
    }
    if let Some(waiting) = data.get("hasPendingAsyncWork").and_then(Value::as_bool) {
        handle.awaiting_async_work.store(waiting, Ordering::SeqCst);
    }
    if let Some(settled) = data.get("isSettled").and_then(Value::as_bool) {
        handle.settled.store(settled, Ordering::SeqCst);
    }
}

async fn write_stdin_loop<W: AsyncWrite + Unpin>(
    mut stdin: W,
    mut stdin_rx: mpsc::Receiver<StdinMessage>,
    mut shutdown_rx: watch::Receiver<bool>,
    writer_handle: Arc<SessionHandle>,
) {
    if !*shutdown_rx.borrow() {
        loop {
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        while stdin_rx.try_recv().is_ok() {}
                        break;
                    }
                }
                item = stdin_rx.recv() => match item {
                    Some(msg) => {
                        if msg.is_cancelled() {
                            continue;
                        }
                        let result = async {
                            stdin.write_all(msg.line.as_bytes()).await?;
                            stdin.write_all(b"\n").await?;
                            stdin.flush().await
                        }
                        .await;
                        if let Err(error) = result {
                            let mut event = process_event(&writer_handle, "rpc.io_failed", "stdin");
                            event.phase = Some("write".into());
                            event.code = Some(io_code(&error).into());
                            event.outcome = Some("error".into());
                            diagnostics::emit(event);
                            break;
                        }
                    }
                    None => break,
                },
            }
        }
    }
    // Dropping ChildStdin closes stdin → omp exits gracefully. Do it before
    // waiting for stdout so the child is never kept alive by the wait.
    drop(stdin);
    // The child may still flush a final response on stdout; let the reader
    // drain before failing anything, then fail whatever is left.
    writer_handle
        .fail_pending_after_drain("session stdin closed")
        .await;
}

async fn read_bounded_stderr_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max_bytes: usize,
) -> std::io::Result<Option<String>> {
    buf.clear();
    let mut discarding = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if buf.is_empty() && !discarding {
                return Ok(None);
            }
            break;
        }
        if let Some(pos) = chunk.iter().position(|&b| b == b'\n') {
            if !discarding {
                let remain = max_bytes.saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..pos.min(remain)]);
            }
            reader.consume(pos + 1);
            break;
        } else {
            let len = chunk.len();
            if !discarding {
                let remain = max_bytes.saturating_sub(buf.len());
                let take = len.min(remain);
                buf.extend_from_slice(&chunk[..take]);
                if take < len {
                    discarding = true;
                }
            }
            reader.consume(len);
        }
    }
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    let mut line = String::from_utf8_lossy(buf).into_owned();
    if discarding {
        line.push_str("... [truncated]");
    }
    if buf.capacity() > max_bytes.saturating_mul(2) {
        buf.clear();
        buf.shrink_to(0);
    }
    Ok(Some(line))
}

enum BoundedLine {
    Line,
    Oversized(usize),
    Eof,
}

async fn read_bounded_stdout_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max_bytes: usize,
) -> std::io::Result<BoundedLine> {
    buf.clear();
    let mut oversized_len: usize = 0;
    let mut discarding = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if discarding {
                return Ok(BoundedLine::Oversized(oversized_len));
            }
            if buf.is_empty() {
                return Ok(BoundedLine::Eof);
            }
            break;
        }
        if let Some(pos) = chunk.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            if discarding {
                oversized_len = oversized_len.saturating_add(pos);
                reader.consume(take);
                return Ok(BoundedLine::Oversized(oversized_len));
            }
            if buf.len().saturating_add(pos) > max_bytes {
                let total = buf.len().saturating_add(pos);
                buf.clear();
                buf.shrink_to_fit();
                reader.consume(take);
                return Ok(BoundedLine::Oversized(total));
            }
            buf.extend_from_slice(&chunk[..pos]);
            reader.consume(take);
            break;
        } else {
            let len = chunk.len();
            if discarding {
                oversized_len = oversized_len.saturating_add(len);
                reader.consume(len);
            } else if buf.len().saturating_add(len) > max_bytes {
                oversized_len = buf.len().saturating_add(len);
                buf.clear();
                buf.shrink_to_fit();
                discarding = true;
                reader.consume(len);
            } else {
                buf.extend_from_slice(chunk);
                reader.consume(len);
            }
        }
    }
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    Ok(BoundedLine::Line)
}

fn emit_stdout_closed(handle: &SessionHandle, error: Option<&std::io::Error>) {
    let mut event = process_event(handle, "rpc.stdout_closed", "stdout");
    event.phase = Some(if error.is_some() { "read" } else { "eof" }.into());
    event.outcome = Some(if error.is_some() { "error" } else { "observed" }.into());
    if let Some(error) = error {
        event.code = Some(io_code(error).into());
        let mut failed = process_event(handle, "rpc.io_failed", "stdout");
        failed.phase = Some("read".into());
        failed.outcome = Some("error".into());
        failed.code = event.code.clone();
        diagnostics::emit(failed);
    }
    diagnostics::emit(event);
}

async fn read_loop(
    sink: OutSink,
    handle: Arc<SessionHandle>,
    stdout: ChildStdout,
    ready_tx: oneshot::Sender<Value>,
) {
    read_loop_with_limit(sink, handle, stdout, ready_tx, None).await;
}

async fn read_loop_with_limit<R: AsyncRead + Unpin>(
    sink: OutSink,
    handle: Arc<SessionHandle>,
    stdout: R,
    ready_tx: oneshot::Sender<Value>,
    max_line_override: Option<usize>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line_buf = Vec::new();
    let mut reasm = ChunkReassembler::default();
    let mut ready_tx = Some(ready_tx);
    loop {
        let max_line_bytes = max_line_override.unwrap_or_else(|| {
            reasm
                .max_reassembled()
                .clamp(MIN_STDOUT_LINE_BYTES, MAX_REASSEMBLED_CEILING)
        });
        match read_bounded_stdout_line(&mut reader, &mut line_buf, max_line_bytes).await {
            Ok(BoundedLine::Line) => {}
            Ok(BoundedLine::Oversized(len)) => {
                tracing::warn!(
                    "rpc: oversized stdout line ({len} bytes > {max_line_bytes}), discarding"
                );
                reasm.reset();
                let mut event = process_event(&handle, "rpc.protocol_invalid", "stdout");
                event.code = Some("protocol_invalid".into());
                diagnostics::emit(event);
                continue;
            }
            Ok(BoundedLine::Eof) => {
                emit_stdout_closed(&handle, None);
                break;
            }
            Err(error) => {
                emit_stdout_closed(&handle, Some(&error));
                break;
            }
        }
        let text = match std::str::from_utf8(&line_buf) {
            Ok(text) => text,
            Err(err) => {
                let io_err = std::io::Error::new(std::io::ErrorKind::InvalidData, err);
                emit_stdout_closed(&handle, Some(&io_err));
                break;
            }
        };
        if text.trim().is_empty() {
            continue;
        }
        let raw_len = line_buf.len();
        let parsed = serde_json::from_str::<Value>(text);
        if line_buf.capacity() > 64 * 1024 {
            line_buf.clear();
            line_buf.shrink_to(0);
        }
        let Ok(value) = parsed else {
            tracing::warn!("rpc: unparseable stdout line ({raw_len} bytes)");
            let mut event = process_event(&handle, "rpc.protocol_invalid", "stdout");
            event.code = Some("protocol_invalid".into());
            diagnostics::emit(event);
            continue;
        };
        match reasm.feed(value) {
            Ok(Some(frame)) => {
                if frame.get("type").and_then(Value::as_str) == Some("ready") {
                    if let Some(max) = frame
                        .get("maxReassembledFrameBytes")
                        .and_then(Value::as_u64)
                    {
                        reasm.set_max_reassembled(usize::try_from(max).unwrap_or(usize::MAX));
                    }
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(frame);
                    }
                    continue;
                }
                apply_frame(&handle, &frame);
                emit_frame(&sink, &handle, frame);
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("rpc_chunk: {e}");
                let mut event = process_event(&handle, "rpc.protocol_invalid", "stdout");
                event.code = Some("protocol_invalid".into());
                diagnostics::emit(event);
            }
        }
    }
    // EOF: every response the child wrote has been applied. Wake the writer and
    // the monitor so they can settle pending requests in the right order.
    handle.stdout_closed.send_replace(true);
}

type ExitObservation = Arc<parking_lot::Mutex<(Option<i32>, Option<i32>)>>;

async fn monitor(
    sink: OutSink,
    handle: Arc<SessionHandle>,
    mut child: Child,
    exit_tx: oneshot::Sender<String>,
    exit_status: ExitObservation,
) {
    let status = child.wait().await;
    let code = status.as_ref().ok().and_then(|s| s.code());
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.as_ref().ok().and_then(|status| status.signal())
    };
    #[cfg(not(unix))]
    let signal = None;
    *exit_status.lock() = (code, signal);
    if let Err(error) = &status {
        let mut event = process_event(&handle, "rpc.io_failed", "rpc");
        event.phase = Some("read".into());
        event.outcome = Some("error".into());
        event.code = Some(io_code(error).into());
        diagnostics::emit(event);
    }
    super::lifecycle::record(&handle, "process_exit", code);
    let _ = exit_tx.send(match &status {
        Ok(status) => format!("exit status: {status}"),
        Err(err) => format!("failed to wait for process: {err}"),
    });
    handle.alive.store(false, Ordering::SeqCst);
    crate::mobile::work::process_exited(&handle);
    // Wake the stdin writer: it owns a handle clone, so its channel never closes on its own.
    let _ = handle.shutdown.send(true);
    let code = status.ok().and_then(|s| s.code());
    // Drain every buffered frame before publishing the exit boundary, including
    // final prompt results and persistence notices flushed immediately before exit.
    handle.fail_pending_after_drain("omp process exited").await;
    handle.streaming.store(false, Ordering::SeqCst);
    handle.pending_ui.lock().clear();
    publish_exit(&sink, &handle, code);
    handle.exited.send_replace(true);
}

fn publish_exit(sink: &OutSink, handle: &Arc<SessionHandle>, code: Option<i32>) {
    rpc::clear_process_automation_guard(handle.pid);
    let mut output_closed = handle.output_closed.lock();
    *output_closed = true;
    handle.pending_frames.lock().clear();
    let session_id = handle.session_id.read().clone();
    if session_id.is_empty() {
        return;
    }
    {
        let mut reg = rpc::registry().write();
        if reg
            .get(&session_id)
            .is_some_and(|existing| !Arc::ptr_eq(existing, handle))
        {
            rpc::clear_stopping_handle(&session_id, handle);
            return; // A replacement process already owns this session.
        }
        reg.remove(&session_id);
        sink(OutEvent::Process {
            session_id: session_id.clone(),
            running: false,
            exit_code: code,
        });
    }
    rpc::clear_stopping_handle(&session_id, handle);
}

/// Atomically mark `handle` shutting down and detach it from the live registry
/// so no concurrent `get_handle` or `ensure_live` can reuse a dying handle.
pub(super) fn mark_shutting_down_and_detach(handle: &Arc<SessionHandle>) {
    let session_id = handle.session_id.read().clone();
    let mut reg = rpc::registry().write();
    handle.shutdown.send_replace(true);
    if !session_id.is_empty()
        && reg
            .get(&session_id)
            .is_some_and(|existing| Arc::ptr_eq(existing, handle))
    {
        reg.remove(&session_id);
        if handle.pid > 0 && !*handle.exited.borrow() {
            rpc::track_stopping_handle(&session_id, handle);
        }
    }
}

/// Close stdin, wait ≤5s for exit, then SIGKILL.
pub async fn stop_handle(handle: &Arc<SessionHandle>) -> Result<(), String> {
    stop_handle_with_source(handle, "explicit_stop").await
}

pub(super) async fn stop_handle_with_source(
    handle: &Arc<SessionHandle>,
    source: &str,
) -> Result<(), String> {
    {
        let _dispatch = handle.dispatch_lock.lock().await;
        if !handle.is_shutting_down() {
            super::lifecycle::record(handle, source, None);
        }
        mark_shutting_down_and_detach(handle);
    }
    stop_handle_after_signal(handle).await
}

pub(super) async fn stop_handle_after_signal(handle: &Arc<SessionHandle>) -> Result<(), String> {
    mark_shutting_down_and_detach(handle);
    // An explicit stop cancels its callers: fail them now instead of waiting
    // for the exit path (the reader may still resolve responses that already
    // arrived; anything after this point has been abandoned by its caller).
    if handle.alive.load(Ordering::SeqCst) {
        handle.pending.fail_all("session is stopping");
    }
    if handle.wait_exited(STOP_GRACE).await {
        let session_id = handle.session_id.read().clone();
        if !session_id.is_empty() {
            rpc::clear_stopping_handle(&session_id, handle);
        }
        return Ok(());
    }
    let pid = handle.pid;
    if pid > 1 {
        // SAFETY: SIGKILL the child process after grace window.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
    // Wait for the monitor to observe the exit so callers never respawn while
    // the old process may still write the session file.
    if handle.wait_exited(Duration::from_secs(2)).await {
        let session_id = handle.session_id.read().clone();
        if !session_id.is_empty() {
            rpc::clear_stopping_handle(&session_id, handle);
        }
        return Ok(());
    }
    Err("session process did not exit".to_string())
}

#[cfg(test)]
#[path = "diagnostic_tests.rs"]
mod diagnostic_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_exit_reports_status_and_stderr() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ompws-startup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("fake-omp");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf 'startup diagnostic\\n' >&2\nexit 42\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let opts = StartOpts {
            cwd: dir.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let settings = Settings {
            omp_binary: executable.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let sink: OutSink = Arc::new(|_| {});
        let err = match spawn_with_sink(&opts, &settings, sink).await {
            Ok(_) => panic!("expected startup failure"),
            Err(err) => err,
        };
        assert!(err.contains("startup diagnostic"), "{err}");
        assert!(err.contains("42"), "{err}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn old_process_exit_does_not_revoke_replacement_registration() {
        let old = test_handle();
        let replacement = test_handle();
        let id = format!("replacement-{}", uuid::Uuid::new_v4());
        *old.session_id.write() = id.clone();
        *replacement.session_id.write() = id.clone();
        rpc::registry()
            .write()
            .insert(id.clone(), replacement.clone());
        let output = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let capture = output.clone();
        let sink: OutSink = Arc::new(move |event| capture.lock().push(event));
        emit_frame(&sink, &old, json!({"type":"message_end","messageId":"old"}));
        assert!(output.lock().is_empty());
        publish_exit(&sink, &old, Some(0));
        assert!(output.lock().is_empty());
        assert!(Arc::ptr_eq(&rpc::registry().read()[&id], &replacement));
        publish_exit(&sink, &replacement, Some(0));
        assert_eq!(output.lock().len(), 1);
        assert!(!rpc::registry().read().contains_key(&id));
    }

    #[tokio::test]
    async fn dead_handle_drops_activity_but_resolves_final_responses() {
        let h = test_handle();
        let rx = h.pending.insert("final".into());
        h.alive.store(false, Ordering::SeqCst);
        apply_frame(&h, &json!({"type":"agent_start"}));
        apply_frame(
            &h,
            &json!({"type":"extension_ui_request","id":"late","method":"confirm"}),
        );
        apply_frame(&h, &json!({"type":"response","id":"final","success":true}));
        assert!(!h.streaming.load(Ordering::SeqCst));
        assert!(h.pending_ui.lock().is_empty());
        assert_eq!(rx.await.unwrap()["success"], json!(true));
    }

    #[test]
    fn final_frames_are_delivered_before_exit_and_never_after_it() {
        let handle = test_handle();
        *handle.session_id.write() = format!("drain-{}", uuid::Uuid::new_v4());
        let output = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let captured = output.clone();
        let sink: OutSink = Arc::new(move |event| captured.lock().push(event));
        // The child has exited, but its final JSONL frames are still in stdout.
        handle.alive.store(false, Ordering::SeqCst);
        let frames = [
            json!({"type":"message_end","messageId":"answer","message":{"role":"assistant","content":[{"type":"text","text":"Final answer"}]}}),
            json!({"type":"prompt_result","id":"prompt","status":"completed","agentInvoked":true,"sessionSettled":true}),
            json!({"type":"notice","level":"error","source":"session-persistence","message":"Session could not be saved"}),
        ];
        for frame in &frames {
            apply_frame(&handle, frame);
            emit_frame(&sink, &handle, frame.clone());
        }
        publish_exit(&sink, &handle, Some(1));
        // A reader that missed its bounded drain cannot publish into a closed stream.
        emit_frame(&sink, &handle, json!({"type":"agent_start"}));
        let output = output.lock();
        assert_eq!(output.len(), frames.len() + 1);
        for (event, expected) in output.iter().zip(&frames) {
            let OutEvent::Frame { frame, .. } = event else {
                panic!("process exit overtook final stdout frame");
            };
            assert_eq!(frame, expected);
        }
        assert!(matches!(
            output.last(),
            Some(OutEvent::Process {
                running: false,
                exit_code: Some(1),
                ..
            })
        ));
    }

    #[tokio::test]
    async fn settled_dialog_cannot_be_answered_or_sent_twice() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let h = Arc::new(SessionHandle {
            stdin_tx: tx,
            ..SessionHandle::for_test()
        });
        apply_frame(
            &h,
            &json!({"type":"extension_ui_request","id":"dialog","method":"confirm"}),
        );
        send_raw(
            &h,
            json!({"type":"extension_ui_response","id":"dialog","value":true}),
        )
        .await
        .unwrap();
        assert!(rx.try_recv().is_ok());
        assert!(
            send_raw(&h, json!({"type":"extension_ui_response","id":"dialog"}))
                .await
                .is_err()
        );
        for end in [
            json!({"type":"agent_end"}),
            json!({"type":"agent_end","isTerminal":false,"awaitingAsyncWork":true}),
        ] {
            apply_frame(
                &h,
                &json!({"type":"extension_ui_request","id":"dialog","method":"confirm"}),
            );
            apply_frame(&h, &end);
            assert!(h.pending_ui.lock().is_empty());
            assert_eq!(
                send_raw(&h, json!({"type":"extension_ui_response","id":"dialog"}))
                    .await
                    .unwrap_err(),
                "UI request is no longer pending"
            );
            assert!(rx.try_recv().is_err());
        }
    }

    #[test]
    fn stale_ids_compare_known_fingerprints_only() {
        let sessions = [("a", Some("fp1")), ("b", Some("fp2")), ("c", None)];
        assert_eq!(stale_session_ids(Some("fp1"), sessions), vec!["b"]);
        assert_eq!(stale_session_ids(Some("fp2"), sessions), vec!["a"]);
        assert!(stale_session_ids(None, sessions).is_empty());
    }

    #[test]
    fn fingerprint_changes_when_binary_rewritten() {
        let dir = std::env::temp_dir().join(format!("omp-fp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("omp");
        std::fs::write(&bin, b"v1").unwrap();
        let path = dir.to_string_lossy().to_string();
        let by_name = omp_fingerprint("omp", &path).unwrap();
        let by_path = omp_fingerprint(bin.to_str().unwrap(), "").unwrap();
        assert_eq!(by_name, by_path);
        std::fs::write(&bin, b"version-2").unwrap();
        let after = omp_fingerprint("omp", &path).unwrap();
        assert_ne!(after, by_name);
        assert_eq!(
            stale_session_ids(Some(&after), [("s", Some(by_name.as_str()))]),
            vec!["s"]
        );
        assert!(omp_fingerprint("omp-missing", &path).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn test_handle() -> Arc<SessionHandle> {
        Arc::new(SessionHandle::for_test())
    }

    #[test]
    fn lifecycle_frames_track_detached_work_and_internal_probes_are_quiet() {
        let h = test_handle();
        let before = h.activity_version.load(Ordering::SeqCst);
        apply_frame(&h, &json!({"type":"response","success":true,"data":{}}));
        assert_eq!(h.activity_version.load(Ordering::SeqCst), before);
        apply_frame(&h, &json!({"type":"agent_start"}));
        assert!(!h.settled.load(Ordering::SeqCst));
        apply_frame(
            &h,
            &json!({"type":"agent_end","isTerminal":false,"awaitingAsyncWork":true}),
        );
        assert!(!h.streaming.load(Ordering::SeqCst));
        assert!(h.awaiting_async_work.load(Ordering::SeqCst));
        assert!(!h.settled.load(Ordering::SeqCst));
        apply_frame(
            &h,
            &json!({"type":"subagent_lifecycle","payload":{"id":"a1","status":"running"}}),
        );
        assert!(h.active_subagents.lock().contains("a1"));
        apply_frame(
            &h,
            &json!({"type":"subagent_lifecycle","payload":{"id":"a1","status":"completed"}}),
        );
        assert!(h.active_subagents.lock().is_empty());
        apply_frame(&h, &json!({"type":"session_settled"}));
        assert!(h.settled.load(Ordering::SeqCst));
        assert!(!h.awaiting_async_work.load(Ordering::SeqCst));
    }

    #[test]
    fn response_resolves_pending_by_id() {
        let h = test_handle();
        let rx = h.pending.insert("req_1".into());
        let resp = json!({"id": "req_1", "type": "response", "success": true, "data": {"x": 1}});
        apply_frame(&h, &resp);
        assert_eq!(rx.blocking_recv().unwrap(), resp);
    }

    #[test]
    fn response_with_unknown_id_is_ignored() {
        let h = test_handle();
        let rx = h.pending.insert("req_1".into());
        apply_frame(
            &h,
            &json!({"id": "req_other", "type": "response", "success": true}),
        );
        // Still pending: resolve now and confirm we get our own response.
        apply_frame(
            &h,
            &json!({"id": "req_1", "type": "response", "success": true}),
        );
        assert!(rx.blocking_recv().is_ok());
    }

    #[test]
    fn plan_status_frames_are_cached() {
        let h = test_handle();
        assert!(h.plan_status.lock().is_none());
        // Other status keys and malformed text are ignored.
        apply_frame(
            &h,
            &json!({"type":"extension_ui_request","id":"a","method":"setStatus","statusKey":"other","statusText":"{\"enabled\":true}"}),
        );
        apply_frame(
            &h,
            &json!({"type":"extension_ui_request","id":"b","method":"setStatus","statusKey":"ompws-plan","statusText":"nope"}),
        );
        assert!(h.plan_status.lock().is_none());
        apply_frame(
            &h,
            &json!({"type":"extension_ui_request","id":"c","method":"setStatus","statusKey":"ompws-plan","statusText":"{\"v\":1,\"enabled\":true,\"phase\":\"planning\"}"}),
        );
        let cached = h.plan_status.lock().clone().unwrap();
        assert_eq!(cached["enabled"], json!(true));
        apply_frame(
            &h,
            &json!({"type":"extension_ui_request","id":"d","method":"setStatus","statusKey":"ompws-plan","statusText":"{\"v\":1,\"enabled\":false}"}),
        );
        assert_eq!(
            h.plan_status.lock().clone().unwrap()["enabled"],
            json!(false)
        );
    }

    #[test]
    fn dialog_requests_are_tracked_and_cancelled() {
        let h = test_handle();
        apply_frame(
            &h,
            &json!({"type":"extension_ui_request","id":"ui_1","method":"select","options":["Approve","Deny"]}),
        );
        // Fire-and-forget methods are not tracked.
        apply_frame(
            &h,
            &json!({"type":"extension_ui_request","id":"w1","method":"setWidget"}),
        );
        assert_eq!(h.pending_ui.lock().len(), 1);
        apply_frame(
            &h,
            &json!({"type":"extension_ui_request","id":"c1","method":"cancel","targetId":"ui_1"}),
        );
        assert!(h.pending_ui.lock().is_empty());
    }

    #[test]
    fn streaming_tracks_agent_lifecycle() {
        let h = test_handle();
        apply_frame(&h, &json!({"type":"agent_start"}));
        assert!(h.streaming.load(Ordering::SeqCst));
        // Non-terminal agent_end keeps streaming (maintenance turn).
        apply_frame(&h, &json!({"type":"agent_end","isTerminal":false}));
        assert!(h.streaming.load(Ordering::SeqCst));
        apply_frame(&h, &json!({"type":"agent_end","isTerminal":true}));
        assert!(!h.streaming.load(Ordering::SeqCst));
        // Missing isTerminal is terminal-compatible.
        apply_frame(&h, &json!({"type":"agent_start"}));
        apply_frame(&h, &json!({"type":"agent_end"}));
        assert!(!h.streaming.load(Ordering::SeqCst));
        // Idle until a background job wakes it: not streaming (prompts go direct).
        apply_frame(&h, &json!({"type":"agent_start"}));
        apply_frame(
            &h,
            &json!({"type":"agent_end","isTerminal":false,"awaitingAsyncWork":true}),
        );
        assert!(!h.streaming.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn send_command_reports_closed_stdin_and_dead_process() {
        // stdin receiver dropped → send fails fast.
        let h = test_handle();
        *h.session_id.write() = format!("closed-stdin-{}", uuid::Uuid::new_v4());
        assert!(rpc::idle_suspendable(&h, Duration::ZERO));
        let err = send_command(&h, json!({"type":"get_state"}))
            .await
            .unwrap_err();
        assert_eq!(err, "session stdin closed");
        assert!(rpc::idle_suspendable(&h, Duration::ZERO));
        let locked_err = send_command_locked(&h, json!({"type":"get_state"}))
            .await
            .unwrap_err();
        assert_eq!(locked_err, "session stdin closed");
        assert!(rpc::idle_suspendable(&h, Duration::ZERO));
        let other = h.pending.insert("unrelated-request".to_string());
        assert!(send_command(&h, json!({"type":"get_state"})).await.is_err());
        apply_frame(
            &h,
            &json!({"type":"response","id":"unrelated-request","success":true}),
        );
        assert_eq!(other.await.unwrap()["success"], true);

        h.alive.store(false, Ordering::SeqCst);
        let err = send_command(&h, json!({"type":"get_state"}))
            .await
            .unwrap_err();
        assert_eq!(err, "session process is not running");
    }

    #[tokio::test]
    async fn send_command_success_false_maps_to_err() {
        // Keep the stdin receiver alive and resolve the pending request with a
        // failure response, mimicking the read loop.
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let h = Arc::new(SessionHandle {
            stdin_tx: tx,
            ..SessionHandle::for_test()
        });
        let h3 = h.clone();
        let writer = tokio::spawn(async move {
            let line = rx.recv().await.expect("stdin line");
            let sent: Value = serde_json::from_str(&line).unwrap();
            let id = sent["id"].as_str().unwrap().to_string();
            h3.pending.resolve(
                &id,
                json!({"id": id, "type":"response","success":false,"error":"nope"}),
            );
        });
        let err = send_command(&h, json!({"type":"get_state"}))
            .await
            .unwrap_err();
        writer.await.unwrap();
        assert_eq!(err, "nope");
    }

    #[tokio::test]
    async fn prompt_is_delivered_if_a_turn_starts_after_command_preparation() {
        for turn_started in [false, true] {
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            let handle = Arc::new(SessionHandle {
                stdin_tx: tx,
                ..SessionHandle::for_test()
            });
            // Prepared while the host still sees an idle session.
            assert!(!handle.streaming.load(Ordering::SeqCst));
            let command = rpc::prompt_command("User question", Vec::new(), None);
            let upstream = handle.clone();
            let consumer = tokio::spawn(async move {
                let line = rx.recv().await.expect("prompt written to upstream");
                let sent: Value = serde_json::from_str(&line).unwrap();
                // Mirrors AgentSession.prompt's post-preparation busy check:
                // no policy refuses the prompt, followUp queues it, idle starts it.
                if turn_started {
                    apply_frame(&upstream, &json!({"type":"agent_start"}));
                }
                let delivery = if upstream.streaming.load(Ordering::SeqCst) {
                    match sent["streamingBehavior"].as_str() {
                        Some("followUp") => Some(("followUp", sent["message"].clone())),
                        _ => None,
                    }
                } else {
                    Some(("started", sent["message"].clone()))
                };
                let response = if delivery.is_some() {
                    json!({"type":"response","command":"prompt","id":sent["id"],"success":true})
                } else {
                    json!({"type":"response","command":"prompt","id":sent["id"],"success":false,"error":"Agent is busy"})
                };
                apply_frame(&upstream, &response);
                delivery
            });
            send_command(&handle, command)
                .await
                .expect("prompt accepted");
            assert_eq!(
                consumer.await.unwrap(),
                Some((
                    if turn_started { "followUp" } else { "started" },
                    json!("User question")
                ))
            );
        }
    }

    #[tokio::test]
    async fn send_command_surfaces_upstream_refusal_code() {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let h = Arc::new(SessionHandle {
            stdin_tx: tx,
            ..SessionHandle::for_test()
        });
        let h3 = h.clone();
        let writer = tokio::spawn(async move {
            let line = rx.recv().await.expect("stdin line");
            let sent: Value = serde_json::from_str(&line).unwrap();
            let id = sent["id"].as_str().unwrap().to_string();
            h3.pending.resolve(
                &id,
                json!({"id": id, "type":"response","success":false,"error":"nope","code":"session_busy"}),
            );
        });
        let err = send_command(&h, json!({"type":"navigate_tree"}))
            .await
            .unwrap_err();
        writer.await.unwrap();
        assert_eq!(err, "session_busy: nope");
    }

    #[test]
    fn emit_frame_buffers_when_session_id_empty_and_drains() {
        let h = test_handle();
        *h.session_id.write() = String::new();

        let emitted = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let emitted_clone = emitted.clone();
        let sink: OutSink = Arc::new(move |ev| {
            if let OutEvent::Frame { session_id, frame } = ev {
                emitted_clone.lock().push((session_id, frame));
            }
        });

        let frame1 = json!({"type": "available_commands_update", "commands": []});
        let frame2 = json!({"type": "extension_ui_request", "id": "1"});

        emit_frame(&sink, &h, frame1.clone());
        emit_frame(&sink, &h, frame2.clone());

        // Buffering: nothing emitted yet
        assert_eq!(emitted.lock().len(), 0);
        assert_eq!(h.pending_frames.lock().len(), 2);

        // Apply state / set session_id
        *h.session_id.write() = "s_test_123".to_string();
        drain_pending_frames(&sink, &h);

        assert_eq!(h.pending_frames.lock().len(), 0);
        let items = emitted.lock().clone();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].0, "s_test_123");
        assert_eq!(items[0].1, frame1);
        assert_eq!(items[1].0, "s_test_123");
        assert_eq!(items[1].1, frame2);
    }

    #[tokio::test]
    async fn send_command_rejects_non_object() {
        let h = test_handle();
        let err = send_command(&h, json!("not an object")).await.unwrap_err();
        assert_eq!(err, "command must be a JSON object");

        let err2 = send_command(&h, json!([1, 2, 3])).await.unwrap_err();
        assert_eq!(err2, "command must be a JSON object");
    }

    #[tokio::test]
    async fn send_command_rejects_when_shutdown() {
        let (tx, _rx) = mpsc::unbounded_channel::<String>();
        let (shutdown, _srx) = watch::channel(false);
        let h = Arc::new(SessionHandle {
            stdin_tx: tx,
            shutdown,
            ..SessionHandle::for_test()
        });
        let _ = h.shutdown.send(true);
        let err = send_command(&h, json!({"type": "get_state"}))
            .await
            .unwrap_err();
        assert_eq!(err, "session process is not running");
    }

    #[tokio::test]
    async fn stop_handle_fails_pending_requests() {
        let h = test_handle();
        let rx = h.pending.insert("req_test".into());
        let _ = stop_handle(&h).await;
        let resp = rx.await.expect("pending request resolved by stop_handle");
        assert_eq!(resp.get("success").and_then(Value::as_bool), Some(false));
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("session is stopping")
        );
    }

    /// A response the child prints just before exiting must resolve its caller:
    /// the exit path settles pending requests only after stdout hit EOF.
    #[tokio::test]
    async fn pending_is_failed_only_after_stdout_drains() {
        let (tx, _rx) = mpsc::unbounded_channel::<String>();
        let (shutdown, _srx) = watch::channel(false);
        let (closed, _crx) = watch::channel(false);
        let h = Arc::new(SessionHandle {
            stdin_tx: tx,
            shutdown,
            stdout_closed: closed,
            ..SessionHandle::for_test()
        });
        let rx = h.pending.insert("req_1".into());
        let reader_handle = h.clone();
        let reader = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            apply_frame(
                &reader_handle,
                &json!({"id":"req_1","type":"response","success":true,"data":{"ok":1}}),
            );
            reader_handle.stdout_closed.send_replace(true);
        });
        let fail_handle = h.clone();
        let failer = tokio::spawn(async move {
            fail_handle
                .fail_pending_after_drain("omp process exited")
                .await;
        });
        let resp = rx.await.expect("response resolved before fail_all");
        assert_eq!(resp.get("success").and_then(Value::as_bool), Some(true));
        reader.await.unwrap();
        failer.await.unwrap();
        assert!(h.pending.is_empty());
    }

    /// Whatever stdout did not answer is still failed once it drains (or after
    /// the drain grace period), so callers never hang on a dead process.
    #[tokio::test]
    async fn drained_stdout_still_fails_unanswered_requests() {
        let h = test_handle(); // for_test: stdout already closed
        let rx = h.pending.insert("req_missing".into());
        h.fail_pending_after_drain("omp process exited").await;
        let resp = rx.await.unwrap();
        assert_eq!(resp.get("success").and_then(Value::as_bool), Some(false));
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("omp process exited")
        );
    }

    #[test]
    fn build_command_plan_yolo_appended_for_fresh_session() {
        let settings = Settings::default();
        let opts = StartOpts {
            cwd: "/tmp".into(),
            plan_yolo: Some(true),
            ..Default::default()
        };
        let cmd = build_command(&opts, &settings).unwrap();
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"--plan-yolo".to_string()));
    }

    #[test]
    fn build_command_plan_yolo_skipped_when_resuming() {
        let settings = Settings::default();
        let opts = StartOpts {
            cwd: "/tmp".into(),
            resume_file: Some("/tmp/session.jsonl".into()),
            plan_yolo: Some(true),
            ..Default::default()
        };
        let cmd = build_command(&opts, &settings).unwrap();
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(!args.contains(&"--plan-yolo".to_string()));
        assert!(args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_command_plan_yolo_skipped_when_false_or_none() {
        let settings = Settings::default();
        let opts = StartOpts {
            cwd: "/tmp".into(),
            plan_yolo: Some(false),
            ..Default::default()
        };
        let cmd = build_command(&opts, &settings).unwrap();
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(!args.contains(&"--plan-yolo".to_string()));

        let opts_none = StartOpts {
            cwd: "/tmp".into(),
            plan_yolo: None,
            ..Default::default()
        };
        let cmd_none = build_command(&opts_none, &settings).unwrap();
        let args_none: Vec<String> = cmd_none
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(!args_none.contains(&"--plan-yolo".to_string()));
    }
    fn command_args(opts: &StartOpts, settings: &Settings) -> Vec<String> {
        build_command(opts, settings)
            .unwrap()
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn build_command_resume_does_not_apply_new_session_model() {
        let settings = Settings {
            new_session_model: Some("openai/gpt-5".into()),
            ..Settings::default()
        };
        let opts = StartOpts {
            cwd: "/tmp".into(),
            resume_file: Some("/tmp/session.jsonl".into()),
            ..Default::default()
        };
        let args = command_args(&opts, &settings);
        assert!(!args.contains(&"--model".to_string()));
        assert!(args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_command_resume_keeps_explicit_model_override() {
        let settings = Settings {
            new_session_model: Some("openai/gpt-5".into()),
            ..Settings::default()
        };
        let opts = StartOpts {
            cwd: "/tmp".into(),
            resume_file: Some("/tmp/session.jsonl".into()),
            model: Some("anthropic/claude-sonnet".into()),
            ..Default::default()
        };
        let args = command_args(&opts, &settings);
        let pos = args.iter().position(|arg| arg == "--model").unwrap();
        assert_eq!(args[pos + 1], "anthropic/claude-sonnet");
    }

    #[test]
    fn build_command_fresh_still_uses_new_session_model() {
        let settings = Settings {
            new_session_model: Some("openai/gpt-5".into()),
            ..Settings::default()
        };
        let opts = StartOpts {
            cwd: "/tmp".into(),
            ..Default::default()
        };
        let args = command_args(&opts, &settings);
        let pos = args.iter().position(|arg| arg == "--model").unwrap();
        assert_eq!(args[pos + 1], "openai/gpt-5");
    }
    #[test]
    fn build_command_plugin_dir_gated_by_visualize_enabled() {
        // Install the bundled plugin under an isolated data dir so the
        // `--plugin-dir` arg has a real manifest to point at.
        let dir = std::env::temp_dir().join(format!("ompws-viz-spawn-{}", uuid::Uuid::new_v4()));
        std::env::set_var("OMPWS_DATA_DIR", &dir);
        crate::visualize::install();

        let opts = StartOpts {
            cwd: "/tmp".into(),
            ..Default::default()
        };
        let args_of = |s: &Settings| {
            build_command(&opts, s)
                .unwrap()
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy().to_string())
                .collect::<Vec<String>>()
        };

        let on = args_of(&Settings::default());
        let pos = on.iter().position(|a| a == "--plugin-dir");
        assert!(pos.is_some(), "expected --plugin-dir in {on:?}");
        assert_eq!(
            on[pos.unwrap() + 1],
            crate::visualize::plugin_dir().to_string_lossy()
        );
        let hint_pos = on.iter().position(|a| a == "--append-system-prompt");
        assert!(hint_pos.is_some_and(|p| on[p + 1].contains("skill://visualize")));

        let off = args_of(&Settings {
            visualize_enabled: false,
            ..Settings::default()
        });
        assert!(!off.iter().any(|a| a == "--plugin-dir"));
        assert!(!off.iter().any(|a| a == "--append-system-prompt"));

        // The terminal's `omp --resume` must get the identical prompt-shaping argv
        // as the RPC spawn, or the first turn after switching views cold-misses
        // the provider prompt cache.
        let file = dir.join("s.jsonl");
        std::fs::write(
            &file,
            "{\"type\":\"session\",\"id\":\"sid\",\"providerPromptCacheKey\":\"pinned\"}\n",
        )
        .unwrap();
        let file = file.to_string_lossy().to_string();
        let resume_opts = StartOpts {
            cwd: "/tmp".into(),
            resume_file: Some(file.clone()),
            ..Default::default()
        };
        for visualize_enabled in [true, false] {
            let s = Settings {
                visualize_enabled,
                ..Settings::default()
            };
            let shape = prompt_shape_args(Some(&file), None, None, &s);
            let pos = shape
                .iter()
                .position(|a| a == "--prompt-cache-key")
                .unwrap();
            assert_eq!(shape[pos + 1], "pinned");
            let rpc: Vec<String> = build_command(&resume_opts, &s)
                .unwrap()
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy().to_string())
                .collect();
            assert!(
                rpc.windows(shape.len()).any(|w| w == shape.as_slice()),
                "rpc argv {rpc:?} lacks shared shape {shape:?}"
            );
        }

        std::env::remove_var("OMPWS_DATA_DIR");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn session_file(lines: &[&str]) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("ompws-ckey-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        std::fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();
        (dir, file.to_string_lossy().to_string())
    }

    #[test]
    fn transcript_cache_key_reads_header_after_title_row() {
        let (dir, file) = session_file(&[
            r#"{"type":"title","title":"t"}"#,
            r#"{"type":"session","id":"child","providerPromptCacheKey":"parent-key"}"#,
        ]);
        assert_eq!(
            transcript_cache_key(&file, true).as_deref(),
            Some("parent-key")
        );
        assert_eq!(
            transcript_cache_key(&file, false).as_deref(),
            Some("parent-key")
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn transcript_cache_key_falls_back_to_id_only_for_forks() {
        let (dir, file) = session_file(&[r#"{"type":"session","id":"parent-id"}"#]);
        assert_eq!(
            transcript_cache_key(&file, true).as_deref(),
            Some("parent-id")
        );
        assert_eq!(transcript_cache_key(&file, false), None);
        assert_eq!(transcript_cache_key("/nonexistent/x.jsonl", true), None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn fork_spawn_pins_parent_prompt_cache_key() {
        let (dir, file) = session_file(&[r#"{"type":"session","id":"parent-id"}"#]);
        let opts = StartOpts {
            cwd: "/tmp".into(),
            fork_file: Some(file),
            model: Some("openai/gpt-5".into()),
            ..Default::default()
        };
        let args: Vec<String> = build_command(&opts, &Settings::default())
            .unwrap()
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let pos = args.iter().position(|a| a == "--prompt-cache-key").unwrap();
        assert_eq!(args[pos + 1], "parent-id");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn bounded_stdin_queue_reports_backpressure_when_full() {
        let (handle, _rx, _shutdown_rx) = SessionHandle::for_test_bounded(2);
        let handle = Arc::new(handle);
        handle
            .enqueue_stdin(StdinMessage::new("{\"type\":\"a\"}".into(), None))
            .unwrap();
        handle
            .enqueue_stdin(StdinMessage::new("{\"type\":\"b\"}".into(), None))
            .unwrap();
        let err = send_command(&handle, json!({"type": "get_state"}))
            .await
            .unwrap_err();
        assert_eq!(err, "session stdin queue full");
        assert!(handle.pending.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_command_is_skipped_by_stdin_writer() {
        let (handle, rx, shutdown_rx) = SessionHandle::for_test_bounded(4);
        let handle = Arc::new(handle);

        // Send a command with a short timeout BEFORE the stdin writer drains the queue.
        let err = send_command_with_timeout(
            &handle,
            json!({"type": "prompt", "message": "should never hit stdin"}),
            Duration::from_millis(50),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "command timed out");
        assert!(handle.pending.is_empty());

        // Queue a subsequent non-cancelled command to prove the writer continues cleanly.
        handle
            .enqueue_stdin(StdinMessage::new(
                "{\"type\":\"get_state\",\"id\":\"keep\"}".into(),
                None,
            ))
            .unwrap();

        let (client, mut server) = tokio::io::duplex(1024);
        let writer_handle = handle.clone();
        let writer = tokio::spawn(write_stdin_loop(client, rx, shutdown_rx, writer_handle));

        // Wait until the kept line is written, then signal shutdown so the writer exits.
        let mut written = Vec::new();
        let mut buf = [0u8; 256];
        loop {
            let n = tokio::io::AsyncReadExt::read(&mut server, &mut buf)
                .await
                .unwrap();
            written.extend_from_slice(&buf[..n]);
            if written.contains(&b'\n') {
                break;
            }
        }
        let _ = handle.shutdown.send(true);
        writer.await.unwrap();

        let written_text = String::from_utf8(written).unwrap();
        assert_eq!(written_text, "{\"type\":\"get_state\",\"id\":\"keep\"}\n");
        assert!(!written_text.contains("should never hit stdin"));
    }

    #[tokio::test]
    async fn read_loop_discards_oversized_stdout_line_and_recovers() {
        let handle = test_handle();
        *handle.session_id.write() = format!("oversized-{}", uuid::Uuid::new_v4());
        let emitted = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let emitted_clone = emitted.clone();
        let sink: OutSink = Arc::new(move |ev| {
            if let OutEvent::Frame { frame, .. } = ev {
                emitted_clone.lock().push(frame);
            }
        });
        let oversized = format!("{{\"big\":\"{}\"}}\n", "x".repeat(256));
        let valid = "{\"type\":\"agent_end\"}\n";
        let stream = std::io::Cursor::new(format!("{oversized}{valid}").into_bytes());
        let (ready_tx, _ready_rx) = oneshot::channel();
        read_loop_with_limit(sink, handle, stream, ready_tx, Some(64)).await;
        let frames = emitted.lock();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "agent_end");
    }

    #[test]
    fn bounded_stderr_keeps_tail_within_budget() {
        let mut stderr = BoundedStderr::new(64);
        for i in 0..20 {
            stderr.push_line(format!("noise line {i:02}"));
        }
        stderr.push_line("SessionModelRestoreError: Could not restore model x".into());
        let rendered = stderr.render();
        assert!(rendered.starts_with("... (stderr truncated)\n"));
        assert!(rendered.contains("SessionModelRestoreError: Could not restore model x"));
        assert!(stderr.bytes <= 64);
    }

    #[test]
    fn pending_frame_buffer_enforces_count_and_byte_bounds() {
        let mut buf = PendingFrameBuffer::default();
        assert!(buf.push_with_limits(json!({"seq": 1}), 2, 1024));
        assert!(buf.push_with_limits(json!({"seq": 2}), 2, 1024));
        assert!(buf.push_with_limits(json!({"seq": 3}), 2, 1024));
        assert_eq!(buf.len(), 2);
        let frames = buf.take();
        assert_eq!(frames, vec![json!({"seq": 2}), json!({"seq": 3})]);
        assert_eq!(buf.bytes(), 0);

        // Oversized single frame is rejected cleanly without panicking.
        assert!(!buf.push_with_limits(json!({"huge": "x".repeat(200)}), 4, 64));
        assert!(buf.is_empty());
    }

    #[test]
    fn emit_frame_slims_tool_details_before_buffering_and_delivery() {
        let h = test_handle();
        *h.session_id.write() = String::new();
        let emitted = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let emitted_clone = emitted.clone();
        let sink: OutSink = Arc::new(move |ev| {
            if let OutEvent::Frame { frame, .. } = ev {
                emitted_clone.lock().push(frame);
            }
        });
        emit_frame(
            &sink,
            &h,
            json!({
                "type": "tool_execution_end",
                "toolCallId": "tc1",
                "toolName": "read",
                "result": {
                    "content": [{"type": "text", "text": "ok"}],
                    "details": { "displayContent": "x".repeat(4096) }
                }
            }),
        );
        // Buffered frame is already slimmed (no bloated displayContent retained).
        assert!(h.pending_frames.lock().bytes() < 512);
        *h.session_id.write() = "s_slim".to_string();
        drain_pending_frames(&sink, &h);
        let frames = emitted.lock();
        assert_eq!(frames.len(), 1);
        assert!(frames[0]["result"].get("details").is_none());
    }
}

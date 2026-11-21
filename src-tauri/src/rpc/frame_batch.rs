//! Outbound RPC frame slimming and per-session burst coalescing.
//!
//! Streaming `message_update` and `tool_execution_update` frames carry cumulative
//! snapshots that can saturate Tauri IPC and broadcast buffers when emitted per
//! token/chunk. This module strips redundant tool `details` (matching
//! `catalog::transcript::slim_details`) and coalesces streaming bursts per
//! `(session_id, key)` within a short window while preserving strict barrier
//! ordering.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::rpc::process::{OutEvent, OutSink};

pub(crate) const DEFAULT_BATCH_WINDOW: Duration = Duration::from_millis(40);

#[derive(Clone, Copy)]
enum DetailsPolicy {
    KeepFull,
    KeepDiffOnly,
    FallbackByShape,
}

fn details_policy(tool_name: Option<&str>) -> DetailsPolicy {
    match tool_name {
        Some("task" | "agent" | "ask") => DetailsPolicy::KeepFull,
        Some(_) => DetailsPolicy::KeepDiffOnly,
        None => DetailsPolicy::FallbackByShape,
    }
}

fn should_keep_details(policy: DetailsPolicy, details: &Value) -> bool {
    match policy {
        DetailsPolicy::KeepFull => true,
        DetailsPolicy::KeepDiffOnly => false,
        DetailsPolicy::FallbackByShape => {
            details.get("progress").is_some()
                || details.get("results").is_some()
                || details.get("questions").is_some()
                || details.get("answers").is_some()
        }
    }
}

fn slim_details_in_place(container: &mut Value, policy: DetailsPolicy) {
    let Some(obj) = container.as_object_mut() else {
        return;
    };
    let Some(details) = obj.get_mut("details") else {
        return;
    };
    if should_keep_details(policy, details) {
        return;
    }
    if let Some(det) = details.as_object_mut() {
        if det.len() == 1 && det.get("diff").is_some_and(Value::is_string) {
            return;
        }
        if let Some(diff) = det.remove("diff").filter(Value::is_string) {
            let mut kept = Map::with_capacity(1);
            kept.insert("diff".to_string(), diff);
            *details = Value::Object(kept);
            return;
        }
    }
    obj.remove("details");
}

/// Strip oversized redundant `details` fields from tool-bearing RPC frames
/// before they enter IPC or broadcast buffers.
pub(crate) fn slim_rpc_frame(mut frame: Value) -> Value {
    match frame.get("type").and_then(Value::as_str) {
        Some("tool_execution_update") => {
            let policy = details_policy(frame.get("toolName").and_then(Value::as_str));
            if let Some(partial) = frame.get_mut("partialResult") {
                slim_details_in_place(partial, policy);
            }
        }
        Some("tool_execution_end") => {
            let policy = details_policy(frame.get("toolName").and_then(Value::as_str));
            if let Some(result) = frame.get_mut("result") {
                slim_details_in_place(result, policy);
            }
        }
        Some("message_end") => {
            if let Some(msg) = frame.get_mut("message") {
                if msg.get("role").and_then(Value::as_str) == Some("toolResult") {
                    let policy = details_policy(msg.get("toolName").and_then(Value::as_str));
                    slim_details_in_place(msg, policy);
                }
            }
        }
        _ => {}
    }
    frame
}

#[derive(PartialEq, Eq)]
enum CoalesceKey {
    MessageUpdate,
    ToolUpdate(String),
}

#[derive(Clone, Copy)]
enum CoalesceKeyRef<'a> {
    MessageUpdate,
    ToolUpdate(&'a str),
}

impl CoalesceKeyRef<'_> {
    fn to_owned(self) -> CoalesceKey {
        match self {
            Self::MessageUpdate => CoalesceKey::MessageUpdate,
            Self::ToolUpdate(id) => CoalesceKey::ToolUpdate(id.to_owned()),
        }
    }
}

impl PartialEq<CoalesceKeyRef<'_>> for CoalesceKey {
    fn eq(&self, other: &CoalesceKeyRef<'_>) -> bool {
        match (self, other) {
            (CoalesceKey::MessageUpdate, CoalesceKeyRef::MessageUpdate) => true,
            (CoalesceKey::ToolUpdate(a), CoalesceKeyRef::ToolUpdate(b)) => a == b,
            _ => false,
        }
    }
}

fn coalesce_key_ref(frame: &Value) -> Option<CoalesceKeyRef<'_>> {
    match frame.get("type").and_then(Value::as_str)? {
        "message_update" => Some(CoalesceKeyRef::MessageUpdate),
        "tool_execution_update" => frame
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(CoalesceKeyRef::ToolUpdate),
        _ => None,
    }
}

fn event_session_id(ev: &OutEvent) -> &str {
    match ev {
        OutEvent::Frame { session_id, .. } | OutEvent::Process { session_id, .. } => session_id,
    }
}

struct PendingEntry {
    key: CoalesceKey,
    event: OutEvent,
}

impl PendingEntry {
    fn session_id(&self) -> &str {
        event_session_id(&self.event)
    }
}

#[derive(Default)]
struct BatchState {
    queue: Vec<PendingEntry>,
    scheduled: bool,
    // Bumped whenever the queue is cleared so stale timer wakeups never truncate a newer batch.
    next_gen: u64,
}

struct Inner {
    window: Duration,
    deliver: OutSink,
    state: Mutex<BatchState>,
    // Lock order is always `deliver_lock` -> `state` so timer flushes and barriers stay ordered.
    deliver_lock: Mutex<()>,
}

impl Inner {
    fn flush_all(&self) {
        let _deliver_guard = self.deliver_lock.lock();
        let drained = {
            let mut state = self.state.lock();
            state.scheduled = false;
            state.next_gen = state.next_gen.wrapping_add(1);
            std::mem::take(&mut state.queue)
        };
        for entry in drained {
            (self.deliver)(entry.event);
        }
    }

    fn flush_scheduled(&self, gen: u64) {
        let _deliver_guard = self.deliver_lock.lock();
        let drained = {
            let mut state = self.state.lock();
            if !state.scheduled || state.next_gen != gen {
                return;
            }
            state.scheduled = false;
            state.next_gen = state.next_gen.wrapping_add(1);
            std::mem::take(&mut state.queue)
        };
        for entry in drained {
            (self.deliver)(entry.event);
        }
    }

    fn deliver_barrier(&self, barrier: OutEvent) {
        let sid = event_session_id(&barrier);
        let _deliver_guard = self.deliver_lock.lock();
        let drained = {
            let mut state = self.state.lock();
            drain_session(&mut state, sid)
        };
        for pending in drained {
            (self.deliver)(pending);
        }
        (self.deliver)(barrier);
    }
}

fn drain_session(state: &mut BatchState, sid: &str) -> Vec<OutEvent> {
    if !state.queue.iter().any(|e| e.session_id() == sid) {
        return Vec::new();
    }
    let prev = std::mem::take(&mut state.queue);
    let mut drained = Vec::new();
    for entry in prev {
        if entry.session_id() == sid {
            drained.push(entry.event);
        } else {
            state.queue.push(entry);
        }
    }
    if state.queue.is_empty() {
        state.scheduled = false;
        state.next_gen = state.next_gen.wrapping_add(1);
    }
    drained
}

/// Coalesces outbound streaming frames per `(session_id, key)` within a short window
/// while flushing pending frames for a session ahead of any barrier event.
pub(crate) struct FrameBatcher {
    inner: Arc<Inner>,
}

impl FrameBatcher {
    pub(crate) fn new(window: Duration, deliver: OutSink) -> Self {
        Self {
            inner: Arc::new(Inner {
                window,
                deliver,
                state: Mutex::new(BatchState::default()),
                deliver_lock: Mutex::new(()),
            }),
        }
    }

    pub(crate) fn push(&self, ev: OutEvent) {
        let ev = match ev {
            OutEvent::Frame { session_id, frame } => OutEvent::Frame {
                session_id,
                frame: slim_rpc_frame(frame),
            },
            barrier @ OutEvent::Process { .. } => barrier,
        };
        self.push_slimmed(ev);
    }

    /// Enqueue an event whose `OutEvent::Frame` payload has already passed
    /// through `slim_rpc_frame`, avoiding a redundant traversal on the hot path.
    pub(crate) fn push_slimmed(&self, ev: OutEvent) {
        match ev {
            OutEvent::Frame { session_id, frame } => {
                if let Some(key_ref) = coalesce_key_ref(&frame) {
                    let mut state = self.inner.state.lock();
                    let hit_idx = state
                        .queue
                        .iter()
                        .rposition(|e| e.session_id() == session_id && e.key == key_ref);
                    if let Some(idx) = hit_idx {
                        if let OutEvent::Frame { frame: slot, .. } = &mut state.queue[idx].event {
                            *slot = frame;
                        }
                    } else {
                        let key = key_ref.to_owned();
                        state.queue.push(PendingEntry {
                            key,
                            event: OutEvent::Frame { session_id, frame },
                        });
                    }
                    if !state.scheduled {
                        if let Ok(rt) = tokio::runtime::Handle::try_current() {
                            state.scheduled = true;
                            let gen = state.next_gen;
                            let inner = Arc::clone(&self.inner);
                            let window = self.inner.window;
                            rt.spawn(async move {
                                tokio::time::sleep(window).await;
                                inner.flush_scheduled(gen);
                            });
                        }
                    }
                    return;
                }
                self.inner
                    .deliver_barrier(OutEvent::Frame { session_id, frame });
            }
            barrier @ OutEvent::Process { .. } => {
                self.inner.deliver_barrier(barrier);
            }
        }
    }

    pub(crate) fn flush_all(&self) {
        self.inner.flush_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn capture_sink() -> (OutSink, Arc<Mutex<Vec<OutEvent>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink_log = Arc::clone(&log);
        let sink: OutSink = Arc::new(move |ev| sink_log.lock().push(ev));
        (sink, log)
    }

    fn frame_types(events: &[OutEvent]) -> Vec<(&str, &str)> {
        events
            .iter()
            .map(|ev| match ev {
                OutEvent::Frame { session_id, frame } => (
                    session_id.as_str(),
                    frame.get("type").and_then(Value::as_str).unwrap_or(""),
                ),
                OutEvent::Process { session_id, .. } => (session_id.as_str(), "process"),
            })
            .collect()
    }

    #[test]
    fn slim_rpc_frame_strips_read_and_edit_details_while_preserving_diff_and_task_ask() {
        let read_update = slim_rpc_frame(json!({
            "type": "tool_execution_update",
            "toolCallId": "tc1",
            "toolName": "read",
            "partialResult": {
                "content": [{"type": "text", "text": "hello"}],
                "details": { "displayContent": "huge text" }
            }
        }));
        assert!(read_update["partialResult"].get("details").is_none());

        let edit_end = slim_rpc_frame(json!({
            "type": "tool_execution_end",
            "toolCallId": "tc2",
            "toolName": "edit",
            "result": {
                "details": {
                    "diff": "@@ -1 +1 @@\n-a\n+b",
                    "oldText": "a",
                    "newText": "b",
                    "perFileResults": [{"path": "x"}]
                }
            }
        }));
        assert_eq!(
            edit_end["result"]["details"],
            json!({ "diff": "@@ -1 +1 @@\n-a\n+b" })
        );

        let tool_result_msg = slim_rpc_frame(json!({
            "type": "message_end",
            "message": {
                "role": "toolResult",
                "toolName": "edit",
                "details": {
                    "diff": "@@ -1 +1 @@",
                    "oldText": "x",
                    "newText": "y"
                }
            }
        }));
        assert_eq!(
            tool_result_msg["message"]["details"],
            json!({ "diff": "@@ -1 +1 @@" })
        );

        let task_end = slim_rpc_frame(json!({
            "type": "tool_execution_end",
            "toolCallId": "tc3",
            "toolName": "task",
            "result": {
                "details": {
                    "progress": [{"index": 0, "status": "done"}],
                    "results": [{"output": "ok"}]
                }
            }
        }));
        assert_eq!(
            task_end["result"]["details"],
            json!({
                "progress": [{"index": 0, "status": "done"}],
                "results": [{"output": "ok"}]
            })
        );

        let ask_msg = slim_rpc_frame(json!({
            "type": "message_end",
            "message": {
                "role": "toolResult",
                "toolName": "ask",
                "details": {
                    "questions": [{"id": "q1"}],
                    "answers": {"q1": "yes"}
                }
            }
        }));
        assert_eq!(
            ask_msg["message"]["details"],
            json!({
                "questions": [{"id": "q1"}],
                "answers": {"q1": "yes"}
            })
        );

        let missing_name_task = slim_rpc_frame(json!({
            "type": "tool_execution_update",
            "toolCallId": "tc4",
            "partialResult": {
                "details": { "progress": [{"step": 1}], "extra": "kept" }
            }
        }));
        assert_eq!(
            missing_name_task["partialResult"]["details"],
            json!({ "progress": [{"step": 1}], "extra": "kept" })
        );

        let missing_name_read = slim_rpc_frame(json!({
            "type": "tool_execution_end",
            "toolCallId": "tc5",
            "result": {
                "details": { "displayContent": "drop me" }
            }
        }));
        assert!(missing_name_read["result"].get("details").is_none());

        let assistant_msg = slim_rpc_frame(json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "details": { "displayContent": "untouched" }
            }
        }));
        assert_eq!(
            assistant_msg["message"]["details"],
            json!({ "displayContent": "untouched" })
        );
    }

    #[test]
    fn coalesces_message_update_and_same_tool_call_update() {
        let (sink, log) = capture_sink();
        let batcher = FrameBatcher::new(DEFAULT_BATCH_WINDOW, sink);

        for i in 0..5 {
            batcher.push(OutEvent::Frame {
                session_id: "s1".into(),
                frame: json!({ "type": "message_update", "seq": i }),
            });
        }
        for i in 0..4 {
            batcher.push(OutEvent::Frame {
                session_id: "s1".into(),
                frame: json!({
                    "type": "tool_execution_update",
                    "toolCallId": "tc1",
                    "toolName": "read",
                    "seq": i,
                    "partialResult": { "details": { "displayContent": "bloated" } }
                }),
            });
        }

        assert!(log.lock().is_empty());
        batcher.flush_all();

        let captured = log.lock();
        assert_eq!(captured.len(), 2);
        let OutEvent::Frame { frame: mu, .. } = &captured[0] else {
            panic!("expected frame");
        };
        assert_eq!(mu["type"], "message_update");
        assert_eq!(mu["seq"], 4);

        let OutEvent::Frame { frame: tu, .. } = &captured[1] else {
            panic!("expected frame");
        };
        assert_eq!(tu["type"], "tool_execution_update");
        assert_eq!(tu["seq"], 3);
        assert!(tu["partialResult"].get("details").is_none());
    }

    #[test]
    fn keeps_distinct_tool_call_ids_separate() {
        let (sink, log) = capture_sink();
        let batcher = FrameBatcher::new(DEFAULT_BATCH_WINDOW, sink);

        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "tool_execution_update", "toolCallId": "tc1", "seq": 1 }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "tool_execution_update", "toolCallId": "tc2", "seq": 1 }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "tool_execution_update", "toolCallId": "tc1", "seq": 2 }),
        });

        batcher.flush_all();
        let captured = log.lock();
        assert_eq!(captured.len(), 2);
        let OutEvent::Frame { frame: f0, .. } = &captured[0] else {
            panic!("expected frame");
        };
        let OutEvent::Frame { frame: f1, .. } = &captured[1] else {
            panic!("expected frame");
        };
        assert_eq!(f0["toolCallId"], "tc1");
        assert_eq!(f0["seq"], 2);
        assert_eq!(f1["toolCallId"], "tc2");
        assert_eq!(f1["seq"], 1);
    }

    #[test]
    fn barriers_flush_pending_session_frames_in_order_before_barrier() {
        let (sink, log) = capture_sink();
        let batcher = FrameBatcher::new(DEFAULT_BATCH_WINDOW, sink);

        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "message_update", "seq": 1 }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "tool_execution_update", "toolCallId": "tc1", "seq": 1 }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "message_end" }),
        });

        {
            let captured = log.lock();
            assert_eq!(
                frame_types(&captured),
                vec![
                    ("s1", "message_update"),
                    ("s1", "tool_execution_update"),
                    ("s1", "message_end"),
                ]
            );
        }

        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "tool_execution_update", "toolCallId": "tc2", "seq": 1 }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "tool_execution_end", "toolCallId": "tc2" }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "message_update", "seq": 2 }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "agent_end" }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "message_update", "seq": 3 }),
        });
        batcher.push(OutEvent::Process {
            session_id: "s1".into(),
            running: false,
            exit_code: Some(0),
        });

        let captured = log.lock();
        assert_eq!(
            frame_types(&captured),
            vec![
                ("s1", "message_update"),
                ("s1", "tool_execution_update"),
                ("s1", "message_end"),
                ("s1", "tool_execution_update"),
                ("s1", "tool_execution_end"),
                ("s1", "message_update"),
                ("s1", "agent_end"),
                ("s1", "message_update"),
                ("s1", "process"),
            ]
        );
    }

    #[test]
    fn cross_session_frames_do_not_overwrite_or_drain_each_other() {
        let (sink, log) = capture_sink();
        let batcher = FrameBatcher::new(DEFAULT_BATCH_WINDOW, sink);

        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "message_update", "text": "s1" }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s2".into(),
            frame: json!({ "type": "message_update", "text": "s2-a" }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s2".into(),
            frame: json!({ "type": "message_update", "text": "s2-b" }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "message_end" }),
        });

        {
            let captured = log.lock();
            assert_eq!(
                frame_types(&captured),
                vec![("s1", "message_update"), ("s1", "message_end")]
            );
        }

        batcher.flush_all();
        let captured = log.lock();
        assert_eq!(captured.len(), 3);
        let OutEvent::Frame { session_id, frame } = &captured[2] else {
            panic!("expected s2 frame");
        };
        assert_eq!(session_id, "s2");
        assert_eq!(frame["text"], "s2-b");
    }

    #[tokio::test]
    async fn tokio_timer_flushes_coalesced_burst_after_window() {
        let (sink, log) = capture_sink();
        let batcher = FrameBatcher::new(Duration::from_millis(15), sink);

        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "message_update", "seq": 1 }),
        });
        batcher.push(OutEvent::Frame {
            session_id: "s1".into(),
            frame: json!({ "type": "message_update", "seq": 2 }),
        });
        assert!(log.lock().is_empty());

        tokio::time::sleep(Duration::from_millis(50)).await;
        let captured = log.lock();
        assert_eq!(captured.len(), 1);
        let OutEvent::Frame { frame, .. } = &captured[0] else {
            panic!("expected frame");
        };
        assert_eq!(frame["seq"], 2);
    }
}

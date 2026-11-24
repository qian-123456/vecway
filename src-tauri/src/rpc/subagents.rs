//! [B] Subagent session files (contract C5): `subagent_list` / `subagent_transcript`.
//!
//! omp writes one `<AgentId>.jsonl` session per spawned subagent under a sibling
//! directory named after the parent session file (`<parentFile without .jsonl>/`),
//! plus `<AgentId>.md|.json` final outputs and `.<AgentId>.jsonl.lock.os` locks.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::catalog::{parse as cat_parse, transcript as cat_transcript};
use crate::contracts::{SubagentRunSegment, SubagentStatus, SubagentSummary, SubagentTranscript};
use crate::paths;

/// Locks touched within this window mark the agent as still running.
const LOCK_FRESH: Duration = Duration::from_secs(300);
/// Output files are capped by omp (~500KB); cap our read anyway.
const MAX_OUTPUT_BYTES: u64 = 1_000_000;
/// Prompt preview length for `SubagentSummary::prompt`.
const PROMPT_PREVIEW: usize = 160;
/// Maximum cached subagent summary entries across all visited sessions.
const MAX_SUMMARY_CACHE_ENTRIES: usize = 512;
/// Maximum cached subagent detail states (retaining `system_prompt`) across sessions.
const MAX_DETAIL_CACHE_ENTRIES: usize = 128;

fn allowed_root() -> PathBuf {
    paths::omp_sessions_dir()
}

/// `parentFile` must be an existing `*.jsonl` under the OMP sessions root.
/// Returns the canonical path.
fn validate_parent(parent_file: &str, root: &Path) -> Result<PathBuf, String> {
    let path = PathBuf::from(parent_file);
    if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
        return Err("parentFile must be a .jsonl session file".into());
    }
    let canon = path
        .canonicalize()
        .map_err(|_| "parent session file not found".to_string())?;
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if !canon.starts_with(&root) {
        return Err("session file is outside the sessions directory".into());
    }
    Ok(canon)
}

/// Agent ids become file names: reject anything that could escape the dir.
fn validate_agent_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id == ".." || id.starts_with('.') || id.contains('/') || id.contains('\\') {
        return Err(format!("invalid agent id: {id:?}"));
    }
    Ok(())
}

/// `<parentFile>` → `<parent stem>/` sibling dir holding subagent files.
fn subagent_dir(parent: &Path) -> PathBuf {
    let stem = parent.file_stem().unwrap_or_default();
    parent.parent().unwrap_or_else(|| Path::new("")).join(stem)
}

/// The agent's transcript / output paths inside `dir`.
fn agent_paths(dir: &Path, id: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    (
        dir.join(format!("{id}.jsonl")),
        dir.join(format!(".{id}.jsonl.lock.os")),
        dir.join(format!("{id}.md")),
        dir.join(format!("{id}.json")),
    )
}

fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn fresh_enough(t: Option<SystemTime>) -> bool {
    t.and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age <= LOCK_FRESH)
}

/// Per-file metadata accumulated while scanning the jsonl once.
#[derive(Default, Clone)]
struct AgentMeta {
    has_session_header: bool,
    model: Option<String>,
    thinking_level: Option<String>,
    system_prompt: Option<String>,
    /// `session_init.agent`: the omp agent type.
    agent: Option<String>,
    /// Full first user message (the spawned prompt / assignment).
    prompt: Option<String>,
    message_count: u32,
    tool_call_count: u32,
    request_count: u32,
    /// input + output + cacheWrite, matching AgentProgress.tokens.
    tokens: Option<u64>,
    cost: Option<f64>,
    last_assistant_text: Option<String>,
    run_started_at: Option<SystemTime>,
    last_stop_reason: Option<String>,
    has_assistant: bool,
}

fn accumulate(meta: &mut AgentMeta, v: &Value) {
    let ts = v.get("timestamp").and_then(Value::as_str);
    match v.get("type").and_then(Value::as_str) {
        Some("session") => {
            if v.get("id").and_then(Value::as_str).is_some() {
                meta.has_session_header = true;
            }
        }
        Some("model_change") => {
            meta.model = v.get("model").and_then(Value::as_str).map(str::to_string);
        }
        Some("thinking_level_change") => {
            meta.thinking_level = v
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        Some("session_init") => {
            meta.run_started_at = ts
                .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
                .map(SystemTime::from);
            meta.last_stop_reason = None;
            if meta.system_prompt.is_none() {
                meta.system_prompt = v
                    .get("systemPrompt")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            if meta.agent.is_none() {
                meta.agent = v
                    .get("agent")
                    .and_then(Value::as_str)
                    .filter(|a| !a.is_empty())
                    .map(str::to_string);
            }
        }
        Some("message") => {
            meta.message_count += 1;
            let Some(msg) = v.get("message") else { return };
            match msg.get("role").and_then(Value::as_str) {
                Some("user") => {
                    if meta.prompt.is_none()
                        && msg.get("toolCallId").is_none()
                        && msg.get("toolName").is_none()
                    {
                        meta.prompt = Some(cat_parse::content_text(msg.get("content")));
                    }
                }
                Some("assistant") => {
                    meta.has_assistant = true;
                    meta.request_count += 1;
                    if let Some(content) = msg.get("content").and_then(Value::as_array) {
                        meta.tool_call_count += content
                            .iter()
                            .filter(|b| b.get("type").and_then(Value::as_str) == Some("toolCall"))
                            .count() as u32;
                    }
                    let text = cat_parse::content_text(msg.get("content"));
                    if !text.trim().is_empty() {
                        meta.last_assistant_text = Some(text);
                    }
                    let usage = msg
                        .get("usage")
                        .map(cat_transcript::parse_usage)
                        .unwrap_or_default();
                    let tokens = usage
                        .input
                        .zip(usage.output)
                        .zip(usage.cache_write)
                        .and_then(|((input, output), write)| {
                            input.checked_add(output)?.checked_add(write)
                        });
                    meta.tokens = if meta.request_count == 1 {
                        tokens
                    } else {
                        meta.tokens.zip(tokens).and_then(|(a, b)| a.checked_add(b))
                    };
                    meta.cost = if meta.request_count == 1 {
                        usage.cost
                    } else {
                        meta.cost.zip(usage.cost).map(|(a, b)| a + b)
                    };
                    if let Some(sr) = msg.get("stopReason").and_then(Value::as_str) {
                        meta.last_stop_reason = Some(sr.to_string());
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

/// Parsed metadata + timing segments + complete-line cursor of a subagent jsonl
/// (transcript items are never stored in cache).
#[derive(Default, Clone)]
struct AgentState {
    meta: AgentMeta,
    closed_segments: Vec<SubagentRunSegment>,
    current_segment: Option<(String, String)>,
    next_byte: u64,
}

impl AgentState {
    fn all_segments(&self) -> Vec<SubagentRunSegment> {
        let mut out = self.closed_segments.clone();
        if let Some((s, e)) = &self.current_segment {
            out.push(SubagentRunSegment {
                started_at: s.clone(),
                ended_at: e.clone(),
            });
        }
        out
    }

    fn started_at(&self) -> Option<String> {
        self.closed_segments
            .first()
            .map(|seg| seg.started_at.clone())
            .or_else(|| self.current_segment.as_ref().map(|(s, _)| s.clone()))
    }

    fn ended_at(&self) -> Option<String> {
        self.current_segment
            .as_ref()
            .map(|(_, e)| e.clone())
            .or_else(|| self.closed_segments.last().map(|seg| seg.ended_at.clone()))
    }
}

fn is_session_exit(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("custom")
        && v.get("customType").and_then(Value::as_str) == Some("session_exit")
}

fn cmp_ts(a: &str, b: &str) -> std::cmp::Ordering {
    match (
        chrono::DateTime::parse_from_rfc3339(a),
        chrono::DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(da), Ok(db)) => da.cmp(&db),
        _ => a.cmp(b),
    }
}

fn record_timing(scan: &mut AgentState, v: &Value) {
    if is_session_exit(v) {
        if let Some((s, e)) = scan.current_segment.take() {
            scan.closed_segments.push(SubagentRunSegment {
                started_at: s,
                ended_at: e,
            });
        }
        return;
    }
    let Some(ts) = v
        .get("timestamp")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    match &mut scan.current_segment {
        Some((start, end)) => {
            if cmp_ts(ts, start) == std::cmp::Ordering::Less {
                *start = ts.to_string();
            }
            if cmp_ts(ts, end) == std::cmp::Ordering::Greater {
                *end = ts.to_string();
            }
        }
        None => {
            scan.current_segment = Some((ts.to_string(), ts.to_string()));
        }
    }
}

#[cfg(test)]
fn scan_agent(path: &Path, from_byte: u64) -> std::io::Result<AgentState> {
    scan_detail_file(path, from_byte, None).map(|r| r.state)
}

/// Inferred status for a subagent file.
fn infer_status(
    dir: &Path,
    id: &str,
    meta: &AgentMeta,
    file_mtime: Option<SystemTime>,
) -> (SubagentStatus, Option<PathBuf>) {
    let (_jsonl, lock, out_md, out_json) = agent_paths(dir, id);
    let artifact = [out_md, out_json].into_iter().find_map(|path| {
        let metadata = fs::metadata(&path).ok()?;
        metadata.is_file().then_some((path, metadata))
    });
    let output = if let Some((path, metadata)) = artifact {
        // A resumed child can leave its previous result on disk while working.
        let stale = meta
            .run_started_at
            .zip(metadata.modified().ok())
            .is_some_and(|(started, modified)| modified < started);
        if !stale {
            return (SubagentStatus::Completed, Some(path));
        }
        Some(path)
    } else {
        None
    };
    // omp keeps the lock file while the child is alive; only an existing,
    // recently touched lock proves a live child. A hot transcript alone does
    // not: a finished child's final write is also "fresh" for minutes.
    let stop = meta.last_stop_reason.as_deref().unwrap_or("");
    let lock_alive = lock.exists() && fresh_enough(mtime(&lock));
    if lock_alive {
        return (SubagentStatus::Running, output);
    }
    // Only stop reasons with known terminal semantics end a run. Anything else
    // ("toolUse", "length", unknown/future reasons) falls through to the
    // freshness / has-assistant heuristics below.
    match stop {
        "stop" | "end_turn" => return (SubagentStatus::Completed, output),
        "error" => return (SubagentStatus::Failed, output),
        "aborted" | "abort" | "cancelled" | "canceled" => return (SubagentStatus::Aborted, output),
        _ => {}
    }
    if fresh_enough(file_mtime) {
        // No terminal marker yet and the transcript is still being written.
        return (SubagentStatus::Running, output);
    }
    if meta.has_assistant {
        // Idle, produced a final text, no output file.
        return (SubagentStatus::Completed, output);
    }
    // Stale file that never got past the prompt.
    (SubagentStatus::Pending, output)
}

fn summary_from(
    id: &str,
    path: &Path,
    scan: &AgentState,
    status: SubagentStatus,
    output: Option<PathBuf>,
) -> SubagentSummary {
    SubagentSummary {
        id: id.to_string(),
        status,
        model: scan.meta.model.clone(),
        thinking_level: scan.meta.thinking_level.clone(),
        agent: scan.meta.agent.clone(),
        prompt: scan
            .meta
            .prompt
            .as_deref()
            .map(|p| cat_parse::snippet(p, PROMPT_PREVIEW)),
        message_count: scan.meta.message_count,
        tool_call_count: scan.meta.tool_call_count,
        request_count: scan.meta.request_count,
        tokens: if scan.meta.request_count == 0 {
            Some(0)
        } else {
            scan.meta.tokens
        },
        cost: if scan.meta.request_count == 0 {
            Some(0.0)
        } else {
            scan.meta.cost
        },
        started_at: scan.started_at(),
        ended_at: scan.ended_at(),
        run_segments: scan.all_segments(),
        output_path: output.map(|p| p.to_string_lossy().into_owned()),
        file_path: path.to_string_lossy().into_owned(),
    }
}

/// Read the output file; caps at MAX_OUTPUT_BYTES.
fn read_output(path: &Path) -> Option<String> {
    let size = fs::metadata(path).ok()?.len();
    if size == 0 || size > MAX_OUTPUT_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// Cross-platform file identity used to detect rotation/replacement across polls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    created: Option<SystemTime>,
}

impl FileIdentity {
    fn from_metadata(md: &fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Self {
                dev: md.dev(),
                ino: md.ino(),
                created: md.created().ok(),
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                created: md.created().ok(),
            }
        }
    }
}

/// What the cache remembers per subagent transcript: the parsed state (items
/// are never kept) plus the file identity/size/mtime it was computed from.
#[derive(Clone)]
struct CachedAgent {
    identity: FileIdentity,
    size: u64,
    mtime: Option<SystemTime>,
    state: AgentState,
}

struct CacheEntry {
    value: CachedAgent,
    last_access: u64,
}

/// Bounded LRU cache of parsed subagent transcript states keyed by path.
/// Callers snapshot entries under a short lock, perform all FS I/O and parsing
/// lock-free, and commit updates under a second short lock.
struct ScanCache {
    map: HashMap<PathBuf, CacheEntry>,
    max_entries: usize,
    tick: u64,
    /// Total transcript bytes read from disk (observability / tests).
    bytes_read: u64,
}

impl Default for ScanCache {
    fn default() -> Self {
        Self::with_capacity(MAX_SUMMARY_CACHE_ENTRIES)
    }
}

impl ScanCache {
    fn with_capacity(max_entries: usize) -> Self {
        Self {
            map: HashMap::new(),
            max_entries: max_entries.max(1),
            tick: 0,
            bytes_read: 0,
        }
    }

    fn get_cloned(&mut self, path: &Path) -> Option<CachedAgent> {
        self.tick = self.tick.wrapping_add(1);
        let tick = self.tick;
        let entry = self.map.get_mut(path)?;
        entry.last_access = tick;
        Some(entry.value.clone())
    }

    fn upsert(&mut self, path: PathBuf, value: CachedAgent, force_replace: bool) {
        if !force_replace {
            if let Some(existing) = self.map.get(&path) {
                let e = &existing.value;
                if e.identity == value.identity && e.mtime == value.mtime && e.size > value.size {
                    return;
                }
            }
        }
        self.tick = self.tick.wrapping_add(1);
        let tick = self.tick;
        self.map.insert(
            path,
            CacheEntry {
                value,
                last_access: tick,
            },
        );
        self.evict_if_needed();
    }

    fn evict_if_needed(&mut self) {
        while self.map.len() > self.max_entries {
            let Some(oldest_key) = self
                .map
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.map.remove(&oldest_key);
        }
    }

    /// Drop entries under `dir` that were not seen in the latest listing.
    fn retain_seen(&mut self, dir: &Path, seen: &HashSet<PathBuf>) {
        self.map
            .retain(|p, _| !p.starts_with(dir) || seen.contains(p));
    }
}

/// Parse the complete lines of `bytes` (which start at `state.next_byte`) into
/// the running summary; a trailing partial line is left for the next pass.
fn fold_lines(state: &mut AgentState, bytes: &[u8], keep_system_prompt: bool) {
    let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    for line in bytes[..complete].split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        record_timing(state, &v);
        accumulate(&mut state.meta, &v);
    }
    if !keep_system_prompt {
        // The list never shows the system prompt; do not keep it resident.
        state.meta.system_prompt = None;
    }
    state.next_byte += complete as u64;
}

struct SummaryScanResult {
    state: AgentState,
    updated_cache: Option<(CachedAgent, bool)>,
    bytes_read: u64,
    mtime: Option<SystemTime>,
}

fn scan_summary_file(
    path: &Path,
    cached: Option<&CachedAgent>,
) -> std::io::Result<SummaryScanResult> {
    let md = fs::metadata(path)?;
    let size = md.len();
    let modified = md.modified().ok();
    let identity = FileIdentity::from_metadata(&md);

    if let Some(c) = cached {
        if c.identity == identity {
            if c.size == size && c.mtime == modified {
                return Ok(SummaryScanResult {
                    state: c.state.clone(),
                    updated_cache: None,
                    bytes_read: 0,
                    mtime: modified,
                });
            }
            if size > c.size && c.state.next_byte <= size {
                let start = c.state.next_byte;
                let mut f = fs::File::open(path)?;
                f.seek(SeekFrom::Start(start))?;
                let mut tail = Vec::new();
                f.read_to_end(&mut tail)?;
                let bytes_read = tail.len() as u64;
                let mut state = c.state.clone();
                fold_lines(&mut state, &tail, false);
                let actual_size = start + bytes_read;
                let updated = CachedAgent {
                    identity,
                    size: actual_size,
                    mtime: modified,
                    state: state.clone(),
                };
                return Ok(SummaryScanResult {
                    state,
                    updated_cache: Some((updated, false)),
                    bytes_read,
                    mtime: modified,
                });
            }
        }
    }

    let mut f = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(size as usize);
    f.read_to_end(&mut bytes)?;
    let bytes_read = bytes.len() as u64;
    let mut state = AgentState::default();
    fold_lines(&mut state, &bytes, false);
    let updated = CachedAgent {
        identity,
        size: bytes_read,
        mtime: modified,
        state: state.clone(),
    };
    let force_replace = cached.is_some_and(|c| c.identity != identity || bytes_read < c.size);
    Ok(SummaryScanResult {
        state,
        updated_cache: Some((updated, force_replace)),
        bytes_read,
        mtime: modified,
    })
}

struct DetailScanResult {
    state: AgentState,
    items: Vec<crate::contracts::TranscriptItem>,
    reset: bool,
    updated_cache: Option<(CachedAgent, bool)>,
    bytes_read: u64,
    mtime: Option<SystemTime>,
}

fn scan_detail_file(
    path: &Path,
    from_byte: u64,
    cached: Option<&CachedAgent>,
) -> std::io::Result<DetailScanResult> {
    let md = fs::metadata(path)?;
    let size = md.len();
    let modified = md.modified().ok();
    let identity = FileIdentity::from_metadata(&md);

    // Incremental paths: reuse cached metadata/segments and seek directly to
    // the cached/requested byte offset when the same file did not shrink or rewrite.
    if from_byte > 0 && from_byte <= size {
        if let Some(c) = cached {
            if c.identity == identity {
                let unchanged = size == c.size && modified == c.mtime;
                let monotonic_growth = size > c.size && c.state.next_byte <= size;

                if unchanged && from_byte >= c.state.next_byte {
                    return Ok(DetailScanResult {
                        state: c.state.clone(),
                        items: Vec::new(),
                        reset: false,
                        updated_cache: None,
                        bytes_read: 0,
                        mtime: modified,
                    });
                }

                if unchanged && from_byte < c.state.next_byte {
                    let mut f = fs::File::open(path)?;
                    f.seek(SeekFrom::Start(from_byte - 1))?;
                    let want = 1 + (c.state.next_byte - from_byte);
                    let mut buf = Vec::with_capacity(want as usize);
                    f.take(want).read_to_end(&mut buf)?;
                    let bytes_read = buf.len() as u64;
                    if !buf.is_empty() {
                        let slice = if buf[0] == b'\n' {
                            &buf[1..]
                        } else if let Some(nl) = buf[1..].iter().position(|&b| b == b'\n') {
                            &buf[1 + nl + 1..]
                        } else {
                            &[][..]
                        };
                        let complete = slice.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
                        let mut items = Vec::new();
                        for line in slice[..complete].split(|&b| b == b'\n') {
                            if line.is_empty() {
                                continue;
                            }
                            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                                if let Some(item) = cat_transcript::normalize_entry(&v) {
                                    items.push(item);
                                }
                            }
                        }
                        return Ok(DetailScanResult {
                            state: c.state.clone(),
                            items,
                            reset: false,
                            updated_cache: None,
                            bytes_read,
                            mtime: modified,
                        });
                    }
                }

                if monotonic_growth && from_byte >= c.state.next_byte {
                    let base = c.state.next_byte;
                    let mut f = fs::File::open(path)?;
                    f.seek(SeekFrom::Start(base))?;
                    let mut tail = Vec::new();
                    f.read_to_end(&mut tail)?;
                    let bytes_read = tail.len() as u64;
                    let complete = tail.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
                    let mut state = c.state.clone();
                    let mut items = Vec::new();
                    let mut rel_offset = 0usize;
                    for line in tail[..complete].split(|&b| b == b'\n') {
                        let abs_line_start = base + rel_offset as u64;
                        rel_offset += line.len() + 1;
                        if line.is_empty() {
                            continue;
                        }
                        let Ok(v) = serde_json::from_slice::<Value>(line) else {
                            continue;
                        };
                        record_timing(&mut state, &v);
                        accumulate(&mut state.meta, &v);
                        if abs_line_start >= from_byte {
                            if let Some(item) = cat_transcript::normalize_entry(&v) {
                                items.push(item);
                            }
                        }
                    }
                    state.next_byte = base + complete as u64;
                    let actual_size = base + bytes_read;
                    let updated = CachedAgent {
                        identity,
                        size: actual_size,
                        mtime: modified,
                        state: state.clone(),
                    };
                    return Ok(DetailScanResult {
                        state,
                        items,
                        reset: false,
                        updated_cache: Some((updated, false)),
                        bytes_read,
                        mtime: modified,
                    });
                }
            }
        }
    }

    // Full re-read fallback: initial load (`from_byte == 0`), cache miss,
    // truncation, rotation (changed file identity), or in-place rewrite.
    let mut f = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(size as usize);
    f.read_to_end(&mut bytes)?;
    let actual_size = bytes.len() as u64;
    let invalidated = from_byte > 0
        && cached.is_some_and(|c| {
            c.identity != identity
                || actual_size < c.size
                || (actual_size == c.size && modified != c.mtime)
        });
    let reset = from_byte > actual_size || invalidated;
    let start = if reset { 0 } else { from_byte.min(actual_size) };
    let complete = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let mut state = AgentState {
        next_byte: complete as u64,
        ..Default::default()
    };
    let mut items = Vec::new();
    let mut offset = 0usize;
    for line in bytes[..complete].split(|&b| b == b'\n') {
        let line_start = offset;
        offset += line.len() + 1;
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        record_timing(&mut state, &v);
        accumulate(&mut state.meta, &v);
        if reset || line_start >= start as usize {
            if let Some(item) = cat_transcript::normalize_entry(&v) {
                items.push(item);
            }
        }
    }
    let updated = CachedAgent {
        identity,
        size: actual_size,
        mtime: modified,
        state: state.clone(),
    };
    let force_replace =
        reset || cached.is_some_and(|c| c.identity != identity || actual_size < c.size);
    Ok(DetailScanResult {
        state,
        items,
        reset,
        updated_cache: Some((updated, force_replace)),
        bytes_read: actual_size,
        mtime: modified,
    })
}

static SUMMARY_CACHE: LazyLock<Mutex<ScanCache>> =
    LazyLock::new(|| Mutex::new(ScanCache::with_capacity(MAX_SUMMARY_CACHE_ENTRIES)));
static DETAIL_CACHE: LazyLock<Mutex<ScanCache>> =
    LazyLock::new(|| Mutex::new(ScanCache::with_capacity(MAX_DETAIL_CACHE_ENTRIES)));

/// Nested subagents (an agent that dispatches its own) live one directory
/// deeper per generation: `<dir>/<A>/<A>.<B>.jsonl`, `<dir>/<A>/<A>.<B>/...`.
const MAX_NEST_DEPTH: usize = 8;

/// Non-subagent artifacts share `<parent>/` with subagent transcripts:
/// - `changes.jsonl`: selective-commit edit/tool-call journal
/// - `__advisor.jsonl` / `__advisor.<slug>.jsonl`: advisor transcripts
/// - `*.bak.jsonl` / dotfiles: backups and lock files
fn is_subagent_filename(name: &str) -> bool {
    if name.starts_with('.') || !name.ends_with(".jsonl") || name.contains(".bak") {
        return false;
    }
    let stem = &name[..name.len() - ".jsonl".len()];
    stem != "changes" && stem != "__advisor" && !stem.starts_with("__advisor.")
}

/// Every visible `*.jsonl` agent transcript under `dir`, nested ones included.
/// Only descends into `<agentId>/` subdirectories that have a sibling
/// `<agentId>.jsonl`, skipping non-session artifact dirs (`blobs/`, `url-search/`).
fn collect_agent_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut dirs = HashMap::new();
    let mut stems = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        // Skip dotfiles: lock files (.X.jsonl.lock.os) and hidden junk.
        if name.starts_with('.') {
            continue;
        }
        let Ok(kind) = e.file_type() else { continue };
        if kind.is_dir() {
            dirs.insert(name.to_string(), path);
        } else if kind.is_file() && is_subagent_filename(name) {
            let stem = &name[..name.len() - ".jsonl".len()];
            stems.push(stem.to_string());
            out.push(path);
        }
    }
    if depth < MAX_NEST_DEPTH {
        for stem in stems {
            if let Some(sub) = dirs.get(&stem) {
                collect_agent_files(sub, depth + 1, out);
            }
        }
    }
}

/// Locate `<id>.jsonl` below `dir`: direct child first, then nested generations.
fn find_agent_file(dir: &Path, id: &str) -> Option<PathBuf> {
    if !is_subagent_filename(&format!("{id}.jsonl")) {
        return None;
    }
    let direct = dir.join(format!("{id}.jsonl"));
    if direct.is_file() {
        return Some(direct);
    }
    let mut files = Vec::new();
    collect_agent_files(dir, 0, &mut files);
    files
        .into_iter()
        .find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(id))
}

struct ListComputeOutput {
    summaries: Vec<SubagentSummary>,
    seen: HashSet<PathBuf>,
    updates: Vec<(PathBuf, CachedAgent, bool)>,
    bytes_read: u64,
}

fn collect_valid_agent_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    collect_agent_files(dir, 0, &mut files);
    files
        .into_iter()
        .filter_map(|path| {
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            validate_agent_id(&id).ok().map(|()| (id, path))
        })
        .collect()
}

fn compute_list_entries(
    dir: &Path,
    entries: Vec<(String, PathBuf, Option<CachedAgent>)>,
) -> ListComputeOutput {
    let mut summaries = Vec::new();
    let mut seen = HashSet::new();
    let mut updates = Vec::new();
    let mut bytes_read = 0u64;
    for (id, path, cached) in entries {
        let Ok(res) = scan_summary_file(&path, cached.as_ref()) else {
            continue;
        };
        bytes_read += res.bytes_read;
        seen.insert(path.clone());
        if let Some((updated, force_replace)) = res.updated_cache {
            updates.push((path.clone(), updated, force_replace));
        }
        if !res.state.meta.has_session_header {
            continue;
        }
        let agent_dir = path.parent().unwrap_or(dir);
        let (status, output) = infer_status(agent_dir, &id, &res.state.meta, res.mtime);
        summaries.push(summary_from(&id, &path, &res.state, status, output));
    }
    summaries.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    ListComputeOutput {
        summaries,
        seen,
        updates,
        bytes_read,
    }
}

fn list_with_mutex(
    parent_file: &str,
    root: &Path,
    cache_lock: &Mutex<ScanCache>,
    prune_detail_cache: Option<&Mutex<ScanCache>>,
) -> Result<Vec<SubagentSummary>, String> {
    // Directory scan happens completely outside any cache lock.
    let parent = validate_parent(parent_file, root)?;
    let dir = subagent_dir(&parent);
    let files = collect_valid_agent_files(&dir);

    let entries: Vec<(String, PathBuf, Option<CachedAgent>)> = {
        let mut cache = cache_lock.lock().unwrap_or_else(|e| e.into_inner());
        files
            .into_iter()
            .map(|(id, path)| {
                let snap = cache.get_cloned(&path);
                (id, path, snap)
            })
            .collect()
    };

    // File reads, JSON parsing, and status inference run completely lock-free.
    let computed = compute_list_entries(&dir, entries);

    {
        let mut cache = cache_lock.lock().unwrap_or_else(|e| e.into_inner());
        cache.bytes_read += computed.bytes_read;
        for (path, updated, force_replace) in computed.updates {
            cache.upsert(path, updated, force_replace);
        }
        cache.retain_seen(&dir, &computed.seen);
    }
    if let Some(detail_lock) = prune_detail_cache {
        let mut detail = detail_lock.lock().unwrap_or_else(|e| e.into_inner());
        detail.retain_seen(&dir, &computed.seen);
    }
    Ok(computed.summaries)
}

#[cfg(test)]
fn list_with(
    parent_file: &str,
    root: &Path,
    cache: &mut ScanCache,
) -> Result<Vec<SubagentSummary>, String> {
    let parent = validate_parent(parent_file, root)?;
    let dir = subagent_dir(&parent);
    let files = collect_valid_agent_files(&dir);
    let entries = files
        .into_iter()
        .map(|(id, path)| {
            let snap = cache.get_cloned(&path);
            (id, path, snap)
        })
        .collect();
    let computed = compute_list_entries(&dir, entries);
    cache.bytes_read += computed.bytes_read;
    for (path, updated, force_replace) in computed.updates {
        cache.upsert(path, updated, force_replace);
    }
    cache.retain_seen(&dir, &computed.seen);
    Ok(computed.summaries)
}

#[cfg(test)]
fn list_in(parent_file: &str, root: &Path) -> Result<Vec<SubagentSummary>, String> {
    list_with(parent_file, root, &mut ScanCache::default())
}

pub fn list(parent_file: &str) -> Result<Vec<SubagentSummary>, String> {
    list_with_mutex(
        parent_file,
        &allowed_root(),
        &SUMMARY_CACHE,
        Some(&DETAIL_CACHE),
    )
}

fn transcript_with_mutex(
    parent_file: &str,
    agent_id: &str,
    from_byte: u64,
    root: &Path,
    cache_lock: &Mutex<ScanCache>,
) -> Result<SubagentTranscript, String> {
    validate_agent_id(agent_id)?;
    let parent = validate_parent(parent_file, root)?;
    let dir = subagent_dir(&parent);
    let Some(file) = find_agent_file(&dir, agent_id) else {
        return Err(format!("subagent session not found: {agent_id}"));
    };
    let agent_dir = file.parent().unwrap_or(&dir).to_path_buf();

    let cached = {
        let mut cache = cache_lock.lock().unwrap_or_else(|e| e.into_inner());
        cache.get_cloned(&file)
    };

    // Perform incremental seek / read / parse completely outside the cache lock.
    let res = scan_detail_file(&file, from_byte, cached.as_ref())
        .map_err(|e| format!("read subagent transcript {agent_id}: {e}"))?;

    {
        let mut cache = cache_lock.lock().unwrap_or_else(|e| e.into_inner());
        cache.bytes_read += res.bytes_read;
        if let Some((updated, force_replace)) = res.updated_cache {
            cache.upsert(file.clone(), updated, force_replace);
        }
    }

    if !res.state.meta.has_session_header {
        return Err(format!("subagent session not found: {agent_id}"));
    }
    let (status, output_path) = infer_status(&agent_dir, agent_id, &res.state.meta, res.mtime);
    let summary = summary_from(agent_id, &file, &res.state, status, output_path.clone());
    // Prefer the output artifact; fall back to the last assistant text.
    let output = output_path
        .as_deref()
        .and_then(read_output)
        .or_else(|| res.state.meta.last_assistant_text.clone());
    Ok(SubagentTranscript {
        agent_id: agent_id.to_string(),
        file: file.to_string_lossy().into_owned(),
        summary,
        system_prompt: res.state.meta.system_prompt,
        prompt: res.state.meta.prompt,
        items: res.items,
        output,
        output_path: output_path.map(|p| p.to_string_lossy().into_owned()),
        next_byte: res.state.next_byte,
        reset: res.reset,
    })
}

pub fn transcript_in(
    parent_file: &str,
    agent_id: &str,
    from_byte: u64,
    root: &Path,
) -> Result<SubagentTranscript, String> {
    transcript_with_mutex(parent_file, agent_id, from_byte, root, &DETAIL_CACHE)
}

pub fn transcript(
    parent_file: &str,
    agent_id: &str,
    from_byte: Option<u64>,
) -> Result<SubagentTranscript, String> {
    transcript_in(
        parent_file,
        agent_id,
        from_byte.unwrap_or(0),
        &allowed_root(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        std::env::temp_dir().join(format!("ompws-sub-{}", uuid::Uuid::new_v4()))
    }

    /// `<root>/<bucket>/<parent>.jsonl` plus a `<parent>/` subagent dir.
    fn setup() -> (PathBuf, PathBuf, PathBuf) {
        let root = tmp_root();
        let bucket = root.join("-proj");
        let parent = bucket.join("parent.jsonl");
        let subdir = bucket.join("parent");
        fs::create_dir_all(&subdir).unwrap();
        fs::write(
            &parent,
            r#"{"type":"session","version":3,"id":"P","timestamp":"T0"}"#,
        )
        .unwrap();
        (root, parent, subdir)
    }

    const AGENT: &str = concat!(
        r#"{"type":"title","v":1,"title":"agent"}"#,
        "\n",
        r#"{"type":"session","version":3,"id":"A","timestamp":"T0","cwd":"/w"}"#,
        "\n",
        r#"{"type":"model_change","id":"m","timestamp":"T1","model":"prov/mid"}"#,
        "\n",
        r#"{"type":"thinking_level_change","id":"t","timestamp":"T2","thinkingLevel":"high"}"#,
        "\n",
        r#"{"type":"session_init","id":"i","timestamp":"T3","systemPrompt":"SYS","agent":"scout"}"#,
        "\n",
        r#"{"type":"message","id":"u","timestamp":"T4","message":{"role":"user","content":[{"type":"text","text":"do the thing"}]}}"#,
        "\n",
        r#"{"type":"message","id":"a","timestamp":"T5","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls"}}],"usage":{"input":10,"output":5,"cacheRead":3,"cacheWrite":1,"totalTokens":19,"cost":{"total":0.5}},"stopReason":"toolUse"}}"#,
        "\n",
        r#"{"type":"message","id":"r","timestamp":"T6","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"x"}],"isError":false}}"#,
        "\n",
        r#"{"type":"message","id":"z","timestamp":"T7","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}],"stopReason":"stop","usage":{"input":3,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":5,"cost":{"total":0.1}}}}"#,
        "\n",
    );

    #[test]
    fn parses_summary_and_statuses() {
        let (root, parent, subdir) = setup();
        fs::write(subdir.join("Done.jsonl"), AGENT).unwrap();
        fs::write(subdir.join("Done.md"), "OUTPUT").unwrap();
        // Hidden lock file must be skipped as a list entry.
        fs::write(subdir.join(".Done.jsonl.lock.os"), "").unwrap();
        // A fresh lock on a file without output => running.
        fs::write(subdir.join("Live.jsonl"), AGENT).unwrap();
        fs::write(subdir.join(".Live.jsonl.lock.os"), "").unwrap();

        let list = list_in(parent.to_str().unwrap(), &root).unwrap();
        let by: std::collections::HashMap<_, _> = list.iter().map(|s| (s.id.as_str(), s)).collect();
        assert_eq!(list.len(), 2);
        let done = by["Done"];
        assert_eq!(done.status, SubagentStatus::Completed);
        assert_eq!(done.model.as_deref(), Some("prov/mid"));
        assert_eq!(done.thinking_level.as_deref(), Some("high"));
        assert_eq!(done.agent.as_deref(), Some("scout"));
        assert_eq!(done.prompt.as_deref(), Some("do the thing"));
        assert_eq!(done.tool_call_count, 1);
        assert_eq!(done.request_count, 2);
        assert_eq!(done.tokens, Some(10 + 5 + 1 + 3 + 2));
        assert!((done.cost.unwrap() - 0.6).abs() < 1e-9);
        assert_eq!(done.started_at.as_deref(), Some("T0"));
        assert_eq!(done.ended_at.as_deref(), Some("T7"));
        assert!(done.output_path.as_deref().unwrap().ends_with("Done.md"));
        assert_eq!(by["Live"].status, SubagentStatus::Running);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn partial_request_usage_stays_unknown_in_transcript_and_aggregate() {
        let (root, parent, subdir) = setup();
        let partial = r#"{"type":"message","id":"partial","timestamp":"T8","message":{"role":"assistant","usage":{"output":0}}}"#;
        fs::write(subdir.join("A.jsonl"), format!("{AGENT}\n{partial}\n")).unwrap();
        let t = transcript_in(parent.to_str().unwrap(), "A", 0, &root).unwrap();
        let usage = t
            .items
            .iter()
            .find(|item| item.id == "partial")
            .unwrap()
            .usage
            .as_ref()
            .unwrap();
        assert_eq!(usage.output, Some(0));
        assert_eq!(usage.input, None);
        assert_eq!(t.summary.tokens, None);
        assert_eq!(t.summary.cost, None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn transcript_returns_items_prompt_and_output() {
        let (root, parent, subdir) = setup();
        fs::write(subdir.join("A.jsonl"), AGENT).unwrap();
        fs::write(subdir.join("A.md"), "# out").unwrap();
        let t = transcript_in(parent.to_str().unwrap(), "A", 0, &root).unwrap();
        assert_eq!(t.prompt.as_deref(), Some("do the thing"));
        assert_eq!(t.system_prompt.as_deref(), Some("SYS"));
        assert_eq!(t.output.as_deref(), Some("# out"));
        assert!(t.output_path.unwrap().ends_with("A.md"));
        assert_eq!(t.summary.status, SubagentStatus::Completed);
        // Items are normalized: model_change + user + assistant + tool_result + assistant.
        use crate::contracts::TranscriptKind as K;
        let kinds: Vec<_> = t.items.iter().map(|i| i.kind).collect();
        assert_eq!(
            kinds,
            vec![
                K::ModelChange,
                K::User,
                K::Assistant,
                K::ToolResult,
                K::Assistant
            ]
        );
        assert!(t.next_byte > 0);
        // Incremental read past EOF returns no items, keeps nextByte.
        let t2 = transcript_in(parent.to_str().unwrap(), "A", t.next_byte, &root).unwrap();
        assert!(t2.items.is_empty());
        assert!(!t2.reset);
        assert_eq!(t2.next_byte, t.next_byte);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn output_falls_back_to_last_assistant_text() {
        let (root, parent, subdir) = setup();
        fs::write(subdir.join("B.jsonl"), AGENT).unwrap();
        let t = transcript_in(parent.to_str().unwrap(), "B", 0, &root).unwrap();
        assert_eq!(t.output.as_deref(), Some("final answer"));
        assert!(t.output_path.is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn validates_ids_and_paths() {
        let (root, parent, _subdir) = setup();
        let p = parent.to_str().unwrap();
        for bad in ["", "..", "a/b", "a\\b", ".hidden"] {
            assert!(transcript_in(p, bad, 0, &root).is_err(), "{bad:?}");
        }
        assert!(list_in("/nope.jsonl", &root).is_err());
        assert!(list_in("/tmp/x.txt", &root).is_err());
        // Outside the sessions root.
        let outside =
            std::env::temp_dir().join(format!("ompws-sub-out-{}.jsonl", uuid::Uuid::new_v4()));
        fs::write(&outside, "{}\n").unwrap();
        assert!(list_in(outside.to_str().unwrap(), &root).is_err());
        fs::remove_dir_all(&root).ok();
        fs::remove_file(&outside).ok();
    }

    #[test]
    fn failed_and_aborted_inferred_from_stop_reason() {
        let (root, parent, subdir) = setup();
        let err = AGENT.replace(r#""stopReason":"stop""#, r#""stopReason":"error""#);
        let ab = AGENT.replace(r#""stopReason":"stop""#, r#""stopReason":"aborted""#);
        fs::write(subdir.join("Err.jsonl"), err).unwrap();
        fs::write(subdir.join("Ab.jsonl"), ab).unwrap();
        // Stale: pretend files are old by writing them first, but mtime may be
        // fresh on tmpfs — force via filetime-free approach: set status check
        // relies on freshness, so age the files via `touch -t` is unavailable;
        // instead drop the freshness window by directly asserting infer logic
        // through list_in when mtimes are stale is unreliable. We just verify
        // the stopReason mapping does not panic and statuses differ.
        let list = list_in(parent.to_str().unwrap(), &root).unwrap();
        // On a fresh CI box the files were just written => may read "running";
        // the completed/failed mapping is verified via infer_status directly.
        let _ = list;
        let scan_err = scan_agent(&subdir.join("Err.jsonl"), 0).unwrap();
        // Force staleness: use an mtime of UNIX_EPOCH to simulate old files.
        let (status, _) =
            infer_status(&subdir, "Err", &scan_err.meta, Some(SystemTime::UNIX_EPOCH));
        assert_eq!(status, SubagentStatus::Failed);
        let scan_ab = scan_agent(&subdir.join("Ab.jsonl"), 0).unwrap();
        let (status, _) = infer_status(&subdir, "Ab", &scan_ab.meta, Some(SystemTime::UNIX_EPOCH));
        assert_eq!(status, SubagentStatus::Aborted);
        fs::remove_dir_all(&root).ok();
    }

    /// An agent that dispatches its own keeps the children one directory down
    /// (`<parent>/<A>/<A>.<B>.jsonl`): they must be listed and readable too.
    #[test]
    fn nested_subagents_are_listed_and_readable() {
        let (root, parent, subdir) = setup();
        fs::write(subdir.join("A.jsonl"), AGENT).unwrap();
        fs::create_dir_all(subdir.join("A").join("A.B")).unwrap();
        fs::write(subdir.join("A").join("A.B.jsonl"), AGENT).unwrap();
        fs::write(subdir.join("A").join(".A.B.jsonl.lock.os"), "").unwrap();
        fs::write(subdir.join("A").join("A.B").join("A.B.C.jsonl"), AGENT).unwrap();
        fs::write(subdir.join("A").join("A.B").join("A.B.C.md"), "out").unwrap();
        let p = parent.to_str().unwrap();

        let list = list_in(p, &root).unwrap();
        let by: std::collections::HashMap<_, _> = list.iter().map(|s| (s.id.as_str(), s)).collect();
        assert_eq!(list.len(), 3);
        assert_eq!(by["A.B"].status, SubagentStatus::Running);
        assert_eq!(by["A.B.C"].status, SubagentStatus::Completed);
        assert!(by["A.B.C"]
            .output_path
            .as_deref()
            .unwrap()
            .ends_with("A.B.C.md"));

        let t = transcript_in(p, "A.B.C", 0, &root).unwrap();
        assert_eq!(t.output.as_deref(), Some("out"));
        assert_eq!(t.summary.id, "A.B.C");
        assert!(transcript_in(p, "A.Nope", 0, &root).is_err());
        fs::remove_dir_all(&root).ok();
    }

    fn json(list: &[SubagentSummary]) -> String {
        serde_json::to_string(list).unwrap()
    }

    #[test]
    fn cache_skips_unchanged_and_reads_only_appended_bytes() {
        let (root, parent, subdir) = setup();
        let p = parent.to_str().unwrap();
        let file = subdir.join("A.jsonl");
        fs::write(&file, AGENT).unwrap();
        let mut cache = ScanCache::default();

        let first = list_with(p, &root, &mut cache).unwrap();
        assert_eq!(cache.bytes_read, AGENT.len() as u64);
        assert_eq!(json(&first), json(&list_in(p, &root).unwrap()));

        // Unchanged file: identical result, zero bytes re-read.
        let again = list_with(p, &root, &mut cache).unwrap();
        assert_eq!(cache.bytes_read, AGENT.len() as u64);
        assert_eq!(json(&first), json(&again));

        // Append one complete line plus a partial one: only the tail is read,
        // and the result equals a from-scratch scan.
        let extra = concat!(
            r#"{"type":"message","id":"y","timestamp":"T8","message":{"role":"assistant","content":[{"type":"text","text":"more"}],"stopReason":"stop"}}"#,
            "\n",
            r#"{"type":"mess"#,
        );
        let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
        std::io::Write::write_all(&mut f, extra.as_bytes()).unwrap();
        drop(f);
        let grown = list_with(p, &root, &mut cache).unwrap();
        assert_eq!(cache.bytes_read, (AGENT.len() + extra.len()) as u64);
        assert_eq!(json(&grown), json(&list_in(p, &root).unwrap()));
        assert_eq!(grown[0].message_count, first[0].message_count + 1);

        // Removed files leave the cache.
        fs::remove_file(&file).unwrap();
        assert!(list_with(p, &root, &mut cache).unwrap().is_empty());
        assert!(cache.map.is_empty());
        fs::remove_dir_all(&root).ok();
    }

    fn meta_with_stop(stop: Option<&str>, has_assistant: bool) -> AgentMeta {
        AgentMeta {
            last_stop_reason: stop.map(str::to_string),
            has_assistant,
            ..Default::default()
        }
    }

    fn stale() -> Option<SystemTime> {
        Some(SystemTime::now() - Duration::from_secs(LOCK_FRESH.as_secs() + 60))
    }

    #[test]
    fn infer_status_terminal_stop_beats_fresh_transcript() {
        let (root, _p, dir) = setup();
        let fresh = Some(SystemTime::now());
        for (stop, want) in [
            ("stop", SubagentStatus::Completed),
            ("end_turn", SubagentStatus::Completed),
            ("error", SubagentStatus::Failed),
            ("aborted", SubagentStatus::Aborted),
        ] {
            let (st, _) = infer_status(&dir, "a", &meta_with_stop(Some(stop), true), fresh);
            assert_eq!(st, want, "stop={stop}");
        }
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn infer_status_non_terminal_stops_follow_freshness() {
        let (root, _p, dir) = setup();
        for stop in ["toolUse", "length", "weird_future_reason"] {
            let m = meta_with_stop(Some(stop), true);
            let (hot, _) = infer_status(&dir, "a", &m, Some(SystemTime::now()));
            assert_eq!(hot, SubagentStatus::Running, "hot stop={stop}");
            let (cold, _) = infer_status(&dir, "a", &m, stale());
            assert_eq!(cold, SubagentStatus::Completed, "cold stop={stop}");
        }
        let (st, _) = infer_status(&dir, "a", &meta_with_stop(None, false), stale());
        assert_eq!(st, SubagentStatus::Pending);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn infer_status_fresh_lock_means_running_even_after_terminal_stop() {
        let (root, _p, dir) = setup();
        // A retried "error" turn with the child still alive (lock present).
        fs::write(dir.join(".a.jsonl.lock.os"), "").unwrap();
        let (st, _) = infer_status(&dir, "a", &meta_with_stop(Some("error"), true), stale());
        assert_eq!(st, SubagentStatus::Running);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn infer_status_output_file_is_completed() {
        let (root, _p, dir) = setup();
        fs::write(dir.join("a.md"), "out").unwrap();
        let (st, out) = infer_status(&dir, "a", &meta_with_stop(Some("error"), true), stale());
        assert_eq!(st, SubagentStatus::Completed);
        assert!(out.is_some());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resumed_subagent_ignores_previous_runs_output_for_status() {
        use std::io::Write;

        let (root, parent, dir) = setup();
        let output = dir.join("A.md");
        fs::write(&output, "Previous result").unwrap();
        fs::File::open(&output)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(3))
            .unwrap();
        let mut transcript = fs::File::options()
            .create_new(true)
            .append(true)
            .open(dir.join("A.jsonl"))
            .unwrap();
        let mut append = |entry: &str| writeln!(transcript, "{entry}").unwrap();
        append(concat!(
            r#"{"type":"session","id":"A","timestamp":"1970-01-01T00:00:00Z"}"#,
            "\n",
            r#"{"type":"session_init","timestamp":"1970-01-01T00:00:01Z"}"#,
            "\n",
            r#"{"type":"message","timestamp":"1970-01-01T00:00:02Z","message":{"role":"assistant","stopReason":"stop"}}"#,
            "\n",
            r#"{"type":"custom","customType":"session_exit","timestamp":"1970-01-01T00:00:04Z"}"#,
        ));
        let mut cache = ScanCache::default();
        let mut summary = || {
            list_with(parent.to_str().unwrap(), &root, &mut cache)
                .unwrap()
                .remove(0)
        };
        assert_eq!(summary().status, SubagentStatus::Completed);

        append(r#"{"type":"session_init","timestamp":"1970-01-01T00:00:05Z"}"#);
        let running = summary();
        assert_eq!(running.status, SubagentStatus::Running);
        assert_eq!(
            fs::read_to_string(running.output_path.unwrap()).unwrap(),
            "Previous result"
        );

        append(
            r#"{"type":"message","timestamp":"1970-01-01T00:00:06Z","message":{"role":"assistant","stopReason":"stop"}}"#,
        );
        assert_eq!(summary().status, SubagentStatus::Completed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignores_non_subagent_artifacts_and_unheaded_jsonl() {
        let (root, parent, subdir) = setup();
        let p = parent.to_str().unwrap();
        fs::write(subdir.join("RealAgent.jsonl"), AGENT).unwrap();
        // Selective-commit journal (`omp` 18.20+): must never appear as a pending/running subagent.
        fs::write(
            subdir.join("changes.jsonl"),
            concat!(
                r#"{"type":"call","agent":"Main","tool":"eval","start":1,"label":"Inspect","end":2}"#,
                "\n",
                r#"{"type":"change","at":3,"agent":"Main","tool":"edit","path":"/tmp/a.conf"}"#,
                "\n",
            ),
        )
        .unwrap();
        // Advisor transcripts share `<parent>/` and carry a valid session header.
        fs::write(subdir.join("__advisor.jsonl"), AGENT).unwrap();
        fs::write(subdir.join("__advisor.reviewer.jsonl"), AGENT).unwrap();
        // Backup and headerless artifact jsonl files.
        fs::write(subdir.join("RealAgent.bak.jsonl"), AGENT).unwrap();
        fs::write(
            subdir.join("other-artifact.jsonl"),
            r#"{"type":"event","payload":{}}"#,
        )
        .unwrap();
        // Unrelated artifact subdirectories (e.g. `blobs/`, `url-search/`) are not subagent trees.
        fs::create_dir_all(subdir.join("blobs")).unwrap();
        fs::write(subdir.join("blobs").join("nested.jsonl"), AGENT).unwrap();

        let list = list_in(p, &root).unwrap();
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["RealAgent"]);

        for excluded in [
            "changes",
            "__advisor",
            "__advisor.reviewer",
            "RealAgent.bak",
            "other-artifact",
            "nested",
        ] {
            assert!(
                transcript_in(p, excluded, 0, &root).is_err(),
                "{excluded} should not resolve as a subagent transcript"
            );
        }
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn excludes_trailing_session_exit_from_ended_at_and_run_segments() {
        let (root, parent, subdir) = setup();
        let single = format!(
            "{AGENT}{}\n",
            r#"{"type":"custom","customType":"session_exit","id":"ex","timestamp":"T99","data":{"kind":"normal"}}"#,
        );
        fs::write(subdir.join("Single.jsonl"), single).unwrap();
        let list = list_in(parent.to_str().unwrap(), &root).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].started_at.as_deref(), Some("T0"));
        assert_eq!(list[0].ended_at.as_deref(), Some("T7"));
        assert_eq!(
            list[0].run_segments,
            vec![SubagentRunSegment {
                started_at: "T0".to_string(),
                ended_at: "T7".to_string(),
            }]
        );

        let tr = transcript_in(parent.to_str().unwrap(), "Single", 0, &root).unwrap();
        assert_eq!(tr.summary.ended_at.as_deref(), Some("T7"));
        assert_eq!(tr.summary.run_segments, list[0].run_segments);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn splits_multi_segment_resumed_runs_and_clamps_subsecond_skew() {
        let (root, parent, subdir) = setup();
        let multi = concat!(
            r#"{"type":"session","version":3,"id":"M","timestamp":"2026-11-19T12:16:12.000Z","cwd":"/w"}"#,
            "\n",
            r#"{"type":"message","id":"u1","timestamp":"2026-11-19T12:16:12.500Z","message":{"role":"user","content":[{"type":"text","text":"part 1"}]}}"#,
            "\n",
            r#"{"type":"message","id":"a1","timestamp":"2026-11-19T12:31:32.000Z","message":{"role":"assistant","content":[{"type":"text","text":"done 1"}],"stopReason":"stop"}}"#,
            "\n",
            r#"{"type":"custom","customType":"session_exit","id":"e1","timestamp":"2026-11-19T12:33:32.000Z","data":{"kind":"normal"}}"#,
            "\n",
            // Segment 2 starts with slight sub-second skew (line 1 .536Z, line 2 .455Z)
            r#"{"type":"message","id":"u2","timestamp":"2026-11-19T12:34:22.536Z","message":{"role":"user","content":[{"type":"text","text":"resume"}]}}"#,
            "\n",
            r#"{"type":"message","id":"s2","timestamp":"2026-11-19T12:34:22.455Z","message":{"role":"assistant","content":[{"type":"text","text":"working"}],"stopReason":"toolUse"}}"#,
            "\n",
            r#"{"type":"message","id":"a2","timestamp":"2026-11-19T12:38:38.000Z","message":{"role":"assistant","content":[{"type":"text","text":"done 2"}],"stopReason":"stop"}}"#,
            "\n",
            r#"{"type":"custom","customType":"session_exit","id":"e2","timestamp":"2026-11-19T12:40:38.000Z","data":{"kind":"normal"}}"#,
            "\n",
        );
        fs::write(subdir.join("PlanStatechart.jsonl"), multi).unwrap();

        let list = list_in(parent.to_str().unwrap(), &root).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            list[0].started_at.as_deref(),
            Some("2026-11-19T12:16:12.000Z")
        );
        assert_eq!(
            list[0].ended_at.as_deref(),
            Some("2026-11-19T12:38:38.000Z")
        );
        assert_eq!(
            list[0].run_segments,
            vec![
                SubagentRunSegment {
                    started_at: "2026-11-19T12:16:12.000Z".to_string(),
                    ended_at: "2026-11-19T12:31:32.000Z".to_string(),
                },
                SubagentRunSegment {
                    started_at: "2026-11-19T12:34:22.455Z".to_string(),
                    ended_at: "2026-11-19T12:38:38.000Z".to_string(),
                },
            ]
        );

        // Incremental append through ScanCache yields identical segments.
        let (split_idx, _) = multi.match_indices("e1").next().unwrap();
        let line_end = multi[split_idx..].find('\n').unwrap() + split_idx + 1;
        let (first_half, second_half) = multi.split_at(line_end);
        let cached_file = subdir.join("Cached.jsonl");
        fs::write(&cached_file, first_half).unwrap();
        let mut cache = ScanCache::default();
        let first_list = list_with(parent.to_str().unwrap(), &root, &mut cache).unwrap();
        let cached_first = first_list.iter().find(|s| s.id == "Cached").unwrap();
        assert_eq!(cached_first.run_segments.len(), 1);

        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(&cached_file)
            .unwrap();
        std::io::Write::write_all(&mut f, second_half.as_bytes()).unwrap();
        drop(f);
        let second_list = list_with(parent.to_str().unwrap(), &root, &mut cache).unwrap();
        let cached_second = second_list.iter().find(|s| s.id == "Cached").unwrap();
        assert_eq!(cached_second.run_segments, list[0].run_segments);
        assert_eq!(cached_second.ended_at, list[0].ended_at);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn detail_cache_seeks_incrementally_on_append_and_resets_on_truncation_or_rotation() {
        let (root, parent, subdir) = setup();
        let p = parent.to_str().unwrap();
        let file = subdir.join("Inc.jsonl");
        fs::write(&file, AGENT).unwrap();
        let cache = Mutex::new(ScanCache::with_capacity(8));

        // Initial load from byte 0 populates the detail cache.
        let first = transcript_with_mutex(p, "Inc", 0, &root, &cache).unwrap();
        assert_eq!(cache.lock().unwrap().bytes_read, AGENT.len() as u64);
        assert_eq!(first.system_prompt.as_deref(), Some("SYS"));
        assert_eq!(first.prompt.as_deref(), Some("do the thing"));
        assert!(!first.reset);

        // Unchanged poll at next_byte reads zero bytes from disk.
        let same = transcript_with_mutex(p, "Inc", first.next_byte, &root, &cache).unwrap();
        assert_eq!(cache.lock().unwrap().bytes_read, AGENT.len() as u64);
        assert!(same.items.is_empty());
        assert!(!same.reset);
        assert_eq!(same.next_byte, first.next_byte);
        assert_eq!(same.system_prompt.as_deref(), Some("SYS"));

        // Append one complete line + trailing partial line: seeks directly to
        // cached next_byte and parses only the newly appended bytes.
        let appended_complete = concat!(
            r#"{"type":"message","id":"m_inc","timestamp":"T8","message":{"role":"assistant","content":[{"type":"text","text":"tail answer"}],"stopReason":"stop","usage":{"input":2,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"total":0.05}}}}"#,
            "\n",
        );
        let appended_partial = r#"{"type":"message","id":"m_part"#;
        let extra = format!("{appended_complete}{appended_partial}");
        {
            let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
            std::io::Write::write_all(&mut f, extra.as_bytes()).unwrap();
        }
        let inc = transcript_with_mutex(p, "Inc", first.next_byte, &root, &cache).unwrap();
        assert_eq!(
            cache.lock().unwrap().bytes_read,
            (AGENT.len() + extra.len()) as u64
        );
        assert!(!inc.reset);
        assert_eq!(inc.items.len(), 1);
        assert_eq!(inc.items[0].id, "m_inc");
        assert_eq!(
            inc.next_byte,
            (AGENT.len() + appended_complete.len()) as u64
        );
        assert_eq!(inc.summary.message_count, first.summary.message_count + 1);
        assert_eq!(inc.summary.request_count, first.summary.request_count + 1);
        assert_eq!(inc.summary.tokens, Some(10 + 5 + 1 + 3 + 2 + 2 + 1));
        assert_eq!(inc.output.as_deref(), Some("tail answer"));
        assert_eq!(inc.system_prompt.as_deref(), Some("SYS"));

        // Finish the partial line: seeks to inc.next_byte and reads only the completed line.
        let partial_rest = concat!(
            r#"","timestamp":"T9","message":{"role":"assistant","content":[{"type":"text","text":"completed partial"}],"stopReason":"stop"}}"#,
            "\n",
        );
        {
            let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
            std::io::Write::write_all(&mut f, partial_rest.as_bytes()).unwrap();
        }
        let bytes_before_partial = cache.lock().unwrap().bytes_read;
        let inc2 = transcript_with_mutex(p, "Inc", inc.next_byte, &root, &cache).unwrap();
        assert_eq!(
            cache.lock().unwrap().bytes_read,
            bytes_before_partial + (appended_partial.len() + partial_rest.len()) as u64
        );
        assert!(!inc2.reset);
        assert_eq!(inc2.items.len(), 1);
        assert_eq!(inc2.items[0].id, "m_part");
        assert_eq!(inc2.output.as_deref(), Some("completed partial"));

        // Truncation forces full re-read and sets reset=true.
        let shorter = concat!(
            r#"{"type":"session","version":3,"id":"A2","timestamp":"T10","cwd":"/w"}"#,
            "\n",
            r#"{"type":"message","id":"u_new","timestamp":"T11","message":{"role":"user","content":[{"type":"text","text":"fresh"}]}}"#,
            "\n",
        );
        fs::write(&file, shorter).unwrap();
        let trunc = transcript_with_mutex(p, "Inc", inc2.next_byte, &root, &cache).unwrap();
        assert!(trunc.reset);
        assert_eq!(trunc.items.len(), 1);
        assert_eq!(trunc.items[0].id, "u_new");
        assert_eq!(trunc.next_byte, shorter.len() as u64);

        // Atomic rotation (new inode, larger file) triggers full re-read + reset=true.
        #[cfg(unix)]
        {
            let rotated_tmp = subdir.join(".Inc.jsonl.tmp");
            fs::write(&rotated_tmp, AGENT).unwrap();
            fs::rename(&rotated_tmp, &file).unwrap();
            let rot = transcript_with_mutex(p, "Inc", trunc.next_byte, &root, &cache).unwrap();
            assert!(rot.reset);
            assert_eq!(rot.items.len(), first.items.len());
            assert_eq!(rot.next_byte, AGENT.len() as u64);
        }

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bounded_cache_evicts_least_recently_accessed_entries() {
        let (root, parent, subdir) = setup();
        let p = parent.to_str().unwrap();
        for name in ["A", "B", "C"] {
            fs::write(subdir.join(format!("{name}.jsonl")), AGENT).unwrap();
        }
        let cache = Mutex::new(ScanCache::with_capacity(2));

        // Load A then B -> cache holds {A, B}.
        transcript_with_mutex(p, "A", 0, &root, &cache).unwrap();
        transcript_with_mutex(p, "B", 0, &root, &cache).unwrap();
        assert_eq!(cache.lock().unwrap().map.len(), 2);

        // Touch A so B becomes the least-recently-accessed entry.
        let a_len = AGENT.len() as u64;
        transcript_with_mutex(p, "A", a_len, &root, &cache).unwrap();

        // Load C -> must evict B and keep {A, C}.
        transcript_with_mutex(p, "C", 0, &root, &cache).unwrap();
        let guard = cache.lock().unwrap();
        let canon_subdir = fs::canonicalize(&subdir).unwrap();
        assert_eq!(guard.map.len(), 2);
        assert!(guard.map.contains_key(&canon_subdir.join("A.jsonl")));
        assert!(guard.map.contains_key(&canon_subdir.join("C.jsonl")));
        assert!(!guard.map.contains_key(&canon_subdir.join("B.jsonl")));
        drop(guard);

        fs::remove_dir_all(&root).ok();
    }
}

//! Per-turn checkpoints: parse `omp-workspace.turn-checkpoint` entries from
//! session .jsonl files, list them per session/worktree (enriched with
//! `restorable`/`undone` from the repo's hidden `refs/omp/*`), and undo any
//! turn — the target plus every later non-undone turn cascade newest-first —
//! restoring files, rolling back HEAD while each turn's commits are still on
//! top, and writing `refs/omp/undone/<sid>/<turnId>` last per turn.

use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::SystemTime;

use parking_lot::Mutex;
use serde_json::Value;

use super::cmd::git_ok;
use super::worktree;
use crate::contracts::{TurnCheckpoint, TurnFile, TurnUndoResult};

const CHECKPOINT_TYPE: &str = "vecway.turn-checkpoint";
const LEGACY_CHECKPOINT_TYPE: &str = "omp-workspace.turn-checkpoint";
/// Shown when the turn's commits are no longer on top of HEAD.
const HEAD_WARNING: &str = "这一轮之后又有新的存档，版本历史没有回退，只恢复了文件";
/// Maximum path arguments per batched git command (keeps argv well under ARG_MAX).
const GIT_PATH_CHUNK_MAX_COUNT: usize = 128;
/// Maximum total path bytes per batched git command.
const GIT_PATH_CHUNK_MAX_BYTES: usize = 64 * 1024;
/// Repository-wide cap on retained `refs/omp/undone/*` markers so pruned
/// snapshot commits are not pinned forever and `git gc` can reclaim them.
const MAX_UNDONE_REFS: usize = 100;

/// `sid` = session id with every char outside `[A-Za-z0-9._-]` → `_`
/// (same rule as the extension; contract "Hidden refs").
fn sanitize_sid(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn turn_ref(sid: &str, turn_id: &str, which: &str) -> String {
    format!("refs/omp/turns/{sid}/{turn_id}/{which}")
}

fn undone_ref(sid: &str, turn_id: &str) -> String {
    format!("refs/omp/undone/{sid}/{turn_id}")
}

/// `path` must be relative and unable to escape the worktree.
fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

/// Parse one `custom` entry into a checkpoint; None when malformed or unrelated.
fn parse_checkpoint(v: &Value) -> Option<TurnCheckpoint> {
    if v.get("type").and_then(Value::as_str) != Some("custom") {
        return None;
    }
    let custom_type = v.get("customType").and_then(Value::as_str);
    if custom_type != Some(CHECKPOINT_TYPE) && custom_type != Some(LEGACY_CHECKPOINT_TYPE) {
        return None;
    }
    let d = v.get("data")?;
    if d.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let turn_id = str_field(d, "turnId").filter(|s| !s.is_empty())?;
    let before = str_field(d, "before").filter(|s| !s.is_empty())?;
    let after = str_field(d, "after").filter(|s| !s.is_empty())?;
    let files = d
        .get("files")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    let path = str_field(f, "path")?;
                    let status = str_field(f, "status")?;
                    (matches!(status.as_str(), "A" | "M" | "D") && safe_path(&path))
                        .then_some(TurnFile { path, status })
                })
                .collect()
        })
        .unwrap_or_default();
    let commits = d
        .get("commits")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    Some(TurnCheckpoint {
        turn_id,
        session_id: str_field(d, "sessionId").unwrap_or_default(),
        user_item_id: str_field(d, "userItemId"),
        prompt: truncate_prompt(&str_field(d, "prompt").unwrap_or_default()),
        before,
        after,
        head_before: str_field(d, "headBefore"),
        head_after: str_field(d, "headAfter"),
        commits,
        files,
        ended_at: str_field(d, "endedAt").unwrap_or_default(),
        restorable: false,
        undone: false,
    })
}

/// Longest prompt (in chars) kept per checkpoint; the Timeline row shows one
/// truncated line plus a tooltip, so full multi-KB prompts are never needed.
const PROMPT_PREVIEW_CHARS: usize = 200;

fn truncate_prompt(s: &str) -> String {
    match s.char_indices().nth(PROMPT_PREVIEW_CHARS) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// Cache bounds: entry count and approximate retained bytes.
const CACHE_MAX_ENTRIES: usize = 1024;
const CACHE_MAX_BYTES: usize = 2 * 1024 * 1024;

struct CacheEntry {
    mtime: SystemTime,
    size: u64,
    bytes: usize,
    last_used: u64,
    parsed: Arc<ParsedSession>,
}

#[derive(Default)]
struct SessionCache {
    map: HashMap<PathBuf, CacheEntry>,
    bytes: usize,
    tick: u64,
}

// LazyLock is stable since 1.80 while the declared MSRV is 1.77.2; the pinned
// toolchain is newer, so keep the declaration-site initializer and scope the
// lint to this static.
#[allow(clippy::incompatible_msrv)]
static SESSION_CACHE: LazyLock<Mutex<SessionCache>> =
    LazyLock::new(|| Mutex::new(SessionCache::default()));

fn approx_bytes(p: &ParsedSession) -> usize {
    let mut n = 128 + p.id.len() + p.cwd.as_ref().map_or(0, String::len);
    for t in &p.turns {
        n += 256
            + t.turn_id.len()
            + t.session_id.len()
            + t.prompt.len()
            + t.before.len()
            + t.after.len()
            + t.commits.iter().map(|c| c.len() + 24).sum::<usize>()
            + t.files.iter().map(|f| f.path.len() + 40).sum::<usize>();
    }
    n
}

/// Insert, then evict least-recently-used entries until both bounds hold.
fn cache_insert(path: &Path, mtime: SystemTime, size: u64, parsed: Arc<ParsedSession>) {
    let bytes = approx_bytes(&parsed);
    let mut c = SESSION_CACHE.lock();
    c.tick += 1;
    let tick = c.tick;
    if let Some(old) = c.map.insert(
        path.to_path_buf(),
        CacheEntry {
            mtime,
            size,
            bytes,
            last_used: tick,
            parsed,
        },
    ) {
        c.bytes -= old.bytes;
    }
    c.bytes += bytes;
    while c.map.len() > CACHE_MAX_ENTRIES || c.bytes > CACHE_MAX_BYTES {
        let Some(victim) = c
            .map
            .iter()
            .min_by_key(|(_, e)| e.last_used)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        if let Some(e) = c.map.remove(&victim) {
            c.bytes -= e.bytes;
        }
    }
}

struct ParsedSession {
    /// `cwd` from the `type:"session"` header entry.
    cwd: Option<String>,
    /// Session id from the header (fallback for data.sessionId).
    id: String,
    turns: Vec<TurnCheckpoint>,
}

/// Read a session .jsonl; malformed lines/entries are skipped.
/// Results are cached in memory keyed by (mtime, size) to avoid re-reading
/// and re-parsing large historical session files repeatedly.
fn parse_file(path: &Path) -> Result<Arc<ParsedSession>, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("读取会话记录失败: {e}"))?;
    let mtime = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let size = metadata.len();

    // Check in-memory cache
    {
        let mut guard = SESSION_CACHE.lock();
        let c = &mut *guard;
        c.tick += 1;
        let tick = c.tick;
        if let Some(entry) = c.map.get_mut(path) {
            if entry.mtime == mtime && entry.size == size {
                entry.last_used = tick;
                return Ok(entry.parsed.clone());
            }
        }
    }

    let file = std::fs::File::open(path).map_err(|e| format!("读取会话记录失败: {e}"))?;
    let mut reader = std::io::BufReader::new(file);
    let mut parsed = ParsedSession {
        cwd: None,
        id: String::new(),
        turns: Vec::new(),
    };
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("读取会话记录失败: {e}")),
        }
        let text = String::from_utf8_lossy(&buf);
        let line = text.trim();
        if line.is_empty() {
            continue;
        }
        // Fast pre-filter: skip lines that cannot be a checkpoint or session header,
        // avoiding expensive serde_json::from_str parsing on message/tool output rows.
        if !line.contains(CHECKPOINT_TYPE)
            && !line.contains(LEGACY_CHECKPOINT_TYPE)
            && (parsed.cwd.is_some() || !line.contains("\"session\""))
        {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("type").and_then(Value::as_str) {
            Some("session") => {
                if parsed.cwd.is_none() {
                    parsed.cwd = str_field(&v, "cwd");
                }
                if parsed.id.is_empty() {
                    parsed.id = str_field(&v, "id").unwrap_or_default();
                }
            }
            _ => {
                if let Some(t) = parse_checkpoint(&v) {
                    parsed.turns.push(t);
                }
            }
        }
    }
    for t in &mut parsed.turns {
        if t.session_id.is_empty() {
            t.session_id = parsed.id.clone();
        }
    }

    let parsed_arc = Arc::new(parsed);
    cache_insert(path, mtime, size, parsed_arc.clone());
    Ok(parsed_arc)
}

#[cfg(test)]
pub(crate) fn clear_session_cache_for_test() {
    let mut c = SESSION_CACHE.lock();
    c.map.clear();
    c.bytes = 0;
}

/// All `refs/omp/**` refs of the repo containing `dir` (empty on failure).
fn omp_refs(dir: &Path) -> HashSet<String> {
    git_ok(dir, &["for-each-ref", "--format=%(refname)", "refs/omp/"])
        .map(|t| t.lines().map(String::from).collect())
        .unwrap_or_default()
}

/// Fill `restorable` (both snapshot refs exist) and `undone` (undone ref exists).
fn enrich(dir: &Path, turns: &mut [TurnCheckpoint]) {
    if turns.is_empty() {
        return;
    }
    let refs = omp_refs(dir);
    for t in turns.iter_mut() {
        let sid = sanitize_sid(&t.session_id);
        t.restorable = refs.contains(&turn_ref(&sid, &t.turn_id, "before"))
            && refs.contains(&turn_ref(&sid, &t.turn_id, "after"));
        t.undone = refs.contains(&undone_ref(&sid, &t.turn_id));
    }
}

/// `git_session_turns`: checkpoints of one session file, oldest first.
/// Ref enrichment happens in the repo of the session's own cwd.
pub fn session_turns(session_file: &Path) -> Result<Vec<TurnCheckpoint>, String> {
    let parsed = parse_file(session_file)?;
    let mut turns = parsed.turns.clone();
    sort_turns(&mut turns);
    if let Some(cwd) = parsed.cwd.as_deref().filter(|c| !c.is_empty()) {
        enrich(Path::new(cwd), &mut turns);
    }
    Ok(turns)
}

/// Merge checkpoints from several session files of one worktree, oldest first.
fn collect_turns(files: &[PathBuf], repo_dir: &Path) -> Vec<TurnCheckpoint> {
    let mut out = Vec::new();
    for f in files {
        if let Ok(parsed) = parse_file(f) {
            out.extend(parsed.turns.iter().cloned());
        }
    }
    sort_turns(&mut out);
    enrich(repo_dir, &mut out);
    out
}

/// Stable oldest-first order: `endedAt`, then `turnId` as tiebreak.
fn sort_turns(turns: &mut [TurnCheckpoint]) {
    turns.sort_by(|a, b| {
        a.ended_at
            .cmp(&b.ended_at)
            .then_with(|| a.turn_id.cmp(&b.turn_id))
    });
}

/// `git_worktree_turns`: checkpoints of every session assigned to the
/// (deepest) worktree containing `cwd`, oldest first by `endedAt`.
/// Efficient: resolves worktree paths and sessions directly without
/// triggering redundant `git status` checks across all worktrees.
pub fn worktree_turns(
    cwd: &Path,
    sessions: &[(String, String)],
) -> Result<Vec<TurnCheckpoint>, String> {
    let Some(info) = worktree::repo_info(cwd) else {
        return Ok(Vec::new());
    };
    let dir = worktree::canon(cwd);
    let main_root = info.main_root();
    let entries = worktree::list_entries(&main_root)?;
    let paths: Vec<PathBuf> = entries
        .iter()
        .map(|e| worktree::canon(Path::new(&e.path)))
        .collect();
    let Some(entry_path) = paths
        .iter()
        .filter(|p| worktree::is_inside(&dir, p))
        .max_by_key(|p| p.as_os_str().len())
    else {
        return Ok(Vec::new());
    };
    let session_ids = worktree::sessions_for_path(entry_path, &paths, sessions);
    let files: Vec<PathBuf> = session_ids
        .iter()
        .filter_map(|id| crate::catalog::file_of(id))
        .collect();
    Ok(collect_turns(&files, &dir))
}

fn chunk_paths<'a>(paths: &[&'a str]) -> Vec<Vec<&'a str>> {
    let mut chunks = Vec::new();
    let mut cur = Vec::new();
    let mut cur_bytes = 0usize;
    for &p in paths {
        let p_bytes = p.len() + 1;
        if !cur.is_empty()
            && (cur.len() >= GIT_PATH_CHUNK_MAX_COUNT
                || cur_bytes + p_bytes > GIT_PATH_CHUNK_MAX_BYTES)
        {
            chunks.push(std::mem::take(&mut cur));
            cur_bytes = 0;
        }
        cur.push(p);
        cur_bytes += p_bytes;
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

/// Blob sha of the file as it currently is on disk; None when absent, Some("")
/// when present but not a regular file (never matches a blob sha).
fn worktree_blob(dir: &Path, path: &str) -> Option<String> {
    let meta = std::fs::symlink_metadata(dir.join(path)).ok()?;
    if !meta.is_file() {
        return Some(String::new());
    }
    git_ok(dir, &["hash-object", "--", path])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Batched worktree blob lookup: avoids spawning one `git hash-object` per file.
fn worktree_blobs_batched<'a>(dir: &Path, paths: &[&'a str]) -> HashMap<&'a str, Option<String>> {
    let mut out = HashMap::with_capacity(paths.len());
    let mut regular_files = Vec::new();
    for &path in paths {
        match std::fs::symlink_metadata(dir.join(path)) {
            Err(_) => {
                out.insert(path, None);
            }
            Ok(meta) if !meta.is_file() => {
                out.insert(path, Some(String::new()));
            }
            Ok(_) => regular_files.push(path),
        }
    }
    for chunk in chunk_paths(&regular_files) {
        let mut args = Vec::with_capacity(2 + chunk.len());
        args.push("hash-object");
        args.push("--");
        args.extend_from_slice(&chunk);
        let parsed = git_ok(dir, &args).ok().and_then(|text| {
            let lines: Vec<&str> = text.lines().map(str::trim).collect();
            if lines.len() == chunk.len() && lines.iter().all(|l| !l.is_empty()) {
                Some(
                    chunk
                        .iter()
                        .zip(lines)
                        .map(|(&p, sha)| (p, Some(sha.to_string())))
                        .collect::<Vec<_>>(),
                )
            } else {
                None
            }
        });
        if let Some(entries) = parsed {
            for (p, sha) in entries {
                out.insert(p, sha);
            }
        } else {
            for &p in &chunk {
                out.insert(p, worktree_blob(dir, p));
            }
        }
    }
    out
}

/// Blob sha of `path` inside `commit`; None when the path is absent there.
fn blob_at(dir: &Path, commit: &str, path: &str) -> Option<String> {
    git_ok(
        dir,
        &["rev-parse", "-q", "--verify", &format!("{commit}:{path}")],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

/// Batched `<commit>:<path>` object lookup via a single `git cat-file --batch-check`.
fn blobs_at_batched<'a>(
    dir: &Path,
    pairs: &[(&'a str, &'a str)],
) -> HashMap<&'a str, Option<String>> {
    let mut out = HashMap::with_capacity(pairs.len());
    let mut batch: Vec<(&'a str, &'a str)> = Vec::with_capacity(pairs.len());
    for &(path, commit) in pairs {
        if path.contains(['\n', '\r']) {
            out.insert(path, blob_at(dir, commit, path));
        } else {
            batch.push((path, commit));
        }
    }
    if batch.is_empty() {
        return out;
    }
    let mut stdin = String::new();
    for &(path, commit) in &batch {
        stdin.push_str(commit);
        stdin.push(':');
        stdin.push_str(path);
        stdin.push('\n');
    }
    let parsed = super::cmd::git_with_stdin(dir, &["cat-file", "--batch-check"], stdin.as_bytes())
        .ok()
        .filter(|o| o.ok())
        .and_then(|o| {
            let text = o.text();
            let lines: Vec<&str> = text.lines().collect();
            if lines.len() != batch.len() {
                return None;
            }
            let mut entries = Vec::with_capacity(batch.len());
            for (&(path, commit), &line) in batch.iter().zip(&lines) {
                let missing = format!("{commit}:{path} missing");
                let sha = if line == missing {
                    None
                } else {
                    line.split_whitespace()
                        .next()
                        .filter(|s| !s.is_empty() && !s.contains(':'))
                        .map(str::to_string)
                };
                entries.push((path, sha));
            }
            Some(entries)
        });
    if let Some(entries) = parsed {
        for (p, sha) in entries {
            out.insert(p, sha);
        }
    } else {
        for &(path, commit) in &batch {
            out.insert(path, blob_at(dir, commit, path));
        }
    }
    out
}

fn head(dir: &Path) -> Option<String> {
    git_ok(dir, &["rev-parse", "--verify", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
/// `git_undo_turn`: roll the workspace back to its state before `turn_id`
/// started. That means the target turn AND every later non-undone turn of the
/// session are undone, newest first (a cascade). Per turn: reset HEAD to
/// `head_before` only while it still equals `head_after`, restore the turn's
/// files from their `before` snapshot (created files deleted), then write
/// `refs/omp/undone/<sid>/<turnId>`. `force` skips the post-turn-edit
/// conflict check; without it a non-empty `conflicts` is returned and nothing
/// is written. The whole cascade is pre-flighted before the first write:
/// every non-undone turn after the target must be `restorable`.
pub fn undo_turn(
    cwd: &Path,
    session_file: &Path,
    turn_id: &str,
    force: bool,
) -> Result<TurnUndoResult, String> {
    let parsed = parse_file(session_file)?;
    let mut turns = parsed.turns.clone();
    sort_turns(&mut turns);
    enrich(cwd, &mut turns);
    let Some(idx) = turns.iter().position(|t| t.turn_id == turn_id) else {
        return Err("找不到这一轮".into());
    };
    if turns[idx].undone {
        return Err("这一轮已经撤回过了".into());
    }
    // Cascade: target + every later non-undone turn, processed newest first.
    let cascade: Vec<&TurnCheckpoint> = turns[idx..].iter().filter(|t| !t.undone).rev().collect();

    // Pre-flight (before ANY write): no turn in the cascade may be crossed
    // when its snapshots are gone — a missing checkpoint means the workspace
    // could not be returned to the state before the target started.
    for t in &cascade {
        if !t.restorable {
            let name = if t.prompt.is_empty() {
                t.turn_id.clone()
            } else {
                t.prompt.clone()
            };
            return Err(if t.turn_id == turn_id {
                "这一轮的存档已失效，无法撤回".into()
            } else {
                format!("无法跨过「{name}」撤回更早的轮次：这一轮的存档已失效")
            });
        }
    }

    // Conflict pre-flight: a file conflicts when its current worktree blob
    // differs from the `after` snapshot of the NEWEST cascaded turn that
    // touched it (i.e. it was edited after that turn ended).
    let mut expected: HashMap<&str, &str> = HashMap::new();
    for t in &cascade {
        for f in &t.files {
            expected.entry(f.path.as_str()).or_insert(t.after.as_str());
        }
    }
    let pairs: Vec<(&str, &str)> = expected.iter().map(|(&p, &a)| (p, a)).collect();
    let paths: Vec<&str> = pairs.iter().map(|&(p, _)| p).collect();
    let wt_blobs = worktree_blobs_batched(cwd, &paths);
    let expected_blobs = blobs_at_batched(cwd, &pairs);
    let mut conflicts: Vec<String> = pairs
        .iter()
        .filter(|&&(path, _)| {
            wt_blobs.get(path).and_then(|o| o.as_deref())
                != expected_blobs.get(path).and_then(|o| o.as_deref())
        })
        .map(|&(path, _)| path.to_string())
        .collect();
    // A mixed HEAD reset rewrites the whole index, including staged edits to
    // files this turn never touched. Treat those as explicit-override conflicts
    // as well; worktree-only blob checks cannot detect staged-only edits.
    let current_head = head(cwd);
    if cascade
        .iter()
        .any(|t| !t.commits.is_empty() && current_head.is_some() && current_head == t.head_after)
    {
        let staged = git_ok(cwd, &["diff", "--cached", "--name-only", "-z", "HEAD"])?;
        conflicts.extend(
            staged
                .split('\0')
                .filter(|path| !path.is_empty())
                .map(str::to_string),
        );
    }
    conflicts.sort();
    conflicts.dedup();
    if !conflicts.is_empty() && !force {
        return Ok(TurnUndoResult {
            conflicts,
            ..Default::default()
        });
    }

    let mut result = TurnUndoResult::default();
    let mut restored: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    let mut undone_count = 0usize;

    for t in cascade {
        if let Err(e) = undo_one(cwd, t, &mut result, &mut restored, &mut deleted) {
            return Err(format!("已成功撤回 {undone_count} 轮后失败: {e}"));
        }
        undone_count += 1;
    }
    // Prune ancient undo markers beyond the repo-wide ceiling so pruned
    // snapshot commits can be reclaimed by `git gc`.
    prune_undone_refs(cwd, MAX_UNDONE_REFS);

    // Report each path once, under the OLDEST cascaded action that touched it
    // (the last one that ran) — that is the state the file ends up in.
    restored.sort();
    restored.dedup();
    deleted.sort();
    deleted.dedup();
    let deleted_set: HashSet<&str> = deleted.iter().map(String::as_str).collect();
    restored.retain(|p| !deleted_set.contains(p.as_str()));
    result.restored = restored;
    result.deleted = deleted;
    result.turns_undone = undone_count;
    Ok(result)
}

/// One cascade step: reset HEAD only while this turn's commits are still on
/// top, restore its files from `before` (created files deleted), then write
/// the undone ref last — only after its files were restored.
fn undo_one(
    cwd: &Path,
    t: &TurnCheckpoint,
    result: &mut TurnUndoResult,
    restored: &mut Vec<String>,
    deleted: &mut Vec<String>,
) -> Result<(), String> {
    if !t.commits.is_empty() {
        let now = head(cwd);
        if now.is_some() && now == t.head_after {
            if let Some(base) = &t.head_before {
                git_ok(cwd, &["reset", "--mixed", base])
                    .map_err(|e| format!("回退版本历史失败: {e}"))?;
                result.head_reset = true;
            } else {
                result.warning = Some(HEAD_WARNING.into());
            }
        } else {
            result.warning = Some(HEAD_WARNING.into());
        }
    }

    // Files: only the turn's files are touched. `restore --worktree` never
    // touches the real index; created files are deleted from disk.
    let mut to_restore: Vec<&str> = Vec::new();
    for f in &t.files {
        if f.status == "A" {
            match std::fs::remove_file(cwd.join(&f.path)) {
                Ok(()) => deleted.push(f.path.clone()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("删除 {} 失败: {e}", f.path)),
            }
        } else {
            to_restore.push(f.path.as_str());
        }
    }
    let source_arg = format!("--source={}", t.before);
    for chunk in chunk_paths(&to_restore) {
        let mut args: Vec<&str> = Vec::with_capacity(4 + chunk.len());
        args.push("restore");
        args.push(&source_arg);
        args.push("--worktree");
        args.push("--");
        args.extend_from_slice(&chunk);
        match git_ok(cwd, &args) {
            Ok(_) => restored.extend(chunk.iter().map(|p| (*p).to_string())),
            Err(_) if chunk.len() > 1 => {
                for &path in &chunk {
                    git_ok(cwd, &["restore", &source_arg, "--worktree", "--", path])
                        .map_err(|e| format!("恢复 {path} 失败: {e}"))?;
                    restored.push(path.to_string());
                }
            }
            Err(e) => return Err(format!("恢复 {} 失败: {e}", chunk[0])),
        }
    }

    let sid = sanitize_sid(&t.session_id);
    git_ok(
        cwd,
        &["update-ref", &undone_ref(&sid, &t.turn_id), &t.before],
    )
    .map_err(|e| format!("标记撤回失败: {e}"))?;
    Ok(())
}

fn parse_turn_num(turn_id: &str) -> u64 {
    turn_id
        .strip_prefix('t')
        .and_then(|rest| rest.parse::<u64>().ok())
        .unwrap_or(0)
}

fn delete_refs_batch(dir: &Path, refs: &[String]) {
    if refs.is_empty() {
        return;
    }
    if refs.len() == 1 {
        let _ = git_ok(dir, &["update-ref", "-d", &refs[0]]);
        return;
    }
    let mut stdin = String::new();
    for r in refs {
        stdin.push_str("delete ");
        stdin.push_str(r);
        stdin.push('\n');
    }
    let ok = super::cmd::git_with_stdin(dir, &["update-ref", "--stdin"], stdin.as_bytes())
        .is_ok_and(|o| o.ok());
    if !ok {
        for r in refs {
            let _ = git_ok(dir, &["update-ref", "-d", r]);
        }
    }
}

/// Cap total `refs/omp/undone/*` markers in the repo at `max_undone`.
/// Prunes oldest markers whose snapshot refs are already gone first (preferring
/// sessions with no remaining live snapshots). If active undone turns alone
/// exceed `max_undone`, their snapshot refs are removed alongside the pruned
/// undone marker so an already-undone turn never becomes falsely restorable.
fn prune_undone_refs(dir: &Path, max_undone: usize) {
    let Ok(out) = git_ok(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname)\t%(committerdate:unix)",
            "refs/omp/",
        ],
    ) else {
        return;
    };
    let mut turn_refs_by_key: HashMap<(String, String), Vec<String>> = HashMap::new();
    let mut live_sessions: HashSet<String> = HashSet::new();
    struct UndoneEntry {
        refname: String,
        sid: String,
        turn_id: String,
        turn_num: u64,
        ts: i64,
    }
    let mut undone_entries: Vec<UndoneEntry> = Vec::new();

    for line in out.lines() {
        let mut parts = line.splitn(2, '\t');
        let Some(refname) = parts.next().filter(|s| !s.is_empty()) else {
            continue;
        };
        let ts = parts
            .next()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0);
        if let Some(rest) = refname.strip_prefix("refs/omp/turns/") {
            let segs: Vec<&str> = rest.split('/').collect();
            if segs.len() == 3 && (segs[2] == "before" || segs[2] == "after") {
                let sid = segs[0].to_string();
                let turn_id = segs[1].to_string();
                live_sessions.insert(sid.clone());
                turn_refs_by_key
                    .entry((sid, turn_id))
                    .or_default()
                    .push(refname.to_string());
            }
        } else if let Some(rest) = refname.strip_prefix("refs/omp/undone/") {
            let segs: Vec<&str> = rest.split('/').collect();
            if segs.len() == 2 {
                let sid = segs[0].to_string();
                let turn_id = segs[1].to_string();
                let turn_num = parse_turn_num(&turn_id);
                undone_entries.push(UndoneEntry {
                    refname: refname.to_string(),
                    sid,
                    turn_id,
                    turn_num,
                    ts,
                });
            }
        }
    }

    if undone_entries.len() <= max_undone {
        return;
    }

    undone_entries.sort_by(|a, b| {
        let a_live_turn = turn_refs_by_key.contains_key(&(a.sid.clone(), a.turn_id.clone()));
        let b_live_turn = turn_refs_by_key.contains_key(&(b.sid.clone(), b.turn_id.clone()));
        let a_live_sess = live_sessions.contains(&a.sid);
        let b_live_sess = live_sessions.contains(&b.sid);
        a_live_turn
            .cmp(&b_live_turn)
            .then_with(|| a_live_sess.cmp(&b_live_sess))
            .then_with(|| a.turn_num.cmp(&b.turn_num))
            .then_with(|| a.ts.cmp(&b.ts))
            .then_with(|| a.refname.cmp(&b.refname))
    });

    let excess = undone_entries.len() - max_undone;
    let mut to_delete: Vec<String> = Vec::with_capacity(excess);
    for entry in undone_entries.into_iter().take(excess) {
        to_delete.push(entry.refname);
        if let Some(snap_refs) = turn_refs_by_key.get(&(entry.sid, entry.turn_id)) {
            to_delete.extend(snap_refs.iter().cloned());
        }
    }
    delete_refs_batch(dir, &to_delete);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cmd::{git_cmd, run, GIT_TIMEOUT};
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = PathBuf::from(format!(
            "/tmp/ompws-test-c/turns-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_repo(tag: &str) -> PathBuf {
        let dir = temp_dir(tag);
        git_ok(&dir, &["init", "-q", "-b", "main"]).unwrap();
        git_ok(&dir, &["config", "user.name", "Test"]).unwrap();
        git_ok(&dir, &["config", "user.email", "t@example.com"]).unwrap();
        git_ok(&dir, &["config", "commit.gpgsign", "false"]).unwrap();
        dir
    }

    fn g(dir: &Path, args: &[&str]) -> String {
        git_ok(dir, args).unwrap().trim().to_string()
    }

    fn write(dir: &Path, file: &str, content: &str) {
        let p = dir.join(file);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, content).unwrap();
    }

    /// Whole-worktree snapshot commit via a temp index — same plumbing the
    /// extension uses; the real index is never touched.
    fn snap(dir: &Path, msg: &str) -> String {
        let idx = temp_dir("idx").join("index");
        let run_idx = |args: &[&str]| {
            let mut c = git_cmd(dir);
            c.env("GIT_INDEX_FILE", &idx).args(args);
            let out = run(c, GIT_TIMEOUT).unwrap();
            assert!(out.ok(), "{args:?}: {}", out.err_msg());
            out.text()
        };
        let head = head(dir);
        if let Some(h) = &head {
            run_idx(&["read-tree", h]);
        }
        run_idx(&["add", "-A"]);
        let tree = run_idx(&["write-tree"]).trim().to_string();
        let mut args = vec!["commit-tree".to_string(), tree];
        if let Some(h) = &head {
            args.push("-p".into());
            args.push(h.clone());
        }
        args.push("-m".into());
        args.push(msg.into());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let sha = g(dir, &refs);
        let _ = std::fs::remove_file(&idx);
        sha
    }

    fn refs(dir: &Path, sid: &str, turn_id: &str, before: &str, after: &str) {
        g(
            dir,
            &["update-ref", &turn_ref(sid, turn_id, "before"), before],
        );
        g(
            dir,
            &["update-ref", &turn_ref(sid, turn_id, "after"), after],
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn entry(
        sid: &str,
        turn_id: &str,
        prompt: &str,
        before: &str,
        after: &str,
        head_before: Option<&str>,
        head_after: Option<&str>,
        commits: &[&str],
        files: &[(&str, &str)],
        ended_at: &str,
    ) -> String {
        json!({
            "type": "custom",
            "id": format!("e-{turn_id}"),
            "customType": CHECKPOINT_TYPE,
            "data": {
                "v": 1,
                "turnId": turn_id,
                "sessionId": sid,
                "userItemId": "u1",
                "prompt": prompt,
                "before": before,
                "after": after,
                "headBefore": head_before,
                "headAfter": head_after,
                "commits": commits,
                "files": files
                    .iter()
                    .map(|(p, s)| json!({"path": p, "status": s}))
                    .collect::<Vec<_>>(),
                "endedAt": ended_at,
            }
        })
        .to_string()
    }

    fn session_file(dir: &Path, repo: &Path, sid: &str, lines: &[String]) -> PathBuf {
        let file = dir.join(format!("{sid}.jsonl"));
        let header = json!({
            "type": "session",
            "version": 3,
            "id": sid,
            "timestamp": "2026-09-29T00:00:00Z",
            "cwd": repo.to_string_lossy(),
        })
        .to_string();
        let body = std::iter::once(header)
            .chain(lines.iter().cloned())
            .collect::<Vec<_>>()
            .join("\n");
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&file, body).unwrap();
        file
    }

    /// Turn that modified `mod.txt` m1→m2, deleted `del.txt`, created `new.txt`;
    /// returns (before, after, files-entry).
    fn make_turn(repo: &Path, sid: &str, turn_id: &str, ended: &str) -> (String, String, String) {
        let before = snap(repo, &format!("{turn_id} before"));
        write(repo, "mod.txt", "m2\n");
        std::fs::remove_file(repo.join("del.txt")).unwrap();
        write(repo, "new.txt", "created by turn\n");
        let after = snap(repo, &format!("{turn_id} after"));
        refs(repo, sid, turn_id, &before, &after);
        let e = entry(
            sid,
            turn_id,
            "do the thing",
            &before,
            &after,
            None,
            None,
            &[],
            &[("mod.txt", "M"), ("del.txt", "D"), ("new.txt", "A")],
            ended,
        );
        (before, after, e)
    }

    #[test]
    fn parse_skips_malformed_and_enriches_refs() {
        let repo = temp_repo("parse");
        let sid = "s:1/bad"; // exercises sanitize_sid
        g(&repo, &["commit", "--allow-empty", "-q", "-m", "init"]);
        let before = snap(&repo, "before t1");
        let after = snap(&repo, "after t1");
        refs(&repo, &sanitize_sid(sid), "t1", &before, &after);

        let sess = temp_dir("sess");
        let file = session_file(
            &sess,
            &repo,
            sid,
            &[
                "{not json".to_string(),
                json!({"type": "custom", "customType": "other", "data": {}}).to_string(),
                // missing before/after → malformed
                json!({"type": "custom", "customType": CHECKPOINT_TYPE, "data": {"v": 1, "turnId": "x"}}).to_string(),
                entry(sid, "t1", "first", &before, &after, None, None, &[],
                    &[("mod.txt", "M")], "2026-09-29T10:00:00Z"),
                // refs pruned → restorable=false
                entry(sid, "t2", "second", "0".repeat(40).as_str(), "1".repeat(40).as_str(),
                    None, None, &[], &[("b.txt", "M")], "2026-09-29T10:01:00Z"),
            ],
        );

        let turns = session_turns(&file).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].turn_id, "t1");
        assert_eq!(turns[0].session_id, sid);
        assert!(turns[0].restorable && !turns[0].undone);
        assert_eq!(turns[1].turn_id, "t2");
        assert!(!turns[1].restorable);

        // Undone ref flips the flag.
        g(
            &repo,
            &["update-ref", &undone_ref(&sanitize_sid(sid), "t1"), &before],
        );
        let turns = session_turns(&file).unwrap();
        assert!(turns[0].undone);
        assert!(!turns[1].undone);
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn parse_file_caches_by_mtime_and_size() {
        let sess = temp_dir("cache");
        let sid = "s1";
        // Distinct turn_id per rewrite, same length so size stays identical.
        let line = |turn_id: &str| {
            entry(
                sid,
                turn_id,
                "p",
                &"0".repeat(40),
                &"1".repeat(40),
                None,
                None,
                &[],
                &[("f.txt", "M")],
                "2026-09-29T10:00:00Z",
            )
        };
        let file = session_file(&sess, &sess, sid, &[line("t1")]);
        let set_mtime = |t: SystemTime| {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&file)
                .unwrap()
                .set_modified(t)
                .unwrap();
        };

        clear_session_cache_for_test();
        // First read parses and populates the cache.
        let first = parse_file(&file).unwrap();
        assert_eq!(first.turns[0].turn_id, "t1");
        // Second read with unchanged file → cache hit: same Arc, no re-parse.
        let second = parse_file(&file).unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        // Content changes but (mtime, size) stays identical → still served
        // from cache, proving the key is metadata, not file contents.
        let meta = std::fs::metadata(&file).unwrap();
        let (mtime, size) = (meta.modified().unwrap(), meta.len());
        std::fs::write(
            &file,
            std::fs::read_to_string(&file)
                .unwrap()
                .replace("\"t1\"", "\"t9\""),
        )
        .unwrap();
        set_mtime(mtime);
        assert_eq!(std::fs::metadata(&file).unwrap().len(), size);
        let third = parse_file(&file).unwrap();
        assert!(Arc::ptr_eq(&first, &third));

        // An mtime bump alone invalidates the entry → the file is re-parsed
        // and the updated turn_id is returned.
        set_mtime(mtime + std::time::Duration::from_secs(60));
        let fourth = parse_file(&file).unwrap();
        assert!(!Arc::ptr_eq(&first, &fourth));
        assert_eq!(fourth.turns[0].turn_id, "t9");

        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn collect_turns_merges_sessions_oldest_first() {
        let repo = temp_repo("merge");
        let sid = "s1";
        g(&repo, &["commit", "--allow-empty", "-q", "-m", "init"]);
        let b = snap(&repo, "b");
        let a = snap(&repo, "a");
        refs(&repo, sid, "t1", &b, &a);

        let sess = temp_dir("sess-merge");
        let f1 = session_file(
            &sess,
            &repo,
            sid,
            &[entry(
                sid,
                "t2",
                "later",
                &b,
                &a,
                None,
                None,
                &[],
                &[],
                "2026-09-29T10:05:00Z",
            )],
        );
        let f2 = session_file(
            &sess.with_file_name(format!("{}-2", sess.file_name().unwrap().to_string_lossy())),
            &repo,
            sid,
            &[entry(
                sid,
                "t1",
                "earlier",
                &b,
                &a,
                None,
                None,
                &[],
                &[],
                "2026-09-29T10:00:00Z",
            )],
        );
        let turns = collect_turns(&[f1, f2], &repo);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].turn_id, "t1");
        assert!(turns[0].restorable);
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn undo_restores_turn_files_and_keeps_other_work() {
        let repo = temp_repo("undo");
        let sid = "s1";
        write(&repo, "mod.txt", "m1\n");
        write(&repo, "del.txt", "to be deleted\n");
        write(&repo, "keep.txt", "keep\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);
        // Unrelated staged file — the real index must survive the undo.
        write(&repo, "staged.txt", "staged elsewhere\n");
        g(&repo, &["add", "staged.txt"]);

        let (_b, _a, e) = make_turn(&repo, sid, "t1", "2026-09-29T10:00:00Z");
        // Another session's uncommitted file, created after the turn.
        write(&repo, "dirty.txt", "other session\n");

        let sess = temp_dir("sess-undo");
        let file = session_file(&sess, &repo, sid, &[e]);
        let r = undo_turn(&repo, &file, "t1", false).unwrap();
        assert_eq!(r.restored.len(), 2, "{r:?}");
        assert!(r.restored.contains(&"mod.txt".to_string()));
        assert!(r.restored.contains(&"del.txt".to_string()));
        assert_eq!(r.deleted, vec!["new.txt".to_string()]);
        assert!(!r.head_reset);
        assert_eq!(
            std::fs::read_to_string(repo.join("mod.txt")).unwrap(),
            "m1\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("del.txt")).unwrap(),
            "to be deleted\n"
        );
        assert!(!repo.join("new.txt").exists());
        assert_eq!(
            std::fs::read_to_string(repo.join("dirty.txt")).unwrap(),
            "other session\n"
        );
        let st = g(&repo, &["status", "--porcelain"]);
        assert!(st.contains("A  staged.txt"), "index lost staged file: {st}");
        assert!(st.contains("?? dirty.txt"), "{st}");
        // Undone ref written; a second undo errs.
        assert_eq!(
            g(&repo, &["rev-parse", &undone_ref(sid, "t1")]),
            g(&repo, &["rev-parse", &turn_ref(sid, "t1", "before")])
        );
        assert!(undo_turn(&repo, &file, "t1", false).is_err());
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn undo_conflict_blocks_then_force_proceeds() {
        let repo = temp_repo("conflict");
        let sid = "s1";
        write(&repo, "mod.txt", "m1\n");
        write(&repo, "del.txt", "d\n");
        write(&repo, "new-marker.txt", "x\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);
        std::fs::remove_file(repo.join("new-marker.txt")).unwrap();

        let (_b, _a, e) = make_turn(&repo, sid, "t1", "2026-09-29T10:00:00Z");
        // Edited again after the turn ended.
        write(&repo, "mod.txt", "m3 post-turn\n");
        write(&repo, "new.txt", "recreated differently\n");

        let sess = temp_dir("sess-conflict");
        let file = session_file(&sess, &repo, sid, &[e]);
        let r = undo_turn(&repo, &file, "t1", false).unwrap();
        assert!(r.conflicts.contains(&"mod.txt".to_string()), "{r:?}");
        assert!(r.conflicts.contains(&"new.txt".to_string()), "{r:?}");
        assert!(r.restored.is_empty() && r.deleted.is_empty());
        // Nothing changed.
        assert_eq!(
            std::fs::read_to_string(repo.join("mod.txt")).unwrap(),
            "m3 post-turn\n"
        );
        assert!(git_ok(
            &repo,
            &["rev-parse", "-q", "--verify", &undone_ref(sid, "t1")]
        )
        .is_err());

        let r = undo_turn(&repo, &file, "t1", true).unwrap();
        assert!(r.conflicts.is_empty());
        assert_eq!(
            std::fs::read_to_string(repo.join("mod.txt")).unwrap(),
            "m1\n"
        );
        assert!(!repo.join("new.txt").exists());
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn undo_resets_head_only_when_turn_commits_on_top() {
        let repo = temp_repo("head");
        let sid = "s1";
        write(&repo, "f.txt", "f1\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);

        // HEAD == headAfter → reset --mixed headBefore.
        let head_before = g(&repo, &["rev-parse", "HEAD"]);
        let before = snap(&repo, "before");
        write(&repo, "f.txt", "f2\n");
        g(&repo, &["add", "f.txt"]);
        g(&repo, &["commit", "-q", "-m", "turn commit"]);
        let head_after = g(&repo, &["rev-parse", "HEAD"]);
        let after = snap(&repo, "after");
        refs(&repo, sid, "t1", &before, &after);
        let sess = temp_dir("sess-head");
        let file = session_file(
            &sess,
            &repo,
            sid,
            &[entry(
                sid,
                "t1",
                "commit work",
                &before,
                &after,
                Some(&head_before),
                Some(&head_after),
                &[&head_after],
                &[("f.txt", "M")],
                "2026-09-29T10:00:00Z",
            )],
        );
        let r = undo_turn(&repo, &file, "t1", false).unwrap();
        assert!(r.head_reset, "{r:?}");
        assert_eq!(g(&repo, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(std::fs::read_to_string(repo.join("f.txt")).unwrap(), "f1\n");

        // Later commit on top → HEAD untouched, warning set, files restored.
        let repo2 = temp_repo("head-later");
        write(&repo2, "f.txt", "f1\n");
        g(&repo2, &["add", "-A"]);
        g(&repo2, &["commit", "-q", "-m", "init"]);
        let hb = g(&repo2, &["rev-parse", "HEAD"]);
        let before = snap(&repo2, "before");
        write(&repo2, "f.txt", "f2\n");
        g(&repo2, &["add", "f.txt"]);
        g(&repo2, &["commit", "-q", "-m", "turn commit"]);
        let ha = g(&repo2, &["rev-parse", "HEAD"]);
        let after = snap(&repo2, "after");
        refs(&repo2, sid, "t1", &before, &after);
        // A later, unrelated commit.
        write(&repo2, "other.txt", "later\n");
        g(&repo2, &["add", "other.txt"]);
        g(&repo2, &["commit", "-q", "-m", "later work"]);
        let later = g(&repo2, &["rev-parse", "HEAD"]);
        let file2 = session_file(
            &sess,
            &repo2,
            sid,
            &[entry(
                sid,
                "t1",
                "commit work",
                &before,
                &after,
                Some(&hb),
                Some(&ha),
                &[&ha],
                &[("f.txt", "M")],
                "2026-09-29T10:00:00Z",
            )],
        );
        let r = undo_turn(&repo2, &file2, "t1", false).unwrap();
        assert!(!r.head_reset, "{r:?}");
        assert_eq!(r.warning.as_deref(), Some(HEAD_WARNING));
        assert_eq!(g(&repo2, &["rev-parse", "HEAD"]), later);
        assert_eq!(
            std::fs::read_to_string(repo2.join("f.txt")).unwrap(),
            "f1\n"
        );
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&repo2).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn undo_cascade_restores_oldest_before_state() {
        let repo = temp_repo("cascade");
        let sid = "s1";
        write(&repo, "mod.txt", "m1\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);

        // t1: mod m1→m2, creates t1new.txt.
        let b1 = snap(&repo, "t1 before");
        write(&repo, "mod.txt", "m2\n");
        write(&repo, "t1new.txt", "from t1\n");
        let a1 = snap(&repo, "t1 after");
        refs(&repo, sid, "t1", &b1, &a1);
        let e1 = entry(
            sid,
            "t1",
            "first",
            &b1,
            &a1,
            None,
            None,
            &[],
            &[("mod.txt", "M"), ("t1new.txt", "A")],
            "2026-09-29T10:00:00Z",
        );
        // t2: mod m2→m3, creates t2new.txt.
        let b2 = snap(&repo, "t2 before");
        write(&repo, "mod.txt", "m3\n");
        write(&repo, "t2new.txt", "from t2\n");
        let a2 = snap(&repo, "t2 after");
        refs(&repo, sid, "t2", &b2, &a2);
        let e2 = entry(
            sid,
            "t2",
            "second",
            &b2,
            &a2,
            None,
            None,
            &[],
            &[("mod.txt", "M"), ("t2new.txt", "A")],
            "2026-09-29T10:01:00Z",
        );

        let sess = temp_dir("sess-cascade");
        let file = session_file(&sess, &repo, sid, &[e1, e2]);
        // Undoing the OLDER turn cascades: both turns undone, workspace back
        // to before t1 — including the shared file mod.txt.
        let r = undo_turn(&repo, &file, "t1", false).unwrap();
        assert_eq!(r.turns_undone, 2, "{r:?}");
        assert_eq!(
            std::fs::read_to_string(repo.join("mod.txt")).unwrap(),
            "m1\n"
        );
        assert!(!repo.join("t1new.txt").exists());
        assert!(!repo.join("t2new.txt").exists());
        assert!(r.restored.contains(&"mod.txt".to_string()), "{r:?}");
        assert!(r.deleted.contains(&"t1new.txt".to_string()), "{r:?}");
        assert!(r.deleted.contains(&"t2new.txt".to_string()), "{r:?}");
        for tid in ["t1", "t2"] {
            assert_eq!(
                g(&repo, &["rev-parse", &undone_ref(sid, tid)]),
                g(&repo, &["rev-parse", &turn_ref(sid, tid, "before")])
            );
        }
        // Undoing the newest turn alone only restores that turn.
        let repo2 = temp_repo("cascade-newest");
        write(&repo2, "mod.txt", "m1\n");
        g(&repo2, &["add", "-A"]);
        g(&repo2, &["commit", "-q", "-m", "init"]);
        let b1 = snap(&repo2, "t1 before");
        write(&repo2, "mod.txt", "m2\n");
        let a1 = snap(&repo2, "t1 after");
        refs(&repo2, sid, "t1", &b1, &a1);
        let b2 = snap(&repo2, "t2 before");
        write(&repo2, "mod.txt", "m3\n");
        let a2 = snap(&repo2, "t2 after");
        refs(&repo2, sid, "t2", &b2, &a2);
        let sess2 = temp_dir("sess-cascade2");
        let file2 = session_file(
            &sess2,
            &repo2,
            sid,
            &[
                entry(
                    sid,
                    "t1",
                    "first",
                    &b1,
                    &a1,
                    None,
                    None,
                    &[],
                    &[("mod.txt", "M")],
                    "2026-09-29T10:00:00Z",
                ),
                entry(
                    sid,
                    "t2",
                    "second",
                    &b2,
                    &a2,
                    None,
                    None,
                    &[],
                    &[("mod.txt", "M")],
                    "2026-09-29T10:01:00Z",
                ),
            ],
        );
        let r = undo_turn(&repo2, &file2, "t2", false).unwrap();
        assert_eq!(r.turns_undone, 1, "{r:?}");
        assert_eq!(
            std::fs::read_to_string(repo2.join("mod.txt")).unwrap(),
            "m2\n"
        );
        assert!(git_ok(
            &repo2,
            &["rev-parse", "-q", "--verify", &undone_ref(sid, "t1")]
        )
        .is_err());
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&repo2).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
        std::fs::remove_dir_all(&sess2).unwrap();
    }

    #[test]
    fn undo_cascade_conflict_preflight_writes_nothing() {
        let repo = temp_repo("casc-conflict");
        let sid = "s1";
        write(&repo, "mod.txt", "m1\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);

        let b1 = snap(&repo, "t1 before");
        write(&repo, "mod.txt", "m2\n");
        let a1 = snap(&repo, "t1 after");
        refs(&repo, sid, "t1", &b1, &a1);
        let e1 = entry(
            sid,
            "t1",
            "first",
            &b1,
            &a1,
            None,
            None,
            &[],
            &[("mod.txt", "M")],
            "2026-09-29T10:00:00Z",
        );
        let b2 = snap(&repo, "t2 before");
        write(&repo, "mod.txt", "m3\n");
        write(&repo, "t2new.txt", "from t2\n");
        let a2 = snap(&repo, "t2 after");
        refs(&repo, sid, "t2", &b2, &a2);
        let e2 = entry(
            sid,
            "t2",
            "second",
            &b2,
            &a2,
            None,
            None,
            &[],
            &[("mod.txt", "M"), ("t2new.txt", "A")],
            "2026-09-29T10:01:00Z",
        );

        // Edited after t2 ended → conflicts with the whole cascade.
        write(&repo, "mod.txt", "post-turn edit\n");
        let sess = temp_dir("sess-casc-conflict");
        let file = session_file(&sess, &repo, sid, &[e1, e2]);
        let r = undo_turn(&repo, &file, "t1", false).unwrap();
        assert_eq!(r.conflicts, vec!["mod.txt".to_string()], "{r:?}");
        assert_eq!(r.turns_undone, 0);
        // Nothing written: file untouched, no undone refs, no deletes.
        assert_eq!(
            std::fs::read_to_string(repo.join("mod.txt")).unwrap(),
            "post-turn edit\n"
        );
        assert!(repo.join("t2new.txt").exists());
        for tid in ["t1", "t2"] {
            assert!(git_ok(
                &repo,
                &["rev-parse", "-q", "--verify", &undone_ref(sid, tid)]
            )
            .is_err());
        }
        // force proceeds and restores to before t1 anyway.
        let r = undo_turn(&repo, &file, "t1", true).unwrap();
        assert_eq!(r.turns_undone, 2);
        assert_eq!(
            std::fs::read_to_string(repo.join("mod.txt")).unwrap(),
            "m1\n"
        );
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn undo_blocks_on_non_restorable_later_turn() {
        let repo = temp_repo("guard");
        let sid = "s1";
        write(&repo, "mod.txt", "m1\n");
        write(&repo, "del.txt", "d\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);

        let (_b1, _a1, e1) = make_turn(&repo, sid, "t1", "2026-09-29T10:00:00Z");
        // Turn t2: modify mod.txt again — but its snapshot refs are pruned.
        let b2 = snap(&repo, "t2 before");
        write(&repo, "mod.txt", "m3\n");
        write(&repo, "new.txt", "n2\n");
        let a2 = snap(&repo, "t2 after");
        // Deliberately NO refs for t2 → restorable=false.
        let e2 = entry(
            sid,
            "t2",
            "second turn",
            &b2,
            &a2,
            None,
            None,
            &[],
            &[("mod.txt", "M"), ("new.txt", "M")],
            "2026-09-29T10:01:00Z",
        );
        // A file-less turn after t2 (refs exist) — cascades mark it undone.
        let b3 = snap(&repo, "t3 before");
        let a3 = snap(&repo, "t3 after");
        refs(&repo, sid, "t3", &b3, &a3);
        let e3 = entry(
            sid,
            "t3",
            "no-op",
            &b3,
            &a3,
            None,
            None,
            &[],
            &[],
            "2026-09-29T10:02:00Z",
        );

        let sess = temp_dir("sess-guard");
        let file = session_file(&sess, &repo, sid, &[e1, e2, e3]);
        // t1 cannot be undone: crossing t2 would be required but t2's
        // snapshots are gone. Nothing may be written.
        let err = undo_turn(&repo, &file, "t1", false).unwrap_err();
        assert!(
            err.contains("无法跨过") && err.contains("存档已失效"),
            "{err}"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("mod.txt")).unwrap(),
            "m3\n"
        );
        assert!(git_ok(
            &repo,
            &["rev-parse", "-q", "--verify", &undone_ref(sid, "t1")]
        )
        .is_err());

        // Undoing the newest turn (t3, file-less) works alone.
        let r = undo_turn(&repo, &file, "t3", false).unwrap();
        assert_eq!(r.turns_undone, 1);

        // Once t2 is marked undone out-of-band, t1's cascade skips it (t3
        // was already undone) — t2's undone ref keeps it out.
        g(&repo, &["update-ref", &undone_ref(sid, "t2"), &b2]);
        // t1's conflict check: new.txt content changed since t1's after → force.
        let r = undo_turn(&repo, &file, "t1", true).unwrap();
        assert!(r.restored.contains(&"mod.txt".to_string()));
        assert_eq!(r.turns_undone, 1); // t2 was already undone, t3 already undone

        // Target itself non-restorable → refused.
        let e9 = entry(
            sid,
            "t9",
            "gone",
            &"0".repeat(40),
            &"1".repeat(40),
            None,
            None,
            &[],
            &[("mod.txt", "M")],
            "2026-09-29T10:03:00Z",
        );
        let file9 = session_file(&sess, &repo, sid, &[e9]);
        let err = undo_turn(&repo, &file9, "t9", true).unwrap_err();
        assert!(err.contains("无法撤回"), "{err}");
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn undo_cascade_resets_head_stepwise_when_commits_on_top() {
        let repo = temp_repo("casc-head");
        let sid = "s1";
        write(&repo, "f.txt", "f1\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);

        // t1 commits "turn commit 1" (f1→f2), t2 commits "turn commit 2" (f2→f3).
        let hb1 = g(&repo, &["rev-parse", "HEAD"]);
        let b1 = snap(&repo, "t1 before");
        write(&repo, "f.txt", "f2\n");
        g(&repo, &["add", "f.txt"]);
        g(&repo, &["commit", "-q", "-m", "turn commit 1"]);
        let ha1 = g(&repo, &["rev-parse", "HEAD"]);
        let a1 = snap(&repo, "t1 after");
        refs(&repo, sid, "t1", &b1, &a1);

        let b2 = snap(&repo, "t2 before");
        write(&repo, "f.txt", "f3\n");
        g(&repo, &["add", "f.txt"]);
        g(&repo, &["commit", "-q", "-m", "turn commit 2"]);
        let ha2 = g(&repo, &["rev-parse", "HEAD"]);
        let a2 = snap(&repo, "t2 after");
        refs(&repo, sid, "t2", &b2, &a2);

        let sess = temp_dir("sess-casc-head");
        let file = session_file(
            &sess,
            &repo,
            sid,
            &[
                entry(
                    sid,
                    "t1",
                    "commit 1",
                    &b1,
                    &a1,
                    Some(&hb1),
                    Some(&ha1),
                    &[&ha1],
                    &[("f.txt", "M")],
                    "2026-09-29T10:00:00Z",
                ),
                entry(
                    sid,
                    "t2",
                    "commit 2",
                    &b2,
                    &a2,
                    Some(&ha1),
                    Some(&ha2),
                    &[&ha2],
                    &[("f.txt", "M")],
                    "2026-09-29T10:01:00Z",
                ),
            ],
        );
        // Cascading undo of t1: t2 resets HEAD ha2→ha1, then t1 ha1→hb1.
        let r = undo_turn(&repo, &file, "t1", false).unwrap();
        assert!(r.head_reset, "{r:?}");
        assert_eq!(r.turns_undone, 2);
        assert!(r.warning.is_none(), "{r:?}");
        assert_eq!(g(&repo, &["rev-parse", "HEAD"]), hb1);
        assert_eq!(std::fs::read_to_string(repo.join("f.txt")).unwrap(), "f1\n");
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn undo_cascade_error_reports_done_count() {
        let repo = temp_repo("casc-fail");
        let sid = "s1";
        write(&repo, "mod.txt", "m1\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);

        // t1 claims it created `newdir`, but by undo time that path is a
        // non-empty directory → `remove_file` fails mid-cascade.
        let b1 = snap(&repo, "t1 before");
        write(&repo, "mod.txt", "m2\n");
        write(&repo, "newdir/inner.txt", "x\n");
        let a1 = snap(&repo, "t1 after");
        refs(&repo, sid, "t1", &b1, &a1);
        let e1 = entry(
            sid,
            "t1",
            "first",
            &b1,
            &a1,
            None,
            None,
            &[],
            &[("mod.txt", "M"), ("newdir", "A")],
            "2026-09-29T10:00:00Z",
        );

        let b2 = snap(&repo, "t2 before");
        write(&repo, "other.txt", "o\n");
        let a2 = snap(&repo, "t2 after");
        refs(&repo, sid, "t2", &b2, &a2);
        let e2 = entry(
            sid,
            "t2",
            "second",
            &b2,
            &a2,
            None,
            None,
            &[],
            &[("other.txt", "A")],
            "2026-09-29T10:01:00Z",
        );

        let sess = temp_dir("sess-casc-fail");
        let file = session_file(&sess, &repo, sid, &[e1, e2]);
        // t2 succeeds (newest first), t1 fails on restore — the error says
        // how many turns were already rolled back.
        let err = undo_turn(&repo, &file, "t1", true).unwrap_err();
        assert!(err.contains("已成功撤回 1 轮"), "{err}");
        // t2 was marked undone before the failure; t1's ref was not written.
        assert!(git_ok(
            &repo,
            &["rev-parse", "-q", "--verify", &undone_ref(sid, "t2")]
        )
        .is_ok());
        assert!(git_ok(
            &repo,
            &["rev-parse", "-q", "--verify", &undone_ref(sid, "t1")]
        )
        .is_err());
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }
    #[test]
    fn undo_protects_later_worktree_and_unrelated_staged_edits_before_head_reset() {
        let repo = temp_repo("undo-user-index");
        let sid = "s1";
        write(&repo, "turn.txt", "before\n");
        write(&repo, "user.txt", "base\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);
        let head_before = g(&repo, &["rev-parse", "HEAD"]);
        let before = snap(&repo, "before");
        write(&repo, "turn.txt", "agent edit\n");
        g(&repo, &["add", "turn.txt"]);
        g(&repo, &["commit", "-q", "-m", "turn"]);
        let head_after = g(&repo, &["rev-parse", "HEAD"]);
        let after = snap(&repo, "after");
        refs(&repo, sid, "t1", &before, &after);
        let sess = temp_dir("undo-user-index-session");
        let file = session_file(
            &sess,
            &repo,
            sid,
            &[entry(
                sid,
                "t1",
                "edit",
                &before,
                &after,
                Some(&head_before),
                Some(&head_after),
                &[&head_after],
                &[("turn.txt", "M")],
                "2026-10-29T00:00:00Z",
            )],
        );
        // Staged-only edits are invisible to the worktree blob check.
        write(&repo, "user.txt", "user staged content\n");
        g(&repo, &["add", "user.txt"]);
        write(&repo, "user.txt", "base\n");
        write(&repo, "turn.txt", "later user content\n");
        let index_before = g(&repo, &["write-tree"]);
        let result = undo_turn(&repo, &file, "t1", false).unwrap();
        assert_eq!(result.conflicts, vec!["turn.txt", "user.txt"]);
        assert_eq!(result.turns_undone, 0);
        assert_eq!(g(&repo, &["write-tree"]), index_before);
        assert_eq!(g(&repo, &["rev-parse", "HEAD"]), head_after);
        assert_eq!(
            std::fs::read_to_string(repo.join("turn.txt")).unwrap(),
            "later user content\n"
        );
        assert!(git_ok(&repo, &["rev-parse", "--verify", &undone_ref(sid, "t1")]).is_err());
        // Only the separately confirmed force override may reset that index.
        let forced = undo_turn(&repo, &file, "t1", true).unwrap();
        assert!(forced.head_reset);
        assert_eq!(forced.turns_undone, 1);
        assert_eq!(g(&repo, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            std::fs::read_to_string(repo.join("turn.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("user.txt")).unwrap(),
            "base\n"
        );
        std::fs::remove_dir_all(repo).unwrap();
        std::fs::remove_dir_all(sess).unwrap();
    }

    #[test]
    fn undo_batches_many_files_and_detects_conflicts_with_spaces() {
        let repo = temp_repo("batch-undo");
        let sid = "s-batch";
        for i in 0..12 {
            write(&repo, &format!("dir/file {i}.txt"), &format!("v1-{i}\n"));
        }
        write(&repo, "to remove.txt", "gone\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);

        let before = snap(&repo, "before");
        let names: Vec<String> = (0..12).map(|i| format!("dir/file {i}.txt")).collect();
        let mut files: Vec<(&str, &str)> = Vec::new();
        for (i, name) in names.iter().enumerate() {
            write(&repo, name, &format!("v2-{i}\n"));
            files.push((name.as_str(), "M"));
        }
        std::fs::remove_file(repo.join("to remove.txt")).unwrap();
        files.push(("to remove.txt", "D"));
        write(&repo, "brand new.txt", "created\n");
        files.push(("brand new.txt", "A"));

        let after = snap(&repo, "after");
        refs(&repo, sid, "t1", &before, &after);
        let e = entry(
            sid,
            "t1",
            "bulk edit",
            &before,
            &after,
            None,
            None,
            &[],
            &files,
            "2026-10-29T00:00:00Z",
        );
        let sess = temp_dir("sess-batch-undo");
        let file = session_file(&sess, &repo, sid, &[e]);

        // Post-turn edit to one file triggers conflict detection without writing.
        write(&repo, "dir/file 5.txt", "user edit\n");
        let conflict = undo_turn(&repo, &file, "t1", false).unwrap();
        assert_eq!(conflict.conflicts, vec!["dir/file 5.txt"]);
        assert_eq!(conflict.turns_undone, 0);

        // Force undo restores all modified/deleted files and removes created file.
        let res = undo_turn(&repo, &file, "t1", true).unwrap();
        assert_eq!(res.turns_undone, 1);
        assert_eq!(res.restored.len(), 13);
        assert_eq!(res.deleted, vec!["brand new.txt"]);
        for i in 0..12 {
            assert_eq!(
                std::fs::read_to_string(repo.join(format!("dir/file {i}.txt"))).unwrap(),
                format!("v1-{i}\n")
            );
        }
        assert_eq!(
            std::fs::read_to_string(repo.join("to remove.txt")).unwrap(),
            "gone\n"
        );
        assert!(!repo.join("brand new.txt").exists());
        std::fs::remove_dir_all(&repo).unwrap();
        std::fs::remove_dir_all(&sess).unwrap();
    }

    #[test]
    fn prune_undone_refs_caps_total_and_prefers_orphaned_oldest() {
        let repo = temp_repo("prune-undone");
        write(&repo, "a.txt", "a\n");
        g(&repo, &["add", "-A"]);
        g(&repo, &["commit", "-q", "-m", "init"]);
        let sha = g(&repo, &["rev-parse", "HEAD"]);

        // 2 orphaned undone markers from a dead session, 1 orphaned from an active
        // session, and 2 active undone markers whose snapshot pairs still exist.
        g(&repo, &["update-ref", &undone_ref("dead", "t1"), &sha]);
        g(&repo, &["update-ref", &undone_ref("dead", "t2"), &sha]);
        g(&repo, &["update-ref", &undone_ref("live", "t3"), &sha]);
        refs(&repo, "live", "t4", &sha, &sha);
        g(&repo, &["update-ref", &undone_ref("live", "t4"), &sha]);
        refs(&repo, "live", "t5", &sha, &sha);
        g(&repo, &["update-ref", &undone_ref("live", "t5"), &sha]);

        // Cap at 3: drops the 2 oldest orphaned dead-session markers first.
        prune_undone_refs(&repo, 3);
        let left = omp_refs(&repo);
        assert!(!left.contains(&undone_ref("dead", "t1")));
        assert!(!left.contains(&undone_ref("dead", "t2")));
        assert!(left.contains(&undone_ref("live", "t3")));
        assert!(left.contains(&undone_ref("live", "t4")));
        assert!(left.contains(&undone_ref("live", "t5")));

        // Cap at 1: drops orphaned t3 and active t4 (along with t4's snapshot refs
        // so t4 cannot become falsely restorable), keeping newest t5 intact.
        prune_undone_refs(&repo, 1);
        let left = omp_refs(&repo);
        assert!(!left.contains(&undone_ref("live", "t3")));
        assert!(!left.contains(&undone_ref("live", "t4")));
        assert!(!left.contains(&turn_ref("live", "t4", "before")));
        assert!(!left.contains(&turn_ref("live", "t4", "after")));
        assert!(left.contains(&undone_ref("live", "t5")));
        assert!(left.contains(&turn_ref("live", "t5", "before")));
        assert!(left.contains(&turn_ref("live", "t5", "after")));
        std::fs::remove_dir_all(&repo).unwrap();
    }
}

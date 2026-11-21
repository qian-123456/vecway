//! Full-text search over session transcripts (docs/ARCHITECTURE.md §7 `search_sessions`).
//!
//! A disposable SQLite file (`~/.omp-workspace/search.db`, see `paths::search_db_path`)
//! holds one row per *visible* user/assistant message (same rules as
//! `transcript::normalize_entry`; thinking, tool calls/results and hidden items
//! are never indexed). Rows are mirrored into an FTS5 `trigram` table (substring
//! match for tokens of 3+ chars); shorter tokens (1-2 CJK chars, ...) fall back to
//! `LIKE` scans. Every candidate is re-verified in Rust with simple per-char case
//! folding, so results are exact regardless of the SQL pre-filter.
//!
//! A dedicated low-priority thread keeps the index in sync: a full pass at
//! startup (incremental by file size + mtime, newest files first), then
//! debounced per-file updates driven by the catalog watcher. Growing files only
//! parse the appended bytes while the last indexed line is unchanged; shrunk or
//! rewritten files are reindexed.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::{params, params_from_iter, Connection, OpenFlags};
use serde_json::Value;
use tauri::Emitter as _;
use tracing::warn;

use super::scan;
use super::transcript::normalize_entry;
use crate::contracts::{
    SearchIndexStatus, SearchRole, SearchSegment, SessionSearchHit, TranscriptKind,
};
use crate::paths;
use crate::state::AppState;

/// Bump to drop and rebuild the index file after a schema/extraction change.
const SCHEMA_VERSION: i64 = 2;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 1000;
const MAX_TOKENS: usize = 8;
/// Longest text kept per message (bytes); the tail of a gigantic answer is not searchable.
const MAX_TEXT_BYTES: usize = 256 * 1024;
/// Lines larger than this are skipped outright (pasted binaries etc.).
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
/// Prefix bytes hashed in full for small/medium files; larger files sample fixed windows.
const PREFIX_FULL_CAP: u64 = 16 * 1024;
const PREFIX_SAMPLE_LEN: usize = 4096;
/// Maximum recent entries scanned for short (1-2 char) queries that bypass FTS5.
const SHORT_QUERY_SCAN_CAP: usize = 20_000;
const SNIPPET_CHARS: usize = 160;
const SNIPPET_LEAD_CHARS: usize = 40;
const EMIT_INTERVAL: Duration = Duration::from_millis(250);
const DEBOUNCE: Duration = Duration::from_millis(1000);
/// Maximum wait from the first pending watcher event before flushing to FTS,
/// preventing starvation during continuous streaming across sessions.
const MAX_DEBOUNCE_WAIT: Duration = Duration::from_secs(5);

const ROLE_USER: i64 = 0;
const ROLE_ASSISTANT: i64 = 1;

// ---------------------------------------------------------------------------
// Public API: commands, startup, watcher hooks
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn search_sessions(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SessionSearchHit>, String> {
    let limit = limit
        .map_or(DEFAULT_LIMIT, |l| l as usize)
        .clamp(1, MAX_LIMIT);
    tokio::task::spawn_blocking(move || search_db(&paths::search_db_path(), &query, limit))
        .await
        .map_err(|e| format!("search_sessions: {e}"))?
}

#[tauri::command]
pub async fn search_index_status() -> Result<SearchIndexStatus, String> {
    Ok(status().clone())
}

enum Msg {
    Rescan,
    Paths(Vec<PathBuf>),
}

static TX: OnceLock<Mutex<Sender<Msg>>> = OnceLock::new();

static STATUS: Mutex<SearchIndexStatus> = Mutex::new(SearchIndexStatus {
    indexed: 0,
    total: 0,
    building: true,
});

fn status() -> parking_lot::MutexGuard<'static, SearchIndexStatus> {
    STATUS.lock()
}

/// Start the background indexer thread (never blocks startup).
pub fn init(state: &AppState) {
    let (tx, rx) = mpsc::channel::<Msg>();
    if TX.set(Mutex::new(tx)).is_err() {
        return; // already running
    }
    let app = state.app.clone();
    let spawned = std::thread::Builder::new()
        .name("search-indexer".into())
        .spawn(move || {
            set_background_priority();
            let emit = move |s: &SearchIndexStatus| {
                let _ = app.emit("search_index:progress", s);
            };
            run(
                &paths::search_db_path(),
                &paths::omp_sessions_dir(),
                rx,
                &emit,
            );
        });
    if let Err(e) = spawned {
        warn!("search indexer thread: {e}");
        status().building = false;
    }
}

/// The catalog saw a non-session-file change: reconcile everything.
pub fn request_rescan() {
    send(Msg::Rescan);
}

/// Session files the catalog saw change (modified, created or removed).
pub fn request_paths(paths: Vec<PathBuf>) {
    if !paths.is_empty() {
        send(Msg::Paths(paths));
    }
}

fn send(msg: Msg) {
    if let Some(tx) = TX.get() {
        let _ = tx.lock().send(msg);
    }
}

#[cfg(target_os = "macos")]
fn set_background_priority() {
    // PRIO_DARWIN_THREAD (3) / PRIO_DARWIN_BG (0x1000): background QoS for this thread only.
    // SAFETY: plain syscall without pointer arguments.
    unsafe {
        libc::setpriority(3, 0, 0x1000);
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn set_background_priority() {
    // SAFETY: plain syscall without pointer arguments; on Linux `who = 0` is the calling thread.
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
}

#[cfg(not(unix))]
fn set_background_priority() {}

fn run(db: &Path, dir: &Path, rx: mpsc::Receiver<Msg>, emit: &dyn Fn(&SearchIndexStatus)) {
    let mut conn = match open_rw(db) {
        Ok(c) => c,
        Err(e) => {
            warn!("search index unavailable: {e}");
            let mut s = status();
            s.building = false;
            emit(&s);
            return;
        }
    };
    if let Err(e) = sync_all(&mut conn, dir, emit) {
        warn!("search index build: {e}");
    }
    finish(emit);
    loop {
        let Ok(first) = rx.recv() else { return };
        let (rescan, pending) = collect_debounced_batch(&rx, first, DEBOUNCE, MAX_DEBOUNCE_WAIT);
        let res = if rescan {
            sync_all(&mut conn, dir, emit)
        } else {
            sync_paths(&mut conn, dir, &pending)
        };
        if let Err(e) = res {
            warn!("search index update: {e}");
        }
        finish(emit);
    }
}

/// Debounce incoming file-change bursts until the stream is quiet for `debounce`,
/// capped at `max_wait` from the first pending event so continuous writes cannot
/// starve FTS commits indefinitely.
fn collect_debounced_batch(
    rx: &mpsc::Receiver<Msg>,
    first: Msg,
    debounce: Duration,
    max_wait: Duration,
) -> (bool, HashSet<PathBuf>) {
    let mut rescan = false;
    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut absorb = |m: Msg| match m {
        Msg::Rescan => rescan = true,
        Msg::Paths(p) => pending.extend(p),
    };
    absorb(first);
    let deadline = Instant::now() + max_wait;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(debounce.min(remaining)) {
            Ok(m) => absorb(m),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    (rescan, pending)
}

fn finish(emit: &dyn Fn(&SearchIndexStatus)) {
    let mut s = status();
    s.building = false;
    s.indexed = s.total;
    emit(&s);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

fn open_rw(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match try_open_rw(path) {
        Ok(c) => Ok(c),
        Err(e) => {
            // Disposable: a corrupt or incompatible file is deleted and rebuilt.
            warn!("search index reset after open error: {e}");
            remove_db_files(path);
            try_open_rw(path)
        }
    }
}

fn remove_db_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    for ext in ["-wal", "-shm"] {
        let mut p = path.as_os_str().to_owned();
        p.push(ext);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }
}

fn try_open_rw(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(10))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != SCHEMA_VERSION {
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS entries_ai; DROP TRIGGER IF EXISTS entries_ad;
             DROP TABLE IF EXISTS entries_fts; DROP TABLE IF EXISTS entries;
             DROP TABLE IF EXISTS files;",
        )?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            session_id TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL,
            mtime_ns INTEGER NOT NULL,
            indexed_bytes INTEGER NOT NULL DEFAULT 0,
            tail_len INTEGER NOT NULL DEFAULT 0,
            tail_hash INTEGER NOT NULL DEFAULT 0,
            prefix_hash INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            role INTEGER NOT NULL,
            ts TEXT NOT NULL,
            text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS entries_file ON entries(file_id);
        CREATE INDEX IF NOT EXISTS entries_ts ON entries(ts DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
            text, content='entries', content_rowid='id', tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
            INSERT INTO entries_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;",
    )?;
    if version != SCHEMA_VERSION {
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    }
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

struct FileRow {
    id: i64,
    size: i64,
    mtime_ns: i64,
    indexed_bytes: i64,
    tail_len: i64,
    tail_hash: i64,
    prefix_hash: i64,
}

fn mtime_ns(t: std::time::SystemTime) -> i64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos().min(i64::MAX as u128) as i64)
}

fn file_row(conn: &Connection, path: &str) -> rusqlite::Result<Option<FileRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, size, mtime_ns, indexed_bytes, tail_len, tail_hash, prefix_hash
         FROM files WHERE path = ?1",
    )?;
    let mut rows = stmt.query([path])?;
    Ok(match rows.next()? {
        Some(r) => Some(FileRow {
            id: r.get(0)?,
            size: r.get(1)?,
            mtime_ns: r.get(2)?,
            indexed_bytes: r.get(3)?,
            tail_len: r.get(4)?,
            tail_hash: r.get(5)?,
            prefix_hash: r.get(6)?,
        }),
        None => None,
    })
}

fn bump_status(emit: &dyn Fn(&SearchIndexStatus), last: &mut Instant) {
    let mut s = status();
    s.indexed = (s.indexed + 1).min(s.total);
    if last.elapsed() >= EMIT_INTERVAL {
        *last = Instant::now();
        emit(&s);
    }
}

/// Reconcile the whole index with the sessions directory.
fn sync_all(
    conn: &mut Connection,
    dir: &Path,
    emit: &dyn Fn(&SearchIndexStatus),
) -> Result<(), String> {
    let mut files = scan::list_files(dir);
    let known: HashMap<String, (i64, i64)> = {
        let mut stmt = conn
            .prepare("SELECT path, size, mtime_ns FROM files")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))
            .map_err(err)?;
        rows.filter_map(Result::ok).collect()
    };
    // Purge rows of files that no longer exist; an unreadable sessions dir
    // must not wipe the index.
    if dir.is_dir() {
        let live: HashSet<String> = files
            .iter()
            .map(|(p, _, _)| p.to_string_lossy().into_owned())
            .collect();
        for path in known.keys().filter(|p| !live.contains(*p)) {
            purge_path(conn, path).map_err(err)?;
        }
    }
    // Newest first so recent sessions become searchable first.
    files.sort_by_key(|f| std::cmp::Reverse(f.2));
    let (todo, done): (Vec<_>, Vec<_>) = files.into_iter().partition(|(p, size, mtime)| {
        known.get(p.to_string_lossy().as_ref()) != Some(&(*size as i64, mtime_ns(*mtime)))
    });
    {
        let mut s = status();
        s.total = (todo.len() + done.len()) as u32;
        s.indexed = done.len() as u32;
        s.building = !todo.is_empty();
        emit(&s);
    }
    let mut last = Instant::now();
    for (path, _, _) in todo {
        if let Err(e) = index_file(conn, &path) {
            warn!("search index {}: {e}", path.display());
        }
        bump_status(emit, &mut last);
    }
    Ok(())
}

/// Update only the given files (created/changed/removed).
fn sync_paths(conn: &mut Connection, dir: &Path, paths: &HashSet<PathBuf>) -> Result<(), String> {
    for path in paths {
        let key = path.to_string_lossy();
        match std::fs::metadata(path) {
            Ok(md) if md.is_file() && scan::is_session_file(dir, path) => {
                let mtime = mtime_ns(md.modified().unwrap_or(std::time::UNIX_EPOCH));
                let same = file_row(conn, &key)
                    .map_err(err)?
                    .is_some_and(|r| r.size == md.len() as i64 && r.mtime_ns == mtime);
                if !same {
                    if let Err(e) = index_file(conn, path) {
                        warn!("search index {}: {e}", path.display());
                    }
                }
            }
            Ok(_) => {}
            Err(_) => purge_path(conn, &key).map_err(err)?,
        }
    }
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
        .map_err(err)?;
    status().total = total as u32;
    Ok(())
}

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn purge_path(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    if let Some(row) = file_row(conn, path)? {
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM entries WHERE file_id = ?1", [row.id])?;
        tx.execute("DELETE FROM files WHERE id = ?1", [row.id])?;
        tx.commit()?;
    }
    Ok(())
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;

fn fnv1a_update(h: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *h ^= u64::from(*b);
        *h = h.wrapping_mul(FNV_PRIME);
    }
}

/// FNV-1a: stable across runs/toolchains (the hash is persisted).
fn fnv1a(bytes: &[u8]) -> i64 {
    let mut h = FNV_OFFSET;
    fnv1a_update(&mut h, bytes);
    h as i64
}

/// Fingerprint the already-indexed prefix `[0..indexed_bytes)`: hashes the full
/// prefix for files up to `PREFIX_FULL_CAP`, or three 4 KiB windows (start/header,
/// 1/3, and 2/3) for larger files so in-place edits earlier in the file are detected.
fn prefix_fingerprint(f: &mut File, indexed_bytes: u64) -> std::io::Result<i64> {
    if indexed_bytes == 0 {
        return Ok(0);
    }
    let mut h = FNV_OFFSET;
    fnv1a_update(&mut h, &indexed_bytes.to_le_bytes());
    if indexed_bytes <= PREFIX_FULL_CAP {
        f.seek(SeekFrom::Start(0))?;
        let mut buf = vec![0u8; indexed_bytes as usize];
        f.read_exact(&mut buf)?;
        fnv1a_update(&mut h, &buf);
    } else {
        let max_off = indexed_bytes - PREFIX_SAMPLE_LEN as u64;
        let offsets = [
            0,
            (indexed_bytes / 3).min(max_off),
            ((indexed_bytes / 3) * 2).min(max_off),
        ];
        let mut buf = [0u8; PREFIX_SAMPLE_LEN];
        for off in offsets {
            f.seek(SeekFrom::Start(off))?;
            f.read_exact(&mut buf)?;
            fnv1a_update(&mut h, &buf);
        }
    }
    Ok(h as i64)
}

/// True when both the last indexed line ending at `row.indexed_bytes` AND the
/// header/prefix fingerprint match what was indexed (so appended bytes can be
/// parsed in isolation without leaving stale hits from earlier edits).
fn prefix_unchanged(f: &mut File, row: &FileRow) -> std::io::Result<bool> {
    if row.indexed_bytes <= 0 || row.tail_len < 0 || row.tail_len + 1 > row.indexed_bytes {
        return Ok(false);
    }
    let len = row.tail_len as usize;
    let start = (row.indexed_bytes - row.tail_len - 1) as u64;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; len + 1];
    f.read_exact(&mut buf)?;
    if buf[len] != b'\n' || fnv1a(&buf[..len]) != row.tail_hash {
        return Ok(false);
    }
    Ok(prefix_fingerprint(f, row.indexed_bytes as u64)? == row.prefix_hash)
}

struct Extracted {
    entry_id: String,
    role: i64,
    ts: String,
    text: String,
}

/// Visible user/assistant text of one jsonl line (None = nothing to index).
fn extract(line: &[u8]) -> Option<Extracted> {
    // Cheap byte pre-filter: tool results and other bulk lines never parse as JSON.
    const NEEDLES: [&[u8]; 3] = [
        b"\"role\":\"user\"",
        b"\"role\":\"assistant\"",
        b"skill-prompt",
    ];
    if !NEEDLES.iter().any(|n| contains(line, n)) {
        return None;
    }
    let v: Value = serde_json::from_slice(line).ok()?;
    let item = normalize_entry(&v)?;
    let role = match item.kind {
        TranscriptKind::User => ROLE_USER,
        TranscriptKind::Assistant => ROLE_ASSISTANT,
        _ => return None,
    };
    if item.hidden {
        return None;
    }
    let mut text = item.text.filter(|t| !t.trim().is_empty())?;
    if text.len() > MAX_TEXT_BYTES {
        let mut cut = MAX_TEXT_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    Some(Extracted {
        entry_id: item.id,
        role,
        ts: item.ts,
        text,
    })
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// (Re)index one file: parse only appended bytes when the indexed prefix is intact.
fn index_file(conn: &mut Connection, path: &Path) -> Result<(), String> {
    let key = path.to_string_lossy().into_owned();
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let md = f.metadata().map_err(|e| e.to_string())?;
    let size = md.len() as i64;
    let mtime = mtime_ns(md.modified().unwrap_or(std::time::UNIX_EPOCH));
    let prior = file_row(conn, &key).map_err(err)?;

    let tx = conn.transaction().map_err(err)?;
    let (file_id, session_id, start) = match &prior {
        Some(row)
            if size >= row.indexed_bytes && prefix_unchanged(&mut f, row).unwrap_or(false) =>
        {
            let sid: String = tx
                .query_row(
                    "SELECT session_id FROM files WHERE id = ?1",
                    [row.id],
                    |r| r.get(0),
                )
                .map_err(err)?;
            (row.id, sid, row.indexed_bytes as u64)
        }
        _ => {
            if let Some(row) = &prior {
                tx.execute("DELETE FROM entries WHERE file_id = ?1", [row.id])
                    .map_err(err)?;
            }
            let sid = super::parse::read_head(path)
                .ok()
                .flatten()
                .map(|h| h.id)
                .unwrap_or_default();
            let id = match &prior {
                Some(row) => row.id,
                None => {
                    tx.execute(
                        "INSERT INTO files (path, size, mtime_ns) VALUES (?1, ?2, ?3)",
                        params![key, size, mtime],
                    )
                    .map_err(err)?;
                    tx.last_insert_rowid()
                }
            };
            (id, sid, 0)
        }
    };

    let mut indexed_bytes = start as i64;
    let mut tail = (0i64, 0i64);
    let mut prefix_hash = 0i64;
    if let (true, Some(row)) = (start > 0, &prior) {
        tail = (row.tail_len, row.tail_hash);
        prefix_hash = row.prefix_hash;
    }
    let mut have_last = false;
    if !session_id.is_empty() {
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        let mut reader = BufReader::with_capacity(
            256 * 1024,
            (&mut f).take((size as u64).saturating_sub(start)),
        );
        let mut line: Vec<u8> = Vec::new();
        let mut last_line: Vec<u8> = Vec::new();
        let mut insert = tx
            .prepare_cached(
                "INSERT INTO entries (file_id, session_id, entry_id, role, ts, text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(err)?;
        loop {
            line.clear();
            let n = reader
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            if line.last() != Some(&b'\n') {
                break; // incomplete trailing line: left for the next pass
            }
            indexed_bytes += n as i64;
            line.pop();
            if line.len() <= MAX_LINE_BYTES {
                if let Some(e) = extract(&line) {
                    insert
                        .execute(params![
                            file_id, session_id, e.entry_id, e.role, e.ts, e.text
                        ])
                        .map_err(err)?;
                }
            }
            std::mem::swap(&mut line, &mut last_line);
            have_last = true;
        }
        if have_last {
            tail = (last_line.len() as i64, fnv1a(&last_line));
        }
    } else {
        indexed_bytes = 0;
    }
    if indexed_bytes > 0 && (have_last || start == 0) {
        prefix_hash =
            prefix_fingerprint(&mut f, indexed_bytes as u64).map_err(|e| e.to_string())?;
    } else if indexed_bytes == 0 {
        prefix_hash = 0;
    }
    tx.execute(
        "UPDATE files SET session_id = ?2, size = ?3, mtime_ns = ?4, indexed_bytes = ?5,
                tail_len = ?6, tail_hash = ?7, prefix_hash = ?8 WHERE id = ?1",
        params![
            file_id,
            session_id,
            size,
            mtime,
            indexed_bytes,
            tail.0,
            tail.1,
            prefix_hash
        ],
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// Simple per-char lowercase (1:1 char mapping, so char indexes stay aligned
/// between a text and its folded form).
fn fold_char(c: char) -> char {
    if c.is_ascii() {
        c.to_ascii_lowercase()
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

fn fold(s: &str) -> String {
    if s.is_ascii() {
        s.to_ascii_lowercase()
    } else {
        s.chars().map(fold_char).collect()
    }
}

/// SQLite `LIKE` only folds ASCII; a token is a safe pre-filter when no
/// non-ASCII cased character is in it.
fn like_safe(tok: &str) -> bool {
    tok.chars()
        .all(|c| c.is_ascii() || c.to_lowercase().eq(c.to_uppercase()))
}

fn tokenize(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in query.split_whitespace() {
        let f = fold(t);
        if !out.contains(&f) {
            out.push(f);
        }
        if out.len() == MAX_TOKENS {
            break;
        }
    }
    out
}

struct Best {
    score: f64,
    ts: String,
    entry_id: String,
    role: i64,
    text: String,
    count: u32,
}

/// Relevance of a message that already contains every token (folded).
fn relevance(folded: &str, tokens: &[String], phrase: &str) -> Option<f64> {
    let mut first = usize::MAX;
    for t in tokens {
        first = first.min(folded.find(t.as_str())?);
    }
    let mut score = 1.0;
    if tokens.len() > 1 && folded.contains(phrase) {
        score += 2.0;
    }
    score += 1.0 / (1.0 + first as f64 / 200.0);
    score += 1.0 / (1.0 + folded.len() as f64 / 2000.0);
    Some(score)
}

fn like_pattern(tok: &str) -> String {
    let mut p = String::from("%");
    for c in tok.chars() {
        if matches!(c, '%' | '_' | '\\') {
            p.push('\\');
        }
        p.push(c);
    }
    p.push('%');
    p
}

fn short_query_match_cap(limit: usize) -> usize {
    limit.saturating_mul(20).clamp(500, 4_000)
}

fn search_db(db: &Path, query: &str, limit: usize) -> Result<Vec<SessionSearchHit>, String> {
    search_db_bounded(
        db,
        query,
        limit,
        SHORT_QUERY_SCAN_CAP,
        short_query_match_cap(limit),
    )
}

fn search_db_bounded(
    db: &Path,
    query: &str,
    limit: usize,
    short_scan_cap: usize,
    short_match_cap: usize,
) -> Result<Vec<SessionSearchHit>, String> {
    let tokens = tokenize(query.trim());
    if tokens.is_empty() || !db.exists() {
        return Ok(Vec::new());
    }
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(err)?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(err)?;
    let phrase = tokens.join(" ");

    let long: Vec<&String> = tokens.iter().filter(|t| t.chars().count() >= 3).collect();
    let short_only = long.is_empty();
    let all_like_safe = tokens.iter().all(|t| like_safe(t));
    let mut args: Vec<String> = Vec::new();
    let mut sql = String::from("SELECT e.session_id, e.entry_id, e.role, e.ts, e.text FROM ");
    if short_only {
        // Short 1-2 char queries bypass FTS5 trigram lookup; bound the scan to
        // the newest `short_scan_cap` entries so they cannot scan the whole DB.
        sql.push_str(&format!(
            "(SELECT session_id, entry_id, role, ts, text FROM entries ORDER BY ts DESC LIMIT {short_scan_cap}) e WHERE 1=1"
        ));
    } else {
        let m = long
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        args.push(m);
        sql.push_str(
            "entries_fts JOIN entries e ON e.id = entries_fts.rowid WHERE entries_fts MATCH ?1",
        );
    }
    for t in tokens
        .iter()
        .filter(|t| t.chars().count() < 3 && like_safe(t))
    {
        args.push(like_pattern(t));
        sql.push_str(&format!(" AND e.text LIKE ?{} ESCAPE '\\'", args.len()));
    }
    if short_only && all_like_safe {
        sql.push_str(&format!(" LIMIT {short_match_cap}"));
    }

    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut rows = stmt.query(params_from_iter(args.iter())).map_err(err)?;
    let mut best: HashMap<String, Best> = HashMap::new();
    let mut matched_rows = 0usize;
    while let Some(r) = rows.next().map_err(err)? {
        let text_ref = r.get_ref(4).map_err(err)?;
        let Ok(text) = text_ref.as_str() else {
            continue;
        };
        let folded = fold(text);
        let Some(score) = relevance(&folded, &tokens, &phrase) else {
            continue;
        };
        matched_rows += 1;
        let session_id: String = r.get(0).map_err(err)?;
        let ts: String = r.get(3).map_err(err)?;
        match best.get_mut(&session_id) {
            Some(b) => {
                b.count += 1;
                if (score, &ts) > (b.score, &b.ts) {
                    b.score = score;
                    b.ts = ts;
                    b.entry_id = r.get(1).map_err(err)?;
                    b.role = r.get(2).map_err(err)?;
                    b.text = text.to_string();
                }
            }
            None => {
                best.insert(
                    session_id,
                    Best {
                        score,
                        ts,
                        entry_id: r.get(1).map_err(err)?,
                        role: r.get(2).map_err(err)?,
                        text: text.to_string(),
                        count: 1,
                    },
                );
            }
        }
        if short_only && matched_rows >= short_match_cap {
            break;
        }
    }
    let mut ranked: Vec<(String, Best)> = best.into_iter().collect();
    ranked.sort_by(|a, b| {
        b.1.score
            .total_cmp(&a.1.score)
            .then_with(|| b.1.ts.cmp(&a.1.ts))
            .then_with(|| a.0.cmp(&b.0))
    });
    ranked.truncate(limit);
    Ok(ranked
        .into_iter()
        .map(|(session_id, b)| {
            let (segments, truncated_start, truncated_end) = snippet(&b.text, &tokens);
            SessionSearchHit {
                session_id,
                entry_id: b.entry_id,
                role: if b.role == ROLE_ASSISTANT {
                    SearchRole::Assistant
                } else {
                    SearchRole::User
                },
                ts: b.ts,
                segments,
                truncated_start,
                truncated_end,
                match_count: b.count,
            }
        })
        .collect())
}

/// ~160 char window around the first match, split into hit / non-hit runs.
fn snippet(text: &str, tokens: &[String]) -> (Vec<SearchSegment>, bool, bool) {
    let chars: Vec<char> = text.chars().collect();
    let folded: Vec<char> = chars.iter().map(|c| fold_char(*c)).collect();
    let toks: Vec<Vec<char>> = tokens.iter().map(|t| t.chars().collect()).collect();

    let first = toks
        .iter()
        .filter_map(|t| find_from(&folded, t, 0))
        .min()
        .unwrap_or(0);
    let start = first.saturating_sub(SNIPPET_LEAD_CHARS);
    let end = (start + SNIPPET_CHARS).min(chars.len());

    let mut hit = vec![false; end - start];
    for t in &toks {
        let mut from = start;
        while let Some(p) = find_from(&folded[..end], t, from) {
            for flag in &mut hit[p - start..(p + t.len()).min(end) - start] {
                *flag = true;
            }
            from = p + 1;
        }
    }
    let mut segments: Vec<SearchSegment> = Vec::new();
    for (i, c) in chars[start..end].iter().enumerate() {
        match segments.last_mut() {
            Some(seg) if seg.hit == hit[i] => seg.text.push(*c),
            _ => segments.push(SearchSegment {
                text: c.to_string(),
                hit: hit[i],
            }),
        }
    }
    (segments, start > 0, end < chars.len())
}

fn find_from(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() || from > hay.len() - needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ompws-search-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("sessions/bucket")).unwrap();
        d
    }

    fn header(id: &str) -> String {
        format!(
            "{{\"type\":\"title\",\"v\":1,\"title\":\"\",\"updatedAt\":\"2026-01-01T00:00:00Z\"}}\n\
             {{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/tmp\"}}\n"
        )
    }

    fn user(id: &str, ts: &str, text: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"{id}\",\"parentId\":null,\"timestamp\":\"{ts}\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":{}}}]}}}}\n",
            serde_json::to_string(text).unwrap()
        )
    }

    fn assistant(id: &str, ts: &str, text: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"{id}\",\"parentId\":null,\"timestamp\":\"{ts}\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"thinking\",\"thinking\":\"secretthought\"}},{{\"type\":\"text\",\"text\":{}}},{{\"type\":\"toolCall\",\"id\":\"t1\",\"name\":\"bash\",\"arguments\":{{\"command\":\"toolcallarg\"}}}}]}}}}\n",
            serde_json::to_string(text).unwrap()
        )
    }

    fn tool_result(id: &str, text: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"{id}\",\"parentId\":null,\"timestamp\":\"2026-01-01T00:00:09Z\",\"message\":{{\"role\":\"toolResult\",\"toolCallId\":\"t1\",\"toolName\":\"bash\",\"content\":[{{\"type\":\"text\",\"text\":{}}}]}}}}\n",
            serde_json::to_string(text).unwrap()
        )
    }

    struct Fx {
        root: PathBuf,
        dir: PathBuf,
        db: PathBuf,
    }

    impl Fx {
        fn new(tag: &str) -> Self {
            let root = tmp(tag);
            Self {
                dir: root.join("sessions"),
                db: root.join("search.db"),
                root,
            }
        }
        fn file(&self, name: &str) -> PathBuf {
            self.dir.join("bucket").join(format!("{name}.jsonl"))
        }
        fn write(&self, name: &str, content: &str) {
            std::fs::write(self.file(name), content).unwrap();
        }
        fn sync(&self) -> Connection {
            let mut conn = open_rw(&self.db).unwrap();
            sync_all(&mut conn, &self.dir, &|_| {}).unwrap();
            conn
        }
        fn sync_with(&self, conn: &mut Connection) {
            sync_all(conn, &self.dir, &|_| {}).unwrap();
        }
        fn q(&self, q: &str) -> Vec<SessionSearchHit> {
            search_db(&self.db, q, 50).unwrap()
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn joined(h: &SessionSearchHit) -> String {
        h.segments.iter().map(|s| s.text.as_str()).collect()
    }

    fn hits_text(h: &SessionSearchHit) -> String {
        h.segments
            .iter()
            .filter(|s| s.hit)
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("|")
    }

    #[test]
    fn cjk_short_queries_and_mixed_text() {
        let fx = Fx::new("cjk");
        fx.write(
            "a",
            &(header("sa")
                + &user("u1", "2026-01-01T00:00:01Z", "请帮我优化数据库查询性能")
                + &assistant("a1", "2026-01-01T00:00:02Z", "好的，使用 Index 优化 SQL")),
        );
        fx.write(
            "b",
            &(header("sb") + &user("u2", "2026-01-01T00:00:03Z", "今天天气不错 hello World")),
        );
        fx.sync();
        // 1 char
        let r = fx.q("优");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].session_id, "sa");
        assert_eq!(r[0].match_count, 2);
        // 2 chars
        let r = fx.q("天气");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].session_id, "sb");
        assert_eq!(hits_text(&r[0]), "天气");
        // mixed + case-insensitive substring inside a word
        let r = fx.q("WORLD");
        assert_eq!(r[0].session_id, "sb");
        assert_eq!(hits_text(&r[0]), "World");
        let r = fx.q("orl");
        assert_eq!(r.len(), 1);
        // 3+ chars CJK via FTS
        assert_eq!(fx.q("数据库")[0].session_id, "sa");
        // 2-char CJK + English token
        let r = fx.q("优化 sql");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].role, SearchRole::Assistant);
        assert_eq!(r[0].entry_id, "a1");
        assert!(fx.q("   ").is_empty());
        assert!(fx.q("不存在的词语xyz").is_empty());
    }

    #[test]
    fn multi_token_and_in_same_entry_and_one_hit_per_session() {
        let fx = Fx::new("and");
        fx.write(
            "a",
            &(header("sa")
                + &user("u1", "2026-01-01T00:00:01Z", "alpha only here")
                + &user("u2", "2026-01-01T00:00:02Z", "beta only here")
                + &user("u3", "2026-01-01T00:00:03Z", "alpha beta together")
                + &assistant("a4", "2026-01-01T00:00:04Z", "beta then alpha again")),
        );
        fx.sync();
        let r = fx.q("alpha beta");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].match_count, 2);
        // Phrase order wins over later-but-unordered entry.
        assert_eq!(r[0].entry_id, "u3");
        // Tokens split across entries never match.
        fx.write(
            "b",
            &(header("sb")
                + &user("x1", "2026-01-01T00:00:01Z", "gamma")
                + &user("x2", "2026-01-01T00:00:02Z", "delta")),
        );
        let mut c = fx.sync();
        fx.sync_with(&mut c);
        assert!(fx.q("gamma delta").is_empty());
        assert_eq!(fx.q("alpha").len(), 1);
    }

    #[test]
    fn snippet_reassembles_to_substring_with_hit_flags() {
        let fx = Fx::new("snip");
        let long = format!(
            "{}关键词出现在这里 Needle 还有更多{}",
            "前缀".repeat(60),
            "后缀".repeat(80)
        );
        fx.write(
            "a",
            &(header("sa") + &user("u1", "2026-01-01T00:00:01Z", &long)),
        );
        fx.sync();
        let r = fx.q("关键词 needle");
        let h = &r[0];
        let s = joined(h);
        assert!(long.contains(&s), "snippet must be a real substring");
        assert!(h.truncated_start && h.truncated_end);
        assert_eq!(s.chars().count(), SNIPPET_CHARS);
        assert_eq!(hits_text(h), "关键词|Needle");
        // Short text: not truncated, whole text is one snippet.
        fx.write(
            "b",
            &(header("sb") + &user("u2", "2026-01-01T00:00:01Z", "短文本 ok")),
        );
        let mut c = open_rw(&fx.db).unwrap();
        fx.sync_with(&mut c);
        let r = fx.q("ok");
        assert_eq!(joined(&r[0]), "短文本 ok");
        assert!(!r[0].truncated_start && !r[0].truncated_end);
    }

    #[test]
    fn tool_output_thinking_and_hidden_not_indexed() {
        let fx = Fx::new("skip");
        let reminder = "{\"type\":\"message\",\"id\":\"h1\",\"parentId\":null,\"timestamp\":\"2026-01-01T00:00:05Z\",\"message\":{\"role\":\"user\",\"content\":\"<system-reminder>hiddenreminder</system-reminder>\"}}\n";
        fx.write(
            "a",
            &(header("sa")
                + &user("u1", "2026-01-01T00:00:01Z", "visible words")
                + &assistant("a1", "2026-01-01T00:00:02Z", "answer text")
                + &tool_result("t1", "toolresultbody")
                + reminder),
        );
        fx.sync();
        assert!(fx.q("toolresultbody").is_empty());
        assert!(fx.q("secretthought").is_empty());
        assert!(fx.q("toolcallarg").is_empty());
        assert!(fx.q("hiddenreminder").is_empty());
        assert_eq!(fx.q("visible")[0].role, SearchRole::User);
        assert_eq!(fx.q("answer")[0].role, SearchRole::Assistant);
    }

    fn entry_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn incremental_append_parses_only_new_bytes() {
        let fx = Fx::new("append");
        let base = header("sa") + &user("u1", "2026-01-01T00:00:01Z", "first message");
        fx.write("a", &base);
        let mut conn = fx.sync();
        assert_eq!(fx.q("first").len(), 1);
        let id1: i64 = conn
            .query_row("SELECT id FROM entries WHERE entry_id='u1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        // Append a complete line plus an unterminated fragment.
        let more = user("u2", "2026-01-01T00:00:02Z", "second message");
        let frag = &user("u3", "2026-01-01T00:00:03Z", "third fragment")[..40];
        fx.write("a", &(base.clone() + &more + frag));
        fx.sync_with(&mut conn);
        assert_eq!(fx.q("second").len(), 1);
        assert!(fx.q("fragment").is_empty());
        // Earlier row untouched (same rowid) => not reindexed.
        let id1b: i64 = conn
            .query_row("SELECT id FROM entries WHERE entry_id='u1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(id1, id1b);
        assert_eq!(entry_count(&conn), 2);
        // Fragment completes.
        let full3 = user("u3", "2026-01-01T00:00:03Z", "third fragment");
        fx.write("a", &(base + &more + &full3));
        fx.sync_with(&mut conn);
        assert_eq!(fx.q("fragment").len(), 1);
        assert_eq!(entry_count(&conn), 3);
    }

    #[test]
    fn shrink_or_rewrite_reindexes_file() {
        let fx = Fx::new("rewrite");
        fx.write(
            "a",
            &(header("sa")
                + &user("u1", "2026-01-01T00:00:01Z", "old content one")
                + &user("u2", "2026-01-01T00:00:02Z", "old content two")),
        );
        let mut conn = fx.sync();
        assert_eq!(fx.q("old content").len(), 1);
        // Shrunk file.
        fx.write(
            "a",
            &(header("sa") + &user("n1", "2026-01-01T00:00:01Z", "brand new")),
        );
        fx.sync_with(&mut conn);
        assert!(fx.q("old content").is_empty());
        assert_eq!(fx.q("brand new").len(), 1);
        assert_eq!(entry_count(&conn), 1);
        // Same-or-larger rewrite whose last indexed line changed (prefix check).
        fx.write(
            "a",
            &(header("sa")
                + &user("n9", "2026-01-01T00:00:01Z", "rewritten text")
                + &user("n2", "2026-01-01T00:00:02Z", "appended too")),
        );
        fx.sync_with(&mut conn);
        assert!(fx.q("brand new").is_empty());
        assert_eq!(fx.q("rewritten").len(), 1);
        assert_eq!(fx.q("appended").len(), 1);
        assert_eq!(entry_count(&conn), 2);
    }

    #[test]
    fn deleted_files_are_purged_and_paths_sync() {
        let fx = Fx::new("purge");
        fx.write(
            "a",
            &(header("sa") + &user("u1", "2026-01-01T00:00:01Z", "keepme text")),
        );
        fx.write(
            "b",
            &(header("sb") + &user("u2", "2026-01-01T00:00:02Z", "dropme text")),
        );
        let mut conn = fx.sync();
        assert_eq!(fx.q("text").len(), 2);
        std::fs::remove_file(fx.file("b")).unwrap();
        fx.sync_with(&mut conn);
        assert_eq!(fx.q("text").len(), 1);
        assert!(fx.q("dropme").is_empty());
        // Watcher-driven path updates: change + removal.
        fx.write(
            "a",
            &(header("sa")
                + &user("u1", "2026-01-01T00:00:01Z", "keepme text")
                + &user("u5", "2026-01-01T00:00:05Z", "watcher added")),
        );
        let set: HashSet<PathBuf> = [fx.file("a")].into_iter().collect();
        sync_paths(&mut conn, &fx.dir, &set).unwrap();
        assert_eq!(fx.q("watcher").len(), 1);
        std::fs::remove_file(fx.file("a")).unwrap();
        sync_paths(&mut conn, &fx.dir, &set).unwrap();
        assert!(fx.q("keepme").is_empty());
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn status_counts_and_limit() {
        let fx = Fx::new("limit");
        for i in 0..5 {
            fx.write(
                &format!("s{i}"),
                &(header(&format!("id{i}"))
                    + &user("u", &format!("2026-01-01T00:00:0{i}Z"), "common term")),
            );
        }
        fx.sync();
        assert_eq!(search_db(&fx.db, "common", 3).unwrap().len(), 3);
        // Same relevance -> most recent first.
        let r = search_db(&fx.db, "common", 50).unwrap();
        assert_eq!(r.len(), 5);
        assert_eq!(r[0].session_id, "id4");
    }

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("a%b_c\\"), "%a\\%b\\_c\\\\%");
    }

    #[test]
    fn earlier_edit_with_unchanged_tail_triggers_reindex() {
        let fx = Fx::new("prefix");
        let tail_line = user("u2", "2026-01-01T00:00:02Z", "constant tail line");
        fx.write(
            "a",
            &(header("sa") + &user("u1", "2026-01-01T00:00:01Z", "alpha old message") + &tail_line),
        );
        let mut conn = fx.sync();
        assert_eq!(fx.q("alpha old").len(), 1);

        // Same-length in-place edit to u1, keeping tail_line at the exact same byte
        // offset and appending u3 so size grows and tail_hash alone would falsely match.
        let appended = user("u3", "2026-01-01T00:00:03Z", "appended follow-up");
        fx.write(
            "a",
            &(header("sa")
                + &user("u1", "2026-01-01T00:00:01Z", "gamma new message")
                + &tail_line
                + &appended),
        );
        fx.sync_with(&mut conn);
        assert!(
            fx.q("alpha old").is_empty(),
            "stale hit from earlier edited line must be purged"
        );
        assert_eq!(fx.q("gamma new").len(), 1);
        assert_eq!(fx.q("appended").len(), 1);
    }

    #[test]
    fn short_query_respects_scan_and_match_bounds() {
        let fx = Fx::new("short-bounds");
        for i in 0..20 {
            fx.write(
                &format!("s{i:02}"),
                &(header(&format!("id{i:02}"))
                    + &user("u", &format!("2026-01-01T00:00:{i:02}Z"), "性能优化")),
            );
        }
        fx.sync();
        // Bounded scan inspects only the 6 newest entries.
        let r = search_db_bounded(&fx.db, "优", 50, 6, 500).unwrap();
        assert_eq!(r.len(), 6);
        assert_eq!(r[0].session_id, "id19");
        assert_eq!(r[5].session_id, "id14");

        // Bounded match cap stops after 4 matches even when scan cap is larger.
        let r = search_db_bounded(&fx.db, "优", 50, 100, 4).unwrap();
        assert_eq!(r.len(), 4);
        assert_eq!(r[0].session_id, "id19");
    }

    #[test]
    fn debounce_flushes_at_max_wait_under_continuous_writes() {
        let (tx, rx) = mpsc::channel();
        let producer = std::thread::spawn(move || {
            for i in 0..30 {
                let _ = tx.send(Msg::Paths(vec![PathBuf::from(format!("/s/{i}.jsonl"))]));
                std::thread::sleep(Duration::from_millis(15));
            }
        });
        let first = rx.recv().unwrap();
        let start = Instant::now();
        let (rescan, pending) = collect_debounced_batch(
            &rx,
            first,
            Duration::from_millis(60),
            Duration::from_millis(120),
        );
        let elapsed = start.elapsed();
        assert!(!rescan);
        assert!(pending.len() >= 2);
        // Must flush near max_wait rather than waiting for all 30 events (~450ms).
        assert!(
            elapsed < Duration::from_millis(300),
            "debounce starved for {elapsed:?}"
        );
        let _ = producer.join();
    }
}

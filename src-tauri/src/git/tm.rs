//! Time machine: run an old commit in a detached worktree.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use regex::Regex;

use super::cmd::git_ok;
use super::history::valid_sha;
use super::worktree;
use crate::contracts::TmRun;

/// Max lines kept per run for `log_tail`.
const LOG_LINES: usize = 300;

/// Callback receiving `(run_id, line)` for every output line.
pub type LogSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

struct Run {
    info: TmRun,
    log: VecDeque<String>,
    /// Insertion order, used to evict the oldest finished runs.
    seq: u64,
}

static RUNS: LazyLock<Mutex<HashMap<String, Run>>> = LazyLock::new(Default::default);

fn runs() -> &'static Mutex<HashMap<String, Run>> {
    &RUNS
}

/// Finished (no pid) runs kept for the UI; older ones are evicted along with
/// their detached worktrees and SHA-keyed temp data directories.
const MAX_FINISHED_RUNS: usize = 20;

struct EvictedResources {
    repo: String,
    worktree: String,
    sha: String,
    remove_wt: bool,
    remove_data_dir: bool,
}

/// Insert a run, evict the oldest finished runs beyond `MAX_FINISHED_RUNS`,
/// and clean up their unreferenced disk resources outside the map lock.
fn insert_run(id: String, mut run: Run) {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    run.seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let evicted = {
        let mut map = runs().lock();
        map.insert(id, run);
        take_evicted_finished(&mut map)
    };
    cleanup_evicted(runs(), evicted);
}

fn take_evicted_finished(map: &mut HashMap<String, Run>) -> Vec<EvictedResources> {
    let mut done: Vec<(u64, String)> = map
        .iter()
        .filter(|(_, r)| r.info.pid.is_none())
        .map(|(k, r)| (r.seq, k.clone()))
        .collect();
    if done.len() <= MAX_FINISHED_RUNS {
        return Vec::new();
    }
    done.sort_unstable();
    let mut removed = Vec::new();
    for (_, k) in &done[..done.len() - MAX_FINISHED_RUNS] {
        if let Some(run) = map.remove(k) {
            removed.push(run);
        }
    }
    let remaining_wts: HashSet<PathBuf> = map
        .values()
        .map(|r| worktree::canon(Path::new(&r.info.worktree)))
        .collect();
    let remaining_shas: HashSet<String> = map.values().map(|r| r.info.sha.clone()).collect();

    let mut seen_wts = HashSet::new();
    let mut seen_shas = HashSet::new();
    let mut out = Vec::new();
    for run in removed {
        let wt_canon = worktree::canon(Path::new(&run.info.worktree));
        let remove_wt = !remaining_wts.contains(&wt_canon) && seen_wts.insert(wt_canon);
        let remove_data_dir =
            !remaining_shas.contains(&run.info.sha) && seen_shas.insert(run.info.sha.clone());
        if remove_wt || remove_data_dir {
            out.push(EvictedResources {
                repo: run.info.repo,
                worktree: run.info.worktree,
                sha: run.info.sha,
                remove_wt,
                remove_data_dir,
            });
        }
    }
    out
}

fn cleanup_worktree_with_runs(repo: &Path, wt: &Path, active_runs: &[TmRun]) -> Result<(), String> {
    let wt_canon = worktree::canon(wt);
    let repo_canon = worktree::canon(repo);
    if wt_canon == repo_canon {
        return Err("不能删除主工作区".into());
    }
    worktree::ensure_unused(&wt_canon, &[], active_runs)?;

    let mut first_err: Option<String> = None;
    if wt_canon.exists() {
        let wt_s = wt_canon.to_string_lossy().into_owned();
        if let Err(e) = git_ok(repo, &["worktree", "remove", "--force", &wt_s]) {
            if wt_canon.exists() {
                if let Err(rm_err) = std::fs::remove_dir_all(&wt_canon) {
                    first_err = Some(format!("{e}; remove_dir_all failed: {rm_err}"));
                }
            }
        }
    }
    let _ = git_ok(repo, &["worktree", "prune"]);
    super::invalidate_cache(&wt_canon);

    if wt_canon.exists() {
        return Err(first_err.unwrap_or_else(|| {
            format!(
                "worktree directory still exists after cleanup: {}",
                wt_canon.display()
            )
        }));
    }
    Ok(())
}

fn cleanup_data_dir(sha: &str) -> Result<(), String> {
    if sha.is_empty() {
        return Ok(());
    }
    let dir = isolated_data_dir(sha);
    if !dir.exists() {
        return Ok(());
    }
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清理临时数据目录失败 ({}): {e}", dir.display())),
    }
}

fn cleanup_evicted(map_lock: &Mutex<HashMap<String, Run>>, evicted: Vec<EvictedResources>) {
    for item in evicted {
        let wt_canon = worktree::canon(Path::new(&item.worktree));
        let (wt_in_use, sha_in_use, active_runs) = {
            let map = map_lock.lock();
            let wt_in_use = map
                .values()
                .any(|r| worktree::canon(Path::new(&r.info.worktree)) == wt_canon);
            let sha_in_use = map.values().any(|r| r.info.sha == item.sha);
            let active_runs: Vec<TmRun> = map.values().map(|r| r.info.clone()).collect();
            (wt_in_use, sha_in_use, active_runs)
        };
        if item.remove_wt && !wt_in_use {
            if let Err(e) = cleanup_worktree_with_runs(
                Path::new(&item.repo),
                Path::new(&item.worktree),
                &active_runs,
            ) {
                tracing::warn!(
                    "time machine eviction failed to remove worktree {}: {e}",
                    item.worktree
                );
            }
        }
        if item.remove_data_dir && !sha_in_use {
            if let Err(e) = cleanup_data_dir(&item.sha) {
                tracing::warn!(
                    "time machine eviction failed to remove data dir for {}: {e}",
                    item.sha
                );
            }
        }
    }
}

static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]")
        .expect("ansi regex")
});

static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s]*")
        .expect("url regex")
});

fn ansi_re() -> &'static Regex {
    &ANSI_RE
}

fn url_re() -> &'static Regex {
    &URL_RE
}

pub fn strip_ansi(s: &str) -> String {
    ansi_re().replace_all(s, "").into_owned()
}

/// First local dev-server URL in a (ANSI-stripped) line.
pub fn detect_url(line: &str) -> Option<String> {
    let m = url_re().find(line)?;
    let url = m.as_str().trim_end_matches(['.', ',', ')', ']', '\'', '"']);
    Some(url.replace("0.0.0.0", "localhost"))
}

/// Package manager implied by the lockfile in `dir`.
fn package_manager(dir: &Path) -> &'static str {
    if dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    }
}

fn install_cmd(dir: &Path) -> String {
    match package_manager(dir) {
        "pnpm" => "pnpm install --frozen-lockfile".into(),
        "yarn" => "yarn install --frozen-lockfile".into(),
        "bun" => "bun install --frozen-lockfile".into(),
        _ if dir.join("package-lock.json").exists() => "npm ci".into(),
        _ => "npm install".into(),
    }
}

fn has_dev_script(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .is_some_and(|v| v["scripts"]["dev"].is_string())
}

/// Custom run command from `.omp-workspace/run.json` or `.omp/run.json`.
fn custom_command(dir: &Path) -> Option<String> {
    [".omp-workspace/run.json", ".omp/run.json"]
        .iter()
        .find_map(|p| {
            let s = std::fs::read_to_string(dir.join(p)).ok()?;
            let v: serde_json::Value = serde_json::from_str(&s).ok()?;
            let c = v["command"].as_str()?.trim();
            (!c.is_empty()).then(|| c.to_string())
        })
}

/// Whether `dir` is a Tauri desktop project.
pub fn is_tauri(dir: &Path) -> bool {
    dir.join("src-tauri/tauri.conf.json").exists()
        || dir.join("src-tauri/Cargo.toml").exists()
        || dir.join("tauri.conf.json").exists()
}

/// Detected run command (no install step), or None when nothing is runnable.
pub fn detect_command(dir: &Path) -> Option<String> {
    if let Some(c) = custom_command(dir) {
        return Some(c);
    }
    if is_tauri(dir) {
        return Some(match package_manager(dir) {
            "pnpm" => "pnpm tauri dev".into(),
            "yarn" => "yarn tauri dev".into(),
            "bun" => "bun run tauri dev".into(),
            _ => "npm run tauri dev".into(),
        });
    }
    if has_dev_script(dir) {
        return Some(match package_manager(dir) {
            "pnpm" => "pnpm dev".into(),
            "yarn" => "yarn dev".into(),
            "bun" => "bun run dev".into(),
            _ => "npm run dev".into(),
        });
    }
    if dir.join("Cargo.toml").exists() {
        return Some("cargo run".into());
    }
    None
}

/// Isolated data dir for a time-machine Tauri child, so it never contends
/// for the main instance's SQLite lock.
pub fn isolated_data_dir(sha: &str) -> PathBuf {
    std::env::temp_dir().join(format!("ompws-tm-{sha}"))
}

/// Full shell command: optional dependency install followed by the run command.
pub fn full_command(dir: &Path, command: Option<&str>) -> Option<String> {
    let run = match command.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => c.to_string(),
        None => detect_command(dir)?,
    };
    if dir.join("package.json").exists() && !dir.join("node_modules").exists() {
        Some(format!("{} && {run}", install_cmd(dir)))
    } else {
        Some(run)
    }
}

/// PATH with common user tool locations prepended (GUI apps get a minimal PATH).
pub fn augmented_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let mut parts: Vec<String> = [
        home.join(".local/bin"),
        home.join(".bun/bin"),
        home.join(".cargo/bin"),
        home.join("Library/pnpm"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]
    .iter()
    .map(|p| p.to_string_lossy().into_owned())
    .collect();
    if let Ok(cur) = std::env::var("PATH") {
        parts.extend(cur.split(':').map(str::to_string));
    }
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| !p.is_empty() && seen.insert(p.clone()));
    parts.join(":")
}

fn push_line(run_id: &str, line: String, sink: &LogSink) {
    {
        let mut map = runs().lock();
        let Some(run) = map.get_mut(run_id) else {
            return;
        };
        if run.info.url.is_none() {
            run.info.url = detect_url(&line);
        }
        run.log.push_back(line.clone());
        while run.log.len() > LOG_LINES {
            run.log.pop_front();
        }
    }
    sink(run_id, &line);
}

fn pump<R: Read + Send + 'static>(reader: R, run_id: String, sink: LogSink) {
    std::thread::spawn(move || {
        let mut r = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let raw = String::from_utf8_lossy(&buf);
                    let line = strip_ansi(raw.trim_end_matches(['\n', '\r']));
                    // Progress bars redraw with \r; keep the last frame.
                    let line = line.rsplit('\r').next().unwrap_or_default().to_string();
                    push_line(&run_id, line, &sink);
                }
            }
        }
    });
}

fn snapshot(run: &Run) -> TmRun {
    let mut info = run.info.clone();
    info.log_tail = run.log.iter().cloned().collect::<Vec<_>>().join("\n");
    info
}

/// Start (or return the already-running) time-machine run for `sha`.
pub fn run(repo: &Path, sha: &str, command: Option<&str>, sink: LogSink) -> Result<TmRun, String> {
    if !valid_sha(sha) {
        return Err("invalid commit id".into());
    }
    let full_sha = git_ok(
        repo,
        &["rev-parse", "--verify", &format!("{sha}^{{commit}}")],
    )?
    .trim()
    .to_string();
    let repo_root = worktree::repo_info(repo)
        .ok_or("不是 git 仓库")?
        .main_root();
    let repo_s = repo_root.to_string_lossy().into_owned();
    {
        let mut map = runs().lock();
        if let Some(r) = map
            .values()
            .find(|r| r.info.repo == repo_s && r.info.sha == full_sha && r.info.pid.is_some())
        {
            return Ok(snapshot(r));
        }
        // Drop finished runs of the same commit; the worktree is reused.
        map.retain(|_, r| !(r.info.repo == repo_s && r.info.sha == full_sha));
    }
    let short: String = full_sha.chars().take(8).collect();
    let wt = worktree::create_detached(&repo_root, &format!("tm-{short}"), &full_sha)?;
    let id = uuid::Uuid::new_v4().to_string();
    let full = full_command(&wt, command);
    let mut info = TmRun {
        id: id.clone(),
        repo: repo_s,
        sha: full_sha,
        worktree: wt.to_string_lossy().into_owned(),
        command: full.clone().unwrap_or_default(),
        pid: None,
        url: None,
        log_tail: String::new(),
    };
    let Some(full) = full else {
        let mut log = VecDeque::new();
        log.push_back(format!(
            "未检测到可运行的命令，已创建 worktree：{}",
            info.worktree
        ));
        let run = Run { info, log, seq: 0 };
        let snap = snapshot(&run);
        insert_run(id, run);
        return Ok(snap);
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = Command::new(shell);
    cmd.arg("-lc")
        .arg(&full)
        .current_dir(&wt)
        .env("PATH", augmented_path())
        .env("BROWSER", "none")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if is_tauri(&wt) {
        cmd.env("OMPWS_DATA_DIR", isolated_data_dir(&info.sha));
    }
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动失败：{e}"))?;
    info.pid = Some(child.id());
    let mut log = VecDeque::new();
    log.push_back(format!("$ {full}"));
    let run = Run { info, log, seq: 0 };
    let snap = snapshot(&run);
    insert_run(id.clone(), run);
    if let Some(out) = child.stdout.take() {
        pump(out, id.clone(), sink.clone());
    }
    if let Some(err) = child.stderr.take() {
        pump(err, id.clone(), sink.clone());
    }
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        let evicted = {
            let mut map = runs().lock();
            if let Some(r) = map.get_mut(&id) {
                r.info.pid = None;
            }
            take_evicted_finished(&mut map)
        };
        let msg = match code {
            Some(c) => format!("[进程已退出，退出码 {c}]"),
            None => "[进程已被终止]".to_string(),
        };
        push_line(&id, msg, &sink);
        cleanup_evicted(runs(), evicted);
    });
    Ok(snap)
}

pub fn list() -> Vec<TmRun> {
    let mut v: Vec<TmRun> = runs().lock().values().map(snapshot).collect();
    v.sort_by(|a, b| a.worktree.cmp(&b.worktree));
    v
}

/// Process-group ids of live runs (used by services to flag `started_by_app`).
pub fn app_pgids() -> Vec<i32> {
    runs()
        .lock()
        .values()
        .filter_map(|r| r.info.pid.map(|p| p as i32))
        .collect()
}

fn group_alive(pgid: i32) -> bool {
    // SAFETY: kill with signal 0 only checks for existence/permission.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

/// Terminate a process group: SIGTERM, wait ≤3 s, then SIGKILL.
pub fn kill_group(pgid: i32) {
    // SAFETY: getpgid(0) only queries our own process group.
    let own = unsafe { libc::getpgid(0) };
    if pgid <= 1 || pgid == own {
        return;
    }
    // SAFETY: plain signal delivery to a process group we spawned.
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while group_alive(pgid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if group_alive(pgid) {
        // SAFETY: as above.
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
}

fn stop_in(
    map_lock: &Mutex<HashMap<String, Run>>,
    run_id: &str,
    remove_worktree: bool,
) -> Result<(), String> {
    let (pid, repo, wt, sha) = {
        let map = map_lock.lock();
        let r = map.get(run_id).ok_or("运行记录不存在")?;
        (
            r.info.pid,
            r.info.repo.clone(),
            r.info.worktree.clone(),
            r.info.sha.clone(),
        )
    };
    if let Some(pid) = pid {
        kill_group(pid as i32);
        // Reflect the stop immediately; the waiter thread may lag behind.
        if let Some(r) = map_lock.lock().get_mut(run_id) {
            r.info.pid = None;
        }
    }
    if remove_worktree {
        let wt_canon = worktree::canon(Path::new(&wt));
        let (other_live_uses_wt, other_uses_wt, other_uses_sha, active_runs) = {
            let map = map_lock.lock();
            let other_live_uses_wt = map.iter().any(|(id, r)| {
                id != run_id
                    && r.info.pid.is_some()
                    && worktree::canon(Path::new(&r.info.worktree)) == wt_canon
            });
            let other_uses_wt = map.iter().any(|(id, r)| {
                id != run_id && worktree::canon(Path::new(&r.info.worktree)) == wt_canon
            });
            let other_uses_sha = map.iter().any(|(id, r)| id != run_id && r.info.sha == sha);
            let active_runs: Vec<TmRun> = map.values().map(|r| r.info.clone()).collect();
            (
                other_live_uses_wt,
                other_uses_wt,
                other_uses_sha,
                active_runs,
            )
        };
        if other_live_uses_wt {
            return Err("时光机仍在此工作树运行，请先停止".into());
        }
        // Perform disk cleanup BEFORE removing the in-memory entry so failures
        // surface cleanly and retain accurate state for retry.
        if !other_uses_wt {
            cleanup_worktree_with_runs(Path::new(&repo), Path::new(&wt), &active_runs)?;
        }
        if !other_uses_sha {
            cleanup_data_dir(&sha)?;
        }
        map_lock.lock().remove(run_id);
    }
    Ok(())
}

/// Stop a run's process group and optionally remove its worktree and temp data dir.
pub fn stop(run_id: &str, remove_worktree: bool) -> Result<(), String> {
    stop_in(runs(), run_id, remove_worktree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_vite_url_through_ansi() {
        let raw = "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m";
        let line = strip_ansi(raw);
        assert_eq!(detect_url(&line).as_deref(), Some("http://localhost:5173/"));
        assert_eq!(
            detect_url("listening on http://0.0.0.0:3000.").as_deref(),
            Some("http://localhost:3000")
        );
        assert_eq!(detect_url("see https://example.com:443"), None);
    }

    #[test]
    fn command_detection() {
        let dir = PathBuf::from(format!(
            "/tmp/ompws-test-c/tm-detect-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(full_command(&dir, None), None);
        std::fs::write(dir.join("Cargo.toml"), "[package]").unwrap();
        assert_eq!(full_command(&dir, None).as_deref(), Some("cargo run"));
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(
            full_command(&dir, None).as_deref(),
            Some("pnpm install --frozen-lockfile && pnpm dev")
        );
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        assert_eq!(full_command(&dir, None).as_deref(), Some("pnpm dev"));
        assert_eq!(
            full_command(&dir, Some("make run")).as_deref(),
            Some("make run")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn fresh(name: &str) -> PathBuf {
        let dir = PathBuf::from(format!(
            "/tmp/ompws-test-c/tm-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_project_kinds() {
        let web = fresh("web");
        std::fs::write(web.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        std::fs::write(web.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(detect_command(&web).as_deref(), Some("pnpm dev"));

        let tauri = fresh("tauri");
        std::fs::write(tauri.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        std::fs::write(tauri.join("pnpm-lock.yaml"), "").unwrap();
        std::fs::create_dir_all(tauri.join("src-tauri")).unwrap();
        std::fs::write(tauri.join("src-tauri/tauri.conf.json"), "{}").unwrap();
        assert!(is_tauri(&tauri));
        assert_eq!(detect_command(&tauri).as_deref(), Some("pnpm tauri dev"));

        let cargo = fresh("cargo");
        std::fs::write(cargo.join("Cargo.toml"), "[package]").unwrap();
        assert!(!is_tauri(&cargo));
        assert_eq!(detect_command(&cargo).as_deref(), Some("cargo run"));

        std::fs::create_dir_all(tauri.join(".omp")).unwrap();
        std::fs::write(tauri.join(".omp/run.json"), r#"{"command":"make serve"}"#).unwrap();
        assert_eq!(detect_command(&tauri).as_deref(), Some("make serve"));
        std::fs::create_dir_all(tauri.join(".omp-workspace")).unwrap();
        std::fs::write(
            tauri.join(".omp-workspace/run.json"),
            r#"{"command":"just dev"}"#,
        )
        .unwrap();
        assert_eq!(detect_command(&tauri).as_deref(), Some("just dev"));

        for d in [web, tauri, cargo] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }

    fn temp_tm_repo(tag: &str) -> (PathBuf, String) {
        let dir =
            std::env::temp_dir().join(format!("vecway-tm-unit-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git_ok(&dir, &["init", "-q", "-b", "main"]).unwrap();
        git_ok(&dir, &["config", "user.name", "Test"]).unwrap();
        git_ok(&dir, &["config", "user.email", "t@example.com"]).unwrap();
        git_ok(&dir, &["config", "commit.gpgsign", "false"]).unwrap();
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        git_ok(&dir, &["add", "-A"]).unwrap();
        git_ok(&dir, &["commit", "-q", "-m", "init"]).unwrap();
        let sha = git_ok(&dir, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        (dir, sha)
    }

    fn make_finished_run(id: &str, repo: &Path, wt: &Path, sha: &str, seq: u64) -> Run {
        Run {
            info: TmRun {
                id: id.to_string(),
                repo: repo.to_string_lossy().into_owned(),
                sha: sha.to_string(),
                worktree: wt.to_string_lossy().into_owned(),
                command: String::new(),
                pid: None,
                url: None,
                log_tail: String::new(),
            },
            log: VecDeque::new(),
            seq,
        }
    }

    #[test]
    fn eviction_cleans_up_detached_worktree_and_temp_data_dir() {
        let (repo, sha) = temp_tm_repo("evict");
        let wt = worktree::create_detached(&repo, "tm-evict001", &sha).unwrap();
        std::fs::create_dir_all(wt.join("node_modules/pkg")).unwrap();
        std::fs::write(wt.join("node_modules/pkg/index.js"), "module.exports = 1;").unwrap();

        let evicted_sha = format!("evict-{}", uuid::Uuid::new_v4());
        let data_dir = isolated_data_dir(&evicted_sha);
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("app.db"), "stub").unwrap();

        let local_runs: Mutex<HashMap<String, Run>> = Mutex::new(HashMap::new());
        {
            let mut map = local_runs.lock();
            map.insert(
                "oldest".to_string(),
                make_finished_run("oldest", &repo, &wt, &evicted_sha, 1),
            );
            for i in 0..MAX_FINISHED_RUNS {
                let id = format!("keep-{i}");
                let dummy_wt = repo.join(format!(".worktrees/dummy-{i}"));
                map.insert(
                    id.clone(),
                    make_finished_run(
                        &id,
                        &repo,
                        &dummy_wt,
                        &format!("keep-sha-{i}"),
                        (i + 2) as u64,
                    ),
                );
            }
        }

        let evicted = {
            let mut map = local_runs.lock();
            take_evicted_finished(&mut map)
        };
        assert_eq!(evicted.len(), 1);
        cleanup_evicted(&local_runs, evicted);

        assert!(!wt.exists(), "evicted worktree should be removed from disk");
        assert!(
            !data_dir.exists(),
            "evicted SHA temp data dir should be removed from disk"
        );
        let listed = worktree::list_entries(&repo).unwrap();
        assert!(!listed
            .iter()
            .any(|e| worktree::canon(Path::new(&e.path)) == wt));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn stop_retains_entry_on_cleanup_failure_and_cleans_data_dir_on_success() {
        let (repo, sha) = temp_tm_repo("stop");
        let wt = worktree::create_detached(&repo, "tm-stop0001", &sha).unwrap();
        let test_sha = format!("stop-{}", uuid::Uuid::new_v4());
        let data_dir = isolated_data_dir(&test_sha);
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("state.db"), "stub").unwrap();

        let local_runs: Mutex<HashMap<String, Run>> = Mutex::new(HashMap::new());
        local_runs.lock().insert(
            "bad-main".to_string(),
            make_finished_run("bad-main", &repo, &repo, "bad-sha", 1),
        );
        // Refusing to delete the main repo root must NOT drop the map entry.
        assert!(stop_in(&local_runs, "bad-main", true).is_err());
        assert!(local_runs.lock().contains_key("bad-main"));

        local_runs.lock().insert(
            "good".to_string(),
            make_finished_run("good", &repo, &wt, &test_sha, 2),
        );
        stop_in(&local_runs, "good", true).unwrap();
        assert!(!wt.exists(), "worktree removed on stop(true)");
        assert!(
            !data_dir.exists(),
            "SHA temp data dir removed on stop(true)"
        );
        assert!(!local_runs.lock().contains_key("good"));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn cleanup_worktree_falls_back_to_remove_dir_all_and_prunes() {
        let (repo, sha) = temp_tm_repo("fallback");
        let wt = worktree::create_detached(&repo, "tm-fall0001", &sha).unwrap();
        // Corrupt the worktree `.git` pointer so `git worktree remove --force` fails.
        std::fs::write(wt.join(".git"), "corrupted-gitdir\n").unwrap();
        cleanup_worktree_with_runs(&repo, &wt, &[]).unwrap();
        assert!(!wt.exists(), "fallback remove_dir_all should remove dir");
        let listed = worktree::list_entries(&repo).unwrap();
        assert!(!listed
            .iter()
            .any(|e| worktree::canon(Path::new(&e.path)) == wt));
        let _ = std::fs::remove_dir_all(&repo);
    }
}

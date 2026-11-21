//! Process helpers: run `git` / arbitrary commands with a timeout.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

/// Default timeout for git invocations.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// Maximum bytes retained per stream (stdout/stderr) so normal large diffs work
/// while runaway subprocess output cannot OOM the app.
pub const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
/// Grace period for reader threads after killing a timed-out process group,
/// preventing indefinite hangs if a detached descendant keeps a pipe FD open.
const POST_KILL_READ_GRACE: Duration = Duration::from_millis(200);

#[derive(Debug, Clone)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    /// Human-readable error for a failed command.
    pub fn err_msg(&self) -> String {
        let msg = self.stderr.trim();
        if msg.is_empty() {
            format!("exit code {:?}", self.code)
        } else {
            msg.to_string()
        }
    }
}

fn read_bounded<R: Read>(mut reader: R, max_bytes: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let remaining = max_bytes.saturating_sub(buf.len());
                if remaining > 0 {
                    buf.extend_from_slice(&chunk[..n.min(remaining)]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    buf
}

fn kill_pgid(pgid: u32) {
    #[cfg(unix)]
    {
        let pgid = pgid as libc::pid_t;
        if pgid > 1 {
            // SAFETY: query our own process group id before signaling the
            // child's dedicated process group (`process_group(0)`).
            let own = unsafe { libc::getpgid(0) };
            if pgid != own {
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = pgid;
}

fn kill_process_tree(child: &mut std::process::Child) {
    kill_pgid(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

fn run_inner(
    mut cmd: Command,
    stdin_data: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output, String> {
    cmd.stdin(if stdin_data.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let child_pid = child.id();

    if let Some(input) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            let owned = input.to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&owned);
            });
        }
    }

    let out = child.stdout.take().expect("piped stdout");
    let err = child.stderr.take().expect("piped stderr");
    let (out_tx, out_rx) = mpsc::sync_channel::<Vec<u8>>(1);
    let (err_tx, err_rx) = mpsc::sync_channel::<Vec<u8>>(1);
    std::thread::spawn(move || {
        let _ = out_tx.send(read_bounded(out, MAX_OUTPUT_BYTES));
    });
    std::thread::spawn(move || {
        let _ = err_tx.send(read_bounded(err, MAX_OUTPUT_BYTES));
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if Instant::now() >= deadline => {
                kill_process_tree(&mut child);
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => {
                kill_process_tree(&mut child);
                return Err(format!("wait failed: {e}"));
            }
        }
    };

    let Some(st) = status else {
        let grace_deadline = Instant::now() + POST_KILL_READ_GRACE;
        let _ = out_rx.recv_timeout(grace_deadline.saturating_duration_since(Instant::now()));
        let _ = err_rx.recv_timeout(grace_deadline.saturating_duration_since(Instant::now()));
        return Err(format!("command timed out after {}s", timeout.as_secs()));
    };

    // Even after the direct child exits, a surviving descendant may keep stdout
    // or stderr open; bound the drain wait by the remaining command deadline.
    let read_deadline = deadline.max(Instant::now() + Duration::from_millis(50));
    let stdout = match out_rx.recv_timeout(read_deadline.saturating_duration_since(Instant::now()))
    {
        Ok(buf) => buf,
        Err(RecvTimeoutError::Disconnected) => Vec::new(),
        Err(RecvTimeoutError::Timeout) => {
            kill_pgid(child_pid);
            let _ = out_rx.recv_timeout(POST_KILL_READ_GRACE);
            return Err(format!("command timed out after {}s", timeout.as_secs()));
        }
    };
    let stderr_bytes =
        match err_rx.recv_timeout(read_deadline.saturating_duration_since(Instant::now())) {
            Ok(buf) => buf,
            Err(RecvTimeoutError::Disconnected) => Vec::new(),
            Err(RecvTimeoutError::Timeout) => {
                kill_pgid(child_pid);
                let _ = err_rx.recv_timeout(POST_KILL_READ_GRACE);
                return Err(format!("command timed out after {}s", timeout.as_secs()));
            }
        };
    Ok(Output {
        code: st.code(),
        stdout,
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
    })
}

/// Run a command to completion, killing its process group after `timeout`.
pub fn run(cmd: Command, timeout: Duration) -> Result<Output, String> {
    run_inner(cmd, None, timeout)
}

/// Run a command with piped stdin bytes, killing its process group after `timeout`.
pub fn run_with_stdin(
    cmd: Command,
    stdin_data: &[u8],
    timeout: Duration,
) -> Result<Output, String> {
    run_inner(cmd, Some(stdin_data), timeout)
}

/// Base `git -C <dir>` command with lock-free, non-interactive env.
pub fn git_cmd(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .env("PATH", crate::todos::omp::augmented_path())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    cmd
}

/// Run `git -C dir <args>` with the default timeout.
pub fn git(dir: &Path, args: &[&str]) -> Result<Output, String> {
    let mut cmd = git_cmd(dir);
    cmd.args(args);
    run(cmd, GIT_TIMEOUT)
}

/// Run `git -C dir <args>` with piped stdin bytes and the default timeout.
pub fn git_with_stdin(dir: &Path, args: &[&str], stdin_data: &[u8]) -> Result<Output, String> {
    let mut cmd = git_cmd(dir);
    cmd.args(args);
    run_with_stdin(cmd, stdin_data, GIT_TIMEOUT)
}
/// Run git and return stdout text, or Err(stderr) on non-zero exit.
pub fn git_ok(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git(dir, args)?;
    if out.ok() {
        Ok(out.text())
    } else {
        Err(out.err_msg())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_times_out() {
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let err = run(cmd, Duration::from_millis(100)).unwrap_err();
        assert!(err.contains("timed out"));
    }

    #[test]
    fn run_captures_output() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo hi; echo oops >&2; exit 3"]);
        let out = run(cmd, Duration::from_secs(5)).unwrap();
        assert_eq!(out.text(), "hi\n");
        assert_eq!(out.code, Some(3));
        assert_eq!(out.err_msg(), "oops");
    }

    #[cfg(unix)]
    #[test]
    fn run_timeout_kills_grandchild_holding_pipes() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30 & wait"]);
        let start = Instant::now();
        let err = run(cmd, Duration::from_millis(150)).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "timeout hung waiting for grandchild pipes: {:?}",
            start.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_grandchild_holding_pipe_after_child_exit_does_not_hang() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30 & exit 0"]);
        let start = Instant::now();
        let err = run(cmd, Duration::from_millis(150)).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "post-exit pipe drain hung on grandchild: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn read_bounded_caps_output_and_drains() {
        let input = [b'a'; 128];
        let got = read_bounded(&input[..], 32);
        assert_eq!(got.len(), 32);
        assert!(got.iter().all(|&b| b == b'a'));
    }

    #[test]
    fn run_with_stdin_roundtrips() {
        let cmd = Command::new("cat");
        let out = run_with_stdin(cmd, b"hello\nworld\n", Duration::from_secs(5)).unwrap();
        assert!(out.ok());
        assert_eq!(out.text(), "hello\nworld\n");
    }
}

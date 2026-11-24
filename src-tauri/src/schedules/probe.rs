//! Lightweight shell probe/script runner for two-stage automations.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;

use crate::contracts::ScheduleAgentTrigger;

const MAX_OUTPUT_BYTES: usize = 32 * 1024;
const MAX_OUTPUT_CHARS: usize = 8_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    Quiet,
    WakeAgent { context: String },
    ScriptOk { output: String },
    Failed { output: String },
}

/// Optional structured JSON contract returned by a local automation script:
/// `{ "status": "quiet"|"ok"|"skipped"|"warning"|"error", "summary": "...", "details"?: "...", "sessionId"?: "..." }`
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredProbeResult {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub details: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// Parse a structured script result from either the full stdout or its final JSON line.
pub fn parse_structured_result(output: &str) -> Option<StructuredProbeResult> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return None;
    }
    let try_parse = |s: &str| -> Option<StructuredProbeResult> {
        let val: serde_json::Value = serde_json::from_str(s).ok()?;
        let obj = val.as_object()?;
        if !obj.contains_key("status") && !obj.contains_key("summary") {
            return None;
        }
        serde_json::from_value(val).ok()
    };
    if let Some(parsed) = try_parse(trimmed) {
        return Some(parsed);
    }
    let last_line = trimmed.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    if last_line.starts_with('{') && last_line.ends_with('}') {
        return try_parse(last_line);
    }
    None
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let clipped: String = text.chars().take(max_chars).collect();
    format!("{clipped}…")
}

pub fn combine_output(stdout: &str, stderr: &str) -> String {
    let out = stdout.trim();
    let err = stderr.trim();
    let merged = match (out.is_empty(), err.is_empty()) {
        (true, true) => String::new(),
        (false, true) => out.to_string(),
        (true, false) => err.to_string(),
        (false, false) => format!("{out}\n[stderr]\n{err}"),
    };
    truncate_chars(&merged, MAX_OUTPUT_CHARS)
}

/// Pure outcome classification from process exit status and captured streams.
pub fn classify_probe(
    trigger: ScheduleAgentTrigger,
    exit_code: Option<i32>,
    timed_out: bool,
    stdout: &str,
    stderr: &str,
) -> ProbeOutcome {
    let combined = combine_output(stdout, stderr);
    if timed_out {
        let msg = if combined.is_empty() {
            "本地脚本执行超时".to_string()
        } else {
            format!("{combined}\n（执行超时）")
        };
        return ProbeOutcome::Failed {
            output: truncate_chars(&msg, MAX_OUTPUT_CHARS),
        };
    }

    match trigger {
        ScheduleAgentTrigger::OnSignal => match exit_code {
            Some(10) => ProbeOutcome::Quiet,
            Some(20) => ProbeOutcome::WakeAgent { context: combined },
            Some(0) => {
                let out_trimmed = stdout.trim();
                if out_trimmed.is_empty() {
                    ProbeOutcome::Quiet
                } else {
                    ProbeOutcome::WakeAgent {
                        context: truncate_chars(out_trimmed, MAX_OUTPUT_CHARS),
                    }
                }
            }
            _ => ProbeOutcome::Failed { output: combined },
        },
        ScheduleAgentTrigger::Never => match exit_code {
            Some(10) => ProbeOutcome::Quiet,
            Some(0) => {
                let out_trimmed = stdout.trim();
                let quiet_structured = parse_structured_result(out_trimmed)
                    .and_then(|r| r.status)
                    .is_some_and(|s| s.eq_ignore_ascii_case("quiet"));
                if out_trimmed.is_empty() || quiet_structured {
                    ProbeOutcome::Quiet
                } else {
                    ProbeOutcome::ScriptOk { output: combined }
                }
            }
            _ => ProbeOutcome::Failed { output: combined },
        },
        ScheduleAgentTrigger::Always => match exit_code {
            Some(0) => ProbeOutcome::WakeAgent {
                context: truncate_chars(stdout.trim(), MAX_OUTPUT_CHARS),
            },
            _ => ProbeOutcome::Failed { output: combined },
        },
    }
}

async fn read_bounded_into<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
) {
    let mut chunk = [0u8; 4096];
    loop {
        let remaining = {
            let guard = buf.lock().unwrap_or_else(|e| e.into_inner());
            MAX_OUTPUT_BYTES.saturating_sub(guard.len())
        };
        if remaining == 0 {
            break;
        }
        let max_read = chunk.len().min(remaining);
        match reader.read(&mut chunk[..max_read]).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend_from_slice(&chunk[..n]);
            }
        }
    }
}

/// Execute a lightweight shell probe/script in `cwd` with login PATH and automation state dir.
pub async fn execute_probe(
    cwd: &Path,
    command: &str,
    trigger: ScheduleAgentTrigger,
    schedule_id: Option<&str>,
    timeout: Duration,
) -> (Option<i32>, bool, u64, ProbeOutcome, String) {
    let started = Instant::now();
    let auto_id = schedule_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("preview");
    let auto_dir = if schedule_id.is_some() {
        crate::paths::automation_dir(auto_id)
    } else {
        std::env::temp_dir().join("ompws-automation-preview")
    };
    let state_dir = auto_dir.join("state");
    let _ = std::fs::create_dir_all(&state_dir);

    #[cfg(unix)]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut c = tokio::process::Command::new(shell);
        c.args(["-c", command]);
        c.process_group(0);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", command]);
        c
    };

    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", crate::terminal::env::augmented_path())
        .env("OMPWS_AUTOMATION_ID", auto_id)
        .env("OMPWS_AUTOMATION_DIR", &auto_dir)
        .env("OMPWS_STATE_DIR", &state_dir);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("无法启动本地脚本：{e}");
            return (
                None,
                false,
                started.elapsed().as_millis() as u64,
                ProbeOutcome::Failed {
                    output: msg.clone(),
                },
                msg,
            );
        }
    };

    let pid = child.id();
    let out_buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let err_buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_buf_task = out_buf.clone();
    let mut out_task = tokio::spawn(async move {
        if let Some(s) = stdout {
            read_bounded_into(s, out_buf_task).await;
        }
    });
    let err_buf_task = err_buf.clone();
    let mut err_task = tokio::spawn(async move {
        if let Some(s) = stderr {
            read_bounded_into(s, err_buf_task).await;
        }
    });

    // Single end-to-end deadline covering both child exit and stdout/stderr draining so
    // background descendants keeping pipes open cannot hang past the timeout.
    let deadline = tokio::time::Instant::now() + timeout;
    let wait_all = tokio::time::timeout_at(deadline, async {
        tokio::join!(child.wait(), &mut out_task, &mut err_task)
    })
    .await;

    let (exit_code, timed_out) = match wait_all {
        Ok((Ok(status), _, _)) => (status.code(), false),
        Ok((Err(_), _, _)) => (None, false),
        Err(_) => {
            #[cfg(unix)]
            if let Some(p) = pid {
                // Kill the entire process group so background descendants holding pipes open do not linger.
                unsafe {
                    libc::killpg(p as i32, libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            let _ = tokio::time::timeout(Duration::from_millis(200), child.wait()).await;
            out_task.abort();
            err_task.abort();
            (None, true)
        }
    };

    let stdout_str =
        String::from_utf8_lossy(&out_buf.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    let stderr_str =
        String::from_utf8_lossy(&err_buf.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    let combined = combine_output(&stdout_str, &stderr_str);
    let outcome = classify_probe(trigger, exit_code, timed_out, &stdout_str, &stderr_str);
    let duration_ms = started.elapsed().as_millis() as u64;
    (exit_code, timed_out, duration_ms, outcome, combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_mode_collapses_empty_exit10_and_structured_quiet() {
        assert_eq!(
            classify_probe(ScheduleAgentTrigger::Never, Some(0), false, "", ""),
            ProbeOutcome::Quiet
        );
        assert_eq!(
            classify_probe(ScheduleAgentTrigger::Never, Some(10), false, "anything", ""),
            ProbeOutcome::Quiet
        );
        assert_eq!(
            classify_probe(
                ScheduleAgentTrigger::Never,
                Some(0),
                false,
                "{\"status\":\"quiet\",\"summary\":\"nothing due\"}",
                ""
            ),
            ProbeOutcome::Quiet
        );
        assert!(matches!(
            classify_probe(
                ScheduleAgentTrigger::Never,
                Some(0),
                false,
                "{\"status\":\"ok\",\"summary\":\"synced 3 items\"}",
                ""
            ),
            ProbeOutcome::ScriptOk { .. }
        ));
    }

    #[test]
    fn parses_structured_result_from_full_or_last_line() {
        let parsed = parse_structured_result(
            "debug line\n{\"status\":\"skipped\",\"summary\":\"outside window\",\"sessionId\":\"s-1\"}\n",
        )
        .expect("should parse last JSON line");
        assert_eq!(parsed.status.as_deref(), Some("skipped"));
        assert_eq!(parsed.summary.as_deref(), Some("outside window"));
        assert_eq!(parsed.session_id.as_deref(), Some("s-1"));
        assert!(parse_structured_result("plain text without json").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execute_probe_bounds_leaked_descendant_pipes_with_single_deadline() {
        let dir = std::env::temp_dir().join(format!("ompws-probe-m3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let started = Instant::now();
        let (exit_code, timed_out, _duration_ms, outcome, combined) = execute_probe(
            &dir,
            "(sleep 10) & echo hi",
            ScheduleAgentTrigger::OnSignal,
            None,
            Duration::from_millis(250),
        )
        .await;
        let elapsed = started.elapsed();

        assert!(timed_out, "leaked descendant pipe must trigger timeout");
        assert_eq!(exit_code, None);
        assert!(
            elapsed < Duration::from_secs(2),
            "probe hung past bounded deadline: {elapsed:?}"
        );
        assert!(
            matches!(outcome, ProbeOutcome::Failed { .. }),
            "expected Failed outcome on timeout, got {outcome:?}"
        );
        assert!(combined.contains("hi") || matches!(outcome, ProbeOutcome::Failed { .. }));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execute_probe_timeout_when_only_stdout_stays_open_does_not_panic() {
        let dir = std::env::temp_dir().join(format!("ompws-probe-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let started = Instant::now();
        let (exit_code, timed_out, _duration_ms, outcome, combined) = execute_probe(
            &dir,
            "(sleep 10 2>&-) & echo out_only",
            ScheduleAgentTrigger::OnSignal,
            None,
            Duration::from_millis(250),
        )
        .await;
        let elapsed = started.elapsed();

        assert!(
            timed_out,
            "open stdout descendant pipe must trigger timeout"
        );
        assert_eq!(exit_code, None);
        assert!(
            elapsed < Duration::from_secs(2),
            "probe hung past bounded deadline: {elapsed:?}"
        );
        assert!(
            matches!(outcome, ProbeOutcome::Failed { .. }),
            "expected Failed outcome on timeout, got {outcome:?}"
        );
        assert!(
            combined.contains("out_only"),
            "expected buffered stdout, got {combined:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execute_probe_timeout_when_only_stderr_stays_open_does_not_panic() {
        let dir = std::env::temp_dir().join(format!("ompws-probe-err-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let started = Instant::now();
        let (exit_code, timed_out, _duration_ms, outcome, combined) = execute_probe(
            &dir,
            "(sleep 10 >&2 1>&-) & echo err_only >&2",
            ScheduleAgentTrigger::OnSignal,
            None,
            Duration::from_millis(250),
        )
        .await;
        let elapsed = started.elapsed();

        assert!(
            timed_out,
            "open stderr descendant pipe must trigger timeout"
        );
        assert_eq!(exit_code, None);
        assert!(
            elapsed < Duration::from_secs(2),
            "probe hung past bounded deadline: {elapsed:?}"
        );
        assert!(
            matches!(outcome, ProbeOutcome::Failed { .. }),
            "expected Failed outcome on timeout, got {outcome:?}"
        );
        assert!(
            combined.contains("err_only"),
            "expected buffered stderr, got {combined:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

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
                if out_trimmed.is_empty() {
                    ProbeOutcome::Quiet
                } else if parse_structured_result(out_trimmed)
                    .and_then(|r| r.status)
                    .is_some_and(|s| s.eq_ignore_ascii_case("quiet"))
                {
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

async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(mut reader: R) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    while buf.len() < MAX_OUTPUT_BYTES {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let take = n.min(MAX_OUTPUT_BYTES - buf.len());
                buf.extend_from_slice(&chunk[..take]);
                if take < n {
                    break;
                }
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
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
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_task = tokio::spawn(async move {
        match stdout {
            Some(s) => read_bounded(s).await,
            None => String::new(),
        }
    });
    let err_task = tokio::spawn(async move {
        match stderr {
            Some(s) => read_bounded(s).await,
            None => String::new(),
        }
    });

    let wait_res = tokio::time::timeout(timeout, child.wait()).await;
    let (exit_code, timed_out) = match wait_res {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(_)) => (None, false),
        Err(_) => {
            #[cfg(unix)]
            if let Some(p) = pid {
                // Kill the entire process group so background descendants do not linger.
                unsafe {
                    libc::killpg(p as i32, libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            (None, true)
        }
    };

    let stdout_str = out_task.await.unwrap_or_default();
    let stderr_str = err_task.await.unwrap_or_default();
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
}

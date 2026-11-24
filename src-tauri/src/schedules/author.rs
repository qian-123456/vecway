//! Natural-language AI authoring for Automations (`schedules_generate_draft`).

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::contracts::{
    AutomationAuthorResult, ScheduleAgentTrigger, ScheduleCadence, ScheduleDraft, ScheduleNotify,
    ScheduleResultMode,
};
use crate::prompts;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuthorPayload {
    name: Option<String>,
    cadence: Option<ScheduleCadence>,
    #[serde(default)]
    agent_trigger: ScheduleAgentTrigger,
    #[serde(default)]
    result_mode: ScheduleResultMode,
    #[serde(default)]
    invokes_external_model: bool,
    probe_description: Option<String>,
    script_filename: Option<String>,
    script_content: Option<String>,
    probe_command: Option<String>,
    prompt: Option<String>,
    #[serde(default)]
    notify: ScheduleNotify,
    explanation: Option<String>,
}

/// Extract the first balanced JSON object from raw LLM output (handles ```json fences).
pub fn extract_json_object(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    let stripped = if let Some(rest) = trimmed.strip_prefix("```") {
        let after_lang = rest.split_once('\n').map(|(_, body)| body).unwrap_or(rest);
        after_lang
            .rsplit_once("```")
            .map(|(body, _)| body)
            .unwrap_or(after_lang)
            .trim()
    } else {
        trimmed
    };

    let start = stripped.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in stripped[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let end = start + offset + 1;
                    return Some(&stripped[start..end]);
                }
            }
            _ => {}
        }
    }
    None
}

fn sanitize_script_filename(raw: Option<&str>) -> String {
    let candidate = raw.unwrap_or("check.sh").trim();
    let cleaned: String = candidate
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        "check.sh".to_string()
    } else {
        cleaned
    }
}

fn shell_quote_single(path: &Path) -> String {
    let s = path.to_string_lossy();
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn stage_script_and_resolve_command(
    automation_dir: &Path,
    script_filename: Option<&str>,
    script_content: Option<&str>,
    probe_command: Option<&str>,
) -> Result<Option<String>, String> {
    let trimmed_cmd = probe_command
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let Some(content) = script_content.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(trimmed_cmd);
    };

    let state_dir = automation_dir.join("state");
    std::fs::create_dir_all(&state_dir).map_err(|e| format!("无法创建自动化目录：{e}"))?;

    let filename = sanitize_script_filename(script_filename);
    let script_path = automation_dir.join(&filename);
    std::fs::write(&script_path, format!("{content}\n"))
        .map_err(|e| format!("写入本地脚本失败：{e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755));
    }

    let quoted = shell_quote_single(&script_path);
    let default_runner = if filename.ends_with(".py") {
        format!("python3 {quoted}")
    } else if filename.ends_with(".mjs") || filename.ends_with(".cjs") || filename.ends_with(".js") {
        format!("node {quoted}")
    } else {
        format!("bash {quoted}")
    };

    let final_cmd = match trimmed_cmd {
        Some(cmd) if cmd.contains("<SCRIPT_PATH>") => cmd.replace("<SCRIPT_PATH>", &quoted),
        Some(cmd) => cmd,
        None => default_runner,
    };
    Ok(Some(final_cmd))
}

pub fn parse_and_stage_output(
    schedule_id: &str,
    automation_dir: &Path,
    raw_output: &str,
    fallback_request: &str,
) -> Result<AutomationAuthorResult, String> {
    let json_slice = extract_json_object(raw_output)
        .ok_or_else(|| "模型未能生成有效的 JSON 配置，请重试或换一种描述".to_string())?;
    let parsed: RawAuthorPayload =
        serde_json::from_str(json_slice).map_err(|e| format!("解析自动化配置失败：{e}"))?;

    let probe_command = stage_script_and_resolve_command(
        automation_dir,
        parsed.script_filename.as_deref(),
        parsed.script_content.as_deref(),
        parsed.probe_command.as_deref(),
    )?;

    let name = parsed
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let short: String = fallback_request.trim().chars().take(24).collect();
            if short.is_empty() {
                "新建自动化".to_string()
            } else {
                short
            }
        });

    let cadence = match parsed
        .cadence
        .unwrap_or(ScheduleCadence::Interval { minutes: 30 })
    {
        ScheduleCadence::Interval { minutes } => ScheduleCadence::Interval {
            minutes: minutes.max(1),
        },
        other => other,
    };

    let agent_trigger = match (parsed.agent_trigger, &probe_command) {
        (ScheduleAgentTrigger::OnSignal, None) => ScheduleAgentTrigger::Always,
        (t, _) => t,
    };

    let prompt = parsed.prompt.unwrap_or_default().trim().to_string();
    let probe_description = parsed
        .probe_description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let explanation = parsed
        .explanation
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "已根据你的描述生成配置，可先点击「试跑脚本」验证效果。".to_string());

    Ok(AutomationAuthorResult {
        schedule_id: schedule_id.to_string(),
        name,
        cadence,
        agent_trigger,
        result_mode: parsed.result_mode,
        invokes_external_model: parsed.invokes_external_model,
        probe_description,
        probe_command,
        prompt,
        notify: parsed.notify,
        explanation,
    })
}

fn read_existing_staged_script(auto_dir: &Path) -> String {
    let Ok(entries) = std::fs::read_dir(auto_dir) else {
        return String::new();
    };
    let mut files: Vec<std::path::PathBuf> = entries
        .filter_map(|e| e.ok().map(|entry| entry.path()))
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| matches!(ext, "sh" | "py" | "js" | "mjs"))
        })
        .collect();
    files.sort();
    let mut out = String::new();
    for file in files {
        if let Ok(text) = std::fs::read_to_string(&file) {
            let name = file
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("script");
            let snippet: String = text.chars().take(6000).collect();
            out.push_str(&format!("# {name}\n{snippet}\n"));
            if out.len() >= 8000 {
                break;
            }
        }
    }
    out.trim().to_string()
}
pub fn resolve_stage_dir(auto_dir: &Path, preview: bool) -> Result<std::path::PathBuf, String> {
    if !preview {
        return Ok(auto_dir.to_path_buf());
    }
    let rev_id = uuid::Uuid::new_v4().to_string();
    let stage_dir = auto_dir.join("revisions").join(&rev_id);
    std::fs::create_dir_all(&stage_dir).map_err(|e| format!("无法准备自动化预览目录：{e}"))?;
    Ok(stage_dir)
}

pub async fn generate_draft_with_options(
    state: &AppState,
    request: &str,
    cwd: &str,
    current: Option<ScheduleDraft>,
    preview: bool,
) -> Result<AutomationAuthorResult, String> {
    let trimmed_req = request.trim();
    if trimmed_req.is_empty() {
        return Err("请先输入想让 AI 生成的自动化描述".to_string());
    }

    let schedule_id = current
        .as_ref()
        .and_then(|c| c.id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let auto_dir = crate::paths::automation_dir(&schedule_id);
    std::fs::create_dir_all(&auto_dir).map_err(|e| format!("无法准备自动化目录：{e}"))?;
    let stage_dir = resolve_stage_dir(&auto_dir, preview)?;

    let current_json = current
        .as_ref()
        .and_then(|c| serde_json::to_string_pretty(c).ok())
        .unwrap_or_default();
    let existing_script = if current.is_some() {
        read_existing_staged_script(&auto_dir)
    } else {
        String::new()
    };

    let mut vars = HashMap::new();
    vars.insert("request", trimmed_req.to_string());
    vars.insert("cwd", cwd.trim().to_string());
    vars.insert("automation_dir", stage_dir.to_string_lossy().into_owned());
    vars.insert("local_now", chrono::Local::now().to_rfc3339());
    vars.insert("current_json", current_json);
    vars.insert("existing_script", existing_script);

    let prompt = prompts::render(prompts::AUTOMATION_AUTHOR, &vars);
    let model = state
        .settings
        .read()
        .new_session_model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "default".to_string());

    let output =
        crate::todos::omp::run_print(state, &model, &prompt, Duration::from_secs(90)).await?;
    parse_and_stage_output(&schedule_id, &stage_dir, &output, trimmed_req)
}

pub async fn generate_draft(
    state: &AppState,
    request: &str,
    cwd: &str,
    current: Option<ScheduleDraft>,
) -> Result<AutomationAuthorResult, String> {
    generate_draft_with_options(state, request, cwd, current, false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_fenced_and_raw_json_and_stages_script() {
        let dir = std::env::temp_dir().join(format!("ompws-author-{}", uuid::Uuid::new_v4()));
        let raw = r##"```json
{
  "name": "检查日志报错",
  "cadence": { "kind": "interval", "minutes": 0 },
  "agentTrigger": "on_signal",
  "probeDescription": "扫描最近错误日志",
  "scriptFilename": "../evil/check errors.sh",
  "scriptContent": "#!/usr/bin/env bash\necho ok",
  "probeCommand": null,
  "prompt": "分析新错误并总结原因",
  "notify": "important",
  "explanation": "每 1 分钟检查一次，有新报错才通知智能体。"
}
```"##;
        let res = parse_and_stage_output("auto-1", &dir, raw, "检查日志").unwrap();
        assert_eq!(res.schedule_id, "auto-1");
        assert_eq!(res.name, "检查日志报错");
        assert_eq!(res.cadence, ScheduleCadence::Interval { minutes: 1 });
        assert_eq!(res.agent_trigger, ScheduleAgentTrigger::OnSignal);
        let cmd = res.probe_command.unwrap();
        assert!(cmd.starts_with("bash '"));
        assert!(cmd.contains("_evil_check_errors.sh"));
        assert!(dir.join("state").is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_staging_isolates_revision_and_preserves_live_script() {
        let auto_dir = std::env::temp_dir().join(format!("ompws-author-prev-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&auto_dir).unwrap();
        let live_script = auto_dir.join("check.sh");
        std::fs::write(&live_script, "#!/usr/bin/env bash\necho live\n").unwrap();

        assert_eq!(read_existing_staged_script(&auto_dir), "# check.sh\n#!/usr/bin/env bash\necho live");

        let stage_dir = resolve_stage_dir(&auto_dir, true).unwrap();
        assert!(stage_dir.starts_with(auto_dir.join("revisions")));
        assert_ne!(stage_dir, auto_dir);

        let raw = r##"{"name":"Fixed","cadence":{"kind":"interval","minutes":5},"agentTrigger":"on_signal","scriptFilename":"check.sh","scriptContent":"#!/usr/bin/env bash\necho fixed","probeCommand":null,"prompt":"inspect"}"##;
        let res = parse_and_stage_output("auto-prev", &stage_dir, raw, "fix").unwrap();
        let cmd = res.probe_command.unwrap();
        assert!(cmd.contains("revisions/"), "expected revision path in {cmd}");
        assert_eq!(
            std::fs::read_to_string(&live_script).unwrap(),
            "#!/usr/bin/env bash\necho live\n"
        );
        assert_eq!(
            std::fs::read_to_string(stage_dir.join("check.sh")).unwrap(),
            "#!/usr/bin/env bash\necho fixed\n"
        );
        let _ = std::fs::remove_dir_all(&auto_dir);
    }
}

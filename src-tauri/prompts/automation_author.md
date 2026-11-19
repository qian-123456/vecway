You are generating or updating a Vecway Automation definition for a user request.

Return ONLY a single JSON object (no surrounding prose; markdown ```json fences are acceptable) with this exact schema:
{
  "name": "Short descriptive title in the user's language",
  "cadence": {
    "kind": "interval",
    "minutes": 30
  },
  "agentTrigger": "on_signal",
  "resultMode": "structured",
  "invokesExternalModel": false,
  "probeDescription": "One sentence summarizing what the pre-check script checks",
  "scriptFilename": "check.sh",
  "scriptContent": "#!/usr/bin/env bash\nset -euo pipefail\n...",
  "probeCommand": null,
  "prompt": "Actionable instructions for the AI agent when woken up (or empty string ONLY when agentTrigger is \"never\")",
  "notify": "important",
  "explanation": "1-2 plain sentences explaining what the check step does and when the agent wakes up"
}

Rules:
1. Supported `cadence` shapes:
   - `{"kind":"interval","minutes":30}` (`minutes >= 5`)
   - `{"kind":"daily","time":"09:00","weekdays":[1,2,3,4,5],"every":1}` (`weekdays` omitted or `[]` = every N days; `[1..5]` = Mon-Fri; `0` = Sun .. `6` = Sat)
   - `{"kind":"monthly","day":15,"time":"09:00","every":1}`
   - `{"kind":"once","at":"2026-12-01T09:00:00+08:00"}`
2. Supported `agentTrigger` values:
   - `"on_signal"` (PREFERRED for monitoring/polling/periodic checks): runs the lightweight local script first (0 LLM tokens).
     - Exit `0` with empty stdout, OR exit `10` => Quiet / nothing new (0 tokens, collapsed in history).
     - Exit `0` with non-empty stdout, OR exit `20` => New updates detected (wakes the AI agent and feeds stdout in `<automation_check_output>`).
     - Any other non-zero exit => Script failure.
   - `"never"`: local script/command mode, never wakes Vecway's native agent.
     - Quiet gate: exit `10`, exit `0` with empty stdout, OR structured JSON `{"status":"quiet"}` => Quiet / nothing new (collapsed in history, 0 tokens).
     - When `resultMode` is `"structured"` (default), print a final JSON line `{"status":"ok"|"skipped"|"warning"|"error"|"quiet","summary":"1-2 human sentences","details":"optional","sessionId":"optional"}` so the UI displays a clear human summary.
     - Use `resultMode: "llm_summary"` when wrapping existing unstructured commands/logs so Vecway summarizes non-quiet output with its lightweight summary model.
     - Only set `"invokesExternalModel": true` when the script itself genuinely orchestrates external models/CLIs (multi-model fan-out, existing external pipeline); otherwise prefer `"on_signal"` or `"always"` so Vecway runs the model natively.
   - `"always"`: runs the AI agent on every trigger.
3. Persistent state: Check scripts run in `cwd` (`{{cwd}}`) with `$OMPWS_STATE_DIR` pointing to a persistent per-automation directory (under `{{automation_dir}}/state`). Use files inside `"$OMPWS_STATE_DIR"` (like cursors, hashes, or last-seen timestamps) so repeated checks only report genuine changes.
4. When a script file is needed (almost always for `"on_signal"` or `"never"`), provide `scriptFilename` (safe characters `[A-Za-z0-9._-]+`, e.g. `check.sh` or `check.py`) and complete self-contained `scriptContent`. Set `probeCommand` to `null` (Vecway stages the file and wires the execution command automatically) OR a single-line command when no script file is needed.
5. NEVER create or edit system `crontab` or `LaunchAgents` in the script or prompt.

Context:
- Current local time: `{{local_now}}`
- Workspace directory (`cwd`): `{{cwd}}`
- Automation managed directory: `{{automation_dir}}`
{{#if current_json}}
- Existing configuration being updated:
```json
{{current_json}}
```
{{/if}}
{{#if existing_script}}
- Existing staged check script source inside `{{automation_dir}}`:
```
{{existing_script}}
```
{{/if}}
- User request:
{{request}}

// omp-workspace automations extension (installed + loaded by the OMP Workspace app).
//
// Strictly on-demand: dormant in ordinary chat sessions (tool hidden and refused)
// until the user explicitly invokes `/automate [request]` or toggles Automation mode
// from the `+` menu / Automations page (`/automation-action enable`).
//
// Supports staging local scripts with accurate runtime inference (Python/Node/Bash),
// multi-draft proposals (multiple confirmation cards side by side), and full draft
// fields (model, thinking, resultMode, invokesExternalModel).
//
// Never write to stdout (JSON-RPC frames live there) and never throw out of handlers.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Entry = { type?: string; customType?: string; data?: unknown };
type Ctx = {
	cwd: string;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, type?: string): void;
	};
	sessionManager?: {
		getEntries?: () => Entry[];
	};
};

type ToolDef = {
	name: string;
	label: string;
	description: string;
	loadMode?: "essential" | "discoverable";
	approval?: "read" | "write" | "exec";
	parameters: unknown;
	execute: (...args: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
};

type ZodNode = {
	optional(): ZodNode;
	describe(d: string): ZodNode;
};

type ZodLike = {
	object(shape: Record<string, unknown>): unknown;
	string(): ZodNode;
	number(): ZodNode;
	boolean(): ZodNode;
	array(item: unknown): ZodNode;
	enum(values: readonly [string, ...string[]]): ZodNode;
	unknown(): ZodNode;
};

type Pi = {
	zod?: ZodLike;
	on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void;
	registerTool(def: ToolDef): void;
	registerCommand(
		name: string,
		def: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> },
	): void;
	appendEntry(customType: string, data?: unknown): void;
	getActiveTools?: () => string[];
	setActiveTools?: (names: string[]) => Promise<void> | void;
	sendUserMessage?: (text: string) => void;
};

const STATUS_KEY = "ompws-automation";
const DRAFT_ENTRY = "ompws-automation-draft";
const STATE_ENTRY = "ompws-automation-state";
const TOOL_NAME = "vecway_automation";

type StoredDraftItem = {
	v: 1;
	draftId: string;
	status: "pending" | "saved" | "dismissed";
	draft: Record<string, unknown>;
	presentFields?: string[];
	cadencePresentFields?: string[];
};

type StoredState = {
	v: 2;
	mode: "active" | "idle";
	drafts: StoredDraftItem[];
};

const AUTOMATION_MODE_CONTEXT = `<automation-mode>
Vecway Automation customization mode is ACTIVE for this conversation.
Use \`vecway_automation\` to inspect existing automations, stage local scripts, and propose interactive Automation Draft Cards in chat.
Guidelines:
1. Prefer native Vecway execution:
   - \`agentTrigger: "on_signal"\` when a lightweight local script checks conditions at 0 tokens and wakes Vecway's native agent only on signal.
   - \`agentTrigger: "always"\` when the agent should run directly on schedule.
   - Specify \`model\` and \`thinking\` directly on \`draft\` when the user wants a specific model/effort — do NOT work around it by spawning CLI models inside a shell script.
   - Only use \`agentTrigger: "never"\` with \`invokesExternalModel: true\` when the task genuinely requires script-side multi-model fan-out or an existing external pipeline.
2. When using a local script:
   - Stage it with \`stage_script\` and verify it in \`cwd\` before proposing.
   - Quiet checks (nothing new) should exit 10, exit 0 with empty stdout, or print \`{"status":"quiet"}\` so Vecway collapses quiet runs.
   - Set \`resultMode: "structured"\` (default) and emit a final JSON line \`{"status":"ok"|"skipped"|"warning"|"error"|"quiet","summary":"1-2 human sentences","details":"optional","sessionId":"optional"}\`, OR set \`resultMode: "llm_summary"\` when wrapping unstructured logs/commands so Vecway summarizes non-quiet output with its lightweight model.
3. Multi-task workflows: if a request naturally splits into multiple independent automations, call \`propose\` once per task — Vecway displays multiple draft cards side by side.
4. Always provide a concise human-readable \`draft.summary\` (1-2 sentences in the user's language). Never edit OS \`crontab\` or \`LaunchAgents\`.
</automation-mode>`;

function dataDir(): string {
	const override = process.env.OMPWS_DATA_DIR?.trim();
	return override || join(homedir(), ".vecway");
}

function sanitizeSegment(raw: string, fallback: string): string {
	const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+|\.+$/g, "");
	return cleaned || fallback;
}

function shellQuote(filePath: string): string {
	return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function inferRunner(filename: string, content: string): string {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".py")) return "python3";
	if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) return "node";
	if (lower.endsWith(".ts") || lower.endsWith(".mts")) return "bun";
	const firstLine = content.trimStart().split("\n", 1)[0] ?? "";
	if (firstLine.startsWith("#!")) {
		if (/\bnode\b/.test(firstLine)) return "node";
		if (/\bpython3?\b/.test(firstLine)) return "python3";
		if (/\bbun\b/.test(firstLine)) return "bun";
	}
	return "bash";
}

function publishStatus(
	ctx: Ctx | undefined,
	state: StoredState,
	newlyProposedDraftId?: string,
): void {
	try {
		if (!ctx?.ui?.setStatus) return;
		const visibleDrafts = state.drafts.filter((d) => d.status !== "dismissed");
		if (state.mode !== "active" && visibleDrafts.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const latest = visibleDrafts[visibleDrafts.length - 1];
		const payload: Record<string, unknown> = {
			v: 1,
			mode: state.mode,
			drafts: visibleDrafts,
		};
		if (
			newlyProposedDraftId &&
			visibleDrafts.some((d) => d.draftId === newlyProposedDraftId && d.status === "pending")
		) {
			payload.lastProposedDraftId = newlyProposedDraftId;
		}
		if (latest) {
			payload.draftId = latest.draftId;
			payload.status = latest.status;
			payload.draft = latest.draft;
			if (latest.presentFields) payload.presentFields = latest.presentFields;
			if (latest.cadencePresentFields) payload.cadencePresentFields = latest.cadencePresentFields;
		}
		ctx.ui.setStatus(STATUS_KEY, JSON.stringify(payload));
	} catch {
		// Never throw into the RPC host.
	}
}

function restoreState(ctx: Ctx | undefined): StoredState {
	try {
		const entries = ctx?.sessionManager?.getEntries?.() ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e?.type === "custom" && e.customType === STATE_ENTRY && e.data && typeof e.data === "object") {
				const s = e.data as Partial<StoredState>;
				if (s.v === 2 && Array.isArray(s.drafts)) {
					return {
						v: 2,
						mode: s.mode === "active" ? "active" : "idle",
						drafts: s.drafts.filter(
							(d): d is StoredDraftItem =>
								Boolean(d && typeof d === "object" && d.draftId && d.draft),
						),
					};
				}
			}
			// Backward compatibility with v1 single-draft entries
			if (e?.type === "custom" && e.customType === DRAFT_ENTRY && e.data && typeof e.data === "object") {
				const d = e.data as Partial<StoredDraftItem>;
				if (d.draftId && d.draft && (d.status === "pending" || d.status === "saved" || d.status === "dismissed")) {
					return {
						v: 2,
						mode: d.status === "pending" ? "active" : "idle",
						drafts: [{ v: 1, draftId: d.draftId, status: d.status, draft: d.draft }],
					};
				}
			}
		}
	} catch {
		// ignore
	}
	return { v: 2, mode: "idle", drafts: [] };
}

function resolveCtx(args: unknown[], fallback: Ctx | undefined): Ctx | undefined {
	for (let i = args.length - 1; i >= 0; i--) {
		const candidate = args[i] as Partial<Ctx> | undefined;
		if (candidate && typeof candidate === "object" && ("cwd" in candidate || "ui" in candidate)) {
			return candidate as Ctx;
		}
	}
	return fallback;
}

async function syncToolVisibility(pi: Pi, active: boolean): Promise<void> {
	try {
		if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
		const current = pi.getActiveTools();
		const has = current.includes(TOOL_NAME);
		if (active && !has) {
			await pi.setActiveTools([...current, TOOL_NAME]);
		} else if (!active && has) {
			await pi.setActiveTools(current.filter((n) => n !== TOOL_NAME));
		}
	} catch {
		// ignore host incompatibilities
	}
}

export default function ompWorkspaceAutomation(pi: Pi): void {
	let lastCtx: Ctx | undefined;
	let state: StoredState = { v: 2, mode: "idle", drafts: [] };

	const persistAndPublish = (ctx: Ctx | undefined, newlyProposedDraftId?: string) => {
		try {
			pi.appendEntry(STATE_ENTRY, state);
		} catch {
			// ignore
		}
		publishStatus(ctx, state, newlyProposedDraftId);
	};

	const setMode = async (active: boolean, ctx: Ctx | undefined) => {
		state = { ...state, mode: active ? "active" : "idle" };
		await syncToolVisibility(pi, active);
		persistAndPublish(ctx);
	};

	try {
		pi.on("session_start", (_ev, ctx) => {
			lastCtx = ctx;
			state = restoreState(ctx);
			void syncToolVisibility(pi, state.mode === "active");
			publishStatus(ctx, state);
		});
		pi.on("turn_start", (_ev, ctx) => {
			lastCtx = ctx;
		});
		pi.on("before_agent_start", (ev, ctx) => {
			lastCtx = ctx;
			if (state.mode !== "active") return undefined;
			const eventObj = (ev && typeof ev === "object" ? ev : {}) as { systemPrompt?: string };
			if (typeof eventObj.systemPrompt === "string") {
				return { systemPrompt: `${eventObj.systemPrompt}\n\n${AUTOMATION_MODE_CONTEXT}` };
			}
			return { systemPrompt: AUTOMATION_MODE_CONTEXT };
		});
	} catch {
		// ignore
	}

	const z = pi.zod;
	if (z && typeof pi.registerTool === "function") {
		try {
			pi.registerTool({
				name: TOOL_NAME,
				label: "Vecway Automation",
				description:
					"On-demand tool (active only after /automate or Automation mode is enabled): list existing Vecway automations, stage local scripts inside Vecway's managed automations directory (using $OMPWS_STATE_DIR for persistent state), and propose one or more interactive Automation Draft Cards in chat. NEVER edit OS crontab or LaunchAgents.",
				loadMode: "discoverable",
				approval: "read",
				parameters: z.object({
					action: z.enum(["list", "stage_script", "propose"]).describe(
						"list: inspect current automations; stage_script: write a script into ~/.vecway/automations/<id>/; propose: show a confirmation card in chat (multiple distinct drafts can coexist)",
					),
					automationId: z.string().optional().describe("Target automation ID (reuse existing or omit to allocate one)"),
					scriptFilename: z.string().optional().describe("Script filename for stage_script (e.g. check.sh, check.py, check.mjs)"),
					scriptContent: z.string().optional().describe("Full executable script body for stage_script"),
					draft: z.unknown().optional().describe(
						"Draft config for propose: { id?, name, summary, cadence, agentTrigger ('always'|'on_signal'|'never'), resultMode? ('structured'|'llm_summary'), invokesExternalModel?, model?, thinking?, probeDescription?, probeCommand?, prompt, cwd?, runMode?, notify? }",
					),
				}),
				async execute(...rawArgs) {
					try {
						const params = (rawArgs[1] ?? {}) as Record<string, unknown>;
						const ctx = resolveCtx(rawArgs, lastCtx);
						if (ctx) lastCtx = ctx;
						if (state.mode !== "active") {
							return {
								content: [
									{
										type: "text",
										text: "Automation customization mode is not active in this chat. Only use vecway_automation when the user explicitly invokes /automate or enables Automation mode.",
									},
								],
							};
						}
						const action = String(params.action ?? "");

						if (action === "list") {
							const catPath = join(dataDir(), "automations", "catalog.json");
							const items = existsSync(catPath) ? JSON.parse(readFileSync(catPath, "utf8")) : [];
							return {
								content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
								details: { count: Array.isArray(items) ? items.length : 0 },
							};
						}

						if (action === "stage_script") {
							const content = typeof params.scriptContent === "string" ? params.scriptContent : "";
							if (!content.trim()) {
								return {
									content: [{ type: "text", text: "Missing non-empty scriptContent for stage_script." }],
								};
							}
							const safeId = sanitizeSegment(
								typeof params.automationId === "string" ? params.automationId : newId("auto"),
								newId("auto"),
							);
							const safeFile = sanitizeSegment(
								typeof params.scriptFilename === "string" ? params.scriptFilename : "check.sh",
								"check.sh",
							);
							const autoDir = join(dataDir(), "automations", safeId);
							const stateDir = join(autoDir, "state");
							mkdirSync(stateDir, { recursive: true });
							const scriptPath = join(autoDir, safeFile);
							writeFileSync(scriptPath, `${content.replace(/\s+$/, "")}\n`, "utf8");
							try {
								chmodSync(scriptPath, 0o755);
							} catch {
								// ignore on non-POSIX filesystems
							}
							const runner = inferRunner(safeFile, content);
							const suggestedProbeCommand = `${runner} ${shellQuote(scriptPath)}`;
							const payload = {
								automationId: safeId,
								automationDir: autoDir,
								stateDir,
								scriptPath,
								suggestedProbeCommand,
							};
							return {
								content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
								details: payload,
							};
						}

						if (action === "propose") {
							const rawDraft = params.draft;
							if (!rawDraft || typeof rawDraft !== "object" || Array.isArray(rawDraft)) {
								return {
									content: [{ type: "text", text: "Missing draft object for propose action." }],
								};
							}
							const rawRecord = rawDraft as Record<string, unknown>;
							const presentFields = Object.keys(rawRecord).filter((k) => {
								const v = rawRecord[k];
								if (v === undefined) return false;
								if (k === "cwd" && (typeof v !== "string" || !v.trim())) return false;
								if (k === "cadence" && (!v || typeof v !== "object" || Array.isArray(v))) return false;
								return true;
							});
							const rawCadence =
								rawRecord.cadence && typeof rawRecord.cadence === "object" && !Array.isArray(rawRecord.cadence)
									? (rawRecord.cadence as Record<string, unknown>)
									: null;
							const cadencePresentFields = rawCadence
								? Object.keys(rawCadence).filter((k) => rawCadence[k] !== undefined)
								: [];
							const draftObj = { ...rawRecord };
							if (typeof draftObj.cwd !== "string" || !draftObj.cwd.trim()) {
								draftObj.cwd = ctx?.cwd || ".";
							}
							if (typeof draftObj.prompt !== "string") {
								draftObj.prompt = "";
							}
							if (!draftObj.cadence || typeof draftObj.cadence !== "object") {
								draftObj.cadence = { kind: "interval", minutes: 30 };
							}
							const draftId = newId("draft");
							const item: StoredDraftItem = {
								v: 1,
								draftId,
								status: "pending",
								draft: draftObj,
								presentFields,
								cadencePresentFields,
							};
							// distinct automations coexist side by side.
							const incomingId = typeof draftObj.id === "string" && draftObj.id.trim() ? draftObj.id.trim() : null;
							const incomingName = typeof draftObj.name === "string" ? draftObj.name.trim() : "";
							const existingIdx = state.drafts.findIndex((existing) => {
								if (existing.status !== "pending") return false;
								const exId = typeof existing.draft.id === "string" ? existing.draft.id.trim() : null;
								const exName = typeof existing.draft.name === "string" ? existing.draft.name.trim() : "";
								if (incomingId && exId && incomingId === exId) return true;
								if (!incomingId && incomingName && exName === incomingName) return true;
								return false;
							});
							const nextDrafts = [...state.drafts];
							if (existingIdx >= 0) {
								nextDrafts[existingIdx] = item;
							} else {
								nextDrafts.push(item);
							}
							state = { v: 2, mode: "active", drafts: nextDrafts };
							persistAndPublish(ctx, draftId);
							return {
								content: [
									{
										type: "text",
										text: `Staged Automation Draft Card (${draftId}) for "${String(draftObj.name || "Untitled automation")}". Total pending cards: ${nextDrafts.filter((d) => d.status === "pending").length}. The user can test, adjust, or confirm & enable directly in Vecway.`,
									},
								],
								details: item,
							};
						}

						return {
							content: [{ type: "text", text: `Unknown vecway_automation action: ${action}` }],
						};
					} catch (e) {
						return {
							content: [{ type: "text", text: `vecway_automation error: ${String(e)}` }],
						};
					}
				},
			});
		} catch {
			// ignore tool registration failure on incompatible hosts
		}
	}

	try {
		pi.registerCommand("automate", {
			description: "Customize a Vecway Automation from the current chat or a new requirement",
			async handler(args: string, ctx: Ctx) {
				lastCtx = ctx;
				await setMode(true, ctx);
				const trimmed = args.trim();
				if (typeof pi.sendUserMessage === "function") {
					if (trimmed) {
						pi.sendUserMessage(trimmed);
					} else {
						pi.sendUserMessage(
							"请结合我们当前对话的内容，帮我设计并生成对应的 Vecway 自动化方案（如果适合拆成多个独立任务可以分别提出确认卡）。",
						);
					}
				}
			},
		});

		pi.registerCommand("automation-action", {
			description: "Internal host control for Vecway Automation mode and Draft Cards",
			async handler(args: string, ctx: Ctx) {
				lastCtx = ctx;
				const parts = args.trim().split(/\s+/);
				if (parts[0] === "enable") {
					await setMode(true, ctx);
					return;
				}
				if (parts[0] === "disable") {
					await setMode(false, ctx);
					return;
				}
				if (parts[0] !== "resolve" || parts.length < 3) return;
				const draftId = parts[1];
				const nextStatus: StoredDraftItem["status"] = parts[2] === "saved" ? "saved" : "dismissed";
				const nextDrafts: StoredDraftItem[] = state.drafts.map((item) =>
					item.draftId === draftId ? { ...item, status: nextStatus } : item,
				);
				// Keep automation customization mode active until the user explicitly turns it off
				// (confirming or dismissing drafts must not strip vecway_automation mid-conversation).
				state = {
					v: 2,
					mode: state.mode,
					drafts: nextDrafts,
				};
				persistAndPublish(ctx);
			},
		});
	} catch {
		// ignore
	}
}

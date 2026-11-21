/** [B] Automation mode + draft state published by `extension/omp-workspace-automation.ts`
 * under the `ompws-automation` `setStatus` key. */

import type {
	ScheduleAgentTrigger,
	ScheduleCadence,
	ScheduleDraft,
	ScheduleNotify,
	ScheduleResultMode,
	ScheduleRunMode,
} from "../../../lib/contracts";
import { ensureLive } from "../../../lib/ensureLive";
import { rpcSend } from "../../../lib/ipc";
import { useLive } from "../../../stores/live";

export const AUTOMATION_STATUS_KEY = "ompws-automation";

export interface AutomationDraftStatus {
	draftId: string;
	status: "pending" | "saved" | "dismissed";
	draft: ScheduleDraft;
	/** Concise human-facing summary shown on the draft confirmation card instead of raw prompt instructions. */
	summary?: string | null;
}

export interface AutomationSessionState {
	mode: "active" | "idle";
	drafts: AutomationDraftStatus[];
}

function asCadence(raw: unknown): ScheduleCadence {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { kind: "interval", minutes: 30 };
	}
	const c = raw as Record<string, unknown>;
	switch (c.kind) {
		case "interval": {
			const mins =
				typeof c.minutes === "number" && Number.isFinite(c.minutes)
					? Math.max(1, Math.floor(c.minutes))
					: 30;
			return { kind: "interval", minutes: mins };
		}
		case "daily": {
			const time = typeof c.time === "string" && /^\d{2}:\d{2}$/.test(c.time) ? c.time : "09:00";
			const weekdays = Array.isArray(c.weekdays)
				? c.weekdays.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
				: undefined;
			const every = typeof c.every === "number" && c.every > 1 ? Math.floor(c.every) : undefined;
			return { kind: "daily", time, weekdays, every };
		}
		case "monthly": {
			const day = typeof c.day === "number" ? Math.min(31, Math.max(1, Math.floor(c.day))) : 1;
			const time = typeof c.time === "string" && /^\d{2}:\d{2}$/.test(c.time) ? c.time : "09:00";
			const every = typeof c.every === "number" && c.every > 1 ? Math.floor(c.every) : undefined;
			return { kind: "monthly", day, time, every };
		}
		case "once": {
			const at =
				typeof c.at === "string" && c.at ? c.at : new Date(Date.now() + 3600_000).toISOString();
			return { kind: "once", at };
		}
		default:
			return { kind: "interval", minutes: 30 };
	}
}

function asTrigger(raw: unknown, hasProbe: boolean): ScheduleAgentTrigger {
	if (raw === "always" || raw === "on_signal" || raw === "never") return raw;
	return hasProbe ? "on_signal" : "always";
}

function asResultMode(raw: unknown): ScheduleResultMode {
	return raw === "llm_summary" ? "llm_summary" : "structured";
}

function asNotify(raw: unknown): ScheduleNotify {
	if (raw === "important" || raw === "all" || raw === "none") return raw;
	return "important";
}

function asRunMode(raw: unknown): ScheduleRunMode {
	return raw === "worktree" ? "worktree" : "local";
}

function parseDraftItem(obj: Record<string, unknown>): AutomationDraftStatus | null {
	if (typeof obj.draftId !== "string" || !obj.draftId) return null;
	if (!obj.draft || typeof obj.draft !== "object" || Array.isArray(obj.draft)) return null;
	const status =
		obj.status === "saved" || obj.status === "dismissed" ? obj.status : "pending";
	const rawDraft = obj.draft as Record<string, unknown>;
	const probeCommand =
		typeof rawDraft.probeCommand === "string" && rawDraft.probeCommand.trim()
			? rawDraft.probeCommand.trim()
			: null;
	const probeDescription =
		typeof rawDraft.probeDescription === "string" && rawDraft.probeDescription.trim()
			? rawDraft.probeDescription.trim()
			: null;
	const summary =
		typeof rawDraft.summary === "string" && rawDraft.summary.trim()
			? rawDraft.summary.trim()
			: undefined;
	const model =
		typeof rawDraft.model === "string" && rawDraft.model.trim()
			? rawDraft.model.trim()
			: null;
	const thinking =
		typeof rawDraft.thinking === "string" && rawDraft.thinking.trim()
			? rawDraft.thinking.trim()
			: null;

	const draft: ScheduleDraft = {
		id:
			typeof rawDraft.id === "string" && rawDraft.id.trim()
				? rawDraft.id.trim()
				: undefined,
		name:
			typeof rawDraft.name === "string" && rawDraft.name.trim()
				? rawDraft.name.trim()
				: "未命名自动化",
		prompt: typeof rawDraft.prompt === "string" ? rawDraft.prompt.trim() : "",
		cwd:
			typeof rawDraft.cwd === "string" && rawDraft.cwd.trim()
				? rawDraft.cwd.trim()
				: ".",
		runMode: asRunMode(rawDraft.runMode),
		cadence: asCadence(rawDraft.cadence),
		model,
		thinking,
		notify: asNotify(rawDraft.notify),
		probeCommand,
		probeDescription,
		agentTrigger: asTrigger(rawDraft.agentTrigger, Boolean(probeCommand)),
		resultMode: asResultMode(rawDraft.resultMode),
		invokesExternalModel: rawDraft.invokesExternalModel === true,
		enabled: true,
	};

	return {
		draftId: obj.draftId,
		status,
		draft,
		...(summary ? { summary } : {}),
	};
}

export function parseAutomationSessionState(text: unknown): AutomationSessionState | null {
	if (text === undefined || text === null || (typeof text === "string" && !text.trim())) {
		return { mode: "idle", drafts: [] };
	}
	if (typeof text !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	return parseAutomationStateObject(parsed, false);
}

function parseAutomationStateObject(
	parsed: unknown,
	allowV2: boolean,
): AutomationSessionState | null {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const obj = parsed as Record<string, unknown>;
	const validVersion = allowV2 ? obj.v === 1 || obj.v === 2 : obj.v === 1;
	if (!validVersion) return null;

	if (Array.isArray(obj.drafts)) {
		const drafts = obj.drafts
			.filter((d): d is Record<string, unknown> => Boolean(d && typeof d === "object"))
			.map(parseDraftItem)
			.filter((d): d is AutomationDraftStatus => d !== null);
		const mode = obj.mode === "active" ? "active" : "idle";
		return { mode, drafts };
	}

	const single = parseDraftItem(obj);
	if (single) {
		return {
			mode: obj.mode === "active" || single.status === "pending" ? "active" : "idle",
			drafts: [single],
		};
	}
	if (obj.mode === "active" || obj.mode === "idle") {
		return { mode: obj.mode, drafts: [] };
	}
	return null;
}

/** Hydrate persisted `ompws-automation-state` (v2) or legacy `ompws-automation-draft` (v1) from transcript. */
export function parseSavedAutomationState(value: unknown): AutomationSessionState | null {
	return parseAutomationStateObject(value, true);
}

/** Legacy helper returning the latest draft item (kept for unit tests and compatibility). */
export function parseAutomationStatus(text: unknown): AutomationDraftStatus | null {
	const state = parseAutomationSessionState(text);
	if (!state || state.drafts.length === 0) return null;
	return state.drafts[state.drafts.length - 1] ?? null;
}

export async function setAutomationModeAction(
	sessionId: string,
	enabled: boolean,
): Promise<void> {
	try {
		if (!useLive.getState().sessions[sessionId]?.alive) {
			await ensureLive(sessionId);
		}
		await rpcSend(sessionId, {
			type: "prompt",
			message: `/automation-action ${enabled ? "enable" : "disable"}`,
		});
	} catch {
		// Best-effort RPC toggle.
	}
}

export async function resolveAutomationDraftAction(
	sessionId: string,
	draftId: string,
	outcome: "saved" | "dismissed",
): Promise<void> {
	try {
		if (!useLive.getState().sessions[sessionId]?.alive) {
			await ensureLive(sessionId);
		}
		await rpcSend(sessionId, {
			type: "prompt",
			message: `/automation-action resolve ${draftId} ${outcome}`,
		});
	} catch {
		// Best-effort persistence back into session transcript.
	}
}

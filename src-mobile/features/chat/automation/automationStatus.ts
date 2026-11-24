/**
 * Mobile automation session state parser (`ompws-automation` `setStatus` key),
 * cross-remount probe test cache, manual-edit handoff, and conversational launch helper.
 */
import { nav, paths } from "../../../core/nav";
import { useSessions } from "../../../core/stores/sessions";
import type { SpaceMode } from "../../../core/types";
import {
	AUTOMATION_COMPOSER_SYSTEM_PROMPT,
	type Cadence,
	type NotifyMode,
	type ProbeTestResult,
	type RunMode,
	type Schedule,
	type ScheduleAgentTrigger,
	type ScheduleDraft,
	type ScheduleResultMode,
} from "../../more/schedule";
import { draftBook, queueFirstSend } from "../lib/drafts";

export const AUTOMATION_STATUS_KEY = "ompws-automation";

export interface AutomationDraftStatus {
	draftId: string;
	status: "pending" | "saved" | "dismissed";
	draft: ScheduleDraft;
	summary?: string | null;
	presentFields?: ReadonlySet<string>;
	cadencePresentFields?: ReadonlySet<string>;
}
export interface AutomationSessionState {
	mode: "active" | "idle";
	drafts: AutomationDraftStatus[];
}

function asCadence(raw: unknown): Cadence {
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
			const every =
				typeof c.every === "number" && Number.isFinite(c.every) && c.every >= 1
					? Math.floor(c.every)
					: undefined;
			const anchor = typeof c.anchor === "string" && c.anchor.trim() ? c.anchor.trim() : undefined;
			return {
				kind: "daily",
				time,
				...(weekdays !== undefined ? { weekdays } : {}),
				...(every !== undefined ? { every } : {}),
				...(anchor ? { anchor } : {}),
			};
		}
		case "monthly": {
			const day =
				typeof c.day === "number" && Number.isFinite(c.day)
					? Math.min(31, Math.max(1, Math.floor(c.day)))
					: 1;
			const time = typeof c.time === "string" && /^\d{2}:\d{2}$/.test(c.time) ? c.time : "09:00";
			const every =
				typeof c.every === "number" && Number.isFinite(c.every) && c.every >= 1
					? Math.floor(c.every)
					: undefined;
			const anchor = typeof c.anchor === "string" && c.anchor.trim() ? c.anchor.trim() : undefined;
			return {
				kind: "monthly",
				day,
				time,
				...(every !== undefined ? { every } : {}),
				...(anchor ? { anchor } : {}),
			};
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

function asNotify(raw: unknown): NotifyMode {
	if (raw === "important" || raw === "all" || raw === "none") return raw;
	return "important";
}

function asRunMode(raw: unknown): RunMode {
	return raw === "worktree" ? "worktree" : "local";
}

const SPACE_MODES: Record<string, true> = { code: true, work: true, study: true, research: true, chat: true };
const APPROVAL_MODES: Record<string, true> = { "always-ask": true, write: true, yolo: true };
function parseDraftItem(obj: Record<string, unknown>): AutomationDraftStatus | null {
	if (typeof obj.draftId !== "string" || !obj.draftId) return null;
	if (!obj.draft || typeof obj.draft !== "object" || Array.isArray(obj.draft)) return null;
	const status = obj.status === "saved" || obj.status === "dismissed" ? obj.status : "pending";
	const rawDraft = obj.draft as Record<string, unknown>;
	const presentFields = new Set(Object.keys(rawDraft).filter((k) => rawDraft[k] !== undefined));
	const cadenceRaw =
		rawDraft.cadence && typeof rawDraft.cadence === "object" && !Array.isArray(rawDraft.cadence)
			? (rawDraft.cadence as Record<string, unknown>)
			: null;
	const cadencePresentFields = cadenceRaw
		? new Set(Object.keys(cadenceRaw).filter((k) => cadenceRaw[k] !== undefined))
		: undefined;

	const has = (k: string) => presentFields.has(k);
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
			: typeof obj.summary === "string" && obj.summary.trim()
				? obj.summary.trim()
				: undefined;
	const model =
		typeof rawDraft.model === "string" && rawDraft.model.trim() ? rawDraft.model.trim() : null;
	const thinking =
		typeof rawDraft.thinking === "string" && rawDraft.thinking.trim()
			? rawDraft.thinking.trim()
			: null;
	const mode =
		typeof rawDraft.mode === "string" && SPACE_MODES[rawDraft.mode]
			? (rawDraft.mode as Schedule["mode"])
			: undefined;
	const approvalMode =
		rawDraft.approvalMode === null
			? null
			: typeof rawDraft.approvalMode === "string" && APPROVAL_MODES[rawDraft.approvalMode.trim()]
				? rawDraft.approvalMode.trim()
				: typeof rawDraft.approvalMode === "string" && rawDraft.approvalMode.trim() === ""
					? null
					: undefined;
	const endAt =
		rawDraft.endAt === null
			? null
			: typeof rawDraft.endAt === "string" && rawDraft.endAt.trim()
				? rawDraft.endAt.trim()
				: undefined;
	const maxRuns =
		rawDraft.maxRuns === null
			? null
			: typeof rawDraft.maxRuns === "number" && Number.isFinite(rawDraft.maxRuns) && rawDraft.maxRuns >= 1
				? Math.floor(rawDraft.maxRuns)
				: undefined;

	const draft: ScheduleDraft = {
		name:
			typeof rawDraft.name === "string" && rawDraft.name.trim()
				? rawDraft.name.trim()
				: "未命名自动化",
		prompt: typeof rawDraft.prompt === "string" ? rawDraft.prompt.trim() : "",
		cwd: typeof rawDraft.cwd === "string" && rawDraft.cwd.trim() ? rawDraft.cwd.trim() : ".",
		runMode: asRunMode(rawDraft.runMode),
		cadence: asCadence(rawDraft.cadence),
		...(typeof rawDraft.id === "string" && rawDraft.id.trim() ? { id: rawDraft.id.trim() } : {}),
		...(mode !== undefined ? { mode } : {}),
		...(has("model") ? { model } : {}),
		...(has("thinking") ? { thinking } : {}),
		...(has("approvalMode") && approvalMode !== undefined ? { approvalMode } : {}),
		...(typeof rawDraft.enabled === "boolean" ? { enabled: rawDraft.enabled } : {}),
		...(has("notify") ? { notify: asNotify(rawDraft.notify) } : {}),
		...(typeof rawDraft.newChatEachRun === "boolean" ? { newChatEachRun: rawDraft.newChatEachRun } : {}),
		...(has("endAt") && endAt !== undefined ? { endAt } : {}),
		...(has("maxRuns") && maxRuns !== undefined ? { maxRuns } : {}),
		...(has("probeCommand") ? { probeCommand } : {}),
		...(has("probeDescription") ? { probeDescription } : {}),
		...(has("agentTrigger") ? { agentTrigger: asTrigger(rawDraft.agentTrigger, Boolean(probeCommand)) } : {}),
		...(has("resultMode") ? { resultMode: asResultMode(rawDraft.resultMode) } : {}),
		...(typeof rawDraft.invokesExternalModel === "boolean"
			? { invokesExternalModel: rawDraft.invokesExternalModel }
			: {}),
	};

	return {
		draftId: obj.draftId,
		status,
		draft,
		presentFields,
		...(cadencePresentFields ? { cadencePresentFields } : {}),
		...(summary ? { summary } : {}),
	};
}

/** Merge only explicitly present proposed fields onto an existing authoritative schedule. */
export function mergeAutomationDraftOntoSchedule(existing: Schedule, item: AutomationDraftStatus): Schedule {
	const { draft } = item;
	const has = (k: keyof ScheduleDraft): boolean =>
		item.presentFields ? item.presentFields.has(k) : draft[k] !== undefined;
	let cadence = existing.cadence;
	if (has("cadence")) {
		if (
			(draft.cadence.kind === "daily" && existing.cadence.kind === "daily") ||
			(draft.cadence.kind === "monthly" && existing.cadence.kind === "monthly")
		) {
			const hasAnchor = item.cadencePresentFields
				? item.cadencePresentFields.has("anchor")
				: Boolean(draft.cadence.anchor);
			cadence = {
				...draft.cadence,
				...(!hasAnchor && existing.cadence.anchor ? { anchor: existing.cadence.anchor } : {}),
			};
		} else {
			cadence = draft.cadence;
		}
	}
	return {
		...existing,
		name: has("name") ? draft.name : existing.name,
		prompt: has("prompt") ? draft.prompt : existing.prompt,
		cwd: has("cwd") ? draft.cwd : existing.cwd,
		mode: has("mode") && draft.mode ? draft.mode : existing.mode,
		runMode: has("runMode") ? draft.runMode : existing.runMode,
		cadence,
		model: has("model") ? (draft.model ?? null) : existing.model,
		thinking: has("thinking") ? (draft.thinking ?? null) : existing.thinking,
		approvalMode: has("approvalMode") ? (draft.approvalMode ?? null) : existing.approvalMode,
		enabled: has("enabled") && typeof draft.enabled === "boolean" ? draft.enabled : existing.enabled,
		notify: has("notify") && draft.notify ? draft.notify : existing.notify,
		newChatEachRun:
			has("newChatEachRun") && typeof draft.newChatEachRun === "boolean"
				? draft.newChatEachRun
				: existing.newChatEachRun,
		endAt: has("endAt") ? (draft.endAt ?? null) : existing.endAt,
		maxRuns: has("maxRuns") ? (draft.maxRuns ?? null) : existing.maxRuns,
		probeCommand: has("probeCommand") ? (draft.probeCommand ?? null) : existing.probeCommand,
		probeDescription: has("probeDescription") ? (draft.probeDescription ?? null) : existing.probeDescription,
		agentTrigger: has("agentTrigger") ? draft.agentTrigger : existing.agentTrigger,
		resultMode: has("resultMode") ? draft.resultMode : existing.resultMode,
		invokesExternalModel:
			has("invokesExternalModel") && typeof draft.invokesExternalModel === "boolean"
				? draft.invokesExternalModel
				: existing.invokesExternalModel,
	};
}
/** Parse automation state from either a JSON status string or a pre-parsed object. */
export function parseAutomationSessionState(raw: unknown): AutomationSessionState | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw === "string") {
		if (!raw.trim()) return { mode: "idle", drafts: [] };
		try {
			return parseAutomationSessionState(JSON.parse(raw));
		} catch {
			return null;
		}
	}
	if (typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	const mode: "active" | "idle" = obj.mode === "active" ? "active" : "idle";
	const rawDrafts = Array.isArray(obj.drafts) ? obj.drafts : [];
	const drafts: AutomationDraftStatus[] = [];
	for (const entry of rawDrafts) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const parsed = parseDraftItem(entry as Record<string, unknown>);
		if (parsed) drafts.push(parsed);
	}
	// Legacy single-draft payload fallback (`{ draftId, status, draft }`)
	if (drafts.length === 0 && typeof obj.draftId === "string" && obj.draft) {
		const single = parseDraftItem(obj);
		if (single) drafts.push(single);
	}
	return { mode, drafts };
}

/** Cross-remount probe test result cache keyed by `${sessionId}:${draftId}`. */
const probeTestCache = new Map<string, ProbeTestResult>();

export function getCachedProbeResult(sessionId: string, draftId: string): ProbeTestResult | null {
	return probeTestCache.get(`${sessionId}:${draftId}`) ?? null;
}

export function setCachedProbeResult(sessionId: string, draftId: string, res: ProbeTestResult): void {
	probeTestCache.set(`${sessionId}:${draftId}`, res);
}

/** One-shot handoff when switching a draft card to manual fine-tuning in ScheduleFormPage. */
let pendingManualDraft: { targetKey: string; draft: ScheduleDraft } | null = null;

export function stashManualScheduleDraft(targetKey: string, draft: ScheduleDraft): void {
	pendingManualDraft = { targetKey, draft };
}

export function takeManualScheduleDraft(targetKey: string): ScheduleDraft | null {
	if (!pendingManualDraft || pendingManualDraft.targetKey !== targetKey) return null;
	const d = pendingManualDraft.draft;
	pendingManualDraft = null;
	return d;
}

/** Launch a dedicated conversational automation session and open chat. */
export async function startAutomationChat(opts: {
	cwd: string;
	mode?: SpaceMode;
	appendSystemPrompt?: string;
	prefill?: string;
	autoSend?: boolean;
	prepareAttachments?: (sessionId: string) => Promise<unknown[] | null>;
}): Promise<string | null> {
	const { id } = await useSessions.getState().createSession({
		cwd: opts.cwd,
		mode: opts.mode,
		appendSystemPrompt: opts.appendSystemPrompt ?? AUTOMATION_COMPOSER_SYSTEM_PROMPT,
		automationMode: true,
	});
	const atts = opts.prepareAttachments ? await opts.prepareAttachments(id) : [];
	if (atts === null) return null;
	if (opts.prefill?.trim()) {
		if (opts.autoSend) {
			if (atts.length > 0) draftBook.stash(id, "", atts);
			queueFirstSend(id, opts.prefill.trim());
		} else {
			draftBook.stash(id, opts.prefill, atts);
		}
	} else if (atts.length > 0) {
		draftBook.stash(id, "", atts);
	}
	nav.push(paths.chat(id));
	return id;
}

/**
 * Stateful tracker that decides when a newly proposed pending automation draft
 * should auto-open the right workspace drawer:
 * - Never triggers before `hydrated === true`.
 * - First hydrated snapshot or any reconnect `"snapshot"` seeds baseline without opening.
 * - Only returns the newest previously-unseen `pending` `draftId` on `"live"` updates.
 * - Once seen, repeated streaming frames carrying the same `draftId` never re-open after manual close.
 */
export function createAutomationDraftAutoOpenTracker() {
	let baselineReady = false;
	const seenPending = new Set<string>();
	return {
		reset() {
			baselineReady = false;
			seenPending.clear();
		},
		next(
			hydrated: boolean,
			state: AutomationSessionState | null,
			source: "snapshot" | "live" = "live",
		): string | null {
			if (!hydrated) return null;
			const pendingIds = (state?.drafts ?? [])
				.filter((d) => d.status === "pending")
				.map((d) => d.draftId);
			if (!baselineReady || source === "snapshot") {
				for (const did of pendingIds) seenPending.add(did);
				baselineReady = true;
				return null;
			}
			let newest: string | null = null;
			for (const did of pendingIds) {
				if (!seenPending.has(did)) newest = did;
				seenPending.add(did);
			}
			return newest;
		},
	};
}

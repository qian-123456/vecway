/**
 * Centralized mobile schedules store with SSE sync (`schedules`, `todos`, `resync`),
 * per-schedule run/awaiting/worktree caches, seen-run persistence, and attention ranking.
 */
import { create } from "zustand";
import { api, errorMessage } from "../api";
import { events } from "../sse";
import {
	draftFromSchedule,
	renamePayload,
	type AutomationAuthorResult,
	type AutomationWorktreeState,
	type ProbeTestResult,
	type Schedule,
	type ScheduleAgentTrigger,
	type ScheduleDraft,
	type ScheduleRun,
} from "../../features/more/schedule";

const SEEN_RUNS_KEY = "omp:mobile:schedules:seenRuns";
const MAX_SEEN_RUNS = 400;
const enc = encodeURIComponent;

export type MobileAttentionTone = "error" | "awaiting" | "patch" | "unread";

export interface ScheduleAttentionInfo {
	tone: MobileAttentionTone;
	label: string;
}

function loadSeenRuns(): Record<string, string> {
	try {
		if (typeof localStorage === "undefined") return {};
		const raw = localStorage.getItem(SEEN_RUNS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (typeof v === "string" && v) out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

function saveSeenRuns(seen: Record<string, string>): void {
	try {
		if (typeof localStorage === "undefined") return;
		const entries = Object.entries(seen);
		const trimmed = entries.length > MAX_SEEN_RUNS ? entries.slice(-MAX_SEEN_RUNS) : entries;
		localStorage.setItem(SEEN_RUNS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
	} catch {
		/* storage unavailable */
	}
}

/** Attention priority: error > awaiting > patch > unread. Quiet probe runs never count as unread. */
export function deriveScheduleAttention(
	s: Schedule,
	opts: {
		awaitingCount?: number;
		worktree?: AutomationWorktreeState | null;
		seenAt?: string;
	},
): ScheduleAttentionInfo | null {
	if (s.lastRunStatus === "error") {
		return { tone: "error", label: s.lastRunPhase === "probe_only" ? "脚本出错" : "最近失败" };
	}
	if ((opts.awaitingCount ?? 0) > 0) {
		return { tone: "awaiting", label: "等待确认" };
	}
	if (opts.worktree && (opts.worktree.ahead > 0 || opts.worktree.dirty > 0)) {
		return { tone: "patch", label: "有待合并改动" };
	}
	if (
		s.lastRunAt &&
		s.lastRunStatus === "ok" &&
		s.lastRunPhase !== "probe_quiet" &&
		opts.seenAt !== s.lastRunAt
	) {
		return { tone: "unread", label: "有新结果" };
	}
	return null;
}

const ATTENTION_PRIORITY: Record<MobileAttentionTone, number> = {
	error: 0,
	awaiting: 1,
	patch: 2,
	unread: 3,
};

/** Sort schedules by attention tier then lifecycle: error -> awaiting/patch -> unread -> active -> paused -> completed. */
export function sortSchedulesForDashboard(
	list: readonly Schedule[],
	ctx: {
		awaitingById: Record<string, ScheduleRun[]>;
		worktreeById: Record<string, AutomationWorktreeState | null>;
		seenRuns: Record<string, string>;
	},
): Schedule[] {
	const rank = (s: Schedule): number => {
		const att = deriveScheduleAttention(s, {
			awaitingCount: ctx.awaitingById[s.id]?.length ?? 0,
			worktree: ctx.worktreeById[s.id] ?? null,
			seenAt: ctx.seenRuns[s.id],
		});
		if (att) return ATTENTION_PRIORITY[att.tone];
		if (s.lifecycle === "active" && s.enabled) return 4;
		if (s.lifecycle === "paused" || (s.lifecycle === "active" && !s.enabled)) return 5;
		return 6;
	};
	return [...list].sort((a, b) => {
		const diff = rank(a) - rank(b);
		if (diff !== 0) return diff;
		const ta = Date.parse(a.lastRunAt ?? a.updatedAt ?? "") || 0;
		const tb = Date.parse(b.lastRunAt ?? b.updatedAt ?? "") || 0;
		return tb - ta;
	});
}

export interface WorktreeTarget {
	runId?: string | null;
	branch?: string | null;
	worktreePath?: string | null;
}

interface MobileSchedulesState {
	schedules: Schedule[];
	loaded: boolean;
	loading: boolean;
	error: string | null;
	detailVersion: number;
	runsById: Record<string, ScheduleRun[]>;
	awaitingById: Record<string, ScheduleRun[]>;
	worktreeById: Record<string, AutomationWorktreeState | null>;
	seenRuns: Record<string, string>;

	ensureSse: () => void;
	loadSchedules: () => Promise<Schedule[]>;
	loadDetail: (id: string) => Promise<{ runs: ScheduleRun[]; awaiting: ScheduleRun[]; worktree: AutomationWorktreeState | null }>;
	markSeen: (scheduleId: string, runAt: string | null | undefined) => void;
	createSchedule: (draft: Record<string, unknown>) => Promise<Schedule>;
	updateSchedule: (id: string, draft: Record<string, unknown>) => Promise<Schedule>;
	deleteSchedule: (id: string) => Promise<void>;
	toggleSchedule: (s: Schedule) => Promise<void>;
	runNow: (id: string) => Promise<void>;
	duplicateSchedule: (s: Schedule) => Promise<Schedule>;
	renameSchedule: (s: Schedule, name: string) => Promise<Schedule>;
	resumeAwaiting: (scheduleId: string, runId: string) => Promise<void>;
	releaseAwaiting: (scheduleId: string, runId: string) => Promise<void>;
	testProbe: (body: {
		cwd: string;
		probeCommand: string;
		agentTrigger: ScheduleAgentTrigger;
		scheduleId?: string;
	}) => Promise<ProbeTestResult>;
	generateDraft: (body: {
		request: string;
		cwd: string;
		current?: ScheduleDraft | null;
		preview?: boolean;
	}) => Promise<AutomationAuthorResult>;
	inspectWorktree: (id: string) => Promise<AutomationWorktreeState | null>;
	mergeWorktree: (id: string, target?: WorktreeTarget) => Promise<void>;
	discardWorktree: (id: string, target?: WorktreeTarget) => Promise<void>;
}

let sseWired = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function worktreeTargetBody(target?: WorktreeTarget): Record<string, string> | undefined {
	if (!target) return undefined;
	const body: Record<string, string> = {};
	if (target.runId) body.runId = target.runId;
	if (target.branch) body.branch = target.branch;
	if (target.worktreePath) body.worktreePath = target.worktreePath;
	return Object.keys(body).length > 0 ? body : undefined;
}

function ensureSseWired(): void {
	if (sseWired) return;
	sseWired = true;
	let pendingDetailBump = false;
	const scheduleRefresh = (bumpDetail: boolean) => {
		if (bumpDetail) pendingDetailBump = true;
		if (!bumpDetail && !useMobileSchedules.getState().loaded) return;
		clearTimeout(refreshTimer ?? undefined);
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			const shouldBump = pendingDetailBump;
			pendingDetailBump = false;
			if (shouldBump) {
				useMobileSchedules.setState((s) => ({ detailVersion: s.detailVersion + 1 }));
			}
			if (useMobileSchedules.getState().loaded) {
				void useMobileSchedules.getState().loadSchedules().catch(() => {});
			}
		}, 120);
	};
	events.on("schedules", () => scheduleRefresh(true));
	events.on("todos", () => scheduleRefresh(false));
	events.on("resync", () => scheduleRefresh(true));
}

export const useMobileSchedules = create<MobileSchedulesState>((set, get) => ({
	schedules: [],
	loaded: false,
	loading: false,
	error: null,
	detailVersion: 0,
	runsById: {},
	awaitingById: {},
	worktreeById: {},
	seenRuns: loadSeenRuns(),

	ensureSse: () => {
		ensureSseWired();
	},

	loadSchedules: async () => {
		ensureSseWired();
		set({ loading: true, error: null });
		try {
			const list = await api<Schedule[]>("GET", "/left/schedules");
			const schedules = Array.isArray(list) ? list : [];
			set({ schedules, loaded: true, loading: false, error: null });
			// Lightweight background worktree & awaiting probes for schedules.
			const worktreeIds = schedules.filter((s) => s.runMode === "worktree").map((s) => s.id);
			if (worktreeIds.length > 0) {
				void Promise.allSettled(
					worktreeIds.map(async (id) => {
						const wt = await api<AutomationWorktreeState | null>("GET", `/left/schedules/${enc(id)}/worktree`);
						set((st) => ({ worktreeById: { ...st.worktreeById, [id]: wt ?? null } }));
					}),
				);
			}
			const awaitingIds = schedules
				.filter(
					(s) =>
						s.lastRunAt != null ||
						s.lastRunStatus != null ||
						s.runsDone > 0 ||
						Object.prototype.hasOwnProperty.call(get().awaitingById, s.id) ||
						Object.prototype.hasOwnProperty.call(get().runsById, s.id),
				)
				.map((s) => s.id);
			if (awaitingIds.length > 0) {
				void Promise.allSettled(
					awaitingIds.map(async (id) => {
						const awaiting = await api<ScheduleRun[]>("GET", `/left/schedules/${enc(id)}/awaiting`);
						set((st) => ({
							awaitingById: {
								...st.awaitingById,
								[id]: Array.isArray(awaiting) ? awaiting : [],
							},
						}));
					}),
				);
			}
			return schedules;
		} catch (e) {
			const msg = errorMessage(e);
			set({ loading: false, error: msg });
			throw e;
		}
	},

	loadDetail: async (id) => {
		ensureSseWired();
		const [runsRes, awaitingRes, worktreeRes] = await Promise.all([
			api<ScheduleRun[]>("GET", `/left/schedules/${enc(id)}/runs?limit=50`).catch(() => []),
			api<ScheduleRun[]>("GET", `/left/schedules/${enc(id)}/awaiting`).catch(() => []),
			api<AutomationWorktreeState | null>("GET", `/left/schedules/${enc(id)}/worktree`).catch(() => null),
		]);
		const runs = Array.isArray(runsRes) ? runsRes : [];
		const awaiting = Array.isArray(awaitingRes) ? awaitingRes : [];
		const worktree = worktreeRes ?? null;
		set((s) => ({
			runsById: { ...s.runsById, [id]: runs },
			awaitingById: { ...s.awaitingById, [id]: awaiting },
			worktreeById: { ...s.worktreeById, [id]: worktree },
		}));
		return { runs, awaiting, worktree };
	},

	markSeen: (scheduleId, runAt) => {
		if (!runAt) return;
		const current = get().seenRuns;
		if (current[scheduleId] === runAt) return;
		const next = { ...current, [scheduleId]: runAt };
		saveSeenRuns(next);
		set({ seenRuns: next });
	},

	createSchedule: async (draft) => {
		const created = await api<Schedule>("POST", "/left/schedules", draft);
		await get().loadSchedules().catch(() => {});
		return created;
	},

	updateSchedule: async (id, draft) => {
		const updated = await api<Schedule>("PUT", `/left/schedules/${enc(id)}`, draft);
		await get().loadSchedules().catch(() => {});
		return updated;
	},

	deleteSchedule: async (id) => {
		await api("DELETE", `/left/schedules/${enc(id)}`);
		set((s) => ({ schedules: s.schedules.filter((x) => x.id !== id) }));
		await get().loadSchedules().catch(() => {});
	},

	toggleSchedule: async (s) => {
		const nextEnabled = !s.enabled;
		set((st) => ({
			schedules: st.schedules.map((x) => (x.id === s.id ? { ...x, enabled: nextEnabled } : x)),
		}));
		try {
			await api("POST", `/left/schedules/${enc(s.id)}/enabled`, { enabled: nextEnabled });
		} finally {
			await get().loadSchedules().catch(() => {});
		}
	},

	runNow: async (id) => {
		await api("POST", `/left/schedules/${enc(id)}/run`);
		await Promise.allSettled([get().loadSchedules(), get().loadDetail(id)]);
	},

	duplicateSchedule: async (s) => {
		const created = await api<Schedule>("POST", "/left/schedules", draftFromSchedule(s));
		await get().loadSchedules().catch(() => {});
		return created;
	},

	renameSchedule: async (s, name) => {
		const updated = await api<Schedule>("PUT", `/left/schedules/${enc(s.id)}`, renamePayload(s, name));
		await get().loadSchedules().catch(() => {});
		return updated;
	},

	resumeAwaiting: async (scheduleId, runId) => {
		await api("POST", `/left/schedules/${enc(scheduleId)}/runs/${enc(runId)}/resume-awaiting`);
		await Promise.allSettled([get().loadSchedules(), get().loadDetail(scheduleId)]);
	},

	releaseAwaiting: async (scheduleId, runId) => {
		await api("POST", `/left/schedules/${enc(scheduleId)}/runs/${enc(runId)}/release-awaiting`);
		await Promise.allSettled([get().loadSchedules(), get().loadDetail(scheduleId)]);
	},

	testProbe: async (body) =>
		api<ProbeTestResult>("POST", "/left/schedules/probe-test", body, { timeoutMs: 45_000 }),

	generateDraft: async (body) =>
		api<AutomationAuthorResult>("POST", "/left/schedules/generate-draft", body, { timeoutMs: 110_000 }),

	inspectWorktree: async (id) => {
		const wt = await api<AutomationWorktreeState | null>("GET", `/left/schedules/${enc(id)}/worktree`);
		set((s) => ({ worktreeById: { ...s.worktreeById, [id]: wt ?? null } }));
		return wt ?? null;
	},

	mergeWorktree: async (id, target) => {
		await api("POST", `/left/schedules/${enc(id)}/worktree/merge`, worktreeTargetBody(target));
		set((s) => ({ worktreeById: { ...s.worktreeById, [id]: null } }));
		await Promise.allSettled([get().loadSchedules(), get().loadDetail(id)]);
	},

	discardWorktree: async (id, target) => {
		await api("POST", `/left/schedules/${enc(id)}/worktree/discard`, worktreeTargetBody(target));
		set((s) => ({ worktreeById: { ...s.worktreeById, [id]: null } }));
		await Promise.allSettled([get().loadSchedules(), get().loadDetail(id)]);
	},
}));

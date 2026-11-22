import { useCallback, useContext, useSyncExternalStore } from "react";
import { parsePlanStatus, PLAN_STATUS_KEY, type PlanStatus } from "../../../src/features/chat/plan/planStatus";
import { api, errorMessage } from "../../core/api";
import { events } from "../../core/sse";
import { useSessions } from "../../core/stores/sessions";
import { isDraftId, type RpcFrame, type SpaceMode } from "../../core/types";
import { ChatCtx } from "../chat/ChatContext";
import type { ComposerState } from "../chat/chatStore";
interface Snapshot {
	data: ComposerState | null;
	error: string | null;
	loading: boolean;
}

const EMPTY: Snapshot = { data: null, error: null, loading: true };
const COALESCE_MS = 600;
const FALLBACK_MS = 5000;
const sources = new Map<string, PlanExecutionSource>();

/** One owned loader per mounted session, never one poller per component. */
class PlanExecutionSource {
	snapshot: Snapshot = EMPTY;
	listeners = new Set<() => void>();
	private controller: AbortController | null = null;
	private pending: Promise<void> | null = null;
	private queued = false;
	private refreshTimer = 0;
	private fallbackTimer = 0;
	private lastStart = 0;
	private offs: Array<() => void> = [];

	constructor(readonly id: string) {}

	private publish(snapshot: Snapshot): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}

	private clearWork(): void {
		window.clearTimeout(this.refreshTimer);
		window.clearTimeout(this.fallbackTimer);
		this.refreshTimer = 0;
		this.fallbackTimer = 0;
		this.queued = false;
		this.controller?.abort();
		this.controller = null;
		this.pending = null;
	}

	private armFallback(): void {
		window.clearTimeout(this.fallbackTimer);
		this.fallbackTimer = 0;
		const data = this.snapshot.data;
		const running = data?.streaming || data?.planStatus?.approved?.status === "executing" || useSessions.getState().byId[this.id]?.status === "working";
		if (this.listeners.size && !document.hidden && (running || data === null)) {
			this.fallbackTimer = window.setTimeout(() => {
				this.fallbackTimer = 0;
				this.schedule();
			}, FALLBACK_MS);
		}
	}

	private schedule = (): void => {
		if (!this.listeners.size || document.hidden) return;
		if (this.pending) {
			this.queued = true;
			return;
		}
		if (this.refreshTimer) return;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = 0;
			void this.reload();
		}, Math.max(0, COALESCE_MS - (Date.now() - this.lastStart)));
	};

	reload = (): Promise<void> => {
		if (!this.listeners.size || document.hidden || isDraftId(this.id)) return Promise.resolve();
		if (this.pending) {
			this.queued = true;
			return this.pending;
		}
		window.clearTimeout(this.refreshTimer);
		window.clearTimeout(this.fallbackTimer);
		this.refreshTimer = 0;
		this.fallbackTimer = 0;
		this.lastStart = Date.now();
		const controller = new AbortController();
		this.controller = controller;
		this.publish({ ...this.snapshot, loading: this.snapshot.data === null, error: null });
		this.pending = (async () => {
			try {
				const data = await api<ComposerState>("GET", `/sessions/${encodeURIComponent(this.id)}/composer-state`, undefined, { signal: controller.signal });
				if (this.controller === controller && !controller.signal.aborted) this.publish({ data, error: null, loading: false });
			} catch (error) {
				if (this.controller === controller && !controller.signal.aborted) {
					this.publish({ ...this.snapshot, error: errorMessage(error, "计划状态加载失败"), loading: false });
				}
			} finally {
				if (this.controller === controller) {
					this.controller = null;
					this.pending = null;
					const again = this.queued;
					this.queued = false;
					if (again) this.schedule();
					this.armFallback();
				}
			}
		})();
		return this.pending;
	};

	start(): void {
		if (isDraftId(this.id)) {
			this.publish({ data: { planStatus: null, streaming: false }, error: null, loading: false });
			return;
		}
		this.offs = [
			events.on("hello", this.schedule),
			events.on("resync", this.schedule),
			events.on("rpc", (event) => { if (event.sessionId === this.id) this.schedule(); }),
			events.on("session", (event) => { if (event.sessionId === this.id) this.schedule(); }),
			events.on("touch", (event) => { if (!event.sessionId || event.sessionId === this.id) this.schedule(); }),
		];
		const onVisibility = () => {
			if (document.hidden) this.clearWork();
			else void this.reload();
		};
		document.addEventListener("visibilitychange", onVisibility);
		this.offs.push(() => document.removeEventListener("visibilitychange", onVisibility));
		void this.reload();
	}

	stop(): void {
		this.clearWork();
		for (const off of this.offs) off();
		this.offs = [];
	}
}

function subscribe(id: string, listener: () => void): () => void {
	const source = sources.get(id) ?? new PlanExecutionSource(id);
	if (!sources.has(id)) sources.set(id, source);
	source.listeners.add(listener);
	if (source.listeners.size === 1) source.start();
	return () => {
		source.listeners.delete(listener);
		if (!source.listeners.size) {
			source.stop();
			if (sources.get(id) === source) sources.delete(id);
		}
	};
}

/** True whenever a real plan exists in any lifecycle state (planning, review, executing, completed, failed, handoff). */
export function hasRealPlan(planStatus: PlanStatus | null | undefined): boolean {
	if (!planStatus) return false;
	if (planStatus.approved) return true;
	if (planStatus.enabled) return true;
	return Boolean(planStatus.content?.trim() || planStatus.planFile);
}

export type PlanApproveMode = "keep" | "compact" | "fresh";

export interface ApprovePlanOptions {
	mode?: PlanApproveMode;
	role?: string | null;
}

export interface PlanApprovalResult {
	ok: boolean;
	error?: string;
	handoffSessionId?: string;
}

interface PlanEndpointResponse {
	streaming?: boolean;
	planStatus?: PlanStatus | null;
}

const APPROVAL_TIMEOUT_MS = 5000;
const APPROVAL_POLL_MS = 250;
export function defaultApproveMode(planStatus?: PlanStatus | null): PlanApproveMode {
	return planStatus?.keepDisabled ? "compact" : "keep";
}

function formatApprovalFailure(st: PlanStatus): string {
	const err = st.approved?.error;
	if (err === "model-unavailable") return "所选执行模型不可用，计划未执行";
	if (err === "aborted") return "计划执行已中止";
	return err || "计划执行失败";
}

/**
 * Execute `/plan-action approve ...` and wait for authoritative plan settlement before
 * reporting success. Prevents false-positive UI closure when context limits or model errors reject approval.
 */
export async function executePlanApproval(params: {
	sessionId: string;
	planStatus?: PlanStatus | null;
	mode?: PlanApproveMode;
	role?: string | null;
	cwd?: string | null;
	sessionMode?: SpaceMode;
	onPlanStatus?: (st: PlanStatus) => void;
	onLegacyPlanModeOff?: () => void;
	onWorking?: () => void;
}): Promise<PlanApprovalResult> {
	const { sessionId, planStatus } = params;
	const mode = params.mode ?? defaultApproveMode(planStatus);
	if (mode === "keep" && planStatus?.keepDisabled) {
		return { ok: false, error: "当前上下文已接近上限，请选择压缩上下文或新上下文执行" };
	}
	const role = params.role?.trim() || null;
	const sessionMeta = useSessions.getState().byId[sessionId];
	const cwd = params.cwd ?? sessionMeta?.cwd ?? null;
	const sessionMode = params.sessionMode ?? sessionMeta?.mode;

	let handoffSessionId: string | undefined;
	if (mode === "fresh") {
		const planFile = planStatus?.planFile;
		if (!planFile) {
			return { ok: false, error: "当前计划缺少文件路径，无法在新上下文中执行" };
		}
		if (!cwd) {
			return { ok: false, error: "无法确定项目目录，请选择压缩或继续当前上下文执行" };
		}
		try {
			const created = await useSessions.getState().createSession({
				cwd,
				...(sessionMode ? { mode: sessionMode } : {}),
			});
			const runArgs = `run ${role ? `@${role} ` : ""}${planFile}`;
			const runRes = await api<{ sessionId?: string }>(
				"POST",
				`/sessions/${encodeURIComponent(created.id)}/slash`,
				{ name: "plan-action", args: runArgs },
			);
			handoffSessionId = runRes?.sessionId || created.id;
		} catch (e) {
			return { ok: false, error: errorMessage(e, "新建执行会话失败") };
		}
	}

	let notifyError: string | null = null;
	let liveStatus: PlanStatus | null = null;
	const off = events.on("rpc", (ev) => {
		if (!ev || ev.sessionId !== sessionId) return;
		const frame = ev.frame as RpcFrame | undefined;
		if (!frame || frame.type !== "extension_ui_request") return;
		if (frame.method === "notify") {
			const rawFrame = frame as Record<string, unknown>;
			const msg = typeof rawFrame.message === "string" ? rawFrame.message.trim() : "";
			const nType = typeof rawFrame.notifyType === "string" ? rawFrame.notifyType : "info";
			if (msg && (nType === "error" || (nType === "warning" && /plan mode is not active/i.test(msg)))) {
				notifyError = msg;
			}
		} else if (frame.method === "setStatus" && frame.statusKey === PLAN_STATUS_KEY) {
			const parsed = parsePlanStatus(frame.statusText);
			if (parsed) {
				liveStatus = parsed;
				params.onPlanStatus?.(parsed);
			}
		}
	});

	try {
		const cmdArgs =
			mode === "fresh"
				? "approve execute"
				: role
					? `approve ${mode} ${role}`
					: `approve ${mode}`;
		try {
			await api("POST", `/sessions/${encodeURIComponent(sessionId)}/slash`, {
				name: "plan-action",
				args: cmdArgs,
			});
		} catch (e) {
			return { ok: false, error: errorMessage(e, "发送计划执行命令失败") };
		}

		const evaluate = (st: PlanStatus | null | undefined, streaming?: boolean): PlanApprovalResult | null => {
			if (notifyError) return { ok: false, error: notifyError };
			if (!st) return null;
			params.onPlanStatus?.(st);
			if (st.approved) {
				if (st.approved.status === "failed") {
					return { ok: false, error: formatApprovalFailure(st) };
				}
				if (streaming) params.onWorking?.();
				return { ok: true, handoffSessionId };
			}
			if (st.enabled === false) {
				return { ok: false, error: notifyError || "计划未进入执行状态，请检查会话状态" };
			}
			return null;
		};

		const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
		while (true) {
			const liveVerdict = evaluate(liveStatus);
			if (liveVerdict) return liveVerdict;

			try {
				const res = await api<PlanEndpointResponse>("GET", `/sessions/${encodeURIComponent(sessionId)}/plan`);
				if (notifyError) return { ok: false, error: notifyError };
				if (res && Object.prototype.hasOwnProperty.call(res, "planStatus")) {
					const verdict = evaluate(res.planStatus, res.streaming);
					if (verdict) return verdict;
				} else {
					// Fallback for hosts/mocks that only expose plan state on composer-state.
					const cs = await api<ComposerState>("GET", `/sessions/${encodeURIComponent(sessionId)}/composer-state`);
					if (notifyError) return { ok: false, error: notifyError };
					if (cs && Object.prototype.hasOwnProperty.call(cs, "planStatus")) {
						const verdict = evaluate(cs.planStatus, cs.streaming);
						if (verdict) return verdict;
					} else if (cs && cs.planMode === false) {
						params.onLegacyPlanModeOff?.();
						return { ok: true, handoffSessionId };
					}
				}
			} catch {
				// Transient poll error; keep retrying until deadline unless notifyError arrived.
				if (notifyError) return { ok: false, error: notifyError };
			}

			if (Date.now() >= deadline) break;
			await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_MS));
		}

		if (notifyError) return { ok: false, error: notifyError };
		return { ok: false, error: "计划批准尚未生效，请稍后重试" };
	} finally {
		off();
	}
}

/** Chat reuses its existing controller; tool routes own a shared read-only snapshot. */
export function usePlanExecution(sessionId: string): {
	planStatus: PlanStatus | null;
	hasPlan: boolean;
	executing: boolean;
	loading: boolean;
	error: string | null;
	reload: () => Promise<void>;
} {
	const context = useContext(ChatCtx);
	const controller = context?.controller.id === sessionId ? context.controller : null;
	const subscribeChat = useCallback((listener: () => void) => controller ? controller.store.subscribe(listener) : () => {}, [controller]);
	const getChatSnapshot = useCallback(() => controller?.state.cstate ?? null, [controller]);
	const chatState = useSyncExternalStore(subscribeChat, getChatSnapshot, getChatSnapshot);
	const subscribePanel = useCallback((listener: () => void) => controller ? () => {} : subscribe(sessionId, listener), [controller, sessionId]);
	const getPanelSnapshot = useCallback(() => controller ? EMPTY : sources.get(sessionId)?.snapshot ?? EMPTY, [controller, sessionId]);
	const panel = useSyncExternalStore(subscribePanel, getPanelSnapshot, getPanelSnapshot);
	const reload = useCallback(async () => {
		if (controller) await controller.loadState();
		else await sources.get(sessionId)?.reload();
	}, [controller, sessionId]);
	const planStatus = (controller ? chatState : panel.data)?.planStatus ?? null;
	return {
		planStatus,
		hasPlan: hasRealPlan(planStatus),
		executing: planStatus?.approved?.status === "executing",
		loading: controller ? chatState === null : panel.loading,
		error: controller ? null : panel.error,
		reload,
	};
}

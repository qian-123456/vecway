import { useEffect, useRef } from "react";
import { useLive } from "../../../stores/live";
import { useUi } from "../../../stores/ui";
import { parsePlanStatus, type PlanStatus } from "./planStatus";

/** Plan is a contextual document, not a general-purpose empty panel. */
export function hasMeaningfulPlan(plan: PlanStatus | undefined): boolean {
	return Boolean(
		(plan?.enabled && plan.phase === "review" && plan.content?.trim()) ||
		plan?.approved?.content.trim(),
	);
}

/** Adapt an on-disk extension record, without inventing status for ordinary sessions. */
export function parseSavedPlanStatus(value: unknown): PlanStatus | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const saved = value as Record<string, unknown>;
	if (typeof saved.enabled !== "boolean") return null;
	const content = typeof saved.lastContent === "string" ? saved.lastContent : null;
	const title = typeof saved.title === "string" ? saved.title : content?.match(/^#\s+(.+)$/m)?.[1] ?? null;
	return parsePlanStatus(JSON.stringify({ ...saved, v: 1, content, title }));
}

/**
 * Highest plan version already auto-opened (or suppressed on user stop) per
 * session in this app session. Kept at module scope so switching sessions or
 * unmounting Composer never loses dismissal memory or misses a plan that
 * finished while another session was active.
 */
const autoOpenedVersion = new Map<string, number>();

export function resetPlanAutoOpenForTest(): void {
	autoOpenedVersion.clear();
}

function isReviewablePlan(plan: PlanStatus | undefined): plan is PlanStatus {
	return Boolean(plan?.enabled && plan.phase === "review" && plan.content?.trim());
}

export function usePlanPanelLifecycle(
	sessionId: string,
	plan: PlanStatus | undefined,
	streaming: boolean,
): void {
	const selectedId = useUi((s) => s.selectedSessionId);
	const selected = selectedId === sessionId;
	const suppressed = useRef(false);

	useEffect(() => {
		const initial = useLive.getState().sessions[sessionId];
		suppressed.current = Boolean(initial?.exitIntent || initial?.interruption);
		if (!selected) return;
		if (
			suppressed.current &&
			typeof initial?.plan?.version === "number" &&
			initial.plan.version > 0
		) {
			autoOpenedVersion.set(sessionId, initial.plan.version);
		}
		return useLive.subscribe((state, previous) => {
			if (useUi.getState().selectedSessionId !== sessionId) return;
			const live = state.sessions[sessionId];
			if (live?.exitIntent || live?.interruption || live?.processExited) {
				// A user stop can start and finish in one React batch. Observe the
				// store edge, not just its final rendered streaming=false flag.
				suppressed.current = true;
				if (typeof live.plan?.version === "number" && live.plan.version > 0) {
					autoOpenedVersion.set(sessionId, live.plan.version);
				}
			} else if (live?.streaming && !previous.sessions[sessionId]?.streaming) {
				suppressed.current = false;
			} else if (
				suppressed.current &&
				typeof live?.plan?.version === "number" &&
				live.plan.version > 0
			) {
				autoOpenedVersion.set(sessionId, live.plan.version);
			}
		});
	}, [sessionId, selected]);

	useEffect(() => {
		if (!selected) return;
		if (plan && (!plan.enabled || plan.version === 0)) {
			autoOpenedVersion.delete(sessionId);
			return;
		}
		if (streaming || !isReviewablePlan(plan)) return;
		const ver = plan.version;
		if (typeof ver !== "number" || ver <= 0) return;
		if (suppressed.current) {
			autoOpenedVersion.set(sessionId, ver);
			return;
		}
		if (autoOpenedVersion.get(sessionId) === ver) return;
		// Consume before opening: later status frames or re-selection must respect manual dismissal.
		autoOpenedVersion.set(sessionId, ver);
		if (useUi.getState().selectedSessionId === sessionId) {
			useUi.getState().setRightTab("plan");
		}
	}, [sessionId, selected, plan, streaming]);
}

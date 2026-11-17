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

export function usePlanPanelLifecycle(
	sessionId: string,
	plan: PlanStatus | undefined,
	streaming: boolean,
): void {
	const selectedId = useUi((s) => s.selectedSessionId);
	const selected = selectedId === sessionId;
	const revision = useRef<{ sessionId: string; version: number | undefined; pending?: number } | null>(null);
	const suppressed = useRef(false);
	useEffect(() => {
		suppressed.current = false;
		if (!selected) return;
		return useLive.subscribe((state, previous) => {
			if (useUi.getState().selectedSessionId !== sessionId) return;
			const live = state.sessions[sessionId];
			if (live?.exitIntent || live?.interruption || live?.processExited) {
				// A user stop can start and finish in one React batch. Observe the
				// store edge, not just its final rendered streaming=false flag.
				suppressed.current = true;
				if (revision.current?.sessionId === sessionId) {
					revision.current.pending = undefined;
					revision.current.version = live.plan?.version;
				}
			} else if (live?.streaming && !previous.sessions[sessionId]?.streaming) {
				suppressed.current = false;
			}
		});
	}, [sessionId, selected]);

	useEffect(() => {
		if (!selected) {
			revision.current = null;
			return;
		}
		const version = plan?.version;
		const previous = revision.current;
		if (!previous || previous.sessionId !== sessionId || previous.version === undefined || version === undefined) {
			revision.current = { sessionId, version };
			return;
		}
		if (version < previous.version || !plan?.enabled || suppressed.current) previous.pending = undefined;
		else if (version > previous.version) previous.pending = version;
		previous.version = version;
		if (previous.pending !== version || streaming || !plan?.enabled || !hasMeaningfulPlan(plan)) return;
		// Consume before opening: later status frames must respect a manual dismissal.
		previous.pending = undefined;
		if (useUi.getState().selectedSessionId === sessionId) useUi.getState().setRightTab("plan");
	}, [sessionId, selected, plan, streaming]);
}

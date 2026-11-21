/**
 * Auto-opens the right-panel "automation" tab when AI proposes or updates a
 * pending automation draft in the active session, mirroring PlanPanel's
 * lifecycle: manual closure is respected until a new draftId arrives.
 */
import { useEffect, useRef } from "react";
import { useUi } from "../../../stores/ui";
import type { AutomationSessionState } from "./automationStatus";

function pendingDraftIds(state: AutomationSessionState | undefined): string[] {
	if (!state) return [];
	return state.drafts.filter((d) => d.status === "pending").map((d) => d.draftId);
}

export function useAutomationPanelLifecycle(
	sessionId: string,
	automationState: AutomationSessionState | undefined,
	disabled = false,
): void {
	const selectedId = useUi((s) => s.selectedSessionId);
	const selected = !disabled && selectedId === sessionId;
	const seenRef = useRef<{ sessionId: string; hydrated: boolean; ids: Set<string> } | null>(null);

	useEffect(() => {
		if (!selected) {
			seenRef.current = null;
			return;
		}
		const currentPending = pendingDraftIds(automationState);
		const prev = seenRef.current;

		// Initial hydration for this session: record already-existing pending drafts
		// without forcing the right panel open over the user's restored layout.
		if (!prev || prev.sessionId !== sessionId) {
			seenRef.current = {
				sessionId,
				hydrated: automationState !== undefined,
				ids: new Set(currentPending),
			};
			return;
		}

		// First real automationState snapshot arriving after mount: also treat as hydration
		// unless drafts arrived dynamically after the session already reported idle/empty.
		if (!prev.hydrated) {
			if (automationState !== undefined) {
				prev.hydrated = true;
				for (const id of currentPending) prev.ids.add(id);
			}
			return;
		}

		let hasNewPending = false;
		for (const id of currentPending) {
			if (!prev.ids.has(id)) {
				hasNewPending = true;
				prev.ids.add(id);
			}
		}

		if (hasNewPending && useUi.getState().selectedSessionId === sessionId) {
			useUi.getState().setRightTab("automation");
		}
	}, [sessionId, selected, automationState]);
}

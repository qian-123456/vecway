/**
 * Lightweight focus request bus so clicking an inline draft reference card in
 * the conversation stream opens the right-hand Automation Drafts panel and
 * smoothly scrolls to + highlights the exact draft card.
 */
import { useUi } from "../../../stores/ui";

export interface DraftFocusRequest {
	sessionId: string;
	draftId?: string | null;
	name?: string | null;
	nonce: number;
}

type Listener = (req: DraftFocusRequest) => void;

let latestRequest: DraftFocusRequest | null = null;
let nextNonce = 1;
const listeners = new Set<Listener>();

export function openAutomationDraftsPanel(
	sessionId: string,
	target?: { draftId?: string | null; name?: string | null },
): void {
	useUi.getState().setRightTab("automation");
	if (target?.draftId || target?.name) {
		latestRequest = {
			sessionId,
			draftId: target.draftId ?? null,
			name: target.name ?? null,
			nonce: nextNonce++,
		};
		for (const listener of listeners) {
			listener(latestRequest);
		}
	}
}

export function subscribeDraftFocus(listener: Listener): () => void {
	listeners.add(listener);
	if (latestRequest) {
		listener(latestRequest);
	}
	return () => {
		listeners.delete(listener);
	};
}

export function clearLatestDraftFocus(nonce?: number): void {
	if (nonce === undefined || latestRequest?.nonce === nonce) {
		latestRequest = null;
	}
}

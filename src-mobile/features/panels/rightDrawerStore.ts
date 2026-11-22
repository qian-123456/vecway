import { create } from "zustand";

export type WorkspaceTab = "sidechat" | "git" | "files" | "terminal" | "services" | "plan";

export interface SidechatAnnotationPayload {
	quote: string;
	comment?: string;
	sourceLabel?: string;
}

export interface MainAnnotationPayload {
	quote: string;
	comment?: string;
	sourceLabel?: string;
}

interface RightDrawerState {
	open: boolean;
	sessionId: string | null;
	/** Remembers the last active workspace tab per session so reopening returns in 1 tap. */
	tabBySession: Record<string, WorkspaceTab>;
	/** Tracks which tabs have been visited per session so panels stay mounted & alive while drawer is collapsed. */
	visitedBySession: Record<string, WorkspaceTab[]>;
	/** One-shot annotation payload targeted at the session's sidechat inside the right drawer. */
	pendingSidechat: { sessionId: string; payload: SidechatAnnotationPayload; nonce: number } | null;
	/** One-shot annotation/prompt payload sent from a workspace panel back to the main chat composer. */
	pendingMain: { sessionId: string; payload: MainAnnotationPayload; nonce: number } | null;

	openDrawer: (sessionId: string, tab?: WorkspaceTab) => void;
	closeDrawer: () => void;
	toggleDrawer: (sessionId: string) => void;
	setTab: (sessionId: string, tab: WorkspaceTab) => void;
	openSidechatWithAnnotation: (sessionId: string, payload: SidechatAnnotationPayload) => void;
	consumeSidechatAnnotation: (sessionId: string) => SidechatAnnotationPayload | null;
	sendToMainChat: (sessionId: string, payload: MainAnnotationPayload) => void;
	consumeMainAnnotation: (sessionId: string) => MainAnnotationPayload | null;
	resetSession: (sessionId: string) => void;
}

let nonceSeq = 1;

function addVisited(current: readonly WorkspaceTab[] | undefined, tab: WorkspaceTab): WorkspaceTab[] {
	const list = current ?? [];
	return list.includes(tab) ? [...list] : [...list, tab];
}

export const useRightDrawer = create<RightDrawerState>((set, get) => ({
	open: false,
	sessionId: null,
	tabBySession: {},
	visitedBySession: {},
	pendingSidechat: null,
	pendingMain: null,

	openDrawer: (sessionId, tab) => {
		set((s) => {
			const nextTab = tab ?? s.tabBySession[sessionId] ?? "git";
			return {
				open: true,
				sessionId,
				tabBySession: { ...s.tabBySession, [sessionId]: nextTab },
				visitedBySession: {
					...s.visitedBySession,
					[sessionId]: addVisited(s.visitedBySession[sessionId], nextTab),
				},
			};
		});
	},

	closeDrawer: () => set({ open: false }),

	toggleDrawer: (sessionId) => {
		const s = get();
		if (s.open && s.sessionId === sessionId) {
			set({ open: false });
		} else {
			s.openDrawer(sessionId);
		}
	},

	setTab: (sessionId, tab) => {
		set((s) => ({
			tabBySession: { ...s.tabBySession, [sessionId]: tab },
			visitedBySession: {
				...s.visitedBySession,
				[sessionId]: addVisited(s.visitedBySession[sessionId], tab),
			},
		}));
	},

	openSidechatWithAnnotation: (sessionId, payload) => {
		const nonce = ++nonceSeq;
		set((s) => ({
			open: true,
			sessionId,
			tabBySession: { ...s.tabBySession, [sessionId]: "sidechat" },
			visitedBySession: {
				...s.visitedBySession,
				[sessionId]: addVisited(s.visitedBySession[sessionId], "sidechat"),
			},
			pendingSidechat: { sessionId, payload, nonce },
		}));
	},

	consumeSidechatAnnotation: (sessionId) => {
		const cur = get().pendingSidechat;
		if (!cur || cur.sessionId !== sessionId) return null;
		set({ pendingSidechat: null });
		return cur.payload;
	},

	sendToMainChat: (sessionId, payload) => {
		const nonce = ++nonceSeq;
		set({
			open: false,
			pendingMain: { sessionId, payload, nonce },
		});
	},

	consumeMainAnnotation: (sessionId) => {
		const cur = get().pendingMain;
		if (!cur || cur.sessionId !== sessionId) return null;
		set({ pendingMain: null });
		return cur.payload;
	},

	resetSession: (sessionId) => {
		set((s) => {
			const nextTabs = { ...s.tabBySession };
			const nextVisited = { ...s.visitedBySession };
			delete nextTabs[sessionId];
			delete nextVisited[sessionId];
			return {
				open: s.sessionId === sessionId ? false : s.open,
				sessionId: s.sessionId === sessionId ? null : s.sessionId,
				tabBySession: nextTabs,
				visitedBySession: nextVisited,
			};
		});
	},
}));

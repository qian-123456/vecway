import type { ReactNode } from "react";
import { create } from "zustand";

export type WorkspaceTab = "sidechat" | "git" | "files" | "terminal" | "services";

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

export interface DrawerMoreAction {
	id: string;
	label: string;
	icon?: ReactNode;
	danger?: boolean;
	onSelect: () => void;
}

export interface DrawerSidechatSwitcher {
	count: number;
	open: boolean;
	toggle: () => void;
}

export interface DrawerTabHeader {
	title?: string;
	moreActions?: readonly DrawerMoreAction[];
	sidechatSwitcher?: DrawerSidechatSwitcher;
}

interface RightDrawerState {
	open: boolean;
	/** Monotonic counter incremented on every open/close/reset to cancel stale lazy-resolve completions. */
	openSeq: number;
	sessionId: string | null;
	/** Remembers the last active workspace tab per session so reopening returns in 1 tap. */
	tabBySession: Record<string, WorkspaceTab>;
	/** Tracks which tabs have been visited per session so panels stay mounted & alive while drawer is collapsed. */
	visitedBySession: Record<string, WorkspaceTab[]>;
	/** One-shot annotation payload targeted at the session's sidechat inside the right drawer. */
	pendingSidechat: { sessionId: string; payload: SidechatAnnotationPayload; nonce: number } | null;
	/** One-shot annotation/prompt payload sent from a workspace panel back to the main chat composer. */
	pendingMain: { sessionId: string; payload: MainAnnotationPayload; nonce: number } | null;
	/** Per-session, per-tab header slot metadata registered by embedded panels. */
	tabHeaders: Record<string, DrawerTabHeader>;

	openDrawer: (sessionId: string, tab?: WorkspaceTab) => void;
	closeDrawer: () => void;
	toggleDrawer: (sessionId: string) => void;
	setTab: (sessionId: string, tab: WorkspaceTab) => void;
	bindResolvedSession: (sessionId: string) => void;
	clearActiveContext: () => void;
	openSidechatWithAnnotation: (sessionId: string, payload: SidechatAnnotationPayload) => void;
	consumeSidechatAnnotation: (sessionId: string) => SidechatAnnotationPayload | null;
	sendToMainChat: (sessionId: string, payload: MainAnnotationPayload) => void;
	consumeMainAnnotation: (sessionId: string) => MainAnnotationPayload | null;
	resetSession: (sessionId: string) => void;
	setTabHeader: (sessionId: string, tab: WorkspaceTab, header: DrawerTabHeader) => void;
	clearTabHeader: (sessionId: string, tab: WorkspaceTab) => void;
}

let nonceSeq = 1;

function addVisited(current: readonly WorkspaceTab[] | undefined, tab: WorkspaceTab): WorkspaceTab[] {
	const list = current ?? [];
	return list.includes(tab) ? [...list] : [...list, tab];
}

export function tabHeaderKey(sessionId: string, tab: WorkspaceTab): string {
	return `${sessionId}:${tab}`;
}

export const useRightDrawer = create<RightDrawerState>((set, get) => ({
	open: false,
	openSeq: 0,
	sessionId: null,
	tabBySession: {},
	visitedBySession: {},
	pendingSidechat: null,
	pendingMain: null,
	tabHeaders: {},

	openDrawer: (sessionId, tab) => {
		set((s) => {
			const targetId = sessionId || s.sessionId || "";
			const nextTab = tab ?? s.tabBySession[targetId] ?? s.tabBySession[sessionId] ?? "git";
			const nextTabs = { ...s.tabBySession, [targetId]: nextTab };
			return {
				open: true,
				openSeq: (s.openSeq ?? 0) + 1,
				sessionId: targetId,
				tabBySession: nextTabs,
				visitedBySession: targetId
					? {
							...s.visitedBySession,
							[targetId]: addVisited(s.visitedBySession[targetId], nextTab),
						}
					: s.visitedBySession,
			};
		});
	},

	closeDrawer: () => set((s) => ({ open: false, openSeq: (s.openSeq ?? 0) + 1 })),

	toggleDrawer: (sessionId) => {
		const s = get();
		const targetId = sessionId || s.sessionId || "";
		if (s.open && (s.sessionId ?? "") === targetId) {
			set({ open: false, openSeq: (s.openSeq ?? 0) + 1 });
		} else {
			s.openDrawer(targetId);
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

	bindResolvedSession: (sessionId) => {
		if (!sessionId) return;
		set((s) => {
			if (s.sessionId && s.sessionId !== "__pending__") return s;
			const wantedTab = s.tabBySession[""] ?? "git";
			return {
				sessionId,
				tabBySession: { ...s.tabBySession, [sessionId]: s.tabBySession[sessionId] ?? wantedTab },
			};
		});
	},

	clearActiveContext: () =>
		set((s) => ({
			open: false,
			openSeq: (s.openSeq ?? 0) + 1,
			sessionId: null,
		})),
	openSidechatWithAnnotation: (sessionId, payload) => {
		const nonce = ++nonceSeq;
		set((s) => ({
			open: true,
			openSeq: (s.openSeq ?? 0) + 1,
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
		set((s) => ({
			open: false,
			openSeq: (s.openSeq ?? 0) + 1,
			pendingMain: { sessionId, payload, nonce },
		}));
	},
	consumeMainAnnotation: (sessionId) => {
		const cur = get().pendingMain;
		if (!cur || cur.sessionId !== sessionId) return null;
		set({ pendingMain: null });
		return cur.payload;
	},

	setTabHeader: (sessionId, tab, header) => {
		const key = tabHeaderKey(sessionId, tab);
		set((s) => ({
			tabHeaders: { ...(s.tabHeaders ?? {}), [key]: header },
		}));
	},

	clearTabHeader: (sessionId, tab) => {
		const key = tabHeaderKey(sessionId, tab);
		set((s) => {
			const prev = s.tabHeaders ?? {};
			if (!(key in prev)) return s;
			const next = { ...prev };
			delete next[key];
			return { tabHeaders: next };
		});
	},

	resetSession: (sessionId) => {
		set((s) => {
			const nextTabs = { ...s.tabBySession };
			const nextVisited = { ...s.visitedBySession };
			const nextHeaders = { ...(s.tabHeaders ?? {}) };
			const prefix = `${sessionId}:`;
			delete nextTabs[sessionId];
			delete nextVisited[sessionId];
			for (const key of Object.keys(nextHeaders)) {
				if (key.startsWith(prefix)) delete nextHeaders[key];
			}
			return {
				open: s.sessionId === sessionId ? false : s.open,
				openSeq: s.sessionId === sessionId ? (s.openSeq ?? 0) + 1 : (s.openSeq ?? 0),
				sessionId: s.sessionId === sessionId ? null : s.sessionId,
				tabBySession: nextTabs,
				visitedBySession: nextVisited,
				tabHeaders: nextHeaders,
			};
		});
	},
}));

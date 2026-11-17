import { create } from "zustand";

const STORAGE_KEY = "ompws:dismissed-turn-errors";
const MAX_KEYS_PER_SESSION = 100;

type DismissedMap = Record<string, string[]>;

function readPersisted(): DismissedMap {
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: DismissedMap = {};
		for (const [sid, list] of Object.entries(parsed as Record<string, unknown>)) {
			if (!sid || !Array.isArray(list)) continue;
			const clean = list.filter((x): x is string => typeof x === "string" && x.length > 0);
			if (clean.length > 0) out[sid] = clean.slice(-MAX_KEYS_PER_SESSION);
		}
		return out;
	} catch {
		return {};
	}
}

function writePersisted(map: DismissedMap): void {
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(map));
	} catch {
		// Ignore quota / unavailable storage errors; in-memory state still works.
	}
}

interface DismissedTurnErrorsState {
	dismissedBySession: DismissedMap;
	dismiss: (sessionId: string, errorKey: string) => void;
	clearSession: (sessionId: string) => void;
}

export const useDismissedTurnErrors = create<DismissedTurnErrorsState>((set) => ({
	dismissedBySession: readPersisted(),
	dismiss: (sessionId, errorKey) => {
		if (!sessionId || !errorKey) return;
		set((state) => {
			const prev = state.dismissedBySession[sessionId] ?? [];
			if (prev.includes(errorKey)) return state;
			const nextList = [...prev, errorKey].slice(-MAX_KEYS_PER_SESSION);
			const nextMap = { ...state.dismissedBySession, [sessionId]: nextList };
			writePersisted(nextMap);
			return { dismissedBySession: nextMap };
		});
	},
	clearSession: (sessionId) => {
		if (!sessionId) return;
		set((state) => {
			if (!(sessionId in state.dismissedBySession)) return state;
			const nextMap = { ...state.dismissedBySession };
			delete nextMap[sessionId];
			writePersisted(nextMap);
			return { dismissedBySession: nextMap };
		});
	},
}));

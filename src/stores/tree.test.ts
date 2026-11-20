import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem, TranscriptPage } from "../lib/contracts";
import type * as IpcModule from "../lib/ipc";

const h = vi.hoisted(() => ({ rpcSend: vi.fn(), getTranscript: vi.fn() }));

vi.mock("../lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof IpcModule>()),
	rpcSend: h.rpcSend,
	getTranscript: h.getTranscript,
}));

import { emptySessionLive, useLive } from "./live";
import { refreshTranscriptCache } from "./transcript";
import { useTree } from "./tree";

const SID = "tree-store-session";

const item = (id: string, kind: TranscriptItem["kind"] = "user", text: string | null = id): TranscriptItem => ({
	id,
	parentId: null,
	ts: "2026-01-01T00:00:00Z",
	kind,
	text,
	thinking: null,
	assistantParts: [],
	toolCalls: [],
	toolResult: null,
	usage: null,
	model: null,
	stopReason: kind === "assistant" ? "stop" : null,
	images: [],
	hidden: false,
	duration: null,
	ttft: null,
	completedAt: null,
	firstKeptEntryId: null,
});

const u1 = item("u1", "user", "turn 1");
const a1 = item("a1", "assistant", "answer 1");
const u2 = item("u2", "user", "turn 2");

beforeEach(() => {
	h.rpcSend.mockReset();
	h.getTranscript.mockReset();
	useLive.setState({ sessions: { [SID]: { ...emptySessionLive(), alive: true, items: [u1, a1] } } });
	useTree.setState({ leaf: {}, resend: {} });
	useTree.getState().setLeaf(SID, null);
});

describe("useTree stale leaf invalidation", () => {
	it("keeps a confirmed leaf while items remain inside the snapshot and clears synchronously once a new item arrives", async () => {
		h.rpcSend.mockResolvedValueOnce({ data: { entries: [u1, a1], leafId: a1.id } });
		await useTree.getState().refreshLeaf(SID);
		expect(useTree.getState().leaf[SID]).toBe(a1.id);

		useTree.getState().invalidateStaleLeaf(SID, [u1, a1]);
		expect(useTree.getState().leaf[SID]).toBe(a1.id);

		useTree.getState().invalidateStaleLeaf(SID, [u1, a1, u2]);
		expect(useTree.getState().leaf[SID]).toBeNull();
	});

	it("invalidates a stale cached leaf during refreshLeaf even while streaming is active", async () => {
		h.rpcSend.mockResolvedValueOnce({ data: { entries: [u1, a1], leafId: a1.id } });
		await useTree.getState().refreshLeaf(SID);
		expect(useTree.getState().leaf[SID]).toBe(a1.id);
		h.rpcSend.mockClear();

		useLive.setState((state) => ({
			sessions: {
				...state.sessions,
				[SID]: { ...state.sessions[SID], alive: true, streaming: true, items: [u1, a1, u2] },
			},
		}));

		await useTree.getState().refreshLeaf(SID);
		expect(useTree.getState().leaf[SID]).toBeNull();
		expect(h.rpcSend).not.toHaveBeenCalled();
	});

	it("clears a stale cached leaf synchronously when refreshTranscriptCache loads a newly sent message during streaming", async () => {
		h.rpcSend.mockResolvedValueOnce({ data: { entries: [u1, a1], leafId: a1.id } });
		await useTree.getState().refreshLeaf(SID);
		expect(useTree.getState().leaf[SID]).toBe(a1.id);

		useLive.setState((state) => ({
			sessions: {
				...state.sessions,
				[SID]: { ...state.sessions[SID], alive: true, streaming: true },
			},
		}));
		useLive.getState().addUserEcho(SID, "turn 2");

		const page: TranscriptPage = {
			sessionId: SID,
			items: [u1, a1, u2],
			nextOffset: 30,
			tailId: u2.id,
			reset: false,
		};
		h.getTranscript.mockResolvedValueOnce(page);

		await refreshTranscriptCache(SID, false);

		expect(useLive.getState().sessions[SID].pendingUserEchoes).toEqual([]);
		expect(useLive.getState().sessions[SID].items.map((entry) => entry.id)).toEqual(["u1", "a1", "u2"]);
		expect(useTree.getState().leaf[SID]).toBeNull();
	});
});

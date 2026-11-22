// @vitest-environment jsdom
/** Mobile conversation-tree: pure sibling grouping + the controller actions
 * (edit-&-resend draft flow, version switching, cancel, busy refusal). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
vi.mock("../../core/api", async (orig) => {
	const real = await orig<typeof import("../../core/api")>();
	return { ...real, api: (...a: unknown[]) => apiMock(...a), upload: vi.fn() };
});
const h = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../ui", async (orig) => {
	const real = await orig<typeof import("../../ui")>();
	return { ...real, toast: h.toast };
});

import type { Item, TranscriptPage } from "../../core/types";
import { events } from "../../core/sse";
import { ChatController } from "./chatStore";
import { EMPTY_TRANSCRIPT, mergePage } from "./lib/transcript";
import { extractTreeParents, filterToLeafPath, treeVersions } from "./lib/tree";

function row(id: string, parentId: string | null, kind: string): Item {
	return { id, parentId, role: kind === "user" ? "user" : kind === "assistant" ? "assistant" : "system", kind, text: id, thinking: "", tools: [], images: [], ts: null, streaming: false };
}

/** u1 → a1; sibling branch u2 → a2; both under root. */
function branched(): Item[] {
	return [row("root", null, "custom"), row("u1", "root", "user"), row("a1", "u1", "assistant"), row("u2", "root", "user"), row("a2", "u2", "assistant")];
}

beforeEach(() => {
	apiMock.mockReset();
	apiMock.mockResolvedValue({});
	h.toast.mockReset();
});

describe("filterToLeafPath (mobile Items)", () => {
	it("keeps only the root→leaf path", () => {
		expect(filterToLeafPath(branched(), "a2").map((i) => i.id)).toEqual(["root", "u2", "a2"]);
	});
	it("renders unfiltered without a known leaf", () => {
		expect(filterToLeafPath(branched(), null)).toHaveLength(5);
	});
	it("preserves user messages when hidden and tool_result ancestors are supplied via parentById / treeParents", () => {
		const page: TranscriptPage = {
			items: [
				{ id: "u1", parentId: null, kind: "user", text: "hi" },
				{ id: "h1", parentId: "u1", kind: "custom", hidden: true },
				{ id: "a1", parentId: "h1", kind: "assistant", text: "", toolCalls: [{ id: "c1", name: "bash", args: {} }] },
				{ id: "tr1", parentId: "a1", kind: "tool_result", toolResult: { toolCallId: "c1", text: "ok" } },
				{ id: "a2", parentId: "tr1", kind: "assistant", text: "done" },
				// Abandoned sibling branch under u1
				{ id: "a1-old", parentId: "u1", kind: "assistant", text: "old" },
			],
			nextOffset: 100,
		};
		const merged = mergePage(EMPTY_TRANSCRIPT, page);
		expect(merged.state.parentById).toMatchObject({ u1: null, h1: "u1", a1: "h1", tr1: "a1", a2: "tr1" });
		const treeParents = extractTreeParents({
			tree: [
				{
					entry: { id: "u1", parentId: null },
					children: [
						{
							entry: { id: "h1", parentId: "u1" },
							children: [
								{
									entry: { id: "a1", parentId: "h1" },
									children: [
										{
											entry: { id: "tr1", parentId: "a1" },
											children: [{ entry: { id: "a2", parentId: "tr1" }, children: [] }],
										},
									],
								},
							],
						},
					],
				},
			],
		});
		expect(filterToLeafPath(merged.state.items, "a2", merged.state.parentById).map((i) => i.id)).toEqual(["u1", "a1", "a2"]);
		expect(filterToLeafPath(merged.state.items, "a2", treeParents).map((i) => i.id)).toEqual(["u1", "a1", "a2"]);
	});
	it("falls back safely without hiding user messages when the parent chain is broken", () => {
		const items = [row("u1", null, "user"), row("a1", "missing-hidden", "assistant")];
		expect(filterToLeafPath(items, "a1").map((i) => i.id)).toEqual(["u1", "a1"]);
		expect(filterToLeafPath(items, "a1", { u1: null, a1: "missing-hidden" }).map((i) => i.id)).toEqual(["u1", "a1"]);
	});
});

describe("treeVersions", () => {
	it("groups same-kind siblings and locates the on-path one", () => {
		// The user entries are the sibling group here; assistants have no siblings.
		expect(treeVersions(branched(), "a1", "u1")).toEqual({ index: 0, total: 2, ids: ["u1", "u2"] });
		expect(treeVersions(branched(), "a2", "u2")).toEqual({ index: 1, total: 2, ids: ["u1", "u2"] });
		expect(treeVersions(branched(), "a1", "a1")).toBeNull();
	});
	it("returns null without siblings or when rewound past the entry", () => {
		expect(treeVersions(branched(), "a1", "root")).toBeNull();
		expect(treeVersions(branched(), "root", "u1")).toBeNull();
	});
});

describe("ChatController tree actions", () => {
	it("editResendFromTree fills the composer, arms the banner and refetches", async () => {
		const c = new ChatController("s1");
		apiMock.mockImplementation(async (_m: string, path: string) =>
			path.endsWith("/navigate-tree") ? { cancelled: true, editorText: "原话" } : path.endsWith("/tree") ? { leafId: "root" } : {},
		);
		c.store.setState({ working: false, transcript: { ...c.state.transcript, items: branched() } });
		c.composer = { get: () => "", set: vi.fn(), focus: vi.fn() };
		await c.editResendFromTree("u1", "fallback");
		// A user target rewinds past itself: optimistic leaf = its parent.
		expect(c.state.treeEdit).toEqual({ entryId: "u1", prevLeafId: null });
		expect(c.state.leafId).toBe("root");
		expect(c.composer?.set).toHaveBeenCalledWith("原话", true);
		// Composer banner renders the restart wording.
	});

	it("refuses with a toast while the session is working", async () => {
		const c = new ChatController("s1");
		c.store.setState({ working: true });
		await c.editResendFromTree("u1", "x");
		await c.switchTreeVersion("a2");
		expect(apiMock).not.toHaveBeenCalled();
		expect(h.toast).toHaveBeenCalledTimes(2);
		expect(h.toast.mock.calls[0][0]).toContain("当前正在回答");
	});

	it("switchTreeVersion navigates and clears the banner", async () => {
		const c = new ChatController("s1");
		apiMock.mockResolvedValue({});
		c.store.setState({ treeEdit: { entryId: "u1", prevLeafId: "root" } });
		await c.switchTreeVersion("a2");
		expect(apiMock).toHaveBeenCalledWith("POST", "/sessions/s1/navigate-tree", { entryId: "a2" });
		expect(c.state.treeEdit).toBeNull();
		expect(c.state.leafId).toBe("a2");
	});

	it("cancelTreeEdit walks the leaf back", async () => {
		const c = new ChatController("s1");
		apiMock.mockResolvedValue({});
		c.store.setState({ treeEdit: { entryId: "u1", prevLeafId: "old-leaf" } });
		await c.cancelTreeEdit();
		expect(apiMock).toHaveBeenCalledWith("POST", "/sessions/s1/navigate-tree", { entryId: "old-leaf" });
		expect(c.state.treeEdit).toBeNull();
		expect(c.state.leafId).toBe("old-leaf");
	});

	it("a send clears the banner without extra navigation", async () => {
		const c = new ChatController("s1");
		apiMock.mockImplementation(async (_m: string, path: string) =>
			path.endsWith("/prompt-ex") ? {} : path.endsWith("/composer-state") ? { streaming: false } : {},
		);
		c.store.setState({ treeEdit: { entryId: "u1", prevLeafId: "root" }, atts: [] });
		c.composer = { get: () => "edited", set: vi.fn(), focus: vi.fn(), clear: vi.fn() };
		await c.send("edited", "followUp");
		expect(c.state.treeEdit).toBeNull();
	});
	it("rebuilds blocks immediately on editResendFromTree, switchTreeVersion, and cancelTreeEdit", async () => {
		const c = new ChatController("s1");
		apiMock.mockResolvedValue({ editorText: "edited" });
		const items = branched();
		const t = { ...c.state.transcript, items };
		c.store.setState({ working: false, transcript: t, leafId: "a1", blocks: filterToLeafPath(items, "a1").map((i) => ({ type: "notice" as const, id: i.id, text: i.text, src: [i] })) });

		await c.switchTreeVersion("a2");
		expect(c.state.blocks.some((b) => b.type === "turn" && b.user?.id === "u2")).toBe(true);
		expect(c.state.blocks.some((b) => b.type === "turn" && b.user?.id === "u1")).toBe(false);

		await c.editResendFromTree("u2", "u2");
		expect(c.state.leafId).toBe("root");
		expect(c.state.blocks.some((b) => b.type === "turn" && b.user?.id === "u2")).toBe(false);

		await c.cancelTreeEdit();
		expect(c.state.leafId).toBe("a2");
		expect(c.state.blocks.some((b) => b.type === "turn" && b.user?.id === "u2")).toBe(true);
	});

	it("keeps treeEdit armed when send fails pre-dispatch validation", async () => {
		const c = new ChatController("s1");
		c.store.setState({
			treeEdit: { entryId: "u1", prevLeafId: "a1" },
			atts: [{ id: 1, name: "a.png", isImage: true, url: "", status: "up" }],
		});
		expect(await c.send("", "followUp")).toBe(false);
		expect(c.state.treeEdit).toEqual({ entryId: "u1", prevLeafId: "a1" });

		expect(await c.send("hello", "followUp")).toBe(false);
		expect(c.state.treeEdit).toEqual({ entryId: "u1", prevLeafId: "a1" });

		apiMock.mockResolvedValueOnce({ output: "ok" });
		c.store.setState({ atts: [] });
		expect(await c.send("/help", "followUp")).toBe(true);
		expect(c.state.treeEdit).toEqual({ entryId: "u1", prevLeafId: "a1" });
	});

	it("preserves user message hi after fetchTree with hidden and tool_result entries and refreshes tree on touch", async () => {
		vi.useFakeTimers();
		try {
			let leaf = "a2";
			const page: TranscriptPage = {
				items: [
					{ id: "u1", parentId: null, kind: "user", text: "hi" },
					{ id: "h1", parentId: "u1", kind: "custom", hidden: true },
					{ id: "a1", parentId: "h1", kind: "assistant", text: "", toolCalls: [{ id: "c1", name: "bash", args: {} }] },
					{ id: "tr1", parentId: "a1", kind: "tool_result", toolResult: { toolCallId: "c1", text: "ok" } },
					{ id: "a2", parentId: "tr1", kind: "assistant", text: "done" },
				],
				nextOffset: 10,
				tailId: "a2",
			};
			apiMock.mockImplementation(async (_m: string, path: string) => {
				if (path.includes("/transcript")) return page;
				if (path.endsWith("/tree")) {
					return {
						leafId: leaf,
						entries: [
							{ id: "u1", parentId: null },
							{ id: "h1", parentId: "u1" },
							{ id: "a1", parentId: "h1" },
							{ id: "tr1", parentId: "a1" },
							{ id: "a2", parentId: "tr1" },
						],
					};
				}
				return {};
			});
			const c = new ChatController("s1");
			c.start();
			await vi.advanceTimersByTimeAsync(10);
			expect(c.state.blocks.some((b) => b.type === "turn" && b.user?.text === "hi")).toBe(true);

			leaf = "a1";
			events.emit("touch", { sessionId: "s1" } as never);
			await vi.advanceTimersByTimeAsync(200);
			expect(c.state.leafId).toBe("a1");
			c.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../../lib/contracts";
import { emptySessionLive, useLive } from "../../stores/live";
import { useSessions } from "../../stores/sessions";

vi.mock("../../lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/ipc")>()),
	rpcSend: vi.fn(async () => ({})),
	privacyList: vi.fn(async () => ({ entries: [], nativeStatus: "ok", nativeError: null })),
}));

vi.mock("../../lib/events", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/events")>()),
	onPrivacyChanged: vi.fn(async () => () => {}),
}));

import { MessageList } from "./MessageList";

const makeItem = (
	partial: Partial<TranscriptItem> & { id: string; kind: TranscriptItem["kind"] },
): TranscriptItem =>
	({
		parentId: null,
		ts: "2026-11-13T08:00:00.000Z",
		text: null,
		thinking: null,
		toolCalls: [],
		toolResult: null,
		usage: null,
		model: null,
		stopReason: null,
		hidden: false,
		...partial,
	}) as TranscriptItem;

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
	useLive.setState({ sessions: {} });
	useSessions.setState({ sessions: {} });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function attachScrollMetrics(
	el: HTMLDivElement,
	metrics: { scrollHeight: number; clientHeight: number; initialScrollTop?: number },
) {
	let scrollHeight = metrics.scrollHeight;
	let clientHeight = metrics.clientHeight;
	let scrollTop = metrics.initialScrollTop ?? 0;

	Object.defineProperty(el, "scrollHeight", {
		configurable: true,
		get: () => scrollHeight,
	});
	Object.defineProperty(el, "clientHeight", {
		configurable: true,
		get: () => clientHeight,
	});
	Object.defineProperty(el, "scrollTop", {
		configurable: true,
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = Math.max(0, Math.min(v, Math.max(0, scrollHeight - clientHeight)));
		},
	});

	return {
		setScrollHeight(next: number) {
			scrollHeight = next;
			scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, scrollHeight - clientHeight)));
		},
		setClientHeight(next: number) {
			clientHeight = next;
		},
		getScrollTop: () => scrollTop,
	};
}

describe("MessageList streaming scroll stability", () => {
	it("never jumps back to the turn start when a tall streamed reply finishes while following", () => {
		const longReply = Array.from(
			{ length: 40 },
			(_, i) => `第 ${i + 1} 段回复正文，包含足够多内容以超过单屏高度。`,
		).join("\n\n");

		useLive.setState({
			sessions: {
				s1: {
					...emptySessionLive(),
					alive: true,
					streaming: true,
					items: [makeItem({ id: "u1", kind: "user", text: "请详细解释架构" })],
					streamingMessage: {
						role: "assistant",
						content: [{ type: "text", text: longReply }],
					} as never,
				},
			},
		});

		const scrollRef = createRef<HTMLDivElement>();
		render(
			<div ref={scrollRef}>
				<MessageList sessionId="s1" scrollRef={scrollRef} />
			</div>,
		);
		const scroller = scrollRef.current!;
		const ctl = attachScrollMetrics(scroller, {
			scrollHeight: 2600,
			clientHeight: 600,
			initialScrollTop: 2000,
		});

		// Stream finishes and transcript commits the full reply
		act(() => {
			useLive.setState((state) => ({
				sessions: {
					...state.sessions,
					s1: {
						...state.sessions.s1,
						streaming: false,
						streamingMessage: null,
						items: [
							makeItem({ id: "u1", kind: "user", text: "请详细解释架构" }),
							makeItem({
								id: "a1",
								kind: "assistant",
								text: longReply,
								stopReason: "stop",
							}),
						],
					},
				},
			}));
		});

		// Must stay pinned at the bottom (2000), NEVER jumping back to top/prompt (0)
		expect(ctl.getScrollTop()).toBe(2000);
	});

	it("preserves the user's mid-reply reading scrollTop when streaming finishes after scrolling up", () => {
		const longReply = Array.from(
			{ length: 45 },
			(_, i) => `第 ${i + 1} 段流式内容，用户正在中途向上翻阅阅读这一部分。`,
		).join("\n\n");

		useLive.setState({
			sessions: {
				s1: {
					...emptySessionLive(),
					alive: true,
					streaming: true,
					items: [makeItem({ id: "u1", kind: "user", text: "生成一份长报告" })],
					streamingMessage: {
						role: "assistant",
						content: [{ type: "text", text: longReply }],
					} as never,
				},
			},
		});

		const scrollRef = createRef<HTMLDivElement>();
		render(
			<div ref={scrollRef}>
				<MessageList sessionId="s1" scrollRef={scrollRef} />
			</div>,
		);
		const scroller = scrollRef.current!;
		const ctl = attachScrollMetrics(scroller, {
			scrollHeight: 3000,
			clientHeight: 600,
			initialScrollTop: 2400,
		});

		// User scrolls up mid-stream to read at scrollTop = 950
		act(() => {
			fireEvent.wheel(scroller, { deltaY: -180 });
			scroller.scrollTop = 950;
			fireEvent.scroll(scroller);
		});
		expect(ctl.getScrollTop()).toBe(950);

		// Reply finishes streaming and commits to the virtualized transcript
		act(() => {
			useLive.setState((state) => ({
				sessions: {
					...state.sessions,
					s1: {
						...state.sessions.s1,
						streaming: false,
						streamingMessage: null,
						items: [
							makeItem({ id: "u1", kind: "user", text: "生成一份长报告" }),
							makeItem({
								id: "a1",
								kind: "assistant",
								text: longReply,
								stopReason: "stop",
							}),
						],
					},
				},
			}));
		});

		// Must remain right at the user's reading position (950), neither jumping to 0 nor yanking to 2400
		expect(ctl.getScrollTop()).toBe(950);
	});

	it("does not detach follow-bottom when clicking outside the message scroller (e.g. composer)", () => {
		let nowMs = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => nowMs);

		useLive.setState({
			sessions: {
				s1: {
					...emptySessionLive(),
					alive: true,
					streaming: true,
					items: [makeItem({ id: "u1", kind: "user", text: "继续输出" })],
					streamingMessage: {
						role: "assistant",
						content: [{ type: "text", text: "第一段内容\n\n第二段内容" }],
					} as never,
				},
			},
		});

		const scrollRef = createRef<HTMLDivElement>();
		const composerRef = createRef<HTMLTextAreaElement>();
		render(
			<div>
				<div ref={scrollRef}>
					<MessageList sessionId="s1" scrollRef={scrollRef} />
				</div>
				<textarea ref={composerRef} aria-label="composer" />
			</div>,
		);
		const scroller = scrollRef.current!;
		const ctl = attachScrollMetrics(scroller, {
			scrollHeight: 1600,
			clientHeight: 600,
			initialScrollTop: 1000,
		});

		// Advance past FOLLOW_SETTLE_MS (250ms), click composer outside scroller,
		// and trigger a late-content-growth scroll event (dist = 400 >= NEAR_BOTTOM_PX)
		nowMs += 500;
		act(() => {
			fireEvent.pointerDown(composerRef.current!);
			ctl.setScrollHeight(2000);
			fireEvent.scroll(scroller);
			fireEvent.pointerUp(composerRef.current!);
		});

		// Subsequent commit still follows to bottom (1400) because outside click did not detach
		nowMs += 50;
		act(() => {
			useLive.setState((state) => ({
				sessions: {
					...state.sessions,
					s1: {
						...state.sessions.s1,
						streaming: false,
						streamingMessage: null,
						items: [
							makeItem({ id: "u1", kind: "user", text: "继续输出" }),
							makeItem({ id: "a1", kind: "assistant", text: "第一段内容\n\n第二段内容", stopReason: "stop" }),
						],
					},
				},
			}));
		});

		expect(ctl.getScrollTop()).toBe(1400);
	});

	it("does not yank scrollTop to the bottom when expanding TurnDiffCard in an idle chat at the bottom", () => {
		let rowHeight = 600;
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => rowHeight);
		let roCallbacks: Array<{ el: Element; cb: (entries: unknown[]) => void }> = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				private cb: (entries: unknown[]) => void;
				constructor(cb: (entries: unknown[]) => void) {
					this.cb = cb;
				}
				observe(el: Element) {
					roCallbacks.push({ el, cb: this.cb });
				}
				unobserve() {}
				disconnect() {
					roCallbacks = roCallbacks.filter((item) => item.cb !== this.cb);
				}
			},
		);

		const bigDiff = [
			"@@ -1,2 +1,80 @@",
			" const base = 1;",
			...Array.from({ length: 78 }, (_, i) => `+export const line_${i} = ${i};`),
		].join("\n");

		useLive.setState({
			sessions: {
				s1: {
					...emptySessionLive(),
					alive: true,
					streaming: false,
					items: [
						makeItem({ id: "u1", kind: "user", text: "修改代码" }),
						makeItem({
							id: "a-step",
							kind: "assistant",
							toolCalls: [{ id: "c1", name: "edit", args: { path: "/repo/src/a.ts" }, intent: null }],
							stopReason: "toolUse",
						}),
						makeItem({
							id: "r1",
							kind: "tool_result",
							toolResult: {
								toolCallId: "c1",
								toolName: "edit",
								text: "edited",
								isError: false,
								details: { diff: bigDiff },
							},
						}),
						makeItem({
							id: "a-final",
							kind: "assistant",
							text: "修改已完成。",
							stopReason: "stop",
						}),
					],
				},
			},
		});

		const scrollRef = createRef<HTMLDivElement>();
		const { getByRole } = render(
			<div ref={scrollRef}>
				<MessageList sessionId="s1" sessionCwd="/repo" scrollRef={scrollRef} />
			</div>,
		);
		const scroller = scrollRef.current!;
		const ctl = attachScrollMetrics(scroller, {
			scrollHeight: 1600,
			clientHeight: 600,
			initialScrollTop: 1000,
		});

		const diffBtn = getByRole("button", { name: /1 个文件已更改/ });
		act(() => {
			fireEvent.pointerDown(diffBtn);
			fireEvent.click(diffBtn);
			fireEvent.pointerUp(diffBtn);
			// Simulate the expanded DiffView growing the row and scrollHeight by +2400px
			rowHeight = 3000;
			ctl.setScrollHeight(4000);
			for (const { el, cb } of [...roCallbacks]) {
				cb([{ target: el, borderBoxSize: [{ blockSize: 3000, inlineSize: 800 }] }]);
			}
		});

		// Must stay anchored at 1000 (header stays under cursor), NEVER teleporting to 3400!
		expect(ctl.getScrollTop()).toBe(1000);
	});
});

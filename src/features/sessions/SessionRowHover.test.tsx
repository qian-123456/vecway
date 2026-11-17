// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../../lib/contracts";
import * as ipc from "../../lib/ipc";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { clearHoverDetailsCache } from "./SessionHoverCard";
import { SessionRow } from "./SessionRow";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(() => Promise.reject(new Error("no tauri"))),
}));

const makeSession = (id: string): SessionMeta =>
	({
		id,
		tool: "omp",
		file: `/tmp/${id}.jsonl`,
		cwd: "/tmp/ws1",
		title: `Hover Session ${id}`,
		label: "#1",
		createdAt: "2026-11-17T10:00:00.000Z",
		updatedAt: "2026-11-17T10:05:00.000Z",
		parentId: null,
		forkDepth: 0,
		status: "idle",
		unread: false,
		pending: null,
		live: false,
		externalPid: null,
		pinned: false,
		archived: false,
		workspaceId: "ws1",
		repoRoot: null,
		git: { branch: "main", dirty: 0, worktree: null },
		result: null,
		lastAssistant: "Ready for verification",
		model: null,
		attention: null,
		mode: "code",
		groupId: null,
	}) as SessionMeta;

describe("SessionRow hover card lifecycle (no stuck preview)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearHoverDetailsCache();
		vi.spyOn(ipc, "sessionSnapshot").mockResolvedValue({ thinkingLevel: null, contextTokens: null });
		vi.spyOn(ipc, "sessionUsage").mockResolvedValue({ available: false, tokens: null, cost: null, source: "transcript" });
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		useSessions.setState({
			sessions: { s1: makeSession("s1") },
			workspaces: [{ id: "ws1", name: "ws1", path: "/tmp/ws1", kind: "project", sort: 0, mode: "code" }],
		});
		useUi.setState({ selectedSessionId: null, selectedIds: new Set() });
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("opens after 400ms dwell and closes immediately on mouseLeave", () => {
		render(
			<SessionRow
				session={makeSession("s1")}
				workspaces={[]}
				onBatchAction={vi.fn()}
			/>,
		);

		const row = screen.getByRole("option");
		fireEvent.mouseEnter(row);
		expect(document.querySelector('[data-layer="hovercard"]')).toBeNull();

		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(document.querySelector('[data-layer="hovercard"]')).not.toBeNull();

		fireEvent.mouseLeave(row);
		expect(document.querySelector('[data-layer="hovercard"]')).toBeNull();
	});

	it("clears prior timer on repeated mouseEnter so mouseLeave never leaks an old timer", () => {
		render(
			<SessionRow
				session={makeSession("s1")}
				workspaces={[]}
				onBatchAction={vi.fn()}
			/>,
		);

		const row = screen.getByRole("option");
		fireEvent.mouseEnter(row);
		act(() => {
			vi.advanceTimersByTime(250);
		});
		// Re-entering before leave used to leak the first 400ms timer
		fireEvent.mouseEnter(row);
		act(() => {
			vi.advanceTimersByTime(50);
		});
		fireEvent.mouseLeave(row);
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(document.querySelector('[data-layer="hovercard"]')).toBeNull();
	});

	it("dismisses immediately on row click, scroll, keydown, blur, and unmount", () => {
		const { unmount } = render(
			<SessionRow
				session={makeSession("s1")}
				workspaces={[]}
				onBatchAction={vi.fn()}
			/>,
		);

		const row = screen.getByRole("option");
		const openCard = () => {
			fireEvent.mouseEnter(row);
			act(() => {
				vi.advanceTimersByTime(400);
			});
			expect(document.querySelector('[data-layer="hovercard"]')).not.toBeNull();
		};

		openCard();
		fireEvent.click(row);
		expect(document.querySelector('[data-layer="hovercard"]')).toBeNull();

		openCard();
		fireEvent.scroll(window);
		expect(document.querySelector('[data-layer="hovercard"]')).toBeNull();

		openCard();
		fireEvent.keyDown(document, { key: "ArrowDown" });
		expect(document.querySelector('[data-layer="hovercard"]')).toBeNull();

		openCard();
		fireEvent(window, new Event("blur"));
		expect(document.querySelector('[data-layer="hovercard"]')).toBeNull();

		openCard();
		unmount();
		expect(document.querySelector('[data-layer="hovercard"]')).toBeNull();
	});
});

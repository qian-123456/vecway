// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta, Workspace } from "../../lib/contracts";
import * as ipc from "../../lib/ipc";
import { useComposer } from "../../stores/composer";
import { useLive } from "../../stores/live";
import { useSessions } from "../../stores/sessions";
import { useWorktrees } from "../../stores/worktrees";
import {
	cleanAssistantPreview,
	clearHoverDetailsCache,
	formatCompactTokens,
	SessionHoverCard,
} from "./SessionHoverCard";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(() => Promise.reject(new Error("no tauri"))),
}));

vi.mock("../../lib/hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/hooks")>();
	return {
		...actual,
		useHomeDir: () => "/Users/alice",
	};
});

const WORKSPACE: Workspace = {
	id: "ws-1",
	path: "/Users/alice/projects/omp-workspace",
	name: "omp-workspace",
	kind: "project",
	sort: 0,
	mode: "code",
};

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		id: "s1",
		tool: "omp",
		file: "/tmp/s1.jsonl",
		cwd: "/Users/alice/projects/omp-workspace",
		title: "Implement hover card improvements",
		label: "#12",
		createdAt: "2026-11-17T10:00:00.000Z",
		updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
		parentId: null,
		forkDepth: 0,
		kind: null,
		status: "idle",
		unread: false,
		pending: null,
		live: false,
		externalPid: null,
		pinned: false,
		archived: false,
		workspaceId: "ws-1",
		repoRoot: "/Users/alice/projects/omp-workspace",
		git: {
			branch: "feat/hover",
			dirty: 2,
			worktree: null,
		},
		result: null,
		lastAssistant: "## Done\nImplemented `SessionHoverCard` with **clean** summary and [docs](https://example.com).",
		model: "anthropic/claude-3-5-sonnet-20241022",
		attention: null,
		mode: "code",
		groupId: null,
		...overrides,
	};
}

const ANCHOR_RECT = new DOMRect(10, 40, 220, 30);

describe("SessionHoverCard helpers and content", () => {
	beforeEach(() => {
		clearHoverDetailsCache();
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		useComposer.setState({ drafts: {}, images: {} });
		useLive.setState({ sessions: {} });
		useWorktrees.setState({ byWorkspace: {} });
		useSessions.setState({ sessions: {}, workspaces: [WORKSPACE] });
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("cleanAssistantPreview strips markdown formatting cleanly", () => {
		expect(
			cleanAssistantPreview("### Summary\n```ts\nconst x = 1;\n```\nSee [guide](https://a.b) and **bold** `code`."),
		).toBe("Summary const x = 1; See guide and bold code.");
		expect(cleanAssistantPreview(null)).toBe("");
	});

	it("formatCompactTokens formats small, k, and M counts", () => {
		expect(formatCompactTokens(840)).toBe("840");
		expect(formatCompactTokens(12_400)).toBe("12.4k");
		expect(formatCompactTokens(128_000)).toBe("128k");
		expect(formatCompactTokens(1_500_000)).toBe("1.5M");
		expect(formatCompactTokens(null)).toBe("");
	});

	it("renders pointer-none card with status, draft, reply summary, model, tokens, git ahead/behind, and deduplicates project root cwd", async () => {
		const snapSpy = vi.spyOn(ipc, "sessionSnapshot").mockResolvedValue({
			thinkingLevel: "high",
			contextTokens: 24_500,
		});
		const usageSpy = vi.spyOn(ipc, "sessionUsage").mockResolvedValue({
			available: true,
			tokens: 185_000,
			cost: null,
			source: "transcript",
		});

		useSessions.setState({
			sessions: {
				parent1: makeSession({ id: "parent1", title: "Parent Thread" }),
			},
			workspaces: [WORKSPACE],
		});
		useComposer.setState({
			drafts: { s1: "Follow up message" },
			images: {},
		});
		useLive.setState({
			sessions: {
				s1: {
					streaming: true,
					state: null,
					pendingUi: [],
					subagents: {
						sub1: { status: "running" } as never,
					},
					streamingMessage: null,
					pendingUserEchoes: [],
					commands: [],
					commandOutputs: [],
					tools: {
						t1: {
							toolCallId: "t1",
							toolName: "read",
							args: {},
							intent: "Reading SessionRow",
							status: "running",
							text: "",
							details: null,
						},
					},
					items: [],
					nextOffset: 0,
					alive: true,
					liveRequests: [],
					flowNotices: [],
					ompQueue: { steering: [], followUp: [] },
				},
			},
		});
		useWorktrees.setState({
			byWorkspace: {
				"ws-1": [
					{
						path: "/Users/alice/projects/omp-workspace",
						branch: "feat/hover",
						head: "abc1234",
						dirty: 3,
						sessionIds: ["s1"],
						ahead: 2,
						behind: 1,
					},
				],
			},
		});

		const session = makeSession({
			status: "working",
			parentId: "parent1",
			kind: "fork",
		});

		render(
			<SessionHoverCard
				session={session}
				anchorRect={ANCHOR_RECT}
				open
				workspaces={[WORKSPACE]}
			/>,
		);

		const layer = document.querySelector('[data-layer="hovercard"]');
		expect(layer?.className).toContain("pointer-events-none");
		expect(layer?.querySelector(".rounded-full")).toBeNull();
		expect(layer?.querySelector('[class*="rounded-md border"]')).toBeNull();
		expect(screen.getByText("运行中")).toBeTruthy();
		expect(screen.getByText("有未发草稿")).toBeTruthy();
		expect(screen.getByText(/分叉自: Parent Thread/)).toBeTruthy();
		expect(screen.getByText("正在执行：Reading SessionRow")).toBeTruthy();
		expect(screen.getByText("1 个子代理")).toBeTruthy();
		expect(screen.getByText(/Implemented SessionHoverCard with clean summary/)).toBeTruthy();
		expect(screen.getByText("Claude 3.5 Sonnet")).toBeTruthy();
		expect(screen.getByText("↑2 ↓1")).toBeTruthy();
		expect(screen.getByText("●3 未提交")).toBeTruthy();
		// Same cwd as matched project workspace -> directory row deduplicated
		expect(screen.queryByText("~/projects/omp-workspace")).toBeNull();

		await waitFor(() => {
			expect(screen.getByText("high")).toBeTruthy();
			expect(screen.getByText("上下文 24.5k")).toBeTruthy();
			expect(screen.getByText("累计 185k")).toBeTruthy();
		});
		expect(snapSpy).toHaveBeenCalledWith("s1");
		expect(usageSpy).toHaveBeenCalledWith("s1");
	});

	it("shows directory when session runs inside a separate worktree", async () => {
		vi.spyOn(ipc, "sessionSnapshot").mockResolvedValue({ thinkingLevel: null, contextTokens: null });
		vi.spyOn(ipc, "sessionUsage").mockResolvedValue({ available: false, tokens: null, cost: null, source: "transcript" });

		const session = makeSession({
			cwd: "/Users/alice/projects/omp-workspace/.worktrees/hover-fix",
			git: {
				branch: "omp/hover-fix",
				dirty: 0,
				worktree: "hover-fix",
			},
		});

		await act(async () => {
			render(
				<SessionHoverCard
					session={session}
					anchorRect={ANCHOR_RECT}
					open
					workspaces={[WORKSPACE]}
				/>,
			);
		});

		expect(screen.getByText("~/projects/omp-workspace/.worktrees/hover-fix")).toBeTruthy();
		expect(screen.getByText("独立工作树")).toBeTruthy();
	});
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_OFF } from "../../../src/features/chat/plan/planStatus";
import * as apiModule from "../../core/api";
import { bytesToBase64 } from "../../core/nativeBridge";
import { useSessions } from "../../core/stores/sessions";
import { FilesPanel } from "./FilesPage";
import { GitPanel } from "./GitPage";
import { PlanPanel } from "./PlanPage";
import { RightWorkspaceDrawer, useRightEdgeSwipe } from "./RightWorkspaceDrawer";
import { ServicesPanel } from "./ServicesPage";
import { TerminalPanel } from "./TerminalPage";
import { useRightDrawer } from "./rightDrawerStore";

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		options: Record<string, unknown> = {};
		textarea = document.createElement("textarea");
		loadAddon() {}
		open(el: HTMLElement) {
			el.appendChild(this.textarea);
		}
		onData() {
			return { dispose() {} };
		}
		write() {}
		reset() {}
		clear() {}
		paste() {}
		focus() {
			this.textarea.focus();
		}
		blur() {
			this.textarea.blur();
		}
		dispose() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit() {}
	},
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

function resetDrawerStore() {
	useRightDrawer.setState({
		open: false,
		sessionId: null,
		tabBySession: {},
		visitedBySession: {},
		pendingSidechat: null,
		pendingMain: null,
		tabHeaders: {},
	});
}

describe("RightWorkspaceDrawer & panel overhaul", () => {
	beforeEach(() => {
		resetDrawerStore();
		document.documentElement.dataset.scheme = "light";
		vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
		useSessions.setState({
			list: [{ id: "s1", label: "#1", title: "主会话", status: "idle", updatedAt: "2026-11-22T10:00:00Z", cwd: "/proj", live: true }],
			byId: {
				s1: { id: "s1", label: "#1", title: "主会话", status: "idle", updatedAt: "2026-11-22T10:00:00Z", cwd: "/proj", live: true },
			},
			loaded: true,
			loading: false,
		});
	});

	afterEach(() => {
		cleanup();
		resetDrawerStore();
		delete window.__VECWAY_NATIVE__;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("preserves visited tabs across close/reopen with CSS hidden and unmounts on session switch", async () => {
		const apiSpy = vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "GET" && path.endsWith("/git/status")) return { isRepo: true, branch: "main", files: [] };
			if (method === "GET" && path.endsWith("/composer-state")) return { planMode: false, planStatus: PLAN_OFF };
			if (method === "GET" && path.endsWith("/services?all=false")) return [];
			return {};
		});

		const view = render(<RightWorkspaceDrawer sessionId="s1" />);
		expect(screen.queryByRole("dialog", { name: "工作区抽屉" })).toBeNull();

		act(() => useRightDrawer.getState().openDrawer("s1", "git"));
		await waitFor(() => expect(screen.getAllByText(/工作区干净/).length).toBeGreaterThan(0));
		expect(apiSpy).toHaveBeenCalledWith("GET", "/sessions/s1/git/status", undefined, expect.any(Object));

		// Switch to services, keeping git mounted & hidden
		fireEvent.click(screen.getByRole("tab", { name: "服务" }));
		await waitFor(() => expect(screen.getByText("当前项目暂无预览服务")).toBeTruthy());
		const panels = document.querySelectorAll('[role="tabpanel"]');
		expect(panels).toHaveLength(2);
		expect(panels[0].className).toContain("hidden");
		expect(panels[1].className).not.toContain("hidden");

		// Close drawer: visited tabs stay mounted and selected tab stays non-hidden during exit slide while outer wrapper is inert
		fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
		expect(useRightDrawer.getState().open).toBe(false);
		const closedPanels = document.querySelectorAll('[role="tabpanel"]');
		expect(closedPanels).toHaveLength(2);
		expect(closedPanels[0].className).toContain("hidden");
		expect(closedPanels[1].className).not.toContain("hidden");
		const outer = screen.getByRole("dialog", { name: "工作区抽屉", hidden: true }).parentElement;
		expect(outer?.getAttribute("aria-hidden")).toBe("true");
		expect(outer?.hasAttribute("inert")).toBe(true);
		// Switch session: previous session's visited tabs unmount cleanly
		view.rerender(<RightWorkspaceDrawer sessionId="s2" />);
		expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
	});

	it("keeps Plan out of RightWorkspaceDrawer tabs even when an active plan exists", async () => {
		vi.spyOn(apiModule, "api").mockImplementation(async (_m, path) => {
			if (path.endsWith("/composer-state")) {
				return {
					planMode: true,
					planStatus: {
						...PLAN_OFF,
						enabled: true,
						phase: "review",
						title: "重构计划",
						content: "# 重构计划\n- [ ] 第一步",
					},
				};
			}
			if (path.endsWith("/git/status")) return { isRepo: true, branch: "main", files: [] };
			return {};
		});

		render(<RightWorkspaceDrawer sessionId="s1" />);
		act(() => useRightDrawer.getState().openDrawer("s1", "git"));
		await waitFor(() => expect(screen.getAllByText(/工作区干净/).length).toBeGreaterThan(0));
		expect(screen.queryByRole("tab", { name: "计划" })).toBeNull();
	});

	it("lazily resolves Home draft sessionId once on open", async () => {
		vi.spyOn(apiModule, "api").mockResolvedValue({ isRepo: false, files: [] });
		const resolveSessionId = vi.fn(async () => "mobile-draft-99");
		render(<RightWorkspaceDrawer resolveSessionId={resolveSessionId} />);

		act(() => useRightDrawer.getState().openDrawer("", "files"));
		await waitFor(() => expect(resolveSessionId).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(useRightDrawer.getState().sessionId).toBe("mobile-draft-99"));
		expect(useRightDrawer.getState().tabBySession["mobile-draft-99"]).toBe("files");
	});

	it("triggers useRightEdgeSwipe only from rightmost 24px on left swipe > 44px", () => {
		Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
		const onOpen = vi.fn();
		renderHook(() => useRightEdgeSwipe(onOpen, true));

		// Swipe starting too far left (x = 300) should NOT trigger
		fireEvent.touchStart(document, { touches: [{ clientX: 300, clientY: 200 }] });
		fireEvent.touchMove(document, { touches: [{ clientX: 200, clientY: 200 }] });
		fireEvent.touchEnd(document);
		expect(onOpen).not.toHaveBeenCalled();

		// Swipe starting at x = 390 (>= 376) and moving left by 60px triggers
		fireEvent.touchStart(document, { touches: [{ clientX: 390, clientY: 200 }] });
		fireEvent.touchMove(document, { touches: [{ clientX: 330, clientY: 205 }] });
		fireEvent.touchEnd(document);
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("toggles sidechat switcher from top header title (not Row 2 tab), supports model/context/rename parity, and consumes sidechat annotation", async () => {
		vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "GET" && path.endsWith("/sidechats")) {
				return [
					{ id: "sc-1", label: "#1", title: "第一旁聊", status: "review", updatedAt: "2026-11-22T10:00:00Z", cwd: "/proj", live: true },
					{ id: "sc-2", label: "#2", title: "第二旁聊", status: "review", updatedAt: "2026-11-22T09:00:00Z", cwd: "/proj", live: true },
				];
			}
			if (method === "GET" && path.endsWith("/composer-state")) {
				return { planMode: false, planStatus: PLAN_OFF, model: "anthropic/claude-opus-4-6", thinkingLevel: "high", contextPercent: 42 };
			}
			if (method === "GET" && path.includes("/transcript?")) {
				return {
					items: [
						{ id: "q1", kind: "user", text: "Side chat forked from main session\n\n## User question\n首个问题" },
						{ id: "a1", kind: "assistant", text: "这里是结论内容", ts: "2026-11-22T10:00:00Z" },
					],
					reset: true,
				};
			}
			return {};
		});

		render(<RightWorkspaceDrawer sessionId="s1" />);
		act(() => useRightDrawer.getState().openDrawer("s1", "sidechat"));

		await screen.findByText("第一旁聊");
		expect(screen.queryByRole("button", { name: "完成" })).toBeNull();
		expect(screen.queryByRole("button", { name: "发回主对话" })).toBeNull();
		expect(screen.getByRole("button", { name: /上下文用量：42%/ })).toBeTruthy();
		expect(screen.getByText("claude-opus-4-6")).toBeTruthy();

		// Tapping Row 2 辅助对话 tab while active does NOT open the switcher
		const sidechatTab = screen.getByRole("tab", { name: "辅助对话" });
		expect(sidechatTab.getAttribute("aria-selected")).toBe("true");
		fireEvent.click(sidechatTab);
		expect(screen.queryByRole("dialog", { name: "辅助对话列表" })).toBeNull();

		// Tapping Row 1 top title button opens the TitleSwitcher popover list
		fireEvent.click(screen.getByRole("button", { name: /切换辅助对话/ }));
		expect(screen.getByRole("menu", { name: /全部辅助对话/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /打开完整会话|在主对话中打开/ })).toBeNull();

		fireEvent.click(screen.getByRole("menuitemradio", { name: /^第二旁聊/ }));
		expect(screen.queryByRole("menu", { name: /全部辅助对话/ })).toBeNull();
		await screen.findByText("第二旁聊");

		// Top-right ⋯ holds 把结论发回主对话 and 重命名此辅助对话
		const moreBtn = await screen.findByRole("button", { name: "更多操作" });
		fireEvent.click(moreBtn);
		expect(screen.getByRole("button", { name: "重命名此辅助对话" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "把结论发回主对话" }));
		expect(await screen.findByRole("textbox", { name: "结论" })).toBeTruthy();
		fireEvent.keyDown(document, { key: "Escape" });

		act(() => {
			useRightDrawer.getState().openSidechatWithAnnotation("s1", {
				quote: "const x = 1;",
				comment: "解释这行",
				sourceLabel: "主对话",
			});
		});
		await waitFor(() => {
			expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("> const x = 1;");
		});
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("解释这行");
	});

	it("removes Git per-file switches, commits all atomically with AI suggest, and collapses branches", async () => {
		const apiSpy = vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "GET" && path.endsWith("/git/status")) {
				return { isRepo: true, branch: "feat/ux", files: [{ path: "src/app.ts", status: "M", staged: false, unstaged: true }] };
			}
			if (method === "POST" && path.endsWith("/git/suggest")) return { suggestion: "feat: polish mobile ux" };
			if (method === "POST" && path.endsWith("/git/stage")) return { ok: true };
			if (method === "POST" && path.endsWith("/git/commit")) return { output: "[feat/ux 1234] feat: polish mobile ux" };
			if (method === "GET" && path.includes("/git/diff?")) return { diff: "+const a = 1;" };
			if (method === "GET" && path.includes("/git/log")) {
				return [{ sha: "abcdef123456", short: "abcdef1", subject: "initial commit", author: "Alice", ts: "2026-11-22T09:00:00Z" }];
			}
			if (method === "GET" && path.endsWith("/git/branches")) {
				return [{ name: "feat/ux", displayName: "feat/ux", isRemote: false, remote: null, upstream: "origin/feat/ux", isCurrentWorktree: true, lastCommitSha: "abcdef1", lastCommitMessage: "wip", lastCommitTime: "1h ago", ahead: 1, behind: 0, isMerged: false }];
			}
			return {};
		});

		render(<GitPanel sessionId="s1" embedded />);
		await screen.findByText("app.ts");
		expect(screen.queryByRole("switch")).toBeNull();
		expect(screen.queryByRole("textbox", { name: "提交说明" })).toBeNull();

		// Open diff and send to AI
		fireEvent.click(screen.getByText("app.ts"));
		await screen.findByText("改动差异");
		fireEvent.click(screen.getByRole("button", { name: /让 AI 修改/ }));
		expect(useRightDrawer.getState().pendingMain?.payload.sourceLabel).toBe("Git 改动 · src/app.ts");

		// Close diff and test commit-all modal
		fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
		fireEvent.click(screen.getByRole("button", { name: "填写说明提交" }));
		await waitFor(() => expect((screen.getByRole("textbox", { name: "提交说明" }) as HTMLTextAreaElement).value).toBe("feat: polish mobile ux"));
		fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
		await waitFor(() => expect(apiSpy).toHaveBeenCalledWith("POST", "/sessions/s1/git/stage", { paths: ["src/app.ts"] }));
		expect(apiSpy).toHaveBeenCalledWith("POST", "/sessions/s1/git/commit", { message: "feat: polish mobile ux" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		// Switch to Commits tab to verify commit list with author & short sha
		fireEvent.click(screen.getByRole("tab", { name: /提交/ }));
		await screen.findByText("initial commit");
		expect(screen.getByText("Alice")).toBeTruthy();
		expect(screen.getByText("abcdef1")).toBeTruthy();

		// Switch to Branches/Topology tab to verify current branch
		fireEvent.click(screen.getByRole("tab", { name: /分支/ }));
		expect(await screen.findByText(/当前/)).toBeTruthy();
		expect(screen.getAllByText("feat/ux").length).toBeGreaterThanOrEqual(2);
	});

	it("shows directory tree with slim uncommitted bar, renders markdown preview, and sends Ask AI", async () => {
		vi.spyOn(apiModule, "api").mockImplementation(async (_m, path) => {
			if (path.endsWith("/git/status")) {
				return { isRepo: true, branch: "main", files: [{ path: "docs/README.md", status: "M", staged: false, unstaged: true }] };
			}
			if (path.includes("/file?")) {
				return { path: "docs/README.md", size: 24, binary: false, truncated: false, text: "# 标题\n\n正文内容" };
			}
			return { path: "/proj/docs", parent: "/proj", entries: [{ name: "README.md", path: "/proj/docs/README.md", kind: "file", size: 24 }] };
		});

		render(<FilesPanel sessionId="s1" embedded />);
		expect(await screen.findByText("1 个文件还没提交")).toBeTruthy();
		fireEvent.click(await screen.findByRole("button", { name: /README\.md/ }));
		await screen.findByText("正文内容");
		expect(screen.queryByRole("button", { name: /自动换行/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /问 AI/ }));
		expect(useRightDrawer.getState().pendingMain?.payload.sourceLabel).toBe("文件 · README.md");
	});

	it("never renders ordinary assistant reply as a fake plan in PlanPanel", async () => {
		vi.spyOn(apiModule, "api").mockResolvedValue({
			text: "这是普通对话里的回复，不是计划",
			streaming: false,
			planStatus: null,
		});
		render(<PlanPanel sessionId="s1" embedded />);
		await screen.findByText("暂无计划");
		expect(screen.queryByText("这是普通对话里的回复，不是计划")).toBeNull();
	});

	it("scopes ServicesPanel to project previews and hides host ports behind diagnostic toggle", async () => {
		vi.spyOn(apiModule, "api").mockImplementation(async (_m, path) => {
			if (path.includes("all=false")) {
				return [
					{ pid: 101, name: "vite", port: 5173, cwd: "/proj", command: "vite", sessionId: "s1", startedByApp: true, memoryKb: 20480 },
					{ pid: 202, name: "other-app", port: 9000, cwd: "/other", command: "node other.js", sessionId: null, startedByApp: false, memoryKb: null },
				];
			}
			return [
				{ pid: 101, name: "vite", port: 5173, cwd: "/proj", command: "vite", sessionId: "s1", startedByApp: true, memoryKb: 20480 },
				{ pid: 202, name: "other-app", port: 9000, cwd: "/other", command: "node other.js", sessionId: null, startedByApp: false, memoryKb: null },
			];
		});

		render(<ServicesPanel sessionId="s1" embedded />);
		await screen.findByText("vite");
		expect(screen.queryByText("other-app")).toBeNull();

		const diagBtn = screen.getByRole("button", { name: /本机其他端口（诊断）/ });
		expect(diagBtn.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(diagBtn);
		await screen.findByText("other-app");
		// Open row actions menu for project service
		fireEvent.click(screen.getByRole("button", { name: "操作 vite" }));
		expect(await screen.findByRole("button", { name: "停止服务" })).toBeTruthy();
	});

	it("captures terminal output blocks and dispatches unified multi-select annotations", async () => {
		const utf8 = new TextEncoder();
		let handlers: { onOpen?: () => void; onEvent?: (ev: string, data: string) => void } | null = null;
		window.__VECWAY_NATIVE__ = {
			httpRequest: vi.fn(async () => ({
				status: 200,
				headers: { "content-type": "application/json" },
				bodyText: JSON.stringify({ termId: "t-1", cwd: "/proj/sub" }),
			})),
			openSse: vi.fn((_url, h) => {
				handlers = h;
				return () => {};
			}),
		} as unknown as NonNullable<typeof window.__VECWAY_NATIVE__>;

		render(<TerminalPanel sessionId="s1" embedded />);
		await waitFor(() => expect(handlers).not.toBeNull());
		act(() => handlers?.onOpen?.());
		expect(screen.getByText("/proj/sub")).toBeTruthy();

		act(() => {
			handlers?.onEvent?.(
				"data",
				bytesToBase64(utf8.encode("user@mac % npm test\nFAIL test.ts\nuser@mac % git status\nmodified: a.ts\nuser@mac % ")),
			);
		});
		expect(screen.getByText("已就绪")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /发给 AI/ }));
		await screen.findByText("已选 0 段");
		fireEvent.click(screen.getByRole("button", { name: /npm test/ }));
		expect(screen.getByText("已选 1 段")).toBeTruthy();
		fireEvent.change(screen.getByRole("textbox", { name: "批注说明" }), { target: { value: "请修复这个测试" } });
		fireEvent.click(screen.getByRole("button", { name: "批注到辅助对话" }));

		expect(useRightDrawer.getState().pendingSidechat?.payload.comment).toBe("请修复这个测试");
		expect(useRightDrawer.getState().pendingSidechat?.payload.quote).toContain("FAIL test.ts");
		expect(useRightDrawer.getState().tabBySession.s1).toBe("sidechat");
	});

	it("keeps RightWorkspaceDrawer onscreen during reduced-motion opacity fade-out and moves offscreen after fade completes", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("matchMedia", (q: string) => ({
			matches: q.includes("prefers-reduced-motion"),
			media: q,
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent() { return false; },
		}));
		vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "GET" && path.endsWith("/git/status")) return { isRepo: true, branch: "main", files: [] };
			return {};
		});

		render(<RightWorkspaceDrawer sessionId="s1" />);
		act(() => useRightDrawer.getState().openDrawer("s1", "git"));
		const dialog = screen.getByRole("dialog", { name: "工作区抽屉" });
		expect(dialog.style.transform).toBe("translate3d(0,0,0)");

		// Close via button under reduced motion: must stay at translate3d(0,0,0) while fading out
		fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
		expect(dialog.dataset.visible).toBe("false");
		expect(dialog.style.transform).toBe("translate3d(0,0,0)");

		act(() => vi.advanceTimersByTime(160));
		expect(dialog.style.transform).toBe("translate3d(100%,0,0)");
		vi.useRealTimers();
	});
});

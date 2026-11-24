// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../core/api";
import { useSessions } from "../../core/stores/sessions";
import { PlanSheet } from "../chat/components/PlanSheet";
import { GitPanel } from "./GitPage";
import { RightWorkspaceDrawer } from "./RightWorkspaceDrawer";
import { useRightDrawer } from "./rightDrawerStore";

vi.mock("../../core/api", () => ({
	api: vi.fn(),
	errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
	resolveApiUrl: (p: string) => p,
}));

vi.mock("../../core/nav", () => ({
	nav: {
		push: vi.fn(),
		back: vi.fn(),
		replace: vi.fn(),
		pushLayer: () => () => {},
	},
	paths: {
		chat: (id: string) => `/chat/${id}`,
		files: (id: string) => `/sessions/${id}/files`,
		git: (id: string) => `/sessions/${id}/git`,
		sidechat: (id: string) => `/sessions/${id}/sidechat`,
		terminal: (id: string) => `/sessions/${id}/terminal`,
		services: (id: string) => `/sessions/${id}/services`,
	},
}));

vi.mock("../../core/sse", () => ({
	events: {
		subscribe: () => () => {},
	},
	setEventsProbe: vi.fn(),
}));

const apiMock = vi.mocked(api);

describe("mobile UI overhaul behaviors", () => {
	beforeEach(() => {
		localStorage.clear();
		useSessions.setState({
			list: [
				{
					id: "s1",
					title: "主会话",
					cwd: "/Users/dev/Vecway",
					mode: "code",
					model: "openai/gpt-5",
					thinking: "medium",
					status: "idle",
					updatedAt: Date.now(),
					unread: false,
				} as any,
			],
			byId: {
				s1: {
					id: "s1",
					title: "主会话",
					cwd: "/Users/dev/Vecway",
					mode: "code",
					model: "openai/gpt-5",
					thinking: "medium",
					status: "idle",
					updatedAt: Date.now(),
					unread: false,
				} as any,
			},
		});
		useRightDrawer.setState({
			open: false,
			sessionId: null,
			tabBySession: {},
			visitedBySession: {},
			tabHeaders: {},
			pendingMain: null,
			pendingSidechat: null,
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders PlanSheet with always-visible TOC, zero status text badge, and split execution model + thinking picker", async () => {
		apiMock.mockImplementation(async (method, url) => {
			if (method === "GET" && url === "/sessions/s1/models") {
				return {
					models: [
						{
							provider: "anthropic",
							id: "claude-opus-4-5",
							name: "Claude Opus 4.5",
							contextWindow: 200_000,
							thinking: ["off", "low", "medium", "high"],
						},
						{ provider: "openai", id: "gpt-5", name: "GPT-5", contextWindow: 128_000, thinking: ["low", "medium", "high"] },
					],
					current: { provider: "openai", id: "gpt-5" },
					thinkingLevel: "medium",
					liveThinking: ["off", "low", "medium", "high"],
				};
			}
			if (method === "GET" && url === "/left/providers") {
				return { providers: [{ id: "anthropic", enabled: true, key: { kind: "plaintext" } }] };
			}
			return {};
		});

		const onApprove = vi.fn();
		render(
			<PlanSheet
				open
				status="review"
				title="移动端界面整改计划"
				text={"# 移动端界面整改计划\n\n## 第一阶段\n\n- [ ] 完成测试\n\n## 第二阶段\n\n- [x] 验证构建"}
				sessionId="s1"
				planStatus={{
					enabled: true,
					phase: "review",
					version: 2,
					planFile: "/Users/dev/Vecway/.omp/plan.md",
					planUrl: null,
					title: "移动端界面整改计划",
					content: null,
					prevContent: null,
					planModel: null,
					contextPercent: null,
					keepDisabled: false,
					tiers: [
						{ role: "architect", spec: "anthropic/claude-opus-4-5" },
						{ role: "fast", spec: "openai/gpt-5-mini" },
					],
					defaultRole: "architect",
				}}
				canFresh
				onClose={() => {}}
				onApprove={onApprove}
			/>,
		);

		// Always-visible TOC button without redundant status chip/text
		expect(await screen.findByRole("button", { name: /目录 · \d+ 章节/ })).toBeTruthy();
		expect(screen.queryByText(/待确认/)).toBeNull();
		expect(screen.queryByText(/第 2 版/)).toBeNull();

		// SelectRow for execution mode
		fireEvent.click(screen.getByRole("button", { name: /执行方式/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "压缩上下文执行" }));

		// Split execution model picker -> select custom model -> adjust ThinkingLevelPopover
		fireEvent.click(screen.getByRole("button", { name: /选择执行模型/ }));
		const modalSearch = await screen.findByRole("searchbox", { name: "搜索模型" });
		expect(modalSearch).toBeTruthy();
		const panel = screen.getByRole("tabpanel");
		await waitFor(() => expect(within(panel).getByRole("button", { name: /claude-opus-4-5/ })).toBeTruthy());
		fireEvent.click(within(panel).getByRole("button", { name: /claude-opus-4-5/ }));

		const thinkBtn = await screen.findByRole("button", { name: /执行思考强度/ });
		fireEvent.click(thinkBtn);
		const levelToggle = await screen.findByRole("button", { name: "Auto" });
		fireEvent.click(levelToggle);
		fireEvent.click(screen.getByRole("option", { name: /High/ }));

		fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
		expect(onApprove).toHaveBeenCalledWith({
			mode: "compact",
			role: "anthropic/claude-opus-4-5:high",
		});
	});

	it("renders FilesPage with header TitleSwitcher, search toggle, and slim uncommitted strip inside RightWorkspaceDrawer", async () => {
		apiMock.mockImplementation(async (_method, url) => {
			if (String(url).startsWith("/sessions/s1/files")) {
				return {
					path: "/Users/dev/Vecway/src-mobile",
					parent: "/Users/dev/Vecway",
					roots: ["/Users/dev/Vecway"],
					entries: [
						{ name: "ui", path: "/Users/dev/Vecway/src-mobile/ui", kind: "dir", size: 0 },
						{ name: "main.tsx", path: "/Users/dev/Vecway/src-mobile/main.tsx", kind: "file", size: 420 },
					],
				};
			}
			if (url === "/sessions/s1/git/status") {
				return {
					isRepo: true,
					branch: "main",
					files: [
						{ path: "a.ts", status: "M", staged: false, unstaged: true },
						{ path: "b.ts", status: "??", staged: false, unstaged: true },
					],
				};
			}
			return {};
		});

		useRightDrawer.getState().openDrawer("s1", "files");
		render(<RightWorkspaceDrawer sessionId="s1" />);

		// Ancestor TitleSwitcher in header + search box hidden until toggled
		const dirSwitcher = await screen.findByRole("button", { name: "切换目录层级" });
		expect(dirSwitcher).toBeTruthy();
		expect(screen.queryByRole("searchbox", { name: "在当前目录中查找" })).toBeNull();

		// Slim uncommitted bar routes directly to Git tab
		const uncommittedBar = await screen.findByRole("button", { name: /2 个文件还没提交/ });
		fireEvent.click(screen.getByRole("button", { name: "搜索文件" }));
		expect(screen.getByRole("searchbox", { name: "在当前目录中查找" })).toBeTruthy();

		fireEvent.click(uncommittedBar);
		expect(useRightDrawer.getState().tabBySession.s1).toBe("git");
	});

	it("hydrates GitPanel worktree section from /left/sessions and opens worktree sessions sheet", async () => {
		apiMock.mockImplementation(async (_method, url) => {
			if (url === "/sessions/s1/git/status") {
				return { isRepo: true, branch: "main", files: [] };
			}
			if (String(url).startsWith("/sessions/s1/git/log")) {
				return { commits: [] };
			}
			if (String(url).startsWith("/left/sessions")) {
				return {
					workspaceGroups: [
						{
							workspace: { id: "ws1", name: "Vecway", path: "/Users/dev/Vecway" },
							subgroups: [
								{
									key: "main",
									kind: "worktree",
									label: "main",
									path: "/Users/dev/Vecway",
									createCwd: "/Users/dev/Vecway",
									isMain: true,
									totalCount: 2,
									sessions: [{ id: "s1", title: "主会话", updatedAt: 1000 }],
								},
								{
									key: "wt-feat",
									kind: "worktree",
									label: "omp/mobile-polish",
									path: "/Users/dev/Vecway/.worktrees/mobile-polish",
									createCwd: "/Users/dev/Vecway/.worktrees/mobile-polish",
									isMain: false,
									totalCount: 1,
									sessions: [{ id: "s2", title: "样式调整", updatedAt: 2000 }],
								},
							],
						},
					],
				};
			}
			return {};
		});

		render(<GitPanel sessionId="s1" embedded />);

		// Tap top worktree capsule to jump directly to topology tab
		fireEvent.click(await screen.findByRole("button", { name: /2 个工作树/ }));
		expect(await screen.findByText("工作树 · 2")).toBeTruthy();
		expect(screen.getByText("主目录")).toBeTruthy();
		expect(screen.getByText("当前")).toBeTruthy();

		const wtRow = screen.getByRole("button", { name: /omp\/mobile-polish/ });
		fireEvent.click(wtRow);
		expect(await screen.findByRole("button", { name: /样式调整/ })).toBeTruthy();
	});

	it("PlanSheet toggles data-dragging CSS class without mutating inline style.transition", () => {
		Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => {} });
		Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: () => {} });
		Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => true });

		render(
			<PlanSheet
				open
				status="review"
				title="测试方案"
				text={"# 测试方案\n## 步骤\n内容"}
				sessionId="s1"
				onClose={() => {}}
			/>,
		);
		const dialog = screen.getByRole("dialog", { name: "测试方案" });
		expect(dialog.className).toContain("m-plan-sheet-surface");
		expect(dialog.style.transition).toBe("");

		const heading = screen.getAllByRole("heading", { name: "测试方案" })[0];
		fireEvent.pointerDown(heading, { pointerId: 1, clientX: 100, clientY: 50 });
		expect(dialog.dataset.dragging).toBe("true");
		expect(dialog.style.transition).toBe("");

		fireEvent.pointerUp(heading, { pointerId: 1, clientX: 100, clientY: 60 });
		expect(dialog.dataset.dragging).toBeUndefined();
		expect(dialog.style.transition).toBe("");
	});
});

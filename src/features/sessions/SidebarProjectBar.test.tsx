// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta, Workspace } from "../../lib/contracts";
import * as ipc from "../../lib/ipc";
import { emitPromptSend } from "../../stores/promptSendEvents";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { useWorktrees } from "../../stores/worktrees";
import { useSettings } from "../settings/store";
import { SessionSidebar } from "./SessionSidebar";
import { DISPLAY_PREFS_KEY, useSidebarStore } from "./sidebarStore";

const mockOpenDialog = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(() => Promise.reject(new Error("no tauri"))),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: (...args: unknown[]) => mockOpenDialog(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	revealItemInDir: vi.fn(),
}));

const WS_ALPHA: Workspace = {
	id: "ws-alpha",
	path: "/Users/alice/projects/alpha",
	name: "alpha",
	kind: "project",
	sort: 1,
	mode: "code",
};

const WS_EMPTY: Workspace = {
	id: "ws-empty",
	path: "/Users/alice/projects/empty-proj",
	name: "empty-proj",
	kind: "project",
	sort: 0,
	mode: "code",
};

function makeSession(overrides: Partial<SessionMeta>): SessionMeta {
	return {
		id: "s-default",
		tool: "omp",
		file: "/tmp/s.jsonl",
		cwd: "/Users/alice/projects/alpha",
		title: "Alpha Session",
		label: "#1",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
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
		workspaceId: "ws-alpha",
		repoRoot: "/Users/alice/projects/alpha",
		git: { branch: "main", dirty: 0, worktree: null },
		result: null,
		lastAssistant: null,
		model: null,
		attention: null,
		mode: "code",
		groupId: null,
		...overrides,
	};
}

describe("Fixed project bar, Display Options menu, and slim AddProjectPopover", () => {
	beforeEach(() => {
		mockOpenDialog.mockReset();
		try {
			localStorage.removeItem(DISPLAY_PREFS_KEY);
		} catch {
			/* ignore */
		}
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		vi.spyOn(ipc, "listSessionGroups").mockResolvedValue([]);
		vi.spyOn(ipc, "gitListWorktrees").mockResolvedValue([]);
		vi.spyOn(ipc, "sessionSnapshot").mockResolvedValue({ thinkingLevel: null, contextTokens: null });
		vi.spyOn(ipc, "sessionUsage").mockResolvedValue({
			available: false,
			tokens: null,
			cost: null,
			source: "transcript",
		});

		useSidebarStore.setState({
			activeMode: "code",
			groupOpen: { __unassigned: false, __deleted: false, "ws-alpha": true, "ws-empty": true },
			showArchived: false,
			groupBy: "worktree",
			sessionSort: "updated",
			projectSort: "custom",
			autoPin: false,
			archivedOnly: false,
			showUnassigned: true,
			filterQuery: "",
			statusFilter: "all",
			timeFilter: "all",
			hideEmptyProjects: false,
			expandedSections: {},
			creatingKey: null,
		});
		useSettings.setState({
			settings: {
				sessionGroupByWorktree: true,
			} as never,
		});
		useWorktrees.setState({ byWorkspace: {}, refresh: vi.fn().mockResolvedValue(undefined) });
		useUi.setState({ selectedSessionId: null, highlightId: null, centerView: "session" });
		useSessions.setState({
			hasLoaded: true,
			loadError: null,
			load: vi.fn().mockResolvedValue(undefined),
			workspaces: [WS_ALPHA, WS_EMPTY],
			sessions: {
				"s-alpha": makeSession({
					id: "s-alpha",
					title: "Fix auth race",
					status: "working",
					workspaceId: "ws-alpha",
				}),
				"s-idle": makeSession({
					id: "s-idle",
					title: "Idle cleanup",
					status: "idle",
					workspaceId: "ws-alpha",
				}),
				"s-archived": makeSession({
					id: "s-archived",
					title: "Archived note",
					archived: true,
					workspaceId: "ws-alpha",
				}),
				"s-unassigned": makeSession({
					id: "s-unassigned",
					title: "Unassigned scratch",
					cwd: "/Users/alice/labs/scratch-tool",
					repoRoot: "/Users/alice/labs/scratch-tool",
					workspaceId: null,
				}),
			},
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("renders capsule-free fixed project bar outside scrollable list, collapses projects on click, and hides in chat mode", () => {
		const { container } = render(<SessionSidebar />);

		const bar = screen.getByTestId("fixed-project-bar");
		const scroller = container.querySelector('[data-sidebar-list="true"]');
		expect(bar).toBeTruthy();
		expect(scroller).toBeTruthy();
		expect(scroller?.contains(bar)).toBe(false);
		expect(bar.querySelector(".rounded-full")).toBeNull();
		expect(bar.className).not.toContain("border-b");

		const projectsToggle = screen.getByRole("button", { name: "项目" });
		expect(projectsToggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("alpha")).toBeTruthy();

		fireEvent.click(projectsToggle);
		expect(projectsToggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("alpha")).toBeNull();

		fireEvent.click(projectsToggle);
		expect(projectsToggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("alpha")).toBeTruthy();

		act(() => {
			useSidebarStore.getState().setActiveMode("chat");
		});
		expect(screen.queryByTestId("fixed-project-bar")).toBeNull();
	});

	it("renders Antigravity Display Options menu with submenus, sort, archived-only, auto-pin, and mark-all-read", async () => {
		const markSeenSpy = vi.spyOn(ipc, "markSeen").mockResolvedValue(undefined);
		const updateMetaSpy = vi.spyOn(ipc, "updateSessionMeta").mockResolvedValue(null as never);

		render(<SessionSidebar />);
		expect(screen.getByText("alpha")).toBeTruthy();
		expect(screen.getByText("empty-proj")).toBeTruthy();

		// Initial project order is custom (ws-empty sort=0 before ws-alpha sort=1)
		const emptyNode = screen.getByText("empty-proj");
		const alphaNode = screen.getByText("alpha");
		expect(emptyNode.compareDocumentPosition(alphaNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "显示选项" }));
		const menu = screen.getByRole("menu", { name: "显示选项" });
		expect(menu).toBeTruthy();
		expect(menu.querySelector(".rounded-full")).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();

		// Exact 8 top-level rows matching Antigravity
		const topItems = menu.querySelectorAll('[role^="menuitem"]');
		expect(topItems.length).toBe(8);
		expect(screen.getByRole("menuitem", { name: /分组方式/ })).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: /会话排序/ })).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: /项目排序/ })).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: /筛选/ })).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: /显示/ })).toBeTruthy();
		expect(screen.getByRole("menuitemcheckbox", { name: "发送时自动置顶" })).toBeTruthy();
		expect(screen.getByRole("menuitemcheckbox", { name: "仅看已归档" })).toBeTruthy();

		// Mark All as Read disabled when 0 unread
		const markAllDisabled = screen.getByRole("menuitem", { name: "全部标为已读" }) as HTMLButtonElement;
		expect(markAllDisabled.disabled).toBe(true);

		// Submenu: 项目排序 -> 项目名称 reorders alpha before empty-proj
		fireEvent.click(screen.getByRole("menuitem", { name: /项目排序/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "项目名称" }));
		expect(
			screen.getByText("alpha").compareDocumentPosition(screen.getByText("empty-proj")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		// Submenu: 显示 -> 隐藏无会话项目 hides empty-proj
		fireEvent.click(screen.getByRole("menuitem", { name: /^显示$/ }));
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "隐藏无会话项目" }));
		expect(screen.queryByText("empty-proj")).toBeNull();
		expect(screen.getByText("alpha")).toBeTruthy();

		// Submenu: 筛选 -> 运行中 filters to working session, then 清除筛选 restores
		fireEvent.click(screen.getByRole("menuitem", { name: /^筛选/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "运行中" }));
		expect(screen.getByText("Fix auth race")).toBeTruthy();
		expect(screen.queryByText("Idle cleanup")).toBeNull();
		fireEvent.click(screen.getByRole("menuitem", { name: "清除筛选" }));
		expect(screen.getByText("empty-proj")).toBeTruthy();
		expect(screen.getByText("Idle cleanup")).toBeTruthy();

		// Root toggle: 仅看已归档
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "仅看已归档" }));
		expect(screen.getByRole("button", { name: "项目 (已归档)" })).toBeTruthy();
		expect(screen.getByText("Archived note")).toBeTruthy();
		expect(screen.queryByText("Fix auth race")).toBeNull();
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "仅看已归档" }));
		expect(screen.getByRole("button", { name: "项目" })).toBeTruthy();

		// Root toggle: 发送时自动置顶 triggers on sent prompt event
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "发送时自动置顶" }));
		act(() => {
			emitPromptSend("sent", "s-alpha", "hello");
		});
		expect(updateMetaSpy).toHaveBeenCalledWith("s-alpha", { pinned: true });
		expect(useSessions.getState().sessions["s-alpha"].pinned).toBe(true);

		// Enable 全部标为已读 when unread sessions exist
		act(() => {
			useSessions.getState().upsert([
				{ ...useSessions.getState().sessions["s-idle"], unread: true },
			]);
		});
		const markAllBtn = screen.getByRole("menuitem", { name: "全部标为已读" }) as HTMLButtonElement;
		expect(markAllBtn.disabled).toBe(false);
		fireEvent.click(markAllBtn);
		expect(markSeenSpy).toHaveBeenCalledWith("s-idle");
		expect(useSessions.getState().sessions["s-idle"].unread).toBe(false);
	});

	it("opens AddProjectPopover with Open/Create and Clone actions only and triggers folder picker", async () => {
		mockOpenDialog.mockResolvedValue(null);
		render(<SessionSidebar />);
		fireEvent.click(screen.getByRole("button", { name: "添加项目目录" }));

		const menu = screen.getByRole("menu", { name: "添加项目目录" });
		expect(menu.querySelector(".rounded-full")).toBeNull();
		const items = screen.getAllByRole("menuitem");
		expect(items.length).toBe(2);
		const openOrCreateItem = screen.getByRole("menuitem", { name: "打开或新建文件夹" });
		expect(openOrCreateItem).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: "从 Git 地址克隆" })).toBeTruthy();
		expect(screen.queryByText("新建项目文件夹")).toBeNull();
		expect(screen.queryByText("快速归入活跃目录")).toBeNull();

		fireEvent.click(openOrCreateItem);
		await waitFor(() => {
			expect(mockOpenDialog).toHaveBeenCalledWith({
				directory: true,
				multiple: false,
				title: "选择要添加的工作区目录",
			});
		});
	});

	it("supports CloneRepoModal flow", async () => {
		const cloneSpy = vi
			.spyOn(ipc, "gitCloneRepo")
			.mockResolvedValue("/Users/alice/Documents/repo-x");
		const addSpy = vi.spyOn(ipc, "addWorkspace").mockImplementation(async (path) => ({
			id: `ws-${path}`,
			path,
			name: path.split("/").pop() ?? path,
			kind: "project",
			sort: 3,
			mode: "code",
		}));

		render(<SessionSidebar />);

		fireEvent.click(screen.getByRole("button", { name: "添加项目目录" }));
		fireEvent.click(screen.getByText("从 Git 地址克隆"));

		const urlInput = screen.getByPlaceholderText("https://github.com/owner/repo.git 或 git@...");
		fireEvent.change(urlInput, { target: { value: "https://github.com/org/repo-x.git" } });
		const cloneParentInput = screen.getByPlaceholderText("例如 ~/Documents/projects");
		fireEvent.change(cloneParentInput, { target: { value: "/Users/alice/Documents" } });
		const folderOptionalInput = screen.getByPlaceholderText(
			"留空则自动从仓库地址推断",
		) as HTMLInputElement;
		expect(folderOptionalInput.value).toBe("repo-x");

		fireEvent.click(screen.getByRole("button", { name: "克隆并添加" }));
		await waitFor(() => {
			expect(cloneSpy).toHaveBeenCalledWith(
				"https://github.com/org/repo-x.git",
				"/Users/alice/Documents",
				"repo-x",
			);
			expect(addSpy).toHaveBeenCalledWith("/Users/alice/Documents/repo-x", "code");
		});
	});
});

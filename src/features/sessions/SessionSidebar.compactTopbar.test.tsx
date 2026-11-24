// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { tNow } from "../../stores/language";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { useWorktrees } from "../../stores/worktrees";
import { useSettings } from "../settings/store";
import { SessionSidebar } from "./SessionSidebar";
import { useSidebarStore } from "./sidebarStore";

const trafficLightsMock = vi.hoisted(() => ({ visible: true }));

vi.mock("../../lib/trafficLights", () => ({
	useTrafficLightsVisible: () => trafficLightsMock.visible,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(() => Promise.reject(new Error("no tauri"))),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	revealItemInDir: vi.fn(),
}));

let resizeObservers: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }> = [];
let mockAsideWidth = 260;

function triggerResize(el: HTMLElement, nextWidth: number) {
	mockAsideWidth = nextWidth;
	act(() => {
		for (const inst of resizeObservers) {
			if (inst.targets.has(el)) {
				inst.cb([], {} as ResizeObserver);
			}
		}
	});
}

function getTopbarRows(container: HTMLElement): HTMLElement[] {
	const aside = container.querySelector("aside");
	if (!aside) return [];
	return Array.from(aside.children).filter(
		(child): child is HTMLElement =>
			child instanceof HTMLElement && child.hasAttribute("data-tauri-drag-region"),
	);
}

describe("SessionSidebar compact topbar", () => {
	beforeEach(() => {
		trafficLightsMock.visible = true;
		resizeObservers = [];
		mockAsideWidth = 260;

		vi.stubGlobal(
			"ResizeObserver",
			class {
				private entry: { cb: ResizeObserverCallback; targets: Set<Element> };
				constructor(cb: ResizeObserverCallback) {
					this.entry = { cb, targets: new Set() };
					resizeObservers.push(this.entry);
				}
				observe(target: Element) {
					this.entry.targets.add(target);
				}
				unobserve(target: Element) {
					this.entry.targets.delete(target);
				}
				disconnect() {
					this.entry.targets.clear();
				}
			},
		);

		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
			return this.tagName === "ASIDE" ? mockAsideWidth : 0;
		});

		vi.spyOn(ipc, "listSessionGroups").mockResolvedValue([]);
		vi.spyOn(ipc, "listSchedules").mockResolvedValue([]);
		vi.spyOn(ipc, "gitListWorktrees").mockResolvedValue([]);
		vi.spyOn(ipc, "sessionSnapshot").mockResolvedValue({ thinkingLevel: null, contextTokens: null });
		vi.spyOn(ipc, "sessionUsage").mockResolvedValue({
			available: false,
			tokens: null,
			cost: null,
			source: "transcript",
		});

		useSidebarStore.setState({
			activeMode: "research",
			groupOpen: { __unassigned: false, __deleted: false },
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
		useSettings.setState({ settings: { sessionGroupByWorktree: true } as never });
		useWorktrees.setState({ byWorkspace: {}, refresh: vi.fn().mockResolvedValue(undefined) });
		useUi.setState({
			selectedSessionId: null,
			highlightId: null,
			centerView: "session",
			sidebarWidth: 260,
		});
		useSessions.setState({
			hasLoaded: true,
			loadError: null,
			load: vi.fn().mockResolvedValue(undefined),
			workspaces: [],
			sessions: {},
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("only queries projects in the visible mode, including after focus refresh changes the list", async () => {
		const code = { id: "code", name: "Code", path: "/code", kind: "project", mode: "code", sort: 0 } as const;
		const research = { ...code, id: "research", path: "/research", mode: "research" } as const;
		const global = { ...research, id: "global", kind: "global" } as const;
		useSessions.setState({ workspaces: [code, research, global] });
		const refresh = vi.mocked(useWorktrees.getState().refresh);
		render(<SessionSidebar />);
		expect(refresh.mock.calls).toEqual([[[research]]]);
		act(() => useSidebarStore.setState({ activeMode: "code" }));
		expect(refresh).toHaveBeenLastCalledWith([code]);
		const moved = { ...code, path: "/moved" };
		vi.spyOn(ipc, "listWorkspaces").mockResolvedValue([moved, research, global]);
		refresh.mockClear();
		await act(async () => { window.dispatchEvent(new Event("focus")); });
		expect(refresh.mock.calls).toEqual([[[moved]]]);
	});

	it("keeps inbox and search in row 2 when wide with macOS traffic lights, and moves them into row 1 when narrow (<236px) without duplicating buttons", () => {
		const inboxLabel = tNow("sidebar.inbox");
		const searchLabel = tNow("common.search");
		const collapseTitle = tNow("sidebar.collapseSidebar", { shortcut: "⌘B" });

		mockAsideWidth = 260;
		const { container } = render(<SessionSidebar />);
		const aside = container.querySelector("aside")!;

		// Wide (>= 236px): row 1 has collapse only; row 2 has mode switcher + inbox + search.
		let rows = getTopbarRows(container);
		expect(rows).toHaveLength(2);
		expect(within(rows[0]).getByTitle(collapseTitle)).toBeTruthy();
		expect(within(rows[0]).queryByRole("button", { name: inboxLabel })).toBeNull();
		expect(within(rows[0]).queryByRole("button", { name: searchLabel })).toBeNull();
		expect(within(rows[1]).getByRole("button", { name: /Research/ })).toBeTruthy();
		expect(within(rows[1]).getByRole("button", { name: inboxLabel })).toBeTruthy();
		expect(within(rows[1]).getByRole("button", { name: searchLabel })).toBeTruthy();
		expect(screen.getAllByRole("button", { name: inboxLabel })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: searchLabel })).toHaveLength(1);

		// Narrow (235px < 236px): inbox & search move into row 1 next to collapse; row 2 gives full width to mode switcher.
		triggerResize(aside, 235);
		rows = getTopbarRows(container);
		expect(rows).toHaveLength(2);
		expect(within(rows[0]).getByRole("button", { name: inboxLabel })).toBeTruthy();
		expect(within(rows[0]).getByRole("button", { name: searchLabel })).toBeTruthy();
		expect(within(rows[0]).getByTitle(collapseTitle)).toBeTruthy();
		expect(within(rows[1]).getByRole("button", { name: /Research/ })).toBeTruthy();
		expect(within(rows[1]).queryByRole("button", { name: inboxLabel })).toBeNull();
		expect(within(rows[1]).queryByRole("button", { name: searchLabel })).toBeNull();
		expect(screen.getAllByRole("button", { name: inboxLabel })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: searchLabel })).toHaveLength(1);

		// Growing back to 236px restores inbox & search to row 2.
		triggerResize(aside, 236);
		rows = getTopbarRows(container);
		expect(rows).toHaveLength(2);
		expect(within(rows[0]).queryByRole("button", { name: inboxLabel })).toBeNull();
		expect(within(rows[0]).queryByRole("button", { name: searchLabel })).toBeNull();
		expect(within(rows[1]).getByRole("button", { name: inboxLabel })).toBeTruthy();
		expect(within(rows[1]).getByRole("button", { name: searchLabel })).toBeTruthy();
		expect(screen.getAllByRole("button", { name: inboxLabel })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: searchLabel })).toHaveLength(1);
	});

	it("uses one row when wide without traffic lights (>=256px) and splits to two rows with inbox/search in row 1 when narrow (<256px)", () => {
		trafficLightsMock.visible = false;
		const inboxLabel = tNow("sidebar.inbox");
		const searchLabel = tNow("common.search");
		const collapseTitle = tNow("sidebar.collapseSidebar", { shortcut: "⌘B" });

		mockAsideWidth = 260;
		const { container } = render(<SessionSidebar />);
		const aside = container.querySelector("aside")!;

		// Wide (>= 256px) without traffic lights: single topbar row holds mode switcher, inbox, search, collapse.
		let rows = getTopbarRows(container);
		expect(rows).toHaveLength(1);
		expect(within(rows[0]).getByRole("button", { name: /Research/ })).toBeTruthy();
		expect(within(rows[0]).getByRole("button", { name: inboxLabel })).toBeTruthy();
		expect(within(rows[0]).getByRole("button", { name: searchLabel })).toBeTruthy();
		expect(within(rows[0]).getByTitle(collapseTitle)).toBeTruthy();
		expect(screen.getAllByRole("button", { name: inboxLabel })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: searchLabel })).toHaveLength(1);

		// Narrow (255px < 256px): splits into two rows with inbox & search in row 1 and mode switcher alone in row 2.
		triggerResize(aside, 255);
		rows = getTopbarRows(container);
		expect(rows).toHaveLength(2);
		expect(within(rows[0]).getByRole("button", { name: inboxLabel })).toBeTruthy();
		expect(within(rows[0]).getByRole("button", { name: searchLabel })).toBeTruthy();
		expect(within(rows[0]).getByTitle(collapseTitle)).toBeTruthy();
		expect(within(rows[1]).getByRole("button", { name: /Research/ })).toBeTruthy();
		expect(within(rows[1]).queryByRole("button", { name: inboxLabel })).toBeNull();
		expect(within(rows[1]).queryByRole("button", { name: searchLabel })).toBeNull();
		expect(screen.getAllByRole("button", { name: inboxLabel })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: searchLabel })).toHaveLength(1);
	});
});

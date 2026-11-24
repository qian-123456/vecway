// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta, Workspace } from "./lib/contracts";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd.startsWith("list_") || cmd.endsWith("_list") || cmd.endsWith("_turns")) return [];
		return null;
	}),
	convertFileSrc: (path: string) => path,
	Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		hide: vi.fn(),
		onFocusChanged: async () => () => {},
		onResized: async () => () => {},
		isFullscreen: async () => false,
		setTitle: async () => {},
		label: "main",
	}),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("./features/settings/useStartupImageGc", () => ({ useStartupImageGc() {} }));
vi.mock("./features/heatmap/doctorStore", () => ({ useDoctorAutoScheduler() {} }));
vi.mock("./features/todos/store", () => ({ startTodos() {} }));
vi.mock("./stores/ompUpdate", () => ({
	useOmpUpdate: { getState: () => ({ checkOnStartup: async () => {} }) },
	watchOmpUpdateChecks: () => () => {},
	watchOmpStaleness: () => () => {},
}));
vi.mock("./stores/appUpdate", () => ({
	useAppUpdate: { getState: () => ({ checkOnStartup: async () => {} }) },
	watchAppUpdateChecks: () => () => {},
}));
vi.mock("./stores/ompInstall", () => ({ useOmpInstall: { getState: () => ({ checkOnStartup: async () => {} }) } }));
vi.mock("./features/omp-install/OmpInstallDialog", () => ({ OmpInstallDialog: () => null }));
vi.mock("./lib/nativeShortcuts", () => ({ installNativeShortcuts: () => () => {} }));
vi.mock("./features/shortcuts/dispatcher", () => ({ installShortcutDispatcher: () => () => {} }));
vi.mock("./features/sessions/SessionSidebar", () => ({ SessionSidebar: () => <div data-testid="sidebar" /> }));
vi.mock("./features/chat/SessionView", () => ({ SessionView: () => <div /> }));
vi.mock("./features/chat/Composer", () => ({ Composer: () => <div /> }));
vi.mock("./features/sessions/ForkDraftView", () => ({ ForkDraftView: () => null }));
vi.mock("./features/home/StartPage", () => ({ StartPage: () => null }));
vi.mock("./features/inbox/InboxPage", () => ({ InboxPage: () => null }));
vi.mock("./features/settings/SettingsOverlay", () => ({ SettingsOverlay: () => null }));
vi.mock("./components/CenterHeader", () => ({
	CenterHeader: () => null,
	CENTER_WITHOUT_RIGHT_PANEL: new Set(["inbox", "schedules", "skills"]),
}));
vi.mock("./components/BottomBar", () => ({ BottomBar: () => null }));
vi.mock("./components/RightAside", () => ({
	RightAside: ({ width }: { width: number }) => (
		<div data-testid="right-aside" style={{ width }} />
	),
}));
vi.mock("./features/backlog/QuickCapture", () => ({ QuickCapture: () => null }));
vi.mock("./features/sidechat/HandbackDialog", () => ({ HandbackDialog: () => null }));
vi.mock("./features/diagnose/DiagnoseDialog", () => ({ DiagnoseDialog: () => null }));
vi.mock("./features/chat/share/ShareImageDialog", () => ({ ShareImageDialog: () => null }));
vi.mock("./features/git/NewSessionDialog", () => ({ NewSessionDialog: () => null }));
vi.mock("./features/sessions/ResumeMissingCwdDialog", () => ({ ResumeMissingCwdDialog: () => null }));
vi.mock("./features/sessions/ResumeMissingModelDialog", () => ({ ResumeMissingModelDialog: () => null }));

import App from "./App";
import { computeShellWidths } from "./lib/shellWidths";
import { useSessions } from "./stores/sessions";
import { useUi } from "./stores/ui";

describe("App splitter drag behavior (M10 / M17)", () => {
	beforeEach(() => {
		localStorage.clear();
		Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1000 });
		useSessions.setState({
			sessions: {} as Record<string, SessionMeta>,
			workspaces: [] as Workspace[],
			hasLoaded: false,
			loadError: null,
		});
		useUi.setState({
			centerView: "home",
			previousCenterView: null,
			selectedSessionId: null,
			lastSessionId: null,
			sidebarOpen: true,
			sidebarWidth: 400,
			rightOpen: true,
			rightWidth: 400,
			rightMaximized: false,
			modal: null,
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("starts drag preview from stored preferences in constrained windows without jumping, ignores pure Y moves, and restores uncommitted preview on cancel", () => {
		const rafQueue: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
			rafQueue.push(cb);
			return rafQueue.length;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

		render(<App />);
		const leftSep = screen.getByRole("separator", { name: /左栏/ });
		const leftPane = leftSep.previousElementSibling as HTMLElement;
		const initialWidths = computeShellWidths({
			viewportWidth: 1000,
			sidebarOpen: true,
			sidebarWidth: 400,
			rightVisible: true,
			rightWidth: 400,
		});
		expect(leftPane.style.width).toBe(`${initialWidths.leftWidth}px`);

		// Start drag at clientX=320, clientY=200
		fireEvent.pointerDown(leftSep, { button: 0, pointerId: 7, clientX: 320, clientY: 200 });

		// Pure vertical movement (dx = 0, dy = 40) must NOT mark moved or schedule rAF preview
		const verticalMove = new Event("pointermove") as PointerEvent;
		Object.defineProperty(verticalMove, "pointerId", { value: 7 });
		Object.defineProperty(verticalMove, "clientX", { value: 320 });
		Object.defineProperty(verticalMove, "clientY", { value: 240 });
		act(() => {
			window.dispatchEvent(verticalMove);
		});
		expect(rafQueue).toHaveLength(0);

		// Releasing after pure vertical movement must not change stored preference or rendered width
		const upAfterY = new Event("pointerup") as PointerEvent;
		Object.defineProperty(upAfterY, "pointerId", { value: 7 });
		act(() => {
			window.dispatchEvent(upAfterY);
		});
		expect(useUi.getState().sidebarWidth).toBe(400);
		expect(leftPane.style.width).toBe(`${initialWidths.leftWidth}px`);

		// New drag with small positive horizontal move (+4px from 320 -> 324) in constrained window:
		// Preview must start from stored pref 400 (+4 => 404), NEVER jump down to constrained ~288!
		fireEvent.pointerDown(leftSep, { button: 0, pointerId: 8, clientX: 320, clientY: 200 });
		const horizMove = new Event("pointermove") as PointerEvent;
		Object.defineProperty(horizMove, "pointerId", { value: 8 });
		Object.defineProperty(horizMove, "clientX", { value: 324 });
		Object.defineProperty(horizMove, "clientY", { value: 200 });
		act(() => {
			window.dispatchEvent(horizMove);
			const cb = rafQueue.shift();
			cb?.(16);
		});
		const expectedPreview = computeShellWidths({
			viewportWidth: 1000,
			sidebarOpen: true,
			sidebarWidth: 404,
			rightVisible: true,
			rightWidth: 400,
		});
		expect(leftPane.style.width).toBe(`${expectedPreview.leftWidth}px`);
		expect(expectedPreview.leftWidth).toBeGreaterThanOrEqual(initialWidths.leftWidth);

		// Escape cancels without committing -> restores exact committed DOM width
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(useUi.getState().sidebarWidth).toBe(400);
		expect(leftPane.style.width).toBe(`${initialWidths.leftWidth}px`);
	});
});

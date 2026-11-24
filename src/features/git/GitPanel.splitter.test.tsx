// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
	gitRepoRoot: vi.fn(async () => "/repo"),
	gitListWorktrees: vi.fn(async () => [
		{ path: "/repo", branch: "main", isMain: true },
		{ path: "/repo-wt", branch: "feat", isMain: false },
	]),
	tmList: vi.fn(async () => []),
	gitSummary: vi.fn(async () => ({ isRepo: true, branch: "main", files: [], dirtyCount: 0 })),
	gitLog: vi.fn(async () => []),
	gitDiff: vi.fn(async () => ""),
}));
vi.mock("./WorktreeSection", () => ({ WorktreeSection: () => <div data-testid="wt-section" /> }));
vi.mock("./ChangesSection", () => ({ ChangesSection: () => null }));
vi.mock("./TimelineSection", () => ({ TimelineSection: () => null }));
vi.mock("./CheckpointsCard", () => ({ CheckpointsCard: () => null }));
vi.mock("./BranchAssetSection", () => ({ BranchAssetSection: () => null }));
vi.mock("./WorktreeHoverCard", () => ({ WorktreeHoverCard: () => null }));
vi.mock("./useAutoRefresh", () => ({
	keepIfEqual: <T,>(_prev: T, next: T) => next,
	useAutoRefresh: () => {},
}));

import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { GitPanel } from "./GitPanel";

describe("GitPanel splitter pointer & Escape cleanup (M18)", () => {
	beforeEach(() => {
		useUi.setState({ selectedSessionId: "s1", centerView: "session", gitListHeight: 220 });
		useSessions.setState({
			sessions: {
				s1: { id: "s1", title: "S1", cwd: "/repo", status: "idle", mode: "code" } as never,
			},
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("ignores foreign pointerIds and removes window Escape listener on lostpointercapture and unmount", async () => {
		const removeSpy = vi.spyOn(window, "removeEventListener");
		const { unmount } = render(<GitPanel />);
		const sep = await screen.findByRole("separator");

		// jsdom lacks PointerEvent constructor / capture methods on HTMLElement
		sep.setPointerCapture = vi.fn();
		sep.hasPointerCapture = vi.fn(() => true);
		sep.releasePointerCapture = vi.fn();
		const split = sep.parentElement as HTMLElement;
		const listEl = split.firstElementChild as HTMLElement;
		split.getBoundingClientRect = () => ({ top: 0, height: 600, bottom: 600, left: 0, right: 300, width: 300, x: 0, y: 0, toJSON: () => ({}) });
		listEl.getBoundingClientRect = () => ({ top: 0, height: 220, bottom: 220, left: 0, right: 300, width: 300, x: 0, y: 0, toJSON: () => ({}) });

		fireEvent.pointerDown(sep, { button: 0, pointerId: 11, clientY: 220 });

		// Foreign pointerId=99 pointerup must not commit or end drag
		const foreignUp = new Event("pointerup") as PointerEvent;
		Object.defineProperty(foreignUp, "pointerId", { value: 99 });
		sep.dispatchEvent(foreignUp);
		expect(sep.releasePointerCapture).not.toHaveBeenCalled();

		// lostpointercapture for captured pointerId=11 must clean up window keydown Escape listener
		const lost = new Event("lostpointercapture") as PointerEvent;
		Object.defineProperty(lost, "pointerId", { value: 11 });
		sep.dispatchEvent(lost);
		await waitFor(() =>
			expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function), true),
		);

		// Start another drag and unmount mid-drag -> unmount cleanup removes window Escape listener
		removeSpy.mockClear();
		fireEvent.pointerDown(sep, { button: 0, pointerId: 22, clientY: 220 });
		unmount();
		expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function), true);
	});
});

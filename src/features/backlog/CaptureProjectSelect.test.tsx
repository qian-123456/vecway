// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../lib/contracts";

vi.mock("../../lib/ipc", () => ({ backlogList: vi.fn(async () => []) }));
vi.mock("../../lib/events", () => ({ onBacklogChanged: vi.fn(async () => () => {}) }));

import { tNow } from "../../stores/language";
import { useSessions } from "../../stores/sessions";
import { useBacklog } from "./backlogStore";
import { CaptureProjectSelect, EditProjectSelect } from "./CaptureProjectSelect";
import { CAPTURE_PROJECT_NONE } from "./ideasLogic";

const vecwayWorkspace: Workspace = {
	id: "ws-vecway",
	name: "Vecway",
	path: "/Users/me/Vecway",
	kind: "project",
	sort: 0,
	mode: "code",
};

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	localStorage.clear();
	useBacklog.setState({ captureProject: null });
	useSessions.setState({ workspaces: [], hasLoaded: false } as never);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("CaptureProjectSelect stale project handling", () => {
	it("auto-resets stale captureProject to null once workspaces load and hides it from the dropdown", async () => {
		useBacklog.getState().setCaptureProject("/Users/me/omp-workspace");
		useSessions.setState({ workspaces: [vecwayWorkspace], hasLoaded: true } as never);

		render(<CaptureProjectSelect currentProject="/Users/me/Vecway" />);

		// Immediately falls back to current session without flashing the stale directory name.
		expect(screen.queryByText("omp-workspace")).toBeNull();
		expect(screen.getByRole("button", { name: tNow("backlog.assignProjectAria", { label: "Vecway" }) })).toBeTruthy();

		await waitFor(() => {
			expect(useBacklog.getState().captureProject).toBeNull();
		});
		expect(localStorage.getItem("ompws:backlog-capture-project")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: tNow("backlog.assignProjectAria", { label: "Vecway" }) }));
		expect(screen.queryByRole("option", { name: "omp-workspace" })).toBeNull();
		expect(screen.getByRole("option", { name: tNow("backlog.followCurrentSession", { name: "Vecway" }) })).toBeTruthy();
		expect(screen.getByRole("option", { name: "Vecway" })).toBeTruthy();
		expect(screen.getByRole("option", { name: tNow("backlog.noProjectAssigned") })).toBeTruthy();
	});

	it("does not prematurely wipe captureProject while hasLoaded is false, then resets once loaded", async () => {
		useBacklog.getState().setCaptureProject("/Users/me/omp-workspace");
		useSessions.setState({ workspaces: [], hasLoaded: false } as never);

		const { rerender } = render(<CaptureProjectSelect currentProject="/Users/me/Vecway" />);

		expect(useBacklog.getState().captureProject).toBe("/Users/me/omp-workspace");
		expect(screen.getByRole("button", { name: tNow("backlog.assignProjectAria", { label: "omp-workspace" }) })).toBeTruthy();

		useSessions.setState({ workspaces: [vecwayWorkspace], hasLoaded: true } as never);
		rerender(<CaptureProjectSelect currentProject="/Users/me/Vecway" />);

		await waitFor(() => {
			expect(useBacklog.getState().captureProject).toBeNull();
		});
		expect(screen.queryByText("omp-workspace")).toBeNull();
	});

	it("keeps CAPTURE_PROJECT_NONE and active workspace selections intact after load", () => {
		useSessions.setState({ workspaces: [vecwayWorkspace], hasLoaded: true } as never);

		useBacklog.getState().setCaptureProject(CAPTURE_PROJECT_NONE);
		const { rerender } = render(<CaptureProjectSelect currentProject="/Users/me/Vecway" />);
		expect(useBacklog.getState().captureProject).toBe(CAPTURE_PROJECT_NONE);
		expect(screen.getByRole("button", { name: tNow("backlog.assignProjectAria", { label: tNow("backlog.noProject") }) })).toBeTruthy();

		useBacklog.getState().setCaptureProject("/Users/me/Vecway");
		rerender(<CaptureProjectSelect currentProject={null} />);
		expect(useBacklog.getState().captureProject).toBe("/Users/me/Vecway");
		expect(screen.getByRole("button", { name: tNow("backlog.assignProjectAria", { label: "Vecway" }) })).toBeTruthy();
	});

	it("persists captureProject and removes it from storage when reset to null", () => {
		useBacklog.getState().setCaptureProject("/Users/me/Vecway");
		expect(localStorage.getItem("ompws:backlog-capture-project")).toBe("/Users/me/Vecway");
		useBacklog.getState().setCaptureProject(null);
		expect(localStorage.getItem("ompws:backlog-capture-project")).toBeNull();
	});
});

describe("EditProjectSelect removed directory support", () => {
	it("shows an existing item's removed directory and lets the user reassign it", () => {
		useSessions.setState({ workspaces: [vecwayWorkspace], hasLoaded: true } as never);

		function Harness() {
			const [dir, setDir] = useState("/Users/me/omp-workspace");
			return <EditProjectSelect value={dir} onChange={setDir} />;
		}

		render(<Harness />);

		const pill = screen.getByRole("button", { name: tNow("backlog.assignProjectAria", { label: "omp-workspace" }) });
		fireEvent.click(pill);

		expect(screen.getByRole("option", { name: "omp-workspace" })).toBeTruthy();
		expect(screen.getByRole("option", { name: "Vecway" })).toBeTruthy();
		expect(screen.getByRole("option", { name: tNow("backlog.noProjectAssigned") })).toBeTruthy();

		fireEvent.click(screen.getByRole("option", { name: "Vecway" }));
		expect(screen.getByRole("button", { name: tNow("backlog.assignProjectAria", { label: "Vecway" }) })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: tNow("backlog.assignProjectAria", { label: "Vecway" }) }));
		fireEvent.click(screen.getByRole("option", { name: tNow("backlog.noProjectAssigned") }));
		expect(screen.getByRole("button", { name: tNow("backlog.assignProjectAria", { label: tNow("backlog.noProject") }) })).toBeTruthy();
	});
});

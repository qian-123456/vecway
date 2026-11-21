// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_OFF, type ApprovedPlan, type PlanStatus } from "../features/chat/plan/planStatus";
import { emptySessionLive, useLive } from "../stores/live";
import { type RightTab, useUi } from "../stores/ui";
import { RightPanelHeader } from "./RightPanelHeader";

const badges: Record<RightTab, number> = {
	explorer: 0, sidechat: 0, heatmap: 0, git: 0, services: 0, terminal: 0, plan: 0, automation: 0, files: 0,
};
const approved: ApprovedPlan = {
	planFile: null, planUrl: null, title: "t", content: "# c", prevContent: null, version: 1, status: "failed", error: "error",
};
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "打开新标签页" }));

describe("RightPanelHeader 计划入口", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});
	beforeEach(() => {
		// jsdom lacks ResizeObserver, which the tab strip measures with.
		vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
		localStorage.clear();
		useUi.getState().selectSession("a");
		useUi.setState({ rightOpen: true, rightTab: "git", openRightTabs: ["git"] });
		useLive.setState({ sessions: {} });
	});

	it.each([
		["unknown", undefined],
		["off", PLAN_OFF],
		["empty review", { ...PLAN_OFF, enabled: true, phase: "review", content: "  " }],
		["planning", { ...PLAN_OFF, enabled: true, content: "# Draft" }],
	] as const)("hides the reopen menu for %s", (_name, plan) => {
		if (plan) useLive.setState({ sessions: { a: { ...emptySessionLive(), plan } } });
		render(<RightPanelHeader activeTab="git" tabBadges={badges} />);
		openMenu();
		expect(screen.queryByRole("button", { name: /计划/ })).toBeNull();
	});

	it("does not borrow another session's plan", () => {
		useLive.setState({ sessions: { b: { ...emptySessionLive(), plan: { ...PLAN_OFF, approved } } } });
		render(<RightPanelHeader activeTab="git" tabBadges={badges} />);
		openMenu();
		expect(screen.queryByRole("button", { name: /计划/ })).toBeNull();
		act(() => useUi.setState({ selectedSessionId: null }));
		expect(screen.queryByRole("button", { name: /计划/ })).toBeNull();
	});

	it("opens 计划 for approved enabled=false state without enabling plan mode", () => {
		useLive.setState({ sessions: { a: { ...emptySessionLive(), plan: { ...PLAN_OFF, approved } } } });
		render(<RightPanelHeader activeTab="git" tabBadges={badges} />);
		openMenu();
		fireEvent.click(screen.getByRole("button", { name: /计划/ }));
		expect(useUi.getState().rightTab).toBe("plan");
		expect(useLive.getState().sessions.a.plan?.enabled).toBe(false);
	});

	it("reopens a meaningful review without changing plan mode", () => {
		const plan: PlanStatus = { ...PLAN_OFF, enabled: true, phase: "review", content: "# Review", version: 2 };
		useLive.setState({ sessions: { a: { ...emptySessionLive(), plan } } });
		render(<RightPanelHeader activeTab="git" tabBadges={badges} />);
		openMenu();
		fireEvent.click(screen.getByRole("button", { name: /计划/ }));
		expect(useUi.getState().rightTab).toBe("plan");
		expect(useLive.getState().sessions.a.plan).toBe(plan);
	});

	it("keeps an unknown persisted plan tab until status is known, then closes without opening the panel", () => {
		useUi.setState({ rightOpen: false, rightTab: "git", openRightTabs: ["git", "plan"] });
		render(<RightPanelHeader activeTab="git" tabBadges={badges} />);
		expect(useUi.getState().openRightTabs).toContain("plan");
		act(() => useLive.setState({ sessions: { a: { ...emptySessionLive(), plan: PLAN_OFF } } }));
		expect(useUi.getState().openRightTabs).toEqual(["git"]);
		expect(useUi.getState().rightTab).toBe("git");
		expect(useUi.getState().rightOpen).toBe(false);
	});

	it("keeps the displayed plan through planning/streaming and updates the same tab after revision", () => {
		const review: PlanStatus = { ...PLAN_OFF, enabled: true, phase: "review", content: "# Version one", version: 1 };
		useUi.setState({ rightTab: "plan", openRightTabs: ["git", "plan"] });
		useLive.setState({ sessions: { a: { ...emptySessionLive(), alive: true, plan: review } } });
		render(<RightPanelHeader activeTab="plan" tabBadges={badges} />);
		act(() => useLive.setState({ sessions: {
			a: { ...emptySessionLive(), alive: true, streaming: true, plan: { ...review, phase: "planning" } },
		} }));
		expect(useUi.getState().rightTab).toBe("plan");
		expect(useUi.getState().openRightTabs).toEqual(["git", "plan"]);
		openMenu();
		// The existing document stays open, but planning is not a reopen affordance.
		expect(screen.queryByRole("button", { name: /计划/ })).toBeNull();
		act(() => useLive.setState({ sessions: {
			a: { ...emptySessionLive(), alive: true, plan: { ...review, content: "# Version two", version: 2 } },
		} }));
		expect(useUi.getState().rightTab).toBe("plan");
		expect(useUi.getState().openRightTabs).toEqual(["git", "plan"]);
		expect(screen.getByRole("button", { name: /计划/ })).toBeTruthy();
	});

	it("closes an unavailable active plan but preserves approved history", () => {
		useUi.setState({ rightTab: "plan", openRightTabs: ["plan"] });
		useLive.setState({ sessions: { a: { ...emptySessionLive(), plan: { ...PLAN_OFF, approved } } } });
		render(<RightPanelHeader activeTab="plan" tabBadges={badges} />);
		expect(useUi.getState().rightTab).toBe("plan");
		act(() => useLive.setState({ sessions: { a: { ...emptySessionLive(), plan: PLAN_OFF } } }));
		expect(useUi.getState().openRightTabs).toEqual([]);
		expect(useUi.getState().rightTab).toBeNull();
		expect(useUi.getState().rightOpen).toBe(false);
	});
});

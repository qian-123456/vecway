// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptySessionLive, setExitIntent, useLive } from "../../../stores/live";
import { useUi } from "../../../stores/ui";
import type { PlanStatus } from "./planStatus";
import {
	parseSavedPlanStatus,
	resetPlanAutoOpenForTest,
	usePlanPanelLifecycle,
} from "./usePlanPanelLifecycle";

describe("saved plan status adapter", () => {
	it.each([undefined, null, [], {}, { enabled: "true" }])("does not turn an absent or invalid record into off (%j)", (record) => {
		expect(parseSavedPlanStatus(record)).toBeNull();
	});

	it("adapts the persisted review body without guessing a plan URL", () => {
		const plan = parseSavedPlanStatus({
			enabled: true, phase: "review", lastContent: "# A plan\n\nBody", version: 4,
			planFile: "/tmp/nested/project-plan.md",
		});
		expect(plan).toMatchObject({
			enabled: true, phase: "review", content: "# A plan\n\nBody", title: "A plan", version: 4,
			planFile: "/tmp/nested/project-plan.md", planUrl: null,
		});
	});

	it("retains approved history using the same validation as live status", () => {
		expect(parseSavedPlanStatus({ enabled: false, approved: {
			content: "# Approved", version: 5, status: "completed",
		} })?.approved).toMatchObject({ content: "# Approved", version: 5, status: "completed" });
		expect(parseSavedPlanStatus({ enabled: false, approved: {
			content: "# Invalid", status: "invented",
		} })?.approved).toBeUndefined();
	});

	it("keeps an explicit later off record off", () => {
		expect(parseSavedPlanStatus({ enabled: false, lastContent: "# Previous" })).toMatchObject({
			enabled: false, content: null,
		});
	});
});

const planningPlan = (): PlanStatus => ({
	enabled: true,
	phase: "planning",
	planFile: null,
	planUrl: null,
	title: null,
	content: null,
	prevContent: null,
	version: 0,
	planModel: null,
	tiers: [],
	defaultRole: "default",
	contextPercent: null,
	keepDisabled: false,
});

const reviewPlan = (version: number): PlanStatus => ({
	enabled: true,
	phase: "review",
	planFile: `/tmp/plan-v${version}.md`,
	planUrl: `local://plan-v${version}.md`,
	title: `Plan v${version}`,
	content: `# Plan v${version}\n\nDetails`,
	prevContent: version > 1 ? `# Plan v${version - 1}\n\nDetails` : null,
	version,
	planModel: null,
	tiers: [],
	defaultRole: "default",
	contextPercent: 12,
	keepDisabled: false,
});

describe("usePlanPanelLifecycle", () => {
	beforeEach(() => {
		localStorage.clear();
		resetPlanAutoOpenForTest();
		useLive.setState({ sessions: {} });
		useUi.setState({
			selectedSessionId: "s1",
			rightTab: null,
			openRightTabs: [],
			rightOpen: false,
		});
	});

	afterEach(() => {
		cleanup();
	});

	it("auto-opens the plan panel when version jumps from undefined directly to 1", () => {
		const { rerender } = renderHook(
			({ sid, plan, streaming }: { sid: string; plan: PlanStatus | undefined; streaming: boolean }) =>
				usePlanPanelLifecycle(sid, plan, streaming),
			{ initialProps: { sid: "s1", plan: undefined as PlanStatus | undefined, streaming: false } },
		);
		expect(useUi.getState().rightTab).toBeNull();

		rerender({ sid: "s1", plan: reviewPlan(1), streaming: false });
		expect(useUi.getState().rightTab).toBe("plan");
		expect(useUi.getState().rightOpen).toBe(true);
	});

	it("auto-opens when switching away while planning and returning after version 1 finishes", () => {
		const first = renderHook(
			({ sid, plan, streaming }: { sid: string; plan: PlanStatus | undefined; streaming: boolean }) =>
				usePlanPanelLifecycle(sid, plan, streaming),
			{ initialProps: { sid: "s1", plan: planningPlan(), streaming: true } },
		);
		expect(useUi.getState().rightTab).toBeNull();

		act(() => {
			useUi.getState().selectSession("s2");
		});
		first.unmount();

		act(() => {
			useUi.getState().selectSession("s1");
		});
		renderHook(() => usePlanPanelLifecycle("s1", reviewPlan(1), false));
		expect(useUi.getState().rightTab).toBe("plan");
		expect(useUi.getState().rightOpen).toBe(true);
	});

	it("respects manual dismissal across extra status frames and session switches", () => {
		const hook = renderHook(
			({ sid, plan, streaming }: { sid: string; plan: PlanStatus | undefined; streaming: boolean }) =>
				usePlanPanelLifecycle(sid, plan, streaming),
			{ initialProps: { sid: "s1", plan: reviewPlan(1), streaming: false } },
		);
		expect(useUi.getState().rightTab).toBe("plan");

		act(() => {
			useUi.getState().closeRightTab("plan");
		});
		expect(useUi.getState().rightTab).toBeNull();
		expect(useUi.getState().rightOpen).toBe(false);

		// Extra status frame with the same version must not reopen.
		hook.rerender({ sid: "s1", plan: { ...reviewPlan(1), contextPercent: 20 }, streaming: false });
		expect(useUi.getState().rightTab).toBeNull();

		// Switching away and returning must not reopen the dismissed version.
		act(() => {
			useUi.getState().selectSession("s2");
		});
		hook.unmount();
		act(() => {
			useUi.getState().selectSession("s1");
		});
		renderHook(() => usePlanPanelLifecycle("s1", reviewPlan(1), false));
		expect(useUi.getState().rightTab).toBeNull();
	});

	it("reopens when a newer plan version arrives after manual dismissal", () => {
		const hook = renderHook(
			({ sid, plan, streaming }: { sid: string; plan: PlanStatus | undefined; streaming: boolean }) =>
				usePlanPanelLifecycle(sid, plan, streaming),
			{ initialProps: { sid: "s1", plan: reviewPlan(1), streaming: false } },
		);
		act(() => {
			useUi.getState().closeRightTab("plan");
		});
		expect(useUi.getState().rightTab).toBeNull();

		hook.rerender({ sid: "s1", plan: reviewPlan(2), streaming: true });
		expect(useUi.getState().rightTab).toBeNull();

		hook.rerender({ sid: "s1", plan: reviewPlan(2), streaming: false });
		expect(useUi.getState().rightTab).toBe("plan");
		expect(useUi.getState().rightOpen).toBe(true);
	});

	it("suppresses auto-open when the user stops/aborts a turn", () => {
		act(() => {
			useLive.setState({
				sessions: { s1: { ...emptySessionLive(), alive: true, streaming: true, plan: planningPlan() } },
			});
		});
		const hook = renderHook(
			({ sid, plan, streaming }: { sid: string; plan: PlanStatus | undefined; streaming: boolean }) =>
				usePlanPanelLifecycle(sid, plan, streaming),
			{ initialProps: { sid: "s1", plan: planningPlan(), streaming: true } },
		);

		act(() => {
			setExitIntent("s1", "stop");
			useLive.setState((s) => ({
				sessions: {
					...s.sessions,
					s1: { ...s.sessions.s1, streaming: false, exitIntent: undefined, interruption: "stop", plan: reviewPlan(1) },
				},
			}));
		});
		hook.rerender({ sid: "s1", plan: reviewPlan(1), streaming: false });
		expect(useUi.getState().rightTab).toBeNull();

		// Switching away and returning should still suppress that stopped version.
		act(() => {
			useUi.getState().selectSession("s2");
		});
		hook.unmount();
		act(() => {
			useUi.getState().selectSession("s1");
		});
		const returned = renderHook(
			({ sid, plan, streaming }: { sid: string; plan: PlanStatus | undefined; streaming: boolean }) =>
				usePlanPanelLifecycle(sid, plan, streaming),
			{ initialProps: { sid: "s1", plan: reviewPlan(1), streaming: false } },
		);
		expect(useUi.getState().rightTab).toBeNull();

		// Starting a fresh turn and reaching version 2 opens again.
		act(() => {
			useLive.setState((s) => ({
				sessions: {
					...s.sessions,
					s1: { ...s.sessions.s1, streaming: true, interruption: undefined, plan: reviewPlan(1) },
				},
			}));
		});
		returned.rerender({ sid: "s1", plan: reviewPlan(1), streaming: true });
		returned.rerender({ sid: "s1", plan: reviewPlan(2), streaming: false });
		expect(useUi.getState().rightTab).toBe("plan");
	});

	it("does not auto-open for already-approved plans, and opens again if plan mode re-enters", () => {
		const approved: PlanStatus = {
			...planningPlan(),
			enabled: false,
			approved: {
				planFile: "/tmp/plan-v1.md",
				planUrl: "local://plan-v1.md",
				title: "Approved",
				content: "# Approved",
				prevContent: null,
				version: 1,
				status: "completed",
				error: null,
			},
		};
		const hook = renderHook(
			({ sid, plan, streaming }: { sid: string; plan: PlanStatus | undefined; streaming: boolean }) =>
				usePlanPanelLifecycle(sid, plan, streaming),
			{ initialProps: { sid: "s1", plan: reviewPlan(1), streaming: false } },
		);
		expect(useUi.getState().rightTab).toBe("plan");
		act(() => {
			useUi.getState().closeRightTab("plan");
		});

		hook.rerender({ sid: "s1", plan: approved, streaming: false });
		expect(useUi.getState().rightTab).toBeNull();

		// Re-entering plan mode (version 0 -> version 1) should auto-open again.
		hook.rerender({ sid: "s1", plan: planningPlan(), streaming: true });
		hook.rerender({ sid: "s1", plan: reviewPlan(1), streaming: false });
		expect(useUi.getState().rightTab).toBe("plan");
	});
});

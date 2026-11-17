import { describe, expect, it } from "vitest";
import { parseSavedPlanStatus } from "./usePlanPanelLifecycle";

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

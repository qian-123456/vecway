// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "./ui";

describe("useUi right panel", () => {
	beforeEach(() => {
		localStorage.clear();
		useUi.setState({
			centerView: "session",
			rightOpen: true,
			rightTab: null,
			openRightTabs: [],
			rightMaximized: false,
		});
	});

	it("restores the previously active tab on collapse then expand", () => {
		useUi.getState().setRightTab("git");
		useUi.getState().toggleRight(); // collapse
		expect(useUi.getState().rightOpen).toBe(false);
		expect(useUi.getState().rightTab).toBe("git");
		useUi.getState().toggleRight(); // expand
		expect(useUi.getState().rightOpen).toBe(true);
		expect(useUi.getState().rightTab).toBe("git");
	});

	it("shows the picker only when no tab was active", () => {
		useUi.getState().toggleRight(); // collapse
		useUi.getState().toggleRight(); // expand
		expect(useUi.getState().rightOpen).toBe(true);
		expect(useUi.getState().rightTab).toBeNull();
	});

	it("expands to the neighbour activated by closing the active tab", () => {
		useUi.getState().setRightTab("sidechat");
		useUi.getState().setRightTab("git");
		// Active "git"; close it while expanded → "sidechat" becomes active.
		useUi.getState().closeRightTab("git");
		expect(useUi.getState().rightTab).toBe("sidechat");
		useUi.getState().toggleRight(); // collapse
		useUi.getState().toggleRight(); // expand
		expect(useUi.getState().rightTab).toBe("sidechat");
	});

	it("persists open state and tabs for the next launch", () => {
		useUi.getState().setRightTab("terminal");
		useUi.getState().toggleRight(); // collapse
		expect(JSON.parse(localStorage.getItem("ompws:right-by-session") ?? "{}")[""]).toMatchObject({
			open: false,
			tabs: ["terminal"],
		});
	});

	it("toggles and sets rightMaximized transiently without persisting", () => {
		useUi.getState().setRightTab("files");
		expect(useUi.getState().rightMaximized).toBe(false);

		useUi.getState().toggleRightMaximized();
		expect(useUi.getState().rightMaximized).toBe(true);

		useUi.getState().toggleRightMaximized();
		expect(useUi.getState().rightMaximized).toBe(false);

		useUi.getState().setRightMaximized(true);
		expect(useUi.getState().rightMaximized).toBe(true);
		expect(localStorage.getItem("ompws:right-by-session") ?? "").not.toContain("rightMaximized");

		useUi.getState().setRightMaximized(false);
		expect(useUi.getState().rightMaximized).toBe(false);
	});

	it("resets rightMaximized when the right panel closes", () => {
		useUi.getState().setRightTab("files");
		useUi.getState().setRightMaximized(true);
		useUi.getState().setRightOpen(false);
		expect(useUi.getState().rightMaximized).toBe(false);

		useUi.getState().setRightOpen(true);
		useUi.getState().setRightMaximized(true);
		useUi.getState().toggleRight();
		expect(useUi.getState().rightOpen).toBe(false);
		expect(useUi.getState().rightMaximized).toBe(false);
	});

	it("resets rightMaximized when closing the last right tab, but keeps it if another tab stays active", () => {
		useUi.getState().setRightTab("git");
		useUi.getState().setRightTab("files");
		useUi.getState().setRightMaximized(true);

		useUi.getState().closeRightTab("files");
		expect(useUi.getState().rightOpen).toBe(true);
		expect(useUi.getState().rightTab).toBe("git");
		expect(useUi.getState().rightMaximized).toBe(true);

		useUi.getState().closeRightTab("git");
		expect(useUi.getState().rightOpen).toBe(false);
		expect(useUi.getState().rightTab).toBeNull();
		expect(useUi.getState().rightMaximized).toBe(false);
	});

	it("resets rightMaximized when opening settings or switching to views without a right panel", () => {
		useUi.getState().setRightTab("files");
		useUi.getState().setRightMaximized(true);
		useUi.getState().openSettings("general");
		expect(useUi.getState().rightMaximized).toBe(false);

		useUi.getState().setCenter("session");
		useUi.getState().setRightMaximized(true);
		useUi.getState().setCenter("doc");
		expect(useUi.getState().rightMaximized).toBe(true);

		for (const view of ["home", "inbox", "schedules", "skills", "settings"] as const) {
			useUi.getState().setCenter("session");
			useUi.getState().setRightMaximized(true);
			useUi.getState().setCenter(view);
			expect(useUi.getState().rightMaximized).toBe(false);
		}
	});
});

import { describe, expect, it } from "vitest";
import { MIN_CENTER_WIDTH, MIN_RIGHT_WIDTH, MIN_SIDEBAR_WIDTH } from "../stores/ui";
import { computeShellWidths } from "./shellWidths";

describe("computeShellWidths", () => {
	it("keeps preferred widths when viewport has plenty of space", () => {
		const res = computeShellWidths({
			viewportWidth: 1440,
			sidebarOpen: true,
			sidebarWidth: 280,
			rightVisible: true,
			rightWidth: 360,
		});
		expect(res).toEqual({ leftWidth: 280, rightWidth: 360 });
	});

	it("fits all three panes inside the 760px minimum window width without clipping right panel", () => {
		const res = computeShellWidths({
			viewportWidth: 760,
			sidebarOpen: true,
			sidebarWidth: 300,
			rightVisible: true,
			rightWidth: 360,
		});
		expect(res.leftWidth).toBeGreaterThanOrEqual(MIN_SIDEBAR_WIDTH);
		expect(res.rightWidth).toBeGreaterThanOrEqual(MIN_RIGHT_WIDTH);
		expect(760 - res.leftWidth - res.rightWidth).toBeGreaterThanOrEqual(MIN_CENTER_WIDTH);
	});

	it("trims both side panels proportionally above their floors at medium-narrow widths", () => {
		const res = computeShellWidths({
			viewportWidth: 820,
			sidebarOpen: true,
			sidebarWidth: 320,
			rightVisible: true,
			rightWidth: 360,
		});
		expect(res.leftWidth).toBeGreaterThan(MIN_SIDEBAR_WIDTH);
		expect(res.rightWidth).toBeGreaterThan(MIN_RIGHT_WIDTH);
		expect(res.leftWidth + res.rightWidth).toBe(820 - MIN_CENTER_WIDTH);
	});

	it("never overflows the viewport even under extreme zoom (< 748px)", () => {
		const res = computeShellWidths({
			viewportWidth: 640,
			sidebarOpen: true,
			sidebarWidth: 280,
			rightVisible: true,
			rightWidth: 360,
		});
		expect(res.leftWidth + res.rightWidth).toBeLessThan(640);
		expect(res.rightWidth).toBeGreaterThanOrEqual(120);
	});

	it("handles single open side panel", () => {
		const leftOnly = computeShellWidths({
			viewportWidth: 760,
			sidebarOpen: true,
			sidebarWidth: 500,
			rightVisible: false,
			rightWidth: 360,
		});
		expect(leftOnly).toEqual({ leftWidth: 400, rightWidth: 0 });

		const rightOnly = computeShellWidths({
			viewportWidth: 760,
			sidebarOpen: false,
			sidebarWidth: 280,
			rightVisible: true,
			rightWidth: 500,
		});
		expect(rightOnly).toEqual({ leftWidth: 0, rightWidth: 400 });
	});
});

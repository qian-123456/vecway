// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ThinkingLevelPicker } from "./ThinkingLevelPicker";

beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});
afterEach(cleanup);

const LEVELS = ["auto", "off", "low", "medium", "high", "xhigh", "max"];

const status = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
const slider = () => document.querySelector<HTMLElement>('[role="slider"]')!;

function openPicker(props: { levels: string[]; value: string; onSelect: (level: string) => void }) {
	function Harness() {
		const [open, setOpen] = useState(false);
		return <ThinkingLevelPicker {...props} open={open} onOpenChange={setOpen} />;
	}
	render(<Harness />);
	fireEvent.click(document.querySelector<HTMLButtonElement>("button")!);
}

describe("ThinkingLevelPicker", () => {
	it("keeps shrink-0 and whitespace-nowrap across states and variants", () => {
		for (const variant of ["ghost", "pill"] as const) {
			const levelsRender = render(
				<ThinkingLevelPicker levels={LEVELS} value="high" open={false} onOpenChange={() => {}} onSelect={() => {}} variant={variant} />,
			);
			const levelsBtn = levelsRender.container.querySelector("button")!;
			expect(levelsBtn.className).toContain("whitespace-nowrap");
			expect(levelsBtn.className).toContain("shrink-0");
			levelsRender.unmount();

			const unconfiguredRender = render(
				<ThinkingLevelPicker levels={[]} reasoning={true} value="" open={false} onOpenChange={() => {}} onSelect={() => {}} variant={variant} />,
			);
			const unconfiguredBtn = unconfiguredRender.container.querySelector("button")!;
			expect(unconfiguredBtn.className).toContain("whitespace-nowrap");
			expect(unconfiguredBtn.className).toContain("shrink-0");
			unconfiguredRender.unmount();

			const pendingRender = render(
				<ThinkingLevelPicker levels={[]} reasoning={undefined} value="" open={false} onOpenChange={() => {}} onSelect={() => {}} variant={variant} />,
			);
			const pendingSpan = pendingRender.container.querySelector("span")!;
			expect(pendingSpan.className).toContain("whitespace-nowrap");
			expect(pendingSpan.className).toContain("shrink-0");
			expect(pendingSpan.textContent).toBe("加载中");
			expect(pendingSpan.textContent).not.toContain("不支持思考");
			pendingRender.unmount();

			const unsupportedRender = render(
				<ThinkingLevelPicker levels={[]} reasoning={false} value="" open={false} onOpenChange={() => {}} onSelect={() => {}} variant={variant} />,
			);
			const unsupportedSpan = unsupportedRender.container.querySelector("span")!;
			expect(unsupportedSpan.className).toContain("whitespace-nowrap");
			expect(unsupportedSpan.className).toContain("shrink-0");
			expect(unsupportedSpan.textContent).toBe("不支持思考");
			unsupportedRender.unmount();
		}
	});

	it("shows the capitalized current level with no list until the status button is clicked", () => {
		const onSelect = vi.fn();
		openPicker({ levels: LEVELS, value: "high", onSelect });
		expect(status().textContent).toBe("High");
		expect(items()).toHaveLength(0);
		fireEvent.click(status());
		expect(items().map((b) => b.querySelector(".font-medium")?.textContent)).toEqual(LEVELS);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("list pick commits the raw level once and closes only the list", () => {
		const onSelect = vi.fn();
		openPicker({ levels: LEVELS, value: "high", onSelect });
		fireEvent.click(status());
		fireEvent.click(items().find((b) => b.querySelector(".font-medium")?.textContent === "auto")!);
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("auto");
		expect(items()).toHaveLength(0);
		expect(slider()).toBeTruthy();
	});

	it("picking the saved level only closes the list", () => {
		const onSelect = vi.fn();
		openPicker({ levels: LEVELS, value: "high", onSelect });
		fireEvent.click(status());
		fireEvent.click(items().find((b) => b.getAttribute("aria-checked") === "true")!);
		expect(onSelect).not.toHaveBeenCalled();
		expect(items()).toHaveLength(0);
	});

	it("slider keys commit the neighbouring concrete level; auto is not a stop", () => {
		const onSelect = vi.fn();
		openPicker({ levels: LEVELS, value: "high", onSelect });
		fireEvent.keyDown(slider(), { key: "ArrowRight" });
		expect(onSelect).toHaveBeenLastCalledWith("xhigh");
		fireEvent.keyDown(slider(), { key: "Home" });
		expect(onSelect).toHaveBeenLastCalledWith("off");
	});

	it("keeps an unknown saved level verbatim", () => {
		openPicker({ levels: ["low", "weird"], value: "weird", onSelect: () => {} });
		expect(status().textContent).toBe("weird");
	});

	it("a single concrete stop is a disabled slider that never commits", () => {
		const onSelect = vi.fn();
		openPicker({ levels: ["auto", "high"], value: "high", onSelect });
		expect(slider().getAttribute("aria-disabled")).toBe("true");
		fireEvent.keyDown(slider(), { key: "ArrowLeft" });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("keeps a neutral loading state while capabilities are loading and keeps all level names in English", () => {
		const { rerender } = render(
			<ThinkingLevelPicker levels={[]} loading value="" open={false} onOpenChange={() => {}} onSelect={() => {}} />,
		);
		expect(document.body.textContent).toContain("加载中");
		expect(document.body.textContent).not.toContain("不支持思考");

		rerender(
			<ThinkingLevelPicker levels={[]} reasoning={false} value="" open={false} onOpenChange={() => {}} onSelect={() => {}} />,
		);
		expect(document.body.textContent).toContain("不支持思考");

		const allLevels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
		openPicker({ levels: allLevels, value: "minimal", onSelect: () => {} });
		fireEvent.click(status());
		expect(items().map((b) => b.querySelector(".font-medium")?.textContent)).toEqual(allLevels);
	});
});

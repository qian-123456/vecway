// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THINK_DESC } from "../lib/models";
import { ThinkingLevelPopover } from "./ThinkingLevelPopover";

describe("ThinkingLevelPopover", () => {
	afterEach(() => {
		cleanup();
	});

	it("matches desktop EffortSlider layout: centered status toggle, description, slider without tick labels or hint", () => {
		const anchor = document.createElement("button");
		document.body.appendChild(anchor);
		const onChange = vi.fn();

		render(
			<ThinkingLevelPopover
				open
				onClose={() => {}}
				anchorEl={anchor}
				levels={["off", "low", "medium", "high", "xhigh"]}
				value="high"
				onChange={onChange}
			/>,
		);

		const toggle = screen.getByRole("button", { name: "High" });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.getByText(THINK_DESC.high)).toBeTruthy();

		// Zero bottom tick labels & zero footer hint text when collapsed on EffortSlider view
		expect(screen.queryByText("关闭")).toBeNull();
		expect(screen.queryByText("最高")).toBeNull();
		expect(screen.queryByText(/点上方/)).toBeNull();

		const slider = screen.getByRole("slider", { name: "思考强度" });
		expect(slider.getAttribute("aria-valuetext")).toBe("High");

		fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(onChange).toHaveBeenCalledWith("xhigh");

		// Expanding full listbox shows every option and commits on click
		fireEvent.click(toggle);
		const listbox = screen.getByRole("listbox", { name: "全部思考档位" });
		expect(within(listbox).getAllByRole("option")).toHaveLength(5);

		fireEvent.click(within(listbox).getByRole("option", { name: /Low/ }));
		expect(onChange).toHaveBeenCalledWith("low");

		anchor.remove();
	});
});

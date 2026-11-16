// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PopoverSelect, type PopoverSelectOption } from "./PopoverSelect";

globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
});

const OPTIONS: PopoverSelectOption[] = [
	{
		value: "off",
		label: "关闭",
		badge: "off",
		description: "不启用自动思考推理",
	},
	{
		value: "low",
		label: "低",
		badge: "low",
		description: "较快响应，仅使用少量思考",
	},
	{
		value: "medium",
		label: "中",
		badge: "medium",
		description: "平衡速度与推理深度",
		disabled: true,
	},
	{
		value: "high",
		label: "高",
		badge: "high",
		description: "深度推理模式",
	},
];

describe("PopoverSelect", () => {
	it("renders active option label and opens menu with option descriptions and badges", () => {
		const onChange = vi.fn();
		render(<PopoverSelect value="low" options={OPTIONS} aria-label="思考等级" onChange={onChange} />);

		const trigger = screen.getByRole("combobox", { name: "思考等级" });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(trigger.textContent).toContain("低");
		expect(screen.queryByRole("listbox")).toBeNull();

		fireEvent.click(trigger);

		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const listbox = screen.getByRole("listbox", { name: "思考等级" });
		expect(listbox).toBeTruthy();

		expect(screen.getByText("不启用自动思考推理")).toBeTruthy();
		expect(screen.getByText("平衡速度与推理深度")).toBeTruthy();
		expect(screen.getByText("high")).toBeTruthy();

		const selectedOption = screen.getByRole("option", { name: /低/ });
		expect(selectedOption.getAttribute("aria-selected")).toBe("true");
	});

	it("selects an enabled option on click and ignores disabled options", () => {
		const onChange = vi.fn();
		render(<PopoverSelect value="off" options={OPTIONS} aria-label="思考等级" onChange={onChange} />);

		fireEvent.click(screen.getByRole("combobox", { name: "思考等级" }));

		const disabledOpt = screen.getByRole("option", { name: /中/ });
		expect(disabledOpt.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(disabledOpt);
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("listbox")).toBeTruthy();

		fireEvent.click(screen.getByRole("option", { name: /高/ }));
		expect(onChange).toHaveBeenCalledWith("high");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("supports full keyboard navigation, IME Enter guard, and Escape returning focus", () => {
		const onChange = vi.fn();
		render(<PopoverSelect value="off" options={OPTIONS} aria-label="思考等级" onChange={onChange} />);

		const trigger = screen.getByRole("combobox", { name: "思考等级" });
		trigger.focus();

		// Open with ArrowDown -> active is selected ("off")
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(screen.getByRole("listbox")).toBeTruthy();
		const active1 = trigger.getAttribute("aria-activedescendant");
		expect(active1).toBeTruthy();
		expect(document.getElementById(active1!)?.textContent).toContain("关闭");

		// ArrowDown moves to "low", then skips disabled "medium" and lands on "high"
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(document.getElementById(trigger.getAttribute("aria-activedescendant")!)?.textContent).toContain("低");
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(document.getElementById(trigger.getAttribute("aria-activedescendant")!)?.textContent).toContain("高");

		// Home / End move to first and last enabled options
		fireEvent.keyDown(trigger, { key: "Home" });
		expect(document.getElementById(trigger.getAttribute("aria-activedescendant")!)?.textContent).toContain("关闭");
		fireEvent.keyDown(trigger, { key: "End" });
		expect(document.getElementById(trigger.getAttribute("aria-activedescendant")!)?.textContent).toContain("高");

		// IME composition Enter must not commit
		fireEvent.keyDown(trigger, { key: "Enter", isComposing: true });
		expect(onChange).not.toHaveBeenCalled();

		// Escape closes menu and restores focus to trigger
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(document.activeElement).toBe(trigger);

		// Re-open with Space, ArrowUp wraps to "high", Enter selects
		fireEvent.keyDown(trigger, { key: " " });
		expect(screen.getByRole("listbox")).toBeTruthy();
		fireEvent.keyDown(trigger, { key: "ArrowUp" });
		fireEvent.keyDown(trigger, { key: "Enter" });
		expect(onChange).toHaveBeenCalledWith("high");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("transitions cleanly to custom input mode, validates, commits, and returns to presets", () => {
		const onChange = vi.fn();
		render(
			<PopoverSelect
				value="low"
				options={OPTIONS}
				allowCustom
				aria-label="思考等级"
				customPlaceholder="输入自定义值"
				validateCustom={(v) => (v === "bad" ? "格式无效" : null)}
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByRole("combobox", { name: "思考等级" }));
		fireEvent.click(screen.getByRole("option", { name: "自定义" }));

		// Unified inline editor replaces combobox trigger
		expect(screen.queryByRole("combobox")).toBeNull();
		const input = screen.getByPlaceholderText("输入自定义值") as HTMLInputElement;
		expect(document.activeElement).toBe(input);

		// Invalid custom input displays error and blocks commit
		fireEvent.change(input, { target: { value: "bad" } });
		fireEvent.click(screen.getByRole("button", { name: "确认自定义值" }));
		expect(screen.getByText("格式无效")).toBeTruthy();
		expect(onChange).not.toHaveBeenCalled();

		// Back to presets discards draft and restores combobox focus
		fireEvent.click(screen.getByRole("button", { name: "返回预设" }));
		const restoredTrigger = screen.getByRole("combobox", { name: "思考等级" });
		expect(document.activeElement).toBe(restoredTrigger);
		expect(restoredTrigger.textContent).toContain("低");

		// Re-enter custom mode and commit valid value via Enter (after ignoring composing Enter)
		fireEvent.click(restoredTrigger);
		fireEvent.click(screen.getByRole("option", { name: "自定义" }));
		const input2 = screen.getByPlaceholderText("输入自定义值") as HTMLInputElement;
		fireEvent.change(input2, { target: { value: "ultra" } });
		fireEvent.keyDown(input2, { key: "Enter", isComposing: true });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.keyDown(input2, { key: "Enter" });
		expect(onChange).toHaveBeenCalledWith("ultra");
	});

	it("shows custom badge and edit trigger for uncatalogued values", () => {
		const onChange = vi.fn();
		render(
			<PopoverSelect
				value="custom-x"
				options={OPTIONS}
				allowCustom
				aria-label="思考等级"
				customActionLabel="编辑自定义"
				onChange={onChange}
			/>,
		);

		const trigger = screen.getByRole("combobox", { name: "思考等级" });
		expect(trigger.textContent).toContain("自定义");
		expect(trigger.textContent).toContain("custom-x");

		fireEvent.click(screen.getByRole("button", { name: "编辑自定义" }));
		const input = screen.getByRole("textbox", { name: "思考等级" }) as HTMLInputElement;
		expect(input.value).toBe("custom-x");

		fireEvent.keyDown(input, { key: "Escape" });
		expect(screen.getByRole("combobox", { name: "思考等级" })).toBeTruthy();
		expect(onChange).not.toHaveBeenCalled();
	});
});

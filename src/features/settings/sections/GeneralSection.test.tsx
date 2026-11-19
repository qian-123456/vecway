// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLanguageStore } from "../../../stores/language";
import * as ipc from "../../../lib/ipc";
import { findMatchingField } from "../fieldRegistry";
import { useOmpConfigStore } from "../ompConfigStore";
import { _resetSettingsStore, DEFAULT_SETTINGS, useSettings } from "../store";
import { GeneralSection } from "./GeneralSection";

beforeEach(() => {
	window.localStorage.clear();
	useLanguageStore.setState({ locale: "zh-CN" });
	_resetSettingsStore();
	useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, error: null });
	useOmpConfigStore.setState({ entries: [], loaded: true, loading: false, error: null });
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("GeneralSection language selection", () => {
	it("renders language segmented control with current locale", () => {
		render(<GeneralSection />);
		const langRow = screen.getByText("界面语言");
		expect(langRow).toBeDefined();

		const enOption = screen.getByText("English");
		expect(enOption).toBeDefined();

		fireEvent.click(enOption);

		expect(useLanguageStore.getState().locale).toBe("en-US");
		expect(window.localStorage.getItem("ompws:locale")).toBe("en-US");
	});
});

describe("GeneralSection global automation overlap policy", () => {
	it("defaults to skip and explains active runs and accepted queues", () => {
		render(<GeneralSection />);
		const group = screen.getByRole("radiogroup", { name: "运行重合策略" });
		expect(within(group).getByRole("radio", { name: "跳过" }).getAttribute("aria-checked")).toBe("true");
		expect(screen.getByText(/统一用于所有自动化之后的触发/).textContent).toContain("当前运行不会被中断");
		expect(screen.getByText(/已接收的队列会保留并继续排出/)).toBeTruthy();
	});

	it.each([
		["skip", "跳过"],
		["coalesce", "合并等待一次"],
		["queue", "每次排队"],
		["parallel", "同时运行"],
	] as const)("saves %s through app settings, not an automation draft", async (value, label) => {
		const save = vi.spyOn(ipc, "saveSettings").mockImplementation(async (settings) => ({ ...settings }));
		render(<GeneralSection />);
		fireEvent.click(screen.getByRole("radio", { name: label }));
		await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ automationOverlapPolicy: value })));
		await waitFor(() => expect(useSettings.getState().settings?.automationOverlapPolicy).toBe(value));
		expect(save.mock.calls[0]?.[0]).not.toHaveProperty("overlapPolicy");
	});

	it.each(["重合", "overlap", "排队", "coalesce"])("registers %s searches in General", (query) => {
		expect(findMatchingField("general", query)).toMatchObject({ id: "automationOverlapPolicy", sectionId: "general" });
	});
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpConfigEntry } from "../../lib/contracts";
import * as ipc from "../../lib/ipc";
import { tNow, useLanguageStore } from "../../stores/language";
import { useOmpConfigStore } from "./ompConfigStore";
import { OmpSettingRow } from "./OmpSettingsList";

globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
	window.localStorage.clear();
	useLanguageStore.setState({ locale: "en-US" });
	useOmpConfigStore.setState({ entries: [], loaded: true, loading: false, error: null });
});

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

const enumEntry = (value: string): OmpConfigEntry => ({
	key: "advisor.continueSeverity",
	value,
	valueType: "enum",
	description: "Minimum severity of an advisor note that wakes the agent.",
	redacted: false,
	tab: "model",
});

describe("OmpSettingRow upstream enum support", () => {
	it("includes an unknown live upstream enum value alongside static choices and allows custom input", async () => {
		const setSpy = vi.spyOn(ipc, "ompConfigSet").mockResolvedValue(undefined);
		const onChanged = vi.fn();

		render(<OmpSettingRow entry={enumEntry("critical")} onChanged={onChanged} />);

		const trigger = screen.getByRole("combobox");
		expect(trigger.textContent).toContain("critical");

		fireEvent.click(trigger);

		const options = screen.getAllByRole("option");
		const texts = options.map((el) => el.textContent ?? "");
		expect(texts.some((text) => text.includes("Nit") || text.includes("nit"))).toBe(true);
		expect(texts.some((text) => text.includes("Concern") || text.includes("concern"))).toBe(true);
		expect(texts.some((text) => text.includes("Blocker") || text.includes("blocker"))).toBe(true);

		const liveOption = options.find((el) => (el.textContent ?? "").includes("critical"));
		expect(liveOption).toBeTruthy();
		expect(liveOption?.getAttribute("aria-selected")).toBe("true");

		const customOption = screen.getByRole("option", { name: tNow("settingsCore.ompList.custom") });
		fireEvent.click(customOption);

		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "urgent" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(setSpy).toHaveBeenCalledWith("advisor.continueSeverity", "urgent");
		});
		expect(onChanged).toHaveBeenCalledTimes(1);
	});
});

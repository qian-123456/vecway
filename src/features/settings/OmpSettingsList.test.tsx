// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpConfigEntry } from "../../lib/contracts";
import * as ipc from "../../lib/ipc";
import { tNow, useLanguageStore } from "../../stores/language";
import { useOmpConfigStore } from "./ompConfigStore";
import { OmpSections, OmpSettingRow } from "./OmpSettingsList";

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

const memoryBackendEntry = (value: string): OmpConfigEntry => ({
	key: "memory.backend",
	value,
	valueType: "enum",
	description: "Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Sharpshooter",
	redacted: false,
	tab: "memory",
});

describe("MemoryBackendRows in OmpSections", () => {
	it("renders Enable Memory switch OFF without backend dropdown when off, and defaults to local on first enable", async () => {
		const setSpy = vi.spyOn(ipc, "ompConfigSet").mockResolvedValue(undefined);
		const listSpy = vi.spyOn(ipc, "ompConfigList").mockResolvedValue({
			found: true,
			entries: [memoryBackendEntry("local")],
			error: null,
		});

		useOmpConfigStore.setState({
			entries: [memoryBackendEntry("off")],
			loaded: true,
			loading: false,
			error: null,
		});

		const { container } = render(<OmpSections page="memory" />);

		const toggle = screen.getByRole("switch", { name: tNow("settingsCore.ompList.memoryEnableTitle") });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(screen.queryByRole("combobox")).toBeNull();

		const anchorRow = container.querySelector('[data-omp-key="memory.backend"]');
		expect(anchorRow).not.toBeNull();
		expect(anchorRow?.contains(toggle)).toBe(true);

		fireEvent.click(toggle);

		await waitFor(() => {
			expect(setSpy).toHaveBeenCalledWith("memory.backend", "local");
		});
		await waitFor(() => {
			expect(listSpy).toHaveBeenCalled();
		});
	});

	it("shows backend dropdown without off option when enabled, remembers mnemopi on disable, and restores it on re-enable", async () => {
		let currentBackend = "mnemopi";
		const setSpy = vi.spyOn(ipc, "ompConfigSet").mockImplementation(async (key, value) => {
			if (key === "memory.backend") currentBackend = value;
		});
		vi.spyOn(ipc, "ompConfigList").mockImplementation(async () => ({
			found: true,
			entries: [memoryBackendEntry(currentBackend)],
			error: null,
		}));

		useOmpConfigStore.setState({
			entries: [memoryBackendEntry("mnemopi")],
			loaded: true,
			loading: false,
			error: null,
		});

		const { container } = render(<OmpSections page="memory" />);

		const toggle = screen.getByRole("switch", { name: tNow("settingsCore.ompList.memoryEnableTitle") });
		expect(toggle.getAttribute("aria-checked")).toBe("true");

		const trigger = screen.getByRole("combobox");
		expect(trigger.textContent).toContain("Mnemopi");

		const anchorRow = container.querySelector('[data-omp-key="memory.backend"]');
		expect(anchorRow).not.toBeNull();
		expect(anchorRow?.contains(trigger)).toBe(true);
		expect(anchorRow?.contains(toggle)).toBe(false);

		fireEvent.click(trigger);
		const options = screen.getAllByRole("option");
		const optionTexts = options.map((el) => (el.textContent ?? "").toLowerCase());
		expect(optionTexts.some((text) => text.includes("local"))).toBe(true);
		expect(optionTexts.some((text) => text.includes("hindsight"))).toBe(true);
		expect(optionTexts.some((text) => text.includes("mnemopi"))).toBe(true);
		expect(optionTexts.some((text) => text.includes("sharpshooter"))).toBe(true);
		expect(optionTexts.some((text) => /\boff\b/.test(text))).toBe(false);

		// Close popover before toggling off.
		fireEvent.keyDown(trigger, { key: "Escape" });

		fireEvent.click(toggle);

		await waitFor(() => {
			expect(setSpy).toHaveBeenCalledWith("memory.backend", "off");
		});
		expect(window.localStorage.getItem("ompws:memory-last-backend")).toBe("mnemopi");

		await waitFor(() => {
			expect(screen.queryByRole("combobox")).toBeNull();
			expect(toggle.getAttribute("aria-checked")).toBe("false");
		});

		fireEvent.click(toggle);

		await waitFor(() => {
			expect(setSpy).toHaveBeenLastCalledWith("memory.backend", "mnemopi");
		});
	});

	it("persists backend changes and updates the remembered backend in localStorage", async () => {
		let currentBackend = "local";
		const setSpy = vi.spyOn(ipc, "ompConfigSet").mockImplementation(async (key, value) => {
			if (key === "memory.backend") currentBackend = value;
		});
		vi.spyOn(ipc, "ompConfigList").mockImplementation(async () => ({
			found: true,
			entries: [memoryBackendEntry(currentBackend)],
			error: null,
		}));

		useOmpConfigStore.setState({
			entries: [memoryBackendEntry("local")],
			loaded: true,
			loading: false,
			error: null,
		});

		render(<OmpSections page="memory" />);

		fireEvent.click(screen.getByRole("combobox"));
		const hindsightOption = screen.getByRole("option", { name: /Hindsight/i });
		fireEvent.click(hindsightOption);

		await waitFor(() => {
			expect(setSpy).toHaveBeenCalledWith("memory.backend", "hindsight");
		});
		expect(window.localStorage.getItem("ompws:memory-last-backend")).toBe("hindsight");
	});
});

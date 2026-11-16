// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ focusKey: null as string | null, focusRequest: 0 }));
const openSettingsTarget = vi.hoisted(() => vi.fn());
vi.mock("../settings/settingsNav", () => ({ useSettingsNav: () => nav }));
vi.mock("../settings/settingsTargets", () => ({ openSettingsTarget }));
vi.mock("../settings/SectionJumpBar", () => ({ SectionJumpBar: () => null }));
vi.mock("../settings/OmpSettingsList", () => ({ OmpSections: () => null }));
vi.mock("../settings/sections/QuotaDashboardCard", () => ({ QuotaDashboardCard: () => <div>Quota dashboard</div> }));
vi.mock("../settings/sections/RawFilesDialog", () => ({ RawFilesDialog: () => null }));
vi.mock("./ProviderPanel", () => ({ ProviderPanel: ({ category }: { category: string }) => <div>{category === "other" ? "Non-LLM model catalog" : "Chat provider management"}</div> }));

import { ProvidersSection } from "../settings/sections/ProvidersSection";

afterEach(() => {
	cleanup();
	nav.focusKey = null;
	nav.focusRequest = 0;
});

describe("other-model settings navigation", () => {
	it("opens the other-model tab from the service role configuration link", () => {
		nav.focusKey = "otherModels";
		render(<ProvidersSection />);
		expect(screen.getByText("Non-LLM model catalog")).toBeTruthy();
		expect(screen.queryByText("Chat provider management")).toBeNull();
		expect(screen.getByRole("radio", { name: "其他类型模型" }).getAttribute("aria-checked")).toBe("true");
	});

	it("reopens the other tab for a repeated role link without changing provider deep links", () => {
		nav.focusKey = "otherModels";
		const view = render(<ProvidersSection />);
		fireEvent.click(screen.getByRole("radio", { name: "对话模型供应商" }));
		expect(screen.getByText("Chat provider management")).toBeTruthy();
		nav.focusRequest += 1;
		view.rerender(<ProvidersSection />);
		expect(screen.getByText("Non-LLM model catalog")).toBeTruthy();
		nav.focusKey = "provider:existing";
		nav.focusRequest += 1;
		view.rerender(<ProvidersSection />);
		expect(screen.getByText("Chat provider management")).toBeTruthy();
		expect(screen.queryByText("Non-LLM model catalog")).toBeNull();
	});

	it("renders raw config action in the top header and inline context-window link on chat providers tab", () => {
		render(<ProvidersSection />);
		expect(screen.getByRole("button", { name: "编辑原始配置文件" })).toBeTruthy();
		const contextBtn = screen.getByRole("button", { name: "批量设置上下文窗口 →" });
		fireEvent.click(contextBtn);
		expect(openSettingsTarget).toHaveBeenCalledWith("modelContext");
		fireEvent.click(screen.getByRole("radio", { name: "其他类型模型" }));
		expect(screen.queryByRole("button", { name: "批量设置上下文窗口 →" })).toBeNull();
		expect(screen.getByRole("button", { name: "编辑原始配置文件" })).toBeTruthy();
	});
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelFacts, ModelsResponse } from "../lib/models";
import { loadRecentModels, RECENT_MODELS_STORAGE_KEY } from "../lib/models";
import type { ModelSource } from "./useModelFacts";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../../../core/api", () => ({ api: (...args: unknown[]) => apiMock(...args), errorMessage: String }));

import { ModelThinkingSheet } from "./ModelThinkingSheet";

function makeCatalog(): ModelsResponse {
	return {
		models: [
			{ provider: "openai", id: "gpt-5", name: "GPT 5", thinking: ["low", "high"], contextWindow: 128_000, reasoning: true },
			{ provider: "openai", id: "gpt-small", name: "GPT Small", contextWindow: 8_000 },
			{ provider: "anthropic", id: "claude-opus", name: "Claude Opus", thinking: ["medium", "high"], contextWindow: 200_000, reasoning: true },
			{ provider: "groq", id: "llama-3", name: "Llama 3", contextWindow: 32_000 },
		],
		current: { provider: "openai", id: "gpt-5" },
		thinkingLevel: "high",
		liveThinking: ["low", "high"],
	};
}

function makeSource(catalog: ModelsResponse): ModelSource {
	return {
		load: vi.fn(async () => catalog),
		setModel: vi.fn(async (m): Promise<ModelFacts> => ({
			current: { provider: m.provider, id: m.id },
			thinkingLevel: "auto",
			liveThinking: m.thinking ?? [],
		})),
		setThinking: vi.fn(async (level): Promise<ModelFacts> => ({
			current: catalog.current,
			thinkingLevel: level,
			liveThinking: catalog.liveThinking,
		})),
	};
}

beforeEach(() => {
	apiMock.mockReset();
	localStorage.clear();
});

afterEach(() => {
	cleanup();
});

describe("ModelThinkingSheet", () => {
	it("renders two-pane layout with configured providers first and hides unconfigured behind collapsible toggle", async () => {
		apiMock.mockResolvedValue({
			providers: [
				{ id: "anthropic", displayName: "Anthropic", enabled: true, key: { kind: "plaintext" } },
				{ id: "openai", displayName: "OpenAI", enabled: true, key: { kind: "plaintext" } },
				{ id: "groq", displayName: "Groq", enabled: true, key: { kind: "missing" } },
			],
		});
		const source = makeSource(makeCatalog());
		render(<ModelThinkingSheet open onClose={() => {}} source={source} onFacts={() => {}} />);

		const rail = await screen.findByRole("tablist", { name: "模型供应商" });
		expect(within(rail).getByRole("tab", { name: /Anthropic/ })).toBeTruthy();
		expect(within(rail).getByRole("tab", { name: /OpenAI/ }).getAttribute("aria-selected")).toBe("true");
		// Unconfigured provider is hidden behind toggle initially
		expect(within(rail).queryByRole("tab", { name: /Groq/ })).toBeNull();

		const moreBtn = within(rail).getByRole("button", { name: /更多 \(1\)/ });
		expect(moreBtn.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(moreBtn);
		expect(moreBtn.getAttribute("aria-expanded")).toBe("true");
		expect(within(rail).getByRole("tab", { name: /Groq/ })).toBeTruthy();

		// No noisy "深度思考" badges
		expect(screen.queryByText("深度思考")).toBeNull();
	});

	it("records recent picks, shows removable rows in 常用, and persists across re-opens", async () => {
		apiMock.mockResolvedValue({
			providers: [
				{ id: "openai", enabled: true, key: { kind: "plaintext" } },
				{ id: "anthropic", enabled: true, key: { kind: "plaintext" } },
			],
		});
		const source = makeSource(makeCatalog());
		const onFacts = vi.fn();
		const { rerender } = render(<ModelThinkingSheet open onClose={() => {}} source={source} onFacts={onFacts} />);

		const rail = await screen.findByRole("tablist", { name: "模型供应商" });
		fireEvent.click(within(rail).getByRole("tab", { name: /anthropic/ }));

		const panel = screen.getByRole("tabpanel");
		await act(async () => {
			fireEvent.click(within(panel).getByRole("button", { name: /claude-opus/ }));
		});

		expect(loadRecentModels()).toEqual(["anthropic/claude-opus"]);
		expect(onFacts).toHaveBeenCalledWith(expect.objectContaining({ model: "anthropic/claude-opus" }));

		// Re-open shows 常用 tab and allows removing entry
		rerender(<ModelThinkingSheet open={false} onClose={() => {}} source={source} onFacts={onFacts} />);
		rerender(<ModelThinkingSheet open onClose={() => {}} source={source} onFacts={onFacts} />);

		const rail2 = await screen.findByRole("tablist", { name: "模型供应商" });
		const recentTab = within(rail2).getByRole("tab", { name: /常用/ });
		fireEvent.click(recentTab);

		const panel2 = screen.getByRole("tabpanel");
		expect(within(panel2).getByText("claude-opus")).toBeTruthy();
		fireEvent.click(within(panel2).getByRole("button", { name: "从常用移除 claude-opus" }));
		expect(JSON.parse(localStorage.getItem(RECENT_MODELS_STORAGE_KEY) ?? "[]")).toEqual([]);
	});

	it("flattens search results across all providers and shows context overflow warning only when exceeded", async () => {
		apiMock.mockRejectedValue(new Error("inventory unavailable"));
		const source = makeSource(makeCatalog());
		render(<ModelThinkingSheet open onClose={() => {}} source={source} contextTokens={16_000} onFacts={() => {}} />);

		await screen.findByRole("tablist", { name: "模型供应商" });
		const panel = screen.getByRole("tabpanel");
		// gpt-small has 8k context < 16k -> shows gentle warning; gpt-5 has 128k -> does not
		expect(within(panel).getAllByText("上下文窗口小于当前对话")).toHaveLength(1);

		const searchInput = screen.getByRole("searchbox", { name: "搜索模型" });
		fireEvent.change(searchInput, { target: { value: "llama" } });
		expect(screen.queryByRole("tablist", { name: "模型供应商" })).toBeNull();
		expect(screen.getByText("1 个结果")).toBeTruthy();
		expect(screen.getByText("llama-3")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "清除模型搜索" }));
		expect(screen.getByRole("tablist", { name: "模型供应商" })).toBeTruthy();
	});
});

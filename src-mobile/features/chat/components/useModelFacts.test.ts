// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
vi.mock("../../../core/api", () => ({ api: (...args: unknown[]) => apiMock(...args), errorMessage: String }));

import { sessionModelSource, useModelFacts, type ModelSource } from "./useModelFacts";

beforeEach(() => {
	apiMock.mockReset();
});
afterEach(() => cleanup());

describe("session model source", () => {
	it("uses the provider/modelId API contract for a model selection", async () => {
		apiMock.mockResolvedValue({ current: { provider: "openai", id: "gpt-test" }, thinkingLevel: "high", liveThinking: ["low", "high"] });
		const facts = await sessionModelSource("s1").setModel({ provider: "openai", id: "gpt-test" });
		expect(apiMock).toHaveBeenCalledWith("POST", "/sessions/s1/model", { provider: "openai", modelId: "gpt-test" });
		expect(facts.thinkingLevel).toBe("high");
	});

	it("normalizes empty catalog arrays and sends thinking independently", async () => {
		apiMock.mockResolvedValue({ current: null, thinkingLevel: null });
		const source = sessionModelSource("s2");
		expect(await source.load()).toMatchObject({ models: [], liveThinking: [] });
		await source.setThinking("low");
		expect(apiMock).toHaveBeenLastCalledWith("POST", "/sessions/s2/thinking", { level: "low" });
	});
});

describe("useModelFacts", () => {
	const source: ModelSource = {
		load: async () => ({
			models: [{ provider: "openai", id: "gpt-5" }, { provider: "anthropic", id: "sonnet" }],
			current: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "auto",
			liveThinking: ["low", "high"],
		}),
		setModel: async () => ({ current: null, thinkingLevel: null, liveThinking: [] }),
		setThinking: async () => ({ current: null, thinkingLevel: null, liveThinking: [] }),
	};

	it("loads configuredProviders and providerLabels from /left/providers", async () => {
		apiMock.mockResolvedValue({
			providers: [
				{ id: "openai", displayName: "OpenAI 直连", enabled: true, key: { kind: "plaintext" } },
				{ id: "ollama", displayName: null, enabled: true, authNone: true, key: { kind: "none" } },
				{ id: "anthropic", displayName: "Claude", enabled: false, key: { kind: "plaintext" } },
				{ id: "groq", enabled: true, key: { kind: "missing" } },
			],
		});
		const { result } = renderHook(() => useModelFacts(true, source));
		await waitFor(() => expect(result.current.data).not.toBeNull());
		expect([...(result.current.configuredProviders ?? [])]).toEqual(["openai", "ollama"]);
		expect(result.current.providerLabels).toEqual({ openai: "OpenAI 直连", anthropic: "Claude" });
		expect(result.current.providerOrder).toEqual(["openai", "ollama", "anthropic", "groq"]);
	});

	it("falls back non-fatally to null configuredProviders when /left/providers fails or is empty", async () => {
		apiMock.mockRejectedValue(new Error("offline"));
		const { result } = renderHook(() => useModelFacts(true, source));
		await waitFor(() => expect(result.current.data).not.toBeNull());
		expect(result.current.error).toBe("");
		expect(result.current.configuredProviders).toBeNull();
		expect(result.current.providerLabels).toEqual({});
	});
});

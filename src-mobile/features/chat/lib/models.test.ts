// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
	currentModelOpt,
	filterModels,
	groupByProvider,
	groupModelsInOrder,
	isCurrentModel,
	isModelContextTooSmall,
	isProviderConfigured,
	loadRecentModels,
	modelLabel,
	RECENT_MODELS_STORAGE_KEY,
	recordRecentModel,
	removeRecentModel,
	resolveRecentModels,
	resolveThinkingLevels,
	shortModel,
	splitProviderGroups,
	type ModelOpt,
} from "./models";

const ms: ModelOpt[] = [
	{ provider: "openai", id: "gpt-5", name: "GPT 5", thinking: ["low", "high"] },
	{ provider: "anthropic", id: "sonnet", name: "sonnet" },
	{ provider: "openai", id: "gpt-mini" },
	{ provider: "anthropic", id: "opus", name: "Claude Opus" },
];

describe("groupByProvider", () => {
	it("sorts providers, keeps model order", () => {
		const g = groupByProvider(ms);
		expect(g.map((x) => x.provider)).toEqual(["anthropic", "openai"]);
		expect(g[0].models.map((m) => m.id)).toEqual(["sonnet", "opus"]);
		expect(g[1].models.map((m) => m.id)).toEqual(["gpt-5", "gpt-mini"]);
	});
});

describe("filterModels", () => {
	it("empty query returns all", () => expect(filterModels(ms, "  ")).toHaveLength(4));
	it("AND tokens across provider/name, case-insensitive", () => {
		expect(filterModels(ms, "OPENAI gpt").map((m) => m.id)).toEqual(["gpt-5", "gpt-mini"]);
		expect(filterModels(ms, "claude anthropic").map((m) => m.id)).toEqual(["opus"]);
		expect(filterModels(ms, "claude openai")).toEqual([]);
	});
});

describe("current model", () => {
	it("provider optional", () => {
		expect(isCurrentModel(ms[0], { id: "gpt-5" })).toBe(true);
		expect(isCurrentModel(ms[0], { provider: "x", id: "gpt-5" })).toBe(false);
		expect(isCurrentModel(ms[0], null)).toBe(false);
	});
	it("currentModelOpt falls back to id match", () => {
		expect(currentModelOpt(ms, { provider: "anthropic", id: "opus" })).toBe(ms[3]);
		expect(currentModelOpt(ms, { provider: "zzz", id: "opus" })).toBe(ms[3]);
		expect(currentModelOpt(ms, { id: "nope" })).toBeNull();
	});
});

describe("resolveThinkingLevels", () => {
	it("auto, off, then ascending effort from catalog", () => {
		expect(resolveThinkingLevels(ms[0], [], "auto")).toEqual(["auto", "off", "low", "high"]);
	});
	it("live levels win", () => {
		expect(resolveThinkingLevels(ms[0], ["medium", "off", "auto"], null)).toEqual(["auto", "off", "medium"]);
	});
	it("sorts known levels and keeps unknown current level at end", () => {
		expect(resolveThinkingLevels(ms[0], [], "custom-level")).toEqual(["auto", "off", "low", "high", "custom-level"]);
		expect(resolveThinkingLevels(ms[0], [], "max")).toEqual(["auto", "off", "low", "high", "max"]);
	});
	it("empty cases", () => {
		expect(resolveThinkingLevels(null, [], null)).toEqual([]);
		expect(resolveThinkingLevels(ms[1], [], "high")).toEqual(["high"]);
	});
});

describe("labels", () => {
	it("modelLabel", () => {
		expect(modelLabel(ms[0])).toBe("GPT 5");
		expect(modelLabel(ms[1])).toBe("sonnet");
		expect(modelLabel({ provider: "a", id: "b", name: "a/b" })).toBe("b");
	});
	it("shortModel strips provider prefixes, thinking suffixes, and date snapshots", () => {
		expect(shortModel("openai/gpt-5")).toBe("gpt-5");
		expect(shortModel("gpt-5")).toBe("gpt-5");
		expect(shortModel("anthropic/claude-3-7-sonnet-20250219")).toBe("claude-3-7-sonnet");
		expect(shortModel("openai/gpt-4o-2024-08-06")).toBe("gpt-4o");
		expect(shortModel("google/gemini-4-neon:high")).toBe("gemini-4-neon");
		expect(shortModel("gemini-4-neon:xhigh")).toBe("gemini-4-neon");
	});
});

describe("recent model picks", () => {
	beforeEach(() => localStorage.clear());

	it("records deduplicated provider/id entries most-recent-first capped at 5", () => {
		for (const key of ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6", "b/2"]) {
			recordRecentModel(key);
		}
		expect(loadRecentModels()).toEqual(["b/2", "f/6", "e/5", "d/4", "c/3"]);
		expect(JSON.parse(localStorage.getItem(RECENT_MODELS_STORAGE_KEY) ?? "[]")).toEqual(["b/2", "f/6", "e/5", "d/4", "c/3"]);
	});

	it("ignores non-catalog keys and removes entries cleanly", () => {
		recordRecentModel("__recent__");
		recordRecentModel("@smol");
		recordRecentModel("openai/gpt-5");
		recordRecentModel("anthropic/opus");
		expect(loadRecentModels()).toEqual(["anthropic/opus", "openai/gpt-5"]);
		expect(removeRecentModel("openai/gpt-5")).toEqual(["anthropic/opus"]);
		expect(resolveRecentModels(ms, loadRecentModels()).map((m) => m.id)).toEqual(["opus"]);
	});
});

describe("provider configuration & splitting", () => {
	it("detects configured/enabled vs unconfigured/disabled providers", () => {
		expect(isProviderConfigured({ id: "openai", enabled: true, key: { kind: "plaintext" } })).toBe(true);
		expect(isProviderConfigured({ id: "ollama", enabled: true, authNone: true, key: { kind: "none" } })).toBe(true);
		expect(isProviderConfigured({ id: "local", enabled: true, key: { kind: "none" } })).toBe(true);
		expect(isProviderConfigured({ id: "env-ok", enabled: true, key: { kind: "envVar", envSet: true } })).toBe(true);
		expect(isProviderConfigured({ id: "env-miss", enabled: true, key: { kind: "envVar", envSet: false } })).toBe(false);
		expect(isProviderConfigured({ id: "no-key", enabled: true, key: { kind: "missing" } })).toBe(false);
		expect(isProviderConfigured({ id: "disabled", enabled: false, key: { kind: "plaintext" } })).toBe(false);
	});

	it("splits configured providers in priority order and sorts unconfigured separately", () => {
		const groups = groupModelsInOrder([
			{ provider: "zai", id: "z1" },
			{ provider: "openai", id: "o1" },
			{ provider: "anthropic", id: "a1" },
			{ provider: "bedrock", id: "b1" },
		]);
		const { configured, unconfigured } = splitProviderGroups(groups, new Set(["anthropic", "openai"]), ["anthropic", "openai"]);
		expect(configured.map((g) => g.provider)).toEqual(["anthropic", "openai"]);
		expect(unconfigured.map((g) => g.provider)).toEqual(["bedrock", "zai"]);
	});

	it("falls back to all providers when inventory is null or empty", () => {
		const groups = groupModelsInOrder(ms);
		expect(splitProviderGroups(groups, null).configured.map((g) => g.provider)).toEqual(["openai", "anthropic"]);
		expect(splitProviderGroups(groups, new Set()).unconfigured).toEqual([]);
	});
});

describe("isModelContextTooSmall", () => {
	it("flags models whose contextWindow is smaller than active contextTokens", () => {
		expect(isModelContextTooSmall({ contextWindow: 8000 }, 12000)).toBe(true);
		expect(isModelContextTooSmall({ contextWindow: 12000 }, 12000)).toBe(false);
		expect(isModelContextTooSmall({ contextWindow: undefined }, 12000)).toBe(false);
		expect(isModelContextTooSmall({ contextWindow: 8000 }, null)).toBe(false);
	});
});

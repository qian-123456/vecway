import { describe, expect, it } from "vitest";
import { findCatalogModel, parseModels, pickCurrentModel, resolveCurrentModel, resolveThinkingLevels, thinkingChipState } from "./models";

describe("resolveThinkingLevels", () => {
	it("falls back to configured catalog levels when live metadata is unavailable", () => {
		expect(resolveThinkingLevels(undefined, ["low", "high"])).toEqual([
			"auto",
			"off",
			"low",
			"high",
		]);
	});

	it("orders auto and off first, then effort ascending, unknown levels last", () => {
		expect(resolveThinkingLevels(["max", "custom", "low", "xhigh", "medium"], null)).toEqual([
			"auto",
			"off",
			"low",
			"medium",
			"xhigh",
			"max",
			"custom",
		]);
	});

	it("keeps a non-auto current level even when it is not in known capabilities", () => {
		expect(resolveThinkingLevels(["low", "high"], ["medium"], "xhigh")).toEqual([
			"auto",
			"off",
			"low",
			"high",
			"xhigh",
		]);
	});

	it("does not invent an auto-only control when capabilities and current level are unknown", () => {
		expect(resolveThinkingLevels(undefined, undefined)).toEqual([]);
	});

	it("shows an unknown current level without inventing auto when capabilities are unknown", () => {
		expect(resolveThinkingLevels(undefined, undefined, "xhigh")).toEqual([
			"xhigh",
		]);
	});
});

describe("thinkingChipState", () => {
	it("shows levels when omp reports them, regardless of the reasoning flag", () => {
		const levels = resolveThinkingLevels(undefined, ["low", "high", "max"]);
		expect(thinkingChipState(levels, true)).toEqual({ kind: "levels", levels });
		expect(thinkingChipState(levels, undefined).kind).toBe("levels");
	});

	it("is 'unconfigured' for a reasoning model with no levels", () => {
		expect(thinkingChipState(resolveThinkingLevels(undefined, []), true)).toEqual({ kind: "unconfigured" });
	});

	it("is 'unsupported' when the model does not think or the flag is unknown", () => {
		expect(thinkingChipState([], false)).toEqual({ kind: "unsupported" });
		expect(thinkingChipState([], null)).toEqual({ kind: "unsupported" });
	});

	it("parseModels carries the reasoning flag", () => {
		const [m] = parseModels([{ provider: "p", id: "m", reasoning: true, thinking: [] }]);
		expect(m.reasoning).toBe(true);
	});
});

describe("model label never falls to the placeholder while a model is known", () => {
	it("shows the provider/model key even when the catalog is empty or unloaded", () => {
		for (const models of [undefined, null, []]) {
			const r = resolveCurrentModel("prov/m1", models);
			expect(r.value).toBe("prov/m1");
			expect(r.label).not.toBe("模型…");
		}
	});

	it("skips an empty live model and falls through to the session meta model", () => {
		for (const live of ["", "  ", {}, null, undefined]) {
			const r = pickCurrentModel([live, "prov/m1"], []);
			expect(r.value).toBe("prov/m1");
			expect(r.label).toBe("prov/m1");
		}
	});

	it("resolves against the catalog when loaded and yields the placeholder only when nothing is known", () => {
		const models = parseModels([{ provider: "prov", id: "m1" }]);
		expect(pickCurrentModel(["", "prov/m1"], models).label).toBe("m1");
		expect(pickCurrentModel([undefined, ""], models).value).toBe("");
	});
});

describe("slash-containing model IDs and exact provider identity", () => {
	const magpieModel = { provider: "magpie", id: "agy-cli/gemini-4-hydrogen", name: "Gemini 4 Hydrogen", contextWindow: 1_000_000 };

	it("resolves a slash-containing model id recorded without its provider prefix when unique in catalog", () => {
		const r = resolveCurrentModel("agy-cli/gemini-4-hydrogen", [magpieModel]);
		expect(r).toEqual({
			value: "magpie/agy-cli/gemini-4-hydrogen",
			provider: "magpie",
			id: "agy-cli/gemini-4-hydrogen",
			label: "agy-cli/gemini-4-hydrogen",
		});
	});

	it("prefers exact provider/id match over bare slash-id match", () => {
		const exactProvider = { provider: "agy-cli", id: "gemini-4-hydrogen", name: "Direct", contextWindow: 200_000 };
		const r = resolveCurrentModel("agy-cli/gemini-4-hydrogen", [magpieModel, exactProvider]);
		expect(r).toEqual({
			value: "agy-cli/gemini-4-hydrogen",
			provider: "agy-cli",
			id: "gemini-4-hydrogen",
			label: "gemini-4-hydrogen",
		});
	});

	it("never guesses when multiple providers share the same slash-id or when only suffix matches", () => {
		const otherSameId = { provider: "proxy2", id: "agy-cli/gemini-4-hydrogen", name: "Proxy 2", contextWindow: 256_000 };
		expect(findCatalogModel("agy-cli/gemini-4-hydrogen", [magpieModel, otherSameId])).toBeNull();
		expect(resolveCurrentModel("agy-cli/gemini-4-hydrogen", [magpieModel, otherSameId]).value).toBe("agy-cli/gemini-4-hydrogen");

		const otherProviderBare = { provider: "other", id: "gemini-4-hydrogen", name: "Other", contextWindow: 128_000 };
		expect(findCatalogModel("agy-cli/gemini-4-hydrogen", [otherProviderBare])).toBeNull();
		expect(resolveCurrentModel("agy-cli/gemini-4-hydrogen", [otherProviderBare]).provider).toBe("agy-cli");
	});

	it("keeps explicit provider identity when model state is an object", () => {
		const r = resolveCurrentModel({ provider: "agy-cli", id: "gemini-4-hydrogen" }, [magpieModel]);
		expect(r).toEqual({
			value: "agy-cli/gemini-4-hydrogen",
			provider: "agy-cli",
			id: "gemini-4-hydrogen",
			label: "gemini-4-hydrogen",
		});
	});
});

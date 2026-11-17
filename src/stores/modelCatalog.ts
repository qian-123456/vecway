import { useMemo } from "react";
import { create } from "zustand";
import type { Model, ModelCatalogWarning } from "../lib/contracts";
import { listModels, ompModelsContextWindowOverrides, ompModelsSetContextWindows } from "../lib/ipc";
import { type ModelOption, parseModels } from "../lib/models";
import { loadProviderWindows, loadRules, pickRule } from "../features/settings/contextWindow/core";
import { errMsg } from "../lib/dialogs";
import { toast } from "../lib/toast";
import { tNow } from "./language";

const CACHE_KEY = "ompws:cached-models";
const UNAVAILABLE_KEY = "ompws:unavailable-models";

/**
 * Last catalog persisted in localStorage. Accepts both the current shape
 * (raw `Model[]`) and the legacy parsed `ModelOption[]` (a subset of `Model`);
 * malformed entries are dropped, unusable payloads yield null.
 */
export function readCachedModels(key = CACHE_KEY): Model[] | null {
	try {
		const raw = globalThis.localStorage?.getItem(key);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const out: Model[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== "object") continue;
			const o = item as Record<string, unknown>;
			if (typeof o.provider !== "string" || typeof o.id !== "string") continue;
			if (!o.provider || !o.id) continue;
			out.push({
				provider: o.provider,
				id: o.id,
				name: typeof o.name === "string" && o.name ? o.name : `${o.provider}/${o.id}`,
				thinking: Array.isArray(o.thinking)
					? o.thinking.filter((t): t is string => typeof t === "string")
					: undefined,
				contextWindow: typeof o.contextWindow === "number" ? o.contextWindow : null,
				reasoning: typeof o.reasoning === "boolean" ? o.reasoning : undefined,
			});
		}
		return parsed.length === 0 || out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

function writeCachedModels(models: Model[], key = CACHE_KEY): void {
	try {
		globalThis.localStorage?.setItem(key, JSON.stringify(models));
	} catch {
		// Storage full/unavailable: the in-memory catalog still works.
	}
}

const modelKey = (model: Model) => `${model.provider}\0${model.id}`;

interface ModelCatalogState {
	/** Most recent successful CLI result; stale results are retained for context only. */
	models: Model[] | null;
	loading: boolean;
	status: "idle" | "unverified" | "stale" | "failed";
	error: string | null;
	unavailable: Model[];
	warnings: ModelCatalogWarning[];
	refreshOnline: () => Promise<void>;
	/** Ordinary opens deduplicate. Confirmed mutations evict affected providers
	 * from memory/cache and supersede every request started before the mutation. */
	refresh: (invalidateProviders?: readonly string[]) => Promise<void>;
}

let inflight: Promise<void> | null = null;
let generation = 0;
const cachedModels = readCachedModels();

export const useModelCatalog = create<ModelCatalogState>((set, get) => {
	const refresh = (invalidateProviders?: readonly string[], online = false) => {
		if (invalidateProviders === undefined && inflight) return inflight;
		const current = ++generation;
		if (invalidateProviders !== undefined) {
			const affected = new Set(invalidateProviders);
			const models = get().models?.filter((model) => !affected.has(model.provider)) ?? null;
			const unavailable = get().unavailable.filter((model) => !affected.has(model.provider));
			const warnings = get().warnings.filter((warning) => "provider" in warning && !affected.has(warning.provider));
			set({ models, unavailable, warnings });
			if (models !== null) writeCachedModels(models);
			writeCachedModels(unavailable, UNAVAILABLE_KEY);
		}
		set({ loading: true });
		const publish = async (list: Model[], warnings: ModelCatalogWarning[]): Promise<boolean> => {
			if (current !== generation) return false;
			const keys = new Set(list.map(modelKey));
			const baseline = get().models;
			const previous = new Map((baseline ?? []).map((model) => [modelKey(model), model]));
			const unavailable = new Map(get().unavailable.map((model) => [modelKey(model), model]));
			for (const [key, model] of previous) {
				if (!keys.has(key)) unavailable.set(key, model);
			}
			for (const key of keys) unavailable.delete(key);
			const missing = [...unavailable.values()];
			const added = [...keys].some((key) => !previous.has(key));
			// A manual refresh or a normal reread can discover an external provider
			// change. Sync existing processes before exposing the new selectors.
			if (added && invalidateProviders === undefined && (baseline !== null || online)) {
				await Promise.allSettled([
					import("../features/sessions/draftSession").then(({ invalidateWarmDrafts }) =>
						current === generation ? invalidateWarmDrafts() : undefined),
					import("../features/sessions/modelRegistrySync").then(({ markLiveSessionsStale }) =>
						current === generation ? markLiveSessionsStale() : undefined),
				]);
				if (current !== generation) return false;
			}
			set({ models: list, status: "unverified", error: null, warnings, unavailable: missing });
			writeCachedModels(list);
			writeCachedModels(missing, UNAVAILABLE_KEY);
			return true;
		};
		const request = (async () => {
			try {
				const { models: list, warnings = [] } = await listModels(online);
				if (!(await publish(list, warnings)) || current !== generation) return;
				const rules = loadRules();
				const providerWindows = loadProviderWindows();
				let writing = false;
				if (rules.length > 0 || Object.keys(providerWindows).length > 0) {
					try {
						const overrides = await ompModelsContextWindowOverrides();
						if (current !== generation) return;
						const explicit = new Set(overrides.map((o) => `${o.providerId}\0${o.modelId}`));
						const edits = list.flatMap((model) => {
							const window = providerWindows[model.provider] ?? pickRule(rules, model.id)?.contextWindow;
							return window != null && !explicit.has(`${model.provider}\0${model.id}`)
								? [{ providerId: model.provider, modelId: model.id, contextWindow: window }]
								: [];
						});
						if (edits.length > 0) {
							writing = true;
							await ompModelsSetContextWindows(edits, true);
							if (current !== generation) return;
							// This read is for metadata only. A second discovery pass
							// must not override the membership or diagnostics just published.
							const resolved = new Map((await listModels()).models.map((m) => [modelKey(m), m]));
							if (current !== generation) return;
							const models = list.map((m) => resolved.get(modelKey(m)) ?? m);
							set({ models });
							writeCachedModels(models);
						}
					} catch (error) {
						if (current !== generation) return;
						toast.error(tNow(writing ? "settingsSectionsContext.context.writeFailed" : "settingsSectionsContext.context.readOverridesFailed", { error: errMsg(error) }));
					}
				}
			} catch (error) {
				if (current === generation) set({
					status: get().models === null ? "failed" : "stale",
					warnings: [],
					error: tNow("models.catalogRefreshFailed", { error: errMsg(error) }),
				});
			} finally {
				if (current === generation) {
					inflight = null;
					set({ loading: false });
				}
			}
		})();
		inflight = request;
		return request;
	};
	return {
		models: cachedModels,
		loading: false,
		status: cachedModels === null ? "idle" : "stale",
		error: null,
		unavailable: readCachedModels(UNAVAILABLE_KEY) ?? [],
		warnings: [],
		refresh: (invalidateProviders) => refresh(invalidateProviders),
		refreshOnline: () => refresh(undefined, true),
	};
});

/** Catalog as picker options; null until the first load. */
export function useModelOptions(): ModelOption[] | null {
	const models = useModelCatalog((s) => s.models);
	return useMemo(() => (models ? parseModels(models) : null), [models]);
}

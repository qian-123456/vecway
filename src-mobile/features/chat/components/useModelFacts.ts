import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../../core/api";
import {
	isProviderConfigured,
	type ModelFacts,
	type ModelOpt,
	type ModelsResponse,
	type ProviderInventoryRow,
} from "../lib/models";

/** Where the model + thinking sheet reads the catalog from and writes the choice to. */
export interface ModelSource {
	load(): Promise<ModelsResponse>;
	setModel(m: ModelOpt): Promise<ModelFacts>;
	setThinking(level: string): Promise<ModelFacts>;
}

/** A live session: `GET /sessions/{id}/models`, `POST …/model`, `POST …/thinking`. */
export function sessionModelSource(sessionId: string): ModelSource {
	const facts = (r: Partial<ModelFacts>): ModelFacts => ({
		current: r.current ?? null,
		thinkingLevel: r.thinkingLevel ?? null,
		liveThinking: r.liveThinking ?? [],
	});
	return {
		load: async () => {
			const r = await api<ModelsResponse>("GET", `/sessions/${sessionId}/models`);
			return { ...r, models: r.models ?? [], liveThinking: r.liveThinking ?? [] };
		},
		setModel: async (m) => facts(await api<ModelFacts>("POST", `/sessions/${sessionId}/model`, { provider: m.provider, modelId: m.id })),
		setThinking: async (level) => facts(await api<ModelFacts>("POST", `/sessions/${sessionId}/thinking`, { level })),
	};
}

export interface ModelFactsState {
	data: ModelsResponse | null;
	loading: boolean;
	error: string;
	configuredProviders: Set<string> | null;
	providerLabels: Record<string, string>;
	providerOrder: string[];
	reload: () => void;
	/** Merge facts returned by a write into the loaded data. */
	patch: (f: ModelFacts) => void;
}

function parseProviderInventory(res: { providers?: ProviderInventoryRow[] } | null | undefined): {
	configuredProviders: Set<string> | null;
	providerLabels: Record<string, string>;
	providerOrder: string[];
} {
	const rows = Array.isArray(res?.providers) ? res.providers : [];
	if (rows.length === 0) {
		return { configuredProviders: null, providerLabels: {}, providerOrder: [] };
	}
	const configuredProviders = new Set<string>();
	const providerLabels: Record<string, string> = {};
	const providerOrder: string[] = [];
	for (const row of rows) {
		if (!row || typeof row.id !== "string" || !row.id) continue;
		providerOrder.push(row.id);
		if (isProviderConfigured(row)) configuredProviders.add(row.id);
		const label = row.displayName?.trim();
		if (label) providerLabels[row.id] = label;
	}
	if (providerOrder.length === 0) {
		return { configuredProviders: null, providerLabels: {}, providerOrder: [] };
	}
	return { configuredProviders, providerLabels, providerOrder };
}

/** Loads the catalog from `source` and provider inventory whenever the sheet opens. */
export function useModelFacts(open: boolean, source: ModelSource): ModelFactsState {
	const [data, setData] = useState<ModelsResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [configuredProviders, setConfiguredProviders] = useState<Set<string> | null>(null);
	const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
	const [providerOrder, setProviderOrder] = useState<string[]>([]);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		if (!open) return;
		let dead = false;
		setLoading(true);
		setError("");
		const providersReq = api<{ providers?: ProviderInventoryRow[] }>("GET", "/left/providers").catch(() => null);
		Promise.all([source.load(), providersReq])
			.then(([modelsRes, providersRes]) => {
				if (dead) return;
				const inv = parseProviderInventory(providersRes);
				setData(modelsRes);
				setConfiguredProviders(inv.configuredProviders);
				setProviderLabels(inv.providerLabels);
				setProviderOrder(inv.providerOrder);
			})
			.catch((e: unknown) => {
				if (dead) return;
				setError(errorMessage(e));
			})
			.finally(() => {
				if (!dead) setLoading(false);
			});
		return () => {
			dead = true;
		};
	}, [open, source, tick]);

	const reload = useCallback(() => setTick((n) => n + 1), []);
	const patch = useCallback((f: ModelFacts) => setData((d) => (d ? { ...d, ...f } : d)), []);
	return { data, loading, error, configuredProviders, providerLabels, providerOrder, reload, patch };
}

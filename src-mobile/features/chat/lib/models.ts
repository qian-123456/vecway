export interface ModelOpt {
	provider: string;
	id: string;
	name?: string;
	thinking?: string[];
	contextWindow?: number;
	reasoning?: boolean | null;
}

export interface ModelFacts {
	current: { provider?: string; id: string } | null;
	thinkingLevel: string | null;
	liveThinking: string[];
}

export interface ModelsResponse extends ModelFacts {
	models: ModelOpt[];
	live?: boolean;
	catalogSource?: "cli";
	catalogCompleteness?: "unverified";
}

export const THINK_DESC: Record<string, string> = {
	auto: "跟随模型的默认力度",
	off: "不启用深度推理思考",
	minimal: "轻度推理，适合简单问答",
	low: "较少推理步骤，响应较快",
	medium: "均衡推理与响应速度",
	high: "完整多步推理，适合复杂分析",
	xhigh: "高强度推理，适合复杂推演",
	max: "无限制深度推理，耗费最多预算",
};

/** Short Chinese name of a thinking level for the top bar and the level picker. */
export const THINK_LABEL: Record<string, string> = {
	auto: "自动",
	off: "关闭",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "超高",
	max: "最高",
};

export function thinkLabel(level: string | null | undefined): string {
	const l = level || "auto";
	return THINK_LABEL[l] ?? l;
}

/** Desktop-canonical English thinking level name (High, Low, Medium, X-High, Max, Auto, Off). */
export function desktopThinkingLabel(level: string | null | undefined): string {
	const l = (level || "").trim().toLowerCase();
	switch (l) {
		case "xhigh":
			return "X-High";
		case "max":
			return "Max";
		case "high":
			return "High";
		case "medium":
			return "Medium";
		case "low":
			return "Low";
		case "minimal":
			return "Minimal";
		case "auto":
			return "Auto";
		case "off":
			return "Off";
		default:
			return level ? level.charAt(0).toUpperCase() + level.slice(1) : "Auto";
	}
}

/**
 * Split a settings model reference (`provider/id[:level]`, e.g. `google/gemini-3-flash:high`)
 * into the catalog key and the optional thinking suffix.
 */
export function parseModelRef(ref: string | null | undefined): { provider?: string; id: string; thinking: string | null } | null {
	const raw = (ref ?? "").trim();
	if (!raw) return null;
	const colon = raw.lastIndexOf(":");
	const level = colon > 0 ? raw.slice(colon + 1) : "";
	const known = level in THINK_LABEL;
	const body = known ? raw.slice(0, colon) : raw;
	const slash = body.indexOf("/");
	return slash > 0
		? { provider: body.slice(0, slash), id: body.slice(slash + 1), thinking: known ? level : null }
		: { id: body, thinking: known ? level : null };
}

export interface ProviderGroup {
	provider: string;
	models: ModelOpt[];
}

/** Providers sorted alphabetically; models keep catalog order inside each provider. */
export function groupByProvider(models: ModelOpt[]): ProviderGroup[] {
	const by = new Map<string, ModelOpt[]>();
	for (const m of models) {
		const list = by.get(m.provider);
		if (list) list.push(m);
		else by.set(m.provider, [m]);
	}
	return [...by.keys()]
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map((provider) => ({ provider, models: by.get(provider) ?? [] }));
}

/** Every whitespace-separated token must match provider, id or name (case-insensitive). */
export function filterModels(models: ModelOpt[], query: string, providerLabels?: Record<string, string>): ModelOpt[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return models;
	return models.filter((m) => {
		const label = providerLabels?.[m.provider] ?? "";
		const hay = `${m.provider}/${m.id} ${label} ${m.name ?? ""}`.toLowerCase();
		return terms.every((t) => hay.includes(t));
	});
}

export function isCurrentModel(m: ModelOpt, current: ModelFacts["current"]): boolean {
	return !!current && current.id === m.id && (!current.provider || current.provider === m.provider);
}

export function currentModelOpt(models: ModelOpt[], current: ModelFacts["current"]): ModelOpt | null {
	if (!current) return null;
	return models.find((m) => isCurrentModel(m, current)) ?? models.find((m) => m.id === current.id) ?? null;
}

const THINKING_ORDER = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `levels` reordered as `auto`, `off`, then weakest → strongest effort. */
function sortThinkingLevels(levels: readonly string[]): string[] {
	const rank = (level: string) => {
		const i = THINKING_ORDER.indexOf(level);
		return i === -1 ? THINKING_ORDER.length : i;
	};
	return levels
		.map((level, i) => ({ level, i }))
		.sort((a, b) => rank(a.level) - rank(b.level) || a.i - b.i)
		.map((x) => x.level);
}

/** Live levels else catalog; `auto`, `off`, then ascending effort; current level kept even if unlisted. */
export function resolveThinkingLevels(
	opt: ModelOpt | null | undefined,
	liveThinking: string[] | null | undefined,
	currentLevel: string | null | undefined,
): string[] {
	const sup = liveThinking && liveThinking.length ? liveThinking : (opt?.thinking ?? []);
	const cur = currentLevel || "";
	if (!sup.length) return cur ? [cur] : [];
	const levels = ["auto", ...sup.filter((l) => l !== "auto")];
	if (!levels.includes("off")) levels.push("off");
	if (cur && !levels.includes(cur)) levels.push(cur);
	return sortThinkingLevels(levels);
}

/** Display name: the catalog name when it adds information, else the id. */
export function modelLabel(m: ModelOpt): string {
	return m.name && m.name !== m.id && m.name !== `${m.provider}/${m.id}` ? m.name : m.id;
}

/**
 * Extract clean model identifier from "provider/model" or snapshot names.
 * Drops organization prefix and trailing date/timestamp snapshots (e.g. -20250219).
 */
export function shortModel(text: string): string {
	if (!text) return "";
	const parsed = parseModelRef(text);
	let s = parsed ? parsed.id : text;
	const slash = s.lastIndexOf("/");
	if (slash >= 0) s = s.slice(slash + 1);
	// Strip trailing release/snapshot dates like -20250219 or -2024-08-06
	s = s.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
	return s;
}

export function modelKey(m: Pick<ModelOpt, "provider" | "id">): string {
	return `${m.provider}/${m.id}`;
}

export const RECENT_MODELS_STORAGE_KEY = "omp-workspace.recentModels";
export const RECENT_MODELS_CAP = 5;

function isRecordableKey(key: string): boolean {
	const k = key.trim();
	if (!k || k.startsWith("__") || k.startsWith("@")) return false;
	const slash = k.indexOf("/");
	return slash > 0 && slash < k.length - 1;
}

function writeRecentList(list: readonly string[]): void {
	try {
		localStorage.setItem(RECENT_MODELS_STORAGE_KEY, JSON.stringify(list));
	} catch {
		// Ignore storage errors (private mode / quota exceeded / non-DOM test env).
	}
}

/** Load persisted recent `provider/id` picks (most-recent-first, deduplicated, capped at 5). */
export function loadRecentModels(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_MODELS_STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const item of parsed) {
			if (typeof item !== "string") continue;
			const k = item.trim();
			if (!isRecordableKey(k) || seen.has(k)) continue;
			seen.add(k);
			out.push(k);
			if (out.length >= RECENT_MODELS_CAP) break;
		}
		return out;
	} catch {
		return [];
	}
}

/** Record a model pick at the front of recents, deduplicating and capping at 5. */
export function recordRecentModel(key: string): string[] {
	const current = loadRecentModels();
	const k = key.trim();
	if (!isRecordableKey(k)) return current;
	const next = [k, ...current.filter((item) => item !== k)].slice(0, RECENT_MODELS_CAP);
	writeRecentList(next);
	return next;
}

/** Remove a `provider/id` entry from persisted recents. */
export function removeRecentModel(key: string): string[] {
	const next = loadRecentModels().filter((item) => item !== key);
	writeRecentList(next);
	return next;
}

/** Resolve recent `provider/id` keys against the active model catalog in recent order. */
export function resolveRecentModels(models: readonly ModelOpt[], recentKeys: readonly string[]): ModelOpt[] {
	if (!models.length || !recentKeys.length) return [];
	const byKey = new Map<string, ModelOpt>();
	for (const m of models) {
		const k = modelKey(m);
		if (!byKey.has(k)) byKey.set(k, m);
	}
	const out: ModelOpt[] = [];
	for (const k of recentKeys) {
		const hit = byKey.get(k);
		if (hit) out.push(hit);
	}
	return out;
}

export interface ProviderInventoryRow {
	id: string;
	displayName?: string | null;
	enabled?: boolean;
	authNone?: boolean;
	key?: { kind?: string; envVar?: string | null; envSet?: boolean | null };
}

/** Whether a `/left/providers` row is enabled and has usable credentials (or requires none). */
export function isProviderConfigured(row: ProviderInventoryRow): boolean {
	if (row.enabled === false) return false;
	if (row.authNone) return true;
	const kind = row.key?.kind;
	if (kind === "none") return true;
	if (kind === "envVar") return row.key?.envSet !== false;
	if (kind === "plaintext" || kind === "command" || kind === "oauth" || kind === "loginStored") return true;
	return row.key?.envSet === true;
}

/** Group models by provider while preserving first-seen catalog order (matching desktop). */
export function groupModelsInOrder(models: readonly ModelOpt[]): ProviderGroup[] {
	const order: string[] = [];
	const by = new Map<string, ModelOpt[]>();
	for (const m of models) {
		let list = by.get(m.provider);
		if (!list) {
			list = [];
			by.set(m.provider, list);
			order.push(m.provider);
		}
		list.push(m);
	}
	return order.map((provider) => ({ provider, models: by.get(provider) ?? [] }));
}

/**
 * Partition provider groups into configured/enabled vs unconfigured providers.
 * Falls back to treating all groups as configured when inventory is unavailable or yields none.
 */
export function splitProviderGroups(
	groups: readonly ProviderGroup[],
	configuredProviders: ReadonlySet<string> | null | undefined,
	providerOrder?: readonly string[],
): { configured: ProviderGroup[]; unconfigured: ProviderGroup[] } {
	if (!configuredProviders || configuredProviders.size === 0) {
		return { configured: [...groups], unconfigured: [] };
	}
	const configured: ProviderGroup[] = [];
	const unconfigured: ProviderGroup[] = [];
	for (const g of groups) {
		if (configuredProviders.has(g.provider)) configured.push(g);
		else unconfigured.push(g);
	}
	if (configured.length === 0) {
		return { configured: [...groups], unconfigured: [] };
	}
	if (providerOrder && providerOrder.length > 0) {
		const rank = new Map<string, number>();
		providerOrder.forEach((id, i) => rank.set(id, i));
		configured.sort((a, b) => {
			const ra = rank.get(a.provider);
			const rb = rank.get(b.provider);
			if (ra !== undefined && rb !== undefined) return ra - rb;
			if (ra !== undefined) return -1;
			if (rb !== undefined) return 1;
			return 0;
		});
	}
	unconfigured.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
	return { configured, unconfigured };
}

/** True when session `contextTokens` exceeds the model's declared `contextWindow`. */
export function isModelContextTooSmall(
	model: Pick<ModelOpt, "contextWindow">,
	contextTokens: number | null | undefined,
): boolean {
	return (
		typeof contextTokens === "number" &&
		contextTokens > 0 &&
		typeof model.contextWindow === "number" &&
		model.contextWindow > 0 &&
		contextTokens > model.contextWindow
	);
}

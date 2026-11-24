import type { ProviderRow } from "../../lib/contracts";

/**
 * First-party models supporting Fast mode when OMP's live model metadata
 * omits `serviceTiers`. The live `serviceTiers` array always takes precedence.
 * Sources:
 * - https://learn.chatgpt.com/docs/agent-configuration/speed#fast-mode
 * - https://developers.openai.com/api/docs/pricing?latest-pricing=fast
 */
const CODEX_FAST_MODELS: Record<string, true> = {
	"gpt-6.2-astra": true,
	"gpt-6.2-sol": true,
	"gpt-6.1-sol": true,
	"gpt-6.1-terra": true,
	"gpt-6-astra": true,
	"gpt-6-sol": true,
	"gpt-6-luna": true,
};

const API_FAST_MODELS: Record<string, true> = {
	...CODEX_FAST_MODELS,
	"gpt-5.6-sol": true,
	"gpt-5.6-terra": true,
	"gpt-5.6-luna": true,
	"gpt-5.5": true,
	"gpt-5.4": true,
	"gpt-5.4-mini": true,
	"gpt-5.2": true,
	"gpt-5.1": true,
	"gpt-5": true,
	"gpt-5-mini": true,
	"gpt-4.1": true,
	"gpt-4.1-mini": true,
	"gpt-4o": true,
	"gpt-4o-mini": true,
	o3: true,
};

export type FastModeChannel = "api" | "codex";

function normalizeEndpoint(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function isFirstPartyCodexEndpoint(endpoint: string): boolean {
	return endpoint === "https://chatgpt.com/backend-api" || endpoint === "https://chatgpt.com/backend-api/codex";
}

function isFirstPartyOpenAIApi(api: unknown): boolean {
	return api === "openai-responses" || api === "openai-completions";
}

function isFirstPartyOpenAIEndpoint(endpoint: string): boolean {
	return endpoint === "https://api.openai.com/v1";
}

/**
 * Resolve the first-party fast-mode channel from confirmed live state, or null
 * when the model, endpoint, or capability cannot be verified.
 */
export function fastModeChannel(snapshot: unknown, modelKey: string): FastModeChannel | null {
	if (!snapshot || typeof snapshot !== "object") return null;
	const state = snapshot as Record<string, unknown>;
	if (typeof state.fastModeEnabled !== "boolean" || typeof state.fastModeActive !== "boolean") return null;
	if (!state.model || typeof state.model !== "object") return null;
	const { id, provider, api, baseUrl, serviceTiers } = state.model as Record<string, unknown>;
	if (typeof id !== "string" || typeof provider !== "string" || `${provider}/${id}` !== modelKey) return null;
	if (typeof baseUrl !== "string") return null;
	const endpoint = normalizeEndpoint(baseUrl);
	let channel: FastModeChannel;
	if (provider === "openai-codex" && api === "openai-codex-responses" && isFirstPartyCodexEndpoint(endpoint)) {
		channel = "codex";
	} else if (provider === "openai" && isFirstPartyOpenAIApi(api) && isFirstPartyOpenAIEndpoint(endpoint)) {
		channel = "api";
	} else {
		return null;
	}
	const models = channel === "codex" ? CODEX_FAST_MODELS : API_FAST_MODELS;
	const supported =
		Array.isArray(serviceTiers) && serviceTiers.length > 0
			? serviceTiers.includes("priority")
			: Object.prototype.hasOwnProperty.call(models, id);
	return supported ? channel : null;
}

/** True when `modelKey` names a built-in first-party OpenAI or Codex fast-mode model. */
export function isFirstPartyFastModel(modelKey: string): boolean {
	const slash = modelKey.indexOf("/");
	if (slash <= 0) return false;
	const provider = modelKey.slice(0, slash);
	const id = modelKey.slice(slash + 1);
	if (!id) return false;
	if (provider === "openai-codex") return Object.prototype.hasOwnProperty.call(CODEX_FAST_MODELS, id);
	if (provider === "openai") return Object.prototype.hasOwnProperty.call(API_FAST_MODELS, id);
	return false;
}

/**
 * Resolve the first-party fast-mode channel before a live `get_state` exists
 * (local drafts and stopped sessions), using loaded provider configuration to
 * reject `models.yml` custom endpoint overrides.
 */
export function offlineFastModeChannel(
	modelKey: string,
	providerRows: readonly ProviderRow[] | null | undefined,
): FastModeChannel | null {
	if (!isFirstPartyFastModel(modelKey) || !providerRows) return null;
	const slash = modelKey.indexOf("/");
	const provider = modelKey.slice(0, slash);
	const row = providerRows.find((r) => r.id === provider);
	if (row && !row.enabled) return null;

	if (provider === "openai-codex") {
		if (row?.baseUrl && !isFirstPartyCodexEndpoint(normalizeEndpoint(row.baseUrl))) return null;
		if (row?.api && row.api !== "openai-codex-responses") return null;
		return "codex";
	}

	if (row?.baseUrl && !isFirstPartyOpenAIEndpoint(normalizeEndpoint(row.baseUrl))) return null;
	if (row?.api && !isFirstPartyOpenAIApi(row.api)) return null;
	return "api";
}

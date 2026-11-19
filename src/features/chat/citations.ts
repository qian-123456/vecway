/**
 * OpenAI PUA citation marker (`\uE200...\uE201`) preprocessing and rehype plugin.
 *
 * Models using web/file search emit private-use control sequences such as
 * `\uE200cite\uE202https://...\uE202https://...\uE201` (or internal IDs like
 * `turn0search0`). Left raw, missing glyphs render as striped tofu boxes and
 * GFM autolink merges adjacent URLs together.
 *
 * Pipeline:
 * 1. `normalizeCitations` (before react-markdown, skipping code blocks/spans)
 *    extracts valid `http(s)://` URLs from closed `\uE200...\uE201` blocks into
 *    a Markdown-inert base64 token, strips internal-only/unclosed/stray PUA
 *    markers, and leaves code blocks/spans byte-for-byte intact.
 * 2. `rehypeCitationChips` (after `rehypeSanitize`) turns those tokens into
 *    `<cite-chip>` elements rendered by `MarkdownCitationChip`.
 */

import { commonmarkLanguage } from "@codemirror/lang-markdown";

/** Tag emitted by `rehypeCitationChips`; markdown maps it to a citation pill. */
export const CITE_CHIP_TAG = "cite-chip";

const PUA_ANY_RE = /[\uE200-\uE20F]/;
const PUA_ALL_RE = /[\uE200-\uE20F]/g;
const CLOSED_BLOCK_RE = /\uE200([^\uE201]*)\uE201/g;
const UNCLOSED_TAIL_RE = /\uE200[^\uE201]*$/;

// Use PUA sentinels outside OpenAI's U+E200..U+E20F range with a standard
// base64 payload (A-Za-z0-9+/=), which never triggers GFM autolinks or emphasis.
const TOKEN_PREFIX = "\uE000CITE:";
const TOKEN_SUFFIX = "\uE001";
const TOKEN_RE = /\uE000CITE:([A-Za-z0-9+/=]+)\uE001/g;

function encodeUrls(urls: readonly string[]): string {
	const json = JSON.stringify(urls);
	const bytes = new TextEncoder().encode(json);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function decodeUrls(encoded: string): string[] {
	try {
		const bin = atob(encoded);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return Array.isArray(parsed)
			? parsed.filter((u): u is string => typeof u === "string" && isHttpUrl(u))
			: [];
	} catch {
		return [];
	}
}

function isHttpUrl(raw: string): boolean {
	if (!/^https?:\/\/[^\s<>]+$/i.test(raw)) return false;
	try {
		const u = new URL(raw);
		return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname);
	} catch {
		return false;
	}
}

/** Extract deduplicated http(s) URLs from a `\uE200...\uE201` body. */
function extractBlockUrls(body: string): string[] {
	const parts = body.split(/[\uE202-\uE20F]/);
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const part of parts) {
		const candidate = part.trim();
		if (!isHttpUrl(candidate) || seen.has(candidate)) continue;
		seen.add(candidate);
		urls.push(candidate);
	}
	return urls;
}

function normalizeSegment(segment: string): string {
	if (!PUA_ANY_RE.test(segment)) return segment;
	const replaced = segment.replace(CLOSED_BLOCK_RE, (_match, body: string) => {
		const urls = extractBlockUrls(body);
		return urls.length > 0 ? `${TOKEN_PREFIX}${encodeUrls(urls)}${TOKEN_SUFFIX}` : "";
	});
	// Hide an unclosed `\uE200...` tail while streaming so partial control
	// characters do not flash before `\uE201` arrives.
	return replaced.replace(UNCLOSED_TAIL_RE, "").replace(PUA_ALL_RE, "");
}

/**
 * Normalize OpenAI PUA citation blocks in prose before markdown parsing,
 * leaving CommonMark code blocks and inline code spans intact.
 */
export function normalizeCitations(text: string): string {
	if (!PUA_ANY_RE.test(text)) return text;
	if (!/[`~\t]| {4}/.test(text)) return normalizeSegment(text);
	let out = "";
	let cursor = 0;
	commonmarkLanguage.parser.parse(text).iterate({
		enter(node) {
			if (node.name !== "FencedCode" && node.name !== "CodeBlock" && node.name !== "InlineCode") return;
			out += normalizeSegment(text.slice(cursor, node.from));
			out += text.slice(node.from, node.to);
			cursor = node.to;
			return false;
		},
	});
	return out + normalizeSegment(text.slice(cursor));
}

/** Display host for a citation pill (strips leading `www.`). */
export function formatCitationHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./i, "");
	} catch {
		return url;
	}
}

const KNOWN_TERMS: Record<string, string> = {
	api: "API",
	cli: "CLI",
	css: "CSS",
	html: "HTML",
	id: "ID",
	ios: "iOS",
	js: "JS",
	json: "JSON",
	macos: "macOS",
	oauth: "OAuth",
	sdk: "SDK",
	ts: "TS",
	ui: "UI",
	url: "URL",
};

function humanizeSlug(raw: string): string {
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		/* keep raw */
	}
	const cleaned = decoded.replace(/\.(html?|md|php|aspx?)$/i, "");
	const words = cleaned.split(/[-_+\s]+/).filter(Boolean);
	if (words.length === 0) return "";
	return words
		.map((w) => {
			const lower = w.toLowerCase();
			if (KNOWN_TERMS[lower]) return KNOWN_TERMS[lower];
			return lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join(" ");
}

/**
 * Derive a human-readable title and host breadcrumb from a citation URL
 * without making any network request.
 */
export function formatCitationPreview(url: string): {
	host: string;
	title: string;
	breadcrumb: string;
} {
	try {
		const u = new URL(url);
		const host = u.hostname.replace(/^www\./i, "");
		const segments = u.pathname
			.split("/")
			.filter(Boolean)
			.filter((s) => !/^index\.(html?|php)$/i.test(s));
		if (segments.length === 0) {
			return { host, title: host, breadcrumb: url };
		}
		const last = segments[segments.length - 1];
		const slugTitle = humanizeSlug(last);
		const title = slugTitle || host;
		const parents = segments.slice(0, -1).slice(0, 2);
		const breadcrumb = parents.length > 0 ? `${host} › ${parents.join(" › ")}` : host;
		return { host, title, breadcrumb };
	} catch {
		return { host: url, title: url, breadcrumb: "" };
	}
}

/** Parse `data-cite-urls` / `dataCiteUrls` property back into validated URLs. */
export function parseCitationUrls(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((u): u is string => typeof u === "string" && isHttpUrl(u))
			: [];
	} catch {
		return [];
	}
}

interface HastNode {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
}

function splitCitationTokens(value: string): HastNode[] {
	if (!value.includes(TOKEN_PREFIX)) return [{ type: "text", value }];
	const out: HastNode[] = [];
	let cursor = 0;
	TOKEN_RE.lastIndex = 0;
	for (const match of value.matchAll(TOKEN_RE)) {
		const idx = match.index ?? 0;
		if (idx > cursor) out.push({ type: "text", value: value.slice(cursor, idx) });
		const urls = decodeUrls(match[1]);
		if (urls.length > 0) {
			out.push({
				type: "element",
				tagName: CITE_CHIP_TAG,
				properties: { dataCiteUrls: JSON.stringify(urls) },
				children: [],
			});
		}
		cursor = idx + match[0].length;
	}
	if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
	return out.length > 0 ? out : [{ type: "text", value: "" }];
}

function walkHast(node: HastNode): void {
	const children = node.children;
	if (!children || children.length === 0) return;
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child.type === "text") {
			const parts = splitCitationTokens(child.value ?? "");
			if (parts.length !== 1 || parts[0] !== child) {
				children.splice(i, 1, ...parts);
				i += parts.length - 1;
			}
			continue;
		}
		if (child.type === "element") {
			if (child.tagName === "a" || child.tagName === "code" || child.tagName === "pre") continue;
			walkHast(child);
		}
	}
}

/** Rehype plugin: turn encoded citation tokens in prose into `<cite-chip>`. */
export function rehypeCitationChips() {
	return (tree: HastNode) => {
		walkHast(tree);
	};
}

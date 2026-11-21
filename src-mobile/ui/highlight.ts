import type { HighlightResult, HLJSApi, LanguageFn } from "highlight.js";
import { useEffect, useMemo, useState } from "react";
import type { Options } from "react-markdown";

type PluggableList = NonNullable<Options["rehypePlugins"]>;

interface EmitterNode {
	scope?: string;
	children?: EmitterChild[];
}
type EmitterChild = string | EmitterNode;

interface HastText {
	type: "text";
	value: string;
}

interface HastElement {
	type: "element";
	tagName: string;
	properties: Record<string, unknown>;
	children: HastContent[];
}

type HastContent = HastText | HastElement;

interface HastNode {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
}

const NO_PLUGINS: PluggableList = [];

type CanonicalLanguage =
	| "bash"
	| "css"
	| "diff"
	| "go"
	| "ini"
	| "javascript"
	| "json"
	| "markdown"
	| "python"
	| "rust"
	| "shell"
	| "sql"
	| "typescript"
	| "xml"
	| "yaml"
	| "plaintext";

const LANGUAGE_LOADERS: Record<CanonicalLanguage, () => Promise<{ default: LanguageFn }>> = {
	bash: () => import("highlight.js/lib/languages/bash"),
	css: () => import("highlight.js/lib/languages/css"),
	diff: () => import("highlight.js/lib/languages/diff"),
	go: () => import("highlight.js/lib/languages/go"),
	ini: () => import("highlight.js/lib/languages/ini"),
	javascript: () => import("highlight.js/lib/languages/javascript"),
	json: () => import("highlight.js/lib/languages/json"),
	markdown: () => import("highlight.js/lib/languages/markdown"),
	python: () => import("highlight.js/lib/languages/python"),
	rust: () => import("highlight.js/lib/languages/rust"),
	shell: () => import("highlight.js/lib/languages/shell"),
	sql: () => import("highlight.js/lib/languages/sql"),
	typescript: () => import("highlight.js/lib/languages/typescript"),
	xml: () => import("highlight.js/lib/languages/xml"),
	yaml: () => import("highlight.js/lib/languages/yaml"),
	plaintext: () => import("highlight.js/lib/languages/plaintext"),
};

const LANGUAGE_ALIASES: Record<string, CanonicalLanguage> = {
	bash: "bash",
	sh: "bash",
	zsh: "bash",
	css: "css",
	diff: "diff",
	patch: "diff",
	go: "go",
	golang: "go",
	ini: "ini",
	toml: "ini",
	javascript: "javascript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	markdown: "markdown",
	md: "markdown",
	mkdown: "markdown",
	mkd: "markdown",
	python: "python",
	py: "python",
	gyp: "python",
	ipython: "python",
	rust: "rust",
	rs: "rust",
	shell: "shell",
	console: "shell",
	shellsession: "shell",
	sql: "sql",
	typescript: "typescript",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	xml: "xml",
	html: "xml",
	xhtml: "xml",
	rss: "xml",
	atom: "xml",
	xjb: "xml",
	xsd: "xml",
	xsl: "xml",
	plist: "xml",
	wsf: "xml",
	svg: "xml",
	yaml: "yaml",
	yml: "yaml",
	plaintext: "plaintext",
	text: "plaintext",
	txt: "plaintext",
};

const LANGUAGE_DEPS: Partial<Record<CanonicalLanguage, readonly CanonicalLanguage[]>> = {
	shell: ["bash"],
	markdown: ["xml"],
};

const FENCE_LANG_RE =
	/^[^\S\r\n]*(?:>[^\S\r\n]*)*(?:(?:[-+*]|\d+[.)])[^\S\r\n]+)?(?:`{3,}|~{3,})[^\S\r\n]*([^\s`~]+)/gm;

let hljsInstance: HLJSApi | null = null;
let corePromise: Promise<HLJSApi> | null = null;
const registered = new Set<CanonicalLanguage>();
const langPromises = new Map<CanonicalLanguage, Promise<void>>();
let registryVersion = 0;
let cachedPluginVersion = -1;
let cachedPlugins: PluggableList = NO_PLUGINS;

function resolveCanonicalLanguage(raw: string): CanonicalLanguage | null {
	const normalized = raw.trim().toLowerCase().replace(/^\.+/, "");
	return LANGUAGE_ALIASES[normalized] ?? null;
}

/** Lightweight scan for fenced code block languages actually referenced in `text`. */
export function detectHighlightLanguages(text: string): CanonicalLanguage[] {
	if (!text || (!text.includes("```") && !text.includes("~~~"))) return [];
	const found = new Set<CanonicalLanguage>();
	FENCE_LANG_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = FENCE_LANG_RE.exec(text)) !== null) {
		const lang = resolveCanonicalLanguage(match[1] ?? "");
		if (!lang) continue;
		found.add(lang);
		const deps = LANGUAGE_DEPS[lang];
		if (deps) {
			for (const dep of deps) found.add(dep);
		}
	}
	return found.size > 0 ? Array.from(found).sort() : [];
}

function isHastNode(value: unknown): value is HastNode {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function isEmitterNode(value: unknown): value is EmitterNode {
	if (typeof value !== "object" || value === null) return false;
	if ("scope" in value && value.scope !== undefined && typeof value.scope !== "string") return false;
	if ("children" in value && value.children !== undefined && !Array.isArray(value.children)) return false;
	return true;
}

function emitterRootChildren(emitter: unknown): readonly EmitterChild[] | undefined {
	if (typeof emitter !== "object" || emitter === null || !("rootNode" in emitter)) return undefined;
	const root = emitter.rootNode;
	return isEmitterNode(root) ? root.children : undefined;
}

function scopeToClasses(scope: string): string[] {
	if (scope.startsWith("language:")) {
		return [`language-${scope.slice("language:".length)}`];
	}
	if (scope.includes(".")) {
		const [first, ...rest] = scope.split(".");
		return [`hljs-${first}`, ...rest.map((part, i) => `${part}${"_".repeat(i + 1)}`)];
	}
	return [`hljs-${scope}`];
}

function toHastChildren(nodes: readonly EmitterChild[] | undefined): HastContent[] {
	if (!nodes?.length) return [];
	const out: HastContent[] = [];
	for (const child of nodes) {
		if (typeof child === "string") {
			if (child) out.push({ type: "text", value: child });
			continue;
		}
		const children = toHastChildren(child.children);
		if (child.scope) {
			out.push({
				type: "element",
				tagName: "span",
				properties: { className: scopeToClasses(child.scope) },
				children,
			});
		} else {
			for (const c of children) out.push(c);
		}
	}
	return out;
}

function extractLanguage(node: HastNode): string | null {
	const raw = node.properties?.className;
	const classes = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\s+/) : [];
	let lang: string | null = null;
	for (const entry of classes) {
		const value = String(entry);
		if (value === "no-highlight" || value === "nohighlight") return null;
		if (!lang && value.startsWith("language-")) lang = value.slice(9);
		else if (!lang && value.startsWith("lang-")) lang = value.slice(5);
	}
	return lang;
}

function extractText(node: HastNode): string {
	if (node.type === "text" && typeof node.value === "string") return node.value;
	if (!node.children?.length) return "";
	let out = "";
	for (const child of node.children) out += extractText(child);
	return out;
}

function visitCodeBlocks(node: HastNode, parent: HastNode | null, onCode: (codeNode: HastNode) => void): void {
	if (
		node.type === "element" &&
		node.tagName === "code" &&
		parent?.type === "element" &&
		parent.tagName === "pre"
	) {
		onCode(node);
		return;
	}
	if (!node.children) return;
	for (const child of node.children) {
		visitCodeBlocks(child, node, onCode);
	}
}

function createRehypeHighlightPlugin(hljs: HLJSApi): PluggableList[number] {
	return function rehypeMobileHighlight() {
		return (tree: unknown) => {
			if (!isHastNode(tree)) return;
			visitCodeBlocks(tree, null, (codeNode) => {
				const rawLang = extractLanguage(codeNode);
				if (!rawLang) return;
				const lang = hljs.getLanguage(rawLang) ? rawLang : resolveCanonicalLanguage(rawLang);
				if (!lang || !hljs.getLanguage(lang)) return;
				const text = extractText(codeNode);
				let result: HighlightResult;
				try {
					result = hljs.highlight(text, { language: lang, ignoreIllegals: true });
				} catch {
					return;
				}
				const props = (codeNode.properties ??= {});
				const classes = Array.isArray(props.className)
					? props.className.map(String)
					: typeof props.className === "string"
						? props.className.split(/\s+/).filter(Boolean)
						: [];
				if (!classes.includes("hljs")) classes.unshift("hljs");
				props.className = classes;
				const children = toHastChildren(emitterRootChildren(result._emitter));
				if (children.length > 0) codeNode.children = children;
			});
		};
	};
}

function currentPlugins(): PluggableList {
	if (!hljsInstance) return NO_PLUGINS;
	if (cachedPluginVersion !== registryVersion) {
		cachedPlugins = [createRehypeHighlightPlugin(hljsInstance)];
		cachedPluginVersion = registryVersion;
	}
	return cachedPlugins;
}

function ensureCore(): Promise<HLJSApi> {
	if (hljsInstance) return Promise.resolve(hljsInstance);
	corePromise ??= import("highlight.js/lib/core")
		.then(({ default: hljsCore }) => {
			hljsInstance = hljsCore.newInstance();
			return hljsInstance;
		})
		.catch((err) => {
			corePromise = null;
			throw err;
		});
	return corePromise;
}

/** Loads highlight.js core + only the specific language grammar(s) needed by the rendered block. */
async function loadLanguages(langs: readonly CanonicalLanguage[]): Promise<PluggableList> {
	if (langs.length === 0) return NO_PLUGINS;
	const hljs = await ensureCore();
	const pending: Promise<void>[] = [];
	for (const lang of langs) {
		if (registered.has(lang)) continue;
		let job = langPromises.get(lang);
		if (!job) {
			job = LANGUAGE_LOADERS[lang]()
				.then(({ default: grammar }) => {
					if (!registered.has(lang)) {
						hljs.registerLanguage(lang, grammar);
						registered.add(lang);
						registryVersion++;
					}
				})
				.finally(() => {
					langPromises.delete(lang);
				});
			langPromises.set(lang, job);
		}
		pending.push(job);
	}
	if (pending.length > 0) await Promise.all(pending);
	return currentPlugins();
}

function allReady(langs: readonly CanonicalLanguage[]): boolean {
	if (!hljsInstance || langs.length === 0) return false;
	for (const lang of langs) {
		if (!registered.has(lang)) return false;
	}
	return true;
}

/**
 * Returns a stable rehype highlight plugin list on demand:
 * - Loads ZERO chunks when disabled or when `text` contains no fenced code block with a supported language.
 * - Loads only highlight.js core + the specific grammar(s) present in `text`.
 */
export function useHighlightPlugins(enabled: boolean, text = ""): PluggableList {
	const langs = useMemo(() => (enabled ? detectHighlightLanguages(text) : []), [enabled, text]);
	const langsKey = langs.join(",");
	const readyNow = enabled && langs.length > 0 && allReady(langs);
	const [plugins, setPlugins] = useState<PluggableList>(() => (readyNow ? currentPlugins() : NO_PLUGINS));

	useEffect(() => {
		if (!enabled || !langsKey) return;
		const needed = langsKey.split(",") as CanonicalLanguage[];
		if (allReady(needed)) {
			setPlugins(currentPlugins());
			return;
		}
		let alive = true;
		void loadLanguages(needed)
			.then((p) => {
				if (alive) setPlugins(p);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [enabled, langsKey]);

	if (!enabled || langs.length === 0) return NO_PLUGINS;
	return readyNow ? currentPlugins() : plugins;
}

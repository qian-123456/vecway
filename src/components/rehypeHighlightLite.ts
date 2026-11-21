/**
 * Lightweight rehype syntax-highlighting plugin built directly on
 * `highlight.js/lib/core`. Unlike `rehype-highlight`, this never imports
 * `lowlight/common` (37 languages) so unused grammars stay out of the bundle
 * while still picking up lazy-loaded grammars added to `languages` on demand.
 */

import hljs from "highlight.js/lib/core";
import type { HLJSApi, LanguageFn } from "highlight.js";

export interface RehypeHighlightLiteOptions {
	/** Mutable or static map of grammar name → highlight.js language factory. */
	languages?: Readonly<Record<string, LanguageFn>> | null;
	/** Optional extra language aliases (canonical name → alias or alias list). */
	aliases?: Readonly<Record<string, ReadonlyArray<string> | string>> | null;
	/** Auto-detect language when a code block has no `language-*` class (default: false). */
	detect?: boolean | null;
	/** Language names to leave unhighlighted. */
	plainText?: ReadonlyArray<string> | null;
	/** CSS class prefix (default: "hljs-"). */
	prefix?: string | null;
}

interface HastNode {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
}

interface HljsDataNode {
	scope?: string;
	children?: HljsTokenNode[];
}

type HljsTokenNode = string | HljsDataNode;

interface HljsEmitterLike {
	rootNode?: HljsDataNode;
}

interface CachedHljs {
	instance: HLJSApi;
	synced: Map<string, LanguageFn>;
}

const instanceByLanguages = new WeakMap<object, CachedHljs>();

function getHljsInstance(
	languages?: Readonly<Record<string, LanguageFn>> | null,
	aliases?: Readonly<Record<string, ReadonlyArray<string> | string>> | null,
): HLJSApi {
	let entry: CachedHljs | undefined;
	if (languages) {
		entry = instanceByLanguages.get(languages);
		if (!entry) {
			entry = { instance: hljs.newInstance(), synced: new Map() };
			instanceByLanguages.set(languages, entry);
		}
		for (const name in languages) {
			if (!Object.prototype.hasOwnProperty.call(languages, name)) continue;
			const fn = languages[name];
			if (fn && entry.synced.get(name) !== fn) {
				entry.instance.registerLanguage(name, fn);
				entry.synced.set(name, fn);
			}
		}
	} else {
		entry = { instance: hljs.newInstance(), synced: new Map() };
	}
	if (aliases) {
		for (const name in aliases) {
			if (!Object.prototype.hasOwnProperty.call(aliases, name)) continue;
			const aliasList = aliases[name];
			if (aliasList) {
				entry.instance.registerAliases(
					typeof aliasList === "string" ? aliasList : [...aliasList],
					{ languageName: name },
				);
			}
		}
	}
	return entry.instance;
}

/**
 * Convert a highlight.js emitter scope name into HAST `className` tokens,
 * matching highlight.js's HTMLRenderer rules:
 * - `"language:js"` → `["language-js"]`
 * - `"keyword"` → `["hljs-keyword"]`
 * - `"title.function"` → `["hljs-title", "function_"]`
 * - `"title.class.inherited"` → `["hljs-title", "class_", "inherited__"]`
 */
export function scopeToClassNames(scope: string, prefix = "hljs-"): string[] {
	if (scope.startsWith("language:")) {
		return [`language-${scope.slice("language:".length)}`];
	}
	if (scope.includes(".")) {
		const pieces = scope.split(".");
		const classes = [`${prefix}${pieces[0]}`];
		for (let i = 1; i < pieces.length; i++) {
			classes.push(`${pieces[i]}${"_".repeat(i)}`);
		}
		return classes;
	}
	return [`${prefix}${scope}`];
}

function tokenNodesToHast(nodes: readonly HljsTokenNode[] | undefined, prefix: string): HastNode[] {
	const out: HastNode[] = [];
	if (!nodes) return out;
	for (const child of nodes) {
		if (typeof child === "string") {
			if (child.length > 0) out.push({ type: "text", value: child });
			continue;
		}
		const nested = tokenNodesToHast(child.children, prefix);
		if (child.scope) {
			out.push({
				type: "element",
				tagName: "span",
				properties: { className: scopeToClassNames(child.scope, prefix) },
				children: nested,
			});
		} else {
			for (const item of nested) out.push(item);
		}
	}
	return out;
}

function classListOf(node: HastNode): string[] {
	const cls = node.properties?.className;
	if (Array.isArray(cls)) return cls.map(String);
	if (typeof cls === "string") return cls.split(/\s+/).filter(Boolean);
	return [];
}

function extractLanguage(classes: readonly string[]): string | false | undefined {
	let lang: string | undefined;
	for (const value of classes) {
		if (value === "no-highlight" || value === "nohighlight") return false;
		if (!lang && value.startsWith("lang-")) lang = value.slice(5);
		if (!lang && value.startsWith("language-")) lang = value.slice(9);
	}
	return lang;
}

function extractCodeText(node: HastNode): string {
	if (node.type === "text") return node.value ?? "";
	if (node.type === "element" && node.tagName === "br") return "\n";
	const children = node.children;
	if (!children || children.length === 0) return "";
	let out = "";
	for (const child of children) out += extractCodeText(child);
	return out;
}

export function rehypeHighlightLite(options?: RehypeHighlightLiteOptions | null) {
	const languages = options?.languages;
	const aliases = options?.aliases;
	const detect = Boolean(options?.detect);
	const plainText = options?.plainText;
	const prefix = options?.prefix ?? "hljs-";
	const dashAt = prefix.indexOf("-");
	const baseClass = dashAt === -1 ? prefix : prefix.slice(0, dashAt);

	return (tree: HastNode) => {
		let instance: HLJSApi | null = null;

		const walk = (node: HastNode, parent: HastNode | null): void => {
			if (
				node.type === "element" &&
				node.tagName === "code" &&
				parent?.type === "element" &&
				parent.tagName === "pre"
			) {
				const classes = classListOf(node);
				const lang = extractLanguage(classes);
				if (lang === false || (!lang && !detect) || (lang && plainText?.includes(lang))) {
					return;
				}
				const hljsApi = (instance ??= getHljsInstance(languages, aliases));
				if (lang && !hljsApi.getLanguage(lang)) {
					return;
				}
				if (!lang && hljsApi.listLanguages().length === 0) {
					return;
				}
				const code = extractCodeText(node);
				try {
					const result = lang
						? hljsApi.highlight(code, { language: lang, ignoreIllegals: true })
						: hljsApi.highlightAuto(code);
					const rootNode = (result._emitter as unknown as HljsEmitterLike | undefined)?.rootNode;
					const highlighted = tokenNodesToHast(rootNode?.children, prefix);
					const nextClasses = [...classes];
					if (baseClass && !nextClasses.includes(baseClass)) {
						nextClasses.unshift(baseClass);
					}
					if (!lang && result.language) {
						const detectedClass = `language-${result.language}`;
						if (!nextClasses.includes(detectedClass)) {
							nextClasses.push(detectedClass);
						}
					}
					node.properties = { ...(node.properties ?? {}), className: nextClasses };
					if (highlighted.length > 0) {
						node.children = highlighted;
					}
				} catch {
					// Plain text fallback: leave original code children untouched.
				}
				return;
			}
			const children = node.children;
			if (!children || children.length === 0) return;
			for (const child of children) {
				walk(child, node);
			}
		};

		walk(tree, null);
	};
}

export default rehypeHighlightLite;

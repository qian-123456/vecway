import type { HighlightResult, HLJSApi, LanguageFn } from "highlight.js";
import { useEffect, useState } from "react";
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

let loaded: PluggableList | null = null;
let loading: Promise<PluggableList> | null = null;

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
				const lang = extractLanguage(codeNode);
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

/** Loads highlight.js core and a small set of languages into a separate chunk, once (no lowlight/common). */
function load(): Promise<PluggableList> {
	loading ??= (async () => {
		const [
			{ default: hljsCore },
			{ default: bash },
			{ default: css },
			{ default: diff },
			{ default: go },
			{ default: ini },
			{ default: javascript },
			{ default: json },
			{ default: markdown },
			{ default: python },
			{ default: rust },
			{ default: shell },
			{ default: sql },
			{ default: typescript },
			{ default: xml },
			{ default: yaml },
			{ default: plaintext },
		] = await Promise.all([
			import("highlight.js/lib/core"),
			import("highlight.js/lib/languages/bash"),
			import("highlight.js/lib/languages/css"),
			import("highlight.js/lib/languages/diff"),
			import("highlight.js/lib/languages/go"),
			import("highlight.js/lib/languages/ini"),
			import("highlight.js/lib/languages/javascript"),
			import("highlight.js/lib/languages/json"),
			import("highlight.js/lib/languages/markdown"),
			import("highlight.js/lib/languages/python"),
			import("highlight.js/lib/languages/rust"),
			import("highlight.js/lib/languages/shell"),
			import("highlight.js/lib/languages/sql"),
			import("highlight.js/lib/languages/typescript"),
			import("highlight.js/lib/languages/xml"),
			import("highlight.js/lib/languages/yaml"),
			import("highlight.js/lib/languages/plaintext"),
		]);
		const hljs = hljsCore.newInstance();
		const languages: ReadonlyArray<readonly [string, LanguageFn]> = [
			["bash", bash],
			["css", css],
			["diff", diff],
			["go", go],
			["ini", ini],
			["javascript", javascript],
			["json", json],
			["markdown", markdown],
			["python", python],
			["rust", rust],
			["shell", shell],
			["sql", sql],
			["typescript", typescript],
			["xml", xml],
			["yaml", yaml],
			["plaintext", plaintext],
		];
		for (const [name, grammar] of languages) {
			hljs.registerLanguage(name, grammar);
		}
		const plugins: PluggableList = [createRehypeHighlightPlugin(hljs)];
		loaded = plugins;
		return plugins;
	})().catch((err) => {
		loading = null;
		throw err;
	});
	return loading;
}

/**
 * Returns a stable rehype plugin list: empty until highlighting is enabled and loaded,
 * then the module-level highlight plugin list (same identity for every caller).
 */
export function useHighlightPlugins(enabled: boolean): PluggableList {
	const [plugins, setPlugins] = useState<PluggableList>(loaded ?? NO_PLUGINS);
	useEffect(() => {
		if (!enabled || loaded) return;
		let alive = true;
		void load()
			.then((p) => {
				if (alive) setPlugins(p);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [enabled]);
	return enabled ? (loaded ?? plugins) : NO_PLUGINS;
}

import type { LanguageFn } from "highlight.js";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import { describe, expect, it } from "vitest";
import { rehypeHighlightLite, scopeToClassNames } from "./rehypeHighlightLite";

interface TestHastNode {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: TestHastNode[];
}

function makeCodeBlock(code: string, className?: string[] | string): TestHastNode {
	return {
		type: "root",
		children: [
			{
				type: "element",
				tagName: "pre",
				properties: {},
				children: [
					{
						type: "element",
						tagName: "code",
						properties: className === undefined ? {} : { className },
						children: [{ type: "text", value: code }],
					},
				],
			},
		],
	};
}

function collectSpans(node: TestHastNode): Array<{ classes: string[]; text: string }> {
	const out: Array<{ classes: string[]; text: string }> = [];
	const textOf = (n: TestHastNode): string =>
		n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join("");
	const walk = (n: TestHastNode) => {
		if (n.type === "element" && n.tagName === "span") {
			const cls = n.properties?.className;
			out.push({
				classes: Array.isArray(cls) ? cls.map(String) : [],
				text: textOf(n),
			});
		}
		for (const child of n.children ?? []) walk(child);
	};
	walk(node);
	return out;
}

describe("scopeToClassNames", () => {
	it("matches highlight.js CSS class conventions for simple, dotted, and sublanguage scopes", () => {
		expect(scopeToClassNames("keyword")).toEqual(["hljs-keyword"]);
		expect(scopeToClassNames("title.function")).toEqual(["hljs-title", "function_"]);
		expect(scopeToClassNames("title.class.inherited")).toEqual([
			"hljs-title",
			"class_",
			"inherited__",
		]);
		expect(scopeToClassNames("language:javascript")).toEqual(["language-javascript"]);
		expect(scopeToClassNames("title.function", "code-")).toEqual(["code-title", "function_"]);
	});
});

describe("rehypeHighlightLite", () => {
	it("highlights registered languages and aliases into HAST spans with nested dotted scopes", () => {
		const tree = makeCodeBlock("function greet(name: string) { return 42; }", ["language-ts"]);
		rehypeHighlightLite({ detect: false, languages: { typescript } })(tree);

		const codeNode = tree.children![0].children![0];
		expect(codeNode.properties?.className).toEqual(["hljs", "language-ts"]);

		const spans = collectSpans(codeNode);
		expect(spans.some((s) => s.classes.includes("hljs-keyword") && s.text === "function")).toBe(true);
		expect(
			spans.some(
				(s) =>
					s.classes.includes("hljs-title") &&
					s.classes.includes("function_") &&
					s.text === "greet",
			),
		).toBe(true);
		expect(spans.some((s) => s.classes.includes("hljs-number") && s.text === "42")).toBe(true);
	});

	it("syncs newly lazy-loaded grammars added to the languages map between transforms", () => {
		const languages: Record<string, LanguageFn> = { typescript };
		const transform = rehypeHighlightLite({ detect: false, languages });

		const beforeTree = makeCodeBlock("def hi():\n    return 1", ["language-python"]);
		transform(beforeTree);
		expect(collectSpans(beforeTree)).toEqual([]);

		// Simulate markdownAssets mutating HIGHLIGHT_LANGUAGES after dynamic import resolves.
		languages.python = python;

		const afterTree = makeCodeBlock("def hi():\n    return 1", ["language-python"]);
		transform(afterTree);
		const spans = collectSpans(afterTree);
		expect(spans.some((s) => s.classes.includes("hljs-keyword") && s.text === "def")).toBe(true);
		expect(
			spans.some(
				(s) =>
					s.classes.includes("hljs-title") &&
					s.classes.includes("function_") &&
					s.text === "hi",
			),
		).toBe(true);
	});

	it("skips inline code, unclassed blocks when detect=false, no-highlight, plainText, and unknown languages", () => {
		const inlineTree: TestHastNode = {
			type: "root",
			children: [
				{
					type: "element",
					tagName: "p",
					properties: {},
					children: [
						{
							type: "element",
							tagName: "code",
							properties: { className: ["language-ts"] },
							children: [{ type: "text", value: "const x = 1;" }],
						},
					],
				},
			],
		};
		const transform = rehypeHighlightLite({
			detect: false,
			languages: { typescript },
			plainText: ["ts"],
		});
		transform(inlineTree);
		expect(collectSpans(inlineTree)).toEqual([]);

		const plainTextTree = makeCodeBlock("const x = 1;", ["language-ts"]);
		transform(plainTextTree);
		expect(collectSpans(plainTextTree)).toEqual([]);

		const noHighlightTree = makeCodeBlock("const x = 1;", ["language-typescript", "no-highlight"]);
		transform(noHighlightTree);
		expect(collectSpans(noHighlightTree)).toEqual([]);

		const unclassedTree = makeCodeBlock("const x = 1;");
		transform(unclassedTree);
		expect(collectSpans(unclassedTree)).toEqual([]);

		const unknownTree = makeCodeBlock("graph TD; A-->B;", ["language-mermaid"]);
		transform(unknownTree);
		expect(collectSpans(unknownTree)).toEqual([]);
	});

	it("falls back to plain text cleanly when highlighting throws or code is empty", () => {
		const brokenGrammar: LanguageFn = () => {
			throw new Error("broken grammar");
		};
		const errorTree = makeCodeBlock("raw code", ["language-broken"]);
		rehypeHighlightLite({ detect: false, languages: { broken: brokenGrammar } })(errorTree);
		const errorCode = errorTree.children![0].children![0];
		expect(errorCode.children).toEqual([{ type: "text", value: "raw code" }]);

		const emptyTree = makeCodeBlock("", ["language-typescript"]);
		rehypeHighlightLite({ detect: false, languages: { typescript } })(emptyTree);
		const emptyCode = emptyTree.children![0].children![0];
		expect(emptyCode.children).toEqual([{ type: "text", value: "" }]);
	});
});

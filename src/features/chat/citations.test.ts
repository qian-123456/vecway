import { describe, expect, it } from "vitest";
import {
	CITE_CHIP_TAG,
	formatCitationHost,
	normalizeCitations,
	parseCitationUrls,
	rehypeCitationChips,
} from "./citations";

interface TestNode {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: TestNode[];
}

describe("normalizeCitations", () => {
	it("returns text unchanged when no PUA markers are present", () => {
		const input = "Plain text with https://developer.apple.com/ in prose.";
		expect(normalizeCitations(input)).toBe(input);
	});

	it("extracts multiple URLs from a closed cite block and preserves order & deduplication", () => {
		const u1 = "https://developer.apple.com/help/account/certificates/create-developer-id-certificates/";
		const u2 = "https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution";
		const u3 = "https://v2.tauri.app/distribute/sign/macos/";
		const input = `Apple 公证是自动检查。\uE200cite\uE202${u1}\uE202${u2}\uE202${u1}\uE202${u3}\uE201`;

		const normalized = normalizeCitations(input);
		expect(normalized).not.toContain("\uE200");
		expect(normalized).not.toContain("\uE201");
		expect(normalized).not.toContain("\uE202");
		expect(normalized).not.toContain("https://");

		const tree: TestNode = {
			type: "root",
			children: [{ type: "element", tagName: "p", children: [{ type: "text", value: normalized }] }],
		};
		rehypeCitationChips()(tree);

		const pChildren = tree.children?.[0].children ?? [];
		expect(pChildren).toHaveLength(2);
		expect(pChildren[0]).toEqual({ type: "text", value: "Apple 公证是自动检查。" });
		expect(pChildren[1].tagName).toBe(CITE_CHIP_TAG);
		expect(parseCitationUrls(pChildren[1].properties?.dataCiteUrls)).toEqual([u1, u2, u3]);
	});

	it("strips internal-only citation blocks without URLs", () => {
		const input = "检查结果如下\uE200cite\uE202turn0search0\uE202turn0search1\uE201。";
		expect(normalizeCitations(input)).toBe("检查结果如下。");
	});

	it("hides unclosed streaming tail and strips stray PUA control chars", () => {
		const streaming = "正在说明\uE200cite\uE202https://example.com/partial";
		expect(normalizeCitations(streaming)).toBe("正在说明");

		const stray = "异常字符\uE202清理\uE201测试";
		expect(normalizeCitations(stray)).toBe("异常字符清理测试");
	});

	it("keeps fenced code blocks and inline code spans intact", () => {
		const codeSample = "`\uE200cite\uE202https://example.com\uE201`";
		const fenced = "```\n\uE200cite\uE202https://example.com\uE201\n```";
		const prose = "正文\uE200cite\uE202https://example.com\uE201";
		const result = normalizeCitations(`${codeSample}\n\n${fenced}\n\n${prose}`);
		expect(result).toContain(codeSample);
		expect(result).toContain(fenced);
		expect(result).not.toContain("正文\uE200");
	});
});

describe("rehypeCitationChips", () => {
	it("skips code, pre, and anchor elements", () => {
		const normalized = normalizeCitations("ok \uE200cite\uE202https://example.com/a\uE201");
		const token = normalized.slice(3);
		const tree: TestNode = {
			type: "root",
			children: [
				{ type: "element", tagName: "code", children: [{ type: "text", value: token }] },
				{ type: "element", tagName: "a", children: [{ type: "text", value: token }] },
				{ type: "element", tagName: "p", children: [{ type: "text", value: token }] },
			],
		};
		rehypeCitationChips()(tree);

		expect(tree.children?.[0].children?.[0].type).toBe("text");
		expect(tree.children?.[1].children?.[0].type).toBe("text");
		expect(tree.children?.[2].children?.[0].tagName).toBe(CITE_CHIP_TAG);
	});
});

describe("formatCitationHost", () => {
	it("strips www. prefix and falls back gracefully on invalid URLs", () => {
		expect(formatCitationHost("https://www.apple.com/mac")).toBe("apple.com");
		expect(formatCitationHost("https://v2.tauri.app/distribute/sign/macos/")).toBe("v2.tauri.app");
		expect(formatCitationHost("not-a-url")).toBe("not-a-url");
	});
});

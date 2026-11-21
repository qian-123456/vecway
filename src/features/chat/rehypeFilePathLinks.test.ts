import { describe, expect, it } from "vitest";
import { FILE_LINK_TAG, inlineCodeUrl, rehypeFilePathLinks } from "./rehypeFilePathLinks";

describe("inlineCodeUrl", () => {
	it("accepts a lone http(s) URL", () => {
		const u = "https://github.com/qian-123456/vecway/releases/latest/download/latest.json";
		expect(inlineCodeUrl(u)).toBe(u);
		expect(inlineCodeUrl("  http://localhost:3000/a?b=1#c ")).toBe("http://localhost:3000/a?b=1#c");
	});

	it("rejects non-URL code and other schemes", () => {
		for (const s of [
			"curl https://a.com",
			"https://",
			"ftp://a.com/x",
			"javascript:alert(1)",
			"file:///tmp/a.md",
			"npm run dev",
			"/Users/me/a.md",
			"https://a.com/<x>",
		]) {
			expect(inlineCodeUrl(s)).toBeNull();
		}
	});
});

interface TestHastNode {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: TestHastNode[];
}

describe("rehypeFilePathLinks", () => {
	const run = (children: TestHastNode[]): TestHastNode[] => {
		const paragraph: TestHastNode = { type: "element", tagName: "p", children };
		const tree: TestHastNode = { type: "root", children: [paragraph] };
		rehypeFilePathLinks()(tree);
		return paragraph.children ?? [];
	};

	it("links relative and home directory paths in inline code spans", () => {
		for (const dir of [".cache/", "docs/statecharts/", "./src/", "../dir/", "~/.omp/agent/managed-skills/"]) {
			const nodes = run([{ type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: dir }] }]);
			expect(nodes).toHaveLength(1);
			expect(nodes[0].tagName).toBe(FILE_LINK_TAG);
			expect(nodes[0].properties).toEqual({ dataFileLinkText: dir, dataFileLinkCode: "true" });
		}
	});

	it("does not link bare slashes, dot-only dirs, or non-previewable binaries in inline code", () => {
		for (const raw of ["/", "./", "../", "/Applications/Evil.app", "archive.zip"]) {
			const nodes = run([{ type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: raw }] }]);
			expect(nodes).toHaveLength(1);
			expect(nodes[0].tagName).toBe("code");
		}
	});

	it("links both previewable file paths and absolute/home directory paths in prose", () => {
		const nodes = run([
			{ type: "text", value: "见 ~/.omp/agent/managed-skills/ 和 /Users/me/AGENTS.md。" },
		]);
		const links = nodes
			.filter((n) => n.tagName === FILE_LINK_TAG)
			.map((n) => n.properties?.dataFileLinkText);
		expect(links).toEqual(["~/.omp/agent/managed-skills/", "/Users/me/AGENTS.md"]);
	});
});

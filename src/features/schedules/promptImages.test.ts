import { describe, expect, it } from "vitest";
import { composerDocToPrompt, promptToComposerDoc } from "./promptImages";

describe("promptImages", () => {
	it("round-trips image and file markers cleanly", () => {
		const stored = "读 [Image #1: /a.png] 对比 [Image #2: /b.png] 和 [文件 #1: /doc.md] 与 [Image #1: /a.png]";
		const doc = promptToComposerDoc(stored);
		expect(doc.images).toEqual(["/a.png", "/b.png"]);
		expect(doc.files).toEqual(["/doc.md"]);
		expect(doc.text).toBe("读 🖼️#1 对比 🖼️#2 和 📎#1 与 🖼️#1");
		expect(
			composerDocToPrompt(
				doc.text,
				doc.images.map((path) => ({ path })),
				doc.files.map((path) => ({ path })),
			),
		).toBe(stored);
	});

	it("parses dimensioned image markers and drops orphan tokens", () => {
		expect(promptToComposerDoc("[Image #1, 10x20: /a.png]").images).toEqual(["/a.png"]);
		expect(composerDocToPrompt("x 🖼️#3 📎#2", [{ path: "/a.png" }], [])).toBe("x  ");
	});
});

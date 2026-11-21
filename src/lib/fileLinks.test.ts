import { describe, expect, it } from "vitest";
import {
	canPreviewFile,
	findDirPaths,
	findFilePaths,
	isPreviewableFile,
	looksLikeDirPath,
	looksLikeFilePath,
	previewKind,
	resolveFilePath,
	stripLineSuffix,
} from "./fileLinks";

describe("looksLikeFilePath", () => {
	it("accepts absolute and home paths with an extension", () => {
		expect(looksLikeFilePath("/Users/a/project/AGENTS.md")).toBe(true);
		expect(looksLikeFilePath("~/CodingWiki/wiki/rules.md")).toBe(true);
		expect(looksLikeFilePath("/tmp/report.csv:12")).toBe(true);
	});

	it("rejects directories, URLs, globs and placeholders", () => {
		expect(looksLikeFilePath("/Users/a/project/")).toBe(false);
		expect(looksLikeFilePath("https://example.com/a.md")).toBe(false);
		expect(looksLikeFilePath("/Users/a/*/b.md")).toBe(false);
		expect(looksLikeFilePath("/Users/a/<name>.md")).toBe(false);
		expect(looksLikeFilePath("/a path/with space.md")).toBe(false);
	});

	it("ignores a leading @ when checking code spans", () => {
		expect(looksLikeFilePath("@~/CodingWiki/wiki/rules.md", { allowRelative: true })).toBe(true);
		expect(looksLikeFilePath("@src/lib/ipc.ts", { allowRelative: true })).toBe(true);
		expect(looksLikeFilePath("user@host.com/a.md")).toBe(false);
	});

	it("only links relative paths when asked", () => {
		expect(looksLikeFilePath("src/lib/ipc.ts")).toBe(false);
		expect(looksLikeFilePath("src/lib/ipc.ts", { allowRelative: true })).toBe(true);
		expect(looksLikeFilePath("./notes.md", { allowRelative: true })).toBe(true);
		expect(looksLikeFilePath("notes.md", { allowRelative: true })).toBe(false);
		expect(looksLikeFilePath("notes.md", { allowRelative: true, allowBare: true })).toBe(true);
		// Bare tokens must be readable text, so unknown binaries stay plain.
		expect(looksLikeFilePath("app.bin", { allowBare: true })).toBe(false);
	});
});

describe("looksLikeDirPath", () => {
	it("accepts absolute and home directory paths ending with /", () => {
		expect(looksLikeDirPath("/foo/bar/")).toBe(true);
		expect(looksLikeDirPath("~/foo/")).toBe(true);
		expect(looksLikeDirPath("~/.omp/agent/managed-skills/")).toBe(true);
		expect(looksLikeDirPath("@~/.omp/agent/managed-skills/")).toBe(true);
		expect(looksLikeDirPath("file:///Users/me/docs/")).toBe(true);
	});

	it("accepts relative directory paths only when allowRelative is true", () => {
		expect(looksLikeDirPath(".cache/")).toBe(false);
		expect(looksLikeDirPath("docs/statecharts/")).toBe(false);
		expect(looksLikeDirPath("./src/")).toBe(false);
		expect(looksLikeDirPath("../dir/")).toBe(false);

		expect(looksLikeDirPath(".cache/", { allowRelative: true })).toBe(true);
		expect(looksLikeDirPath("docs/statecharts/", { allowRelative: true })).toBe(true);
		expect(looksLikeDirPath("./src/", { allowRelative: true })).toBe(true);
		expect(looksLikeDirPath("../dir/", { allowRelative: true })).toBe(true);
	});

	it("rejects bare slashes, dot-only segments, URLs, globs, spaces, and non-trailing-slash paths", () => {
		for (const bad of [
			"/",
			"~/",
			"./",
			"../",
			"../../",
			"/Users/a/project",
			"docs/statecharts",
			"https://example.com/",
			"http://localhost:3000/dir/",
			"ssh://host/dir/",
			"//example.com/dir/",
			"/Users/a/*/dir/",
			"/Users/a/<name>/",
			"/a path/with space/",
		]) {
			expect(looksLikeDirPath(bad, { allowRelative: true })).toBe(false);
		}
	});
});

describe("findFilePaths", () => {
	it("finds paths embedded in CJK prose and trims punctuation", () => {
		const text = "已经阅读了 /Users/me/.omp/agent/AGENTS.md、~/CodingWiki/x/y.md。";
		expect(findFilePaths(text).map((m) => m.path)).toEqual([
			"/Users/me/.omp/agent/AGENTS.md",
			"~/CodingWiki/x/y.md",
		]);
	});

	it("leaves the agent's @ mention prefix outside the link", () => {
		expect(findFilePaths("@~/CodingWiki/wiki/rules.md").map((m) => m.path)).toEqual([
			"~/CodingWiki/wiki/rules.md",
		]);
		expect(findFilePaths("见 @/Users/me/a.md")).toEqual([
			{ start: 3, end: 17, path: "/Users/me/a.md" },
		]);
	});

	it("does not slice paths out of URLs", () => {
		expect(findFilePaths("see https://example.com/a/b.md now")).toEqual([]);
	});

	it("ignores directories and keeps the file before a fragment", () => {
		expect(findFilePaths("目录 /Users/a/b")).toEqual([]);
		expect(findFilePaths("行 /tmp/x.txt#L3").map((m) => m.path)).toEqual(["/tmp/x.txt"]);
	});
});

describe("findDirPaths", () => {
	it("finds absolute and home directory paths ending with / in prose", () => {
		const text = "查看 ~/.omp/agent/managed-skills/ 和 /tmp/statecharts/。";
		expect(findDirPaths(text).map((m) => m.path)).toEqual([
			"~/.omp/agent/managed-skills/",
			"/tmp/statecharts/",
		]);
	});

	it("keeps @ mention prefix outside the match and ignores URLs and non-slash directories", () => {
		expect(findDirPaths("见 @~/.omp/agent/managed-skills/")).toEqual([
			{ start: 3, end: 31, path: "~/.omp/agent/managed-skills/" },
		]);
		expect(findDirPaths("see https://example.com/a/b/ now")).toEqual([]);
		expect(findDirPaths("目录 /Users/a/b 以及 docs/statecharts/")).toEqual([]);
	});
});

describe("resolveFilePath", () => {
	it("keeps absolute paths and expands home when known", () => {
		expect(resolveFilePath("/a/b.md")).toBe("/a/b.md");
		expect(resolveFilePath("~/b.md", { home: "/Users/me" })).toBe("/Users/me/b.md");
		expect(resolveFilePath("~/b.md")).toBe("~/b.md");
	});

	it("resolves relative paths against the cwd", () => {
		expect(resolveFilePath("src/a.ts", { cwd: "/repo/" })).toBe("/repo/src/a.ts");
		expect(resolveFilePath("./a.ts", { cwd: "/repo" })).toBe("/repo/a.ts");
		expect(resolveFilePath("src/a.ts")).toBe("");
	});
	it("decodes percent-encoded path components", () => {
		expect(resolveFilePath("/repo/%E6%8C%87%E5%8D%97.md")).toBe("/repo/指南.md");
		expect(resolveFilePath("file:///repo/%E6%8C%87%E5%8D%97.md")).toBe("/repo/指南.md");
	});

	it("drops editor line suffixes and URL fragments", () => {
		expect(resolveFilePath("/a/b.py:42:7")).toBe("/a/b.py");
		expect(resolveFilePath("/a/b.html#L10")).toBe("/a/b.html");
	});
});

describe("previewKind", () => {
	it("classifies text, images and everything else", () => {
		expect(previewKind("/a/AGENTS.md")).toBe("text");
		expect(previewKind("/a/diagram.mmd")).toBe("text");
		expect(previewKind("/a/data.json")).toBe("text");
		expect(previewKind("/a/Dockerfile")).toBe("text");
		expect(previewKind("/a/shot.PNG")).toBe("image");
		expect(previewKind("/a/app.dmg")).toBe("external");
	});

	it("keeps isPreviewableFile aligned with text previews", () => {
		expect(isPreviewableFile("/a/notes.yaml")).toBe(true);
		expect(isPreviewableFile("/a/archive.zip")).toBe(false);
	});
});

describe("canPreviewFile", () => {
	it("allows text and image files", () => {
		expect(canPreviewFile("/a/AGENTS.md")).toBe(true);
		expect(canPreviewFile("/a/shot.png")).toBe(true);
	});

	it("refuses anything the panel cannot render (no system opener)", () => {
		expect(canPreviewFile("/Applications/Evil.app")).toBe(false);
		expect(canPreviewFile("/Users/me/run.command")).toBe(false);
		expect(canPreviewFile("/Users/me/install.pkg")).toBe(false);
		expect(canPreviewFile("/Users/me/setup.sh")).toBe(true); // sh is text
		expect(canPreviewFile("/Users/me/a.dmg")).toBe(false);
	});
});

describe("stripLineSuffix", () => {
	it("removes one or two trailing line numbers", () => {
		expect(stripLineSuffix("/a/b.ts:3")).toBe("/a/b.ts");
		expect(stripLineSuffix("/a/b.ts:3:9")).toBe("/a/b.ts");
		expect(stripLineSuffix("/a/b:3")).toBe("/a/b");
	});
});

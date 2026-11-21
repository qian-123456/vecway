import { describe, expect, it } from "vitest";
import { normalizeMath } from "./mathNormalize";

describe("mobile normalizeMath", () => {
	it("puts inline-closed display math on its own fenced lines", () => {
		const src = "前文\n$$\\begin{aligned}\nA &\\cap B\n\\end{aligned}$$\n```\ncode\n```";
		const out = normalizeMath(src);
		expect(out).toContain("\n$$\n\\begin{aligned}\nA &\\cap B\n\\end{aligned}\n$$\n");
		expect(out.endsWith("```\ncode\n```")).toBe(true);
	});

	it("escapes an unclosed streaming $$ so it cannot swallow following prose", () => {
		expect(normalizeMath("a $$ b\n\nrest")).toBe("a \\$\\$ b\n\nrest");
		expect(normalizeMath("streaming $$\\frac{1}{")).toBe("streaming \\$\\$\\frac{1}{");
	});

	it("does not pair $$ across a blank line", () => {
		expect(normalizeMath("$$ x\n\ny $$")).toBe("\\$\\$ x\n\ny \\$\\$");
	});

	it("renders pandoc-style single-dollar inline math", () => {
		expect(normalizeMath("是的，$1 + 1 = 2$。")).toBe("是的，$$1 + 1 = 2$$。");
		expect(normalizeMath("$\\to$ and $\\alpha+1$")).toBe("$$\\to$$ and $$\\alpha+1$$");
	});

	it("keeps currency-like single dollars and escaped dollars as prose", () => {
		for (const s of ["costs $5 and $6", "from $5-$10 total", "花了$5，赚了$10", "a \\$b$ c"]) {
			expect(normalizeMath(s)).toBe(s);
		}
	});

	it.each([
		["backtick fenced code", "```sh\necho $$\nprintf '$x$'\n```"],
		["tilde fenced code", "~~~sh\necho $$\nprintf '$x$'\n~~~"],
		["longer closing fence", "````ts\nconst s = `$x$`;\n```\n$$y$$\n````"],
		["quoted tilde fence", "> ~~~sh\n> echo $$\n> ~~~"],
		["quoted backtick fence", "> ```sh\n> echo $$\n> ```"],
		["list fence", "- code\n\n  ~~~sh\n  echo $$\n  ~~~"],
		["nested quote/list fence", "> - code\n>\n>   ~~~sh\n>   echo $$\n>   ~~~"],
		["indented code", "    echo $$\n    printf '$x$'"],
		["tab-indented code", "\techo $$"],
		["quoted indented code", ">     echo $$"],
		["list indented code", "- code\n\n      echo $$"],
		["open nested fence", "> ~~~sh\n> echo $$"],
		["CRLF quoted fence", "> ~~~sh\r\n> echo $$\r\n> ~~~"],
		["inline code span", "`$x$`"],
		["double-backtick inline code span", "`` `$x$` ``"],
		["multiline code span", "`echo $$\n$x$`"],
		["long code span with shorter interior run", "``echo ` $$\n$x$``"],
		["inline code span ending with backslash", "`$x$ \\`"],
	])("preserves exact source bytes for %s", (_label, source) => {
		expect(normalizeMath(source)).toBe(source);
	});

	it("normalizes prose on both sides of protected code without pairing across it", () => {
		const code = "> ~~~sh\n> echo $$\n> ~~~";
		const source = `$x$ before\n\n${code}\n\nafter $y$`;
		expect(normalizeMath(source)).toBe(`$$x$$ before\n\n${code}\n\nafter $$y$$`);
	});

	it("does not let an unclosed backtick suppress math normalization", () => {
		expect(normalizeMath("a ` lone tick and $x^2$")).toBe("a ` lone tick and $$x^2$$");
	});

	it("does not treat a 4-space continuation line inside a paragraph as indented code", () => {
		expect(normalizeMath("hello\n    $x^2$")).toBe("hello\n    $$x^2$$");
	});

	it("handles escaped backticks outside code spans", () => {
		expect(normalizeMath("\\`$x$\\`")).toBe("\\`$$x$$\\`");
	});
});

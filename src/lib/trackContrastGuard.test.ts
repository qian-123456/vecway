import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...sourceFiles(p));
		else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(p);
	}
	return out;
}

function parseColor(raw: string): Rgba {
	const s = raw.trim();
	const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (hex) {
		const h = hex[1];
		const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
		return {
			r: Number.parseInt(full.slice(0, 2), 16),
			g: Number.parseInt(full.slice(2, 4), 16),
			b: Number.parseInt(full.slice(4, 6), 16),
			a: 1,
		};
	}
	const rgba = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
	if (rgba) {
		return {
			r: Number(rgba[1]),
			g: Number(rgba[2]),
			b: Number(rgba[3]),
			a: rgba[4] !== undefined ? Number(rgba[4]) : 1,
		};
	}
	throw new Error(`Unsupported color literal: ${raw}`);
}

function composite(fg: Rgba, bg: Rgba): Rgba {
	return {
		r: fg.r * fg.a + bg.r * (1 - fg.a),
		g: fg.g * fg.a + bg.g * (1 - fg.a),
		b: fg.b * fg.a + bg.b * (1 - fg.a),
		a: 1,
	};
}

function srgbToLinear(c: number): number {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(c: Rgba): number {
	return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

function rgbDistance(a: Rgba, b: Rgba): number {
	return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function extractVars(blockBody: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const m of blockBody.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
		vars[m[1]] = m[2].trim();
	}
	return vars;
}

const TRACK_CLASS_RE =
	/\b(?:w-full\b[^"`']*\brounded-full\b[^"`']*\boverflow-hidden\b|\boverflow-hidden\b[^"`']*\brounded-full\b|\brounded-full\b[^"`']*\boverflow-hidden\b)/;
const BAR_HEIGHT_RE = /\bh-(?:0\.5|1|1\.5|2|2\.5|3)\b/;
const FORBIDDEN_TRACK_BG_RE = /\bbg-\[var\(--(?:bg-hover|bg-selected|ghost-hover)\)\]/;

function readNormalizedCss(): string {
	return readFileSync(join(SRC, "index.css"), "utf8").replace(/\r\n/g, "\n");
}

describe("progress track contrast guard", () => {
	it("defines --track-bg as a text-derived color-mix token in index.css", () => {
		const css = readNormalizedCss();
		const m = css.match(/--track-bg:\s*color-mix\([^,]+,\s*var\(--text\)\s+(\d+)%,\s*transparent\);/);
		expect(m).toBeTruthy();
		expect(Number(m?.[1])).toBeGreaterThanOrEqual(10);
	});

	it("forbids interactive hover/selected/ghost tokens on progress and ratio tracks", () => {
		const violations: string[] = [];
		for (const file of sourceFiles(SRC)) {
			const rel = relative(SRC, file).split(sep).join("/");
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (BAR_HEIGHT_RE.test(line) && TRACK_CLASS_RE.test(line) && FORBIDDEN_TRACK_BG_RE.test(line)) {
					violations.push(`${rel}:${i + 1} ${line.trim()}`);
				}
			});
		}
		expect(violations).toEqual([]);
	});

	it("ensures --track-bg maintains visible contrast in the right direction on every theme", () => {
		const css = readNormalizedCss();
		const trackMatch = css.match(/--track-bg:\s*color-mix\([^,]+,\s*var\(--text\)\s+(\d+)%,\s*transparent\);/);
		const trackAlpha = Number(trackMatch?.[1] ?? 0) / 100;

		const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
		expect(rootMatch).toBeTruthy();
		const rootVars = extractVars(rootMatch![1]);

		const lightOverrideMatch = css.match(/html\[data-mode="light"\][\s\S]*?\{([\s\S]*?)\n\}/);
		const lightOverrides = lightOverrideMatch ? extractVars(lightOverrideMatch[1]) : {};
		const lightThemeListMatch = css.match(/(html\[data-mode="light"\][\s\S]*?)\{/);
		const lightThemeNames = new Set(
			Array.from(lightThemeListMatch?.[1].matchAll(/data-theme="([^"]+)"/g) ?? []).map((m) => m[1]),
		);

		const themeBlocks = Array.from(
			css.matchAll(
				/^html\[data-theme="([^"]+)"\](?:,\nhtml\[data-theme="\1"\]\[data-wallpaper-appearance="([^"]+)"\]|\[data-wallpaper-appearance="([^"]+)"\])?\s*\{([\s\S]*?)\n\}/gm,
			),
		).filter(([, , , , body]) => /--bg:\s*/.test(body));
		expect(themeBlocks.length).toBeGreaterThan(25);

		const themesToCheck: Array<{ label: string; isLight: boolean; vars: Record<string, string> }> = [
			{ label: "default", isLight: false, vars: rootVars },
			...themeBlocks.map(([, themeName, appA, appB, body]) => {
				const appearance = appA ?? appB;
				const isLight = lightThemeNames.has(themeName) || appearance === "light" || themeName === "light";
				return {
					label: `${themeName}${appearance ? `/${appearance}` : ""}`,
					isLight,
					vars: {
						...rootVars,
						...(lightThemeNames.has(themeName) ? lightOverrides : {}),
						...extractVars(body),
					},
				};
			}),
		];

		for (const { label, isLight, vars } of themesToCheck) {
			const baseBg = parseColor(vars["--bg"]);
			const panelRaw = parseColor(vars["--bg-panel"]);
			const panel = panelRaw.a < 1 ? composite(panelRaw, baseBg) : panelRaw;
			const wellRaw = parseColor(vars["--well-bg"]);
			const card = wellRaw.a < 1 ? composite(wellRaw, panel) : wellRaw;
			const text = parseColor(vars["--text"]);
			const trackOverlay: Rgba = { ...text, a: trackAlpha };

			for (const surface of [panel, card]) {
				const resolvedTrack = composite(trackOverlay, surface);
				const dist = rgbDistance(resolvedTrack, surface);
				const lumDelta = luminance(resolvedTrack) - luminance(surface);

				expect(dist, `${label} track contrast too low`).toBeGreaterThanOrEqual(12);
				if (isLight) {
					expect(lumDelta, `${label} track must be darker than light surface`).toBeLessThan(0);
				} else {
					expect(lumDelta, `${label} track must be lighter than dark surface`).toBeGreaterThan(0);
				}
			}
		}
	});
});

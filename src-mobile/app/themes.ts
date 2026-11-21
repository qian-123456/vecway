import type { Scheme } from "../core/stores/prefs";

export interface MobileThemeSwatch {
	bg: string;
	elev: string;
	card: string;
	bubble: string;
	accent: string;
	text: string;
}

export interface MobileThemeDef {
	id: string;
	name: string;
	scheme: Scheme;
	swatch: MobileThemeSwatch;
}

export const DEFAULT_LIGHT_THEME = "native-light" as const;
export const DEFAULT_DARK_THEME = "native-dark" as const;

/**
 * Curated light & dark colour palettes for `src-mobile`.
 * Every colour rendered in the app comes from `--m-*` CSS tokens defined in `styles/tokens.css`.
 */
export const MOBILE_THEMES: readonly MobileThemeDef[] = [
	// ---- Light themes (default: Direction A Calm Native) ----
	{
		id: "native-light",
		name: "暖白原生",
		scheme: "light",
		swatch: { bg: "#faf9f7", elev: "#f2f1ed", card: "#ffffff", bubble: "#e8effc", accent: "#2563eb", text: "#17191f" },
	},
	{
		id: "pure-light",
		name: "极简纯白",
		scheme: "light",
		swatch: { bg: "#ffffff", elev: "#f6f8fa", card: "#ffffff", bubble: "#e7f1ff", accent: "#0969da", text: "#1f2328" },
	},
	{
		id: "warm-sand",
		name: "暖陶纸感",
		scheme: "light",
		swatch: { bg: "#f8f7f4", elev: "#f0ede6", card: "#ffffff", bubble: "#f4e6df", accent: "#b03e22", text: "#2b2823" },
	},
	{
		id: "sakura",
		name: "樱花粉",
		scheme: "light",
		swatch: { bg: "#fcf6f8", elev: "#f5eaee", card: "#fffdfe", bubble: "#f8e1ea", accent: "#c93b6b", text: "#3a222b" },
	},
	{
		id: "glacier",
		name: "冰川青",
		scheme: "light",
		swatch: { bg: "#f5f9fc", elev: "#e8f1f8", card: "#fcfeff", bubble: "#def0f8", accent: "#0d94bd", text: "#1b3242" },
	},
	{
		id: "lavender",
		name: "薰衣草",
		scheme: "light",
		swatch: { bg: "#f8f6fc", elev: "#eee8f8", card: "#fdfcff", bubble: "#eae2fa", accent: "#7c5cd6", text: "#38304f" },
	},
	{
		id: "catppuccin-latte",
		name: "拿铁蓝",
		scheme: "light",
		swatch: { bg: "#eff1f5", elev: "#e6e9ef", card: "#f9fafc", bubble: "#dce6fb", accent: "#1e66f5", text: "#4c4f69" },
	},
	{
		id: "everforest-light",
		name: "森屿浅绿",
		scheme: "light",
		swatch: { bg: "#fdf6e3", elev: "#f3eed8", card: "#fffdf5", bubble: "#e7efda", accent: "#5f7c2b", text: "#434f55" },
	},

	// ---- Dark themes (default: Direction A Deep Graphite) ----
	{
		id: "native-dark",
		name: "深邃石墨",
		scheme: "dark",
		swatch: { bg: "#0c0d10", elev: "#15171c", card: "#17191f", bubble: "#1e2636", accent: "#78a9ff", text: "#eef0f5" },
	},
	{
		id: "oled-dark",
		name: "纯黑墨玉",
		scheme: "dark",
		swatch: { bg: "#000000", elev: "#0e0f12", card: "#141519", bubble: "#192233", accent: "#60a5fa", text: "#f2f4f8" },
	},
	{
		id: "omp-pink",
		name: "OMP 霓虹",
		scheme: "dark",
		swatch: { bg: "#08080b", elev: "#111116", card: "#16161d", bubble: "#2d1a27", accent: "#ec5bab", text: "#f5f5f7" },
	},
	{
		id: "tokyo-night",
		name: "东京夜色",
		scheme: "dark",
		swatch: { bg: "#1a1b26", elev: "#16161e", card: "#1f2335", bubble: "#242e4d", accent: "#7aa2f7", text: "#c0caf5" },
	},
	{
		id: "catppuccin-mocha",
		name: "摩卡紫夜",
		scheme: "dark",
		swatch: { bg: "#1e1e2e", elev: "#181825", card: "#242437", bubble: "#2f2a46", accent: "#cba6f7", text: "#cdd6f4" },
	},
	{
		id: "rose-pine",
		name: "玫瑰暗夜",
		scheme: "dark",
		swatch: { bg: "#191724", elev: "#1f1d2e", card: "#242136", bubble: "#32273a", accent: "#ebbcba", text: "#e0def4" },
	},
	{
		id: "nord",
		name: "北欧极光",
		scheme: "dark",
		swatch: { bg: "#2e3440", elev: "#272c36", card: "#353c4a", bubble: "#39485a", accent: "#88c0d0", text: "#eceff4" },
	},
	{
		id: "everforest",
		name: "常青森林",
		scheme: "dark",
		swatch: { bg: "#232a2e", elev: "#1d2326", card: "#2a3338", bubble: "#313d34", accent: "#a7c080", text: "#d3c6aa" },
	},
	{
		id: "gruvbox-dark",
		name: "复古暖棕",
		scheme: "dark",
		swatch: { bg: "#22201e", elev: "#1b1917", card: "#2a2724", bubble: "#392e24", accent: "#fe8019", text: "#ebdbb2" },
	},
] as const;

export const LIGHT_THEMES: readonly MobileThemeDef[] = MOBILE_THEMES.filter((t) => t.scheme === "light");
export const DARK_THEMES: readonly MobileThemeDef[] = MOBILE_THEMES.filter((t) => t.scheme === "dark");

const BY_ID = new Map<string, MobileThemeDef>(MOBILE_THEMES.map((t) => [t.id, t]));

export function themeById(id: string | undefined | null): MobileThemeDef | undefined {
	return id ? BY_ID.get(id) : undefined;
}

export function defaultThemeForScheme(scheme: Scheme): string {
	return scheme === "dark" ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
}

/** Validate that `id` exists and matches `scheme`; otherwise fall back to the scheme's default palette. */
export function resolveThemeId(scheme: Scheme, id?: string | null): string {
	const found = themeById(id);
	return found && found.scheme === scheme ? found.id : defaultThemeForScheme(scheme);
}

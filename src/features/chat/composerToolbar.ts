import { tNow } from "../../stores/language";
/** Responsive tiers for the composer toolbar. The toolbar never wraps and never
 * merges Model and Thinking Level into a single button: as its own width
 * shrinks, lower-value elements collapse first (in this order):
 *   0 full      model chip + thinking chip + ring with 「53%」
 *   1 noPercent ring only (percentage stays in its tooltip)
 *   2 tight     tighter chip padding and gaps; model name truncates while
 *               thinking level remains a separate single-line button
 * Widths are estimates from the label text; TIER_TIGHT is the floor. */

export type ToolbarTier = 0 | 1 | 2;

export const TIER_FULL = 0;
export const TIER_NO_PERCENT = 1;
export const TIER_TIGHT = 2;

/** What the thinking chip shows for the selected model. */
export type ThinkingKind = "levels" | "unconfigured" | "unsupported";

const CJK = /[\u2e80-\u9fff\uff00-\uffef]/;

/** Rendered width estimate of 12px UI text. */
export function textWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += CJK.test(ch) ? 12 : 6.6;
	return w;
}

export interface ToolbarMeasure {
	/** Toolbar content-box width in px (0 = not measured yet). */
	width: number;
	modelLabel: string;
	thinkingKind: ThinkingKind;
	thinkingLevel: string;
	/** Extra fixed-width items on the row (plan icon, queue pill), px. */
	extra?: number;
}

const FIXED = 20 /* px-2.5 */ + 28 /* + button */ + 8 /* gap-x */ + 28 /* send */ + 6; /* right gap */
const CHIP_PAD = 30; /* px-2 + gap + chevron */
const RING = 30;
const RING_PCT = 62;

function thinkingChipWidth(kind: ThinkingKind, level: string): number {
	if (kind === "levels") return CHIP_PAD + textWidth(level);
	if (kind === "unconfigured") return 18 + textWidth(tNow("chat.toolbar.unconfiguredThinking"));
	return 18 + textWidth(tNow("chat.toolbar.unsupportedThinking"));
}

export function pickToolbarTier(m: ToolbarMeasure): ToolbarTier {
	if (m.width <= 0) return TIER_FULL;
	const base = FIXED + (m.extra ?? 0);
	const model = CHIP_PAD + textWidth(m.modelLabel);
	const thinking = thinkingChipWidth(m.thinkingKind, m.thinkingLevel);
	const need: Record<0 | 1, number> = {
		0: base + model + thinking + 2 + RING_PCT,
		1: base + model + thinking + 2 + RING,
	};
	for (const t of [0, 1] as const) if (need[t] <= m.width) return t;
	return TIER_TIGHT;
}

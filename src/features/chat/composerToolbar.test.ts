import { describe, expect, it } from "vitest";
import { pickToolbarTier, TIER_FULL, TIER_NO_PERCENT, TIER_TIGHT } from "./composerToolbar";

const base = {
	modelLabel: "gemini-3.8-flash",
	thinkingKind: "levels" as const,
	thinkingLevel: "high",
};

describe("pickToolbarTier", () => {
	it("is full when wide or unmeasured", () => {
		expect(pickToolbarTier({ ...base, width: 640 })).toBe(TIER_FULL);
		expect(pickToolbarTier({ ...base, width: 0 })).toBe(TIER_FULL);
	});
	it("collapses monotonically as width shrinks and stays within 0..2", () => {
		let prev = 0;
		const seen = new Set<number>();
		for (let w = 700; w >= 100; w -= 10) {
			const t = pickToolbarTier({ ...base, width: w });
			expect(t).toBeGreaterThanOrEqual(prev);
			expect(t).toBeLessThanOrEqual(TIER_TIGHT);
			seen.add(t);
			prev = t;
		}
		expect(seen.has(TIER_FULL)).toBe(true);
		expect(seen.has(TIER_NO_PERCENT)).toBe(true);
		expect(prev).toBe(TIER_TIGHT);
	});
	it("stops at TIER_TIGHT on narrow side-chat widths and never merges chips", () => {
		expect(pickToolbarTier({ ...base, width: 280 })).toBe(TIER_TIGHT);
		expect(pickToolbarTier({ ...base, width: 160 })).toBe(TIER_TIGHT);
	});
});

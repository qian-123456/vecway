import { useLayoutEffect, useRef, useState } from "react";

/** Parts stay measurable out of flow, so growing the bar can restore them. */
export function useBottomBarFit(enabled: boolean) {
	const ref = useRef<HTMLElement>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

	useLayoutEffect(() => {
		const bar = ref.current;
		if (!bar || !enabled) return;
		const parts = Array.from(bar.querySelectorAll<HTMLElement>("[data-bottom-bar-part]"));
		const stats = bar.querySelector<HTMLElement>("[data-bottom-bar-stats]");
		const right = bar.querySelector<HTMLElement>("[data-bottom-bar-right]");
		const px = (value: string) => Number.parseFloat(value) || 0;
		const gap = (element: Element) => px(getComputedStyle(element).columnGap);
		const measure = () => {
			const barWidth = bar.getBoundingClientRect().width;
			if (!right || barWidth === 0) return;
			const style = getComputedStyle(bar);
			const available = barWidth - px(style.borderLeftWidth) - px(style.borderRightWidth)
				- px(style.paddingLeft) - px(style.paddingRight);
			const statsStyle = stats ? getComputedStyle(stats) : null;
			let width = right.getBoundingClientRect().width + gap(bar);
			if (stats && statsStyle) {
				width += stats.getBoundingClientRect().width + px(statsStyle.marginLeft) + px(statsStyle.marginRight);
			}
			const candidates = parts.map((part) => {
				const cost = part.getBoundingClientRect().width + gap(part.parentElement!);
				if (part.dataset.collapsed === "true") width += cost;
				return { id: part.dataset.bottomBarPart!, priority: Number(part.dataset.priority), cost };
			}).sort((a, b) => b.priority - a.priority);
			const next = new Set<string>();
			for (const part of candidates) {
				if (width <= available) break;
				next.add(part.id);
				width -= part.cost;
			}
			setCollapsed((previous) => previous.size === next.size && [...next].every((id) => previous.has(id))
				? previous : next);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		for (const element of [bar, right, stats, ...parts]) {
			if (element) observer.observe(element);
		}
		return () => observer.disconnect();
	});

	return { ref, collapsed };
}

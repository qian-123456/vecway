import { useLayoutEffect, useRef, useState } from "react";

/** Parts stay measurable out of flow, so growing the bar can restore them. */
export function useBottomBarFit(enabled: boolean) {
	const ref = useRef<HTMLElement>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const observerRef = useRef<ResizeObserver | null>(null);
	const observedRef = useRef<Set<Element>>(new Set());
	const syncRef = useRef<() => void>(() => {});
	const measureRef = useRef<() => void>(() => {});

	useLayoutEffect(() => {
		const bar = ref.current;
		if (!bar || !enabled) {
			observedRef.current.clear();
			return;
		}
		const px = (value: string) => Number.parseFloat(value) || 0;
		const gap = (element: Element | null) => (element ? px(getComputedStyle(element).columnGap) : 0);
		const measure = () => {
			const parts = Array.from(bar.querySelectorAll<HTMLElement>("[data-bottom-bar-part]"));
			const stats = bar.querySelector<HTMLElement>("[data-bottom-bar-stats]");
			const right = bar.querySelector<HTMLElement>("[data-bottom-bar-right]");
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
				const cost = part.getBoundingClientRect().width + gap(part.parentElement);
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
		const syncObserved = () => {
			const parts = Array.from(bar.querySelectorAll<HTMLElement>("[data-bottom-bar-part]"));
			const stats = bar.querySelector<HTMLElement>("[data-bottom-bar-stats]");
			const right = bar.querySelector<HTMLElement>("[data-bottom-bar-right]");
			const targets = [bar, right, stats, ...parts].filter((el): el is HTMLElement => el !== null);
			const nextSet = new Set<Element>(targets);
			if (observerRef.current) {
				for (const el of observedRef.current) {
					if (!nextSet.has(el)) observerRef.current.unobserve(el);
				}
				for (const el of targets) {
					if (!observedRef.current.has(el)) observerRef.current.observe(el);
				}
			}
			observedRef.current = nextSet;
		};
		measureRef.current = measure;
		syncRef.current = syncObserved;
		if (typeof ResizeObserver !== "undefined") {
			observerRef.current = new ResizeObserver(measure);
		}
		syncObserved();
		measure();
		return () => {
			observerRef.current?.disconnect();
			observerRef.current = null;
			observedRef.current.clear();
		};
	}, [enabled]);

	useLayoutEffect(() => {
		if (!ref.current || !enabled) return;
		syncRef.current();
		measureRef.current();
	});

	return { ref, collapsed };
}

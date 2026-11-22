import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOverlay, usePresence } from "./overlay";

const EXIT_MS = 180;
const EDGE_PAD = 12;

export interface AnchorBox {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export type PopoverPlacement =
	| "bottom-start"
	| "bottom-end"
	| "bottom-center"
	| "top-start"
	| "top-end"
	| "top-center";

export interface AnchoredPopoverProps {
	open: boolean;
	onClose: () => void;
	/** Element to anchor to. Falls back to `anchorRect`, or centered top-under-bar if neither is provided. */
	anchorEl?: HTMLElement | null;
	/** Explicit viewport rect (e.g. from text selection or row event). */
	anchorRect?: AnchorBox | null;
	placement?: PopoverPlacement;
	title?: ReactNode;
	subtitle?: ReactNode;
	children: ReactNode;
	className?: string;
	maxWidth?: number;
	minWidth?: number;
	offset?: number;
}

let safeProbeEl: HTMLDivElement | null = null;

/** Resolve CSS `env(safe-area-inset-top/bottom)` in pixels so floating overlays never clip under the iOS notch/status bar. */
export function readSafeAreaInsets(): { top: number; bottom: number } {
	if (typeof document === "undefined" || !document.body) return { top: 0, bottom: 0 };
	if (!safeProbeEl || !safeProbeEl.isConnected) {
		const el = document.createElement("div");
		el.setAttribute("aria-hidden", "true");
		el.style.cssText =
			"position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
			"padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);";
		document.body.appendChild(el);
		safeProbeEl = el;
	}
	const cs = getComputedStyle(safeProbeEl);
	const top = Number.parseFloat(cs.paddingTop) || 0;
	const bottom = Number.parseFloat(cs.paddingBottom) || 0;
	return { top, bottom };
}

function readAnchor(anchorEl?: HTMLElement | null, anchorRect?: AnchorBox | null): AnchorBox | null {
	if (anchorEl && anchorEl.isConnected) {
		const r = anchorEl.getBoundingClientRect();
		if (r.width > 0 || r.height > 0) {
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
		}
	}
	if (anchorRect) return anchorRect;
	return null;
}

/**
 * Anchored pull-down / contextual popover that opens directly from its trigger
 * (top bar title, right controls, inline rows, composer controls) so eye travel stays minimal.
 */
export function AnchoredPopover({
	open,
	onClose,
	anchorEl,
	anchorRect,
	placement = "bottom-start",
	title,
	subtitle,
	children,
	className = "",
	maxWidth = 340,
	minWidth = 200,
	offset = 6,
}: AnchoredPopoverProps) {
	const { mounted, visible } = usePresence(open, EXIT_MS);
	useOverlay(open, onClose);
	const panelRef = useRef<HTMLDivElement>(null);
	const snapshotRef = useRef<{ children: ReactNode; title: ReactNode; subtitle: ReactNode }>({
		children,
		title,
		subtitle,
	});
	if (open && children != null && children !== false) {
		snapshotRef.current = { children, title, subtitle };
	} else if (!mounted) {
		snapshotRef.current = { children: null, title: undefined, subtitle: undefined };
	}
	const activeChildren = open ? children : snapshotRef.current.children;
	const activeTitle = open ? title : (title ?? snapshotRef.current.title);
	const activeSubtitle = open ? subtitle : (subtitle ?? snapshotRef.current.subtitle);

	const [pos, setPos] = useState<{
		left: number;
		top: number;
		maxHeight: number;
		origin: string;
		fromTop: boolean;
	}>({
		left: EDGE_PAD,
		top: 64,
		maxHeight: 420,
		origin: "top left",
		fromTop: true,
	});

	useLayoutEffect(() => {
		if (!mounted) return;
		const compute = () => {
			const vw = window.innerWidth || 390;
			const vh = window.innerHeight || 844;
			const safe = readSafeAreaInsets();
			const topBound = safe.top + EDGE_PAD;
			const bottomBound = vh - safe.bottom - EDGE_PAD;
			const availVh = Math.max(160, bottomBound - topBound);
			const panelW = Math.min(maxWidth, vw - EDGE_PAD * 2);
			const measuredW = panelRef.current?.offsetWidth || panelW;
			const measuredH = panelRef.current?.offsetHeight || 220;
			const box = readAnchor(anchorEl, anchorRect);

			const preferTop = placement.startsWith("top");
			const align = placement.endsWith("end") ? "end" : placement.endsWith("center") ? "center" : "start";

			let fromTop = !preferTop;
			let top: number;
			let left: number;
			let maxHeight: number;

			if (box) {
				const spaceBelow = Math.max(0, bottomBound - box.bottom - offset);
				const spaceAbove = Math.max(0, box.top - offset - topBound);

				if (preferTop) {
					if (spaceAbove >= Math.min(measuredH, 160) || spaceAbove >= spaceBelow) {
						fromTop = false;
						maxHeight = Math.max(120, Math.min(spaceAbove, availVh * 0.78));
						top = Math.max(topBound, box.top - offset - Math.min(measuredH, maxHeight));
					} else {
						fromTop = true;
						maxHeight = Math.max(120, Math.min(spaceBelow, availVh * 0.78));
						top = Math.max(topBound, Math.min(box.bottom + offset, bottomBound - Math.min(measuredH, maxHeight)));
					}
				} else {
					if (spaceBelow >= Math.min(measuredH, 160) || spaceBelow >= spaceAbove) {
						fromTop = true;
						maxHeight = Math.max(120, Math.min(spaceBelow, availVh * 0.78));
						top = Math.max(topBound, Math.min(box.bottom + offset, bottomBound - Math.min(measuredH, maxHeight)));
					} else {
						fromTop = false;
						maxHeight = Math.max(120, Math.min(spaceAbove, availVh * 0.78));
						top = Math.max(topBound, box.top - offset - Math.min(measuredH, maxHeight));
					}
				}

				if (align === "end") {
					left = box.right - measuredW;
				} else if (align === "center") {
					left = box.left + box.width / 2 - measuredW / 2;
				} else {
					left = box.left;
				}
				left = Math.max(EDGE_PAD, Math.min(left, vw - EDGE_PAD - measuredW));
			} else {
				// Fallback near top bar when no anchor was provided.
				fromTop = !preferTop;
				left = align === "end" ? vw - EDGE_PAD - measuredW : align === "center" ? (vw - measuredW) / 2 : EDGE_PAD;
				left = Math.max(EDGE_PAD, Math.min(left, vw - EDGE_PAD - measuredW));
				maxHeight = Math.max(180, availVh * 0.65);
				top = preferTop ? Math.max(topBound, bottomBound - 88 - Math.min(measuredH, maxHeight)) : topBound + 48;
			}

			const originX = align === "end" ? "right" : align === "center" ? "center" : "left";
			const originY = fromTop ? "top" : "bottom";
			setPos({ left, top, maxHeight, origin: `${originY} ${originX}`, fromTop });
		};

		compute();
		const raf = requestAnimationFrame(compute);
		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined" && panelRef.current) {
			ro = new ResizeObserver(compute);
			ro.observe(panelRef.current);
		}
		window.addEventListener("resize", compute);
		return () => {
			cancelAnimationFrame(raf);
			ro?.disconnect();
			window.removeEventListener("resize", compute);
		};
	}, [mounted, open, anchorEl, anchorRect, placement, maxWidth, offset]);

	if (!mounted) return null;

	return createPortal(
		<div className="fixed inset-0 z-(--z-sheet)">
			<div
				aria-hidden="true"
				onClick={onClose}
				className={`absolute inset-0 bg-m-scrim/35 transition-opacity duration-(--m-dur-fast) ${visible ? "opacity-100" : "opacity-0"}`}
			/>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-label={typeof activeTitle === "string" ? activeTitle : undefined}
				style={{
					left: `${pos.left}px`,
					top: `${pos.top}px`,
					maxWidth: `min(${maxWidth}px, calc(100vw - ${EDGE_PAD * 2}px))`,
					minWidth: `min(${minWidth}px, calc(100vw - ${EDGE_PAD * 2}px))`,
					maxHeight: `${pos.maxHeight}px`,
					transformOrigin: pos.origin,
				}}
				className={`fixed flex flex-col overflow-hidden rounded-m-lg border border-m-border bg-m-bg-elev text-m-text shadow-m-pop transition-[opacity,transform] duration-(--m-dur-fast) ease-m ${
					visible
						? "scale-100 translate-y-0 opacity-100"
						: pos.fromTop
							? "scale-[0.96] -translate-y-1.5 opacity-0"
							: "scale-[0.96] translate-y-1.5 opacity-0"
				} ${className}`}
			>
				{(activeTitle || activeSubtitle) && (
					<div className="shrink-0 border-b border-m-border px-4 py-2.5">
						{activeTitle && <div className="text-m-sm font-semibold text-m-text">{activeTitle}</div>}
						{activeSubtitle && <div className="mt-0.5 text-m-xs text-m-text-3">{activeSubtitle}</div>}
					</div>
				)}
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{activeChildren}</div>
			</div>
		</div>,
		document.body,
	);
}

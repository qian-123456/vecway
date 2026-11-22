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
				const spaceBelow = vh - box.bottom - offset - EDGE_PAD;
				const spaceAbove = box.top - offset - EDGE_PAD;

				if (preferTop) {
					if (spaceAbove >= Math.min(measuredH, 160) || spaceAbove >= spaceBelow) {
						fromTop = false;
						maxHeight = Math.max(140, Math.min(spaceAbove, vh * 0.72));
						top = Math.max(EDGE_PAD, box.top - offset - Math.min(measuredH, maxHeight));
					} else {
						fromTop = true;
						maxHeight = Math.max(140, Math.min(spaceBelow, vh * 0.72));
						top = box.bottom + offset;
					}
				} else {
					if (spaceBelow >= Math.min(measuredH, 160) || spaceBelow >= spaceAbove) {
						fromTop = true;
						maxHeight = Math.max(140, Math.min(spaceBelow, vh * 0.72));
						top = box.bottom + offset;
					} else {
						fromTop = false;
						maxHeight = Math.max(140, Math.min(spaceAbove, vh * 0.72));
						top = Math.max(EDGE_PAD, box.top - offset - Math.min(measuredH, maxHeight));
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
				maxHeight = Math.max(180, vh * 0.65);
				top = preferTop ? Math.max(EDGE_PAD, vh - 120 - Math.min(measuredH, maxHeight)) : 60;
			}

			const originX = align === "end" ? "right" : align === "center" ? "center" : "left";
			const originY = fromTop ? "top" : "bottom";
			setPos({ left, top, maxHeight, origin: `${originY} ${originX}`, fromTop });
		};

		compute();
		const raf = requestAnimationFrame(compute);
		window.addEventListener("resize", compute);
		return () => {
			cancelAnimationFrame(raf);
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

import { X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton";
import { readTranslateXY, rubberBand, VelocityTracker } from "./gesturePhysics";
import { useOverlay, usePresence } from "./overlay";

const CLOSE_DISTANCE = 96;
const CLOSE_VELOCITY = 0.6;
const EXIT_MS = 240;

/**
 * Bottom sheet (docs/MOBILE_DESIGN.md §3).
 * - Default: menu sheet, auto height, grab handle + centred title.
 * - `fullHeight`: page sheet (Gemini settings layout) — handle, close circle, large left title.
 * Drag the header or pull content down at its scroll boundary to close.
 */
export function BottomSheet({
	open,
	onClose,
	title,
	ariaLabel,
	subtitle,
	children,
	footer,
	fullHeight = false,
	headerRight,
	className = "",
}: {
	open: boolean;
	onClose: () => void;
	title?: ReactNode;
	ariaLabel?: string;
	subtitle?: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
	fullHeight?: boolean;
	/** Extra controls next to the close button (page sheets only). */
	headerRight?: ReactNode;
	className?: string;
}) {
	const { mounted, visible } = usePresence(open, EXIT_MS);
	const isTopModal = useOverlay(open, onClose);
	const snapshotRef = useRef<{
		children: ReactNode;
		title?: ReactNode;
		subtitle?: ReactNode;
		footer?: ReactNode;
	}>({ children, title, subtitle, footer });
	if (open && children != null && children !== false) {
		snapshotRef.current = { children, title, subtitle, footer };
	} else if (!mounted) {
		snapshotRef.current = { children: null, title: undefined, subtitle: undefined, footer: undefined };
	}
	const activeChildren = open ? children : snapshotRef.current.children;
	const activeTitle = open ? title : (title ?? snapshotRef.current.title);
	const activeSubtitle = open ? subtitle : (subtitle ?? snapshotRef.current.subtitle);
	const activeFooter = open ? footer : (footer ?? snapshotRef.current.footer);
	const sheetRef = useRef<HTMLDivElement>(null);
	const scrimRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const trackerRef = useRef(new VelocityTracker());
	const drag = useRef<{
		id: number; startX: number; startY: number; baseY: number; lastY: number;
		active: boolean; content: boolean; touch: boolean; target: HTMLElement;
	} | null>(null);
	const interactive = "button,a,input,textarea,select,label,[contenteditable]:not([contenteditable='false']),[role='slider']";
	const activateDrag = useCallback((el: HTMLDivElement, baseY: number) => {
		el.style.transform = `translate3d(0,${baseY}px,0)`;
		el.dataset.dragging = "true";
		el.style.transition = "none";
		if (scrimRef.current) scrimRef.current.style.transition = "none";
	}, []);
	const moveDrag = useCallback((x: number, y: number, time: number) => {
		const d = drag.current;
		if (!d) return false;
		const el = sheetRef.current;
		if (!d.active && d.content) {
			// Leave nested scroll containers in control until every vertical boundary is at the top.
			let node: HTMLElement | null = d.target;
			while (node && contentRef.current?.contains(node)) {
				if (node.scrollTop > 0) {
					d.startX = x; d.startY = y; d.lastY = y;
					trackerRef.current.reset();
					trackerRef.current.add(x, y, time);
					return false;
				}
				node = node.parentElement;
			}
			const dy = y - d.startY;
			if (dy <= 6 || dy <= Math.abs(x - d.startX)) return false;
			d.active = true;
			if (el) {
				d.baseY = Math.max(0, readTranslateXY(el).y);
				activateDrag(el, d.baseY);
			}
		}
		const rawDy = d.baseY + (y - d.startY);
		const dim = Math.max(160, el?.clientHeight || 320);
		const offset = rawDy < 0 ? rubberBand(rawDy, dim, 0.25) : rawDy;
		d.lastY = y;
		trackerRef.current.add(x, y, time);
		if (el) el.style.transform = `translate3d(0,${offset}px,0)`;
		if (scrimRef.current) {
			scrimRef.current.style.opacity = String(Math.max(0, Math.min(1, 1 - Math.max(0, offset) / dim)));
		}
		return true;
	}, [activateDrag]);
	const finishDrag = useCallback((y: number, time: number, cancelled: boolean) => {
		const d = drag.current;
		drag.current = null;
		const el = sheetRef.current;
		const { vy } = trackerRef.current.velocity(time);
		trackerRef.current.reset();
		if (scrimRef.current) {
			scrimRef.current.style.transition = "";
			scrimRef.current.style.opacity = "";
		}
		if (!d || !el) return;
		delete el.dataset.dragging;
		el.style.transition = "";
		// Inline transforms must never override the CSS exit or the next opening.
		el.style.transform = "";
		const dy = d.baseY + (y - d.startY);
		if (!cancelled && d.active && dy > 0 && (dy > CLOSE_DISTANCE || vy > CLOSE_VELOCITY)) onClose();
	}, [onClose]);

	useEffect(() => {
		drag.current = null;
		trackerRef.current.reset();
		const el = sheetRef.current;
		if (scrimRef.current) {
			scrimRef.current.style.transition = "";
			scrimRef.current.style.opacity = "";
		}
		if (el) {
			delete el.dataset.dragging;
			el.style.transition = "";
			el.style.transform = "";
			if (open && mounted && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
		}
	}, [open, mounted]);
	useEffect(() => {
		const content = contentRef.current;
		if (!open || !content) return;
		const onStart = (e: TouchEvent) => {
			if (e.touches.length !== 1) {
				if (drag.current?.touch) finishDrag(drag.current.lastY, e.timeStamp, true);
				return;
			}
			const target = e.target;
			if (!(target instanceof HTMLElement) || target.closest(interactive) || drag.current) return;
			const t = e.touches[0];
			trackerRef.current.reset();
			trackerRef.current.add(t.clientX, t.clientY, e.timeStamp);
			drag.current = { id: t.identifier, startX: t.clientX, startY: t.clientY, baseY: 0, lastY: t.clientY, active: false, content: true, touch: true, target };
		};
		const onTouchMove = (e: TouchEvent) => {
			const d = drag.current;
			if (!d?.touch) return;
			const t = Array.from(e.touches).find(touch => touch.identifier === d.id);
			if (!t) return;
			if (!e.cancelable) { finishDrag(t.clientY, e.timeStamp, true); return; }
			if (moveDrag(t.clientX, t.clientY, e.timeStamp)) e.preventDefault();
		};
		const onEnd = (e: TouchEvent) => {
			const d = drag.current;
			if (!d?.touch) return;
			const t = Array.from(e.changedTouches).find(touch => touch.identifier === d.id);
			if (t) finishDrag(t.clientY, e.timeStamp, e.type === "touchcancel");
		};
		content.addEventListener("touchstart", onStart, { passive: true });
		content.addEventListener("touchmove", onTouchMove, { passive: false });
		content.addEventListener("touchend", onEnd);
		content.addEventListener("touchcancel", onEnd);
		return () => {
			content.removeEventListener("touchstart", onStart);
			content.removeEventListener("touchmove", onTouchMove);
			content.removeEventListener("touchend", onEnd);
			content.removeEventListener("touchcancel", onEnd);
			if (drag.current?.touch) finishDrag(drag.current.lastY, performance.now(), true);
		};
	}, [open, mounted, moveDrag, finishDrag]);

	if (!mounted) return null;

	const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		const content = e.currentTarget === contentRef.current;
		// Native non-passive touch events handle content without also moving it via pointer events.
		if (!open || drag.current || (content && e.pointerType === "touch")) return;
		if (e.button !== 0 && e.pointerType === "mouse") return;
		const target = e.target;
		if (!(target instanceof HTMLElement) || target.closest(interactive)) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		const el = sheetRef.current;
		const baseY = !content && el ? Math.max(0, readTranslateXY(el).y) : 0;
		trackerRef.current.reset();
		trackerRef.current.add(e.clientX, e.clientY, e.timeStamp);
		drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, baseY, lastY: e.clientY, active: !content, content, touch: false, target };
		if (!content && el) activateDrag(el, baseY);
	};
	const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d || d.touch || d.id !== e.pointerId) return;
		if (moveDrag(e.clientX, e.clientY, e.timeStamp)) e.preventDefault();
	};
	const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d || d.touch || d.id !== e.pointerId) return;
		finishDrag(e.clientY, e.timeStamp, e.type !== "pointerup");
		if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
	};

	const handle = <div aria-hidden className="mx-auto mt-2 h-[5px] w-9 rounded-m-pill bg-m-border-strong" />;

	return createPortal(
		<div
			aria-hidden={!open || undefined}
			className={`fixed inset-x-0 z-(--z-sheet) ${open ? "" : "pointer-events-none"}`}
			style={{
				top: "var(--m-vv-top, 0px)",
				height: "var(--m-vh, 100dvh)",
			}}
		>
			<div
				ref={scrimRef}
				aria-hidden
				onClick={onClose}
				className={`absolute inset-0 bg-m-scrim transition-opacity ease-m motion-reduce:duration-150 ${visible ? "opacity-100 duration-(--m-dur-sheet)" : "opacity-0 duration-(--m-dur-sheet-exit)"}`}
			/>
			<div
				ref={sheetRef}
				role="dialog"
				aria-modal={isTopModal ? "true" : undefined}
				aria-label={ariaLabel ?? (typeof activeTitle === "string" ? activeTitle : undefined)}
				tabIndex={-1}
				data-visible={visible ? "true" : "false"}
				className={`m-sheet-surface absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-m-xl bg-m-bg-elev text-m-text outline-none ${visible ? "translate-y-0" : "translate-y-full"} ${className}`}
				style={{
					boxSizing: "border-box",
					maxHeight: "calc(var(--m-vh, 100dvh) - var(--m-safe-top) - 12px)",
					height: fullHeight ? "calc(var(--m-vh, 100dvh) - var(--m-safe-top) - 12px)" : undefined,
					paddingBottom: "max(0px, calc(var(--m-safe-bottom) - var(--m-kb, 0px)))",
					paddingLeft: "var(--m-safe-left)",
					paddingRight: "var(--m-safe-right)",
				}}
			>
				<div
					className="shrink-0 touch-none select-none"
					onPointerDown={onDown}
					onPointerMove={onMove}
					onPointerUp={onUp}
					onPointerCancel={onUp}
					onLostPointerCapture={onUp}
				>
					{handle}
					{fullHeight ? (
						<>
							<div className="flex items-center justify-end gap-1 px-3 pt-1">
								{headerRight}
								<IconButton variant="filled" icon={<X size={20} />} label="关闭" onClick={onClose} />
							</div>
							{activeTitle != null && (
								<div className="px-5 pt-1 pb-3">
									<h2 className="text-m-title font-medium break-words">{activeTitle}</h2>
									{activeSubtitle != null && <div className="mt-1 text-m-sm break-words text-m-text-3">{activeSubtitle}</div>}
								</div>
							)}
						</>
					) : activeTitle != null ? (
						<div className="px-12 pt-3 pb-2 text-center">
							<h2 className="text-m-md font-semibold break-words">{activeTitle}</h2>
							{activeSubtitle != null && <div className="mt-0.5 text-m-xs break-words text-m-text-3">{activeSubtitle}</div>}
						</div>
					) : (
						<div className="h-3" />
					)}
				</div>
				<div
					ref={contentRef}
					className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
					onPointerDown={onDown}
					onPointerMove={onMove}
					onPointerUp={onUp}
					onPointerCancel={onUp}
					onLostPointerCapture={onUp}
				>{activeChildren}</div>
				{activeFooter != null && <div className="shrink-0 px-4 pt-2 pb-3">{activeFooter}</div>}
			</div>
		</div>,
		document.body,
	);
}

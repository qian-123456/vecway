import { useEffect, useRef, useState } from "react";
import { nav } from "../core/nav";

/**
 * Mount/unmount with a transition window: `mounted` stays true while the exit
 * transition plays, `visible` flips one frame after mount so CSS transitions run.
 */
export function usePresence(open: boolean, ms = 300): { mounted: boolean; visible: boolean } {
	const [mounted, setMounted] = useState(open);
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (open) {
			setMounted(true);
			let inner = 0;
			const outer = requestAnimationFrame(() => {
				inner = requestAnimationFrame(() => setVisible(true));
			});
			return () => {
				cancelAnimationFrame(outer);
				cancelAnimationFrame(inner);
			};
		}
		setVisible(false);
		const t = setTimeout(() => setMounted(false), ms);
		return () => clearTimeout(t);
	}, [open, ms]);
	return { mounted, visible: visible && open };
}

let lockCount = 0;
let prevOverflow = "";

function lockScroll(): () => void {
	if (lockCount === 0) {
		prevOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
	}
	lockCount += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		lockCount -= 1;
		if (lockCount === 0) document.body.style.overflow = prevOverflow;
	};
}

const escapeStack: Array<() => void> = [];

function onDocumentKeyDown(e: KeyboardEvent): void {
	if (e.key !== "Escape" || e.defaultPrevented) return;
	const top = escapeStack[escapeStack.length - 1];
	if (top) top();
}

/**
 * Shared overlay behaviour while `open`: back-gesture layer, topmost-only Escape to close,
 * body scroll lock, and safe focus restore once all overlays close.
 */
export function useOverlay(open: boolean, onClose: () => void): void {
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const disposeLayer = nav.pushLayer(() => closeRef.current());
		const unlock = lockScroll();
		const entry = () => closeRef.current();
		if (escapeStack.length === 0) document.addEventListener("keydown", onDocumentKeyDown);
		escapeStack.push(entry);
		return () => {
			const idx = escapeStack.lastIndexOf(entry);
			if (idx >= 0) escapeStack.splice(idx, 1);
			if (escapeStack.length === 0) document.removeEventListener("keydown", onDocumentKeyDown);
			unlock();
			disposeLayer();
			if (lockCount === 0 && previous?.isConnected) previous.focus({ preventScroll: true });
		};
	}, [open]);
}

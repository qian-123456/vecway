/**
 * Global copy-feedback pill store, anchor extraction, obstacle-aware positioning,
 * and native `copy` event listener.
 * Drives <CopyFeedbackPill /> right beside the copied selection or clicked button,
 * avoiding overlap with floating selection/annotation bubbles.
 */
import { create } from "zustand";

export interface CopyPillRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export interface CopyFeedbackItem {
	id: number;
	label?: string;
	anchor: CopyPillRect | null;
	fromSelection: boolean;
}

export interface CopyFeedbackOptions {
	label?: string;
	anchor?: CopyPillRect | null;
	fromSelection?: boolean;
	ttlMs?: number;
}

interface CopyFeedbackState {
	current: CopyFeedbackItem | null;
	show: (opts?: CopyFeedbackOptions) => void;
	clear: () => void;
}

const DEFAULT_TTL_MS = 1400;
const CLICK_ANCHOR_TTL_MS = 1500;
const PILL_GAP = 8;
const OBSTACLE_GAP = 6;

let seq = 0;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let recentClick: { rect: CopyPillRect; at: number } | null = null;

function toRect(r: { left: number; top: number; right: number; bottom: number; width: number; height: number }): CopyPillRect {
	return {
		left: r.left,
		top: r.top,
		right: r.right,
		bottom: r.bottom,
		width: r.width,
		height: r.height,
	};
}

function nonEmptyRect(r: CopyPillRect | null | undefined): CopyPillRect | null {
	if (!r) return null;
	return r.width > 0 || r.height > 0 ? r : null;
}

export const useCopyFeedback = create<CopyFeedbackState>((set) => ({
	current: null,
	show: (opts = {}) => {
		const id = ++seq;
		const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		set({
			current: {
				id,
				label: opts.label,
				anchor: nonEmptyRect(opts.anchor),
				fromSelection: Boolean(opts.fromSelection),
			},
		});
		if (hideTimer !== undefined) clearTimeout(hideTimer);
		if (ttlMs > 0) {
			hideTimer = setTimeout(() => {
				if (useCopyFeedback.getState().current?.id === id) {
					useCopyFeedback.getState().clear();
				}
			}, ttlMs);
		}
	},
	clear: () => set({ current: null }),
}));

/** Return the rect of the most recently clicked control when still fresh (e.g. a Copy button). */
export function getRecentClickAnchor(now = Date.now()): CopyPillRect | null {
	if (!recentClick || now - recentClick.at > CLICK_ANCHOR_TTL_MS) return null;
	return recentClick.rect;
}

/** Clear recorded click anchor (primarily for test isolation). */
export function resetCopyFeedbackAnchors(): void {
	recentClick = null;
}

/** Trigger the copy-feedback pill. Safe to call outside React. */
export function notifyCopied(opts?: CopyFeedbackOptions): void {
	const anchor = opts?.anchor !== undefined ? opts.anchor : getRecentClickAnchor();
	useCopyFeedback.getState().show({ ...opts, anchor });
}

/** Extract copied text from a DOM `copy` event (clipboardData, input/textarea, or window selection). */
export function extractCopiedTextFromEvent(e: ClipboardEvent): string {
	const fromClipboard = e.clipboardData?.getData("text/plain");
	if (fromClipboard) return fromClipboard;

	const active = document.activeElement;
	if (
		(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
		active.selectionStart != null &&
		active.selectionEnd != null &&
		active.selectionEnd > active.selectionStart
	) {
		return active.value.slice(active.selectionStart, active.selectionEnd);
	}

	return window.getSelection()?.toString() ?? "";
}

function unionRects(rects: CopyPillRect[]): CopyPillRect | null {
	if (rects.length === 0) return null;
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const r of rects) {
		if (r.width === 0 && r.height === 0) continue;
		if (r.left < left) left = r.left;
		if (r.top < top) top = r.top;
		if (r.right > right) right = r.right;
		if (r.bottom > bottom) bottom = r.bottom;
	}
	if (!Number.isFinite(left)) return null;
	return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Measure the screen-space bounding rect of the current text selection for positioning the pill. */
export function extractSelectionAnchor(e?: Event): CopyPillRect | null {
	const targetEl = e?.target instanceof Element ? e.target : document.activeElement instanceof Element ? document.activeElement : null;

	// xterm renders selection highlights inside `.xterm-selection div`.
	const xterm = targetEl?.closest(".xterm");
	if (xterm) {
		const selRects = Array.from(xterm.querySelectorAll<HTMLElement>(".xterm-selection > div"))
			.map((el) => toRect(el.getBoundingClientRect()));
		const combined = unionRects(selRects);
		if (combined) return combined;
		return nonEmptyRect(toRect(xterm.getBoundingClientRect()));
	}

	const sel = window.getSelection();
	if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
		const range = sel.getRangeAt(0);
		const box = nonEmptyRect(toRect(range.getBoundingClientRect()));
		if (box) return box;
		const clientRects = Array.from(range.getClientRects()).map((r) => toRect(r));
		const combined = unionRects(clientRects);
		if (combined) return combined;
	}

	const active = document.activeElement;
	if (
		(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
		active.selectionStart != null &&
		active.selectionEnd != null &&
		active.selectionEnd > active.selectionStart
	) {
		return nonEmptyRect(toRect(active.getBoundingClientRect()));
	}

	return null;
}

function clamp(val: number, min: number, max: number): number {
	return Math.min(Math.max(val, min), Math.max(min, max));
}

function rectsOverlap(a: CopyPillRect, b: CopyPillRect, gap: number): boolean {
	return !(
		a.right + gap <= b.left ||
		a.left - gap >= b.right ||
		a.bottom + gap <= b.top ||
		a.top - gap >= b.bottom
	);
}

/**
 * Compute viewport coordinates for the copy-feedback pill right beside `anchor`
 * while staying inside `viewport` and avoiding every visible `obstacle`
 * (such as the annotation SelectionBubble).
 */
export function computeCopyPillPosition(
	anchor: CopyPillRect | null,
	pill: { width: number; height: number },
	viewport: { left: number; top: number; right: number; bottom: number },
	obstacles: readonly CopyPillRect[] = [],
): { left: number; top: number } {
	const fallbackLeft = clamp(
		(viewport.left + viewport.right) / 2 - pill.width / 2,
		viewport.left,
		viewport.right - pill.width,
	);
	const fallbackTop = Math.max(viewport.top, viewport.bottom - pill.height - 16);

	if (!anchor || (anchor.width === 0 && anchor.height === 0)) {
		return { left: fallbackLeft, top: fallbackTop };
	}

	const visTop = Math.max(viewport.top, anchor.top);
	const visBottom = Math.min(viewport.bottom, anchor.bottom);
	if (visBottom <= visTop) {
		return { left: fallbackLeft, top: fallbackTop };
	}

	const cx = anchor.left + anchor.width / 2;
	const centeredLeft = clamp(cx - pill.width / 2, viewport.left, viewport.right - pill.width);
	const midY = visTop + (visBottom - visTop - pill.height) / 2;

	const candidates: Array<{ left: number; top: number }> = [
		// 1. Directly above the selection / button.
		{ left: centeredLeft, top: visTop - PILL_GAP - pill.height },
		// 2. Directly below (automatically chosen when SelectionBubble sits above).
		{ left: centeredLeft, top: visBottom + PILL_GAP },
		// 3. Beside any obstacle (e.g. to the right/left of SelectionBubble).
		...obstacles.flatMap((obs) => [
			{
				left: obs.right + OBSTACLE_GAP,
				top: clamp(obs.top + (obs.height - pill.height) / 2, viewport.top, viewport.bottom - pill.height),
			},
			{
				left: obs.left - OBSTACLE_GAP - pill.width,
				top: clamp(obs.top + (obs.height - pill.height) / 2, viewport.top, viewport.bottom - pill.height),
			},
		]),
		// 4. Directly to the right/left of the selection itself.
		{ left: anchor.right + PILL_GAP, top: clamp(midY, viewport.top, viewport.bottom - pill.height) },
		{ left: anchor.left - PILL_GAP - pill.width, top: clamp(midY, viewport.top, viewport.bottom - pill.height) },
		// 5. Above/below obstacles as a last resort before fallback.
		...obstacles.flatMap((obs) => [
			{ left: centeredLeft, top: obs.top - OBSTACLE_GAP - pill.height },
			{ left: centeredLeft, top: obs.bottom + OBSTACLE_GAP },
		]),
	];

	for (const c of candidates) {
		const box: CopyPillRect = {
			left: c.left,
			top: c.top,
			right: c.left + pill.width,
			bottom: c.top + pill.height,
			width: pill.width,
			height: pill.height,
		};
		const inViewport =
			box.left >= viewport.left &&
			box.right <= viewport.right &&
			box.top >= viewport.top &&
			box.bottom <= viewport.bottom;
		if (!inViewport) continue;
		if (obstacles.some((obs) => rectsOverlap(box, obs, OBSTACLE_GAP))) continue;
		return c;
	}

	return { left: fallbackLeft, top: fallbackTop };
}

function hasActiveSelection(): boolean {
	const sel = window.getSelection();
	if (sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().length > 0) {
		return true;
	}
	const active = document.activeElement;
	if (
		(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
		active.selectionStart != null &&
		active.selectionEnd != null &&
		active.selectionEnd > active.selectionStart
	) {
		return true;
	}
	for (const el of document.querySelectorAll<HTMLElement>(".xterm-selection > div")) {
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) return true;
	}
	return false;
}

/**
 * Install global capture listeners for pointer clicks (so copy buttons/menus
 * anchor the pill next to where the user clicked), DOM `copy` events (Cmd+C
 * / Edit -> Copy / context menu copy), and selection clearing so selection-
 * triggered pills disappear immediately when the user deselects.
 */
export function installGlobalCopyFeedbackListener(target: Document = document): () => void {
	const dismissIfSelectionCleared = () => {
		const cur = useCopyFeedback.getState().current;
		if (!cur?.fromSelection) return;
		if (!hasActiveSelection()) {
			useCopyFeedback.getState().clear();
		}
	};

	const recordClick = (e: PointerEvent | MouseEvent) => {
		if (!(e.target instanceof Element)) return;
		const control = e.target.closest('button, [role="menuitem"], [role="button"], a') ?? e.target;
		const rect = toRect(control.getBoundingClientRect());
		if (rect.width > 0 && rect.height > 0) {
			recentClick = { rect, at: Date.now() };
		} else if (e.clientX > 0 || e.clientY > 0) {
			recentClick = {
				rect: {
					left: e.clientX - 4,
					top: e.clientY - 4,
					right: e.clientX + 4,
					bottom: e.clientY + 4,
					width: 8,
					height: 8,
				},
				at: Date.now(),
			};
		}
		if (useCopyFeedback.getState().current?.fromSelection) {
			setTimeout(dismissIfSelectionCleared, 0);
		}
	};

	const onCopy = (e: ClipboardEvent) => {
		const text = extractCopiedTextFromEvent(e);
		if (!text) return;
		const anchor = extractSelectionAnchor(e);
		notifyCopied({ anchor, fromSelection: true });
	};

	target.addEventListener("pointerdown", recordClick, true);
	target.addEventListener("copy", onCopy);
	target.addEventListener("selectionchange", dismissIfSelectionCleared);
	return () => {
		target.removeEventListener("pointerdown", recordClick, true);
		target.removeEventListener("copy", onCopy);
		target.removeEventListener("selectionchange", dismissIfSelectionCleared);
	};
}

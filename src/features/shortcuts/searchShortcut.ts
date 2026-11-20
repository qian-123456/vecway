import { useEffect, useRef, type RefObject } from "react";
import { isComposing } from "../../lib/hooks";

export type SlashSearchTier = "modal" | "popover" | "panel" | "page";

export interface SlashSearchOptions {
	tier: SlashSearchTier;
	enabled?: boolean;
	/** Required for modal/popover/panel scopes; optional for standalone page views. */
	scopeRef?: RefObject<HTMLElement | null>;
}

interface Entry {
	tier: SlashSearchTier;
	enabled: boolean;
	scopeRef?: RefObject<HTMLElement | null>;
	run: () => boolean | void;
}

const EDITABLE_SELECTOR =
	'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, .monaco-editor, .xterm';
const MODAL_SELECTOR = '[data-layer="modal"], [aria-modal="true"]';
const FLOATING_SELECTOR =
	'[data-layer]:not([data-layer="modal"], [data-layer="toast"], [data-layer="pill"], [data-layer="hovercard"], [role="status"]), [role="menu"]';

const entries = new Set<Entry>();
let uninstallListener: (() => void) | null = null;

function effectiveZ(el: Element): number {
	const raw = getComputedStyle(el).zIndex;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isFinite(parsed)) return parsed;
	let cur = el.parentElement;
	while (cur) {
		const pz = Number.parseInt(getComputedStyle(cur).zIndex, 10);
		if (Number.isFinite(pz)) return pz;
		cur = cur.parentElement;
	}
	return 0;
}

/** Deduplicate nested wrappers (e.g. Modal backdrop + inner [aria-modal="true"]) and return the topmost root. */
function topmostElement(selector: string): HTMLElement | null {
	const all = Array.from(document.querySelectorAll<HTMLElement>(selector));
	if (all.length === 0) return null;
	const roots = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
	let best: HTMLElement | null = null;
	let bestZ = -Infinity;
	for (const el of roots) {
		const z = effectiveZ(el);
		if (best === null || z >= bestZ) {
			best = el;
			bestZ = z;
		}
	}
	return best;
}

function insideScope(container: Element | null, scopeRef?: RefObject<HTMLElement | null>): boolean {
	const scope = scopeRef?.current;
	if (!container || !scope) return false;
	return container === scope || container.contains(scope) || scope.contains(container);
}

function invokeEntries(candidates: Entry[]): boolean {
	for (const entry of candidates) {
		const result = entry.run();
		if (result !== false) return true;
	}
	return false;
}

function resolveSlashCandidates(active: Element | null, target: Element | null): Entry[] {
	const activeEntries = Array.from(entries).filter((e) => e.enabled);
	if (activeEntries.length === 0) return [];

	const topModal = topmostElement(MODAL_SELECTOR);
	const topFloating = topmostElement(FLOATING_SELECTOR);

	// A non-modal popover/menu stacked above (or without) a modal owns `/` so it never leaks underneath.
	if (topFloating && (!topModal || effectiveZ(topFloating) >= effectiveZ(topModal))) {
		return activeEntries.filter(
			(e) => e.tier === "popover" && insideScope(topFloating, e.scopeRef),
		);
	}

	if (topModal) {
		return activeEntries.filter(
			(e) => e.tier === "modal" && insideScope(topModal, e.scopeRef),
		);
	}

	const focusNode = active && active !== document.body && active !== document.documentElement ? active : target;
	const panelMatches = activeEntries.filter(
		(e) =>
			e.tier === "panel" &&
			e.scopeRef?.current?.isConnected &&
			focusNode !== null &&
			e.scopeRef.current.contains(focusNode),
	);
	if (panelMatches.length > 0) return panelMatches;

	// If focus sits inside a panel scope (e.g. a non-search tab), never steal `/` to the main page.
	if (focusNode?.closest("[data-slash-panel]")) return [];

	return activeEntries.filter(
		(e) =>
			e.tier === "page" ||
			// Allow standalone renders of modal-hosted views (e.g. SettingsPage in unit tests).
			(e.tier === "modal" && e.scopeRef?.current && !e.scopeRef.current.closest(MODAL_SELECTOR)),
	);
}

function handleGlobalKeyDown(e: KeyboardEvent): void {
	if (e.defaultPrevented) return;
	if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
	if (e.isComposing || isComposing({ nativeEvent: e, key: e.key })) return;
	if (document.querySelector("[data-shortcut-recording]")) return;

	const target = e.target instanceof Element ? e.target : null;
	const active = document.activeElement instanceof Element ? document.activeElement : null;
	if (target?.closest(EDITABLE_SELECTOR) || active?.closest(EDITABLE_SELECTOR)) return;

	const candidates = resolveSlashCandidates(active, target);
	if (candidates.length === 0) return;

	if (invokeEntries(candidates)) {
		e.preventDefault();
		e.stopPropagation();
	}
}

function syncListener(): void {
	if (entries.size > 0 && !uninstallListener) {
		window.addEventListener("keydown", handleGlobalKeyDown, true);
		uninstallListener = () => {
			window.removeEventListener("keydown", handleGlobalKeyDown, true);
			uninstallListener = null;
		};
	} else if (entries.size === 0 && uninstallListener) {
		uninstallListener();
	}
}

/** Focus and select an input immediately; returns false if unmounted. */
export function focusAndSelect(el: HTMLInputElement | null | undefined): boolean {
	if (!el || !el.isConnected) return false;
	el.focus();
	el.select();
	return true;
}

/** Focus an input now, or on the next tick after a collapsible search bar mounts. */
export function focusDeferred(ref: RefObject<HTMLInputElement | null>): void {
	if (focusAndSelect(ref.current)) return;
	window.setTimeout(() => {
		focusAndSelect(ref.current);
	}, 0);
}

/**
 * Subscribe a surface's search input to the `/` shortcut within its active scope.
 * Returns false from `onTrigger` to decline handling when no search control is active.
 */
export function useSlashSearch(
	onTrigger: () => boolean | void,
	{ tier, enabled = true, scopeRef }: SlashSearchOptions,
): void {
	const onTriggerRef = useRef(onTrigger);
	onTriggerRef.current = onTrigger;

	useEffect(() => {
		const entry: Entry = {
			tier,
			enabled,
			scopeRef,
			run: () => onTriggerRef.current(),
		};
		entries.add(entry);
		syncListener();
		return () => {
			entries.delete(entry);
			syncListener();
		};
	}, [tier, enabled, scopeRef]);
}

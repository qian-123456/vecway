import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useState } from "react";
import { claimEscape } from "./escapeClaim";
import { shortPath } from "./paths";

/** Call `onEscape` when the Escape key is pressed. Attach once per open modal/popover. */
export function useEscapeKey(onEscape: () => void, active = true): void {
	useEffect(() => {
		if (!active) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (isComposing({ nativeEvent: e, key: e.key })) return;
				e.stopPropagation();
				claimEscape(e);
				onEscape();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onEscape, active]);
}

let composingTarget: EventTarget | null = null;
let commitEnter: Event | null = null;
let lastCompositionEndAt: number | null = null;

if (typeof document !== "undefined") {
	// Runs before the shortcut dispatcher's window-capture listener (hooks.ts is imported first).
	window.addEventListener(
		"keydown",
		(e) => {
			if (
				e.key === "Enter" &&
				!e.isComposing &&
				lastCompositionEndAt !== null &&
				Math.abs(e.timeStamp - lastCompositionEndAt) < 50
			) {
				commitEnter = e;
				lastCompositionEndAt = null;
			} else {
				commitEnter = null;
			}
		},
		true,
	);
	document.addEventListener(
		"compositionstart",
		(e) => {
			composingTarget = e.target;
		},
		true,
	);
	document.addEventListener(
		"compositionend",
		(e) => {
			composingTarget = null;
			lastCompositionEndAt = e.timeStamp;
		},
		true,
	);
	// A composition can be orphaned (editor re-rendered or blurred mid-IME, so compositionend never
	// fires). Drop the stale state on focus loss, and on any real key (not the IME's keyCode 229).
	document.addEventListener(
		"focusout",
		(e) => {
			if (e.target === composingTarget) composingTarget = null;
		},
		true,
	);
	document.addEventListener(
		"keydown",
		(e) => {
			if (composingTarget && !e.isComposing && e.keyCode !== 229) composingTarget = null;
			// A non-Enter keydown after compositionend means the composition was committed
			// by Space or a selection key, not Enter; reset so rapid follow-up Enter sends normally.
			if (lastCompositionEndAt !== null && e.key !== "Enter" && !e.isComposing && e.keyCode !== 229) {
				lastCompositionEndAt = null;
			}
		},
		true,
	);
}

/**
 * IME composition guard for Enter-to-submit handlers: skip while composing (拼音选词).
 * On macOS WKWebView, the Enter keydown committing an IME candidate can arrive
 * just after compositionend or with isComposing === false due to event dispatch ordering.
 */
export function isComposing(
	e: { nativeEvent?: unknown; key?: string; isComposing?: boolean; keyCode?: number } | KeyboardEvent,
): boolean {
	const r = e as { nativeEvent?: unknown; key?: string; isComposing?: boolean; keyCode?: number };
	const raw = (r.nativeEvent ?? (typeof Event !== "undefined" && e instanceof Event ? e : r)) as
		| { isComposing?: boolean; keyCode?: number }
		| undefined;
	if (Boolean(raw?.isComposing) || raw?.keyCode === 229) return true;
	if (composingTarget) {
		if ((composingTarget as Node).isConnected === false) composingTarget = null;
		else return true;
	}
	// The Enter that committed the last candidate arrives just after compositionend. It is
	// identified by native event identity (set once by the window capture listener), so every
	// reader of that same event agrees without consuming state; the next Enter is a distinct event.
	if (r.key === "Enter" && commitEnter) {
		const native = r.nativeEvent ?? (typeof Event !== "undefined" && e instanceof Event ? e : undefined);
		if (!native || native === commitEnter) return true;
	}
	return false;
}

/** Test hook: reset IME commit state. */
export function resetLastCompositionEndForTest(): void {
	lastCompositionEndAt = null;
	commitEnter = null;
	composingTarget = null;
}


let homeCache: string | null = null;
let homePromise: Promise<string | null> | null = null;

/** User home directory (cached), for `~` path shortening. */
export function useHomeDir(): string | null {
	const [home, setHome] = useState<string | null>(homeCache);
	useEffect(() => {
		if (homeCache) return;
		homePromise ??= homeDir()
			.then((h) => {
				homeCache = h;
				return h;
			})
			.catch(() => null);
		homePromise.then((h) => setHome(h));
	}, []);
	return home;
}

/** `(path) => path with ~ for home`. */
export function useShortPath(): (path: string) => string {
	const home = useHomeDir();
	return useCallback((path: string) => shortPath(path, home), [home]);
}

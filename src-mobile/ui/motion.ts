/**
 * Shared reduced-motion helpers and CSS presence lifecycle hook for mobile surfaces.
 */
import { useEffect, useState } from "react";

/** True under jsdom where CSS exit transitions are not composited. */
export function isNonCompositedTestEnv(): boolean {
	return typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
}

/** True when the user prefers reduced motion in OS/browser accessibility settings. */
export function prefersReducedMotion(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	} catch {
		return false;
	}
}

/** Smooth scrolling unless the user prefers reduced motion, in which case jump immediately. */
export function scrollBehavior(): ScrollBehavior {
	return prefersReducedMotion() ? "auto" : "smooth";
}
export interface PresenceState {
	/** Keep the DOM mounted while open or finishing its exit animation. */
	present: boolean;
	/** True during the exit window after `open` flips to `false`. */
	exiting: boolean;
}

/**
 * Keeps a mobile surface mounted for `exitMs` after `open` transitions to `false`
 * so exit transitions can complete. Unmounts immediately when `instant` is true or
 * `prefers-reduced-motion: reduce` is active.
 */
export function usePresence(
	open: boolean,
	exitMs: number,
	instant = false,
): PresenceState {
	const [present, setPresent] = useState(open);

	useEffect(() => {
		if (open) {
			setPresent(true);
			return;
		}
		if (!present) return;
		if (instant || exitMs <= 0 || prefersReducedMotion() || isNonCompositedTestEnv()) {
			setPresent(false);
			return;
		}
		const timer = window.setTimeout(() => setPresent(false), exitMs);
		return () => window.clearTimeout(timer);
	}, [open, present, exitMs, instant]);

	return {
		present: open || present,
		exiting: !open && present,
	};
}

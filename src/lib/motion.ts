/**
 * Shared reduced-motion helpers and CSS presence lifecycle hook for desktop surfaces.
 */
import { useEffect, useState } from "react";

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
 * Keeps a surface mounted for `exitMs` after `open` transitions from `true` to `false`
 * so CSS exit transitions can play along the reverse path. Unmounts immediately when
 * `instant` is true, `prefers-reduced-motion: reduce` is active, or running under a
 * non-composited jsdom environment where CSS exit transitions do not paint.
 */
export function usePresence(
	open: boolean,
	exitMs: number,
	instant = false,
): PresenceState {
	const isJsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
	const immediate = instant || exitMs <= 0 || isJsdom;
	const [present, setPresent] = useState(open);

	useEffect(() => {
		if (open) {
			setPresent(true);
			return;
		}
		if (!present) return;
		if (immediate || prefersReducedMotion()) {
			setPresent(false);
			return;
		}
		const timer = window.setTimeout(() => setPresent(false), exitMs);
		return () => window.clearTimeout(timer);
	}, [open, present, exitMs, immediate]);

	if (!open && (immediate || prefersReducedMotion())) {
		return { present: false, exiting: false };
	}

	return {
		present: open || present,
		exiting: !open && present,
	};
}

/**
 * Shared mobile gesture physics primitives:
 * - `readTranslateXY`: reads the currently rendered CSS transform for mid-animation grab takeover
 * - `rubberBand`: progressive iOS-style resistance past scroll/drag boundaries
 * - `VelocityTracker`: 80ms sliding window for instantaneous release velocity (px/ms)
 */

export interface TranslateXY {
	x: number;
	y: number;
}

/** Parse a CSS length token (`px` or `%` against `refSize`) into pixels. */
function parseTranslateToken(token: string | undefined, refSize: number): number {
	if (!token) return 0;
	if (token.endsWith("px")) {
		const n = Number.parseFloat(token);
		return Number.isFinite(n) ? n : 0;
	}
	if (token.endsWith("%")) {
		const pct = Number.parseFloat(token);
		return Number.isFinite(pct) && refSize > 0 ? (pct / 100) * refSize : 0;
	}
	const n = Number.parseFloat(token);
	return Number.isFinite(n) ? n : 0;
}

/** Parse CSS independent `translate` property (`none`, `<x>`, `<x> <y>`, `<x> <y> <z>`). */
function readIndependentTranslate(style: CSSStyleDeclaration, el: HTMLElement): TranslateXY {
	const raw = (style as CSSStyleDeclaration & { translate?: string }).translate;
	if (!raw || raw === "none") return { x: 0, y: 0 };
	const parts = raw.trim().split(/\s+/);
	if (parts.length === 0) return { x: 0, y: 0 };
	return {
		x: parseTranslateToken(parts[0], el.clientWidth || el.offsetWidth),
		y: parseTranslateToken(parts[1], el.clientHeight || el.offsetHeight),
	};
}

/** Parse CSS `transform` matrix translation (`none`, `matrix(...)`, `matrix3d(...)`). */
function readMatrixTranslate(raw: string): TranslateXY {
	if (!raw || raw === "none") return { x: 0, y: 0 };
	try {
		if (typeof DOMMatrix !== "undefined") {
			const matrix = new DOMMatrix(raw);
			return {
				x: Number.isFinite(matrix.m41) ? matrix.m41 : 0,
				y: Number.isFinite(matrix.m42) ? matrix.m42 : 0,
			};
		}
	} catch {
		// Fall through to regex parsing in restricted environments.
	}
	const m3d = /^matrix3d\(([^)]+)\)$/.exec(raw);
	if (m3d) {
		const parts = m3d[1].split(",").map((v) => Number.parseFloat(v.trim()));
		if (parts.length === 16) {
			return {
				x: Number.isFinite(parts[12]) ? parts[12] : 0,
				y: Number.isFinite(parts[13]) ? parts[13] : 0,
			};
		}
	}
	const m2d = /^matrix\(([^)]+)\)$/.exec(raw);
	if (m2d) {
		const parts = m2d[1].split(",").map((v) => Number.parseFloat(v.trim()));
		if (parts.length === 6) {
			return {
				x: Number.isFinite(parts[4]) ? parts[4] : 0,
				y: Number.isFinite(parts[5]) ? parts[5] : 0,
			};
		}
	}
	return { x: 0, y: 0 };
}

/**
 * Read the current rendered X/Y translation of an element (including mid-transition frames)
 * by summing CSS `transform` and independent `translate` (Tailwind v4 `translate-y-*` / `translate-x-*`)
 * so gestures can catch and take over an open/close or snap-back animation seamlessly.
 */
export function readTranslateXY(el: HTMLElement | null): TranslateXY {
	if (!el || typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
		return { x: 0, y: 0 };
	}
	const style = window.getComputedStyle(el);
	const matrix = readMatrixTranslate(style.transform);
	const indep = readIndependentTranslate(style, el);
	return {
		x: matrix.x + indep.x,
		y: matrix.y + indep.y,
	};
}

/**
 * Progressive rubber-band damping past a boundary (`dim` = reference dimension in px).
 * Asymptotically approaches `dim` without hard stops.
 */
export function rubberBand(offset: number, dim: number, coeff = 0.55): number {
	if (!Number.isFinite(offset) || offset === 0) return 0;
	const d = Math.max(1, Number.isFinite(dim) ? Math.abs(dim) : 1);
	const c = Math.max(0, coeff);
	if (c === 0) return 0;
	const abs = Math.abs(offset);
	const damped = (abs * d * c) / (d + c * abs);
	return offset < 0 ? -damped : damped;
}

interface Sample {
	x: number;
	y: number;
	t: number;
}

const DEFAULT_WINDOW_MS = 80;
const STALE_CUTOFF_MS = 100;

/**
 * Tracks pointer movement over a recent sliding window (default 80ms) to compute
 * instantaneous release velocity in `px/ms` instead of whole-gesture averages.
 */
export class VelocityTracker {
	private samples: Sample[] = [];
	private readonly windowMs: number;

	constructor(windowMs = DEFAULT_WINDOW_MS) {
		this.windowMs = windowMs;
	}

	add(x: number, y: number, t = performance.now()): void {
		const cutoff = t - this.windowMs;
		const last = this.samples[this.samples.length - 1];
		if (last && t <= last.t) {
			last.x = x;
			last.y = y;
			last.t = t;
		} else {
			this.samples.push({ x, y, t });
		}
		while (this.samples.length > 2 && this.samples[0].t < cutoff) {
			this.samples.shift();
		}
	}

	velocity(now?: number): { vx: number; vy: number } {
		if (this.samples.length < 2) return { vx: 0, vy: 0 };
		const latest = this.samples[this.samples.length - 1];
		const refTime = now ?? latest.t;
		if (refTime - latest.t > STALE_CUTOFF_MS) return { vx: 0, vy: 0 };
		const cutoff = refTime - this.windowMs;
		let first = this.samples[0];
		for (let i = 0; i < this.samples.length - 1; i++) {
			if (this.samples[i].t >= cutoff) {
				first = this.samples[i];
				break;
			}
			first = this.samples[i];
		}
		const dt = latest.t - first.t;
		if (!(dt >= 4)) return { vx: 0, vy: 0 };
		return {
			vx: (latest.x - first.x) / dt,
			vy: (latest.y - first.y) / dt,
		};
	}

	reset(): void {
		this.samples.length = 0;
	}
}

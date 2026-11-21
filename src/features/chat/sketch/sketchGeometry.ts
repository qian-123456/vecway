/**
 * Pure geometry, bounds, shape outlines, stroke smoothing, pressure simulation,
 * hit-testing, transforms, alignment snapping, and vector erasure math for SketchPad.
 *
 * Framework-free and DOM-free: no React, no Canvas 2D, no external geometry libs.
 */

// ---------------------------------------------------------------------------
// Contract types (frozen — do not change; see SPEC.md "Contract")
// ---------------------------------------------------------------------------

export type SketchTool = "select" | "pen" | "text" | "shapes" | "eraser";
export type ShapeKind =
	| "line"
	| "arrow"
	| "rectangle"
	| "ellipse"
	| "triangle"
	| "diamond"
	| "star"
	| "heart";

export interface SketchPoint {
	x: number;
	y: number;
	pressure?: number;
	breakBefore?: boolean;
}

export interface StrokeStyle {
	color: string;
	width: number;
}

export interface TextFormat {
	bold: boolean;
	italic: boolean;
	underline: boolean;
}

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type SketchItem =
	| {
			kind: "stroke";
			id: string;
			points: SketchPoint[];
			style: StrokeStyle;
			// Normalized per-axis basis captured when a resize collapses a
			// dimension to zero; lets re-expansion recover original ratios. (`rt`)
			resizeBasis?: { x?: number[]; y?: number[] };
	  }
	| {
			// Residual produced by the vector eraser. Shares the stroke shape.
			kind: "ink";
			id: string;
			points: SketchPoint[];
			style: StrokeStyle;
	  }
	| {
			kind: "line";
			id: string;
			from: SketchPoint;
			to: SketchPoint;
			style: StrokeStyle;
	  }
	| {
			kind: "arrow";
			id: string;
			from: SketchPoint;
			to: SketchPoint;
			style: StrokeStyle;
	  }
	| {
			kind:
				| "rectangle"
				| "ellipse"
				| "triangle"
				| "diamond"
				| "star"
				| "heart";
			id: string;
			bounds: Bounds;
			style: StrokeStyle;
			flipX?: boolean;
			flipY?: boolean;
	  }
	| {
			kind: "text";
			id: string;
			text: string;
			bounds: Bounds;
			// style.width is the font size for text objects.
			style: StrokeStyle;
			format: TextFormat;
	  };

export interface SketchDoc {
	schemaVersion: 1;
	objects: SketchItem[];
}

/** Transient live-eraser object exposed through PreviewInfo.object. */
export interface SketchEraserPreview {
	kind: "eraser";
	id: string;
	points: SketchPoint[];
	width: number;
}

export interface PreviewInfo {
	object: SketchItem | SketchEraserPreview;
	replaceObjectId: string | null;
	transformKind: "move" | "resize" | undefined;
}

export interface SnapGuide {
	kind: "alignment";
	axis: "x" | "y";
	coordinate: number;
	start: number;
	end: number;
}

export interface PointerSample {
	pointerId: number;
	point: { x: number; y: number };
	viewportScale: number;
	tolerance: number;
	handleTolerance: number;
	snapTolerance: number;
	shiftKey: boolean;
	altKey: boolean;
	pressure: number | null;
	pointerType: string;
	timestamp: number | null;
	surfaceBounds: Bounds;
}

/** Pending text-edit input; `objectId: null` creates a new text object. */
export interface SketchTextEditInput {
	text: string;
	objectId?: string | null;
	/** Bounds in document space. When omitted, computed from `point`. */
	bounds?: Bounds;
	/** Tap position used to place a new text box when `bounds` is omitted. */
	point?: { x: number; y: number };
	style?: Partial<StrokeStyle>;
	format?: Partial<TextFormat>;
}

/** Normalized pending-edit input (bounds always present). */
export interface SketchTextEdit extends SketchTextEditInput {
	objectId: string | null;
	bounds: Bounds;
}

export type SketchExportResult =
	| { kind: "success"; dataUrl: string; width: number; height: number }
	| { kind: "empty" }
	| { kind: "busy" }
	| { kind: "unavailable" };

export type ResizeHandle =
	| "nw"
	| "n"
	| "ne"
	| "e"
	| "se"
	| "s"
	| "w"
	| "sw"
	| "start"
	| "end";

export interface PressureState {
	point: { x: number; y: number };
	timestamp: number | null;
	velocity: number | null;
	pressure: number;
	source: "speed" | "stylus";
}

export interface SnapResult {
	delta: { x: number; y: number };
	guides: SnapGuide[];
}

export interface EraserSegment {
	from: { x: number; y: number };
	to: { x: number; y: number };
}

export interface ErasureSession {
	readonly released: boolean;
	readonly document: SketchDoc;
	append(points: SketchPoint[]): void;
	finish(): void;
	cancel(): void;
}

// ---------------------------------------------------------------------------
// Constants (all values from the reference implementation)
// ---------------------------------------------------------------------------

export const DEFAULT_STYLE: StrokeStyle = { color: "#111827", width: 12 };
export const DEFAULT_FORMAT: TextFormat = {
	bold: false,
	italic: false,
	underline: false,
};

// Clamps.
export const ERASER_MIN = 4;
export const ERASER_MAX = 96;
export const ERASER_DEFAULT = 32;
export const DRAWING_WIDTH_MIN = 1;
export const DRAWING_WIDTH_MAX = 32;
export const STYLE_WIDTH_MIN = 2;
export const STYLE_WIDTH_MAX = 48;
export const TEXT_SIZE_MIN = 8;
export const TEXT_SIZE_MAX = 128;
export const TEXT_SIZE_DEFAULT = 24;

// Interaction.
export const HIT_TOLERANCE = 10;
export const HANDLE_TOLERANCE_MOUSE = 7;
export const HANDLE_TOLERANCE_TOUCH = 14;
export const SIDE_HANDLE_MIN_SPACING = 20;
export const CORNER_HANDLE_MIN_SPACING = 28;
export const SNAP_TOLERANCE = 6;
export const PASTE_OFFSET = 12;
export const SHAPE_MIN_SIZE = 2;
export const TEXT_INITIAL_WIDTH = 240;
export const TEXT_PADDING = 8;
export const TEXT_LINE_HEIGHT_RATIO = 1.25;
export const TEXT_RENDER_SIZE = 24; // text is rasterized at 24px and scaled
export const TEXT_FONT_FAMILY =
	'ui-sans-serif, -apple-system, "Segoe UI", sans-serif';

// Stroke smoothing.
const SMOOTH_CORNER = 0.025;
const SMOOTH_PRESSURE = 0.01;
const SMOOTH_MAX_SUBDIVISIONS = 512;
export const MIN_SAMPLE_DISTANCE = 0.5; // divided by viewportScale
const PRESSURE_MIN_FACTOR = 0.42; // width *= lerp(0.42,1,sin(p*pi/2))

// Pressure simulation.
const PRESSURE_MIN = 0.08;
const PRESSURE_DEFAULT = 0.58;
const SPEED_PRESSURE_FLOOR = 0.35;
const SPEED_OFFSET = 0.06; // px/ms dead zone
const SPEED_RANGE = 1.54; // px/ms normalization
const DT_DEFAULT = 16;
const DT_MIN = 4;
const DT_MAX = 50;
const TAU_ACCEL = 24; // velocity low-pass, accelerating
const TAU_DECEL = 48; // velocity low-pass, decelerating
const TAU_PRESSURE_DOWN = 22;
const TAU_PRESSURE_UP = 72;
const TAU_PRESSURE_STYLUS = 18;
const SPEED_NORM = 40; // px normalization scale (o/40 per dt)
const WIDTH_SPEED_FACTOR = 4;
const MAX_PRESSURE_DROP = 0.275;

// Arrowhead.
const ARROW_HEAD_MIN = 12;
const ARROW_HEAD_WIDTH_FACTOR = 3;
const ARROW_HEAD_MAX_RATIO = 0.6;
const ARROW_HEAD_HALF_ANGLE = Math.PI / 6;

// Ellipse polygonization.
const ELLIPSE_MIN_SEGMENTS = 32;
const ELLIPSE_MAX_SEGMENTS = 2048;
const ELLIPSE_RESOLUTION = 0.025;

// Eraser.
const ERASURE_FRAGMENT_MIN_AREA = 4; // px^2
const ERASURE_FRAGMENT_MIN_SIZE = 4; // px (screen)
const ERASURE_BATCH = 8;

// ---------------------------------------------------------------------------
// Scalar / geometry helpers
// ---------------------------------------------------------------------------

export const clamp = (v: number, lo: number, hi: number): number =>
	Math.min(Math.max(v, lo), hi);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const nonNegative = (v: number): number => (Number.isFinite(v) ? Math.max(v, 0) : 0);
export const isFiniteNumber = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

/** Normalize possibly-negative width/height. (`U`) */
export function normalizeBounds(b: Bounds): Bounds {
	return {
		x: Math.min(b.x, b.x + b.width),
		y: Math.min(b.y, b.y + b.height),
		width: Math.abs(b.width),
		height: Math.abs(b.height),
	};
}

/** Bounds spanning two points. (`W`) */
export function boundsFromPoints(
	a: { x: number; y: number },
	b: { x: number; y: number },
): Bounds {
	return normalizeBounds({
		x: a.x,
		y: a.y,
		width: b.x - a.x,
		height: b.y - a.y,
	});
}

/** Bounds of points inflated by pad on every side. (`q`) */
function pointsBounds(
	points: readonly { x: number; y: number }[],
	pad = 0,
): Bounds | null {
	if (points.length === 0) return null;
	const first = points[0];
	if (first == null) return null;
	let minX = first.x;
	let maxX = first.x;
	let minY = first.y;
	let maxY = first.y;
	for (const p of points) {
		minX = Math.min(minX, p.x);
		maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y);
		maxY = Math.max(maxY, p.y);
	}
	const s = nonNegative(pad);
	return {
		x: minX - s,
		y: minY - s,
		width: Math.max(maxX - minX + s * 2, s * 2),
		height: Math.max(maxY - minY + s * 2, s * 2),
	};
}

/** Inflate bounds by pad. (`J`) */
function inflateBounds(b: Bounds, pad: number): Bounds {
	const n = normalizeBounds(b);
	const r = nonNegative(pad);
	return {
		x: n.x - r,
		y: n.y - r,
		width: n.width + r * 2,
		height: n.height + r * 2,
	};
}

/** Union of two bounds. (`ne`) */
function boundsUnion(a: Bounds, b: Bounds): Bounds {
	const n = normalizeBounds(a);
	const r = normalizeBounds(b);
	const x = Math.min(n.x, r.x);
	const y = Math.min(n.y, r.y);
	const w = Math.max(n.x + n.width, r.x + r.width);
	const h = Math.max(n.y + n.height, r.y + r.height);
	return { x, y, width: w - x, height: h - y };
}

/** Intersection of two bounds, or null. (`re`) */
function boundsIntersect(a: Bounds, b: Bounds): Bounds | null {
	const n = normalizeBounds(a);
	const r = normalizeBounds(b);
	const x = Math.max(n.x, r.x);
	const y = Math.max(n.y, r.y);
	const w = Math.min(n.x + n.width, r.x + r.width);
	const h = Math.min(n.y + n.height, r.y + r.height);
	return w <= x || h <= y ? null : { x, y, width: w - x, height: h - y };
}

/** Point inside bounds. (`ae`) */
export function pointInBounds(b: Bounds, p: { x: number; y: number }): boolean {
	const n = normalizeBounds(b);
	return (
		p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height
	);
}

/** `inner` fully inside `outer`. (`oe`) */
export function boundsContain(outer: Bounds, inner: Bounds): boolean {
	const n = normalizeBounds(outer);
	const r = normalizeBounds(inner);
	return (
		r.x >= n.x &&
		r.y >= n.y &&
		r.x + r.width <= n.x + n.width &&
		r.y + r.height <= n.y + n.height
	);
}

/** Bounds equality after normalization. (`ie`) */
export function boundsEqual(a: Bounds | null, b: Bounds | null): boolean {
	if (a == null || b == null) return a === b;
	const n = normalizeBounds(a);
	const r = normalizeBounds(b);
	return (
		n.x === r.x && n.y === r.y && n.width === r.width && n.height === r.height
	);
}

/** Clamp a point into bounds (null bounds = no clamp). (`Y`) */
export function clampPointToBounds<T extends { x: number; y: number }>(
	p: T,
	b: Bounds | null,
): T {
	if (b == null) return p;
	const n = normalizeBounds(b);
	return {
		...p,
		x: clamp(p.x, n.x, n.x + n.width),
		y: clamp(p.y, n.y, n.y + n.height),
	};
}

export const dist = (
	a: { x: number; y: number },
	b: { x: number; y: number },
): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from p to segment ab. (`se`) */
function distToSegment(
	p: { x: number; y: number },
	a: { x: number; y: number },
	b: { x: number; y: number },
): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (dx === 0 && dy === 0) return dist(p, a);
	const t = clamp(
		((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy),
		0,
		1,
	);
	return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export const translatePoint = <T extends { x: number; y: number }>(
	p: T,
	d: { x: number; y: number },
): T => ({ ...p, x: p.x + d.x, y: p.y + d.y });

/** Split points into runs at `breakBefore` boundaries. (`Z`) */
export function splitPointRuns(points: readonly SketchPoint[]): SketchPoint[][] {
	const runs: SketchPoint[][] = [];
	for (const p of points) {
		const last = runs[runs.length - 1];
		if (last == null || p.breakBefore === true) {
			runs.push([p]);
			continue;
		}
		last.push(p);
	}
	return runs;
}

// ---------------------------------------------------------------------------
// Shape templates and outline geometry
// ---------------------------------------------------------------------------

/** Star template: 10 points on the unit box, radii 1 / 0.45. (`De`) */
function starTemplate(): { x: number; y: number }[] {
	const pts: { x: number; y: number }[] = [];
	for (let i = 0; i < 10; i += 1) {
		const a = -Math.PI / 2 + (i * Math.PI) / 5;
		const r = i % 2 === 0 ? 1 : 0.45;
		pts.push({
			x: 0.5 + Math.cos(a) * 0.5 * r,
			y: 0.5 + Math.sin(a) * 0.5 * r,
		});
	}
	return pts;
}
const STAR_POINTS = starTemplate();

type HeartStep =
	| { kind: "line"; end: { x: number; y: number } }
	| {
			kind: "curve";
			control1: { x: number; y: number };
			control2: { x: number; y: number };
			end: { x: number; y: number };
	  };

function cubicAt(
	p0: { x: number; y: number },
	c1: { x: number; y: number },
	c2: { x: number; y: number },
	p1: { x: number; y: number },
	t: number,
): { x: number; y: number } {
	const u = 1 - t;
	const a = u ** 3;
	const b = 3 * u ** 2 * t;
	const c = 3 * u * t ** 2;
	const d = t ** 3;
	return {
		x: p0.x * a + c1.x * b + c2.x * c + p1.x * d,
		y: p0.y * a + c1.y * b + c2.y * c + p1.y * d,
	};
}

/**
 * Heart template (`Oe`): 24x24 bezier silhouette sampled to a polygon and
 * normalized to its own bounding box.
 */
function heartTemplate(): { x: number; y: number }[] {
	const tip = { x: 12, y: 20.25 };
	const steps: HeartStep[] = [
		{ kind: "line", end: { x: 4.73, y: 13.5 } },
		{
			kind: "curve",
			control1: { x: 1.5, y: 10.5 },
			control2: { x: 3.65, y: 5.25 },
			end: { x: 7.5, y: 5.25 },
		},
		{
			kind: "curve",
			control1: { x: 9.55, y: 5.25 },
			control2: { x: 11.04, y: 6.32 },
			end: { x: 12, y: 7.75 },
		},
		{
			kind: "curve",
			control1: { x: 12.96, y: 6.32 },
			control2: { x: 14.45, y: 5.25 },
			end: { x: 16.5, y: 5.25 },
		},
		{
			kind: "curve",
			control1: { x: 20.35, y: 5.25 },
			control2: { x: 22.5, y: 10.5 },
			end: { x: 19.27, y: 13.5 },
		},
		{ kind: "line", end: tip },
	];
	const pts: { x: number; y: number }[] = [tip];
	let prev = tip;
	for (const step of steps) {
		if (step.kind === "line") {
			pts.push(step.end);
		} else {
			for (let i = 1; i <= 16; i += 1) {
				pts.push(cubicAt(prev, step.control1, step.control2, step.end, i / 16));
			}
		}
		prev = step.end;
	}
	const b = pointsBounds(pts);
	if (b == null || b.width === 0 || b.height === 0) return [];
	return pts.map((p) => ({
		x: (p.x - b.x) / b.width,
		y: (p.y - b.y) / b.height,
	}));
}
const HEART_POINTS = heartTemplate();

const scaleToBounds = (
	p: { x: number; y: number },
	b: Bounds,
): { x: number; y: number } => ({
	x: b.x + p.x * b.width,
	y: b.y + p.y * b.height,
});

/**
 * Base polygon points for a shape's `bounds` (template-based shapes only).
 * (`K`)
 */
function shapeTemplatePoints(
	kind: ShapeKind,
	b: Bounds,
): { x: number; y: number }[] {
	const n = { x: b.x, y: b.y };
	const l = b.x;
	const t = b.y;
	const r = b.x + b.width;
	const bo = b.y + b.height;
	const cx = l + b.width / 2;
	const cy = t + b.height / 2;
	switch (kind) {
		case "triangle":
			return [
				{ x: cx, y: t },
				{ x: r, y: bo },
				{ x: l, y: bo },
			];
		case "diamond":
			return [
				{ x: cx, y: t },
				{ x: r, y: cy },
				{ x: cx, y: bo },
				{ x: l, y: cy },
			];
		case "star":
			return STAR_POINTS.map((p) => scaleToBounds(p, b));
		case "heart":
			return HEART_POINTS.map((p) => scaleToBounds(p, b));
		default:
			return [n];
	}
}

/**
 * Shape outline polygon in document space, honoring flips. (`G`)
 * Works for rectangle/ellipse (rectangle corners/ellipse sampled) too when
 * needed by callers via `shapeOutlinePoints`.
 */
export function shapePoints(
	kind: ShapeKind,
	bounds: Bounds,
	opts?: { flipX?: boolean; flipY?: boolean },
): { x: number; y: number }[] {
	const b = normalizeBounds(bounds);
	const pts = shapeTemplatePoints(kind, b);
	const { flipX, flipY } = opts ?? {};
	if (!flipX && !flipY) return pts;
	return pts.map((p) => ({
		x: flipX ? b.x * 2 + b.width - p.x : p.x,
		y: flipY ? b.y * 2 + b.height - p.y : p.y,
	}));
}

/**
 * Outline polyline used by hit-testing/erasure. Rectangle -> 4 corners,
 * ellipse -> adaptive polygon, template shapes -> template points. Closed
 * outlines return `closed: true` via the `closed` flag on the array wrapper.
 */
export function shapeOutlinePoints(item: SketchItem): {
	points: { x: number; y: number }[];
	closed: boolean;
} {
	switch (item.kind) {
		case "rectangle": {
			const b = normalizeBounds(item.bounds);
			return {
				points: [
					{ x: b.x, y: b.y },
					{ x: b.x + b.width, y: b.y },
					{ x: b.x + b.width, y: b.y + b.height },
					{ x: b.x, y: b.y + b.height },
				],
				closed: true,
			};
		}
		case "ellipse": {
			const b = normalizeBounds(item.bounds);
			const rx = b.width / 2;
			const ry = b.height / 2;
			const n = Math.max(
				ELLIPSE_MIN_SEGMENTS,
				Math.min(
					ELLIPSE_MAX_SEGMENTS,
					Math.ceil(Math.PI * Math.sqrt(Math.max(rx, ry) / ELLIPSE_RESOLUTION)),
				),
			);
			const pts: { x: number; y: number }[] = [];
			for (let i = 0; i < n; i += 1) {
				const a = (i * 2 * Math.PI) / n;
				pts.push({
					x: b.x + rx + Math.cos(a) * rx,
					y: b.y + ry + Math.sin(a) * ry,
				});
			}
			return { points: pts, closed: true };
		}
		case "triangle":
		case "diamond":
		case "star":
		case "heart":
			return {
				points: shapePoints(item.kind, item.bounds, item),
				closed: true,
			};
		default:
			return { points: [], closed: false };
	}
}

/** Arrowhead wing endpoints. (`ce`) */
export function arrowHead(arrow: {
	from: { x: number; y: number };
	to: { x: number; y: number };
	style: StrokeStyle;
}): { left: { x: number; y: number }; right: { x: number; y: number } } {
	const angle = Math.atan2(
		arrow.to.y - arrow.from.y,
		arrow.to.x - arrow.from.x,
	);
	const len = dist(arrow.from, arrow.to);
	const headLen = Math.min(
		Math.max(
			Math.max(arrow.style.width, 0) * ARROW_HEAD_WIDTH_FACTOR,
			ARROW_HEAD_MIN,
		),
		len * ARROW_HEAD_MAX_RATIO,
	);
	return {
		left: {
			x: arrow.to.x - Math.cos(angle - ARROW_HEAD_HALF_ANGLE) * headLen,
			y: arrow.to.y - Math.sin(angle - ARROW_HEAD_HALF_ANGLE) * headLen,
		},
		right: {
			x: arrow.to.x - Math.cos(angle + ARROW_HEAD_HALF_ANGLE) * headLen,
			y: arrow.to.y - Math.sin(angle + ARROW_HEAD_HALF_ANGLE) * headLen,
		},
	};
}

/** Midpoint of the arrowhead base — where the shaft ends. (`Q`) */
export function arrowShaftEnd(arrow: {
	from: { x: number; y: number };
	to: { x: number; y: number };
	style: StrokeStyle;
}): { x: number; y: number } {
	const { left, right } = arrowHead(arrow);
	return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

/** Point strictly inside triangle abc? (`Ne`) */
function pointInTriangle(
	p: { x: number; y: number },
	a: { x: number; y: number },
	b: { x: number; y: number },
	c: { x: number; y: number },
): boolean {
	if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) === 0) return false;
	const s = crossSign(p, a, b);
	const t = crossSign(p, b, c);
	const u = crossSign(p, c, a);
	return !((s < 0 || t < 0 || u < 0) && (s > 0 || t > 0 || u > 0));
}
function crossSign(
	p: { x: number; y: number },
	a: { x: number; y: number },
	b: { x: number; y: number },
): number {
	return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

/** Distance from p to ellipse (center cx,cy, radii rx,ry). (`je`/`Me`) */
function distToEllipse(
	p: { x: number; y: number },
	cx: number,
	cy: number,
	rx: number,
	ry: number,
): number {
	const ax = Math.abs(p.x - cx);
	const ay = Math.abs(p.y - cy);
	let lo = 0;
	let hi = Math.PI / 2;
	for (let i = 0; i < 32; i += 1) {
		const third = (hi - lo) / 3;
		const t1 = lo + third;
		const t2 = hi - third;
		if (ellipseDistSq(ax, ay, rx, ry, t1) <= ellipseDistSq(ax, ay, rx, ry, t2))
			hi = t2;
		else lo = t1;
	}
	return Math.sqrt(ellipseDistSq(ax, ay, rx, ry, (lo + hi) / 2));
}
function ellipseDistSq(
	x: number,
	y: number,
	rx: number,
	ry: number,
	t: number,
): number {
	const ex = rx * Math.cos(t);
	const ey = ry * Math.sin(t);
	const dx = ex - x;
	const dy = ey - y;
	return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------
// Stroke smoothing (`h`/`g`/`_`/`v`/`y`) — midpoint quadratic subdivision
// ---------------------------------------------------------------------------

/** Pressure-scaled stroke width at one point. (`te`) */
export function pressureWidth(p: SketchPoint, width: number): number {
	if (p.pressure == null) return width;
	const n = clamp(p.pressure, 0, 1);
	return width * lerp(PRESSURE_MIN_FACTOR, 1, Math.sin((n * Math.PI) / 2));
}

/** Smoothed polyline for a stroke/ink point list. (`h`) */
export function smoothStrokePoints(
	points: readonly SketchPoint[],
	width: number,
): SketchPoint[] {
	const out: SketchPoint[] = [];
	for (let i = 0; i < points.length; i += 1) {
		out.push(...subdividePoint(points, i, width));
	}
	return out;
}

/** Relaxed sample: pulls a point toward the curve through its neighbours. (`_`) */
export function relaxedPoint(
	points: readonly SketchPoint[],
	i: number,
	width: number,
): SketchPoint | null {
	const p = points[i];
	const prev = points[i - 1];
	const next = points[i + 1];
	if (
		p == null ||
		p.breakBefore === true ||
		prev == null ||
		next == null ||
		next.breakBefore === true
	)
		return p ?? null;
	const dx = (prev.x - 2 * p.x + next.x) / 4;
	const dy = (prev.y - 2 * p.y + next.y) / 4;
	const len = Math.hypot(dx, dy);
	const k = len > width / 2 ? width / 2 / len : 1;
	return { ...p, x: p.x + dx * k, y: p.y + dy * k };
}

const midpoint = (a: SketchPoint, b: SketchPoint): SketchPoint => ({
	x: (a.x + b.x) / 2,
	y: (a.y + b.y) / 2,
	...(a.pressure != null || b.pressure != null
		? { pressure: ((a.pressure ?? 1) + (b.pressure ?? 1)) / 2 }
		: {}),
});

/** Quadratic subdivision of the curve through point i. (`g`) */
function subdividePoint(
	points: readonly SketchPoint[],
	i: number,
	width: number,
): SketchPoint[] {
	const p = relaxedPoint(points, i, width);
	if (p == null) return [];
	const prev =
		p.breakBefore === true ? undefined : relaxedPoint(points, i - 1, width);
	const nextRaw = relaxedPoint(points, i + 1, width);
	const next = nextRaw?.breakBefore === true ? undefined : nextRaw;
	if (prev == null && next == null) return [p];
	const s = prev == null ? p : midpoint(prev, p);
	const c = next == null ? p : midpoint(p, next);
	const hasPressure =
		s.pressure != null || p.pressure != null || c.pressure != null;
	const pu = s.pressure ?? 1;
	const pd = p.pressure ?? 1;
	const pf = c.pressure ?? 1;
	const curveDist = Math.hypot(s.x - 2 * p.x + c.x, s.y - 2 * p.y + c.y);
	const pressureDist = Math.abs(pu - 2 * pd + pf);
	const subdivisions = collinear(s, p, c)
		? 1
		: Math.min(
				SMOOTH_MAX_SUBDIVISIONS,
				Math.max(
					1,
					Math.ceil(
						Math.sqrt(
							Math.max(
								curveDist / (4 * SMOOTH_CORNER),
								pressureDist / (4 * SMOOTH_PRESSURE),
							),
						),
					),
				),
			);
	const out: SketchPoint[] = prev == null ? [p] : [];
	for (let k = 1; k < subdivisions; k += 1) {
		const t = k / subdivisions;
		const a = (1 - t) ** 2;
		const b = 2 * (1 - t) * t;
		const cc = t ** 2;
		out.push({
			x: a * s.x + b * p.x + cc * c.x,
			y: a * s.y + b * p.y + cc * c.y,
			...(hasPressure ? { pressure: a * pu + b * pd + cc * pf } : {}),
		});
	}
	out.push(c);
	return out;
}

/** True when b lies on segment ac within fp tolerance (pressure included). (`y`) */
function collinear(a: SketchPoint, b: SketchPoint, c: SketchPoint): boolean {
	const dx = c.x - a.x;
	const dy = c.y - a.y;
	const dp = (c.pressure ?? 1) - (a.pressure ?? 1);
	const bx = b.x - a.x;
	const by = b.y - a.y;
	const bp = (b.pressure ?? 1) - (a.pressure ?? 1);
	const scale = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dp));
	if (scale === 0) return bx === 0 && by === 0 && bp === 0;
	const t =
		scale === Math.abs(dx)
			? bx / dx
			: scale === Math.abs(dy)
				? by / dy
				: bp / dp;
	const eps = 2 ** -52 * 16;
	return (
		t >= 0 &&
		t <= 1 &&
		Math.abs(bx - t * dx) <= eps * Math.max(1, Math.abs(dx)) &&
		Math.abs(by - t * dy) <= eps * Math.max(1, Math.abs(dy)) &&
		Math.abs(bp - t * dp) <= eps
	);
}

// ---------------------------------------------------------------------------
// Pressure simulation (`Hi`/`Ui`/`Wi`/`Ji`/`Yi`/`Xi`)
// ---------------------------------------------------------------------------

/** Stylus pressure from a sample; rejects ~0.5 neutral values. (`Ji`) */
function stylusPressure(
	sample: PointerSample,
	keepNeutral: boolean,
): number | null {
	const p = sample.pressure;
	if (
		sample.pointerType !== "pen" ||
		p == null ||
		!Number.isFinite(p) ||
		p <= 0 ||
		(!keepNeutral && Math.abs(p - 0.5) < 0.001)
	)
		return null;
	return clamp(p, PRESSURE_MIN, 1);
}

/** Initial pressure tracker state from pointerdown. (`Hi`) */
export function initialPressure(sample: PointerSample): PressureState {
	const stylus = stylusPressure(sample, false);
	return {
		point: sample.point,
		timestamp: isFiniteNumber(sample.timestamp) ? sample.timestamp : null,
		velocity: null,
		pressure: stylus ?? PRESSURE_DEFAULT,
		source: stylus == null ? "speed" : "stylus",
	};
}

const lowpass = (dt: number, tau: number) => 1 - Math.exp(-dt / tau); // `Xi`

/** Speed-simulated pressure for a given velocity and screen width. (`Yi`) */
function speedPressure(velocity: number, width: number): number {
	const n = clamp((velocity - SPEED_OFFSET) / SPEED_RANGE, 0, 1);
	const floor = lerp(
		PRESSURE_MIN,
		SPEED_PRESSURE_FLOOR,
		clamp((width - 8) / 24, 0, 1),
	);
	return clamp(1 - Math.sqrt(n), floor, 1);
}

/** Advance the pressure tracker for a new sample. (`Ui`) */
export function nextPressure(
	state: PressureState,
	sample: PointerSample,
	screenWidth: number,
): PressureState {
	const point = sample.point;
	const timestamp = isFiniteNumber(sample.timestamp) ? sample.timestamp : null;
	if (
		timestamp != null &&
		state.timestamp === timestamp &&
		point.x === state.point.x &&
		point.y === state.point.y
	)
		return state;
	const dt =
		state.timestamp == null || timestamp == null
			? DT_DEFAULT
			: clamp(timestamp - state.timestamp, DT_MIN, DT_MAX); // `qi`
	const travel = dist(state.point, point);
	const speed = travel / dt;
	const velocity =
		state.velocity == null
			? speed
			: lerp(
					state.velocity,
					speed,
					lowpass(dt, speed > state.velocity ? TAU_ACCEL : TAU_DECEL),
				);
	const stylus = stylusPressure(sample, state.source === "stylus");
	const source =
		state.source === "stylus" || stylus != null ? "stylus" : "speed";
	const target =
		source === "stylus"
			? (stylus ?? state.pressure)
			: speedPressure(velocity, screenWidth);
	const alpha = lowpass(
		dt,
		source === "stylus"
			? TAU_PRESSURE_STYLUS
			: target < state.pressure
				? TAU_PRESSURE_DOWN
				: TAU_PRESSURE_UP,
	);
	const smoothed = clamp(lerp(state.pressure, target, alpha), PRESSURE_MIN, 1);
	const drop = clamp(travel / SPEED_NORM, 0, MAX_PRESSURE_DROP);
	const rise = Math.min(
		drop,
		travel / Math.max(SPEED_NORM, screenWidth * WIDTH_SPEED_FACTOR),
	);
	return {
		point,
		timestamp,
		velocity,
		pressure:
			source === "speed"
				? clamp(smoothed, state.pressure - drop, state.pressure + rise)
				: smoothed,
		source,
	};
}

/** Attach a clamped pressure to a point. (`Wi`) */
export function withPressure(
	p: SketchPoint,
	pressure: number | null,
): SketchPoint {
	return pressure == null || pressure === 0 || !Number.isFinite(pressure)
		? p
		: { ...p, pressure: clamp(pressure, PRESSURE_MIN, 1) };
}

// ---------------------------------------------------------------------------
// Object bounds and hit testing (`fe`/`pe`/`he`/`ve`/`be`/`ge`/`xe`/`Se`)
// ---------------------------------------------------------------------------

/** Ink bounds, pressure-aware. (`pe`) */
function strokeInkBounds(item: {
	points: SketchPoint[];
	style: StrokeStyle;
}): Bounds | null {
	const w = item.style.width;
	const pts = smoothStrokePoints(item.points, w);
	if (pts.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of pts) {
		const r = pressureWidth(p, w) / 2;
		minX = Math.min(minX, p.x - r);
		minY = Math.min(minY, p.y - r);
		maxX = Math.max(maxX, p.x + r);
		maxY = Math.max(maxY, p.y + r);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Drawing bounds incl. stroke half-width. (`fe`) */
function drawingBounds(item: SketchItem): Bounds | null {
	switch (item.kind) {
		case "stroke":
			return pointsBounds(item.points, item.style.width / 2);
		case "line":
			return pointsBounds([item.from, item.to], item.style.width / 2);
		case "arrow": {
			const head = arrowHead(item);
			const shaft = pointsBounds(
				[item.from, arrowShaftEnd(item)],
				item.style.width / 2,
			);
			const headB = pointsBounds([item.to, head.left, head.right]);
			return shaft == null
				? headB
				: headB == null
					? shaft
					: boundsUnion(shaft, headB);
		}
		case "rectangle":
		case "ellipse":
		case "triangle":
		case "diamond":
		case "star":
		case "heart":
			return inflateBounds(normalizeBounds(item.bounds), item.style.width / 2);
		case "ink":
			return pointsBounds(item.points, item.style.width / 2);
		case "text":
			return normalizeBounds(item.bounds);
	}
}

/** Selection bounds: stroke-aware, template-aware. (`he`) */
export function selectionBounds(item: SketchItem): Bounds | null {
	if (item.kind === "stroke") return strokeInkBounds(item);
	if (
		item.kind === "rectangle" ||
		item.kind === "ellipse" ||
		item.kind === "triangle" ||
		item.kind === "diamond" ||
		item.kind === "star" ||
		item.kind === "heart"
	) {
		const inner =
			item.kind === "rectangle" || item.kind === "ellipse"
				? null
				: pointsBounds(shapePoints(item.kind, item.bounds, item));
		return inflateBounds(
			inner ?? normalizeBounds(item.bounds),
			item.style.width / 2,
		);
	}
	return drawingBounds(item);
}

/** Handle list for an object (line/arrow -> endpoints). (`ge`) */
function objectHandles(
	item: SketchItem,
	opts?: {
		minimumSideHandleSpacing?: number;
		minimumCornerHandleSpacing?: number;
	},
): { handle: ResizeHandle; point: { x: number; y: number } }[] {
	if (item.kind === "line" || item.kind === "arrow") {
		return [
			{ handle: "start", point: item.from },
			{ handle: "end", point: item.to },
		];
	}
	const b = selectionBounds(item);
	if (b == null) return [];
	const l = b.x;
	const t = b.y;
	const r = b.x + b.width;
	const bo = b.y + b.height;
	const cx = (l + r) / 2;
	const cy = (t + bo) / 2;
	const corners = [
		{ handle: "nw" as const, point: { x: l, y: t } },
		{ handle: "ne" as const, point: { x: r, y: t } },
		{ handle: "se" as const, point: { x: r, y: bo } },
		{ handle: "sw" as const, point: { x: l, y: bo } },
	];
	const d = Math.max(
		nonNegative(opts?.minimumSideHandleSpacing ?? 0),
		nonNegative(opts?.minimumCornerHandleSpacing ?? 0),
	);
	return (
		[
			corners[0]!,
			{ handle: "n", point: { x: cx, y: t } },
			corners[1]!,
			{ handle: "e", point: { x: r, y: cy } },
			corners[2]!,
			{ handle: "s", point: { x: cx, y: bo } },
			corners[3]!,
			{ handle: "w", point: { x: l, y: cy } },
		] as { handle: ResizeHandle; point: { x: number; y: number } }[]
	).filter(({ handle }) =>
		d === 0
			? true
			: handle === "n" || handle === "s"
				? b.width > d
				: handle === "e" || handle === "w"
					? b.height > d
					: true,
	);
}

/** Polyline hit: distance to any segment <= r (dots as points). (`_e`) */
function polylineHit(
	points: readonly SketchPoint[],
	p: { x: number; y: number },
	r: number,
): boolean {
	const tol = nonNegative(r);
	for (const run of splitPointRuns(points)) {
		const first = run[0];
		if (first == null) continue;
		if (run.length === 1) {
			if (dist(first, p) <= tol) return true;
			continue;
		}
		for (let i = 1; i < run.length; i += 1) {
			const a = run[i - 1];
			const b = run[i];
			if (a != null && b != null && distToSegment(p, a, b) <= tol) return true;
		}
	}
	return false;
}

/** Outline (closed polygon) hit: perimeter or any vertex proximity. (`Ee`) */
function outlineHit(
	points: readonly { x: number; y: number }[],
	p: { x: number; y: number },
	r: number,
): boolean {
	if (polylineHit(points, p, r)) return true;
	const first = points[0];
	const last = points[points.length - 1];
	return first != null && last != null && distToSegment(p, last, first) <= r;
}

/** Rectangle outline hit. (`we`) */
function rectOutlineHit(
	bounds: Bounds,
	p: { x: number; y: number },
	r: number,
): boolean {
	const b = normalizeBounds(bounds);
	if (!pointInBounds(inflateBounds(b, r), p)) return false;
	if (!pointInBounds(b, p)) return true;
	return (
		Math.min(p.x - b.x, b.x + b.width - p.x, p.y - b.y, b.y + b.height - p.y) <=
		r
	);
}

/** Ellipse outline hit. (`Te`) */
function ellipseOutlineHit(
	bounds: Bounds,
	p: { x: number; y: number },
	r: number,
): boolean {
	const b = normalizeBounds(bounds);
	const rx = b.width / 2;
	const ry = b.height / 2;
	return rx === 0 || ry === 0
		? distToSegment(
				p,
				{ x: b.x, y: b.y },
				{ x: b.x + b.width, y: b.y + b.height },
			) <= r
		: distToEllipse(p, b.x + rx, b.y + ry, rx, ry) <= r;
}

/** Arrow hit: shaft segment or head triangle. (`Ce`) */
function arrowHit(
	arrow: {
		from: { x: number; y: number };
		to: { x: number; y: number };
		style: StrokeStyle;
	},
	p: { x: number; y: number },
	r: number,
): boolean {
	if (
		distToSegment(p, arrow.from, arrowShaftEnd(arrow)) <=
		arrow.style.width / 2 + r
	)
		return true;
	const head = arrowHead(arrow);
	return pointInTriangle(p, arrow.to, head.left, head.right);
}

/** Hit test one object. (`ve`) */
export function hitTestItem(
	item: SketchItem,
	p: { x: number; y: number },
	tolerance = 0,
): boolean {
	const r = nonNegative(tolerance);
	const outer = drawingBounds(item);
	if (outer == null || !pointInBounds(inflateBounds(outer, r), p)) return false;
	switch (item.kind) {
		case "ink":
		case "stroke":
			return polylineHit(
				item.kind === "stroke"
					? smoothStrokePoints(item.points, item.style.width)
					: item.points,
				p,
				item.style.width / 2 + r,
			);
		case "line":
			return distToSegment(p, item.from, item.to) <= item.style.width / 2 + r;
		case "arrow":
			return arrowHit(item, p, r);
		case "text":
			return pointInBounds(inflateBounds(item.bounds, r), p);
		case "rectangle":
			return rectOutlineHit(item.bounds, p, item.style.width / 2 + r);
		case "ellipse":
			return ellipseOutlineHit(item.bounds, p, item.style.width / 2 + r);
		case "triangle":
		case "diamond":
		case "star":
		case "heart":
			return outlineHit(
				shapePoints(item.kind, item.bounds, item),
				p,
				item.style.width / 2 + r,
			);
	}
}

/** Topmost object at point: texts first, then other objects. (`be`) */
export function hitTestDocument(
	doc: SketchDoc,
	p: { x: number; y: number },
	tolerance = 0,
	filter?: (item: SketchItem) => boolean,
): SketchItem | null {
	for (let i = doc.objects.length - 1; i >= 0; --i) {
		const o = doc.objects[i];
		if (
			o?.kind === "text" &&
			hitTestItem(o, p, tolerance) &&
			(filter?.(o) ?? true)
		)
			return o;
	}
	for (let i = doc.objects.length - 1; i >= 0; --i) {
		const o = doc.objects[i];
		if (o != null && o.kind !== "text" && hitTestItem(o, p, tolerance))
			return o;
	}
	return null;
}

/** Nearest handle of `item` to `point` within tolerance. (`xe`) */
export function pickHandle(
	item: SketchItem,
	point: { x: number; y: number },
	tolerance: number,
	opts?: {
		minimumSideHandleSpacing?: number;
		minimumCornerHandleSpacing?: number;
	},
): ResizeHandle | null {
	const tol = nonNegative(tolerance);
	let best: ResizeHandle | null = null;
	let bestDist = tol;
	for (const h of objectHandles(item, opts)) {
		const d = dist(h.point, point);
		if (d <= tol && (best == null || d < bestDist)) {
			best = h.handle;
			bestDist = d;
		}
	}
	return best;
}

/** Point for a handle. (`An`) */
export function handlePoint(
	item: SketchItem,
	handle: ResizeHandle,
): { x: number; y: number } | null {
	return objectHandles(item).find((h) => h.handle === handle)?.point ?? null;
}

/** "Grab" hit: bounds for most kinds, outline for line/arrow. (`Se`) */
export function grabHit(
	item: SketchItem,
	point: { x: number; y: number },
	tolerance = 0,
): boolean {
	if (item.kind === "line" || item.kind === "arrow")
		return hitTestItem(item, point, tolerance);
	const b = selectionBounds(item);
	return b != null && pointInBounds(b, point);
}

/** Document content bounds (stroke-aware). (`me`) */
export function contentBounds(doc: SketchDoc): Bounds | null {
	let acc: Bounds | null = null;
	for (const item of doc.objects) {
		if (item.kind === "text" && item.text.length === 0) continue;
		const b = drawingBounds(item);
		if (b != null) acc = acc == null ? b : boundsUnion(acc, b);
	}
	return acc;
}

// ---------------------------------------------------------------------------
// Transforms (`rn`/`rt`/`en`/`Qe`/`$e`/`ot`/`at`/`et`/`tt`/`nt`/`it`/`nn`)
// ---------------------------------------------------------------------------

/** Raw geometric bounds used for resize math. (`nt`) */
function rawGeometryBounds(item: SketchItem): Bounds | null {
	switch (item.kind) {
		case "stroke":
			return isDotStroke(item)
				? selectionBounds(item)
				: pointsBounds(item.points);
		case "line":
		case "arrow":
			return pointsBounds([item.from, item.to]);
		case "ink":
			return pointsBounds(item.points);
		case "rectangle":
		case "ellipse":
		case "text":
			return normalizeBounds(item.bounds);
		case "triangle":
		case "diamond":
		case "star":
		case "heart":
			return pointsBounds(shapePoints(item.kind, item.bounds, item));
	}
}

/** True for a stroke whose points all coincide. (`it`) */
function isDotStroke(item: { kind: string; points?: SketchPoint[] }): boolean {
	if (item.kind !== "stroke" || item.points == null) return false;
	const first = item.points[0];
	return (
		first != null &&
		item.points.every((p) => p.x === first.x && p.y === first.y)
	);
}

/** Translate an object. (`rn`) */
export function translateItem(
	item: SketchItem,
	delta: { x: number; y: number },
): SketchItem {
	switch (item.kind) {
		case "stroke":
		case "ink":
			return {
				...item,
				points: item.points.map((p) => translatePoint(p, delta)),
			};
		case "line":
		case "arrow":
			return {
				...item,
				from: translatePoint(item.from, delta),
				to: translatePoint(item.to, delta),
			};
		case "rectangle":
		case "ellipse":
		case "triangle":
		case "diamond":
		case "star":
		case "heart":
		case "text":
			return {
				...item,
				bounds: {
					...item.bounds,
					x: item.bounds.x + delta.x,
					y: item.bounds.y + delta.y,
				},
			};
	}
}

/** Remap stroke points between two bounds (per-axis normalization). (`rt`) */
function remapStroke(
	item: Extract<SketchItem, { kind: "stroke" }>,
	from: Bounds,
	to: Bounds,
): SketchItem {
	if (isDotStroke(item)) {
		return {
			...item,
			style: {
				...item.style,
				width: (item.style.width * Math.abs(to.width)) / from.width,
			},
			points: item.points.map((p) => ({
				...p,
				x: to.x + to.width / 2,
				y: to.y + to.height / 2,
			})),
		};
	}
	const hasX = from.width > 0 || item.resizeBasis?.x != null;
	const hasY = from.height > 0 || item.resizeBasis?.y != null;
	const doX = hasX && (to.x !== from.x || to.width !== from.width);
	const doY = hasY && (to.y !== from.y || to.height !== from.height);
	if (!doX && !doY) return item;
	const nx = item.points.map((p, i) =>
		from.width === 0
			? (item.resizeBasis?.x?.[i] ?? 0)
			: (p.x - from.x) / from.width,
	);
	const ny = item.points.map((p, i) =>
		from.height === 0
			? (item.resizeBasis?.y?.[i] ?? 0)
			: (p.y - from.y) / from.height,
	);
	const basisX = to.width === 0 && hasX ? nx : undefined;
	const basisY = to.height === 0 && hasY ? ny : undefined;
	return {
		...item,
		resizeBasis:
			basisX == null && basisY == null ? undefined : { x: basisX, y: basisY },
		points: item.points.map((p, i) => ({
			...p,
			x: doX ? to.x + to.width * (nx[i] ?? 0) : p.x,
			y: doY ? to.y + to.height * (ny[i] ?? 0) : p.y,
		})),
	};
}

/**
 * Bounds for a shape such that its template polygon fits `target`.
 * (`et`) — inverse of `shapePoints` scaling.
 */
export function shapeBoundsFromTarget(
	itemLike: {
		kind: ShapeKind;
		flipX?: boolean;
		flipY?: boolean;
	},
	target: Bounds,
): Bounds {
	const unit: Bounds = { x: 0, y: 0, width: 1, height: 1 };
	const basis =
		itemLike.kind === "rectangle" || itemLike.kind === "ellipse"
			? unit
			: pointsBounds(shapeTemplatePoints(itemLike.kind, unit));
	if (basis == null) return normalizeBounds(target);
	const sx = target.width / basis.width;
	const sy = target.height / basis.height;
	return normalizeBounds({
		x: target.x - basis.x * sx,
		y: target.y - basis.y * sy,
		width: sx,
		height: sy,
	});
}

/** Bounds shrunk by `width` on every side (clamped at center). (`tt`) */
export function insetBounds(b: Bounds | null, width: number): Bounds | null {
	if (b == null) return null;
	const n = normalizeBounds(b);
	const r = width / 2;
	return {
		x: n.x + Math.min(r, n.width / 2),
		y: n.y + Math.min(r, n.height / 2),
		width: Math.max(0, n.width - width),
		height: Math.max(0, n.height - width),
	};
}

/**
 * New raw bounds when dragging `handle` to `point`. Corner drags preserve
 * aspect ratio (`ot`); single-axis handles (`at`) keep a centered square.
 */
function resizedBounds(
	item: SketchItem,
	handle: ResizeHandle,
	point: { x: number; y: number },
	limit: Bounds | null = null,
): Bounds | null {
	const raw = rawGeometryBounds(item);
	const sel = selectionBounds(item);
	if (raw == null || sel == null) return null;
	if (isDotStroke(item)) return centeredSquareResize(sel, handle, point);
	const west = handle.includes("w");
	const north = handle.includes("n");
	return boxDrag(
		raw,
		handle,
		{
			x: point.x + raw.x - sel.x + (west ? 0 : raw.width - sel.width),
			y: point.y + raw.y - sel.y + (north ? 0 : raw.height - sel.height),
		},
		item.kind === "ink"
			? limit
			: item.kind === "stroke"
				? null
				: insetBounds(limit, item.kind === "text" ? 0 : item.style.width),
	);
}

/** Dot stroke resize: stays a centered square on the dragged axis. (`at`) */
function centeredSquareResize(
	b: Bounds,
	handle: ResizeHandle,
	point: { x: number; y: number },
): Bounds {
	const raw = boxDrag(b, handle, point, null);
	const horiz = handle === "e" || handle === "w";
	const vert = handle === "n" || handle === "s";
	const extent = vert ? raw.height : raw.width;
	const side = Math.max(Math.min(b.width, 1), Math.abs(extent));
	const signed = extent < 0 ? -side : side;
	return {
		x: vert
			? b.x + (b.width - side) / 2
			: handle.includes("w")
				? b.x + b.width - signed
				: b.x,
		y: horiz
			? b.y + (b.height - side) / 2
			: handle.includes("n")
				? b.y + b.height - signed
				: b.y,
		width: vert ? side : signed,
		height: horiz ? side : signed,
	};
}

/** Drag one side/corner of a box; corners preserve aspect ratio. (`ot`) */
function boxDrag(
	b: Bounds,
	handle: ResizeHandle,
	point: { x: number; y: number },
	limit: Bounds | null,
): Bounds {
	const west = handle.includes("w");
	const north = handle.includes("n");
	const anchorX = b.x + (west ? b.width : 0);
	const anchorY = b.y + (north ? b.height : 0);
	const c = clampPointToBounds(point, limit);
	if (handle.length !== 2 || b.width === 0 || b.height === 0) {
		const x = west ? c.x : b.x;
		const y = north ? c.y : b.y;
		return {
			x,
			y,
			width: (handle.includes("e") ? c.x : b.x + b.width) - x,
			height: (handle.includes("s") ? c.y : b.y + b.height) - y,
		};
	}
	const lx = west ? anchorX - c.x : c.x - anchorX;
	const ly = north ? anchorY - c.y : c.y - anchorY;
	let d = (lx * b.width + ly * b.height) / (b.width ** 2 + b.height ** 2);
	if (limit != null) {
		const flipX = west !== d < 0;
		const flipY = north !== d < 0;
		const maxX = flipX ? anchorX - limit.x : limit.x + limit.width - anchorX;
		const maxY = flipY ? anchorY - limit.y : limit.y + limit.height - anchorY;
		d = Math.sign(d) * Math.min(Math.abs(d), maxX / b.width, maxY / b.height);
	}
	const w = b.width * d;
	const h = b.height * d;
	return {
		x: west ? anchorX - w : anchorX,
		y: north ? anchorY - h : anchorY,
		width: w,
		height: h,
	};
}

/**
 * Resize an object through `handle` so the dragged point lands at `point`,
 * keeping the result inside `surfaceBounds` (binary search fallback). (`Qe`)
 */
export function resizeObject(
	item: SketchItem,
	handle: ResizeHandle,
	point: { x: number; y: number },
	surfaceBounds: Bounds | null,
	resizeText: (
		item: Extract<SketchItem, { kind: "text" }>,
		handle: ResizeHandle,
		point: { x: number; y: number },
		surfaceBounds: Bounds | null,
	) => SketchItem,
): SketchItem {
	const sel = selectionBounds(item);
	if (sel == null) return item;
	const limit = surfaceBounds == null ? null : boundsUnion(surfaceBounds, sel);
	const apply = (p: { x: number; y: number }): SketchItem => {
		switch (item.kind) {
			case "line":
			case "arrow": {
				if (handle !== "start" && handle !== "end") return item;
				const key = handle === "start" ? "from" : "to";
				const clamped = clampPointToBounds(
					p,
					insetBounds(
						limit,
						item.kind === "arrow" && handle === "end" ? 0 : item.style.width,
					),
				);
				return clamped.x === item[key].x && clamped.y === item[key].y
					? item
					: ({ ...item, [key]: clamped } as SketchItem);
			}
		}
		if (handle === "start" || handle === "end") return item;
		const raw = rawGeometryBounds(item);
		const next = resizedBounds(item, handle, p, limit);
		if (
			raw == null ||
			next == null ||
			(next.x === raw.x &&
				next.y === raw.y &&
				next.width === raw.width &&
				next.height === raw.height)
		)
			return item;
		if (item.kind === "stroke") return remapStroke(item, raw, next);
		if (item.kind === "ink") {
			// Points remap onto the (possibly flipped) target rect directly.
			return {
				...item,
				points:
					raw.width === 0 || raw.height === 0
						? item.points
						: item.points.map((pt) => ({
								...pt,
								x: next.x + ((pt.x - raw.x) / raw.width) * next.width,
								y: next.y + ((pt.y - raw.y) / raw.height) * next.height,
							})),
			};
		}
		if (item.kind === "text") {
			return resizeText(item, handle, point, surfaceBounds);
		}
		const flipped = {
			...item,
			flipX: (item.flipX === true) !== next.width < 0 || undefined,
			flipY: (item.flipY === true) !== next.height < 0 || undefined,
		};
		return {
			...flipped,
			bounds: shapeBoundsFromTarget(flipped, normalizeBounds(next)),
		};
	};
	const direct = apply(point);
	const fits = (candidate: SketchItem) => {
		const b = selectionBounds(candidate);
		return limit == null || b == null || boundsContain(limit, b);
	};
	if (fits(direct)) return direct;
	const anchor =
		item.kind === "line" || item.kind === "arrow"
			? handle === "start"
				? item.from
				: item.to
			: {
					x: sel.x + (handle.includes("w") ? 0 : sel.width),
					y: sel.y + (handle.includes("n") ? 0 : sel.height),
				};
	let best = item;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 24; i += 1) {
		const t = (lo + hi) / 2;
		const candidate = apply({
			x: lerp(anchor.x, point.x, t),
			y: lerp(anchor.y, point.y, t),
		});
		if (fits(candidate)) {
			lo = t;
			best = candidate;
		} else {
			hi = t;
		}
	}
	return best;
}

/** Remap a text box given a new bounds rect (raw box drag). (`nn`) */
function textDragBounds(
	b: Bounds,
	handle: ResizeHandle,
	point: { x: number; y: number },
): Bounds {
	let l = b.x;
	let t = b.y;
	let r = b.x + b.width;
	let bo = b.y + b.height;
	if (handle.includes("w")) l = point.x;
	if (handle.includes("e")) r = point.x;
	if (handle.includes("n")) t = point.y;
	if (handle.includes("s")) bo = point.y;
	return { x: l, y: t, width: r - l, height: bo - t };
}

/** Handle actually grabbed after flip normalization. (`$t`) */
export function effectiveHandle(
	item: SketchItem,
	handle: ResizeHandle,
	point: { x: number; y: number },
): ResizeHandle {
	const b = selectionBounds(item);
	if (b == null || handle === "start" || handle === "end") return handle;
	const next =
		item.kind === "text"
			? textDragBounds(b, handle, point)
			: resizedBounds(item, handle, point);
	if (next == null) return handle;
	const flipX = next.width < 0;
	const flipY = next.height < 0;
	const north = handle.includes("n") !== flipY;
	const west = handle.includes("w") !== flipX;
	if (handle.length === 2) {
		if (north) return west ? "nw" : "ne";
		return west ? "sw" : "se";
	}
	if (handle === "n" || handle === "s") return north ? "n" : "s";
	return west ? "w" : "e";
}

/** Clone an object under a new id. (`an`) */
export function cloneItem(item: SketchItem, id: string): SketchItem {
	switch (item.kind) {
		case "stroke":
		case "ink":
			return { ...item, id, points: item.points.map((p) => ({ ...p })) };
		case "line":
		case "arrow":
			return { ...item, id, from: { ...item.from }, to: { ...item.to } };
		case "rectangle":
		case "ellipse":
		case "triangle":
		case "diamond":
		case "star":
		case "heart":
		case "text":
			return { ...item, id, bounds: { ...item.bounds } };
	}
}

// ---------------------------------------------------------------------------
// Shift constraints (`hn`/`Nn`/`Pn`) and move/surface clamping (`sn`/`kn`/`qt`/`dn`)
// ---------------------------------------------------------------------------

const isShapeObject = (k: string): boolean =>
	k === "rectangle" ||
	k === "ellipse" ||
	k === "triangle" ||
	k === "diamond" ||
	k === "star" ||
	k === "heart";
export const isDrawableShapeTool = (tool: string): boolean =>
	tool === "line" || tool === "arrow" || isShapeObject(tool);

/** Remaining distance to bounds edge along sign. (`Nn`) */
function edgeDistance(p: number, dir: number, lo: number, hi: number): number {
	return Math.max(dir >= 0 ? hi - p : p - lo, 0);
}
/** Ray distance to a bounds box. (`Pn`) */
function rayDistance(
	origin: { x: number; y: number },
	cos: number,
	sin: number,
	b: Bounds,
): number {
	const out: number[] = [];
	if (Math.abs(cos) > 2 ** -52)
		out.push(edgeDistance(origin.x, cos, b.x, b.x + b.width) / Math.abs(cos));
	if (Math.abs(sin) > 2 ** -52)
		out.push(edgeDistance(origin.y, sin, b.y, b.y + b.height) / Math.abs(sin));
	return out.length === 0 ? 0 : Math.min(...out);
}

/**
 * Constrain endpoint `to` relative to `from`: shape tools -> equal extents
 * (square/circle), line/arrow -> 45-degree angles. (`hn`)
 */
export function constrainEndpoint(
	from: { x: number; y: number },
	to: { x: number; y: number },
	kind: ShapeKind,
	surfaceBounds: Bounds | null,
): { x: number; y: number } {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const limit = surfaceBounds == null ? null : normalizeBounds(surfaceBounds);
	if (isShapeObject(kind)) {
		const sx = Math.sign(dx || 1);
		const sy = Math.sign(dy || 1);
		let side = Math.max(Math.abs(dx), Math.abs(dy));
		if (limit != null) {
			side = Math.min(
				side,
				edgeDistance(from.x, sx, limit.x, limit.x + limit.width),
				edgeDistance(from.y, sy, limit.y, limit.y + limit.height),
			);
		}
		return { x: from.x + sx * side, y: from.y + sy * side };
	}
	const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	let len = Math.hypot(dx, dy);
	if (limit != null) len = Math.min(len, rayDistance(from, cos, sin, limit));
	return { x: from.x + cos * len, y: from.y + sin * len };
}

/** Minimum-size check for committing a drawn object. (`mn`) */
export function meetsMinSize(
	item: SketchItem | SketchEraserPreview,
	min = SHAPE_MIN_SIZE,
): boolean {
	if (item.kind === "line" || item.kind === "arrow")
		return dist(item.from, item.to) >= min;
	if (
		item.kind === "rectangle" ||
		item.kind === "ellipse" ||
		item.kind === "triangle" ||
		item.kind === "diamond" ||
		item.kind === "star" ||
		item.kind === "heart"
	)
		return item.bounds.width >= min && item.bounds.height >= min;
	return true;
}

/** Clamp a translate delta so the object stays on the surface. (`sn`) */
export function clampMoveDelta(
	item: SketchItem,
	delta: { x: number; y: number },
	surfaceBounds: Bounds | null,
): { x: number; y: number } {
	if (surfaceBounds == null) return delta;
	const basis =
		item.kind === "stroke" ||
		(isShapeObject(item.kind) && item.kind !== "rectangle")
			? selectionBounds(item)
			: drawingBounds(item);
	if (basis == null) return delta;
	const a = normalizeBounds(basis);
	const o = normalizeBounds(surfaceBounds);
	return {
		x: clampDeltaAxis(delta.x, a.x, a.width, o.x, o.width),
		y: clampDeltaAxis(delta.y, a.y, a.height, o.y, o.height),
	};
}
function clampDeltaAxis(
	d: number,
	pos: number,
	size: number,
	surfacePos: number,
	surfaceSize: number,
): number {
	const end = pos + size;
	const surfaceEnd = surfacePos + surfaceSize;
	return clamp(
		d,
		size <= surfaceSize ? Math.min(surfacePos - pos, 0) : surfaceEnd - end,
		size <= surfaceSize ? Math.max(surfaceEnd - end, 0) : surfacePos - pos,
	);
}

/** Keep a pasted object inside the surface when possible. (`on`/`On`) */
export function clampPasteOffset(
	item: SketchItem,
	offset: { x: number; y: number },
	surfaceBounds: Bounds | null,
): { x: number; y: number } {
	const b = drawingBounds(item);
	if (b == null || surfaceBounds == null) return offset;
	const i = normalizeBounds(b);
	const a = normalizeBounds(surfaceBounds);
	return {
		x: pasteAxis(i.x, i.width, a.x, a.width, offset.x),
		y: pasteAxis(i.y, i.height, a.y, a.height, offset.y),
	};
}
function pasteAxis(
	pos: number,
	size: number,
	surfacePos: number,
	surfaceSize: number,
	offset: number,
): number {
	const fits = (d: number) =>
		pos + d >= surfacePos && pos + size + d <= surfacePos + surfaceSize;
	return fits(offset) ? offset : fits(-offset) ? -offset : 0;
}

/** Shrink/translate an arrow so its drawing bounds fit the surface. (`qt`) */
export function clampArrowToSurface(
	arrow: Extract<SketchItem, { kind: "arrow" }>,
	surface: Bounds | null,
): SketchItem | null {
	if (surface == null) return arrow;
	const s = normalizeBounds(surface);
	if (arrow.style.width > s.width || arrow.style.width > s.height) return null;
	let b = drawingBounds(arrow);
	if (b == null) return arrow;
	let out = arrow;
	if (b.width > s.width || b.height > s.height) {
		out = { ...arrow, to: { ...arrow.from } };
		b = drawingBounds(out) ?? b;
		let lo = 0;
		let hi = 1;
		for (let i = 0; i < 16; i += 1) {
			const t = (lo + hi) / 2;
			const candidate: SketchItem = {
				...arrow,
				to: {
					x: lerp(arrow.from.x, arrow.to.x, t),
					y: lerp(arrow.from.y, arrow.to.y, t),
				},
			};
			const cb = drawingBounds(candidate);
			if (cb != null && cb.width <= s.width && cb.height <= s.height) {
				lo = t;
				out = candidate;
				b = cb;
			} else {
				hi = t;
			}
		}
	}
	const dx = clamp(b.x, s.x, s.x + s.width - b.width) - b.x;
	const dy = clamp(b.y, s.y, s.y + s.height - b.height) - b.y;
	return dx === 0 && dy === 0
		? out
		: {
				...out,
				from: translatePoint(out.from, { x: dx, y: dy }),
				to: translatePoint(out.to, { x: dx, y: dy }),
			};
}

/** `dn`: shrink a shape/stroke width until its ink fits the surface. */
export function fitShapeWidth(
	item: SketchItem,
	next: StrokeStyle,
	surface: Bounds | null,
): StrokeStyle {
	if (
		surface == null ||
		item.kind === "text" ||
		item.kind === "ink" ||
		next.width <= item.style.width
	)
		return next;
	const limit = normalizeBounds(surface);
	const fits = (width: number) => {
		const b = selectionBounds({ ...item, style: { ...next, width } });
		return b == null || boundsContain(limit, b);
	};
	if (fits(next.width)) return next;
	if (!fits(item.style.width)) return { ...next, width: item.style.width };
	let lo = item.style.width;
	let hi = next.width;
	for (let i = 0; i < 16; i += 1) {
		const mid = (lo + hi) / 2;
		if (fits(mid)) lo = mid;
		else hi = mid;
	}
	return { ...next, width: lo };
}

// ---------------------------------------------------------------------------
// Text alignment snapping (`pa`/`ga`/`ha`/`ma`/`fa`) — alignment only
// ---------------------------------------------------------------------------

const axisStart = (b: Bounds, axis: "x" | "y") => (axis === "x" ? b.x : b.y);
const axisSize = (b: Bounds, axis: "x" | "y") =>
	axis === "x" ? b.width : b.height;
const axisEnd = (b: Bounds, axis: "x" | "y") =>
	axisStart(b, axis) + axisSize(b, axis);
const axisCoord = (
	b: Bounds,
	axis: "x" | "y",
	mode: "start" | "center" | "end",
) => {
	const s = axisStart(b, axis);
	const e = axisEnd(b, axis);
	return mode === "start" ? s : mode === "center" ? s + (e - s) / 2 : e;
};

/** Closest alignment candidate on one axis. (`ga`) */
function alignmentSnap(
	axis: "x" | "y",
	target: Bounds,
	others: Bounds[],
	tolerance: number,
): { offset: number; distance: number; guide: SnapGuide } | null {
	let best: { offset: number; distance: number; guide: SnapGuide } | null =
		null;
	for (const other of others) {
		for (const mode of ["start", "center", "end"] as const) {
			const offset =
				axisCoord(other, axis, mode) - axisCoord(target, axis, mode);
			const d = Math.abs(offset);
			if (d > tolerance || (best != null && d >= best.distance)) continue;
			const coordinate = axisCoord(target, axis, mode) + offset;
			const cross = axis === "x" ? "y" : "x";
			const start = Math.min(axisStart(target, cross), axisStart(other, cross));
			const end = Math.max(axisEnd(target, cross), axisEnd(other, cross));
			best = {
				offset,
				distance: d,
				guide: { kind: "alignment", axis, coordinate, start, end },
			};
		}
	}
	return best;
}

/**
 * Snap a text object's translate delta to alignment with other text objects.
 * (`pa` — equal-gap snapping intentionally omitted.)
 */
export function snapTextMove(opts: {
	doc: SketchDoc;
	object: SketchItem;
	delta: { x: number; y: number };
	tolerance: number;
	suppressAxes?: { x: boolean; y: boolean };
}): SnapResult {
	const tol = nonNegative(opts.tolerance);
	if (tol === 0 || opts.object.kind !== "text")
		return { delta: opts.delta, guides: [] };
	const moved = normalizeBounds({
		...opts.object.bounds,
		x: opts.object.bounds.x + opts.delta.x,
		y: opts.object.bounds.y + opts.delta.y,
	});
	const others = opts.doc.objects
		.filter(
			(o): o is Extract<SketchItem, { kind: "text" }> =>
				o.kind === "text" && o.id !== opts.object.id,
		)
		.map((o) => normalizeBounds(o.bounds));
	if (others.length === 0) return { delta: opts.delta, guides: [] };
	const suppress = opts.suppressAxes ?? { x: false, y: false };
	const sx = suppress.x ? null : alignmentSnap("x", moved, others, tol);
	const sy = suppress.y ? null : alignmentSnap("y", moved, others, tol);
	return {
		delta: {
			x: opts.delta.x + (sx?.offset ?? 0),
			y: opts.delta.y + (sy?.offset ?? 0),
		},
		guides: [sx?.guide, sy?.guide].filter((g): g is SnapGuide => g != null),
	};
}

/** Initial snap offsets at delta 0 (so the drag can break free). (`fa`) */
export function initialSnapOffsets(
	doc: SketchDoc,
	object: SketchItem,
	tolerance: number,
): { x: number | null; y: number | null } {
	if (object.kind !== "text") return { x: null, y: null };
	const r = snapTextMove({
		doc,
		object,
		delta: { x: 0, y: 0 },
		tolerance,
	});
	const snapped = (axis: "x" | "y") => r.guides.some((g) => g.axis === axis);
	return {
		x: snapped("x") ? r.delta.x : null,
		y: snapped("y") ? r.delta.y : null,
	};
}

/** Keep only guides whose snap survived surface clamping. (`ma`) */
export function filterGuides(
	guides: SnapGuide[],
	preClamp: { x: number; y: number },
	postClamp: { x: number; y: number },
): SnapGuide[] {
	return guides.filter((g) =>
		g.axis === "x" ? preClamp.x === postClamp.x : preClamp.y === postClamp.y,
	);
}

// ---------------------------------------------------------------------------
// Vector erasure (`go` simplified: sync cutting, polyline residuals)
// ---------------------------------------------------------------------------

interface ErasePartState {
	changed: boolean;
	runs: SketchPoint[][];
}

/**
 * Cut `runs` at `t in [0,1]` intervals where the eraser capsule (segments of
 * radius `r`) covers each polyline segment. Returns residual runs.
 */
function cutPolyline(
	points: readonly SketchPoint[],
	segments: readonly EraserSegment[],
	r: number,
): SketchPoint[][] {
	// Collect erase intervals per source segment.
	const cuts = points.slice(0, -1).map(() => [] as [number, number][]);
	for (let i = 0; i + 1 < points.length; i += 1) {
		const a = points[i];
		const b = points[i + 1];
		if (a == null || b == null) continue;
		for (const seg of segments) {
			for (const interval of segmentEraseIntervals(a, b, seg, r)) {
				cuts[i]?.push(interval);
			}
		}
	}
	// Single-point runs (dot): erased when the capsule covers the center.
	if (points.length === 1) {
		const p = points[0];
		if (p == null) return [];
		for (const seg of segments) {
			if (distToSegment(p, seg.from, seg.to) <= r) return [];
		}
		return [points.slice()];
	}
	// Build residual runs from kept sub-intervals.
	const out: SketchPoint[][] = [];
	let current: SketchPoint[] | null = null;
	for (let i = 0; i + 1 < points.length; i += 1) {
		const a = points[i];
		const b = points[i + 1];
		if (a == null || b == null) continue;
		const kept = subtractIntervals(cuts[i] ?? []);
		for (const [t0, t1] of kept) {
			const p0: SketchPoint = {
				x: a.x + (b.x - a.x) * t0,
				y: a.y + (b.y - a.y) * t0,
				pressure: interpolatePressure(a, b, t0),
			};
			const p1: SketchPoint = {
				x: a.x + (b.x - a.x) * t1,
				y: a.y + (b.y - a.y) * t1,
				pressure: interpolatePressure(a, b, t1),
			};
			const tail = current == null ? null : current[current.length - 1];
			const cont = tail != null && tail.x === p0.x && tail.y === p0.y;
			if (!cont && current != null) out.push(current);
			const run: SketchPoint[] = cont && current != null ? current : [p0];
			run.push(p1);
			current = run;
		}
	}
	if (current != null) out.push(current);
	return out;
}

function interpolatePressure(
	a: SketchPoint,
	b: SketchPoint,
	t: number,
): number | undefined {
	if (a.pressure == null && b.pressure == null) return undefined;
	return lerp(a.pressure ?? 1, b.pressure ?? 1, t);
}

/** Merge erase intervals and return kept complement within [0,1]. */
function subtractIntervals(cuts: [number, number][]): [number, number][] {
	if (cuts.length === 0) return [[0, 1]];
	const sorted = cuts
		.map(
			([a, b]) =>
				[Math.max(0, Math.min(a, b)), Math.min(1, Math.max(a, b))] as [
					number,
					number,
				],
		)
		.sort((a, b) => a[0] - b[0]);
	const kept: [number, number][] = [];
	let cursor = 0;
	for (const [lo, hi] of sorted) {
		if (lo > cursor) kept.push([cursor, Math.min(lo, 1)]);
		cursor = Math.max(cursor, hi);
		if (cursor >= 1) break;
	}
	if (cursor < 1) kept.push([cursor, 1]);
	return kept.filter(([a, b]) => b - a > 1e-9);
}

/**
 * Intervals of `t` on segment ab where the eraser capsule cd (radius r)
 * covers the point. Analytic: chord through the capsule's Minkowski sum
 * approximated by circle-chord at both ends + parallel lines around c->d.
 */
function segmentEraseIntervals(
	a: { x: number; y: number },
	b: { x: number; y: number },
	seg: EraserSegment,
	r: number,
): [number, number][] {
	const intervals: [number, number][] = [];
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const len2 = abx * abx + aby * aby;
	if (len2 === 0) {
		return distToSegment(a, seg.from, seg.to) <= r ? [[0, 1]] : [];
	}
	const addClamped = (lo: number, hi: number) => {
		const l = Math.max(0, Math.min(lo, hi));
		const h = Math.min(1, Math.max(lo, hi));
		if (h - l > 1e-9) intervals.push([l, h]);
	};
	// Rounded ends: chord through each circle.
	for (const c of [seg.from, seg.to]) {
		const cx = c.x - a.x;
		const cy = c.y - a.y;
		const A = len2;
		const B = -2 * (cx * abx + cy * aby);
		const C = cx * cx + cy * cy - r * r;
		const disc = B * B - 4 * A * C;
		if (disc <= 0) continue;
		const sq = Math.sqrt(disc);
		addClamped((-B - sq) / (2 * A), (-B + sq) / (2 * A));
	}
	// Rectangular middle: where |perp distance to the axis| <= r AND the
	// axial projection lands within [0, len] of the capsule's axis segment.
	const cdx = seg.to.x - seg.from.x;
	const cdy = seg.to.y - seg.from.y;
	const clen = Math.hypot(cdx, cdy);
	if (clen > 0) {
		const ux = cdx / clen;
		const uy = cdy / clen;
		const nx = -uy;
		const ny = ux;
		const d0 = (a.x - seg.from.x) * nx + (a.y - seg.from.y) * ny;
		const d1 = (b.x - seg.from.x) * nx + (b.y - seg.from.y) * ny;
		const dd = d1 - d0;
		// Perp-distance interval: roots at |d| = r.
		let strip: [number, number] | null = null;
		if (Math.abs(dd) > 1e-12) {
			const tA = (r - d0) / dd;
			const tB = (-r - d0) / dd;
			if (tA > tB ? tB < 1 && tA > 0 : tA < 1 && tB > 0) {
				strip = [Math.min(tA, tB), Math.max(tA, tB)];
			}
		} else if (Math.abs(d0) <= r) {
			strip = [-Infinity, Infinity];
		}
		if (strip != null) {
			// Axial projection interval: proj(t) in [0, clen].
			const p0 = (a.x - seg.from.x) * ux + (a.y - seg.from.y) * uy;
			const p1 = (b.x - seg.from.x) * ux + (b.y - seg.from.y) * uy;
			const pd = p1 - p0;
			let proj: [number, number] | null = null;
			if (Math.abs(pd) > 1e-12) {
				const tA = (0 - p0) / pd;
				const tB = (clen - p0) / pd;
				if (tA > tB ? tB < 1 && tA > 0 : tA < 1 && tB > 0) {
					proj = [Math.min(tA, tB), Math.max(tA, tB)];
				}
			} else if (p0 >= 0 && p0 <= clen) {
				proj = [-Infinity, Infinity];
			}
			if (proj != null) {
				addClamped(Math.max(strip[0], proj[0]), Math.min(strip[1], proj[1]));
			}
		}
	}
	return intervals;
}

/** Convert any object to outline polylines for cutting. (`io` simplified) */
function outlinePolylines(item: SketchItem): SketchPoint[][] {
	switch (item.kind) {
		case "stroke":
		case "ink":
			return splitPointRuns(
				item.kind === "stroke"
					? smoothStrokePoints(item.points, item.style.width)
					: item.points,
			);
		case "line":
			return [[item.from, item.to]];
		case "arrow": {
			const head = arrowHead(item);
			return [
				[item.from, arrowShaftEnd(item)],
				[item.to, head.left, head.right],
			];
		}
		case "rectangle":
		case "ellipse":
		case "triangle":
		case "diamond":
		case "star":
		case "heart": {
			const { points, closed } = shapeOutlinePoints(item);
			return closed && points.length > 0 ? [[...points, points[0]!]] : [points];
		}
		case "text":
			return [];
	}
}

/** True when the eraser capsule hits a text object (bounds approximation). */
function eraserHitsText(
	item: Extract<SketchItem, { kind: "text" }>,
	segments: readonly EraserSegment[],
	r: number,
): boolean {
	const b = normalizeBounds(item.bounds);
	const corners = [
		{ x: b.x, y: b.y },
		{ x: b.x + b.width, y: b.y },
		{ x: b.x + b.width, y: b.y + b.height },
		{ x: b.x, y: b.y + b.height },
	];
	for (const seg of segments) {
		if (pointInBounds(b, seg.from) || pointInBounds(b, seg.to)) return true;
		for (let i = 0; i < 4; i += 1) {
			const c1 = corners[i];
			const c2 = corners[(i + 1) % 4];
			if (c1 != null && c2 != null && segmentsIntersect(seg.from, seg.to, c1, c2))
				return true;
			if (c1 != null && distToSegment(c1, seg.from, seg.to) <= r) return true;
		}
	}
	return false;
}

function segmentsIntersect(
	a: { x: number; y: number },
	b: { x: number; y: number },
	c: { x: number; y: number },
	d: { x: number; y: number },
): boolean {
	const s = (
		p: { x: number; y: number },
		q: { x: number; y: number },
		r: { x: number; y: number },
	) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	const d1 = s(c, d, a);
	const d2 = s(c, d, b);
	const d3 = s(a, b, c);
	const d4 = s(a, b, d);
	return (
		((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
		((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
	);
}

/**
 * Create a live erasure session over `doc`. Segments arrive via `append`;
 * `document` reflects the residual doc for preview; `finish()` calls
 * `onComplete` with the final doc (one history entry). (`go` simplified)
 */
export function createErasure(
	doc: SketchDoc,
	opts: {
		width: number;
		viewportScale: number;
		allocateObjectId: () => string;
		onPreview: () => void;
		onComplete: (doc: SketchDoc) => void;
	},
): ErasureSession {
	const r = opts.width / 2;
	const scale = opts.viewportScale > 0 ? opts.viewportScale : 1;
	const deleted = new Set<string>();
	const parts = new Map<string, ErasePartState>();
	const pendingPoints: SketchPoint[] = [];
	const segments: EraserSegment[] = [];
	let consumedPoints = 0;
	let consumedSegments = 0;
	let released = false;
	let cancelled = false;
	let finished = false;
	let previewDirty = false;
	let preview: SketchDoc = doc;

	const partKey = (id: string, index: number) => `${id}#${index}`;

	/** Lazily explode an object into cuttable runs. */
	function ensureParts(item: SketchItem): ErasePartState | null {
		let state = parts.get(item.id);
		if (state != null) return state;
		const runs = outlinePolylines(item);
		if (runs.length === 0) return null;
		state = { changed: false, runs: runs.map((run) => run.slice()) };
		parts.set(item.id, state);
		return state;
	}

	/** Cut every run overlapping the new segments. */
	function applySegments(batch: EraserSegment[]) {
		if (batch.length === 0) return;
		const bounds = pointsBounds(batch.flatMap((s) => [s.from, s.to]));
		if (bounds == null) return;
		const area = inflateBounds(bounds, r);
		for (const item of doc.objects) {
			if (deleted.has(item.id)) continue;
			const ob = drawingBounds(item);
			if (ob == null || boundsIntersect(ob, area) == null) continue;
			if (item.kind === "text") {
				if (eraserHitsText(item, batch, r)) {
					deleted.add(item.id);
					previewDirty = true;
				}
				continue;
			}
			const state = ensureParts(item);
			if (state == null) continue;
			// Touch only runs whose bounds intersect the batch area.
			const nextRuns: SketchPoint[][] = [];
			let changed = false;
			for (const run of state.runs) {
				const rb = pointsBounds(run, item.style.width / 2);
				if (rb == null || boundsIntersect(rb, area) == null) {
					nextRuns.push(run);
					continue;
				}
				const residual = cutPolyline(run, batch, r);
				if (residual.length !== 1 || residual[0] !== run) changed = true;
				nextRuns.push(...residual);
			}
			if (changed) {
				state.runs = nextRuns;
				state.changed = true;
				previewDirty = true;
			}
		}
	}

	/** Residual document for the current cut state. */
	function residualDocument(): SketchDoc {
		const objects: SketchItem[] = [];
		for (const item of doc.objects) {
			if (deleted.has(item.id)) continue;
			const state = parts.get(item.id);
			if (state == null || !state.changed) {
				objects.push(item);
				continue;
			}
			let index = 0;
			for (const run of state.runs) {
				const ink: SketchItem = {
					kind: "ink",
					id: index === 0 ? item.id : partKey(item.id, index),
					points: run,
					style: { ...item.style },
				};
				objects.push(ink);
				index += 1;
			}
		}
		return { schemaVersion: 1, objects };
	}

	/** Fragment discard: tiny ink runs are dropped at finish. (`j`) */
	function keepFragment(points: SketchPoint[], width: number): boolean {
		const b = pointsBounds(points);
		if (b == null) return false;
		let length = 0;
		for (let i = 1; i < points.length; i += 1) {
			const a = points[i - 1];
			const c = points[i];
			if (a != null && c != null) length += dist(a, c);
		}
		if (points.length === 1) length = width;
		const approxArea = length * Math.max(width, 1);
		return !(
			approxArea < ERASURE_FRAGMENT_MIN_AREA &&
			Math.max(b.width, b.height) * scale < ERASURE_FRAGMENT_MIN_SIZE
		);
	}

	/** Final residual doc with real allocated ids and fragment cleanup. (`A`) */
	function finalDocument(): SketchDoc {
		let anyChanged = deleted.size > 0;
		if (!anyChanged) {
			for (const state of parts.values()) {
				if (state.changed) {
					anyChanged = true;
					break;
				}
			}
		}
		if (!anyChanged) return doc;
		const objects: SketchItem[] = [];
		for (const item of doc.objects) {
			if (deleted.has(item.id)) continue;
			const state = parts.get(item.id);
			if (state == null || !state.changed) {
				objects.push(item);
				continue;
			}
			let index = 0;
			for (const run of state.runs) {
				if (!keepFragment(run, item.style.width)) continue;
				const ink: SketchItem = {
					kind: "ink",
					id: index === 0 ? item.id : opts.allocateObjectId(),
					points: run,
					style: { ...item.style },
				};
				objects.push(ink);
				index += 1;
			}
		}
		return { schemaVersion: 1, objects };
	}

	function drain() {
		// New points: segment from previous relaxed point unless breakBefore.
		while (consumedPoints < pendingPoints.length) {
			const p = pendingPoints[consumedPoints];
			consumedPoints += 1;
			if (p == null) break;
			const prev = pendingPoints[consumedPoints - 2];
			if (consumedPoints >= 2 && prev != null && p.breakBefore !== true) {
				segments.push({ from: prev, to: p });
			} else {
				segments.push({ from: p, to: p }); // degenerate dot segment
			}
		}
		// Apply all pending segments in batches; all are tiny so run synchronously.
		while (consumedSegments < segments.length) {
			const slice = segments.slice(
				consumedSegments,
				consumedSegments + ERASURE_BATCH,
			);
			consumedSegments += slice.length;
			applySegments(slice);
		}
		if (previewDirty) {
			previewDirty = false;
			preview = residualDocument();
			opts.onPreview();
		}
		if (released && !finished) {
			finished = true;
			opts.onComplete(finalDocument());
		}
	}

	return {
		get released() {
			return released;
		},
		get document() {
			return preview;
		},
		append(points: SketchPoint[]) {
			if (released || cancelled || finished) return;
			pendingPoints.length = 0;
			pendingPoints.push(...points);
			drain();
		},
		finish() {
			if (released || cancelled || finished) return;
			released = true;
			drain();
		},
		cancel() {
			cancelled = true;
			parts.clear();
			segments.length = 0;
			pendingPoints.length = 0;
		},
	};
}

/**
 * DOM-free text layout, Canvas 2D object/document/eraser rendering, and PNG
 * export for SketchPad.
 */
import {
	arrowHead,
	arrowShaftEnd,
	boundsContain,
	clamp,
	contentBounds,
	effectiveHandle,
	isFiniteNumber,
	lerp,
	normalizeBounds,
	pressureWidth,
	relaxedPoint,
	selectionBounds,
	shapePoints,
	smoothStrokePoints,
	splitPointRuns,
	TEXT_FONT_FAMILY,
	TEXT_INITIAL_WIDTH,
	TEXT_LINE_HEIGHT_RATIO,
	TEXT_PADDING,
	TEXT_RENDER_SIZE,
	TEXT_SIZE_DEFAULT,
	TEXT_SIZE_MIN,
} from "./sketchGeometry";
import type {
	Bounds,
	ResizeHandle,
	SketchDoc,
	SketchEraserPreview,
	SketchExportResult,
	SketchItem,
	SketchPoint,
	StrokeStyle,
	TextFormat,
} from "./sketchGeometry";

// Export caps.
const EXPORT_MAX_DIMENSION = 2048;
const EXPORT_MAX_PIXELS = 4_000_000;
const EXPORT_DEFAULT_PADDING = 24;

// ---------------------------------------------------------------------------
// Text layout (DOM-free estimator; `jt`/`Mt`/`Ot`/`D`-style normalization)
// ---------------------------------------------------------------------------

interface GraphemeSegmenterLike {
	segment(text: string): Iterable<{ segment: string }>;
}

let graphemeSegmenter: GraphemeSegmenterLike | null | undefined;
function graphemes(text: string): string[] {
	if (graphemeSegmenter === undefined) {
		const intl: typeof Intl & { Segmenter?: unknown } = Intl;
		const candidate = intl.Segmenter;
		// Intl.Segmenter lacks lib types in ES2021; validate it is a constructor.
		graphemeSegmenter =
			typeof candidate === "function"
				? (Reflect.construct(candidate, [
						undefined,
						{ granularity: "grapheme" },
					]) as GraphemeSegmenterLike)
				: null;
	}
	if (graphemeSegmenter == null) return Array.from(text);
	return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

const isFormattingOnly = (g: string) =>
	/^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]+$/u.test(g);
const isBreakable = (g: string) => /\s/.test(g) || g === "-";

/** Estimated grapheme advance at `fontSize`. (`jt`) */
export function measureTextWidth(text: string, fontSize: number): number {
	let w = 0;
	for (const g of graphemes(text)) {
		if (isFormattingOnly(g)) continue;
		if (/^\s+$/u.test(g)) w += fontSize * 0.32;
		else if (/^[ilI.,'!|]$/u.test(g)) w += fontSize * 0.28;
		else if (/^[MW@#%&]$/u.test(g)) w += fontSize * 0.82;
		else if (/[^ -~]/u.test(g)) w += fontSize;
		else w += fontSize * 0.56;
	}
	return w;
}

/** Wrap + line-height -> layout. (`w`/`Ot` simplified, estimator only) */
export function layoutText(opts: {
	text: string;
	boxWidth: number;
	fontSize: number;
}): { lines: string[]; lineHeight: number; height: number } {
	const fontSize = normalizeFontSize(opts.fontSize);
	const innerWidth = Math.max(opts.boxWidth - TEXT_PADDING * 2, fontSize / 8);
	const lineHeight = fontSize * TEXT_LINE_HEIGHT_RATIO;
	const paragraphs = normalizeLineEndings(opts.text).split("\n");
	const lines: string[] = [];
	for (const para of paragraphs) {
		if (para.length === 0) {
			lines.push("");
			continue;
		}
		// Greedy wrap in fontSize units.
		const gs = graphemes(para);
		let start = 0;
		while (start < gs.length) {
			let end = start;
			let breakAt = -1;
			let w = 0;
			for (let i = start; i < gs.length; i += 1) {
				const gw = measureTextWidth(gs[i] ?? "", fontSize);
				if (w + gw > innerWidth && i > start) break;
				w += gw;
				end = i + 1;
				const g = gs[i];
				if (g != null && isBreakable(g)) breakAt = i + 1;
			}
			if (end <= start) end = start + 1;
			const stop = end < gs.length && breakAt > start ? breakAt : end;
			lines.push(gs.slice(start, stop).join("").trimEnd());
			start = stop;
			while (start < gs.length) {
				const g = gs[start];
				if (g == null || !/\s/.test(g)) break;
				start += 1;
			}
		}
	}
	if (lines.length === 0) lines.push("");
	return {
		lines,
		lineHeight,
		height: Math.max(lines.length * lineHeight, lineHeight),
	};
}

export const normalizeFontSize = (v: number): number =>
	Number.isFinite(v) && v > 0 ? v : TEXT_SIZE_DEFAULT;
export const normalizeLineEndings = (s: string): string =>
	s.replace(/\r\n?/g, "\n");

/** Minimum box width: widest grapheme + padding. (`y` fallback path) */
function textMinimumWidth(opts: {
	text: string;
	fontSize: number;
	format: TextFormat;
}): number {
	const fontSize = normalizeFontSize(opts.fontSize);
	let widest = 0;
	for (const g of new Set(graphemes(normalizeLineEndings(opts.text)))) {
		if (isFormattingOnly(g)) continue;
		const w = measureTextWidth(g, fontSize);
		if (Number.isFinite(w)) widest = Math.max(widest, w);
	}
	if (widest === 0) widest = fontSize;
	return widest + TEXT_PADDING * 2;
}

/**
 * Normalize a text object: width grown to fit the widest grapheme, height
 * relaid out. (`D`/`Tt` simplified — padding fixed at TEXT_PADDING.)
 */
export function normalizeTextObject<
	T extends Extract<SketchItem, { kind: "text" }>,
>(item: T): T {
	const bounds = normalizeBounds(item.bounds);
	const text = normalizeLineEndings(item.text);
	const width = Math.max(
		bounds.width,
		textMinimumWidth({
			text,
			fontSize: item.style.width,
			format: item.format,
		}),
	);
	const layout = layoutText({
		text,
		boxWidth: width,
		fontSize: item.style.width,
	});
	return {
		...item,
		text,
		bounds: {
			x: bounds.x,
			y: bounds.y,
			width,
			height: layout.height + TEXT_PADDING * 2,
		},
	};
}

/** Default bounds for a fresh text box at `point` inside `existing`. (`wt`) */
export function defaultTextBounds(
	point: { x: number; y: number },
	existing: Bounds,
	fontSize: number,
): Bounds {
	const fs = normalizeFontSize(fontSize);
	const minW = fs + TEXT_PADDING * 2;
	const w = Math.max(existing.width, minW);
	const h = Math.max(existing.height, 0);
	const x = clamp(point.x, 0, w);
	const left = Math.max(x - TEXT_PADDING, 0);
	const spaceRight = w - left;
	const width = Math.min(
		Math.max(TEXT_INITIAL_WIDTH, minW),
		Math.max(spaceRight, minW),
	);
	const minH = fs * TEXT_LINE_HEIGHT_RATIO + TEXT_PADDING * 2;
	const top = clamp(
		point.y - TEXT_PADDING - (fs * TEXT_LINE_HEIGHT_RATIO) / 2,
		0,
		Math.max(h - minH, 0),
	);
	return {
		x: spaceRight >= minW ? left : Math.max(w - width, 0),
		y: top,
		width,
		height: minH,
	};
}

/** Inner width when a box of `outer` carries `pad` per side. (`pt`) */
function innerExtent(outer: number, pad: number): number {
	const floor = pad / 8;
	return Math.max(outer - pad * 2, floor);
}

/** Corner/n-s text resize: scale font by drag extent, keep anchor. (`xn`) */
export function resizeTextObject(
	item: Extract<SketchItem, { kind: "text" }>,
	handle: ResizeHandle,
	point: { x: number; y: number },
	surfaceBounds: Bounds | null,
): SketchItem {
	if (handle === "e" || handle === "w")
		return resizeTextWidth(item, handle, point);
	const b = normalizeBounds(item.bounds);
	const pad = TEXT_PADDING;
	const fontSize = normalizeFontSize(item.style.width);
	const scale = textScaleRatio(b, handle, point, pad);
	const nextSize = normalizeFontSize(fontSize * scale);
	const c = nextSize / fontSize;
	const width = Math.max(
		textMinimumWidth({
			text: item.text,
			fontSize: nextSize,
			format: item.format,
		}),
		innerExtent(b.width, pad) * c + pad * 2,
	);
	const relaid = normalizeTextObject({
		...item,
		style: { ...item.style, width: nextSize },
		bounds: { ...b, width },
	});
	const right = b.x + b.width;
	const bottom = b.y + b.height;
	const cx = b.x + b.width / 2;
	const cy = b.y + b.height / 2;
	const eff = effectiveHandle(item, handle, point);
	const anchorX = handle.includes("w") ? right : b.x;
	const anchorY = handle.includes("n") ? bottom : b.y;
	const x =
		handle.includes("w") || handle.includes("e")
			? anchorX - (eff.includes("w") ? relaid.bounds.width : 0)
			: cx - relaid.bounds.width / 2;
	const y =
		handle.includes("n") || handle.includes("s")
			? anchorY - (eff.includes("n") ? relaid.bounds.height : 0)
			: cy - relaid.bounds.height / 2;
	let out: SketchItem = {
		...relaid,
		bounds: { ...relaid.bounds, x, y },
	};
	if (surfaceBounds != null) {
		const limit = normalizeBounds(surfaceBounds);
		const sb = selectionBounds(out);
		if (sb != null && !boundsContain(limit, sb)) {
			// Binary search the drag toward the anchor until it fits. (`tn`-ish)
			const anchor = {
				x: b.x + (handle.includes("w") ? 0 : b.width),
				y: b.y + (handle.includes("n") ? 0 : b.height),
			};
			let lo = 0;
			let hi = 1;
			for (let i = 0; i < 20; i += 1) {
				const t = (lo + hi) / 2;
				const candidate = resizeTextObject(
					item,
					handle,
					{ x: lerp(anchor.x, point.x, t), y: lerp(anchor.y, point.y, t) },
					null,
				);
				const cb = selectionBounds(candidate);
				if (cb == null || boundsContain(limit, cb)) {
					lo = t;
					out = candidate;
				} else {
					hi = t;
				}
			}
		}
	}
	return out;
}

/** (`Sn`) side handles change width only. */
function resizeTextWidth(
	item: Extract<SketchItem, { kind: "text" }>,
	handle: ResizeHandle,
	point: { x: number; y: number },
): SketchItem {
	const b = normalizeBounds(item.bounds);
	const minW = textMinimumWidth({
		text: item.text,
		fontSize: item.style.width,
		format: item.format,
	});
	const anchor = handle === "w" ? b.x + b.width : b.x;
	const width = Math.max(Math.abs(point.x - anchor), minW);
	const eff = effectiveHandle(item, handle, point);
	return normalizeTextObject({
		...item,
		bounds: { ...b, x: eff === "w" ? anchor - width : anchor, width },
	});
}

/** Font-scale ratio for a text drag. (`wn`/`Tn`) */
function textScaleRatio(
	b: Bounds,
	handle: ResizeHandle,
	point: { x: number; y: number },
	pad: number,
): number {
	const right = b.x + b.width;
	const innerW = innerExtent(b.width, pad);
	const horiz = handle.includes("w")
		? scaleFactor(right - point.x, innerW, pad)
		: handle.includes("e")
			? scaleFactor(point.x - b.x, innerW, pad)
			: null;
	return (
		horiz ??
		scaleFactor(
			handle.includes("n") ? b.y + b.height - point.y : point.y - b.y,
			innerExtent(b.height, pad),
			pad,
		)
	);
}
function scaleFactor(extent: number, inner: number, pad: number): number {
	return Math.max(
		pad / Math.max(inner, pad / 8) / pad,
		innerExtent(Math.abs(extent), pad) / inner,
	);
}

/** Clamp font size so text still fits surface height. (`fn` simplified) */
export function fitTextStyle(
	item: Extract<SketchItem, { kind: "text" }>,
	style: StrokeStyle,
	surfaceBounds: Bounds | null,
): StrokeStyle {
	const next = { ...style, width: normalizeFontSize(style.width) };
	if (surfaceBounds == null) return next;
	const limit = normalizeBounds(surfaceBounds);
	const avail = Math.max(limit.y + limit.height - item.bounds.y, 0);
	const fits = (size: number) => {
		const layout = layoutText({
			text: item.text,
			boxWidth: item.bounds.width,
			fontSize: size,
		});
		return layout.height + TEXT_PADDING * 2 <= avail;
	};
	if (fits(next.width)) return next;
	const minSize = Math.min(
		TEXT_SIZE_MIN,
		normalizeFontSize(item.style.width),
		next.width,
	);
	if (!fits(minSize)) return { ...next, width: minSize };
	let lo = minSize;
	let hi = next.width;
	for (let i = 0; i < 16; i += 1) {
		const mid = (lo + hi) / 2;
		if (fits(mid)) lo = mid;
		else hi = mid;
	}
	return { ...next, width: lo };
}

/** Keep a text object's bounds inside the surface. (`un` lite) */
export function clampTextToSurface(
	item: Extract<SketchItem, { kind: "text" }>,
	surface: Bounds | null,
): Extract<SketchItem, { kind: "text" }> {
	if (surface == null) return item;
	const limit = normalizeBounds(surface);
	const minW = Math.min(
		textMinimumWidth({
			text: item.text,
			fontSize: item.style.width,
			format: item.format,
		}),
		limit.width,
	);
	const right = limit.x + limit.width;
	const bottom = limit.y + limit.height;
	const x = clamp(item.bounds.x, limit.x, right - minW);
	const width = clamp(item.bounds.width, minW, right - x);
	const minH = Math.min(
		item.style.width * TEXT_LINE_HEIGHT_RATIO + TEXT_PADDING * 2,
		limit.height,
	);
	const y = clamp(item.bounds.y, limit.y, bottom - minH);
	const maxH = Math.max(bottom - y, 0);
	const relaid = normalizeTextObject({
		...item,
		bounds: { ...item.bounds, x, y, width },
	});
	const height = Math.min(relaid.bounds.height, maxH);
	return x === relaid.bounds.x &&
		y === relaid.bounds.y &&
		width === relaid.bounds.width &&
		height === relaid.bounds.height
		? relaid
		: { ...relaid, bounds: { ...relaid.bounds, x, y, width, height } };
}

// ---------------------------------------------------------------------------
// Rendering (`Rn`/`zn`/`qn`/`Jn`/`tr`/`er`/`Kn`) + export (`bo`)
// ---------------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D;

/** Draw one object. (`zn` minus comment/ink-coverage branches) */
export function renderSketchObject(ctx: Ctx2D, item: SketchItem): void {
	ctx.save();
	try {
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		if (item.kind !== "ink" && item.kind !== "text" && item.style.width <= 0)
			return;
		ctx.strokeStyle = item.style.color;
		ctx.fillStyle = item.style.color;
		ctx.lineWidth = item.style.width;
		if (
			item.kind !== "ink" &&
			item.kind !== "text" &&
			"bounds" in item &&
			item.bounds.width === 0 &&
			item.bounds.height === 0
		) {
			ctx.beginPath();
			ctx.arc(
				item.bounds.x,
				item.bounds.y,
				item.style.width / 2,
				0,
				Math.PI * 2,
			);
			ctx.fill();
			return;
		}
		switch (item.kind) {
			case "ink":
				drawPolyline(ctx, item.points, item.style.width);
				break;
			case "stroke": {
				const pts = smoothStrokePoints(item.points, item.style.width);
				if (pts.some((p) => p.pressure != null))
					for (const run of splitPointRuns(pts))
						drawRibbon(ctx, run, item.style.width);
				else drawPolyline(ctx, pts, item.style.width);
				break;
			}
			case "line":
				drawSegment(ctx, item.from, item.to);
				break;
			case "arrow":
				drawSegment(ctx, item.from, arrowShaftEnd(item));
				drawArrowHead(ctx, item);
				break;
			case "rectangle": {
				const b = normalizeBounds(item.bounds);
				ctx.strokeRect(b.x, b.y, b.width, b.height);
				break;
			}
			case "ellipse": {
				const b = normalizeBounds(item.bounds);
				ctx.beginPath();
				ctx.ellipse(
					b.x + b.width / 2,
					b.y + b.height / 2,
					b.width / 2,
					b.height / 2,
					0,
					0,
					Math.PI * 2,
				);
				ctx.stroke();
				break;
			}
			case "triangle":
			case "diamond":
			case "star":
			case "heart":
				drawClosedPolygon(ctx, shapePoints(item.kind, item.bounds, item));
				break;
			case "text":
				drawText(ctx, item);
		}
	} finally {
		ctx.restore();
	}
}

/** Render a document: non-text first, text last. (`Rn`) */
export function renderSketchDocument(
	ctx: Ctx2D,
	doc: SketchDoc,
	opts?: {
		excludeIds?: Set<string>;
		replacement?: {
			objectId: string;
			object: SketchItem | SketchEraserPreview;
		};
	},
): void {
	const objects = doc.objects.flatMap((o) =>
		o.id === opts?.replacement?.objectId
			? opts.replacement.object.kind === "eraser"
				? []
				: [opts.replacement.object]
			: opts?.excludeIds?.has(o.id)
				? []
				: [o],
	);
	for (const o of objects) if (o.kind !== "text") renderSketchObject(ctx, o);
	for (const o of objects) if (o.kind === "text") renderSketchObject(ctx, o);
}

/** Eraser trail drawn with destination-out for the live preview. (`Bn`) */
export function renderEraserTrail(
	ctx: Ctx2D,
	points: readonly SketchPoint[],
	width: number,
): void {
	if (width <= 0 || points.length === 0) return;
	const relaxed: SketchPoint[] = [];
	for (let i = 0; i < points.length; i += 1) {
		const p = relaxedPoint(points, i, width);
		if (p != null) relaxed.push(p);
	}
	ctx.save();
	try {
		ctx.globalCompositeOperation = "destination-out";
		ctx.strokeStyle = "#000000";
		ctx.fillStyle = "#000000";
		ctx.lineWidth = width;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		drawPolyline(ctx, relaxed, width);
	} finally {
		ctx.restore();
	}
}

/** Plain polyline; single point -> filled circle. (`qn`) */
function drawPolyline(
	ctx: Ctx2D,
	points: readonly SketchPoint[],
	width: number,
): void {
	if (points.length === 0) return;
	for (const run of splitPointRuns(points)) {
		const first = run[0];
		if (first == null) continue;
		if (run.length === 1) {
			ctx.beginPath();
			ctx.arc(first.x, first.y, width / 2, 0, Math.PI * 2);
			ctx.fill();
			continue;
		}
		ctx.beginPath();
		ctx.moveTo(first.x, first.y);
		for (let i = 1; i < run.length; i += 1) {
			const p = run[i];
			if (p != null) ctx.lineTo(p.x, p.y);
		}
		ctx.stroke();
	}
}

/** Variable-width ribbon + dots for pressure strokes. (`Jn`) */
function drawRibbon(
	ctx: Ctx2D,
	points: readonly SketchPoint[],
	width: number,
): void {
	const first = points[0];
	if (first == null) return;
	if (points.length === 1) {
		const r = pressureWidth(first, width) / 2;
		ctx.beginPath();
		ctx.arc(first.x, first.y, r, 0, Math.PI * 2);
		ctx.fill();
		return;
	}
	ctx.beginPath();
	for (let i = 1; i < points.length; i += 1) {
		const a = points[i - 1];
		const b = points[i];
		if (a == null || b == null) continue;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		if (len < 1e-4) continue;
		const nx = -dy / len;
		const ny = dx / len;
		const ra = pressureWidth(a, width) / 2;
		const rb = pressureWidth(b, width) / 2;
		ctx.moveTo(a.x + nx * ra, a.y + ny * ra);
		ctx.lineTo(b.x + nx * rb, b.y + ny * rb);
		ctx.lineTo(b.x - nx * rb, b.y - ny * rb);
		ctx.lineTo(a.x - nx * ra, a.y - ny * ra);
		ctx.closePath();
	}
	ctx.fill();
	ctx.beginPath();
	for (const p of points) {
		const r = pressureWidth(p, width) / 2;
		ctx.moveTo(p.x + r, p.y);
		ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
	}
	ctx.fill();
}

function drawSegment(
	ctx: Ctx2D,
	a: { x: number; y: number },
	b: { x: number; y: number },
): void {
	ctx.beginPath();
	ctx.moveTo(a.x, a.y);
	ctx.lineTo(b.x, b.y);
	ctx.stroke();
}

function drawArrowHead(
	ctx: Ctx2D,
	arrow: {
		from: { x: number; y: number };
		to: { x: number; y: number };
		style: StrokeStyle;
	},
): void {
	const { left, right } = arrowHead(arrow);
	ctx.beginPath();
	ctx.moveTo(arrow.to.x, arrow.to.y);
	ctx.lineTo(left.x, left.y);
	ctx.lineTo(right.x, right.y);
	ctx.closePath();
	ctx.fill();
}

function drawClosedPolygon(
	ctx: Ctx2D,
	points: readonly { x: number; y: number }[],
): void {
	const first = points[0];
	if (first == null) return;
	ctx.beginPath();
	ctx.moveTo(first.x, first.y);
	for (let i = 1; i < points.length; i += 1) {
		const p = points[i];
		if (p != null) ctx.lineTo(p.x, p.y);
	}
	ctx.closePath();
	ctx.stroke();
}

/** Text: clip to bounds, render at 24px scaled, underline below baseline. (`Kn`) */
function drawText(
	ctx: Ctx2D,
	item: Extract<SketchItem, { kind: "text" }>,
): void {
	if (item.text.length === 0) return;
	const b = normalizeBounds(item.bounds);
	const fontSize = normalizeFontSize(item.style.width);
	ctx.beginPath();
	ctx.rect(b.x, b.y, b.width, b.height);
	ctx.clip();
	const scale = fontSize / TEXT_RENDER_SIZE;
	ctx.transform(scale, 0, 0, scale, b.x + TEXT_PADDING, b.y + TEXT_PADDING);
	ctx.font = `${item.format.italic ? "italic" : "normal"} ${item.format.bold ? "700" : "400"} ${TEXT_RENDER_SIZE}px ${TEXT_FONT_FAMILY}`;
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	const layout = layoutText({
		text: item.text,
		boxWidth: b.width,
		fontSize,
	});
	const lineHeight = layout.lineHeight / scale;
	// Baseline centers the line box under the ascent/descent split. (`Ct`)
	const ascent = TEXT_RENDER_SIZE * 0.8;
	const descent = TEXT_RENDER_SIZE * 0.2;
	const baseline = (lineHeight - ascent - descent) / 2 + ascent;
	layout.lines.forEach((line, i) => {
		const y = baseline + i * lineHeight;
		ctx.fillText(line, 0, y);
		if (item.format.underline && line.length > 0) {
			ctx.lineWidth = TEXT_RENDER_SIZE / 16;
			ctx.beginPath();
			const underline = y + TEXT_RENDER_SIZE * 0.1;
			ctx.moveTo(0, underline);
			ctx.lineTo(measureTextWidth(line, TEXT_RENDER_SIZE), underline);
			ctx.stroke();
		}
	});
}

function createCanvas(width: number, height: number): HTMLCanvasElement | null {
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	if (typeof canvas.getContext !== "function") return null;
	canvas.width = Math.max(1, Math.ceil(width));
	canvas.height = Math.max(1, Math.ceil(height));
	return canvas;
}

/** Shared export pipeline: render doc -> canvas. (`bo` minus blob emission) */
function renderExportCanvas(
	doc: SketchDoc,
	opts: {
		backgroundColor?: string;
		padding?: number;
		scale?: number;
		maxDimension?: number;
		maxPixelCount?: number;
	},
):
	| { canvas: HTMLCanvasElement; width: number; height: number }
	| { kind: "empty" | "unavailable" } {
	const content = contentBounds(doc);
	if (content == null) return { kind: "empty" };
	const scale = isFiniteNumber(opts.scale) && opts.scale > 0 ? opts.scale : 1;
	const padding =
		isFiniteNumber(opts.padding) && opts.padding >= 0
			? opts.padding
			: EXPORT_DEFAULT_PADDING;
	const maxDim = Math.max(
		1,
		Math.floor(opts.maxDimension ?? EXPORT_MAX_DIMENSION),
	);
	const maxPixels = Math.max(
		1,
		Math.floor(opts.maxPixelCount ?? EXPORT_MAX_PIXELS),
	);
	const w = content.width + padding * 2;
	const h = content.height + padding * 2;
	const outW = Math.max(1, Math.ceil(w * scale));
	const outH = Math.max(1, Math.ceil(h * scale));
	const finalScale =
		scale *
		Math.min(
			1,
			maxDim / outW,
			maxDim / outH,
			Math.sqrt(maxPixels / (outW * outH)),
		);
	const width = Math.max(1, Math.ceil(w * finalScale));
	const height = Math.max(1, Math.ceil(h * finalScale));
	const canvas = createCanvas(width, height);
	const ctx = canvas?.getContext("2d");
	if (canvas == null || ctx == null) return { kind: "unavailable" };
	if (opts.backgroundColor != null) {
		ctx.fillStyle = opts.backgroundColor;
		ctx.fillRect(0, 0, width, height);
	}
	ctx.setTransform(
		finalScale,
		0,
		0,
		finalScale,
		(padding - content.x) * finalScale,
		(padding - content.y) * finalScale,
	);
	renderSketchDocument(ctx, doc);
	return { canvas, width, height };
}

/** `editor.export` backing: PNG render as a typed result. */
export function exportPng(
	doc: SketchDoc,
	opts: {
		backgroundColor?: string;
		padding?: number;
		scale?: number;
		mimeType?: string;
	} = {},
): Promise<SketchExportResult> {
	const rendered = renderExportCanvas(doc, opts);
	if ("kind" in rendered) {
		return Promise.resolve(
			rendered.kind === "empty"
				? { kind: "empty" }
				: ({ kind: "unavailable" } as SketchExportResult),
		);
	}
	try {
		return Promise.resolve({
			kind: "success",
			dataUrl: rendered.canvas.toDataURL(opts.mimeType ?? "image/png"),
			width: rendered.width,
			height: rendered.height,
		});
	} catch {
		return Promise.resolve({ kind: "unavailable" });
	}
}

/**
 * Render the document to a PNG data URL. Content bounds (stroke-aware) get
 * `padding` around them; the result is capped at 2048px / 4MP by shrinking
 * the scale. Returns null when empty or canvas is unavailable. (`bo` core)
 */
export function exportToPng(
	doc: SketchDoc,
	opts: {
		backgroundColor?: string;
		padding?: number;
		scale?: number;
		maxDimension?: number;
		maxPixelCount?: number;
	} = {},
): Promise<string | null> {
	const rendered = renderExportCanvas(doc, opts);
	if ("kind" in rendered) return Promise.resolve(null);
	try {
		return Promise.resolve(rendered.canvas.toDataURL("image/png"));
	} catch {
		return Promise.resolve(null);
	}
}

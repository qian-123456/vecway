/**
 * Vector sketch editor store for SketchPad, a faithful port of the ChatGPT
 * sketch editor core. No React, no paper.js: pure geometry lives in
 * `sketchGeometry.ts`, text layout + Canvas 2D rendering / PNG export live in
 * `sketchRender.ts`, and this module holds `createSketchEditor` plus
 * transaction/history state management while re-exporting all public symbols.
 */
import {
	boundsEqual,
	boundsFromPoints,
	clamp,
	clampArrowToSurface,
	clampMoveDelta,
	clampPasteOffset,
	clampPointToBounds,
	cloneItem,
	constrainEndpoint,
	CORNER_HANDLE_MIN_SPACING,
	createErasure,
	DEFAULT_FORMAT,
	DEFAULT_STYLE,
	dist,
	DRAWING_WIDTH_MAX,
	DRAWING_WIDTH_MIN,
	effectiveHandle,
	ERASER_DEFAULT,
	ERASER_MAX,
	ERASER_MIN,
	filterGuides,
	fitShapeWidth,
	grabHit,
	HANDLE_TOLERANCE_MOUSE,
	HANDLE_TOLERANCE_TOUCH,
	handlePoint,
	HIT_TOLERANCE,
	hitTestDocument,
	initialPressure,
	initialSnapOffsets,
	insetBounds,
	isDrawableShapeTool,
	isFiniteNumber,
	meetsMinSize,
	MIN_SAMPLE_DISTANCE,
	nextPressure,
	normalizeBounds,
	PASTE_OFFSET,
	pickHandle,
	pointInBounds,
	resizeObject,
	SHAPE_MIN_SIZE,
	shapeBoundsFromTarget,
	SIDE_HANDLE_MIN_SPACING,
	SNAP_TOLERANCE,
	snapTextMove,
	STYLE_WIDTH_MAX,
	STYLE_WIDTH_MIN,
	TEXT_SIZE_DEFAULT,
	TEXT_SIZE_MAX,
	TEXT_SIZE_MIN,
	translateItem,
	translatePoint,
	withPressure,
} from "./sketchGeometry";
import type {
	Bounds,
	ErasureSession,
	PointerSample,
	PressureState,
	PreviewInfo,
	ResizeHandle,
	ShapeKind,
	SketchDoc,
	SketchExportResult,
	SketchItem,
	SketchPoint,
	SketchTextEdit,
	SketchTextEditInput,
	SketchTool,
	SnapGuide,
	StrokeStyle,
	TextFormat,
} from "./sketchGeometry";
import {
	clampTextToSurface,
	defaultTextBounds,
	exportPng,
	fitTextStyle,
	normalizeFontSize,
	normalizeLineEndings,
	normalizeTextObject,
	resizeTextObject,
} from "./sketchRender";

export type {
	Bounds,
	PointerSample,
	PreviewInfo,
	ShapeKind,
	SketchDoc,
	SketchEraserPreview,
	SketchExportResult,
	SketchItem,
	SketchPoint,
	SketchTextEdit,
	SketchTextEditInput,
	SketchTool,
	SnapGuide,
	StrokeStyle,
	TextFormat,
} from "./sketchGeometry";
export {
	hitTestItem,
	shapeOutlinePoints,
	smoothStrokePoints,
	TEXT_FONT_FAMILY,
} from "./sketchGeometry";
export {
	exportToPng,
	layoutText,
	measureTextWidth,
	renderEraserTrail,
	renderSketchDocument,
	renderSketchObject,
} from "./sketchRender";

export interface SketchSnapshot {
	document: SketchDoc;
	/** Document with the pending text edit applied (for rendering). */
	effectiveDocument: SketchDoc;
	/** Monotonic counter bumped only when the committed document changes. */
	committedRev: number;
	/** Monotonic counter bumped when a non-text move/resize replacement changes. */
	replacementRev: number;
	activeTool: SketchTool;
	/** Currently armed shape for the "shapes" tool. */
	shapeKind: ShapeKind;
	style: StrokeStyle;
	drawingWidthPx: number | null;
	eraserSizePx: number;
	textSizePx: number | null;
	textFormat: TextFormat;
	selectionId: string | null;
	canUndo: boolean;
	canRedo: boolean;
	hasActiveGesture: boolean;
	hasPendingTextEdit: boolean;
	preview: PreviewInfo | null;
	/** Live "document after current eraser drag", or null. */
	erasurePreview: SketchDoc | null;
	snapGuides: SnapGuide[];
	cursor: string;
}

export interface SketchEditor {
	getSnapshot(): SketchSnapshot;
	subscribe(fn: () => void): () => void;
	setTool(tool: SketchTool | ShapeKind): void;
	setShapeKind(kind: ShapeKind): void;
	setEraserSize(px: number): void;
	setDrawingWidth(px: number): void;
	setTextSize(px: number): void;
	setStyle(
		partial: Partial<StrokeStyle>,
		opts?: { historyGroup?: string },
	): void;
	setTextFormat(
		partial: Partial<TextFormat>,
		opts?: { historyGroup?: string },
	): void;
	undo(): boolean;
	redo(): boolean;
	clear(): boolean;
	selectObject(id: string): boolean;
	clearSelection(): void;
	deleteSelection(): boolean;
	deleteObject(id: string): boolean;
	nudgeSelection(
		delta: { x: number; y: number },
		opts?: { historyGroup?: string },
	): boolean;
	pointerDown(sample: PointerSample): boolean;
	pointerMove(sample: PointerSample): boolean;
	pointerMoves(samples: PointerSample[]): boolean;
	pointerUp(sample: PointerSample): boolean;
	pointerCommit(pointerId?: number): boolean;
	pointerCancel(
		pointerId?: number,
		opts?: { preserveReleasedErasure?: boolean },
	): boolean;
	pointerLeave(): void;
	getObjectAtPoint(
		point: { x: number; y: number },
		tolerance?: number,
	): SketchItem | null;
	pasteObject(
		item: SketchItem,
		opts?: { offset?: { x: number; y: number } },
	): string | null;
	setSurfaceBounds(bounds: Bounds | null): void;
	setPendingTextEdit(input: SketchTextEditInput | null): void;
	commitPendingTextEdit(): boolean;
	discardPendingTextEdit(): boolean;
	insertTextBox(input: {
		text: string;
		bounds: Bounds;
		style?: Partial<StrokeStyle>;
		format?: Partial<TextFormat>;
	}): string | null;
	updateTextBox(
		id: string,
		patch: { text?: string; bounds?: Bounds },
		opts?: { historyGroup?: string },
	): boolean;
	export(opts?: {
		backgroundColor?: string;
		padding?: number;
		scale?: number;
		mimeType?: string;
	}): Promise<SketchExportResult>;
	replaceDocument(doc: SketchDoc): void;
}

/** Maximum number of undo history entries retained in memory. */
export const MAX_HISTORY_ENTRIES = 100;

const EMPTY_SNAP_GUIDES: SnapGuide[] = [];

// ---------------------------------------------------------------------------
// Editor store (`Ko`)
// ---------------------------------------------------------------------------

type GestureTool = ShapeKind | "pen" | "eraser";

interface DrawGesture {
	kind: "draw";
	pointerId: number;
	tool: GestureTool;
	id: string;
	start: SketchPoint;
	points: SketchPoint[];
	current: SketchPoint;
	viewportScale: number;
	style: StrokeStyle;
	shiftKey: boolean;
	pointerWasOutside: boolean;
	latestSampleTimestamp: number | null;
	surfaceBounds: Bounds | null;
	strokePressure: PressureState | null;
	erasure: ErasureSession | null;
}

interface MoveGesture {
	kind: "move";
	pointerId: number;
	objectId: string;
	originalObject: SketchItem;
	start: { x: number; y: number };
	current: { x: number; y: number };
	hasPointerMove: boolean;
	snapGuides: SnapGuide[];
	initialSnapOffsets: { x: number | null; y: number | null };
	releasedInitialSnapAxes: { x: boolean; y: boolean };
}

interface ResizeGesture {
	kind: "resize";
	pointerId: number;
	objectId: string;
	originalObject: SketchItem;
	handle: ResizeHandle;
	current: { x: number; y: number };
	pointerOffset: { x: number; y: number };
	hasPointerMove: boolean;
	surfaceBounds: Bounds | null;
}

type Gesture = DrawGesture | MoveGesture | ResizeGesture;

interface HistoryEntry {
	before: SketchDoc;
	after: SketchDoc;
	selectionBefore: string | null;
	selectionAfter: string | null;
	styleBefore: StrokeStyle;
	styleAfter: StrokeStyle;
	historyGroup?: string;
}

const emptyDoc = (): SketchDoc => ({ schemaVersion: 1, objects: [] });

const clampEraserSize = (v: number | undefined) =>
	clamp(
		v != null && Number.isFinite(v) ? v : ERASER_DEFAULT,
		ERASER_MIN,
		ERASER_MAX,
	);
const clampDrawingWidth = (v: number) =>
	clamp(
		Number.isFinite(v) ? v : DRAWING_WIDTH_MIN,
		DRAWING_WIDTH_MIN,
		DRAWING_WIDTH_MAX,
	);
const clampStyleWidth = (style: StrokeStyle): StrokeStyle => ({
	...style,
	width: Math.min(STYLE_WIDTH_MAX, Math.max(STYLE_WIDTH_MIN, style.width)),
});
const clampTextSize = (v: number) =>
	clamp(
		Number.isFinite(v) ? v : TEXT_SIZE_DEFAULT,
		TEXT_SIZE_MIN,
		TEXT_SIZE_MAX,
	);

/** Style normalization for drawing tools. (`Ge`+`Jo`) */
function normalizeStyle(
	partial: Partial<StrokeStyle> | undefined,
	fallback: StrokeStyle = DEFAULT_STYLE,
): StrokeStyle {
	const color =
		typeof partial?.color === "string" && partial.color.trim().length > 0
			? partial.color
			: fallback.color;
	const width = isFiniteNumber(partial?.width)
			? partial.width
			: fallback.width;
	return { color, width: width > 0 ? width : 1 };
}

/** Text style: width is the font size (uncapped, normalized to 24). (`cn`) */
function normalizeTextStyle(partial: Partial<StrokeStyle>): StrokeStyle {
	return { ...normalizeStyle(partial), width: normalizeFontSize(partial.width ?? NaN) };
}

const normalizeFormat = (f?: Partial<TextFormat>): TextFormat => ({
	bold: f?.bold === true,
	italic: f?.italic === true,
	underline: f?.underline === true,
});

const sameFormat = (a: TextFormat, b: TextFormat) =>
	a.bold === b.bold && a.italic === b.italic && a.underline === b.underline;

/** Object equality for mutation short-circuits. (`Zo`) */
function sameItem(a: SketchItem, b: SketchItem): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Id allocator producing `sketch-object-N`. (`Gt`) */
function createIdAllocator(existing: string[], prefix = "sketch-object") {
	const used = new Set<string>();
	let next = 1;
	const reserve = (ids: string[]) => {
		for (const id of ids) used.add(id);
	};
	reserve(existing);
	return {
		reserve,
		allocate(): string {
			let id: string;
			do {
				id = `${prefix}-${next}`;
				next += 1;
			} while (used.has(id));
			used.add(id);
			return id;
		},
	};
}

/**
 * Create the sketch editor store. Port of the reference `Ko` factory; see
 * SPEC.md for the frozen contract. Synchronous: erasure cutting runs inline.
 */
export function createSketchEditor(init: {
	document?: SketchDoc;
	tool?: SketchTool | ShapeKind;
	style?: Partial<StrokeStyle>;
	shapeKind?: ShapeKind;
	eraserSizePx?: number;
	drawingWidthPx?: number;
	textSizePx?: number;
} = {}): SketchEditor {
	const initTool = init.tool ?? "pen";
	const isShapeInit = (initTool as string) !== "shapes" && isDrawableShapeTool(initTool);
	let doc = init.document ?? emptyDoc();
	let tool: SketchTool = isShapeInit
		? "shapes"
		: isDrawableShapeTool(initTool)
			? "shapes"
			: (initTool as SketchTool);
	let shapeKind: ShapeKind =
		init.shapeKind ??
		(isDrawableShapeTool(initTool) ? (initTool as ShapeKind) : "line");
	let eraserSize = clampEraserSize(init.eraserSizePx);
	let drawingWidth =
		init.drawingWidthPx == null ? undefined : clampDrawingWidth(init.drawingWidthPx);
	let textSize = init.textSizePx == null ? undefined : clampTextSize(init.textSizePx);
	// Separate style memories for drawing tools vs. text (`f`/`p`/`m`).
	let drawStyle = clampStyleWidth(
		normalizeStyle({ ...DEFAULT_STYLE, color: "#ffffff", ...init.style }),
	);
	let textStyle: StrokeStyle = normalizeTextStyle({
		...init.style,
		width: init.textSizePx ?? init.style?.width,
	});
	let style: StrokeStyle = tool === "text" ? textStyle : drawStyle;
	let format: TextFormat = { ...DEFAULT_FORMAT };
	let selectionId: string | null = null;
	const undoStack: HistoryEntry[] = [];
	let historyIndex = -1;
	let gesture: Gesture | null = null;
	let releasedErasureUndone = false;
	let textEdit: { input: SketchTextEdit; objectId: string | null } | null = null;
	let surfaceBounds: Bounds | null = null;
	let hoverInput: {
		point: { x: number; y: number };
		viewportScale: number;
		tolerance: number;
		handleTolerance: number;
	} | null = null;
	const listeners = new Set<() => void>();
	let batchDepth = 0;
	let batchDirty = false;
	let committedRev = 0;
	let replacementRev = 0;
	let prevReplacementActive = false;
	let snapshot = makeSnapshot();
	const ids = createIdAllocator(doc.objects.map((o) => o.id));

	// -- internal helpers -----------------------------------------------------

	const isReleasedErasure = () =>
		gesture?.kind === "draw" && gesture.erasure?.released === true;

	/** Cancel the active gesture; returns true when something was cancelled. (`J`) */
	function cancelGesture(): boolean {
		if (gesture == null) return false;
		const g = gesture;
		gesture = null;
		releasedErasureUndone = false;
		if (g.kind === "draw") g.erasure?.cancel();
		return true;
	}

	const allocateId = () => ids.allocate();

	/** Adopt `style` into the right tool memory. (`I`) */
	function adoptStyle(
		partial: Partial<StrokeStyle>,
		mode: "text" | "drawing",
	): StrokeStyle {
		if (mode === "text") {
			const next = normalizeTextStyle(partial);
			textStyle = { ...next, width: clampTextSize(next.width) };
			drawStyle = { ...drawStyle, color: next.color };
			return next;
		}
		const next = normalizeStyle(partial);
		drawStyle = clampStyleWidth(next);
		textStyle = { ...textStyle, color: next.color };
		return next;
	}

	const modeFor = (item: SketchItem | null): "text" | "drawing" =>
		item?.kind === "text" || (item == null && tool === "text")
			? "text"
			: "drawing";

	/** Restore `style` to the active tool's remembered style. (`R`) */
	function restoreToolStyle(t: SketchTool = tool) {
		style = t === "text" ? textStyle : drawStyle;
	}

	function selectedItem(): SketchItem | null {
		return selectionId == null
			? null
			: (doc.objects.find((o) => o.id === selectionId) ?? null);
	}

	function isSelectable(item: SketchItem | null | undefined): item is SketchItem {
		return item != null;
	}

	/** Adopt an object's style (+ format for text) on selection. (`ee`) */
	function adoptObjectStyle(item: SketchItem, from?: StrokeStyle) {
		if ("style" in item) {
			style = adoptStyle(from ?? item.style, modeFor(item));
		}
		if (item.kind === "text") format = normalizeFormat(item.format);
	}

	function clearSelectionInternal() {
		selectionId = null;
		restoreToolStyle();
	}

	/** Switch tools, accepting a `ShapeKind` directly as `shapes`. (`Ve` call site) */
	function applyToolSwitch(next: SketchTool | ShapeKind) {
		const asShape = isDrawableShapeTool(next as string);
		const nextTool: SketchTool = asShape ? "shapes" : (next as SketchTool);
		const kindChanged = asShape && shapeKind !== (next as ShapeKind);
		const cancelled = !isReleasedErasure() && cancelGesture();
		if (asShape) shapeKind = next as ShapeKind;
		if (tool === nextTool) {
			if (cancelled || kindChanged) notify();
			return;
		}
		if (nextTool === "text") {
			style = { ...textStyle, color: style.color };
			textStyle = style;
		} else if (nextTool === "select") {
			if (selectionId == null) restoreToolStyle(nextTool);
		} else {
			style = { ...drawStyle, color: style.color };
			drawStyle = style;
		}
		tool = nextTool;
		if (nextTool !== "select") selectionId = null;
		notify();
	}

	function clearTextEditState() {
		textEdit = null;
		if (textSize != null) textSize = clampTextSize(textSize);
		if (selectionId == null && tool === "text") restoreToolStyle();
	}

	function makeSnapshot(): SketchSnapshot {
		const preview = releasedErasureUndone ? null : gesturePreview();
		const hasCommittedReplacement =
			preview != null &&
			preview.replaceObjectId != null &&
			preview.object.kind !== "text" &&
			preview.object.kind !== "eraser" &&
			preview.transformKind != null;
		if (hasCommittedReplacement || prevReplacementActive) {
			replacementRev += 1;
		}
		prevReplacementActive = hasCommittedReplacement;
		return {
			document: doc,
			effectiveDocument: effectiveDoc(),
			committedRev,
			replacementRev,
			hasPendingTextEdit: textEdit != null,
			activeTool: tool,
			shapeKind,
			eraserSizePx: eraserSize,
			drawingWidthPx: drawingWidth ?? null,
			textSizePx: textSize ?? null,
			style,
			textFormat: format,
			selectionId,
			canUndo: !releasedErasureUndone && (gesture != null || historyIndex >= 0),
			canRedo:
				releasedErasureUndone ||
				(gesture == null && historyIndex < undoStack.length - 1),
			hasActiveGesture: gesture != null,
			erasurePreview:
				!releasedErasureUndone && gesture?.kind === "draw"
					? (gesture.erasure ? gesture.erasure.document : null)
					: null,
			preview,
			snapGuides:
				gesture?.kind === "move" ? gesture.snapGuides : EMPTY_SNAP_GUIDES,
			cursor: computeCursor(),
		};
	}

	/** Live preview object for the active gesture. (`Kt`) */
	function gesturePreview(): PreviewInfo | null {
		const g = gesture;
		if (g == null) return null;
		if (g.kind === "move") {
			return {
				object: translateItem(g.originalObject, {
					x: g.current.x - g.start.x,
					y: g.current.y - g.start.y,
				}),
				replaceObjectId: g.objectId,
				transformKind: g.hasPointerMove ? "move" : undefined,
			};
		}
		if (g.kind === "resize") {
			return {
				object: g.hasPointerMove
					? resizeObject(
							g.originalObject,
							g.handle,
							{
								x: g.current.x - g.pointerOffset.x,
								y: g.current.y - g.pointerOffset.y,
							},
							g.surfaceBounds,
							resizeTextObject,
						)
					: g.originalObject,
				replaceObjectId: g.objectId,
				transformKind: g.hasPointerMove ? "resize" : undefined,
			};
		}
		// draw gesture
		if (g.tool === "pen") {
			return {
				object: {
					id: g.id,
					kind: "stroke",
					points:
						g.points.length === 1 && g.strokePressure?.source === "speed"
							? g.points.map((p) => ({ ...p, pressure: 1 }))
							: g.points,
					style: g.style,
				},
				replaceObjectId: null,
				transformKind: undefined,
			};
		}
		if (g.tool === "eraser") {
			return {
				object: {
					id: g.id,
					kind: "eraser",
					points: g.points,
					width: g.style.width,
				},
				replaceObjectId: null,
				transformKind: undefined,
			};
		}
		return shapePreviewObject(g);
	}

	/** Preview/commit object for a shape draw gesture. (`Kt` shape branch) */
	function shapePreviewObject(g: DrawGesture): PreviewInfo | null {
		const kind = g.tool as ShapeKind;
		if (g.surfaceBounds != null) {
			const sb = normalizeBounds(g.surfaceBounds);
			if (g.style.width > sb.width || g.style.width > sb.height) return null;
		}
		const inset = insetBounds(g.surfaceBounds, g.style.width);
		const start = clampPointToBounds(g.start, inset);
		if (kind === "arrow") {
			const rawEnd = clampPointToBounds(
				{
					x: g.current.x + (start.x - g.start.x),
					y: g.current.y + (start.y - g.start.y),
				},
				g.surfaceBounds,
			);
			const end = g.shiftKey
				? constrainEndpoint(start, rawEnd, "arrow", g.surfaceBounds)
				: rawEnd;
			const clamped = clampArrowToSurface(
				{ id: g.id, kind: "arrow", from: start, to: end, style: g.style },
				g.surfaceBounds,
			);
			return clamped == null
				? null
				: { object: clamped, replaceObjectId: null, transformKind: undefined };
		}
		const rawEnd = clampPointToBounds(g.current, inset);
		const end = g.shiftKey
			? constrainEndpoint(start, rawEnd, kind, inset)
			: rawEnd;
		if (kind === "line") {
			return {
				object: { id: g.id, kind: "line", from: start, to: end, style: g.style },
				replaceObjectId: null,
				transformKind: undefined,
			};
		}
		return {
			object: {
				id: g.id,
				kind,
				bounds: shapeBoundsFromTarget({ kind }, boundsFromPoints(start, end)),
				style: g.style,
			},
			replaceObjectId: null,
			transformKind: undefined,
		};
	}


	function notify() {
		if (batchDepth > 0) {
			batchDirty = true;
			return;
		}
		snapshot = makeSnapshot();
		for (const fn of Array.from(listeners)) fn();
	}

	/** Push history entry; identical-group merge. (`ne`) */
	function commitDoc(
		next: SketchDoc,
		select: string | null | undefined = selectionId,
		opts: {
			historyGroup?: string;
			styleBefore?: StrokeStyle;
			apply?: boolean;
		} = {},
	): boolean {
		cancelGesture();
		if (next === doc) {
			notify();
			return false;
		}
		const sel = select ?? null;
		const top = undoStack[historyIndex];
		const group = opts.historyGroup;
		if (
			group != null &&
			historyIndex === undoStack.length - 1 &&
			top?.historyGroup === group
		) {
			undoStack[historyIndex] = {
				...top,
				after: next,
				selectionAfter: sel,
				styleAfter: style,
			};
		} else {
			const entry: HistoryEntry = {
				before: doc,
				after: next,
				selectionBefore: selectionId,
				selectionAfter: sel,
				styleBefore: opts.styleBefore ?? style,
				styleAfter: style,
				historyGroup: group,
			};
			undoStack.length = historyIndex + 1;
			undoStack.push(entry);
			historyIndex += 1;
			if (undoStack.length > MAX_HISTORY_ENTRIES) {
				const overflow = undoStack.length - MAX_HISTORY_ENTRIES;
				undoStack.splice(0, overflow);
				historyIndex -= overflow;
			}
		}
		if (opts.apply === false) {
			historyIndex -= 1;
		} else {
			doc = next;
			selectionId = sel;
			committedRev += 1;
		}
		notify();
		return true;
	}

	/** Replace one object in the document. (`oe`) */
	function updateItem(id: string, fn: (item: SketchItem) => SketchItem): SketchDoc {
		const index = doc.objects.findIndex((o) => o.id === id);
		if (index < 0) return doc;
		const item = doc.objects[index];
		if (item == null) return doc;
		const next = fn(item);
		if (sameItem(item, next)) return doc;
		const objects = [...doc.objects];
		objects[index] = next;
		return { schemaVersion: 1, objects };
	}

	/** Document with the pending text edit folded in. (`Y`) */
	function effectiveDoc(): SketchDoc {
		const edit = textEdit;
		if (edit == null) return doc;
		const previewObject = textEditObject(edit);
		if (edit.input.objectId == null)
			return previewObject == null
				? doc
				: { schemaVersion: 1, objects: [...doc.objects, previewObject] };
		const index = doc.objects.findIndex(
			(o) => o.id === edit.input.objectId && o.kind === "text",
		);
		if (index < 0) return doc;
		if (previewObject == null)
			return {
				schemaVersion: 1,
				objects: doc.objects.filter((_, i) => i !== index),
			};
		const existing = doc.objects[index];
		if (existing == null || sameItem(existing, previewObject)) return doc;
		const objects = [...doc.objects];
		objects[index] = previewObject;
		return { schemaVersion: 1, objects };
	}

	/** Build the text object for a pending edit (null = empty text). (`se`) */
	function textEditObject(
		edit: { input: SketchTextEdit; objectId: string | null },
	): Extract<SketchItem, { kind: "text" }> | null {
		const input = edit.input;
		const existing =
			input.objectId == null
				? null
				: (doc.objects.find(
						(o) => o.id === input.objectId && o.kind === "text",
					) ?? null);
		if (input.objectId != null && existing?.kind !== "text") return null;
		const text = normalizeLineEndings(input.text);
		if (text.length === 0) return null;
		const base = existing?.kind === "text" ? existing : null;
		return normalizeTextObject({
			...(base ?? {}),
			id: edit.objectId ?? input.objectId ?? "",
			kind: "text",
			text,
			bounds: input.bounds,
			style: normalizeTextStyle({ ...(base?.style ?? style), ...input.style }),
			format: normalizeFormat({ ...(base?.format ?? format), ...input.format }),
		} as Extract<SketchItem, { kind: "text" }>);
	}

	const normalizeTextForSurface = (
		item: Extract<SketchItem, { kind: "text" }>,
	) => clampTextToSurface(item, surfaceBounds);

	// -- gestures ---------------------------------------------------------------

	function sampleTimestamp(s: PointerSample): number | null {
		return s.timestamp != null && Number.isFinite(s.timestamp) ? s.timestamp : null;
	}

	function hoverFrom(s: PointerSample) {
		return {
			point: s.point,
			viewportScale: s.viewportScale,
			tolerance: s.tolerance,
			handleTolerance:
				s.handleTolerance ??
				(s.pointerType === "touch"
					? HANDLE_TOLERANCE_TOUCH
					: HANDLE_TOLERANCE_MOUSE),
		};
	}

	/** pointerdown → which gesture to start for select tool. (`Xt`) */
	function hitIntent(input: {
		point: { x: number; y: number };
		tolerance: number;
		handleTolerance: number;
	}):
		| { kind: "move"; object: SketchItem }
		| { kind: "resize"; object: SketchItem; handle: ResizeHandle; pointerOffset: { x: number; y: number } }
		| { kind: "clear" } {
		const selected =
			selectionId == null
				? null
				: (doc.objects.find((o) => o.id === selectionId) ?? null);
		const handle =
			selected == null
				? null
				: pickHandle(selected, input.point, input.handleTolerance, {
						minimumSideHandleSpacing: SIDE_HANDLE_MIN_SPACING,
						minimumCornerHandleSpacing: CORNER_HANDLE_MIN_SPACING,
					});
		if (selected != null && handle != null) {
			const hp = handlePoint(selected, handle);
			return {
				kind: "resize",
				object: selected,
				handle,
				pointerOffset:
					hp == null
						? { x: 0, y: 0 }
						: { x: input.point.x - hp.x, y: input.point.y - hp.y },
			};
		}
		if (selected != null && grabHit(selected, input.point, input.tolerance))
			return { kind: "move", object: selected };
		const hit = hitTestDocument(doc, input.point, input.tolerance);
		return hit == null ? { kind: "clear" } : { kind: "move", object: hit };
	}

	function startMoveGesture(item: SketchItem, s: PointerSample): MoveGesture {
		const snapTol = s.snapTolerance ?? SNAP_TOLERANCE;
		return {
			kind: "move",
			pointerId: s.pointerId,
			objectId: item.id,
			originalObject: item,
			start: s.point,
			current: s.point,
			hasPointerMove: false,
			snapGuides: [],
			initialSnapOffsets: initialSnapOffsets(doc, item, snapTol),
			releasedInitialSnapAxes: { x: false, y: false },
		};
	}

	/** pointerDown (`me`) */
	function pointerDown(s: PointerSample): boolean {
		if (gesture != null) return false;
		hoverInput = hoverFrom(s);
		const surface = s.surfaceBounds ?? surfaceBounds;
		if (tool === "text") return false;
		if (tool !== "select") {
			const scale =
				s.viewportScale != null && Number.isFinite(s.viewportScale) && s.viewportScale > 0
					? s.viewportScale
					: 1;
			const clamped = clampPointToBounds({ ...s.point }, surface == null ? null : normalizeBounds(surface));
			const initP = tool === "pen" ? initialPressure(s) : null;
			const startPoint = tool === "pen" ? withPressure(clamped, initP?.pressure ?? null) : clamped;
			const drawTool: GestureTool = tool === "shapes" ? shapeKind : tool;
			const g: DrawGesture = {
				kind: "draw",
				pointerId: s.pointerId,
				tool: drawTool,
				id: allocateId(),
				start: startPoint,
				points: [startPoint],
				current: startPoint,
				viewportScale: scale,
				style:
					drawTool === "eraser"
						? { ...style, width: eraserSize / scale }
						: drawingWidth == null
							? clampStyleWidth(style)
							: { ...style, width: drawingWidth / scale },
				shiftKey: s.shiftKey === true,
				pointerWasOutside: false,
				latestSampleTimestamp: sampleTimestamp(s),
				surfaceBounds: surface == null ? null : normalizeBounds(surface),
				strokePressure: initP,
				erasure: null,
			};
			gesture = g;
			if (drawTool === "eraser") {
				const base = doc;
				g.erasure = createErasure(base, {
					width: g.style.width,
					viewportScale: scale,
					allocateObjectId: allocateId,
					onPreview() {
						if (gesture === g && g.erasure != null && doc === base) notify();
					},
					onComplete(next) {
						if (gesture !== g || g.erasure == null || doc !== base) return;
						commitDoc(next, null, { apply: !releasedErasureUndone });
						if (isReleasedErasure()) return;
						cancelGesture();
					},
				});
				g.erasure.append(g.points);
			}
			clearSelectionInternal();
			notify();
			return true;
		}
		// select tool
		const intent = hitIntent({
			point: s.point,
			tolerance: s.tolerance,
			handleTolerance: s.handleTolerance,
		});
		if (intent.kind === "resize") {
			gesture = {
				kind: "resize",
				pointerId: s.pointerId,
				objectId: intent.object.id,
				originalObject: intent.object,
				handle: intent.handle,
				current: s.point,
				pointerOffset: intent.pointerOffset,
				hasPointerMove: false,
				surfaceBounds: surface == null ? null : normalizeBounds(surface),
			};
			notify();
			return true;
		}
		if (intent.kind === "move") {
			if (selectionId !== intent.object.id) {
				adoptObjectStyle(intent.object);
				selectionId = intent.object.id;
			}
			gesture = startMoveGesture(intent.object, s);
			notify();
			return true;
		}
		clearSelectionInternal();
		notify();
		return true;
	}

	/** pointerMove (`fe`) */
	function pointerMove(s: PointerSample): boolean {
		hoverInput = hoverFrom(s);
		if (gesture == null) {
			if (computeCursor() !== snapshot.cursor) notify();
			return false;
		}
		const g = gesture;
		if (g.pointerId !== s.pointerId) return false;
		if (
			g.kind !== "draw" &&
			!g.hasPointerMove &&
			dist(g.current, s.point) <= s.tolerance * 0.2
		)
			return true;
		if (g.kind === "draw") {
			if (g.erasure?.released === true) return true;
			const ts = sampleTimestamp(s);
			if (ts != null && g.latestSampleTimestamp != null && ts < g.latestSampleTimestamp)
				return true;
			if (ts != null) g.latestSampleTimestamp = ts;
			const surface = s.surfaceBounds ?? g.surfaceBounds;
			g.surfaceBounds = surface;
			const isPenOrEraser = g.tool === "pen" || g.tool === "eraser";
			if (isPenOrEraser && surface != null && !pointInBounds(surface, s.point)) {
				g.pointerWasOutside = true;
				return true;
			}
			const clamped = clampPointToBounds(
				{ x: s.point.x, y: s.point.y },
				surface == null ? null : normalizeBounds(surface),
			);
			const reentered = isPenOrEraser && g.pointerWasOutside;
			let sample: SketchPoint = { ...clamped };
			if (g.tool === "pen" && g.strokePressure != null) {
				const next = reentered
					? (initialPressure(s) ?? g.strokePressure)
					: nextPressure(g.strokePressure, s, g.style.width * g.viewportScale);
				g.strokePressure = next;
				sample = withPressure(sample, next.pressure);
			}
			g.current = sample;
			g.shiftKey = s.shiftKey === true;
			if (reentered) {
				g.points.push({ ...sample, breakBefore: true });
				g.pointerWasOutside = false;
			} else {
				const last = g.points[g.points.length - 1];
				if (last == null) g.points.push(sample);
				else if (dist(last, sample) >= MIN_SAMPLE_DISTANCE / g.viewportScale) {
					if (
						g.tool === "pen" &&
						g.points.length === 1 &&
						g.strokePressure?.source === "speed"
					)
						g.points[0] = withPressure(last, sample.pressure ?? null);
					g.points.push(sample);
				} else if (
					g.tool === "pen" &&
					sample.pressure != null &&
					sample.pressure !== last.pressure
				)
					g.points[g.points.length - 1] = { ...last, pressure: sample.pressure };
				else if (g.tool === "eraser") return true;
			}
			g.erasure?.append(g.points);
		} else if (g.kind === "move") {
			const surface = s.surfaceBounds ?? surfaceBounds;
			const delta = { x: s.point.x - g.start.x, y: s.point.y - g.start.y };
			g.hasPointerMove = true;
			const snapTol = s.snapTolerance ?? SNAP_TOLERANCE;
			const clampedDelta = clampMoveDelta(
				g.originalObject,
				delta,
				surface == null ? null : normalizeBounds(surface),
			);
			g.releasedInitialSnapAxes = {
				x:
					g.releasedInitialSnapAxes.x ||
					(g.initialSnapOffsets.x != null &&
						Math.abs(clampedDelta.x - g.initialSnapOffsets.x) > snapTol),
				y:
					g.releasedInitialSnapAxes.y ||
					(g.initialSnapOffsets.y != null &&
						Math.abs(clampedDelta.y - g.initialSnapOffsets.y) > snapTol),
			};
			const snapped =
				g.originalObject.kind === "text" && s.altKey !== true
					? snapTextMove({
							doc,
							object: g.originalObject,
							delta: clampedDelta,
							tolerance: snapTol,
							suppressAxes: {
								x:
									g.initialSnapOffsets.x != null &&
									!g.releasedInitialSnapAxes.x,
								y:
									g.initialSnapOffsets.y != null &&
									!g.releasedInitialSnapAxes.y,
							},
						})
					: { delta: clampedDelta, guides: [] };
			const finalDelta = clampMoveDelta(
				g.originalObject,
				snapped.delta,
				surface == null ? null : normalizeBounds(surface),
			);
			g.current = translatePoint(g.start, finalDelta);
			g.snapGuides = filterGuides(snapped.guides, snapped.delta, finalDelta);
		} else {
			g.current = s.point;
			g.hasPointerMove = true;
			g.surfaceBounds = s.surfaceBounds ?? g.surfaceBounds;
		}
		notify();
		return true;
	}

	/** Commit the active gesture. (`de`) */
	function commitGesture(): boolean {
		const g = gesture;
		if (g == null) return false;
		if (g.kind === "draw" && g.erasure != null) {
			if (!g.erasure.released) {
				g.erasure.finish();
				notify();
			}
			return true;
		}
		if (g.kind === "resize" && !g.hasPointerMove) {
			cancelGesture();
			notify();
			return true;
		}
		const preview = gesturePreview();
		if (preview == null) {
			cancelGesture();
			notify();
			return true;
		}
		if (g.kind === "draw") {
			const obj = preview.object;
			if (obj.kind === "eraser") {
				cancelGesture();
				notify();
				return true;
			}
			if (isDrawableShapeTool(g.tool) && !meetsMinSize(obj, SHAPE_MIN_SIZE / g.viewportScale)) {
				cancelGesture();
				notify();
				return true;
			}
			// The shape tool stays armed so shapes can be drawn back-to-back
			// with the same kind. The real editor switches to `select` and
			// selects the new object here; this app deliberately keeps
			// stamping until the user picks another tool.
			const styleBefore = style;
			if (isDrawableShapeTool(g.tool)) adoptObjectStyle(obj);
			return commitDoc(
				{ schemaVersion: 1, objects: [...doc.objects, obj] },
				null,
				{ styleBefore },
			);
		}
		// move/resize commit: replace the object.
		const next = updateItem(g.objectId, () => preview.object as SketchItem);
		const styleBefore = style;
		if ("style" in preview.object) style = adoptStyle(preview.object.style as StrokeStyle, modeFor(preview.object as SketchItem));
		return commitDoc(next, g.objectId, { styleBefore });
	}

	function pointerUp(s: PointerSample): boolean {
		if (gesture == null || gesture.pointerId !== s.pointerId) return false;
		const g = gesture;
		let feedMove = true;
		if (
			(g.kind === "move" || g.kind === "resize") &&
			(g.hasPointerMove || dist(g.current, s.point) <= s.tolerance * 0.2)
		)
			feedMove = false;
		if (feedMove) pointerMove(s);
		return commitGesture();
	}

	// -- cursor (`Zt`/`Qt`) ------------------------------------------------------

	function cursorForHandle(handle: ResizeHandle): string {
		switch (handle) {
			case "n":
			case "s":
				return "ns-resize";
			case "e":
			case "w":
				return "ew-resize";
			case "ne":
			case "sw":
				return "nesw-resize";
			case "nw":
			case "se":
				return "nwse-resize";
			case "start":
			case "end":
				return "crosshair";
		}
	}

	function computeCursor(): string {
		const g = gesture;
		if (g?.kind === "move") return "grabbing";
		if (g?.kind === "resize")
			return cursorForHandle(
				effectiveHandle(g.originalObject, g.handle, {
					x: g.current.x - g.pointerOffset.x,
					y: g.current.y - g.pointerOffset.y,
				}),
			);
		if (g?.kind === "draw") return g.tool === "eraser" ? "cell" : "crosshair";
		if (tool !== "select")
			return tool === "text" ? "text" : tool === "eraser" ? "cell" : "crosshair";
		if (hoverInput == null) return "default";
		const intent = hitIntent({
			point: hoverInput.point,
			tolerance: hoverInput.tolerance,
			handleTolerance: hoverInput.handleTolerance,
		});
		return intent.kind === "resize"
			? cursorForHandle(intent.handle)
			: intent.kind === "move"
				? "grab"
				: "default";
	}

	// -- public API ---------------------------------------------------------------

	return {
		getSnapshot() {
			return snapshot;
		},
		subscribe(fn) {
			listeners.add(fn);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				listeners.delete(fn);
			};
		},
		setTool(next) {
			applyToolSwitch(next);
		},
		setShapeKind(kind) {
			applyToolSwitch(kind);
		},
		setEraserSize(px) {
			const next = clampEraserSize(px);
			if (next !== eraserSize) {
				eraserSize = next;
				notify();
			}
		},
		setDrawingWidth(px) {
			const next = clampDrawingWidth(px);
			if (next !== drawingWidth) {
				drawingWidth = next;
				notify();
			}
		},
		setTextSize(px) {
			const next =
				textEdit == null
					? clampTextSize(px)
					: normalizeFontSize(px);
			if (next !== textSize) {
				textSize = next;
				notify();
			}
		},
		setStyle(partial, opts = {}) {
			const selId = selectionId;
			const sel = selectedItem();
			const mode = modeFor(sel);
			const merged = {
				...style,
				...partial,
				...(sel?.kind === "ink" ? { width: style.width } : {}),
			};
			const normalized =
				mode === "text"
					? normalizeTextStyle({
							...merged,
							...(textSize == null && sel == null && textEdit == null && partial.width != null
								? { width: clampTextSize(merged.width) }
								: {}),
						})
					: normalizeStyle(merged);
			const fitted =
				sel?.kind === "text"
					? fitTextStyle(sel, normalized, surfaceBounds)
					: sel == null
						? normalized
						: fitShapeWidth(sel, normalized, surfaceBounds);
			if (fitted.color === style.color && fitted.width === style.width) return;
			const before = style;
			style = adoptStyle(fitted, mode);
			if (sel == null && mode === "drawing") style = drawStyle;
			if (selId != null && sel != null && "style" in sel) {
				commitDoc(
					updateItem(selId, (o) =>
						"style" in o
							? o.kind === "text"
								? normalizeTextForSurface({ ...o, style } as Extract<SketchItem, { kind: "text" }>)
								: { ...o, style }
							: o,
					),
					selectionId,
					{ historyGroup: opts.historyGroup, styleBefore: before },
				);
				return;
			}
			notify();
		},
		setTextFormat(partial, opts = {}) {
			const next = normalizeFormat({ ...format, ...partial });
			if (sameFormat(next, format)) return;
			format = next;
			const sel = selectedItem();
			if (sel?.kind !== "text") {
				notify();
				return;
			}
			const before = style;
			const relaid = normalizeTextObject({ ...sel, format });
			const fittedStyle = fitTextStyle(relaid, relaid.style, surfaceBounds);
			const finalObj = normalizeTextForSurface({ ...relaid, style: fittedStyle });
			const nextDoc = updateItem(sel.id, (o) => (o.kind === "text" ? finalObj : o));
			style = adoptStyle(finalObj.style, "text");
			commitDoc(nextDoc, sel.id, {
				historyGroup: opts.historyGroup,
				styleBefore: before,
			});
		},
		undo() {
			if (isReleasedErasure()) {
				if (releasedErasureUndone) return false;
				releasedErasureUndone = true;
				notify();
				return true;
			}
			if (cancelGesture()) {
				notify();
				return true;
			}
			const entry = undoStack[historyIndex];
			if (entry == null) return false;
			applyHistory(entry, "before");
			historyIndex -= 1;
			notify();
			return true;
		},
		redo() {
			if (isReleasedErasure()) {
				if (!releasedErasureUndone) return false;
				releasedErasureUndone = false;
				notify();
				return true;
			}
			const cancelled = cancelGesture();
			const entry = undoStack[historyIndex + 1];
			if (entry == null) {
				if (cancelled) notify();
				return false;
			}
			applyHistory(entry, "after");
			historyIndex += 1;
			notify();
			return true;
		},
		clear() {
			if (doc.objects.length === 0 && textEdit == null && gesture == null)
				return false;
			const before = style;
			cancelGesture();
			clearTextEditState();
			restoreToolStyle();
			if (doc.objects.length === 0) {
				selectionId = null;
				notify();
				return true;
			}
			return commitDoc(emptyDoc(), null, { styleBefore: before });
		},
		selectObject(id) {
			const item = doc.objects.find((o) => o.id === id);
			if (!isSelectable(item) || isReleasedErasure()) return false;
			cancelGesture();
			adoptObjectStyle(item);
			selectionId = item.id;
			notify();
			return true;
		},
		clearSelection() {
			if (selectionId != null) {
				clearSelectionInternal();
				notify();
			}
		},
		deleteSelection() {
			if (selectionId == null) return false;
			const objects = doc.objects.filter((o) => o.id !== selectionId);
			if (objects.length === doc.objects.length) {
				clearSelectionInternal();
				notify();
				return false;
			}
			const before = style;
			restoreToolStyle();
			return commitDoc({ schemaVersion: 1, objects }, null, { styleBefore: before });
		},
		deleteObject(id) {
			const objects = doc.objects.filter((o) => o.id !== id);
			if (objects.length === doc.objects.length) return false;
			const wasSelected = selectionId === id;
			const before = style;
			if (wasSelected) restoreToolStyle();
			return commitDoc({ schemaVersion: 1, objects }, wasSelected ? null : selectionId, {
				styleBefore: before,
			});
		},
		nudgeSelection(delta, opts = {}) {
			const item = selectedItem();
			if (!isSelectable(item)) return false;
			return commitDoc(
				updateItem(item.id, (o) =>
					translateItem(o, clampMoveDelta(o, delta, surfaceBounds)),
				),
				item.id,
				{ historyGroup: opts.historyGroup },
			);
		},
		pointerDown,
		pointerMove,
		pointerMoves(samples) {
			let handled = false;
			batchDepth += 1;
			try {
				for (const s of samples) handled = pointerMove(s) || handled;
			} finally {
				batchDepth -= 1;
				if (batchDepth === 0 && batchDirty) {
					batchDirty = false;
					notify();
				}
			}
			return handled;
		},
		pointerUp,
		pointerCommit(pointerId) {
			if (gesture == null || (pointerId != null && gesture.pointerId !== pointerId))
				return false;
			return commitGesture();
		},
		pointerCancel(pointerId, opts = {}) {
			if (
				gesture == null ||
				(pointerId != null && gesture.pointerId !== pointerId) ||
				(opts.preserveReleasedErasure === true && isReleasedErasure())
			)
				return false;
			cancelGesture();
			notify();
			return true;
		},
		pointerLeave() {
			hoverInput = null;
			if (computeCursor() !== snapshot.cursor) notify();
		},
		getObjectAtPoint(point, tolerance = HIT_TOLERANCE) {
			const intent = hitIntent({
				point,
				tolerance,
				handleTolerance: tolerance,
			});
			return intent.kind === "clear" ? null : intent.object;
		},
		pasteObject(item, opts = {}) {
			if (isReleasedErasure()) return null;
			cancelGesture();
			const cloned = cloneItem(item, allocateId());
			const moved = translateItem(
				cloned,
				clampPasteOffset(cloned, opts.offset ?? { x: PASTE_OFFSET, y: PASTE_OFFSET }, surfaceBounds),
			);
			const final = moved.kind === "text" ? normalizeTextForSurface(moved) : moved;
			const before = style;
			if (isSelectable(final)) adoptObjectStyle(final);
			if (tool !== "select") tool = "select";
			return commitDoc({ schemaVersion: 1, objects: [...doc.objects, final] }, final.id, {
				styleBefore: before,
			})
				? final.id
				: null;
		},
		setSurfaceBounds(bounds) {
			const next = bounds == null ? null : normalizeBounds(bounds);
			const changed = !boundsEqual(surfaceBounds, next);
			if (changed) surfaceBounds = next;
			if ((changed && textEdit != null) || (changed && gesture != null)) notify();
		},
		setPendingTextEdit(input) {
			if (input == null) {
				if (textEdit == null) return;
				cancelGesture();
				clearTextEditState();
				notify();
				return;
			}
			const fontSize = normalizeFontSize(
				input.style?.width ?? (textSize ?? style.width),
			);
			const bounds =
				input.bounds != null
					? normalizeBounds(input.bounds)
					: defaultTextBounds(
							input.point ?? { x: 0, y: 0 },
							surfaceBounds ?? { x: 0, y: 0, width: 480, height: 320 },
							fontSize,
						);
			const normalizedInput: SketchTextEdit = {
				...input,
				objectId: input.objectId ?? null,
				text: normalizeLineEndings(input.text),
				bounds,
				style: input.style == null ? undefined : { ...input.style },
				format: input.format == null ? undefined : { ...input.format },
			};
			const editId =
				normalizedInput.objectId ??
				(textEdit != null && textEdit.input.objectId == null
					? textEdit.objectId
					: null) ??
				allocateId();
			const nextEdit = { input: normalizedInput, objectId: editId };
			if (
				textEdit != null &&
				textEdit.objectId === nextEdit.objectId &&
				JSON.stringify(textEdit.input) === JSON.stringify(nextEdit.input)
			)
				return;
			cancelGesture();
			textEdit = nextEdit;
			notify();
		},
		commitPendingTextEdit() {
			if (textEdit == null) return false;
			const next = effectiveDoc();
			const obj = textEditObject(textEdit);
			const wasExisting = textEdit.input.objectId != null;
			const wasSelected = obj == null && wasExisting && selectionId === textEdit.input.objectId;
			const before = style;
			clearTextEditState();
			cancelGesture();
			tool = "select";
			if (obj == null) {
				if (wasSelected) restoreToolStyle();
			} else {
				adoptObjectStyle(obj);
			}
			const sel = obj?.id ?? (wasSelected ? null : selectionId);
			if (next === doc) {
				selectionId = sel;
				notify();
				return false;
			}
			return commitDoc(next, sel ?? null, { styleBefore: before });
		},
		discardPendingTextEdit() {
			if (textEdit == null) return false;
			cancelGesture();
			clearTextEditState();
			notify();
			return true;
		},
		insertTextBox(input) {
			const text = normalizeLineEndings(input.text);
			if (text.length === 0) return null;
			const obj = normalizeTextForSurface({
				id: allocateId(),
				kind: "text",
				text,
				bounds: input.bounds,
				style: normalizeTextStyle({ ...style, ...input.style }),
				format: normalizeFormat({ ...format, ...input.format }),
			});
			style = adoptStyle(obj.style, "text");
			format = obj.format;
			if (tool !== "select") tool = "select";
			return commitDoc({ schemaVersion: 1, objects: [...doc.objects, obj] }, obj.id)
				? obj.id
				: null;
		},
		updateTextBox(id, patch, opts = {}) {
			return commitDoc(
				updateItem(id, (o) =>
					o.kind === "text"
						? normalizeTextForSurface({
								...o,
								text: patch.text == null ? o.text : normalizeLineEndings(patch.text),
								bounds: patch.bounds ?? o.bounds,
							})
						: o,
				),
				id,
				{ historyGroup: opts.historyGroup },
			);
		},
		export(opts = {}) {
			if (gesture != null) return Promise.resolve({ kind: "busy" });
			return exportPng(effectiveDoc(), opts)
				.then((result) => result)
				.catch((): SketchExportResult => ({ kind: "unavailable" }));
		},
		replaceDocument(next) {
			cancelGesture();
			clearTextEditState();
			doc = next;
			committedRev += 1;
			ids.reserve(next.objects.map((o) => o.id));
			clearSelectionInternal();
			undoStack.length = 0;
			historyIndex = -1;
			notify();
		},
	};

	// ------------------------------------------------------------------

	/** Apply a history entry direction. (`re`) */
	function applyHistory(entry: HistoryEntry, dir: "before" | "after") {
		doc = entry[dir];
		committedRev += 1;
		if (tool !== "select") {
			clearSelectionInternal();
			return;
		}
		selectionId = dir === "before" ? entry.selectionBefore : entry.selectionAfter;
		const item = selectedItem();
		if (!isSelectable(item)) {
			clearSelectionInternal();
			return;
		}
		adoptObjectStyle(item, dir === "before" ? entry.styleBefore : entry.styleAfter);
	}

}

import { ChevronLeft, ChevronRight, ImageOff, RotateCcw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { rubberBand, VelocityTracker } from "./gesturePhysics";
import { prefersReducedMotion } from "./motion";
import { useOverlay, usePresence } from "./overlay";
export interface ViewerImage {
	src: string;
	alt?: string;
}

interface ViewerState {
	gallery: ViewerImage[];
	index: number;
}

let current: ViewerState | null = null;
const listeners = new Set<() => void>();

function setCurrent(next: ViewerState | null): void {
	current = next;
	for (const l of listeners) l();
}
function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function openImage(
	image: string | ViewerImage,
	gallery?: readonly ViewerImage[],
	index?: number,
): void {
	const primary: ViewerImage = typeof image === "string" ? { src: image } : image;
	const items = gallery && gallery.length > 0 ? [...gallery] : [primary];
	let startIndex = 0;
	if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < items.length) {
		startIndex = index;
	} else if (gallery && gallery.length > 0) {
		const found = items.findIndex((item) => item.src === primary.src);
		startIndex = found >= 0 ? found : 0;
	}
	setCurrent({ gallery: items, index: startIndex });
}

function setViewerIndex(next: number): void {
	if (!current) return;
	const index = Math.max(0, Math.min(next, current.gallery.length - 1));
	if (index === current.index) return;
	setCurrent({ ...current, index });
}
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const TAP_SCALE = 2.5;
const TAP_MOVE_PX = 8;
const DOUBLE_TAP_MS = 300;

interface Gesture {
	scale: number;
	x: number;
	y: number;
	pointers: Map<number, { x: number; y: number }>;
	prevMid: { x: number; y: number } | null;
	prevDist: number;
	moved: number;
	downAt: number;
	startX: number;
	startY: number;
	startScale: number;
	multiTouch: boolean;
	axis: "x" | "y" | null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function ImageViewerHost() {
	const state = useSyncExternalStore(subscribe, () => current, () => current);
	const open = state !== null;
	const [chromeVisible, setChromeVisible] = useState(true);
	const [failed, setFailed] = useState(false);
	const [retryKey, setRetryKey] = useState(0);
	const tapTimer = useRef<number | undefined>(undefined);
	const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
	const clearTap = () => {
		window.clearTimeout(tapTimer.current);
		tapTimer.current = undefined;
		lastTap.current = null;
	};
	const close = () => {
		clearTap();
		setCurrent(null);
	};
	const { mounted, visible } = usePresence(open, 200);
	const isTopModal = useOverlay(open, close);
	// Keep the last gallery mounted while the exit transition plays.
	const lastRef = useRef<ViewerState | null>(null);
	if (state) lastRef.current = state;
	const active = state ?? lastRef.current;
	const count = active?.gallery.length ?? 0;
	const activeIndex = active ? clamp(active.index, 0, Math.max(0, count - 1)) : 0;
	const shown = active?.gallery[activeIndex] ?? null;

	const portalRef = useRef<HTMLDivElement>(null);
	const scrimRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const trackerRef = useRef(new VelocityTracker());
	const prevOpen = useRef(open);
	const g = useRef<Gesture>({
		scale: 1,
		x: 0,
		y: 0,
		pointers: new Map(),
		prevMid: null,
		prevDist: 0,
		moved: 0,
		downAt: 0,
		startX: 0,
		startY: 0,
		startScale: 1,
		multiTouch: false,
		axis: null,
	});

	const apply = (animate: boolean) => {
		const img = imgRef.current;
		if (!img) return;
		const s = g.current;
		img.style.transition = animate && !prefersReducedMotion() ? "transform 200ms var(--m-ease)" : "none";
		const dismissScale = s.scale === 1 && s.axis === "y" && s.y > 0 ? Math.max(0.86, 1 - s.y / 1400) : s.scale;
		img.style.transform = `translate3d(${s.x}px,${s.y}px,0) scale(${dismissScale})`;
	};

	const src = state?.gallery[activeIndex]?.src;
	useEffect(() => {
		if (!mounted) {
			clearTap();
			setChromeVisible(true);
			setFailed(false);
			setRetryKey(0);
			lastRef.current = null;
			const s = g.current;
			s.scale = 1;
			s.x = 0;
			s.y = 0;
			s.axis = null;
			s.pointers.clear();
			s.prevMid = null;
			s.multiTouch = false;
			trackerRef.current.reset();
			prevOpen.current = false;
			return;
		}
		const opening = open && !prevOpen.current;
		prevOpen.current = open;
		if (!open) return;
		if (opening) setChromeVisible(true);
		clearTap();
		setFailed(!src);
		setRetryKey(0);
		const s = g.current;
		s.scale = 1;
		s.x = 0;
		s.y = 0;
		s.axis = null;
		s.pointers.clear();
		s.prevMid = null;
		s.multiTouch = false;
		trackerRef.current.reset();
		if (scrimRef.current) {
			scrimRef.current.style.transition = "";
			scrimRef.current.style.opacity = "";
		}
		apply(false);
	}, [src, activeIndex, open, mounted]);

	useEffect(() => {
		if (!open || count <= 1) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowLeft") setViewerIndex(activeIndex - 1);
			else if (e.key === "ArrowRight") setViewerIndex(activeIndex + 1);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, count, activeIndex]);

	useEffect(() => () => window.clearTimeout(tapTimer.current), []);
	const exiting = mounted && !open;
	useLayoutEffect(() => {
		const el = portalRef.current;
		if (!el) return;
		el.inert = exiting;
		if (exiting) el.setAttribute("inert", "");
		else el.removeAttribute("inert");
	}, [exiting, mounted]);

	if (!mounted || !shown) return null;
	const center = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

	/** Re-anchors so the content point that was under `from` ends up under `to`, scaling by `ratio`. */
	const transform = (from: { x: number; y: number }, to: { x: number; y: number }, ratio: number) => {
		const s = g.current;
		const c = center();
		const next = clamp(s.scale * ratio, MIN_SCALE, MAX_SCALE);
		const r = next / s.scale;
		let x = to.x - c.x - r * (from.x - c.x - s.x);
		let y = to.y - c.y - r * (from.y - c.y - s.y);
		const maxX = ((next - 1) * window.innerWidth) / 2;
		const maxY = ((next - 1) * window.innerHeight) / 2;
		x = clamp(x, -maxX, maxX);
		y = clamp(y, -maxY, maxY);
		s.scale = next;
		s.x = next === 1 ? 0 : x;
		s.y = next === 1 ? 0 : y;
	};

	const midOf = (s: Gesture) => {
		const points = s.pointers.values();
		const a = points.next().value;
		const b = points.next().value;
		if (!a) return { mid: { x: 0, y: 0 }, dist: 0 };
		if (!b) return { mid: { x: a.x, y: a.y }, dist: 0 };
		return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
	};

	const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		const target = e.target as Element;
		if (!open || e.button !== 0 || target.closest("button") || target.closest("[data-viewer-strip]")) return;
		const s = g.current;
		e.currentTarget.setPointerCapture(e.pointerId);
		s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (s.pointers.size === 1) {
			s.moved = 0;
			s.downAt = e.timeStamp;
			s.startX = e.clientX;
			s.startY = e.clientY;
			s.startScale = s.scale;
			s.multiTouch = false;
			s.axis = null;
			trackerRef.current.reset();
			trackerRef.current.add(e.clientX, e.clientY, e.timeStamp);
		} else {
			s.multiTouch = true;
			s.axis = null;
			clearTap();
			s.moved = TAP_MOVE_PX + 1;
		}
		const m = midOf(s);
		s.prevMid = m.mid;
		s.prevDist = m.dist;
	};

	const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const s = g.current;
		const p = s.pointers.get(e.pointerId);
		if (!p || !s.prevMid) return;
		s.moved += Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y);
		if (s.moved > TAP_MOVE_PX) clearTap();
		p.x = e.clientX;
		p.y = e.clientY;
		const m = midOf(s);
		const ratio = s.pointers.size >= 2 && s.prevDist > 0 ? m.dist / s.prevDist : 1;
		if (s.scale === 1 && ratio === 1 && s.pointers.size === 1 && !s.multiTouch) {
			const dx = e.clientX - s.startX;
			const dy = e.clientY - s.startY;
			if (s.axis === null && Math.hypot(dx, dy) > TAP_MOVE_PX) {
				s.axis = count > 1 && Math.abs(dx) > Math.abs(dy) * 1.25 ? "x" : "y";
			}
			trackerRef.current.add(e.clientX, e.clientY, e.timeStamp);
			if (s.axis === "y") {
				const effY = dy >= 0 ? dy : rubberBand(dy, 180, 0.3);
				s.x = 0;
				s.y = effY;
				apply(false);
				if (scrimRef.current) {
					scrimRef.current.style.transition = "none";
					scrimRef.current.style.opacity = String(Math.max(0.15, 1 - Math.max(0, effY) / 360));
				}
			} else if (s.axis === "x") {
				const atStart = activeIndex === 0 && dx > 0;
				const atEnd = activeIndex === count - 1 && dx < 0;
				const effX = atStart || atEnd ? rubberBand(dx, 240, 0.45) : dx;
				s.x = effX;
				s.y = 0;
				apply(false);
			}
			s.prevMid = m.mid;
			s.prevDist = m.dist;
			return;
		}
		transform(s.prevMid, m.mid, ratio);
		s.prevMid = m.mid;
		s.prevDist = m.dist;
		apply(false);
	};

	const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		const s = g.current;
		if (!s.pointers.delete(e.pointerId)) return;
		const cancelled = e.type === "pointercancel" || e.type === "lostpointercapture";
		const dx = e.clientX - s.startX;
		const dy = e.clientY - s.startY;
		const wasTap = !cancelled && !s.multiTouch && s.moved <= TAP_MOVE_PX
			&& Math.hypot(dx, dy) <= TAP_MOVE_PX && e.timeStamp - s.downAt < 400 && s.pointers.size === 0;
		const m = midOf(s);
		s.prevMid = s.pointers.size > 0 ? m.mid : null;
		s.prevDist = m.dist;
		const { vx, vy } = trackerRef.current.velocity(e.timeStamp);
		if (s.pointers.size === 0) trackerRef.current.reset();
		if (!wasTap) {
			clearTap();
			if (s.pointers.size === 0 && s.startScale === 1 && s.scale === 1) {
				if (scrimRef.current) {
					scrimRef.current.style.transition = "";
					scrimRef.current.style.opacity = "";
				}
				if (!cancelled && !s.multiTouch && s.axis === "y" && (s.y > 100 || vy > 0.55)) {
					close();
					return;
				}
				if (!cancelled && !s.multiTouch && s.axis === "x" && count > 1) {
					if ((s.x < -50 || vx < -0.45) && activeIndex < count - 1) {
						setViewerIndex(activeIndex + 1);
						return;
					}
					if ((s.x > 50 || vx > 0.45) && activeIndex > 0) {
						setViewerIndex(activeIndex - 1);
						return;
					}
				}
				if (s.axis !== null) {
					s.x = 0;
					s.y = 0;
					s.axis = null;
					apply(true);
				}
			}
			return;
		}
		const previous = lastTap.current;
		if (previous && e.timeStamp - previous.at <= DOUBLE_TAP_MS
			&& Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= 32) {
			clearTap();
			const point = { x: e.clientX, y: e.clientY };
			if (s.scale > 1) transform(center(), center(), MIN_SCALE / s.scale);
			else transform(point, point, TAP_SCALE);
			apply(true);
			return;
		}
		if (previous) setChromeVisible((value) => !value);
		clearTap();
		lastTap.current = { at: e.timeStamp, x: e.clientX, y: e.clientY };
		tapTimer.current = window.setTimeout(() => {
			lastTap.current = null;
			tapTimer.current = undefined;
			setChromeVisible((value) => !value);
		}, DOUBLE_TAP_MS);
	};

	return createPortal(
		<div
			ref={portalRef}
			role="dialog"
			aria-modal={open && isTopModal ? "true" : undefined}
			aria-hidden={!open || undefined}
			aria-label={shown.alt ?? "图片预览"}
			className={`fixed inset-0 z-(--z-modal) flex touch-none select-none items-center justify-center transition-opacity duration-200 ease-m motion-reduce:duration-150 ${
				visible ? "opacity-100" : "opacity-0"
			} ${open ? "" : "pointer-events-none"}`}
			onPointerDown={onDown}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={onUp}
			onLostPointerCapture={onUp}
		>
			<div
				ref={scrimRef}
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 bg-m-scrim transition-opacity duration-200 ease-m"
			/>
			<div className="relative z-1 flex h-full w-full items-center justify-center">
			{failed ? (
				<div className="flex flex-col items-center gap-3 rounded-m-lg border border-m-border bg-m-bg-elev px-6 py-5 text-center shadow-m-pop">
					<ImageOff size={28} className="text-m-text-3" aria-hidden />
					<span className="text-m-sm font-medium text-m-text">图片加载失败</span>
					<button
						type="button"
						onClick={() => {
							setFailed(false);
							setRetryKey((k) => k + 1);
						}}
						className="inline-flex min-h-9 items-center gap-1.5 rounded-m-pill bg-m-surface px-4 text-m-xs font-medium whitespace-nowrap text-m-text ring-1 ring-m-border active:scale-95"
					>
						<RotateCcw size={13} aria-hidden />
						<span>重试</span>
					</button>
				</div>
			) : (
				<img
					key={`${shown.src}-${retryKey}`}
					ref={imgRef}
					src={shown.src}
					alt={shown.alt ?? ""}
					draggable={false}
					onLoad={() => setFailed(false)}
					onError={() => setFailed(true)}
					className="max-h-full max-w-full object-contain will-change-transform"
				/>
			)}
			</div>
			{chromeVisible && (
				<>
					<div
						className="pointer-events-none absolute inset-x-0 z-2 flex items-center justify-between px-3"
						style={{ top: "calc(var(--m-safe-top) + 8px)" }}
					>
						{count > 1 ? (
							<span className="pointer-events-auto rounded-m-pill bg-m-bg-elev/90 px-3 py-1 font-m-mono text-m-xs font-medium whitespace-nowrap text-m-text ring-1 ring-m-border">
								{activeIndex + 1} / {count}
							</span>
						) : (
							<span />
						)}
						<button
							type="button"
							aria-label="关闭"
							onClick={close}
							className="pointer-events-auto flex min-h-11 min-w-11 items-center justify-center rounded-m-pill bg-m-bg-elev/90 text-m-text ring-1 ring-m-border active:scale-95"
						>
							<X size={22} />
						</button>
					</div>
					{count > 1 && (
						<>
							<button
								type="button"
								aria-label="上一张"
								disabled={activeIndex === 0}
								onClick={() => setViewerIndex(activeIndex - 1)}
								className="absolute top-1/2 left-2 z-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-m-pill bg-m-bg-elev/85 text-m-text ring-1 ring-m-border transition-[opacity,transform,scale] duration-(--m-dur-press) ease-m active:scale-95 disabled:opacity-35"
							>
								<ChevronLeft size={20} />
							</button>
							<button
								type="button"
								aria-label="下一张"
								disabled={activeIndex === count - 1}
								onClick={() => setViewerIndex(activeIndex + 1)}
								className="absolute top-1/2 right-2 z-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-m-pill bg-m-bg-elev/85 text-m-text ring-1 ring-m-border transition-[opacity,transform,scale] duration-(--m-dur-press) ease-m active:scale-95 disabled:opacity-35"
							>
								<ChevronRight size={20} />
							</button>
							<div
								data-viewer-strip
								className="m-noscrollbar absolute left-1/2 z-2 flex max-w-[calc(100vw-32px)] -translate-x-1/2 touch-pan-x items-center gap-1.5 overflow-x-auto rounded-m-lg border border-m-border bg-m-bg-elev/90 p-1.5 shadow-m-pop"
								style={{ bottom: "calc(var(--m-safe-bottom) + 12px)" }}
							>
								{active?.gallery.map((item, i) => (
									<button
										key={`${i}-${item.src}`}
										type="button"
										aria-label={`切换到第 ${i + 1} 张`}
										aria-current={i === activeIndex ? "true" : undefined}
										onClick={() => setViewerIndex(i)}
										className={`h-10 w-10 shrink-0 overflow-hidden rounded-m-sm border transition-[border-color,opacity,box-shadow,transform,scale] duration-(--m-dur-press) ease-m active:scale-95 ${
											i === activeIndex
												? "border-m-accent opacity-100 ring-2 ring-m-accent"
												: "border-m-border opacity-60 hover:opacity-90"
										}`}
									>
										<img src={item.src} alt="" className="h-full w-full object-cover" />
									</button>
								))}
							</div>
						</>
					)}
				</>
			)}
		</div>,
		document.body,
	);
}

import { ChevronLeft, ChevronRight, ImageOff, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
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

	const imgRef = useRef<HTMLImageElement>(null);
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
	});

	const apply = (animate: boolean) => {
		const img = imgRef.current;
		if (!img) return;
		const s = g.current;
		img.style.transition = animate ? "transform 200ms var(--m-ease)" : "none";
		img.style.transform = `translate3d(${s.x}px,${s.y}px,0) scale(${s.scale})`;
	};

	const src = state?.gallery[activeIndex]?.src;
	useEffect(() => {
		clearTap();
		setChromeVisible(true);
		setFailed(open && !src);
		setRetryKey(0);
		const s = g.current;
		s.scale = 1;
		s.x = 0;
		s.y = 0;
		s.pointers.clear();
		s.prevMid = null;
		s.multiTouch = false;
		apply(false);
	}, [src, activeIndex, open]);

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
		} else {
			s.multiTouch = true;
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
		if (s.scale === 1 && ratio === 1) {
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
		if (!wasTap) {
			clearTap();
			if (!cancelled && !s.multiTouch && s.pointers.size === 0 && s.startScale === 1 && s.scale === 1) {
				if (dy > 100 && dy > Math.abs(dx) * 1.5) {
					close();
					return;
				}
				if (count > 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
					if (dx < 0 && activeIndex < count - 1) setViewerIndex(activeIndex + 1);
					else if (dx > 0 && activeIndex > 0) setViewerIndex(activeIndex - 1);
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
			role="dialog"
			aria-modal={isTopModal ? "true" : undefined}
			aria-label={shown.alt ?? "图片预览"}
			className={`fixed inset-0 z-(--z-modal) flex touch-none select-none items-center justify-center bg-m-scrim transition-opacity duration-200 ease-(--m-ease) ${visible ? "opacity-100" : "opacity-0"}`}
			onPointerDown={onDown}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={onUp}
			onLostPointerCapture={onUp}
		>
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
			{chromeVisible && (
				<>
					<div
						className="pointer-events-none absolute inset-x-0 flex items-center justify-between px-3"
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
								className="absolute top-1/2 left-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-m-pill bg-m-bg-elev/85 text-m-text ring-1 ring-m-border transition-[opacity,transform] duration-(--m-dur-press) ease-m active:scale-95 disabled:opacity-35"
							>
								<ChevronLeft size={20} />
							</button>
							<button
								type="button"
								aria-label="下一张"
								disabled={activeIndex === count - 1}
								onClick={() => setViewerIndex(activeIndex + 1)}
								className="absolute top-1/2 right-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-m-pill bg-m-bg-elev/85 text-m-text ring-1 ring-m-border transition-[opacity,transform] duration-(--m-dur-press) ease-m active:scale-95 disabled:opacity-35"
							>
								<ChevronRight size={20} />
							</button>
							<div
								data-viewer-strip
								className="m-noscrollbar absolute left-1/2 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-m-lg border border-m-border bg-m-bg-elev/90 p-1.5 shadow-m-pop"
								style={{ bottom: "calc(var(--m-safe-bottom) + 12px)" }}
							>
								{active?.gallery.map((item, i) => (
									<button
										key={`${i}-${item.src}`}
										type="button"
										aria-label={`切换到第 ${i + 1} 张`}
										aria-current={i === activeIndex ? "true" : undefined}
										onClick={() => setViewerIndex(i)}
										className={`h-10 w-10 shrink-0 overflow-hidden rounded-m-sm border transition-[border-color,opacity,box-shadow,transform] duration-(--m-dur-press) ease-m active:scale-95 ${
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

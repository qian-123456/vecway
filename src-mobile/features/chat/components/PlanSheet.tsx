import {
	Check,
	ChevronDown,
	ClipboardList,
	Copy,
	GitCompareArrows,
	List,
	Maximize2,
	Minimize2,
	PanelBottomClose,
	X,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { copyText } from "../../../core/lib/format";
import { Button, Chip, Spinner, toast, type ChipTone } from "../../../ui";
import { Markdown } from "../../../ui/Markdown";
import { useOverlay } from "../../../ui/overlay";

export type PlanSheetMode = "half" | "full" | "float";
export type PlanSheetStatus = "review" | "pending" | "executing" | "completed" | "failed" | "handoff";

export interface PlanHeading {
	level: number;
	title: string;
}

const STATUS_CHIP: Record<PlanSheetStatus, { label: string; tone: ChipTone; live?: boolean }> = {
	review: { label: "待确认", tone: "accent" },
	pending: { label: "等待执行", tone: "warn", live: true },
	executing: { label: "执行中", tone: "accent", live: true },
	completed: { label: "已完成", tone: "success" },
	failed: { label: "执行失败", tone: "danger" },
	handoff: { label: "已移交", tone: "neutral" },
};

/** Extract `# Title` from markdown when no explicit title is supplied. */
export function extractPlanTitle(md: string): string | null {
	const m = /^\s*#\s+(.+?)\s*$/m.exec(md);
	return m ? m[1].replace(/\s+#+\s*$/, "").trim() : null;
}

/** Extract section headings (preferring h2, falling back to h1/h3) outside fenced code blocks. */
export function parsePlanHeadings(md: string): PlanHeading[] {
	const lines = md.split("\n");
	let fence: string | null = null;
	const all: PlanHeading[] = [];
	for (const line of lines) {
		const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];
			if (!fence) fence = marker;
			else if (fence === marker) fence = null;
			continue;
		}
		if (fence) continue;
		const hMatch = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
		if (!hMatch) continue;
		all.push({ level: hMatch[1].length, title: hMatch[2].replace(/\s+#+\s*$/, "").trim() });
	}
	const h2 = all.filter((h) => h.level === 2);
	if (h2.length > 0) return h2;
	const h3 = all.filter((h) => h.level === 3);
	if (h3.length > 0) return h3;
	return all;
}

function parseChecklistProgress(md: string): { done: number; total: number } | null {
	let done = 0;
	let total = 0;
	for (const line of md.split("\n")) {
		const m = /^\s*[-*+]\s+\[([ xX])\]\s+/.exec(line);
		if (!m) continue;
		total++;
		if (m[1].toLowerCase() === "x") done++;
	}
	return total > 0 ? { done, total } : null;
}

interface PlanDiffLine {
	kind: "same" | "add" | "del";
	text: string;
}

function computeLineDiff(before: string, after: string): PlanDiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length * b.length > 60_000) {
		return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
	}
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out: PlanDiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ kind: "del", text: a[i] });
			i++;
		} else {
			out.push({ kind: "add", text: b[j] });
			j++;
		}
	}
	while (i < m) out.push({ kind: "del", text: a[i++] });
	while (j < n) out.push({ kind: "add", text: b[j++] });
	return out;
}

/**
 * 3-state Apple PlanSheet (`half` 78vh, `full` 94vh, `float` bottom glass pill).
 * Compact 2-row header with TOC dropdown, scrollable Markdown body, and floating approval dock.
 */
export function PlanSheet({
	open,
	onClose,
	text,
	sessionId,
	status,
	title,
	version = 0,
	prevContent = null,
	running = false,
	approving = false,
	onApprove,
	onAnnotate,
}: {
	open: boolean;
	onClose: () => void;
	text: string;
	sessionId: string;
	status: PlanSheetStatus;
	title?: string | null;
	version?: number;
	prevContent?: string | null;
	running?: boolean;
	approving?: boolean;
	onApprove?: () => void | Promise<void>;
	onAnnotate?: () => void;
}) {
	const [mode, setMode] = useState<PlanSheetMode>("half");
	const [tocOpen, setTocOpen] = useState(false);
	const [showDiff, setShowDiff] = useState(false);
	const [curSection, setCurSection] = useState(0);
	const [dragOffset, setDragOffset] = useState(0);
	const [dragging, setDragging] = useState(false);

	const scrollRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ startY: number; startTime: number; lastY: number } | null>(null);

	useEffect(() => {
		if (open) {
			setMode("half");
			setTocOpen(false);
			setDragOffset(0);
			setDragging(false);
		}
	}, [open]);

	useEffect(() => {
		setShowDiff(false);
	}, [text, version]);

	const handleOverlayDismiss = useCallback(() => {
		if (tocOpen) {
			setTocOpen(false);
			return;
		}
		if (mode === "full") {
			setMode("half");
			return;
		}
		onClose();
	}, [tocOpen, mode, onClose]);

	useOverlay(open && mode !== "float", handleOverlayDismiss);

	const headings = useMemo(() => parsePlanHeadings(text), [text]);
	const headingTag = useMemo(() => {
		const level = headings[0]?.level;
		return level ? `h${level}` : "h2";
	}, [headings]);
	const resolvedTitle = title?.trim() || extractPlanTitle(text) || "执行方案";
	const progress = useMemo(() => parseChecklistProgress(text), [text]);
	const chip = STATUS_CHIP[status];
	const hasDiff = prevContent !== null && prevContent !== text;
	const diffLines = useMemo(
		() => (showDiff && hasDiff && prevContent !== null ? computeLineDiff(prevContent, text) : []),
		[showDiff, hasDiff, prevContent, text],
	);

	useEffect(() => {
		if (!open || mode === "float" || showDiff) return;
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			const nodes = Array.from(el.querySelectorAll<HTMLElement>(`[data-plan-sheet-body] ${headingTag}`));
			if (nodes.length === 0) return;
			const threshold = el.getBoundingClientRect().top + 48;
			let active = 0;
			nodes.forEach((node, idx) => {
				if (node.getBoundingClientRect().top <= threshold) active = idx;
			});
			setCurSection(active);
		};
		onScroll();
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [open, mode, showDiff, headingTag, text]);

	const jumpToHeading = (index: number) => {
		setTocOpen(false);
		setCurSection(index);
		const el = scrollRef.current;
		if (!el) return;
		const nodes = Array.from(el.querySelectorAll<HTMLElement>(`[data-plan-sheet-body] ${headingTag}`));
		const target = nodes[index];
		if (!target) return;
		const top = el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - 10;
		if (typeof el.scrollTo === "function") {
			el.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
		} else {
			el.scrollTop = Math.max(0, top);
		}
	};

	const copyPlan = async () => {
		const ok = await copyText(text);
		toast(ok ? "计划已复制" : "复制失败", { kind: ok ? "success" : "error" });
	};

	const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
		if ((e.target as HTMLElement).closest("button,a,input,textarea")) return;
		dragRef.current = { startY: e.clientY, startTime: performance.now(), lastY: e.clientY };
		setDragging(true);
		e.currentTarget.setPointerCapture?.(e.pointerId);
	};

	const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!dragRef.current) return;
		dragRef.current.lastY = e.clientY;
		const dy = e.clientY - dragRef.current.startY;
		// Allow dragging downward freely and upward within reasonable rubber-band.
		setDragOffset(Math.max(-96, dy));
	};

	const onDragEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		dragRef.current = null;
		setDragging(false);
		setDragOffset(0);
		if (!drag) return;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		const dy = e.clientY - drag.startY;
		const dt = Math.max(16, performance.now() - drag.startTime);
		const velocity = dy / dt;

		if (mode === "half") {
			if (dy < -54 || velocity < -0.45) setMode("full");
			else if (dy > 54 || velocity > 0.45) setMode("float");
		} else if (mode === "full") {
			if (dy > 190 || velocity > 0.85) setMode("float");
			else if (dy > 54 || velocity > 0.45) setMode("half");
		}
	};

	if (!open) return null;

	if (mode === "float") {
		return createPortal(
			<div
				className="fixed right-4 left-4 z-(--z-sheet) flex justify-center pointer-events-none"
				style={{ bottom: "calc(var(--m-safe-bottom) + 84px)" }}
			>
				<div
					role="region"
					aria-label="执行方案悬浮条"
					className="m-liquid-surface pointer-events-auto flex max-w-full items-center gap-2 rounded-m-pill py-1.5 pr-1.5 pl-3.5"
				>
					<button
						type="button"
						onClick={() => setMode("half")}
						className="flex min-w-0 items-center gap-2 py-1 text-left active:opacity-75"
					>
						<ClipboardList size={15} strokeWidth={1.75} className="shrink-0 text-m-accent" aria-hidden />
						<span className="truncate whitespace-nowrap text-[13px] font-medium text-m-text">
							查看执行方案 · 点击展开
						</span>
					</button>
					<button
						type="button"
						aria-label="关闭计划"
						onClick={onClose}
						className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-m-text-3 active:bg-m-surface-hover active:text-m-text"
					>
						<X size={14} strokeWidth={1.85} />
					</button>
				</div>
			</div>,
			document.body,
		);
	}

	const sheetHeight = mode === "full" ? "94vh" : "78vh";
	const translateY = dragOffset > 0 ? dragOffset : dragOffset * 0.25;

	return createPortal(
		<div className="fixed inset-0 z-(--z-sheet) flex flex-col justify-end">
			<div
				aria-hidden="true"
				onClick={onClose}
				className="absolute inset-0 bg-m-scrim/45 backdrop-blur-[2px] transition-opacity duration-200"
			/>
			<section
				role="dialog"
				aria-modal="true"
				aria-label={resolvedTitle}
				style={{
					height: sheetHeight,
					maxHeight: "94vh",
					transform: translateY !== 0 ? `translate3d(0, ${translateY}px, 0)` : undefined,
				}}
				className={`m-sheet-surface relative flex w-full flex-col overflow-hidden rounded-t-[28px] border-t border-m-border bg-m-bg-elev text-m-text ${
					dragging ? "" : "transition-[height,transform] duration-300 ease-m-sheet"
				}`}
			>
				{/* Draggable Compact 2-Row Header */}
				<div
					onPointerDown={onDragStart}
					onPointerMove={onDragMove}
					onPointerUp={onDragEnd}
					onPointerCancel={onDragEnd}
					className="shrink-0 touch-none border-b border-m-border px-4 pb-2.5 select-none"
				>
					<div aria-hidden className="mx-auto mt-2 mb-2 h-[4px] w-9 rounded-m-pill bg-m-border-strong" />

					{/* Row 1: Title + version badge on left; Copy, Diff, Expand/Restore, Minimize, Close on right */}
					<div className="flex items-center justify-between gap-2">
						<div className="flex min-w-0 flex-1 items-center gap-2">
							<h2 className="min-w-0 truncate text-[16px] font-semibold tracking-[-0.015em] text-m-text">
								{resolvedTitle}
							</h2>
							{version > 0 && (
								<span className="shrink-0 whitespace-nowrap rounded-full bg-m-surface px-1.5 py-0.5 font-m-mono text-[10px] font-medium text-m-text-3">
									v{version}
								</span>
							)}
						</div>

						<div className="flex shrink-0 items-center gap-0.5">
							<button
								type="button"
								aria-label="复制计划"
								title="复制计划"
								onClick={() => void copyPlan()}
								className="m-press flex h-8 w-8 items-center justify-center rounded-full text-m-text-2 active:bg-m-surface-hover"
							>
								<Copy size={15} strokeWidth={1.75} />
							</button>
							{hasDiff && (
								<button
									type="button"
									aria-label="对比版本"
									title="对比版本"
									aria-pressed={showDiff}
									onClick={() => {
										setShowDiff((v) => !v);
										setTocOpen(false);
									}}
									className={`m-press flex h-8 w-8 items-center justify-center rounded-full ${
										showDiff
											? "bg-m-accent-soft text-m-accent-soft-text"
											: "text-m-text-2 active:bg-m-surface-hover"
									}`}
								>
									<GitCompareArrows size={15} strokeWidth={1.75} />
								</button>
							)}
							<button
								type="button"
								aria-label={mode === "full" ? "还原半屏" : "全屏展开"}
								title={mode === "full" ? "还原半屏" : "全屏展开"}
								onClick={() => setMode((m) => (m === "full" ? "half" : "full"))}
								className="m-press flex h-8 w-8 items-center justify-center rounded-full text-m-text-2 active:bg-m-surface-hover"
							>
								{mode === "full" ? <Minimize2 size={15} strokeWidth={1.75} /> : <Maximize2 size={15} strokeWidth={1.75} />}
							</button>
							<button
								type="button"
								aria-label="收起为悬浮条"
								title="收起为悬浮条"
								onClick={() => setMode("float")}
								className="m-press flex h-8 w-8 items-center justify-center rounded-full text-m-text-2 active:bg-m-surface-hover"
							>
								<PanelBottomClose size={15} strokeWidth={1.75} />
							</button>
							<button
								type="button"
								aria-label="关闭计划"
								title="关闭计划"
								onClick={onClose}
								className="m-press flex h-8 w-8 items-center justify-center rounded-full bg-m-surface text-m-text-2 active:bg-m-surface-2"
							>
								<X size={15} strokeWidth={1.85} />
							</button>
						</div>
					</div>

					{/* Row 2: Full-width TOC dropdown trigger + status/progress chip */}
					<div className="relative mt-2 flex items-center gap-2">
						<button
							type="button"
							disabled={showDiff || headings.length === 0}
							aria-expanded={tocOpen}
							onClick={() => setTocOpen((v) => !v)}
							className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-m-sm bg-m-surface px-2.5 text-left text-[12px] text-m-text-2 transition-colors active:bg-m-surface-2 disabled:opacity-50"
						>
							<List size={13} strokeWidth={1.8} className="shrink-0 text-m-text-quiet" aria-hidden />
							<span className="shrink-0 whitespace-nowrap font-medium">
								目录 · {headings.length} 章节
							</span>
							{headings[curSection] && !showDiff && (
								<span className="min-w-0 flex-1 truncate text-m-text-quiet">
									{headings[curSection].title}
								</span>
							)}
							<ChevronDown
								size={13}
								strokeWidth={1.8}
								aria-hidden
								className={`shrink-0 text-m-text-quiet transition-transform duration-150 ${
									tocOpen ? "rotate-180" : ""
								}`}
							/>
						</button>

						<Chip tone={chip.tone} className="shrink-0">
							{chip.live && (
								<span aria-hidden className="m-pulse inline-block h-1.5 w-1.5 rounded-full bg-current" />
							)}
							{progress ? `${chip.label} · ${progress.done}/${progress.total}` : chip.label}
						</Chip>

						{tocOpen && headings.length > 0 && (
							<div
								role="menu"
								aria-label="方案目录"
								className="m-liquid-surface absolute top-10 right-0 left-0 z-10 max-h-60 overflow-y-auto overscroll-contain rounded-m-md p-1.5"
							>
								{headings.map((h, idx) => {
									const active = idx === curSection;
									return (
										<button
											key={`${idx}-${h.title}`}
											type="button"
											role="menuitem"
											onClick={() => jumpToHeading(idx)}
											className={`flex w-full items-center gap-2 rounded-m-sm px-2.5 py-2 text-left text-[12.5px] transition-colors active:bg-m-surface-hover ${
												active ? "bg-m-surface font-medium text-m-text" : "text-m-text-2"
											}`}
										>
											<span className="w-5 shrink-0 font-m-mono text-[11px] tabular-nums text-m-text-quiet">
												{String(idx + 1).padStart(2, "0")}
											</span>
											<span className="min-w-0 flex-1 truncate">{h.title}</span>
											{active && <Check size={13} className="shrink-0 text-m-accent" aria-hidden />}
										</button>
									);
								})}
							</div>
						)}
					</div>
				</div>

				{/* Scrollable Body */}
				<div
					ref={scrollRef}
					onClick={() => {
						if (tocOpen) setTocOpen(false);
					}}
					className={`m-scroll-pane relative min-h-0 flex-1 px-4 pt-3 ${
						status === "review" ? "pb-24" : "pb-[calc(var(--m-safe-bottom)+24px)]"
					}`}
				>
					{showDiff && hasDiff ? (
						<div className="space-y-0.5 py-1">
							{diffLines.map((l, idx) => {
								if (!l.text.trim()) return null;
								return (
									<div
										key={idx}
										className={`rounded px-2.5 py-0.5 font-m-mono text-[12px] leading-5 whitespace-pre-wrap break-words ${
											l.kind === "add"
												? "bg-m-diff-add text-m-text"
												: l.kind === "del"
													? "bg-m-diff-del text-m-text-2 line-through"
													: "text-m-text-quiet"
										}`}
									>
										{l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
										{l.text}
									</div>
								);
							})}
						</div>
					) : (
						<div data-plan-sheet-body className="m-selectable pb-4">
							<Markdown text={text} sessionId={sessionId} />
						</div>
					)}
				</div>

				{/* Floating Liquid Glass Approval Dock (review state) */}
				{status === "review" && (
					<div
						className="pointer-events-none absolute right-3 left-3 bottom-0 flex justify-center"
						style={{ paddingBottom: "calc(var(--m-safe-bottom) + 12px)" }}
					>
						<div className="m-liquid-surface pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-2xl p-2">
							<Button
								variant="tonal"
								className="flex-1 whitespace-nowrap"
								disabled={running || approving}
								onClick={() => {
									onAnnotate?.();
									onClose();
								}}
							>
								修改计划
							</Button>
							<Button
								variant="primary"
								className="flex-1 whitespace-nowrap"
								disabled={running || approving}
								onClick={() => void onApprove?.()}
							>
								{approving && <Spinner size={15} />}
								执行计划
							</Button>
						</div>
					</div>
				)}
			</section>
		</div>,
		document.body,
	);
}

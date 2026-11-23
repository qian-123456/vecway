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
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { PlanStatus } from "../../../../src/features/chat/plan/planStatus";
import { copyText } from "../../../core/lib/format";
import { Button, Chip, Spinner, toast, type ChipTone } from "../../../ui";
import { Markdown } from "../../../ui/Markdown";
import { useOverlay } from "../../../ui/overlay";
import { defaultApproveMode, type ApprovePlanOptions, type PlanApproveMode } from "../../panels/usePlanExecution";
import { shortModel } from "../lib/models";

export type PlanSheetMode = "half" | "full" | "float";
export type PlanSheetStatus = "review" | "pending" | "executing" | "completed" | "failed" | "handoff";

export interface PlanHeading {
	index: number;
	level: number;
	title: string;
	id: string;
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

/** Read rendered DOM headings in document order and assign stable anchor IDs. */
export function readDomHeadings(container: HTMLElement | null, idPrefix: string): PlanHeading[] {
	if (!container) return [];
	const nodes = container.querySelectorAll<HTMLElement>("h1, h2, h3, h4");
	const out: PlanHeading[] = [];
	nodes.forEach((node) => {
		const title = (node.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!title) return;
		const index = out.length;
		const id = `${idPrefix}-h-${index}`;
		if (node.id !== id) node.id = id;
		const level = Number(node.tagName.slice(1)) || 2;
		out.push({ index, level, title, id });
	});
	return out;
}

/** Strip fenced code blocks before counting markdown checklist items. */
export function parseChecklistProgress(md: string): { done: number; total: number; nextStep: string | null } | null {
	let done = 0;
	let total = 0;
	let nextStep: string | null = null;
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;
	for (const line of md.split("\n")) {
		const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			const char = marker[0];
			if (!inFence) {
				inFence = true;
				fenceChar = char;
				fenceLen = marker.length;
				continue;
			}
			if (char === fenceChar && marker.length >= fenceLen && fenceMatch[2].trim() === "") {
				inFence = false;
				continue;
			}
		}
		if (inFence) continue;
		const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
		if (!m) continue;
		total++;
		if (m[1] !== " ") done++;
		else if (!nextStep) nextStep = m[2].trim();
	}
	return total > 0 ? { done, total, nextStep } : null;
}

export interface PlanDiffLine {
	kind: "same" | "add" | "del";
	text: string;
}

export function computeLineDiff(before: string, after: string): PlanDiffLine[] {
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

/** Shared line-diff list that keeps blank lines with explicit `+`/`-`/` ` markers. */
export function PlanDiffView({ lines }: { lines: readonly PlanDiffLine[] }) {
	return (
		<div className="space-y-0.5 py-1">
			{lines.map((l, idx) => (
				<div
					key={idx}
					className={`min-h-5 rounded px-2.5 py-0.5 font-m-mono text-[12px] leading-5 whitespace-pre-wrap break-words ${
						l.kind === "add"
							? "bg-m-diff-add text-m-text"
							: l.kind === "del"
								? "bg-m-diff-del text-m-text-2 line-through"
								: "text-m-text-quiet"
					}`}
				>
					<span>{l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}</span>
					<span>{l.text || "\u00A0"}</span>
				</div>
			))}
		</div>
	);
}

const EXEC_MODE_OPTIONS: ReadonlyArray<{ id: PlanApproveMode; label: string }> = [
	{ id: "keep", label: "继续当前上下文" },
	{ id: "compact", label: "压缩上下文执行" },
	{ id: "fresh", label: "新上下文执行" },
];

/** Compact Apple-style execution mode & role/model approval dock shared by PlanSheet and PlanPage. */
export function PlanApprovalControls({
	planStatus,
	canFresh = false,
	running = false,
	approving = false,
	onApprove,
	onAnnotate,
}: {
	planStatus?: PlanStatus | null;
	canFresh?: boolean;
	running?: boolean;
	approving?: boolean;
	onApprove?: (opts: ApprovePlanOptions) => unknown | Promise<unknown>;
	onAnnotate?: () => void;
}) {
	const keepDisabled = planStatus?.keepDisabled === true;
	const freshEnabled = Boolean(canFresh && planStatus?.planFile);
	const tiers = planStatus?.tiers ?? [];
	const defaultRole = planStatus?.defaultRole;
	const [mode, setMode] = useState<PlanApproveMode>(() => defaultApproveMode(planStatus));
	const [role, setRole] = useState<string | null>(() => {
		if (!tiers.length) return null;
		return tiers.some((t) => t.role === defaultRole) ? (defaultRole ?? null) : (tiers[0]?.role ?? null);
	});

	useEffect(() => {
		if (keepDisabled && mode === "keep") setMode("compact");
	}, [keepDisabled, mode]);

	useEffect(() => {
		if (!tiers.length) {
			setRole(null);
			return;
		}
		setRole((cur) => {
			if (cur && tiers.some((t) => t.role === cur)) return cur;
			return tiers.some((t) => t.role === defaultRole) ? (defaultRole ?? null) : (tiers[0]?.role ?? null);
		});
	}, [tiers, defaultRole]);

	const activeTier = tiers.find((t) => t.role === role) ?? null;
	const modelSpec = activeTier?.spec ?? planStatus?.planModel ?? null;
	const pct = typeof planStatus?.contextPercent === "number" ? Math.round(planStatus.contextPercent) : null;
	const busy = running || approving;

	return (
		<div className="mx-auto w-full max-w-md space-y-2">
			{/* Execution mode choices */}
			<div
				role="radiogroup"
				aria-label="执行方式"
				className="grid grid-cols-3 gap-1 rounded-m-md bg-m-surface p-1"
			>
				{EXEC_MODE_OPTIONS.map((opt) => {
					const disabledOpt =
						busy ||
						(opt.id === "keep" && keepDisabled) ||
						(opt.id === "fresh" && !freshEnabled);
					const selected = mode === opt.id;
					const titleHint =
						opt.id === "keep" && keepDisabled
							? `上下文已达 ${pct ?? 95}% 以上，请压缩或新开会话`
							: opt.id === "fresh" && !freshEnabled
								? "需要已保存的计划文件与项目目录"
								: undefined;
					return (
						<button
							key={opt.id}
							type="button"
							role="radio"
							aria-checked={selected}
							disabled={disabledOpt}
							title={titleHint}
							onClick={() => setMode(opt.id)}
							className={`m-press min-h-9 rounded-m-sm px-1.5 py-1 text-[11.5px] leading-tight font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
								selected
									? "bg-m-segment-on text-m-text shadow-xs"
									: "text-m-text-2 active:bg-m-surface-hover"
							}`}
						>
							<span className="block truncate">{opt.label}</span>
						</button>
					);
				})}
			</div>

			{/* Execution role / model info */}
			{(tiers.length > 0 || modelSpec) && (
				<div className="flex items-center justify-between gap-2 px-0.5 text-[11.5px] text-m-text-3">
					{tiers.length > 1 ? (
						<div className="m-noscrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="radiogroup" aria-label="执行角色">
							{tiers.map((t) => {
								const selected = t.role === role;
								return (
									<button
										key={t.role}
										type="button"
										role="radio"
										aria-checked={selected}
										disabled={busy}
										onClick={() => setRole(t.role)}
										title={t.spec}
										className={`m-press shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors ${
											selected
												? "bg-m-accent-soft text-m-accent-soft-text"
												: "bg-m-surface text-m-text-2 active:bg-m-surface-2"
										}`}
									>
										{t.role}
									</button>
								);
							})}
						</div>
					) : (
						<span className="min-w-0 truncate">
							{activeTier ? `执行角色：${activeTier.role}` : "执行模型"}
						</span>
					)}
					{modelSpec && (
						<span className="shrink-0 truncate font-m-mono text-[11px] text-m-text-3" title={modelSpec}>
							{shortModel(modelSpec)}
						</span>
					)}
				</div>
			)}

			{/* Primary action buttons */}
			<div className="flex items-center gap-2">
				<Button
					variant="tonal"
					className="flex-1 whitespace-nowrap"
					disabled={busy}
					onClick={onAnnotate}
				>
					修改计划
				</Button>
				<Button
					variant="primary"
					className="flex-1 whitespace-nowrap"
					disabled={busy}
					onClick={() => void onApprove?.({ mode, role })}
				>
					{approving && <Spinner size={15} />}
					执行计划
				</Button>
			</div>
		</div>
	);
}

/**
 * 3-state Apple PlanSheet (`half` 78% vh, `full` 94% vh, `float` bottom glass pill).
 * Compact 2-row header with DOM-derived TOC dropdown, scrollable Markdown body, and pinned translucent approval dock.
 */
export function PlanSheet({
	open,
	mode: modeProp,
	onModeChange,
	onClose,
	text,
	sessionId,
	status,
	title,
	version = 0,
	prevContent = null,
	planStatus = null,
	canFresh = false,
	running = false,
	approving = false,
	onApprove,
	onAnnotate,
}: {
	open: boolean;
	mode?: PlanSheetMode;
	onModeChange?: (mode: PlanSheetMode) => void;
	onClose: () => void;
	text: string;
	sessionId: string;
	status: PlanSheetStatus;
	title?: string | null;
	version?: number;
	prevContent?: string | null;
	planStatus?: PlanStatus | null;
	canFresh?: boolean;
	running?: boolean;
	approving?: boolean;
	onApprove?: (opts?: ApprovePlanOptions) => unknown | Promise<unknown>;
	onAnnotate?: () => void;
}) {
	const [uncontrolledMode, setUncontrolledMode] = useState<PlanSheetMode>("half");
	const mode = modeProp ?? uncontrolledMode;
	const setMode = useCallback(
		(next: PlanSheetMode | ((prev: PlanSheetMode) => PlanSheetMode)) => {
			if (onModeChange) {
				const resolved = typeof next === "function" ? next(modeProp ?? uncontrolledMode) : next;
				onModeChange(resolved);
			} else {
				setUncontrolledMode(next);
			}
		},
		[onModeChange, modeProp, uncontrolledMode],
	);

	const [tocOpen, setTocOpen] = useState(false);
	const [showDiff, setShowDiff] = useState(false);
	const [headings, setHeadings] = useState<PlanHeading[]>([]);
	const [curSection, setCurSection] = useState(0);
	const [dragOffset, setDragOffset] = useState(0);
	const [dragging, setDragging] = useState(false);

	const scrollRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ pointerId: number; startY: number; startTime: number; lastY: number } | null>(null);

	useEffect(() => {
		if (open) {
			if (modeProp === undefined) setUncontrolledMode("half");
			setTocOpen(false);
			setDragOffset(0);
			setDragging(false);
			dragRef.current = null;
		} else {
			setTocOpen(false);
		}
	}, [open, modeProp]);

	useEffect(() => {
		setShowDiff(false);
	}, [text, version]);

	// Separate overlay layers so Back closes TOC first without swallowing PlanSheet's history entry.
	useOverlay(open && mode !== "float", onClose);
	useOverlay(open && mode !== "float" && tocOpen, useCallback(() => setTocOpen(false), []));

	const resolvedTitle = title?.trim() || extractPlanTitle(text) || "执行方案";
	const progress = useMemo(() => parseChecklistProgress(text), [text]);
	const chip = STATUS_CHIP[status];
	const hasDiff = prevContent !== null && prevContent !== text;
	const diffLines = useMemo(
		() => (showDiff && hasDiff && prevContent !== null ? computeLineDiff(prevContent, text) : []),
		[showDiff, hasDiff, prevContent, text],
	);

	// Derive TOC headings directly from rendered Markdown DOM headings so Setext/ATX/nested markup match 1:1.
	useLayoutEffect(() => {
		if (!open || mode === "float" || showDiff) return;
		const container = bodyRef.current;
		if (!container) return;
		const sync = () => setHeadings(readDomHeadings(container, `plan-sheet-${sessionId.slice(0, 8)}`));
		sync();
		if (typeof MutationObserver === "undefined") return;
		const mo = new MutationObserver(sync);
		mo.observe(container, { childList: true, subtree: true, characterData: true });
		return () => mo.disconnect();
	}, [open, mode, showDiff, text, sessionId]);

	useEffect(() => {
		if (!open || mode === "float" || showDiff) return;
		const el = scrollRef.current;
		const body = bodyRef.current;
		if (!el || !body) return;
		const onScroll = () => {
			const nodes = Array.from(body.querySelectorAll<HTMLElement>("h1, h2, h3, h4")).filter(
				(n) => (n.textContent ?? "").trim().length > 0,
			);
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
	}, [open, mode, showDiff, headings]);

	const jumpToHeading = (index: number) => {
		setTocOpen(false);
		setCurSection(index);
		const el = scrollRef.current;
		const body = bodyRef.current;
		if (!el || !body) return;
		const nodes = Array.from(body.querySelectorAll<HTMLElement>("h1, h2, h3, h4")).filter(
			(n) => (n.textContent ?? "").trim().length > 0,
		);
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
		if (dragRef.current) return;
		if ((e.target as HTMLElement).closest("button,a,input,textarea")) return;
		dragRef.current = { pointerId: e.pointerId, startY: e.clientY, startTime: performance.now(), lastY: e.clientY };
		setDragging(true);
		e.currentTarget.setPointerCapture?.(e.pointerId);
	};

	const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!dragRef.current || dragRef.current.pointerId !== e.pointerId) return;
		dragRef.current.lastY = e.clientY;
		const dy = e.clientY - dragRef.current.startY;
		setDragOffset(Math.max(-96, dy));
	};

	const onDragCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		dragRef.current = null;
		setDragging(false);
		setDragOffset(0);
		if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
			e.currentTarget.releasePointerCapture?.(e.pointerId);
		}
	};

	const onDragEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		dragRef.current = null;
		setDragging(false);
		setDragOffset(0);
		if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
			e.currentTarget.releasePointerCapture?.(e.pointerId);
		}
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
				className="pointer-events-none fixed z-(--z-sheet) flex justify-center"
				style={{
					left: "calc(var(--m-safe-left) + 16px)",
					right: "calc(var(--m-safe-right) + 16px)",
					bottom: "calc(var(--m-kb, 0px) + var(--m-safe-bottom) + 84px)",
				}}
			>
				<div
					role="region"
					aria-label="执行方案悬浮条"
					className="m-liquid-surface pointer-events-auto flex max-w-full items-center gap-1 rounded-m-pill py-1 pr-1 pl-3.5"
				>
					<button
						type="button"
						onClick={() => setMode("half")}
						className="flex min-h-10 min-w-0 items-center gap-2 py-1 text-left active:opacity-75"
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
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-m-text-3 active:bg-m-surface-hover active:text-m-text"
					>
						<X size={14} strokeWidth={1.85} />
					</button>
				</div>
			</div>,
			document.body,
		);
	}

	const sheetHeight = mode === "full" ? "calc(var(--m-vh, 100dvh) * 0.94)" : "calc(var(--m-vh, 100dvh) * 0.78)";
	const translateY = dragOffset > 0 ? dragOffset : dragOffset * 0.25;
	const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
	const sheetTransition = dragging
		? "none"
		: reducedMotion
			? "opacity 150ms var(--m-ease)"
			: "height 300ms var(--m-ease-sheet), transform 300ms var(--m-ease-sheet), opacity var(--m-dur-fast) var(--m-ease)";

	return createPortal(
		<div
			className="fixed inset-x-0 z-(--z-sheet) flex flex-col justify-end"
			style={{
				top: "var(--m-vv-top, 0px)",
				height: "var(--m-vh, 100dvh)",
			}}
		>
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
					maxHeight: "calc(var(--m-vh, 100dvh) * 0.94)",
					transform: translateY !== 0 ? `translate3d(0, ${translateY}px, 0)` : undefined,
					transition: sheetTransition,
				}}
				className="relative flex w-full flex-col overflow-hidden rounded-t-[28px] border-t border-m-border bg-m-bg-elev text-m-text shadow-m-pop"
			>
				{/* Draggable Compact 2-Row Header */}
				<div
					onPointerDown={onDragStart}
					onPointerMove={onDragMove}
					onPointerUp={onDragEnd}
					onPointerCancel={onDragCancel}
					onLostPointerCapture={onDragCancel}
					style={{
						paddingInlineStart: "calc(var(--m-safe-left) + 16px)",
						paddingInlineEnd: "calc(var(--m-safe-right) + 16px)",
					}}
					className="shrink-0 touch-none border-b border-m-border pb-2.5 select-none"
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
								className="m-press flex h-9 w-9 items-center justify-center rounded-full text-m-text-2 active:bg-m-surface-hover"
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
									className={`m-press flex h-9 w-9 items-center justify-center rounded-full ${
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
								className="m-press flex h-9 w-9 items-center justify-center rounded-full text-m-text-2 active:bg-m-surface-hover"
							>
								{mode === "full" ? <Minimize2 size={15} strokeWidth={1.75} /> : <Maximize2 size={15} strokeWidth={1.75} />}
							</button>
							<button
								type="button"
								aria-label="收起为悬浮条"
								title="收起为悬浮条"
								onClick={() => setMode("float")}
								className="m-press flex h-9 w-9 items-center justify-center rounded-full text-m-text-2 active:bg-m-surface-hover"
							>
								<PanelBottomClose size={15} strokeWidth={1.75} />
							</button>
							<button
								type="button"
								aria-label="关闭计划"
								title="关闭计划"
								onClick={onClose}
								className="m-press flex h-9 w-9 items-center justify-center rounded-full text-m-text-2 active:bg-m-surface-hover"
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
							className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-m-sm bg-m-surface px-2.5 text-left text-[12px] text-m-text-2 transition-colors active:bg-m-surface-2 disabled:opacity-50"
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
											key={`${idx}-${h.id}`}
											type="button"
											role="menuitem"
											onClick={() => jumpToHeading(idx)}
											style={{ paddingLeft: `${10 + (h.level - 1) * 10}px` }}
											className={`flex min-h-10 w-full items-center gap-2 rounded-m-sm pr-2.5 py-2 text-left text-[12.5px] transition-colors active:bg-m-surface-hover ${
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
					style={{
						paddingInlineStart: "calc(var(--m-safe-left) + 16px)",
						paddingInlineEnd: "calc(var(--m-safe-right) + 16px)",
						paddingBottom: status === "review" ? "24px" : "calc(var(--m-safe-bottom) + 24px)",
					}}
					className="m-scroll-pane relative min-h-0 flex-1 pt-3"
				>
					{showDiff && hasDiff ? (
						<PlanDiffView lines={diffLines} />
					) : (
						<div ref={bodyRef} data-plan-sheet-body className="m-selectable pb-4">
							<Markdown text={text} sessionId={sessionId} />
						</div>
					)}
				</div>

				{/* Pinned Translucent Liquid Glass Approval Dock (never overlaps scrolled text) */}
				{status === "review" && (
					<div
						className="shrink-0 border-t border-m-border/70 bg-m-bg-elev/88 pt-2.5 backdrop-blur-xl"
						style={{
							paddingInlineStart: "calc(var(--m-safe-left) + 14px)",
							paddingInlineEnd: "calc(var(--m-safe-right) + 14px)",
							paddingBottom: "calc(var(--m-safe-bottom) + 12px)",
						}}
					>
						<PlanApprovalControls
							planStatus={planStatus}
							canFresh={canFresh}
							running={running}
							approving={approving}
							onApprove={onApprove}
							onAnnotate={() => {
								onAnnotate?.();
								onClose();
							}}
						/>
					</div>
				)}
			</section>
		</div>,
		document.body,
	);
}

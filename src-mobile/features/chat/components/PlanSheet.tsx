import {
	Check,
	ChevronDown,
	ClipboardList,
	Copy,
	GitCompareArrows,
	List,
	Maximize2,
	Minimize2,
	MoreHorizontal,
	PanelBottomClose,
	Search,
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
import { AnchoredPopover, BottomSheet, Button, IconButton, ListGroup, MenuRow, SelectRow, Spinner, toast } from "../../../ui";
import { Markdown } from "../../../ui/Markdown";
import { useOverlay } from "../../../ui/overlay";
import { defaultApproveMode, type ApprovePlanOptions, type PlanApproveMode } from "../../panels/usePlanExecution";
import { desktopThinkingLabel, resolveThinkingLevels, shortModel, type ModelOpt } from "../lib/models";
import { CompactModelPane } from "./ModelThinkingSheet";
import { ThinkingLevelPopover } from "./ThinkingLevelPopover";
import { sessionModelSource, useModelFacts } from "./useModelFacts";

export type PlanSheetMode = "half" | "full" | "float";
export type PlanSheetStatus = "review" | "pending" | "executing" | "completed" | "failed" | "handoff";

export interface PlanHeading {
	index: number;
	level: number;
	title: string;
	id: string;
}

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
	sessionId,
	planStatus,
	canFresh = false,
	running = false,
	approving = false,
	onApprove,
	onAnnotate,
}: {
	sessionId?: string;
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
	const [custom, setCustom] = useState<{ provider: string; id: string; level: string } | null>(null);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	const [modelQuery, setModelQuery] = useState("");
	const [thinkOpen, setThinkOpen] = useState(false);
	const thinkBtnRef = useRef<HTMLButtonElement>(null);

	const modelSource = useMemo(() => (sessionId ? sessionModelSource(sessionId) : null), [sessionId]);
	const noopSource = useMemo(
		() => ({
			load: async () => ({ models: [], current: null, thinkingLevel: null, liveThinking: [] }),
			setModel: async () => ({ current: null, thinkingLevel: null, liveThinking: [] }),
			setThinking: async () => ({ current: null, thinkingLevel: null, liveThinking: [] }),
		}),
		[],
	);
	const facts = useModelFacts(modelSheetOpen && Boolean(modelSource), modelSource ?? noopSource);

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

	useEffect(() => {
		if (modelSheetOpen) setModelQuery("");
	}, [modelSheetOpen]);

	const activeTier = tiers.find((t) => t.role === role) ?? null;
	const pct = typeof planStatus?.contextPercent === "number" ? Math.round(planStatus.contextPercent) : null;
	const busy = running || approving;

	const modeOptions = useMemo(
		() =>
			EXEC_MODE_OPTIONS.filter((opt) => opt.id !== "fresh" || freshEnabled).map((opt) => ({
				value: opt.id,
				label: opt.label,
				disabled: opt.id === "keep" && keepDisabled,
				disabledReason:
					opt.id === "keep" && keepDisabled ? `上下文已达 ${pct ?? 95}% 以上，请压缩或新开会话` : undefined,
			})),
		[freshEnabled, keepDisabled, pct],
	);

	const catalogModels = facts.data?.models ?? [];
	const customOption = custom
		? catalogModels.find((m) => m.provider === custom.provider && m.id === custom.id)
		: undefined;
	const customLevels = custom ? resolveThinkingLevels(customOption, customOption?.thinking, custom.level) : [];
	const hasThinkingChoice = Boolean(custom && customLevels.length > 1);
	const customSpec = custom
		? custom.level && custom.level !== "auto"
			? `${custom.provider}/${custom.id}:${custom.level}`
			: `${custom.provider}/${custom.id}`
		: null;
	const effectiveRoleSpec = customSpec ?? (tiers.length <= 1 ? null : role);

	const modelTriggerText = custom
		? custom.id
		: activeTier
			? activeTier.spec
				? `${activeTier.role} · ${shortModel(activeTier.spec)}`
				: activeTier.role
			: shortModel(planStatus?.planModel ?? "") || "当前会话模型";

	const handlePickCustomModel = (m: ModelOpt) => {
		const levels = resolveThinkingLevels(m, m.thinking, null);
		setCustom({
			provider: m.provider,
			id: m.id,
			level: levels[0] ?? "auto",
		});
		setModelSheetOpen(false);
	};

	const canCustomizeModel = Boolean(sessionId) || tiers.length > 1;

	return (
		<div className="mx-auto w-full max-w-md space-y-2.5">
			<ListGroup className="!mx-0">
				<SelectRow
					title="执行方式"
					presentation="menu"
					value={mode}
					options={modeOptions}
					disabled={busy}
					onChange={(next) => setMode(next)}
				/>
				{(canCustomizeModel || activeTier || planStatus?.planModel) && (
					<div className="m-list-row flex min-h-12 items-center justify-between gap-3 px-4 py-2">
						<span className="shrink-0 text-m-sm font-medium whitespace-nowrap text-m-text">执行模型</span>
						<div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
							<button
								type="button"
								disabled={busy || !canCustomizeModel}
								aria-label={`选择执行模型，当前：${modelTriggerText}`}
								onClick={() => setModelSheetOpen(true)}
								className="m-press inline-flex min-h-9 min-w-0 max-w-full items-center gap-1 rounded-m-sm px-2 py-1.5 text-right text-m-accent active:bg-m-surface-hover disabled:text-m-text-3 disabled:opacity-70"
							>
								<span className="min-w-0 break-words font-m-mono text-[13px] leading-snug">{modelTriggerText}</span>
								{canCustomizeModel && <ChevronDown size={14} strokeWidth={2} className="shrink-0 opacity-80" aria-hidden />}
							</button>
							{hasThinkingChoice && custom && (
								<button
									ref={thinkBtnRef}
									type="button"
									disabled={busy}
									aria-label={`执行思考强度：${desktopThinkingLabel(custom.level)}`}
									onClick={() => setThinkOpen(true)}
									className="m-press inline-flex min-h-9 shrink-0 items-center gap-0.5 rounded-m-sm px-1.5 py-1 text-[12.5px] whitespace-nowrap text-m-text-2 active:bg-m-surface-hover disabled:opacity-45"
								>
									<span>{desktopThinkingLabel(custom.level)}</span>
									<ChevronDown size={13} strokeWidth={2} className="shrink-0 opacity-75" aria-hidden />
								</button>
							)}
						</div>
					</div>
				)}
			</ListGroup>

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
					onClick={() => void onApprove?.({ mode, role: effectiveRoleSpec })}
				>
					{approving && <Spinner size={15} />}
					执行计划
				</Button>
			</div>

			{custom && (
				<ThinkingLevelPopover
					open={thinkOpen}
					onClose={() => setThinkOpen(false)}
					anchorEl={thinkBtnRef.current}
					placement="top-end"
					levels={customLevels}
					value={custom.level || "auto"}
					disabled={busy}
					onChange={(lvl) => {
						setCustom((prev) => (prev ? { ...prev, level: lvl } : prev));
					}}
				/>
			)}

			<BottomSheet open={modelSheetOpen} onClose={() => setModelSheetOpen(false)}>
				<div className="flex h-[62dvh] max-h-[540px] flex-col">
					<div className="flex shrink-0 items-center gap-2 border-b border-m-border bg-m-bg-elev px-3.5 pt-0.5 pb-2.5">
						{sessionId ? (
							<label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-m-border bg-m-surface py-0.5 pr-1 pl-3">
								<Search size={16} className="shrink-0 text-m-text-3" aria-hidden />
								<input
									type="search"
									value={modelQuery}
									onChange={(e) => setModelQuery(e.target.value)}
									placeholder="搜索模型或供应商"
									aria-label="搜索模型"
									className="min-h-9 min-w-0 flex-1 bg-transparent text-m-md text-m-text outline-none placeholder:text-m-text-3 [&::-webkit-search-cancel-button]:appearance-none"
								/>
								{modelQuery !== "" && (
									<IconButton icon={<X size={16} />} label="清除模型搜索" variant="plain" size="sm" onClick={() => setModelQuery("")} />
								)}
							</label>
						) : (
							<div className="min-w-0 flex-1 px-1 text-m-md font-semibold text-m-text">选择执行模型</div>
						)}
						<IconButton icon={<X size={18} />} label="关闭" variant="plain" size="sm" onClick={() => setModelSheetOpen(false)} />
					</div>

					{sessionId && facts.loading && !facts.data ? (
						<div className="flex flex-1 items-center justify-center gap-2 py-12 text-m-sm text-m-text-3">
							<Spinner size={18} /> 正在加载模型
						</div>
					) : sessionId && facts.data?.models?.length ? (
						<CompactModelPane
							models={facts.data.models}
							current={custom ? { provider: custom.provider, id: custom.id } : null}
							configuredProviders={facts.configuredProviders}
							providerLabels={facts.providerLabels}
							providerOrder={facts.providerOrder}
							busy={busy}
							active={modelSheetOpen}
							query={modelQuery}
							onPick={handlePickCustomModel}
							extraTopSection={
								tiers.length > 0 ? (
									<div className="border-b border-m-border/60 px-3.5 py-2">
										<div className="mb-1 text-[11px] font-medium text-m-text-3">预设角色</div>
										<div className="space-y-1">
											{tiers.map((t) => {
												const selected = !custom && role === t.role;
												return (
													<button
														key={t.role}
														type="button"
														onClick={() => {
															setCustom(null);
															setRole(t.role);
															setModelSheetOpen(false);
														}}
														className={`flex min-h-10 w-full items-center justify-between gap-2 rounded-m-sm px-2.5 py-1.5 text-left text-m-sm ${
															selected ? "bg-m-accent-soft/45 font-medium text-m-accent" : "text-m-text active:bg-m-surface-hover"
														}`}
													>
														<span className="truncate">{t.role}</span>
														<span className="flex shrink-0 items-center gap-1.5">
															{t.spec && <span className="font-m-mono text-[11.5px] text-m-text-3">{shortModel(t.spec)}</span>}
															{selected && <Check size={15} className="text-m-accent" aria-hidden />}
														</span>
													</button>
												);
											})}
										</div>
									</div>
								) : undefined
							}
						/>
					) : (
						<div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
							{tiers.length > 0 && (
								<div className="space-y-1">
									{tiers.map((t) => {
										const selected = !custom && role === t.role;
										return (
											<button
												key={t.role}
												type="button"
												onClick={() => {
													setCustom(null);
													setRole(t.role);
													setModelSheetOpen(false);
												}}
												className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-m-sm px-3 py-2 text-left text-m-sm ${
													selected ? "bg-m-accent-soft/45 font-medium text-m-accent" : "text-m-text active:bg-m-surface-hover"
												}`}
											>
												<span className="truncate">{t.role}</span>
												<span className="flex shrink-0 items-center gap-1.5">
													{t.spec && <span className="font-m-mono text-[11.5px] text-m-text-3">{shortModel(t.spec)}</span>}
													{selected && <Check size={15} className="text-m-accent" aria-hidden />}
												</span>
											</button>
										);
									})}
								</div>
							)}
						</div>
					)}
				</div>
			</BottomSheet>
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
	const [moreOpen, setMoreOpen] = useState(false);
	const [showDiff, setShowDiff] = useState(false);
	const [headings, setHeadings] = useState<PlanHeading[]>([]);
	const [curSection, setCurSection] = useState(0);
	const [dragOffset, setDragOffset] = useState(0);
	const [dragging, setDragging] = useState(false);

	const scrollRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const moreBtnRef = useRef<HTMLButtonElement>(null);
	const tocBtnRef = useRef<HTMLButtonElement>(null);
	const dragRef = useRef<{ pointerId: number; startY: number; startTime: number; lastY: number } | null>(null);

	useEffect(() => {
		if (open) {
			if (modeProp === undefined) setUncontrolledMode("half");
			setTocOpen(false);
			setMoreOpen(false);
			setDragOffset(0);
			setDragging(false);
			dragRef.current = null;
		} else {
			setTocOpen(false);
			setMoreOpen(false);
		}
	}, [open, modeProp]);

	useEffect(() => {
		setShowDiff(false);
	}, [text, version]);

	// Separate overlay layers so Back closes TOC first without swallowing PlanSheet's history entry.
	const isTopModal = useOverlay(open && mode !== "float", onClose);
	useOverlay(open && mode !== "float" && tocOpen, useCallback(() => setTocOpen(false), []));
	useOverlay(open && mode !== "float" && moreOpen, useCallback(() => setMoreOpen(false), []));

	const resolvedTitle = title?.trim() || extractPlanTitle(text) || "执行方案";
	const progress = useMemo(() => parseChecklistProgress(text), [text]);
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
					bottom: "calc(var(--m-kb, 0px) + var(--m-safe-bottom) + 116px)",
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
				aria-modal={isTopModal ? "true" : undefined}
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

					{/* Row 1: Wrapping Title on left; ONLY ⋯ and ✕ on right */}
					<div className="flex items-start justify-between gap-2">
						<h2 className="min-w-0 flex-1 pt-1 text-[16px] leading-snug font-semibold tracking-[-0.015em] break-words text-m-text">
							{resolvedTitle}
						</h2>

						<div className="flex shrink-0 items-center gap-0.5">
							<button
								ref={moreBtnRef}
								type="button"
								aria-label="更多操作"
								aria-haspopup="menu"
								aria-expanded={moreOpen}
								onClick={() => {
									setMoreOpen((v) => !v);
									setTocOpen(false);
								}}
								className="m-press flex h-9 w-9 items-center justify-center rounded-full text-m-text-2 active:bg-m-surface-hover"
							>
								<MoreHorizontal size={17} strokeWidth={1.85} />
							</button>
							<button
								type="button"
								aria-label="关闭计划"
								title="关闭计划"
								onClick={onClose}
								className="m-press flex h-9 w-9 items-center justify-center rounded-full text-m-text-2 active:bg-m-surface-hover"
							>
								<X size={16} strokeWidth={1.85} />
							</button>
						</div>
					</div>

					{/* Row 2: Always-visible TOC button + optional plain progress count (ZERO status chip/text) */}
					{(headings.length > 0 || progress !== null || !showDiff) && (
						<div className="mt-2 flex items-center gap-2">
							<button
								ref={tocBtnRef}
								type="button"
								disabled={showDiff || headings.length === 0}
								aria-expanded={tocOpen}
								onClick={() => {
									setTocOpen((v) => !v);
									setMoreOpen(false);
								}}
								className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-m-sm bg-m-surface px-2.5 text-left text-[12px] text-m-text-2 transition-colors active:bg-m-surface-2 disabled:opacity-50"
							>
								<List size={13} strokeWidth={1.8} className="shrink-0 text-m-text-quiet" aria-hidden />
								<span className="shrink-0 font-medium whitespace-nowrap">
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
							{progress && (
								<span className="shrink-0 font-m-mono text-[12px] font-medium whitespace-nowrap text-m-text-3 tabular-nums">
									{progress.done}/{progress.total}
								</span>
							)}
						</div>
					)}
				</div>

				<AnchoredPopover
					open={open && moreOpen}
					onClose={() => setMoreOpen(false)}
					anchorEl={moreBtnRef.current}
					placement="bottom-end"
					ariaLabel="计划操作"
					minWidth={188}
					className="m-liquid-surface rounded-2xl!"
				>
					<div role="menu" className="py-1">
						<MenuRow
							icon={<Copy size={16} strokeWidth={1.75} />}
							label="复制计划"
							onClick={() => {
								setMoreOpen(false);
								void copyPlan();
							}}
						/>
						{hasDiff && (
							<MenuRow
								icon={<GitCompareArrows size={16} strokeWidth={1.75} />}
								label={showDiff ? "查看正文" : "对比版本"}
								selected={showDiff}
								onClick={() => {
									setShowDiff((v) => !v);
									setMoreOpen(false);
								}}
							/>
						)}
						<MenuRow
							icon={mode === "full" ? <Minimize2 size={16} strokeWidth={1.75} /> : <Maximize2 size={16} strokeWidth={1.75} />}
							label={mode === "full" ? "还原半屏" : "全屏展开"}
							onClick={() => {
								setMode((m) => (m === "full" ? "half" : "full"));
								setMoreOpen(false);
							}}
						/>
						<MenuRow
							icon={<PanelBottomClose size={16} strokeWidth={1.75} />}
							label="收起为悬浮条"
							onClick={() => {
								setMode("float");
								setMoreOpen(false);
							}}
						/>
					</div>
				</AnchoredPopover>

				<AnchoredPopover
					open={open && tocOpen && headings.length > 0}
					onClose={() => setTocOpen(false)}
					anchorEl={tocBtnRef.current}
					placement="bottom-start"
					ariaLabel="方案目录"
					minWidth={260}
					maxWidth={340}
					className="m-liquid-surface rounded-2xl!"
				>
					<div role="menu" aria-label="方案目录" className="max-h-64 overflow-y-auto overscroll-contain p-1.5">
						{headings.map((h, idx) => {
							const active = idx === curSection;
							return (
								<button
									key={`${idx}-${h.id}`}
									type="button"
									role="menuitem"
									onClick={() => jumpToHeading(idx)}
									style={{ paddingLeft: `${10 + (h.level - 1) * 10}px` }}
									className={`flex min-h-10 w-full items-center gap-2 rounded-m-sm py-2 pr-2.5 text-left text-[12.5px] transition-colors active:bg-m-surface-hover ${
										active ? "bg-m-surface font-medium text-m-text" : "text-m-text-2"
									}`}
								>
									<span className="w-5 shrink-0 font-m-mono text-[11px] text-m-text-quiet tabular-nums">
										{String(idx + 1).padStart(2, "0")}
									</span>
									<span className="min-w-0 flex-1 truncate">{h.title}</span>
									{active && <Check size={13} className="shrink-0 text-m-accent" aria-hidden />}
								</button>
							);
						})}
					</div>
				</AnchoredPopover>

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
							sessionId={sessionId}
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

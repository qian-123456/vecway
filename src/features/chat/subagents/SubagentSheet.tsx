/**
 * Right-side slide-over with one subagent's full picture: assignment,
 * prompt, live/historical process transcript, final output. Data comes from
 * the merged AgentRow plus `subagent_transcript` incremental polling.
 */

import clsx from "clsx";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
	Check,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Clock,
	Coins,
	Copy,
	Cpu,
	ExternalLink,
	Loader2,
	Square,
	Timer,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Z_LAYER } from "../../../components/FloatingLayer";
import type { SubagentRunSegment, SubagentTranscript, TranscriptItem } from "../../../lib/contracts";
import { copyText, errMsg } from "../../../lib/dialogs";
import { useEscapeKey } from "../../../lib/hooks";
import { subagentTranscript } from "../../../lib/ipc";
import { toast } from "../../../lib/toast";
import { prefersReducedMotion, usePresence } from "../../../lib/motion";
import { tNow, useT } from "../../../stores/language";
import { Markdown } from "../../../components/Markdown";
import { formatTokens } from "../sessionStats";
import { RequestStatsLine } from "../RequestStatsLine";
import { requestStatFromItem } from "../requestStats";
import { formatDurationCompact, formatShortModel } from "../turnGrouping";
import { type AgentRow, isTerminalStatus, normStatus, runningElapsedMs, segmentsDurationMs } from "./merge";
import { formatClockTime } from "./subagentTree";
import type { SubagentStatus } from "./types";
const ICON: Record<
	SubagentStatus,
	{ Icon: typeof Check; color: string; spin?: boolean }
> = {
	running: { Icon: Loader2, color: "var(--status-info)", spin: true },
	completed: { Icon: Check, color: "var(--status-success)" },
	failed: { Icon: X, color: "var(--status-error)" },
	pending: { Icon: Clock, color: "var(--status-warning)" },
	aborted: { Icon: Square, color: "var(--status-warning)" },
};

const STATUS_TEXT_KEYS: Record<SubagentStatus, string> = {
	pending: "subagents.statusPending",
	running: "subagents.statusRunning",
	completed: "subagents.statusCompleted",
	failed: "subagents.statusFailed",
	aborted: "subagents.statusAborted",
};

type Tab = "overview" | "process" | "output";
const TAB_KEYS: { id: Tab; labelKey: string }[] = [
	{ id: "overview", labelKey: "subagents.tabOverview" },
	{ id: "process", labelKey: "subagents.tabProcess" },
	{ id: "output", labelKey: "subagents.tabOutput" },
];

const POLL_MS = 1500;

function CopyButton({ text, label }: { text: string; label: string }) {
	return (
		<button
			type="button"
			onClick={async () => {
				try {
					await copyText(text);
				} catch (e) {
					toast.error(tNow("subagents.copyFailed", { error: errMsg(e) }));
				}
			}}
			className="press-scale flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-40)] hover:bg-[var(--ghost-hover)] hover:text-[var(--text)]"
			title={label}
		>
			<Copy size={11} />
			{label}
		</button>
	);
}

/** Compact transcript tool call row with expandable output. */
function ToolRow({ item, output }: { item: TranscriptItem; output?: TranscriptItem }) {
	const [open, setOpen] = useState(false);
	const call = item.toolCalls?.[0];
	if (!call) return null;
	const intent = call.intent;
	const argSummary = argPreview(call.args);
	const outText = output?.toolResult?.text ?? "";
	const isErr = output?.toolResult?.isError;
	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-[var(--ghost-hover)]"
			>
				<ChevronRight
					size={11}
					className={clsx(
						"shrink-0 text-[var(--text-30)] transition-transform duration-150",
						open && "rotate-90",
					)}
				/>
				<span
					className={clsx(
						"shrink-0 font-mono text-[11px]",
						isErr ? "text-[var(--status-error)]" : "text-[var(--text-60)]",
					)}
				>
					{call.name}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-30)]">
					{intent ?? argSummary}
				</span>
			</button>
			{open && outText && (
				<pre className="mx-1 mb-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-[10px] border border-[var(--line)] bg-[var(--well-bg)] px-2.5 py-1.5 font-mono text-[11px] leading-5 text-[var(--text-40)]">
					{outText}
				</pre>
			)}
		</div>
	);
}

function argPreview(args: unknown): string {
	if (args == null) return "";
	if (typeof args === "string") return args.slice(0, 80);
	const o = args as Record<string, unknown>;
	for (const k of ["path", "file", "filePath", "command", "pattern", "query"]) {
		if (typeof o[k] === "string") {
			const s = o[k] as string;
			return s.length > 80 ? `${s.slice(0, 80)}…` : s;
		}
	}
	const j = JSON.stringify(args);
	return j && j !== "{}" ? (j.length > 80 ? `${j.slice(0, 80)}…` : j) : "";
}

const CARD_CLASS =
	"rounded-[14px] border border-[var(--line)] bg-[var(--ghost-hover)] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]";

const MAX_COLLAPSED_SEGMENTS = 4;

/** Format one run segment for the timing card, handling open-ended active runs. */
function formatSegmentEntry(seg: SubagentRunSegment, ongoingLabel: string): string | undefined {
	const startClock = formatClockTime(seg.startedAt);
	const endClock = formatClockTime(seg.endedAt);
	if (!startClock && !endClock) return undefined;
	if (startClock && !endClock) {
		return `${startClock} - ${ongoingLabel}`;
	}
	const startMs = Date.parse(seg.startedAt);
	const endMs = seg.endedAt ? Date.parse(seg.endedAt) : NaN;
	const durMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? endMs - startMs : undefined;
	const durText = durMs !== undefined && Math.round(durMs / 1000) >= 1 ? formatDurationCompact(durMs) : undefined;
	const range = startClock && endClock ? `${startClock} - ${endClock}` : (startClock ?? endClock)!;
	return durText ? `${range} · ${durText}` : range;
}

const GLASS_BTN =
	"press-scale grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--line)] bg-[var(--ghost-hover)] text-[var(--text-60)] shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:text-[var(--text)] disabled:opacity-30";
const CHIP =
	"rounded-full border border-[var(--line)] bg-[var(--ghost-hover)] px-2 py-0.5 text-[var(--text-60)]";

/// `<parent-stem>/<id>.jsonl` → `<dir>/<parent-stem>.jsonl`.
function deriveParentFile(agentFile: string): string | undefined {
	const sep = agentFile.lastIndexOf("/");
	if (sep < 0) return undefined;
	const dir = agentFile.slice(0, sep);
	const slash = dir.lastIndexOf("/");
	const parentDir = slash >= 0 ? dir.slice(0, slash) : "";
	const stem = dir.slice(slash + 1);
	return stem ? `${parentDir}/${stem}.jsonl` : undefined;
}

const SHEET_EXIT_MS = 200;

export function SubagentSheet({
	open = true,
	parentFile,
	row,
	context,
	onClose,
	onPrev,
	onNext,
}: {
	open?: boolean;
	parentFile?: string;
	row: AgentRow;
	context?: string;
	onClose: () => void;
	/** Step to the previous / next subagent in tree order; undefined disables the arrow. */
	onPrev?: () => void;
	onNext?: () => void;
}) {
	const { t } = useT();
	const { present, exiting } = usePresence(open, SHEET_EXIT_MS);
	const [tab, setTab] = useState<Tab>("overview");
	const [data, setData] = useState<SubagentTranscript | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [systemOpen, setSystemOpen] = useState(false);
	const [taskOpen, setTaskOpen] = useState(false);
	const [taskClamped, setTaskClamped] = useState(false);
	const [contextOpen, setContextOpen] = useState(false);
	const [segmentsExpanded, setSegmentsExpanded] = useState(false);
	const taskRef = useRef<HTMLParagraphElement>(null);
	const nextByteRef = useRef(0);
	const itemsRef = useRef<TranscriptItem[]>([]);
	const [items, setItems] = useState<TranscriptItem[]>([]);

	useEscapeKey(onClose, open);

	const summary = data?.summary;
	const summaryStatus = summary?.status ? normStatus(summary.status) : undefined;
	const rowStatus = normStatus(row.status);
	const effectiveStatus: SubagentStatus = isTerminalStatus(summaryStatus)
		? summaryStatus!
		: isTerminalStatus(rowStatus)
			? rowStatus!
			: (summaryStatus ?? rowStatus ?? "pending");

	const isLive = effectiveStatus === "running" || effectiveStatus === "pending";

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!open || !isLive) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [open, isLive]);

	const { Icon, color, spin } = ICON[effectiveStatus];

	const startedAt =
		summary?.startedAt ??
		row.startedAt ??
		(items.length > 0 ? items[0]?.ts : undefined);
	const endedAt =
		summary?.endedAt ??
		row.endedAt ??
		(isTerminalStatus(effectiveStatus) && items.length > 0
			? items[items.length - 1]?.ts
			: undefined);

	const effectiveSegments = summary?.runSegments?.length
		? summary.runSegments
		: row.runSegments;
	const startClock = formatClockTime(startedAt);
	const endClock = formatClockTime(endedAt);

	const durationMs = useMemo(() => {
		if (effectiveStatus === "pending") return undefined;
		if (effectiveStatus === "running") {
			return (
				runningElapsedMs(effectiveSegments, startedAt, now) ??
				(row.durationMs && row.durationMs > 0 ? row.durationMs : undefined)
			);
		}
		// Finished states
		const segMs = segmentsDurationMs(effectiveSegments);
		if (segMs !== undefined) return segMs;
		if (startedAt && endedAt) {
			const ms = Date.parse(endedAt) - Date.parse(startedAt);
			if (Number.isFinite(ms) && ms > 0) return ms;
		}
		if (row.durationMs && row.durationMs > 0) return row.durationMs;
		return undefined;
	}, [effectiveStatus, effectiveSegments, startedAt, endedAt, now, row.durationMs]);

	const segmentEntries = useMemo(() => {
		if (!effectiveSegments || effectiveSegments.length <= 1) return [];
		const ongoingLabel = t("subagents.segmentOngoing");
		return effectiveSegments
			.map((seg, idx) => ({
				index: idx + 1,
				text: formatSegmentEntry(seg, ongoingLabel),
			}))
			.filter((entry): entry is { index: number; text: string } => Boolean(entry.text));
	}, [effectiveSegments, t]);

	const duration = durationMs && Math.round(durationMs / 1000) >= 1 ? formatDurationCompact(durationMs) : undefined;
	const effectiveContext = context ?? row.sharedContext;
	const failureText = row.error || row.abortReason;
	const statusText = t(STATUS_TEXT_KEYS[effectiveStatus] ?? STATUS_TEXT_KEYS.pending);

	const effectiveModel = summary?.model ?? row.model;
	const effectiveThinking = summary?.thinkingLevel ?? row.thinkingLevel;
	const effectiveToolCount = summary?.toolCallCount || row.toolCount;
	const effectiveRequests = summary?.requestCount || row.requests;
	const effectiveTokens = summary ? summary.tokens ?? undefined : row.tokens;
	const effectiveCost = summary ? summary.cost ?? undefined : row.cost;

	// subagent_transcript takes the PARENT session file. `row.filePath` is the
	// agent's own `<parent-stem>/<id>.jsonl`; derive the parent from it when
	// the caller could not resolve one.
	const file =
		parentFile ??
		(row.filePath ? deriveParentFile(row.filePath) : undefined);
	const isLiveRef = useRef(isLive);
	isLiveRef.current = isLive;

	// Load the subagent transcript (systemPrompt/prompt/output/items) once per
	// open sheet; while the agent is live, keep tailing via nextByte so the
	// 过程 tab streams. Stops at a terminal status or when the file is gone.
	useEffect(() => {
		setSystemOpen(false);
		setTaskOpen(false);
		setContextOpen(false);
		setSegmentsExpanded(false);
	}, [row.id]);

	useEffect(() => {
		if (!open) return;
		// Stepping to another subagent must not show the previous one's data.
		setData(null);
		setError(null);
		setItems([]);
		if (!file) return;
		let cancelled = false;
		let timer: number | undefined;
		nextByteRef.current = 0;
		itemsRef.current = [];
		const tick = async () => {
			try {
				const t = await subagentTranscript(file, row.id, nextByteRef.current);
				if (cancelled) return;
				setData(t);
				setError(null);
				if (t.reset) {
					itemsRef.current = [];
				}
				itemsRef.current = [...itemsRef.current, ...t.items];
				nextByteRef.current = t.nextByte;
				setItems(itemsRef.current);
				const terminal = isTerminalStatus(t?.summary?.status);
				if (!terminal && isLiveRef.current) timer = window.setTimeout(tick, POLL_MS);
			} catch (e) {
				if (cancelled) return;
				setError(errMsg(e));
				if (isLiveRef.current) timer = window.setTimeout(tick, POLL_MS);
			}
		};
		void tick();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, file, row.id]);

	// Map toolCallId -> toolResult item for compact process rows.
	const callIds = useMemo(() => {
		const s = new Set<string>();
		for (const it of items) {
			for (const c of it.toolCalls ?? []) s.add(c.id);
		}
		return s;
	}, [items]);
	const resultsByCallId = useMemo(() => {
		const m = new Map<string, TranscriptItem>();
		for (const it of items) {
			if (it.kind === "tool_result" && it.toolResult?.toolCallId) {
				m.set(it.toolResult.toolCallId, it);
			}
		}
		return m;
	}, [items]);

	// Prefer full verbatim prompt from transcript (`data.prompt`); fall back to row summary while loading.
	const taskPrompt = data?.prompt ?? row.task ?? row.assignment ?? undefined;
	// omp prefixes every subagent prompt with this; hide it in the "负责什么" summary.
	const assignmentText = taskPrompt?.replace(/^Complete assignment thoroughly:\s*/, "");
	const longTaskHeuristic = (assignmentText?.length ?? 0) > 360 || (assignmentText?.split("\n").length ?? 0) > 6;

	useEffect(() => {
		const el = taskRef.current;
		if (!el) {
			setTaskClamped(false);
			return;
		}
		const measure = () => {
			if (taskOpen) return;
			setTaskClamped(el.scrollHeight > el.clientHeight + 1);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [assignmentText, taskOpen]);

	const showTaskToggle = taskOpen || taskClamped || longTaskHeuristic;

	const outputText =
		data?.output ?? row.output ?? undefined;
	const outputPath = data?.outputPath ?? row.outputPath ?? undefined;

	const doReveal = async () => {
		if (!outputPath) return;
		try {
			await revealItemInDir(outputPath);
		} catch (e) {
			toast.error(t("subagents.openFailed", { error: errMsg(e) }));
		}
	};

	if (!present || (!open && prefersReducedMotion())) return null;

	return createPortal(
		<div
			className={clsx("fixed inset-0", exiting && "pointer-events-none")}
			style={{ zIndex: Z_LAYER.modal }}
			role="dialog"
			aria-modal={exiting ? undefined : "true"}
			aria-hidden={exiting || undefined}
			inert={exiting}
			aria-label={t("subagents.subagentAria", { id: row.id })}
		>
			{/* Very light dim; click closes */}
			<div
				data-exiting={exiting ? "true" : undefined}
				className="apple-sheet-backdrop absolute inset-0 bg-black/10"
				onMouseDown={exiting ? undefined : onClose}
			/>
			<aside
				data-exiting={exiting ? "true" : undefined}
				className="liquid-glass sa-sheet-in absolute right-3 top-[52px] flex max-h-[calc(100%-92px)] w-[min(500px,44vw)] flex-col text-[var(--text)]"
				onMouseDown={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex flex-col gap-2 px-4 pb-2.5 pt-3.5">
					<div className="flex items-center gap-2">
						<Icon
							size={15}
							className={clsx("shrink-0", spin && "animate-spin")}
							style={{ color }}
						/>
						<span className="min-w-0 flex-1 break-words text-[14px] font-bold" title={row.id}>
							{row.id.includes(".") ? row.id.split(".").join(" > ") : row.id}
						</span>
						{(onPrev || onNext) && (
							<>
								<button
									type="button"
									onClick={onPrev}
									disabled={!onPrev}
									aria-label={t("subagents.prevSubagent")}
									title={t("subagents.prevSubagentShortcut")}
									className={GLASS_BTN}
								>
									<ChevronUp size={14} />
								</button>
								<button
									type="button"
									onClick={onNext}
									disabled={!onNext}
									aria-label={t("subagents.nextSubagent")}
									title={t("subagents.nextSubagentShortcut")}
									className={GLASS_BTN}
								>
									<ChevronDown size={14} />
								</button>
							</>
						)}
						<button type="button" onClick={onClose} className={GLASS_BTN} aria-label={t("common.close")} title={t("subagents.closeShortcut")}>
							<X size={14} />
						</button>
					</div>
					<div className="flex flex-wrap items-center gap-1.5 text-[11px]">
						{row.agent && <span className={CHIP}>{row.agent}</span>}
						{(effectiveModel || effectiveThinking) && (
							<span className={CHIP} title={effectiveModel}>
								{effectiveModel
									? `${formatShortModel(effectiveModel)}${effectiveThinking ? ` (${effectiveThinking})` : ""}`
									: effectiveThinking}
							</span>
						)}
						<span className={CHIP} style={{ color }}>
							{[
								statusText,
								duration,
								isTerminalStatus(effectiveStatus) && endClock
									? t("subagents.completedAtShort", { time: endClock })
									: undefined,
							]
								.filter(Boolean)
								.join(" · ")}
						</span>
					</div>
				</div>
				{/* Tabs: segmented pill with sliding highlight */}
				<div className="px-4 pb-2.5">
					<div className="relative grid grid-cols-3 rounded-full border border-[var(--line)] bg-[var(--ghost-hover)] p-0.5">
						<span
							aria-hidden
							className="sa-seg-thumb absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/3)] rounded-full bg-[var(--bg-active-fill)] shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_1px_2px_rgba(0,0,0,0.15)]"
							style={{ transform: `translateX(${TAB_KEYS.findIndex((tItem) => tItem.id === tab) * 100}%)` }}
						/>
						{TAB_KEYS.map((tItem) => (
							<button
								key={tItem.id}
								type="button"
								onClick={() => setTab(tItem.id)}
								className={clsx(
									"relative rounded-full py-1 text-[12px] transition-colors",
									tab === tItem.id
										? "text-[var(--text)]"
										: "text-[var(--text-40)] hover:text-[var(--text-60)]",
								)}
							>
								{t(tItem.labelKey)}
							</button>
						))}
					</div>
				</div>

				{/* Body */}
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
					{tab === "overview" && (
						<div className="space-y-4">
							{failureText && (
								<section
									role="alert"
									className="rounded-[14px] border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 px-3 py-2.5"
								>
									<div className="mb-1 flex items-center justify-between">
										<span className="text-[11px] font-medium text-[var(--status-error)]">{t("subagents.failureReason")}</span>
										<CopyButton text={failureText} label={t("common.copy")} />
									</div>
									<p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-5 text-[var(--text-60)] select-text">
										{failureText}
									</p>
								</section>
							)}
							{assignmentText && (
								<section className="rounded-[14px] border border-[var(--line)] bg-[var(--ghost-hover)] px-3 py-2.5">
									<div className="mb-1 flex items-center justify-between">
										<span className="text-[11px] text-[var(--text-40)]">{t("subagents.taskTitle")}</span>
										<CopyButton text={assignmentText} label={t("common.copy")} />
									</div>
									<p
										ref={taskRef}
										className={clsx(
											"whitespace-pre-wrap break-words text-[12.5px] leading-5 text-[var(--text-60)]",
											!taskOpen && "line-clamp-6",
										)}
									>
										{assignmentText}
									</p>
									{showTaskToggle && (
										<button
											type="button"
											onClick={() => setTaskOpen(!taskOpen)}
											className="press-scale mt-1.5 inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--ghost-hover)] px-2.5 py-0.5 text-[11px] text-[var(--text-60)] hover:text-[var(--text)]"
										>
											{taskOpen ? t("common.collapse") : t("subagents.expandAll")}
											<ChevronRight size={11} className={clsx("transition-transform", taskOpen ? "-rotate-90" : "rotate-90")} />
										</button>
									)}
								</section>
							)}
							{row.solutionSpace && (
								<section className="rounded-[14px] border border-[var(--line)] bg-[var(--ghost-hover)] px-3 py-2.5">
									<div className="mb-1 flex items-center justify-between">
										<span className="text-[11px] text-[var(--text-40)]">{t("subagents.solutionSpace")}</span>
										<CopyButton text={row.solutionSpace} label={t("common.copy")} />
									</div>
									<p className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-[var(--text-60)]">
										{row.solutionSpace}
									</p>
								</section>
							)}
							{effectiveContext && (
								<section className="rounded-[14px] border border-[var(--line)] bg-[var(--ghost-hover)] px-3 py-2.5">
									<div className="mb-1 flex items-center justify-between">
										<button
											type="button"
											onClick={() => setContextOpen(!contextOpen)}
											className="flex items-center gap-1 text-[11px] text-[var(--text-40)] transition-colors hover:text-[var(--text-60)]"
										>
											<ChevronRight size={11} className={clsx("transition-transform", contextOpen && "rotate-90")} />
											{t("subagents.sharedContext")}
										</button>
										<CopyButton text={effectiveContext} label={t("common.copy")} />
									</div>
									{contextOpen && (
										<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[var(--text-60)]">
											{effectiveContext}
										</pre>
									)}
								</section>
							)}
							{(() => {
								const modelDisplay = [effectiveModel, effectiveThinking].filter(Boolean).join(" · ");
								const contextStr =
									row.contextTokens && row.contextWindow
										? `${Math.round((row.contextTokens / row.contextWindow) * 100)}%`
										: row.contextTokens
											? formatTokens(row.contextTokens)
											: undefined;
								const executionStats = [
									effectiveToolCount ? { label: t("subagents.statToolCalls"), value: String(effectiveToolCount) } : null,
									effectiveRequests ? { label: t("subagents.statRequests"), value: String(effectiveRequests) } : null,
									contextStr ? { label: t("subagents.statContext"), value: contextStr } : null,
									effectiveTokens != null ? { label: t("subagents.statTokens"), value: formatTokens(effectiveTokens) } : null,
									effectiveCost !== undefined ? { label: t("subagents.statCost"), value: `$${effectiveCost.toFixed(3)}` } : null,
								].filter((item): item is { label: string; value: string } => item !== null);
								const hasTiming =
									Boolean(duration) ||
									Boolean(startClock) ||
									(isTerminalStatus(effectiveStatus) && Boolean(endClock)) ||
									segmentEntries.length > 0;
								const singleTimeRange =
									isTerminalStatus(effectiveStatus) && startClock && endClock
										? `${startClock} - ${endClock}`
										: isTerminalStatus(effectiveStatus) && endClock
											? t("subagents.completedAtShort", { time: endClock })
											: startClock
												? t("subagents.startedAtShort", { time: startClock })
												: undefined;
								const visibleSegments =
									segmentsExpanded || segmentEntries.length <= MAX_COLLAPSED_SEGMENTS
										? segmentEntries
										: segmentEntries.slice(0, MAX_COLLAPSED_SEGMENTS);
								const hasMoreSegments = segmentEntries.length > MAX_COLLAPSED_SEGMENTS;

								if (!modelDisplay && !row.modelRole && executionStats.length === 0 && !hasTiming) {
									return null;
								}
								return (
									<section className="flex flex-col gap-2">
										{(modelDisplay || row.modelRole) && (
											<div className={CARD_CLASS}>
												<div className="flex items-center justify-between gap-2">
													<div className="flex items-center gap-1.5 text-[11px] text-[var(--text-40)]">
														<Cpu size={12} />
														{t("subagents.statModel")}
													</div>
													{row.modelRole && (
														<span className="whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--ghost-hover)] px-2 py-0.5 text-[10.5px] text-[var(--text-60)]">
															{t("subagents.roleBadge", { role: row.modelRole })}
														</span>
													)}
												</div>
												{modelDisplay && (
													<div className="mt-1 break-words text-[12.5px] font-medium text-[var(--text)]">
														{modelDisplay}
													</div>
												)}
											</div>
										)}
										{executionStats.length > 0 && (
											<div className={CARD_CLASS}>
												<div className="flex items-center gap-1.5 text-[11px] text-[var(--text-40)]">
													<Coins size={12} />
													{t("subagents.cardExecutionStats")}
												</div>
												<div
													className={clsx(
														"mt-2 grid gap-x-2 gap-y-2",
														executionStats.length === 1 && "grid-cols-1",
														executionStats.length === 2 && "grid-cols-2",
														executionStats.length === 3 && "grid-cols-3",
														executionStats.length === 4 && "grid-cols-4",
														executionStats.length >= 5 && "grid-cols-[repeat(auto-fit,minmax(76px,1fr))]",
													)}
												>
													{executionStats.map((stat) => (
														<div key={stat.label} className="min-w-0">
															<div className="whitespace-nowrap text-[10.5px] text-[var(--text-40)]">
																{stat.label}
															</div>
															<div className="mt-0.5 whitespace-nowrap tabular-nums text-[12.5px] font-medium text-[var(--text)]">
																{stat.value}
															</div>
														</div>
													))}
												</div>
											</div>
										)}
										{hasTiming && (
											<div className={CARD_CLASS}>
												<div className="flex items-center justify-between gap-2">
													<div className="flex items-center gap-1.5 text-[11px] text-[var(--text-40)]">
														<Timer size={12} />
														{t("subagents.cardTiming")}
													</div>
													{segmentEntries.length > 1 && (
														<span className="whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--ghost-hover)] px-2 py-0.5 text-[10.5px] text-[var(--text-60)]">
															{t("subagents.segmentCount", { count: segmentEntries.length })}
														</span>
													)}
												</div>
												{segmentEntries.length > 1 ? (
													<div className="mt-1 space-y-1.5">
														{(singleTimeRange || duration) && (
															<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
																{singleTimeRange && (
																	<span className="tabular-nums text-[12px] text-[var(--text-60)]">
																		{singleTimeRange}
																	</span>
																)}
																{duration && (
																	<span className="tabular-nums text-[12.5px] font-medium text-[var(--text)]">
																		{duration}
																	</span>
																)}
															</div>
														)}
														<div className="space-y-1 border-t border-[var(--line)] pt-1.5 tabular-nums text-[11.5px]">
															{visibleSegments.map((seg) => (
																<div key={seg.index} className="flex items-center gap-2">
																	<span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--text-40)]">
																		{t("subagents.segmentIndex", { index: seg.index })}
																	</span>
																	<span className="min-w-0 whitespace-nowrap text-[var(--text-60)]">
																		{seg.text}
																	</span>
																</div>
															))}
															{hasMoreSegments && (
																<button
																	type="button"
																	onClick={() => setSegmentsExpanded((v) => !v)}
																	className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--ghost-hover)] px-2 py-0.5 text-[10.5px] text-[var(--text-60)] transition-colors hover:text-[var(--text)]"
																>
																	{segmentsExpanded
																		? t("subagents.collapseSegments")
																		: t("subagents.showAllSegments", { count: segmentEntries.length })}
																</button>
															)}
														</div>
													</div>
												) : (
													<div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
														{singleTimeRange && (
															<span className="tabular-nums text-[12px] text-[var(--text-60)]">
																{singleTimeRange}
															</span>
														)}
														{duration && (
															<span className="tabular-nums text-[12.5px] font-medium text-[var(--text)]">
																{duration}
															</span>
														)}
													</div>
												)}
											</div>
										)}
									</section>
								);
							})()}
							{effectiveStatus === "running" && row.currentTool && (
								<section>
									<div className="mb-1 text-[11px] text-[var(--text-30)]">
										{t("subagents.currentTool")}
									</div>
									<div className="font-mono text-[12px] text-[var(--text-60)]">
										↳ {row.currentTool}
										{row.currentToolDetail ? ` ${row.currentToolDetail}` : ""}
									</div>
								</section>
							)}
							{row.recentTools && row.recentTools.length > 0 && (
								<section>
									<div className="mb-1 text-[11px] text-[var(--text-30)]">
										{t("subagents.recentTools")}
									</div>
									<div className="space-y-0.5">
										{row.recentTools.slice(-8).map((t, i) => (
											<div
												key={i}
												className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--text-40)]"
											>
												<span
													className={clsx(
														t.isError && "text-[var(--status-error)]",
													)}
												>
													{t.tool}
												</span>
												<span className="min-w-0 flex-1 truncate text-[var(--text-30)]">
													{t.intent ?? t.argsKey ?? argPreview(t.args)}
												</span>
											</div>
										))}
									</div>
								</section>
							)}
							{data?.systemPrompt && (
								<section className={CARD_CLASS}>
									<div className="flex items-center justify-between">
										<button
											type="button"
											onClick={() => setSystemOpen(!systemOpen)}
											className="flex items-center gap-1 text-[11px] text-[var(--text-40)] transition-colors hover:text-[var(--text-60)]"
										>
											<ChevronRight
												size={11}
												className={clsx(
													"transition-transform duration-150",
													systemOpen && "rotate-90",
												)}
											/>
											{t("subagents.systemPrompt")}
										</button>
										<CopyButton text={data.systemPrompt} label={t("common.copy")} />
									</div>
									{systemOpen && (
										<pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[var(--text-40)]">
											{data.systemPrompt}
										</pre>
									)}
								</section>
							)}
						</div>
					)}

					{tab === "process" && (
						<div className="space-y-1">
							{!file && (
								<p className="text-[12px] text-[var(--text-30)]">
									{t("subagents.sessionFileUnavailable")}
								</p>
							)}
							{error && (
								<p className="text-[12px] text-[var(--status-error)]">
									{error}
								</p>
							)}
							{file && !error && items.length === 0 && (
								<p className="text-[12px] text-[var(--text-30)]">
									{isLive ? t("subagents.waitingForOutput") : t("subagents.noProcessRecord")}
								</p>
							)}
							{items.map((it) => {
								if (it.kind === "assistant") {
									return (
										<div key={it.id} className="py-0.5">
											{it.toolCalls?.map((c) => (
												<ToolRow
													key={c.id}
													item={{ ...it, toolCalls: [c] }}
													output={resultsByCallId.get(c.id)}
												/>
											))}
											{it.text && <Markdown text={it.text} />}
											<RequestStatsLine stat={requestStatFromItem(it)!} className="mt-0.5" />
										</div>
									);
								}
								if (it.kind === "tool_result") {
									// Rendered inline under its tool call; orphans show dimmed.
									if (callIds.has(it.toolResult?.toolCallId ?? "")) {
										return null;
									}
									return (
										<div
											key={it.id}
											className="flex items-center gap-1.5 px-1 font-mono text-[11px] text-[var(--text-30)]"
										>
											<span>{it.toolResult?.toolName}</span>
											<span className="min-w-0 flex-1 truncate">
												{it.toolResult?.text?.slice(0, 80)}
											</span>
										</div>
									);
								}
								return null;
							})}
						</div>
					)}

					{tab === "output" && (
						<div className="space-y-3">
							{outputText ? (
								(() => {
									const trimmed = outputText.trim();
									const looksJson =
										trimmed.startsWith("{") || trimmed.startsWith("[");
									if (looksJson) {
										try {
											return (
												<pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-all rounded-[10px] border border-[var(--line)] bg-[var(--well-bg)] px-2.5 py-2 font-mono text-[11px] leading-5 text-[var(--text-60)]">
													{JSON.stringify(JSON.parse(trimmed), null, 2)}
												</pre>
											);
										} catch {
											// fall through to markdown
										}
									}
									return <Markdown text={outputText} />;
								})()
							) : (
								<p className="text-[12px] text-[var(--text-30)]">
									{isLive ? t("subagents.noOutputYet") : t("subagents.noOutput")}
								</p>
							)}
							{outputPath && (
								<div className="flex items-center gap-2 border-t border-[var(--line)] pt-2">
									<span
										className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-30)]"
										title={outputPath}
									>
										{outputPath}
									</span>
									<button
										type="button"
										onClick={doReveal}
										className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-40)] transition-colors hover:bg-[var(--ghost-hover)] hover:text-[var(--text)]"
										title={t("subagents.revealInFinder")}
									>
										<ExternalLink size={11} />
										{t("subagents.reveal")}
									</button>
									<CopyButton text={outputPath} label={t("subagents.copyPath")} />
								</div>
							)}
						</div>
					)}
				</div>
			</aside>
		</div>,
		document.body,
	);
}

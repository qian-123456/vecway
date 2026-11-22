import { ChevronRight, ClipboardList, Copy, Download, Ellipsis, ImageOff } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { apiUrl } from "../../../core/api";
import { copyText } from "../../../core/lib/format";
import { usePrefs } from "../../../core/stores/prefs";
import { useSession } from "../../../core/stores/sessions";
import type { ImageRef, Item, ToolItem } from "../../../core/types";
import { Button, IconButton, openImage, toast, type ViewerImage } from "../../../ui";
import { Markdown } from "../../../ui/Markdown";
import { useChat, useChatUi, type ChatUi } from "../ChatContext";
import { stripImageMarkers } from "../lib/prompt";
import { formatDurationCompact, type RequestStat } from "../lib/requestStats";
import { type Step, type Turn } from "../lib/turns";
import { PlanSheet } from "./PlanSheet";
import { StatLine, TurnSummaryRows } from "./StatLine";
import { Thinking } from "./Thinking";
import { toolState, ToolCard } from "./ToolCard";
import { TurnDiffCard } from "./TurnDiffCard";
import { useLongPress } from "./useLongPress";

/** Per-turn expand override; survives window paging remounts. */
const foldOverride = new Map<string, boolean>();

/** 1 s ticker, mounted only while a turn is running. */
function RunningLabel({ start }: { start: number }) {
	const [first] = useState(() => Date.now());
	const [now, setNow] = useState(first);
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	const elapsed = Math.max(0, now - (start || first));
	return <>正在处理 {formatDurationCompact(elapsed)}…</>;
}

function finishedFoldLabel(turn: Pick<Turn, "steps" | "start" | "end">, steps: readonly Step[]): string {
	const span = turn.end > turn.start && turn.start ? turn.end - turn.start : 0;
	if (span > 0) return `已处理 ${formatDurationCompact(span)}`;
	const hasTools = steps.some((s) => s.kind === "tool");
	if (!hasTools && steps.some((s) => s.kind === "thinking")) {
		let ms = 0;
		for (const s of steps) if (s.kind === "thinking" && s.ms) ms += s.ms;
		return ms > 0 ? `已思考 ${formatDurationCompact(ms)}` : "已思考";
	}
	const count = steps.filter((s) => s.kind !== "stat").length;
	return `已处理 ${count} 步`;
}

function formatHourMinute(epochMs: number | null | undefined): string {
	if (!epochMs || !Number.isFinite(epochMs)) return "";
	const d = new Date(epochMs);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface ParallelMark {
	first: boolean;
	last: boolean;
}

function computeParallelMarks(
	steps: readonly Step[],
	turnSrc: readonly Item[],
	live: Item | null,
): Map<string, ParallelMark> {
	const toolToReq = new Map<string, string>();
	for (const it of turnSrc) {
		if (it.role !== "assistant" || it.tools.length < 2) continue;
		for (const t of it.tools) toolToReq.set(t.id, it.id);
	}
	if (live && live.tools.length >= 2) {
		for (const t of live.tools) toolToReq.set(t.id, live.id);
	}
	const marks = new Map<string, ParallelMark>();
	let i = 0;
	while (i < steps.length) {
		const cur = steps[i];
		if (cur.kind !== "tool") {
			i++;
			continue;
		}
		const reqId = toolToReq.get(cur.tool.id);
		if (!reqId) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < steps.length) {
			const next = steps[j];
			if (next.kind === "tool" && toolToReq.get(next.tool.id) === reqId) j++;
			else break;
		}
		if (j - i >= 2) {
			for (let k = i; k < j; k++) {
				marks.set(steps[k].key, { first: k === i, last: k === j - 1 });
			}
		}
		i = j;
	}
	return marks;
}
export function imageSrc(sessionId: string, img: ImageRef): string {
	return img.path ? apiUrl(`/sessions/${sessionId}/image?path=${encodeURIComponent(img.path)}`) : "";
}

function ImageThumb({
	src,
	label,
	badge,
	onOpen,
}: {
	src: string;
	label: string;
	badge?: number;
	onOpen: () => void;
}) {
	const [bad, setBad] = useState(!src);
	useEffect(() => {
		setBad(!src);
	}, [src]);
	if (bad)
		return (
			<span className="inline-flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-m-md border border-m-border bg-m-surface px-2 text-center text-m-xs text-m-text-2">
				<ImageOff size={16} className="shrink-0 text-m-text-3" aria-hidden />
				<span className="whitespace-nowrap">图片 {label}</span>
			</span>
		);
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`预览图片 ${label}`}
			className="relative block h-20 w-20 shrink-0 overflow-hidden rounded-m-md border border-m-border bg-m-surface active:opacity-80"
		>
			<img src={src} alt={label} loading="lazy" onError={() => setBad(true)} className="block h-full w-full object-cover" />
			{badge !== undefined && (
				<span className="pointer-events-none absolute top-1 left-1 flex h-4 min-w-4 items-center justify-center rounded-m-sm bg-m-bg-elev/90 px-1 font-m-mono text-[10px] font-semibold leading-none text-m-text ring-1 ring-m-border">
					{badge}
				</span>
			)}
		</button>
	);
}

export function Images({
	sessionId,
	images,
	align = "start",
}: {
	sessionId: string;
	images: readonly ImageRef[];
	align?: "start" | "end";
}) {
	if (!images.length) return null;
	const gallery: ViewerImage[] = images.map((img, i) => ({
		src: imageSrc(sessionId, img),
		alt: `#${i + 1}`,
	}));
	return (
		<div
			className={`flex flex-wrap gap-1.5 ${
				align === "end" ? "max-w-[var(--m-user-bubble-max)] justify-end" : "mt-2"
			}`}
			data-no-longpress
		>
			{images.map((img, i) => (
				<ImageThumb
					key={img.id || i}
					src={gallery[i].src}
					label={`#${i + 1}`}
					badge={images.length > 1 ? i + 1 : undefined}
					onOpen={() => openImage(gallery[i], gallery, i)}
				/>
			))}
		</div>
	);
}

const BUBBLE =
	"m-selectable max-w-[var(--m-user-bubble-max)] whitespace-pre-wrap break-words rounded-(--m-bubble-radius) bg-m-bubble-user-bg px-4 py-2.5 text-m-body leading-[1.54] text-m-bubble-user-text [overflow-wrap:anywhere]";

export const UserBubble = memo(function UserBubble({ item, sessionId }: { item: Item; sessionId: string }) {
	const { openActions } = useChatUi();
	const cleaned = stripImageMarkers(item.text);
	const displayText = item.images.length > 0 && cleaned === "（图片）" ? "" : cleaned;
	const lp = useLongPress(() => openActions({ role: "user", text: displayText || item.text, entryId: item.id, canRetry: false }));
	if (!displayText && !item.images.length) return null;
	return (
		<div className="flex flex-col items-end gap-1.5 px-5 pt-4 pb-2">
			<Images sessionId={sessionId} images={item.images} align="end" />
			{displayText && (
				<div {...lp} className={BUBBLE}>
					{displayText}
				</div>
			)}
		</div>
	);
});

export const PendingBubble = memo(function PendingBubble({ text, imageUrls }: { text: string; imageUrls: string[] }) {
	const cleaned = stripImageMarkers(text);
	const displayText = imageUrls.length > 0 && cleaned === "（图片）" ? "" : cleaned;
	const gallery: ViewerImage[] = imageUrls.map((src, i) => ({ src, alt: `#${i + 1}` }));
	if (!displayText && !imageUrls.length) return null;
	return (
		<div className="flex flex-col items-end gap-1.5 px-5 pt-4 pb-2 opacity-70">
			{imageUrls.length > 0 && (
				<div className="flex max-w-[var(--m-user-bubble-max)] flex-wrap justify-end gap-1.5" data-no-longpress>
					{gallery.map((img, i) => (
						<ImageThumb
							key={`${i}-${img.src}`}
							src={img.src}
							label={`#${i + 1}`}
							badge={gallery.length > 1 ? i + 1 : undefined}
							onOpen={() => openImage(img, gallery, i)}
						/>
					))}
				</div>
			)}
			{displayText && <div className={BUBBLE}>{displayText}</div>}
		</div>
	);
});
function StepView({
	step,
	running,
	onStat,
	parallel,
}: {
	step: Step;
	running: boolean;
	onStat: ChatUi["openStat"];
	parallel?: ParallelMark;
}) {
	switch (step.kind) {
		case "thinking":
			return <Thinking id={step.key} text={step.text} live={false} ms={step.ms} />;
		case "text":
			return (
				<div className="m-selectable py-1">
					<Markdown text={step.text} className="m-md-quiet" />
				</div>
			);
		case "tool": {
			const hairline = parallel
				? `relative pr-2 after:pointer-events-none after:absolute after:right-0 after:w-px after:bg-m-border after:content-[''] ${
						parallel.first ? "after:top-1.5" : "after:-top-0.5"
					} ${parallel.last ? "after:bottom-1.5" : "after:-bottom-0.5"}`
				: "";
			return (
				<div className={hairline}>
					<ToolCard id={step.key} tool={step.tool} state={toolState(step.tool, running)} />
				</div>
			);
		}
		case "stat":
			return (
				<div className="ms-5">
					<StatLine stat={step.stat} onOpen={onStat} />
				</div>
			);
		case "notice":
			return <div className="py-1.5 text-[12px] text-m-text-quiet">{step.text}</div>;
	}
}

interface LiveParts {
	steps: Step[];
	liveText: string;
	liveThinking: string;
}

/** Persisted steps + the live row: unresolved persisted tools take the live status; new live tools append. */
export function mergeLive(turn: Turn, live: Item | null): LiveParts {
	if (!live) return { steps: turn.steps, liveText: "", liveThinking: "" };
	const liveById = new Map<string, ToolItem>();
	for (const t of live.tools) liveById.set(t.id, t);
	const seen = new Set<string>();
	const steps: Step[] = turn.steps.map((s) => {
		if (s.kind !== "tool") return s;
		seen.add(s.tool.id);
		const lt = liveById.get(s.tool.id);
		return lt && s.tool.status === "running" && lt.status !== "running" ? { ...s, tool: lt } : s;
	});
	for (const t of live.tools) if (!seen.has(t.id)) steps.push({ kind: "tool", key: `tc-${t.id}`, tool: t });
	return { steps, liveText: live.text, liveThinking: live.thinking };
}

/**
 * Desktop-parity execution disclosure: quiet ghost header 「已处理 X秒 ›」 /
 * shimmering 「正在处理 X秒… ›」, expanded TurnSummaryRows + steps + right-edge
 * parallel hairline + step-level StatLine.
 */
function ProcessFold({
	turn,
	steps,
	liveThinking,
	liveThinkingActive,
	running,
	parallelMarks,
}: {
	turn: Turn;
	steps: Step[];
	liveThinking: string;
	liveThinkingActive: boolean;
	running: boolean;
	parallelMarks: Map<string, ParallelMark>;
}) {
	const { openStat } = useChatUi();
	const foldPref = usePrefs((s) => s.extra.foldOpen === true);
	const [override, setOverride] = useState<boolean | undefined>(foldOverride.get(turn.id));
	const open = override ?? foldPref;
	const live = liveThinking ? <Thinking id={`th-live-${turn.id}`} text={liveThinking} live={liveThinkingActive} /> : null;

	const turnStats = useMemo(() => {
		const list: RequestStat[] = [];
		for (const s of steps) if (s.kind === "stat") list.push(s.stat);
		if (turn.answerStat) list.push(turn.answerStat.stat);
		return list;
	}, [steps, turn.answerStat]);
	const turnSpanMs = turn.end > turn.start && turn.start ? turn.end - turn.start : undefined;

	// Only reasoning happened (no tools, no in-between text): thinking lines stand on their own.
	if (steps.every((s) => s.kind === "thinking" || s.kind === "stat")) {
		return (
			<div className="mb-1">
				{steps.map((s) => (s.kind === "thinking" ? <StepView key={s.key} step={s} running={running} onStat={openStat} /> : null))}
				{live}
			</div>
		);
	}

	const current = running && !open ? (liveThinking ? null : [...steps].reverse().find((s) => s.kind === "tool")) : null;
	return (
		<div className="mb-2">
			<button
				type="button"
				onClick={() => {
					foldOverride.set(turn.id, !open);
					setOverride(!open);
				}}
				aria-expanded={open}
				className="-mx-1 inline-flex min-h-8 w-fit max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-[13.5px] leading-6 text-m-text-faint transition-colors duration-(--m-dur-fast) active:bg-m-surface-hover active:text-m-text-2"
			>
				<span className={running ? "m-shimmer truncate whitespace-nowrap" : "truncate whitespace-nowrap"}>
					{running ? <RunningLabel start={turn.start} /> : finishedFoldLabel(turn, steps)}
				</span>
				<ChevronRight
					size={12}
					strokeWidth={1.75}
					aria-hidden
					className={`shrink-0 text-m-text-faint transition-transform duration-(--m-dur-fast) ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{open && (
				<div className="flex flex-col gap-0.5 pt-1.5 pb-1">
					<TurnSummaryRows stats={turnStats} durationMs={running ? undefined : turnSpanMs} />
					{steps.map((s) => (
						<StepView
							key={s.key}
							step={s}
							running={running}
							onStat={openStat}
							parallel={parallelMarks.get(s.key)}
						/>
					))}
					{live}
				</div>
			)}
			{!open && running && (live || current) && (
				<div className="pt-1 pb-1">
					{live ?? (current && <StepView step={current} running={running} onStat={openStat} />)}
				</div>
			)}
		</div>
	);
}

const PLAN_CARD_TITLE: Record<"review" | "pending" | "executing" | "completed" | "failed" | "handoff", string> = {
	review: "计划已生成",
	pending: "等待执行确认",
	executing: "计划执行中",
	completed: "计划已完成",
	failed: "计划执行失败",
	handoff: "计划已移交",
};

function PlanCard({
	text,
	sessionId,
	turnId,
	running,
	status,
	title,
	version,
	prevContent,
}: {
	text: string;
	sessionId: string;
	turnId: string;
	running: boolean;
	status: "review" | "pending" | "executing" | "completed" | "failed" | "handoff";
	title?: string | null;
	version?: number;
	prevContent?: string | null;
}) {
	const { controller } = useChatUi();
	const [busy, setBusy] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);

	const execute = async () => {
		setBusy(true);
		try {
			const ok = await controller.approvePlan(turnId, text);
			if (ok) {
				toast("计划已批准，等待执行确认", { kind: "success" });
				setSheetOpen(false);
			}
		} finally {
			setBusy(false);
		}
	};

	const copy = async () => {
		const ok = await copyText(text);
		toast(ok ? "计划已复制" : "复制失败", { kind: ok ? "success" : "error" });
	};

	const download = () => {
		const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `plan-${sessionId.slice(0, 8)}.md`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};

	const annotate = () => {
		controller.stageAnnotation(text, "请按以下要求修改计划：\n");
	};

	return (
		<>
			<div className="mt-3 rounded-2xl border border-m-border bg-m-card p-3.5 shadow-m-card" data-no-longpress>
				<div className="flex items-center gap-2.5">
					<button
						type="button"
						onClick={() => setSheetOpen(true)}
						className="flex min-w-0 flex-1 items-center gap-2.5 text-left active:opacity-75"
					>
						<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-m-surface text-m-accent">
							<ClipboardList size={18} strokeWidth={1.75} aria-hidden />
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[14.5px] font-semibold text-m-text">{PLAN_CARD_TITLE[status]}</span>
								{version != null && version > 0 && (
									<span className="shrink-0 rounded-full bg-m-surface px-1.5 py-0.5 font-m-mono text-[10px] text-m-text-3">
										v{version}
									</span>
								)}
							</div>
							<div className="truncate text-[12px] text-m-text-quiet">
								{status === "review"
									? "点击查看完整方案，或确认执行"
									: status === "pending"
										? "批准请求已接受，正在确认执行状态"
										: "点击查看已批准的计划与执行状态"}
							</div>
						</div>
					</button>
					<IconButton size="sm" icon={<Copy size={17} strokeWidth={1.75} />} label="复制计划" onClick={() => void copy()} />
					<IconButton size="sm" icon={<Download size={17} strokeWidth={1.75} />} label="下载 .md 文件" onClick={download} />
				</div>
				<div className="mt-3 flex flex-wrap gap-2">
					<Button variant="tonal" size="sm" className="whitespace-nowrap" onClick={() => setSheetOpen(true)}>
						查看计划
					</Button>
					{status === "review" && (
						<>
							<Button variant="tonal" size="sm" className="flex-1 whitespace-nowrap" disabled={running || busy} onClick={annotate}>
								修改计划
							</Button>
							<Button variant="primary" size="sm" className="flex-1 whitespace-nowrap" busy={busy} disabled={running} onClick={() => void execute()}>
								执行计划
							</Button>
						</>
					)}
				</div>
			</div>
			<PlanSheet
				open={sheetOpen}
				onClose={() => setSheetOpen(false)}
				text={text}
				sessionId={sessionId}
				status={status}
				title={title}
				version={version}
				prevContent={prevContent}
				running={running}
				approving={busy}
				onApprove={execute}
				onAnnotate={annotate}
			/>
		</>
	);
}
export const TurnView = memo(function TurnView({ turn, isLast, sessionId }: { turn: Turn; isLast: boolean; sessionId: string }) {
	const { openActions, openStat } = useChatUi();
	const sessionCwd = useSession(sessionId)?.cwd ?? "";
	const live = useChat((s) => (isLast ? s.live : null));
	const working = useChat((s) => (isLast ? s.working : false));
	const planMode = useChat((s) => (isLast ? s.cstate?.planMode === true : false));
	const planStatus = useChat((s) => (isLast ? s.cstate?.planStatus : null));
	const acceptedPlan = useChat((s) => (s.acceptedPlan?.turnId === turn.id ? s.acceptedPlan : null));
	const approved = planStatus?.approved;
	const cardStatus = approved?.status ?? (acceptedPlan ? "pending" : "review");
	const planText =
		approved?.content ??
		acceptedPlan?.content ??
		(planStatus?.enabled && planStatus.phase === "review" ? planStatus.content : null);
	const running = isLast && working;
	const parts = useMemo(() => mergeLive(turn, live), [turn, live]);
	// The previous answer row becomes a step once a newer message streams text.
	const steps = useMemo(() => {
		if (parts.liveText && turn.answer) {
			return [...parts.steps, { kind: "text", key: `tx-${turn.answer.id}`, text: turn.answer.text } as Step];
		}
		return parts.steps;
	}, [parts, turn.answer]);
	const parallelMarks = useMemo(
		() => computeParallelMarks(steps, turn.src, live),
		[steps, turn.src, live],
	);
	const answerText = parts.liveText || turn.answer?.text || "";
	const answerStat = parts.liveText ? null : turn.answerStat;
	const answerClock = formatHourMinute(
		answerStat?.stat.completedAt ?? answerStat?.stat.startedAt ?? (turn.end > 0 ? turn.end : null),
	);
	const target = { role: "assistant" as const, text: answerText, entryId: turn.lastAssistantId, canRetry: isLast && !running };
	const lp = useLongPress(() => {
		if (answerText) openActions(target);
	});
	const nothingYet = running && !steps.length && !answerText && !parts.liveThinking;
	const hasProcess = steps.some((s) => s.kind !== "stat") || !!parts.liveThinking;

	const copyAnswer = async () => {
		const ok = await copyText(answerText);
		toast(ok ? "已复制" : "复制失败", { kind: ok ? "success" : "error" });
	};

	return (
		<div>
			{turn.user && <UserBubble item={turn.user} sessionId={sessionId} />}
			{(hasProcess || answerText || nothingYet) && (
				<div className="px-5 pt-2 pb-3">
					{hasProcess && (
						<ProcessFold
							turn={turn}
							steps={steps}
							liveThinking={parts.liveThinking}
							liveThinkingActive={running && !parts.liveText}
							running={running}
							parallelMarks={parallelMarks}
						/>
					)}
					{answerText && (
						<div className="m-selectable" {...lp}>
							<Markdown text={answerText} className="m-msg" streaming={!!parts.liveText && running} />
							{turn.answer && !parts.liveText && <Images sessionId={sessionId} images={turn.answer.images} />}
						</div>
					)}
					{nothingYet && (
						<div className="flex min-h-11 items-center text-m-sm" aria-label="正在回复">
							<span className="m-shimmer">思考中</span>
						</div>
					)}
					{(planText || (planMode && answerText && !parts.liveText && !planStatus)) && (
						<PlanCard
							text={planText || answerText}
							sessionId={sessionId}
							turnId={turn.id}
							running={running}
							status={cardStatus}
							title={approved?.title ?? planStatus?.title}
							version={approved?.version ?? planStatus?.version}
							prevContent={planStatus?.prevContent}
						/>
					)}
					{!running && <TurnDiffCard steps={steps} cwd={sessionCwd} />}
					{answerText && !running && (
						<>
							{answerStat && (
								<div className="mt-1.5">
									<StatLine stat={answerStat.stat} omitTime onOpen={openStat} />
								</div>
							)}
							<div className="mt-1.5 flex items-center gap-1 text-[11px] text-m-text-faint">
								{answerClock && (
									<span className="mr-1 shrink-0 tabular-nums leading-5" title="回复时间">
										{answerClock}
									</span>
								)}
								<button
									type="button"
									aria-label="复制"
									title="复制"
									onClick={() => void copyAnswer()}
									className="m-press flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-m-text-faint active:bg-m-surface-hover active:text-m-text"
								>
									<Copy size={14} strokeWidth={1.75} />
								</button>
								<button
									type="button"
									aria-label="更多操作"
									title="更多操作"
									onClick={(e) => openActions(target, e.currentTarget)}
									className="m-press flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-m-text-faint active:bg-m-surface-hover active:text-m-text"
								>
									<Ellipsis size={14} strokeWidth={1.75} />
								</button>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
});

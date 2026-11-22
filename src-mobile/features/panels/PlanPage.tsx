import { AlertTriangle, Check, CheckCircle2, ChevronDown, ClipboardList, Copy, ListTree, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { PlanStatus } from "../../../src/features/chat/plan/planStatus";
import { api } from "../../core/api";
import { copyText } from "../../core/lib/format";
import { nav, type PageProps } from "../../core/nav";
import { isDraftId } from "../../core/types";
import { AnchoredPopover, Chip, EmptyState, IconButton, PageHeader, PullToRefresh, toast, type ChipTone } from "../../ui";
import { Markdown } from "../../ui/Markdown";
import { LoadGate } from "./PanelState";
import { useLoad, useResync } from "./hooks";
import { usePlanExecution } from "./usePlanExecution";
interface PlanResponse {
	streaming?: boolean;
	planStatus?: PlanStatus | null;
}

interface PlanBadge {
	label: string;
	tone: ChipTone;
	live?: boolean;
}

function planBadge(status: PlanStatus | null): PlanBadge {
	if (status?.approved) {
		switch (status.approved.status) {
			case "executing":
				return { label: "执行中", tone: "accent", live: true };
			case "completed":
				return { label: "已完成", tone: "success" };
			case "failed":
				return { label: "执行失败", tone: "danger" };
			case "handoff":
				return { label: "已移交新会话", tone: "accent" };
		}
	}
	if (status?.enabled) {
		return status.phase === "review"
			? { label: "等待审批", tone: "warn" }
			: { label: "规划中", tone: "accent", live: true };
	}
	if (status && (status.content?.trim() || status.planFile)) {
		return { label: "已保存计划", tone: "neutral" };
	}
	return { label: "暂无计划", tone: "neutral" };
}

function parseChecklistProgress(md: string): { done: number; total: number; nextStep: string | null } | null {
	const lines = md.split("\n");
	let done = 0;
	let total = 0;
	let nextStep: string | null = null;
	for (const line of lines) {
		const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
		if (!m) continue;
		total++;
		if (m[1] !== " ") done++;
		else if (!nextStep) nextStep = m[2].trim();
	}
	return total > 0 ? { done, total, nextStep } : null;
}
interface PlanHeading {
	index: number;
	level: number;
	text: string;
}

function parsePlanHeadings(md: string): PlanHeading[] {
	const headings: PlanHeading[] = [];
	let inFence = false;
	let fenceChar = "";
	for (const rawLine of md.split("\n")) {
		const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			const char = fenceMatch[1][0];
			if (!inFence) {
				inFence = true;
				fenceChar = char;
			} else if (char === fenceChar) {
				inFence = false;
			}
			continue;
		}
		if (inFence) continue;
		const m = rawLine.match(/^(#{1,4})\s+(.+?)\s*#*$/);
		if (!m) continue;
		const cleaned = m[2]
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/[`*_~]/g, "")
			.trim();
		if (!cleaned) continue;
		headings.push({ index: headings.length, level: m[1].length, text: cleaned });
	}
	return headings;
}

export function PlanPanel({ sessionId, embedded = false }: { sessionId: string; embedded?: boolean }) {
	const draft = isDraftId(sessionId);
	const state = useLoad(
		(signal) =>
			draft
				? Promise.resolve<PlanResponse>({ streaming: false, planStatus: null })
				: api<PlanResponse>("GET", `/sessions/${encodeURIComponent(sessionId)}/plan`, undefined, { signal }),
		[sessionId, draft],
	);
	const execution = usePlanExecution(sessionId);
	const status = execution.planStatus ?? state.data?.planStatus ?? null;
	// Never substitute an unrelated ordinary assistant reply when no real plan exists.
	const planContent = status?.approved?.content ?? status?.content ?? null;
	const title = status?.approved?.title ?? status?.title ?? "当前计划";
	const version = status?.approved?.version ?? status?.version ?? 0;
	const badge = planBadge(status);
	const progress = useMemo(() => (planContent ? parseChecklistProgress(planContent) : null), [planContent]);
	const headings = useMemo(() => (planContent ? parsePlanHeadings(planContent) : []), [planContent]);
	const [tocOpen, setTocOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const tocBtnRef = useRef<HTMLButtonElement>(null);
	const mdRootRef = useRef<HTMLDivElement>(null);

	const refresh = () => Promise.all([state.reload(true), execution.reload()]).then(() => {});
	useResync(() => void state.reload(true));

	const copyPlan = () => {
		if (!planContent) return;
		void copyText(planContent).then((ok) => {
			if (!ok) return;
			setCopied(true);
			toast("已复制计划内容", { kind: "success" });
			window.setTimeout(() => setCopied(false), 1500);
		});
	};

	const jumpToHeading = (index: number) => {
		setTocOpen(false);
		const target = mdRootRef.current?.querySelectorAll("h1, h2, h3, h4, h5, h6")[index];
		if (target && typeof target.scrollIntoView === "function") {
			target.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	};

	const content = (
		<>
			{planContent && (
				<div className="shrink-0 border-b border-m-border bg-m-bg-elev/85 px-4 py-2.5 backdrop-blur-md">
					<div className="flex items-center justify-between gap-2">
						<div className="flex min-w-0 flex-1 items-center gap-2">
							<h2 className="m-selectable min-w-0 truncate text-m-md font-semibold text-m-text">{title}</h2>
							<Chip tone={badge.tone} className="shrink-0">
								{badge.live && <span aria-hidden className="m-pulse mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />}
								{badge.label}
							</Chip>
							{version > 0 && <span className="shrink-0 text-m-xs whitespace-nowrap text-m-text-3">v{version}</span>}
						</div>
						<div className="flex shrink-0 items-center gap-0.5">
							<IconButton
								variant="plain"
								size="sm"
								icon={copied ? <Check size={16} className="text-m-success" /> : <Copy size={16} />}
								label="复制计划"
								onClick={copyPlan}
							/>
							<IconButton variant="plain" size="sm" icon={<RefreshCw size={16} />} label="刷新计划" onClick={() => void refresh()} />
						</div>
					</div>
					{(headings.length > 0 || progress !== null) && (
						<div className="mt-2 flex items-center gap-2">
							<button
								ref={tocBtnRef}
								type="button"
								disabled={headings.length === 0}
								aria-expanded={tocOpen}
								onClick={() => setTocOpen((v) => !v)}
								className="m-press flex min-h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-m-pill bg-m-surface px-3 py-1.5 text-left text-m-xs font-medium text-m-text-2 active:bg-m-surface-2 disabled:opacity-50"
							>
								<span className="flex min-w-0 items-center gap-1.5">
									<ListTree size={14} className="shrink-0 text-m-text-3" />
									<span className="truncate whitespace-nowrap">目录 · {headings.length} 章节</span>
								</span>
								<ChevronDown size={14} className={`shrink-0 text-m-text-3 transition-transform ${tocOpen ? "rotate-180" : ""}`} />
							</button>
							{progress && (
								<span
									title={status?.approved?.status === "executing" && progress.nextStep ? `当前：${progress.nextStep}` : undefined}
									className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-m-pill bg-m-accent-soft px-3 py-1.5 text-m-xs font-medium whitespace-nowrap text-m-accent-soft-text"
								>
									<CheckCircle2 size={14} className="shrink-0" />
									<span>
										{progress.done}/{progress.total}
									</span>
								</span>
							)}
						</div>
					)}
				</div>
			)}

			<PullToRefresh onRefresh={refresh}>
				<LoadGate state={state}>
					{() =>
						planContent ? (
							<div className="space-y-3 px-4 pt-3" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 28px)" }}>
								{(status?.approved?.status === "failed" || status?.approved?.error) && (
									<div role="status" className="flex items-start gap-2.5 rounded-m-lg border border-m-border bg-m-danger-bg px-3.5 py-3 text-m-sm text-m-danger">
										<AlertTriangle size={18} className="mt-0.5 shrink-0" />
										<span className="m-selectable min-w-0 flex-1 break-words">
											{status.approved?.error === "aborted"
												? "本次执行已停止"
												: status.approved?.error || "计划执行失败"}
										</span>
									</div>
								)}
								<div ref={mdRootRef} className="m-selectable">
									<Markdown text={planContent} streaming={status?.enabled && !status?.approved && !!state.data?.streaming} />
								</div>
							</div>
						) : (
							<EmptyState
								icon={<ClipboardList size={24} strokeWidth={1.75} />}
								title={status?.enabled ? "正在生成计划" : "暂无计划"}
								hint={status?.enabled ? "计划内容准备好后会实时显示在这里" : "在对话中开启规划模式后，计划与执行进度会显示在这里"}
							/>
						)
					}
				</LoadGate>
			</PullToRefresh>

			<AnchoredPopover
				open={tocOpen && headings.length > 0}
				onClose={() => setTocOpen(false)}
				anchorEl={tocBtnRef.current}
				placement="bottom-start"
				title="计划目录"
				subtitle={`${headings.length} 个章节`}
				minWidth={240}
			>
				<div className="space-y-0.5 py-1">
					{headings.map((h) => (
						<button
							key={`${h.index}-${h.text}`}
							type="button"
							onClick={() => jumpToHeading(h.index)}
							style={{ paddingLeft: `${12 + (h.level - 1) * 12}px` }}
							className="flex min-h-9 w-full items-center rounded-m-md pr-3 text-left text-m-sm text-m-text active:bg-m-surface-hover"
						>
							<span className="truncate">{h.text}</span>
						</button>
					))}
				</div>
			</AnchoredPopover>
		</>
	);

	if (embedded) return <div className="flex h-full min-h-0 flex-1 flex-col bg-m-bg">{content}</div>;

	return (
		<div className="flex h-full flex-col bg-m-bg">
			<PageHeader
				title="计划"
				subtitle={badge.label}
				onBack={() => nav.back()}
				right={<IconButton icon={<RefreshCw size={20} />} label="刷新" onClick={() => void refresh()} />}
			/>
			{content}
		</div>
	);
}
export function PlanPage({ route }: PageProps) {
	return <PlanPanel sessionId={route.params.id} />;
}

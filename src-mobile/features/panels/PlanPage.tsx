import { AlertTriangle, Check, CheckCircle2, ChevronDown, ClipboardList, Copy, GitCompareArrows, ListTree, RefreshCw } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PlanStatus } from "../../../src/features/chat/plan/planStatus";
import { api } from "../../core/api";
import { copyText } from "../../core/lib/format";
import { nav, paths, type PageProps } from "../../core/nav";
import { useSession } from "../../core/stores/sessions";
import { isDraftId } from "../../core/types";
import { AnchoredPopover, Chip, EmptyState, IconButton, PageHeader, PullToRefresh, toast, type ChipTone } from "../../ui";
import { Markdown } from "../../ui/Markdown";
import { ChatCtx } from "../chat/ChatContext";
import {
	computeLineDiff,
	parseChecklistProgress,
	PlanApprovalControls,
	PlanDiffView,
	readDomHeadings,
	type PlanHeading,
} from "../chat/components/PlanSheet";
import { LoadGate } from "./PanelState";
import { useLoad, useResync } from "./hooks";
import { useRightDrawer } from "./rightDrawerStore";
import { executePlanApproval, usePlanExecution, type ApprovePlanOptions } from "./usePlanExecution";
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


export function PlanPanel({ sessionId, embedded = false, active = true }: { sessionId: string; embedded?: boolean; active?: boolean }) {
	const draft = isDraftId(sessionId);
	const chatCtx = useContext(ChatCtx);
	const controller = chatCtx?.controller.id === sessionId ? chatCtx.controller : null;
	const session = useSession(sessionId);
	const state = useLoad(
		(signal) =>
			draft
				? Promise.resolve<PlanResponse>({ streaming: false, planStatus: null })
				: api<PlanResponse>("GET", `/sessions/${encodeURIComponent(sessionId)}/plan`, undefined, { signal }),
		[sessionId, draft],
	);
	const execution = usePlanExecution(sessionId);
	const [settledStatus, setSettledStatus] = useState<PlanStatus | null>(null);
	const status = settledStatus ?? execution.planStatus ?? state.data?.planStatus ?? null;
	// Never substitute an unrelated ordinary assistant reply when no real plan exists.
	const isApprovedView = Boolean(status?.approved?.content);
	const planContent = isApprovedView ? status!.approved!.content : (status?.content ?? null);
	const prevContent = isApprovedView
		? (status!.approved!.prevContent ?? null)
		: (status?.prevContent ?? null);
	const title = status?.approved?.title ?? status?.title ?? "当前计划";
	const version = status?.approved?.version ?? status?.version ?? 0;
	const badge = planBadge(status);
	const progress = useMemo(() => (planContent ? parseChecklistProgress(planContent) : null), [planContent]);
	const hasDiff = Boolean(planContent && prevContent !== null && prevContent !== planContent);
	const [showDiff, setShowDiff] = useState(false);
	const diffLines = useMemo(
		() => (showDiff && hasDiff && planContent && prevContent !== null ? computeLineDiff(prevContent, planContent) : []),
		[showDiff, hasDiff, prevContent, planContent],
	);
	const [headings, setHeadings] = useState<PlanHeading[]>([]);
	const [tocOpen, setTocOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [localApproving, setLocalApproving] = useState(false);
	const tocBtnRef = useRef<HTMLButtonElement>(null);
	const [mdRoot, setMdRoot] = useState<HTMLDivElement | null>(null);
	const approving = controller ? controller.state.planApproving : localApproving;
	const isReview = Boolean(status?.enabled && status.phase === "review" && !status?.approved && planContent);
	const canFresh = Boolean(status?.planFile && session?.cwd);

	useEffect(() => {
		setSettledStatus(null);
	}, [sessionId, state.data?.planStatus, execution.planStatus]);

	useEffect(() => {
		setShowDiff(false);
	}, [planContent, version]);

	useEffect(() => {
		if (!active) setTocOpen(false);
	}, [active]);

	useLayoutEffect(() => {
		if (!planContent || showDiff || !mdRoot) {
			if (!planContent) setHeadings([]);
			return;
		}
		const sync = () => setHeadings(readDomHeadings(mdRoot, `plan-panel-${sessionId.slice(0, 8)}`));
		sync();
		if (typeof MutationObserver === "undefined") return;
		const mo = new MutationObserver(sync);
		mo.observe(mdRoot, { childList: true, subtree: true, characterData: true });
		return () => mo.disconnect();
	}, [mdRoot, planContent, showDiff, sessionId]);

	const refresh = () => Promise.all([state.reload(true), execution.reload()]).then(() => {});
	useResync(() => void state.reload(true));

	const copyPlan = () => {
		if (!planContent) return;
		void copyText(planContent).then((ok) => {
			if (!ok) {
				toast("复制失败", { kind: "error" });
				return;
			}
			setCopied(true);
			toast("已复制计划内容", { kind: "success" });
			window.setTimeout(() => setCopied(false), 1500);
		});
	};

	const jumpToHeading = (index: number) => {
		setTocOpen(false);
		const nodes = Array.from(mdRoot?.querySelectorAll<HTMLElement>("h1, h2, h3, h4") ?? []).filter(
			(n) => (n.textContent ?? "").trim().length > 0,
		);
		const target = nodes[index];
		if (target && typeof target.scrollIntoView === "function") {
			target.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	};

	const handleApprove = async (opts: ApprovePlanOptions) => {
		if (!isReview || approving) return;
		if (controller) {
			const ok = await controller.approvePlan(opts);
			if (ok) await refresh();
			return;
		}
		setLocalApproving(true);
		try {
			const res = await executePlanApproval({
				sessionId,
				planStatus: status,
				mode: opts.mode,
				role: opts.role,
				cwd: session?.cwd,
				sessionMode: session?.mode,
				onPlanStatus: (next) => setSettledStatus(next),
			});
			if (!res.ok) {
				toast(res.error || "计划执行失败", { kind: "error" });
				return;
			}
			if (res.handoffSessionId && res.handoffSessionId !== sessionId) {
				toast("已在新会话中开始执行计划", { kind: "success" });
				nav.push(paths.chat(res.handoffSessionId));
			} else {
				toast("计划已开始执行", { kind: "success" });
				await refresh();
			}
		} finally {
			setLocalApproving(false);
		}
	};

	const handleAnnotate = () => {
		if (!planContent) return;
		if (controller) {
			controller.stageAnnotation(planContent, "请按以下要求修改计划：\n");
			if (embedded) useRightDrawer.getState().closeDrawer();
			controller.focusComposer();
			return;
		}
		useRightDrawer.getState().sendToMainChat(sessionId, {
			quote: planContent,
			comment: "请按以下要求修改计划：\n",
			sourceLabel: "计划",
		});
		if (!embedded) nav.back();
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
							{hasDiff && (
								<IconButton
									variant="plain"
									size="sm"
									icon={<GitCompareArrows size={16} className={showDiff ? "text-m-accent" : undefined} />}
									label="对比版本"
									onClick={() => {
										setShowDiff((v) => !v);
										setTocOpen(false);
									}}
								/>
							)}
							{embedded && (
								<IconButton variant="plain" size="sm" icon={<RefreshCw size={16} />} label="刷新计划" onClick={() => void refresh()} />
							)}
						</div>
					</div>
					{(headings.length > 0 || progress !== null) && (
						<div className="mt-2 flex items-center gap-2">
							<button
								ref={tocBtnRef}
								type="button"
								disabled={showDiff || headings.length === 0}
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
							<div
								className="space-y-3 px-4 pt-3"
								style={{ paddingBottom: isReview ? "24px" : "calc(var(--m-safe-bottom) + 28px)" }}
							>
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
								{showDiff && hasDiff ? (
									<PlanDiffView lines={diffLines} />
								) : (
									<div ref={setMdRoot} className="m-selectable">
										<Markdown text={planContent} sessionId={sessionId} streaming={status?.enabled && !status?.approved && !!state.data?.streaming} />
									</div>
								)}
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

			{isReview && (
				<div
					className="shrink-0 border-t border-m-border/70 bg-m-bg-elev/88 px-3.5 pt-2.5 backdrop-blur-xl"
					style={{ paddingBottom: "calc(var(--m-safe-bottom) + 12px)" }}
				>
					<PlanApprovalControls
						planStatus={status}
						canFresh={canFresh}
						running={Boolean(state.data?.streaming)}
						approving={approving}
						onApprove={handleApprove}
						onAnnotate={handleAnnotate}
					/>
				</div>
			)}

			<AnchoredPopover
				open={active && tocOpen && headings.length > 0}
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
							key={`${h.index}-${h.id}`}
							type="button"
							onClick={() => jumpToHeading(h.index)}
							style={{ paddingLeft: `${12 + (h.level - 1) * 12}px` }}
							className="flex min-h-10 w-full items-center rounded-m-md pr-3 text-left text-m-sm text-m-text active:bg-m-surface-hover"
						>
							<span className="truncate">{h.title}</span>
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
				right={<IconButton icon={<RefreshCw size={20} />} label="刷新计划" onClick={() => void refresh()} />}
			/>
			{content}
		</div>
	);
}
export function PlanPage({ route }: PageProps) {
	return <PlanPanel sessionId={route.params.id} />;
}

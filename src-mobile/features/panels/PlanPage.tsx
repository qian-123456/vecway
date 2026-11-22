import { AlertTriangle, CheckCircle2, ClipboardList, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import type { PlanStatus } from "../../../src/features/chat/plan/planStatus";
import { api } from "../../core/api";
import { nav, type PageProps } from "../../core/nav";
import { isDraftId } from "../../core/types";
import { Chip, EmptyState, IconButton, PageHeader, PullToRefresh, type ChipTone } from "../../ui";
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
	const refresh = () => Promise.all([state.reload(true), execution.reload()]).then(() => {});
	useResync(() => void state.reload(true));

	const content = (
		<PullToRefresh onRefresh={refresh}>
			<LoadGate state={state}>
				{() =>
					planContent ? (
						<div className="space-y-3 px-4 pt-3 pb-8" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 24px)" }}>
							<div className="rounded-m-lg border border-m-border bg-m-card p-3.5">
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<Chip tone={badge.tone}>
												{badge.live && <span aria-hidden className="m-pulse mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />}
												{badge.label}
											</Chip>
											{version > 0 && <span className="text-m-xs whitespace-nowrap text-m-text-3">v{version}</span>}
										</div>
										<h2 className="m-selectable mt-2 text-m-md font-semibold break-words text-m-text">{title}</h2>
									</div>
									{embedded && (
										<IconButton variant="plain" size="sm" icon={<RefreshCw size={17} />} label="刷新计划" onClick={() => void refresh()} />
									)}
								</div>
								{progress && (
									<div className="mt-2.5 flex items-center gap-2 rounded-m-md bg-m-surface px-3 py-2 text-m-xs text-m-text-2">
										<CheckCircle2 size={15} className="shrink-0 text-m-accent" />
										<span className="min-w-0 flex-1 break-words">
											步骤进度 {progress.done}/{progress.total}
											{status?.approved?.status === "executing" && progress.nextStep ? ` · 当前：${progress.nextStep}` : ""}
										</span>
									</div>
								)}
							</div>
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
							<div className="m-selectable px-1 pt-1">
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

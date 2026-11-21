import clsx from "clsx";
import {
	AlertCircle,
	CheckCircle2,
	ChevronRight,
	Clock,
	ExternalLink,
	GitBranch,
	Loader2,
	MessageSquare,
	PauseCircle,
	Play,
	Sparkles,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	AutomationAuthorResult,
	ProbeTestResult,
	Schedule,
	ScheduleRun,
} from "../../lib/contracts";
import { confirmDialog, errMsg } from "../../lib/dialogs";
import { absoluteTime } from "../../lib/format";
import {
	generateScheduleDraft,
	listReleasableScheduleRuns,
	releaseAwaitingScheduleRun,
	testScheduleProbe,
} from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { useT } from "../../stores/language";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import {
	type AutomationScheduleAttention,
	acknowledgeAutomationAttention,
	fixAutomationProbeWithAi,
	openAutomationModifyChat,
	resumeOrOpenAutomationSession,
} from "./automationAttention";
import {
	type AutomationWorktreeState,
	discardAndCleanupWorktree,
	inspectAutomationWorktree,
	mergeAndCleanupWorktree,
} from "./automationWorktree";
import { formatCadence, formatRelativeTime } from "./humanCadence";
import { draftFromSchedule, formatRunDuration } from "./scheduleUtils";
import { useSchedulesStore } from "./schedulesStore";

const EMPTY_RUNS: ScheduleRun[] = [];

type HistorySegment =
	| { kind: "quietGroup"; runs: ScheduleRun[]; key: string }
	| { kind: "skippedGroup"; runs: ScheduleRun[]; key: string }
	| { kind: "single"; run: ScheduleRun };

function groupHistoryRuns(runs: ScheduleRun[]): HistorySegment[] {
	const out: HistorySegment[] = [];
	let batch: { kind: "quiet" | "skipped"; runs: ScheduleRun[] } | null = null;

	const flush = () => {
		if (!batch || batch.runs.length === 0) return;
		if (batch.runs.length === 1) {
			out.push({ kind: "single", run: batch.runs[0]! });
		} else {
			out.push({
				kind: batch.kind === "quiet" ? "quietGroup" : "skippedGroup",
				runs: batch.runs,
				key: `${batch.kind}:${batch.runs[0]!.id}`,
			});
		}
		batch = null;
	};

	for (const r of runs) {
		const isQuiet = r.phase === "probe_quiet" && r.status === "ok";
		const isSkipped = r.status === "skipped";
		if (isQuiet) {
			if (batch?.kind === "quiet") batch.runs.push(r);
			else {
				flush();
				batch = { kind: "quiet", runs: [r] };
			}
		} else if (isSkipped) {
			if (batch?.kind === "skipped") batch.runs.push(r);
			else {
				flush();
				batch = { kind: "skipped", runs: [r] };
			}
		} else {
			flush();
			out.push({ kind: "single", run: r });
		}
	}
	flush();
	return out;
}

function countCoalescedSkips(runs: ScheduleRun[]): number {
	let count = 0;
	for (const r of runs) {
		if (r.status === "skipped") count++;
		else break;
	}
	return count;
}

function buildWorkflowSummaryLine(
	schedule: Schedule,
	locale: "zh-CN" | "en-US",
	t: (k: string) => string,
): string {
	const cadence = formatCadence(schedule.cadence, locale);
	const model = schedule.model
		? schedule.model.split("/").pop() ?? schedule.model
		: t("schedules.defaultModel");
	const worktreePlace =
		locale === "zh-CN"
			? schedule.runMode === "worktree"
				? "独立工作树（Worktree）"
				: "当前目录"
			: schedule.runMode === "worktree"
				? "an isolated worktree"
				: "project directory";

	if (locale === "zh-CN") {
		if (schedule.agentTrigger === "never") {
			if (schedule.invokesExternalModel) {
				return `${t("schedules.overviewHowPrefix")}${cadence}运行本地编排脚本（脚本内调用外部模型）➔ 按约定汇报结果`;
			}
			return `${t("schedules.overviewHowPrefix")}${cadence}仅在本地免费运行脚本（无变化时自动静默折叠）➔ 有结果时汇报`;
		}
		if (schedule.agentTrigger === "on_signal" || schedule.probeCommand?.trim()) {
			return `${t("schedules.overviewHowPrefix")}${cadence}先在原目录免费跑脚本探路（已记位置防重复）➔ 发现新变化才在${worktreePlace}唤醒 ${model} 处理`;
		}
		return `${t("schedules.overviewHowPrefix")}${cadence}到点直接在${worktreePlace}唤醒 ${model} 执行并送达收件箱`;
	}

	if (schedule.agentTrigger === "never") {
		if (schedule.invokesExternalModel) {
			return `${t("schedules.overviewHowPrefix")}${cadence} run local orchestration script (invokes external model) ➔ report summary`;
		}
		return `${t("schedules.overviewHowPrefix")}${cadence} run local script only (quiet runs collapse automatically) ➔ report findings`;
	}
	if (schedule.agentTrigger === "on_signal" || schedule.probeCommand?.trim()) {
		return `${t("schedules.overviewHowPrefix")}${cadence} run free local pre-script first ➔ wake ${model} in ${worktreePlace} only on new signal`;
	}
	return `${t("schedules.overviewHowPrefix")}${cadence} wake ${model} in ${worktreePlace} and deliver summary to Inbox`;
}

function ProbeResultBox({
	result,
	error,
	t,
}: {
	result: ProbeTestResult | null;
	error: string | null;
	t: (k: string) => string;
}) {
	if (!result && !error) return null;
	return (
		<div className="rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] p-2.5 text-xs">
			{error ? (
				<p className="select-text whitespace-pre-wrap break-words text-rose-400">
					{error}
				</p>
			) : (
				result && (
					<div className="space-y-1.5">
						<div className="flex flex-wrap items-center gap-2">
							<span
								className={clsx(
									"inline-flex shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold",
									result.outcome === "error"
										? "border-rose-500/35 bg-rose-500/15 text-rose-400"
										: result.outcome === "signal"
											? "border-amber-500/35 bg-amber-500/15 text-amber-400"
											: "border-emerald-500/35 bg-emerald-500/15 text-emerald-400",
								)}
							>
								{result.outcome === "quiet"
									? t("schedules.probeOutcomeQuiet")
									: result.outcome === "signal"
										? t("schedules.probeOutcomeSignal")
										: result.outcome === "ok"
											? t("schedules.probeOutcomeOk")
											: t("schedules.probeOutcomeError")}
							</span>
							<span className="text-[11px] text-[var(--text-40)]">
								{result.durationMs}ms
							</span>
						</div>
						{result.output.trim() && (
							<pre className="max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--text-60)]">
								{result.output}
							</pre>
						)}
					</div>
				)
			)}
		</div>
	);
}

function RunStatusIcon({
	status,
	isAwaiting,
}: {
	status: ScheduleRun["status"];
	isAwaiting: boolean;
}) {
	if (isAwaiting) {
		return <PauseCircle size={13} className="shrink-0 text-amber-400" />;
	}
	switch (status) {
		case "running":
			return <Loader2 size={13} className="shrink-0 animate-spin text-sky-400" />;
		case "ok":
			return <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />;
		case "error":
			return <AlertCircle size={13} className="shrink-0 text-rose-400" />;
		case "skipped":
			return <PauseCircle size={13} className="shrink-0 text-[var(--text-40)]" />;
	}
}

function formatRunSummaryDisplay(summary: string | null | undefined, locale: "zh-CN" | "en-US"): string | null {
	const trimmed = summary?.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		try {
			const obj = JSON.parse(trimmed) as Record<string, unknown>;
			if (typeof obj.summary === "string" && obj.summary.trim()) {
				return obj.summary.trim();
			}
			const task = typeof obj.task === "string" ? obj.task : null;
			const exitCode = typeof obj.exitCode === "number" ? obj.exitCode : null;
			const err = typeof obj.error === "string" && obj.error.trim() ? obj.error.trim() : null;
			if (err) {
				return locale === "zh-CN" ? `脚本报告异常：${err}` : `Script reported error: ${err}`;
			}
			if (task) {
				return locale === "zh-CN"
					? `脚本执行任务「${task}」${exitCode === 0 ? "完成" : exitCode !== null ? `退出（代码 ${exitCode}）` : "结束"}（展开下方查看完整输出）`
					: `Script ran "${task}" (${exitCode === 0 ? "completed" : `exit ${exitCode}`}; expand output for details)`;
			}
		} catch {
			// not JSON; show as-is
		}
	}
	return trimmed;
}

export interface AutomationOverviewTabProps {
	schedule: Schedule;
	attention: AutomationScheduleAttention | null;
	onSwitchToConfig: () => void;
}

export function AutomationOverviewTab({
	schedule,
	attention,
	onSwitchToConfig,
}: AutomationOverviewTabProps) {
	const { t, locale } = useT();
	const runs = useSchedulesStore((s) => s.runs[schedule.id] ?? EMPTY_RUNS);
	const loadRuns = useSchedulesStore((s) => s.loadRuns);
	const loadSchedules = useSchedulesStore((s) => s.load);
	const markRunSeen = useSchedulesStore((s) => s.markRunSeen);
	const saveSchedule = useSchedulesStore((s) => s.saveSchedule);
	const sessions = useSessions((s) => s.sessions);
	const selectSession = useUi((s) => s.selectSession);

	const [testingProbe, setTestingProbe] = useState(false);
	const [probeResult, setProbeResult] = useState<ProbeTestResult | null>(null);
	const [probeError, setProbeError] = useState<string | null>(null);

	const [worktreeState, setWorktreeState] = useState<AutomationWorktreeState | null>(null);
	const [loadingWorktree, setLoadingWorktree] = useState(false);
	const [mergingWorktree, setMergingWorktree] = useState(false);

	const [generatingFix, setGeneratingFix] = useState(false);
	const [repairSuggestion, setRepairSuggestion] = useState<AutomationAuthorResult | null>(null);
	const [testingFix, setTestingFix] = useState(false);
	const [fixProbeResult, setFixProbeResult] = useState<ProbeTestResult | null>(null);
	const [fixProbeError, setFixProbeError] = useState<string | null>(null);
	const [applyingFix, setApplyingFix] = useState(false);
	const [releasable, setReleasable] = useState<{ scheduleId: string; runs: ScheduleRun[] } | null>(null);
	const [releasingRunId, setReleasingRunId] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void listReleasableScheduleRuns(schedule.id).then(
			(result) => {
				if (!cancelled) setReleasable({ scheduleId: schedule.id, runs: result });
			},
			(e) => {
				if (!cancelled) {
					setReleasable(null);
					toast.error(errMsg(e));
				}
			},
		);
		return () => { cancelled = true; };
	}, [schedule.id, runs]);

	useEffect(() => {
		void loadRuns(schedule.id, 30);
	}, [schedule.id, loadRuns]);

	useEffect(() => {
		setProbeResult(null);
		setProbeError(null);
		setRepairSuggestion(null);
		setFixProbeResult(null);
		setFixProbeError(null);
	}, [schedule.id, schedule.probeCommand]);

	const refreshWorktree = useCallback(async () => {
		if (schedule.runMode !== "worktree") {
			setWorktreeState(null);
			return;
		}
		setLoadingWorktree(true);
		try {
			const res = await inspectAutomationWorktree(schedule, runs, sessions);
			setWorktreeState(res);
		} finally {
			setLoadingWorktree(false);
		}
	}, [schedule, runs, sessions]);

	useEffect(() => {
		void refreshWorktree();
	}, [refreshWorktree]);

	const latestRun = runs[0] ?? null;
	const skippedCount = useMemo(() => countCoalescedSkips(runs), [runs]);
	const isAwaiting =
		attention?.tone === "awaiting" ||
		latestRun?.phase === "awaiting" ||
		schedule.lastRunPhase === "awaiting";
	const isError =
		!isAwaiting &&
		(attention?.tone === "error" ||
			latestRun?.status === "error" ||
			schedule.lastRunStatus === "error");
	const isScriptError =
		isError &&
		Boolean(
			attention?.probeError ||
				latestRun?.phase === "probe_only" ||
				(schedule.probeCommand?.trim() && !latestRun?.sessionId),
		);
	const awaitingSessionId =
		attention?.sessionId ?? latestRun?.sessionId ?? schedule.lastRunSessionId ?? null;
	const matchingAwaitingRuns = (releasable?.scheduleId === schedule.id ? releasable.runs : [])
		.filter((run) => run.phase === "awaiting" && run.sessionId === awaitingSessionId);
	const awaitingRunId = matchingAwaitingRuns.length === 1 ? matchingAwaitingRuns[0]!.id : undefined;

	const runDryProbe = async (cmd: string, isRepair = false) => {
		const trimmed = cmd.trim();
		if (!trimmed) return;
		if (isRepair) {
			setTestingFix(true);
			setFixProbeError(null);
		} else {
			setTestingProbe(true);
			setProbeError(null);
		}
		try {
			const res = await testScheduleProbe({
				cwd: schedule.cwd || ".",
				probeCommand: trimmed,
				agentTrigger: schedule.agentTrigger ?? "always",
				scheduleId: schedule.id,
			});
			if (isRepair) setFixProbeResult(res);
			else setProbeResult(res);
		} catch (e) {
			const msg = errMsg(e);
			if (isRepair) {
				setFixProbeResult(null);
				setFixProbeError(msg);
			} else {
				setProbeResult(null);
				setProbeError(msg);
			}
		} finally {
			if (isRepair) setTestingFix(false);
			else setTestingProbe(false);
		}
	};

	const handleGenerateInlineFix = async () => {
		if (!schedule.probeCommand?.trim() || generatingFix) return;
		setGeneratingFix(true);
		try {
			const errContext =
				latestRun?.probeOutput?.trim() ||
				latestRun?.summary?.trim() ||
				"脚本执行失败，请排查 PATH、语法、退出码语义及工作目录";
			const res = await generateScheduleDraft({
				request: [
					"当前前置脚本运行失败，请定位根因并只修复该脚本命令（保持原目标与频率不变）。",
					`原命令：${schedule.probeCommand}`,
					`报错输出：\n${errContext}`,
				].join("\n"),
				cwd: schedule.cwd || ".",
				current: {
					...draftFromSchedule(schedule),
					id: schedule.id,
				},
			});
			setRepairSuggestion(res);
			setFixProbeResult(null);
			setFixProbeError(null);
		} catch (e) {
			toast.error(errMsg(e));
		} finally {
			setGeneratingFix(false);
		}
	};

	const handleApplyFixAndResume = async () => {
		if (!repairSuggestion?.probeCommand || applyingFix) return;
		setApplyingFix(true);
		try {
			const baseDraft = draftFromSchedule(schedule);
			const saved = await saveSchedule({
				...baseDraft,
				id: schedule.id,
				name: schedule.name,
				probeCommand: repairSuggestion.probeCommand,
				probeDescription:
					repairSuggestion.probeDescription ?? schedule.probeDescription ?? null,
				enabled: true,
			});
			if (saved) {
				await acknowledgeAutomationAttention(schedule.id);
				setRepairSuggestion(null);
				void loadRuns(schedule.id, 30);
			}
		} finally {
			setApplyingFix(false);
		}
	};

	const handleMergeWorktree = async () => {
		if (!worktreeState || mergingWorktree) return;
		setMergingWorktree(true);
		try {
			await mergeAndCleanupWorktree(worktreeState, schedule.name);
			await acknowledgeAutomationAttention(schedule.id);
			toast.success(
				t("schedules.overviewMergedSuccess", { branch: worktreeState.branch }),
			);
			setWorktreeState(null);
			void loadSchedules();
			void loadRuns(schedule.id, 30);
		} catch (e) {
			toast.error(errMsg(e));
		} finally {
			setMergingWorktree(false);
		}
	};

	const handleDiscardWorktree = async () => {
		if (!worktreeState || mergingWorktree) return;
		const confirmed = await confirmDialog(
			t("schedules.overviewDiscardWorktreeConfirm", {
				branch: worktreeState.branch,
			}),
			{
				title: t("schedules.overviewDiscardWorktree"),
				okLabel: t("schedules.overviewDiscardWorktree"),
				danger: true,
			},
		);
		if (!confirmed) return;
		setMergingWorktree(true);
		try {
			await discardAndCleanupWorktree(worktreeState);
			await acknowledgeAutomationAttention(schedule.id);
			toast.success(t("schedules.overviewDiscardedSuccess"));
			setWorktreeState(null);
			void loadSchedules();
			void loadRuns(schedule.id, 30);
		} catch (e) {
			toast.error(errMsg(e));
		} finally {
			setMergingWorktree(false);
		}
	};

	const handleReleaseAwaiting = async (run: ScheduleRun) => {
		if (releasingRunId) return;
		setReleasingRunId(run.id);
		const confirmed = await confirmDialog(t("schedules.releaseAwaitingConfirm"), {
			title: t("schedules.releaseAwaiting"),
			okLabel: t("schedules.releaseAwaiting"),
			danger: true,
		});
		if (!confirmed) {
			setReleasingRunId(null);
			return;
		}
		try {
			await releaseAwaitingScheduleRun(schedule.id, run.id);
			setReleasable((current) =>
				current?.scheduleId === schedule.id
					? { ...current, runs: current.runs.filter((item) => item.id !== run.id) }
					: current,
			);
			await Promise.all([loadRuns(schedule.id, 30), loadSchedules()]);
		} catch (e) {
			toast.error(errMsg(e));
		} finally {
			setReleasingRunId(null);
		}
	};

	const openRunSession = (run: ScheduleRun) => {
		markRunSeen(run.id);
		if (run.sessionId) {
			selectSession(run.sessionId);
		}
	};

	const groupedRuns = useMemo(() => groupHistoryRuns(runs), [runs]);
	const oneLineSummary = useMemo(
		() => buildWorkflowSummaryLine(schedule, locale, t),
		[schedule, locale, t],
	);
	const hasProbe =
		Boolean(schedule.probeCommand?.trim()) || schedule.agentTrigger !== "always";

	return (
		<div className="@container space-y-3.5">
			{/* 1. Compact 1-Line Plain Workflow Bar + Expandable Script/Prompt Details */}
			<section aria-label={t("schedules.detailWorkflowTitle")}>
				<details className="group rounded-xl border border-[var(--border-divider)] bg-[var(--bg-panel)] px-3.5 py-2.5 text-xs">
					<summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[var(--text)] hover:opacity-90">
						<span className="min-w-0 truncate">{oneLineSummary}</span>
						<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-[var(--text-40)]">
							<span>{t("schedules.overviewViewScriptsAndPrompt")}</span>
							<ChevronRight
								size={12}
								className="shrink-0 transition-transform group-open:rotate-90"
							/>
						</span>
					</summary>

					<div className="mt-2.5 space-y-2.5 border-t border-[var(--border-divider)] pt-3 text-[11.5px]">
						{hasProbe && schedule.agentTrigger !== "never" && (
							<div className="grid grid-cols-1 gap-2 @[460px]:grid-cols-2">
								<div className="rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-3 py-2 text-[var(--text-60)]">
									<div className="font-medium text-[var(--text)]">
										{t("schedules.overviewProbeCardTitle")}
									</div>
									<p className="mt-0.5 leading-relaxed">
										{t("schedules.overviewProbeCardDesc")}
									</p>
								</div>
								<div className="rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-3 py-2 text-[var(--text-60)]">
									<div className="font-medium text-[var(--text)]">
										{t("schedules.overviewAgentCardTitle")}
									</div>
									<p className="mt-0.5 leading-relaxed">
										{schedule.runMode === "worktree"
											? t("schedules.overviewAgentCardDescWorktree")
											: t("schedules.overviewAgentCardDescLocal")}
									</p>
								</div>
							</div>
						)}

						{schedule.probeCommand?.trim() && (
							<div className="space-y-1.5">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="inline-flex items-center gap-1.5 text-[var(--text-60)]">
										<Terminal size={12} className="shrink-0 text-[var(--text-40)]" />
										<span>
											{schedule.probeDescription?.trim() ||
												t("schedules.probeCommandLabel")}
										</span>
									</span>
									<button
										type="button"
										disabled={testingProbe}
										onClick={() => void runDryProbe(schedule.probeCommand!, false)}
										className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
									>
										{testingProbe ? (
											<Loader2 size={10} className="shrink-0 animate-spin" />
										) : (
											<Play size={9} className="shrink-0" />
										)}
										<span>
											{testingProbe
												? t("schedules.testingProbeBtn")
												: t("schedules.overviewRunProbeNow")}
										</span>
									</button>
								</div>
								<pre className="select-text overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-3 py-2 font-mono text-[11px] text-[var(--text)]">
									{schedule.probeCommand}
								</pre>
								<p className="text-[11px] text-[var(--text-40)]">
									{t("schedules.overviewProbeStateCursorHint")}
								</p>
								<ProbeResultBox
									result={probeResult}
									error={probeError}
									t={t}
								/>
							</div>
						)}

						{schedule.agentTrigger !== "never" && schedule.prompt.trim() && (
							<div className="space-y-1">
								<div className="text-[var(--text-60)]">
									{t("schedules.stepActionTitle")}
								</div>
								<pre className="select-text whitespace-pre-wrap break-words rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-3 py-2 font-sans text-[11.5px] leading-relaxed text-[var(--text)]">
									{schedule.prompt}
								</pre>
							</div>
						)}
					</div>
				</details>
			</section>

			{/* 2A. PR-Style Error & Repair Comparison Card */}
			{isError && (
				<section
					aria-label={t("schedules.statusBadgeScriptError")}
					className="space-y-3 rounded-xl border border-rose-500/35 bg-rose-500/8 p-3.5"
				>
					<div className="space-y-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className="inline-flex shrink-0 items-center whitespace-nowrap rounded border border-rose-500/35 bg-rose-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-rose-700 dark:text-rose-300">
								{isScriptError
									? t("schedules.statusBadgeScriptError")
									: t("schedules.statusBadgeRunError")}
							</span>
							<h2 className="text-[13px] font-semibold text-[var(--text)]">
								{isScriptError
									? t("schedules.overviewErrorHeadlineScript")
									: t("schedules.overviewErrorHeadlineRun")}
							</h2>
						</div>
						{latestRun?.summary?.trim() && (
							<p className="select-text whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--text-60)]">
								{latestRun.summary}
							</p>
						)}
					</div>

					{latestRun?.probeOutput?.trim() && (
						<details
							open
							className="rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-3 py-2 text-xs"
						>
							<summary className="cursor-pointer list-none text-[11px] font-medium text-[var(--text-60)] hover:text-[var(--text)]">
								{t("schedules.overviewTerminalOutput")}
							</summary>
							<pre className="mt-1.5 max-h-44 select-text overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border-divider)] bg-[var(--bg-panel)] p-2 font-mono text-[11px] text-rose-700 dark:text-rose-300">
								{latestRun.probeOutput}
							</pre>
						</details>
					)}

					{repairSuggestion?.probeCommand && (
						<div className="space-y-2 rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] p-3">
							<div className="text-[11px] font-medium text-[var(--text-60)]">
								{t("schedules.overviewFixDiffHeader")}
							</div>
							<pre className="select-text overflow-x-auto whitespace-pre-wrap break-words rounded border border-[var(--border-divider)] bg-[var(--bg-panel)] p-2 font-mono text-[11px] leading-relaxed">
								<span className="block text-rose-700 dark:text-rose-300">
									- {schedule.probeCommand}
								</span>
								<span className="block text-emerald-700 dark:text-emerald-300">
									+ {repairSuggestion.probeCommand}
								</span>
							</pre>
							{repairSuggestion.explanation && (
								<p className="text-[11.5px] text-[var(--text-60)]">
									{repairSuggestion.explanation}
								</p>
							)}
							<ProbeResultBox
								result={fixProbeResult}
								error={fixProbeError}
								t={t}
							/>
						</div>
					)}

					<div className="flex flex-wrap items-center justify-end gap-2">
						{latestRun?.sessionId && (
							<button
								type="button"
								onClick={() => openRunSession(latestRun)}
								className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-60)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
							>
								<span>{t("schedules.detailOpenSession")}</span>
								<ExternalLink size={11} className="shrink-0" />
							</button>
						)}

						<button
							type="button"
							onClick={onSwitchToConfig}
							className="inline-flex shrink-0 items-center whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-60)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
						>
							{t("schedules.overviewGoConfigFix")}
						</button>

						{isScriptError && schedule.probeCommand?.trim() && (
							<>
								{repairSuggestion?.probeCommand ? (
									<>
										<button
											type="button"
											disabled={testingFix}
											onClick={() =>
												void runDryProbe(repairSuggestion.probeCommand!, true)
											}
											className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
										>
											{testingFix ? (
												<Loader2 size={11} className="shrink-0 animate-spin" />
											) : (
												<Play size={10} className="shrink-0" />
											)}
											<span>{t("schedules.overviewTestFixedProbe")}</span>
										</button>
										<button
											type="button"
											disabled={applyingFix}
											onClick={() => void handleApplyFixAndResume()}
											className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-emerald-300 px-3 py-1 text-[11.5px] font-semibold text-neutral-950 hover:bg-emerald-200 disabled:opacity-45"
										>
											{applyingFix && (
												<Loader2 size={11} className="shrink-0 animate-spin" />
											)}
											<span>{t("schedules.overviewApplyFixAndResume")}</span>
										</button>
									</>
								) : (
									<button
										type="button"
										disabled={generatingFix}
										onClick={() => void handleGenerateInlineFix()}
										className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
									>
										{generatingFix ? (
											<Loader2 size={11} className="shrink-0 animate-spin" />
										) : (
											<Sparkles size={11} className="shrink-0 text-rose-300" />
										)}
										<span>
											{generatingFix
												? t("schedules.overviewGeneratingInlineFix")
												: t("schedules.overviewGenerateInlineFix")}
										</span>
									</button>
								)}

								<button
									type="button"
									onClick={() =>
										void fixAutomationProbeWithAi(
											schedule,
											latestRun?.probeOutput || latestRun?.summary || "",
										)
									}
									className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-rose-300 px-3 py-1 text-[11.5px] font-semibold text-neutral-950 hover:bg-rose-200"
								>
									{t("schedules.overviewGoChatDeepFix")}
								</button>
							</>
						)}
					</div>
				</section>
			)}

			{/* 2B. PR-Style Awaiting Confirmation / Worktree Patch Review Card */}
			{!isError && (isAwaiting || worktreeState || loadingWorktree) && (
				<section
					aria-label={t("schedules.statusBadgeAwaitingConfirm")}
					className="space-y-3 rounded-xl border border-amber-500/35 bg-amber-500/8 p-3.5"
				>
					<div className="space-y-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className="inline-flex shrink-0 items-center whitespace-nowrap rounded border border-amber-500/35 bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
								{worktreeState
									? t("schedules.statusBadgePatchReady")
									: t("schedules.statusBadgeAwaitingConfirm")}
							</span>
							<h2 className="text-[13px] font-semibold text-[var(--text)]">
								{worktreeState
									? t("schedules.overviewAwaitingHeadlinePatch")
									: t("schedules.overviewAwaitingHeadline")}
							</h2>
						</div>
						<p className="text-[11.5px] leading-relaxed text-[var(--text-60)]">
							{skippedCount > 0
								? t("schedules.overviewAwaitingAntiPileup", {
										count: skippedCount,
									})
								: t("schedules.overviewAwaitingAntiPileupZero")}
						</p>
					</div>

					{loadingWorktree && !worktreeState ? (
						<div className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-40)]">
							<Loader2 size={12} className="shrink-0 animate-spin" />
							<span>{t("schedules.overviewWorktreeDiffLoading")}</span>
						</div>
					) : (
						worktreeState && (
							<details
								open
								className="rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-3 py-2 text-xs"
							>
								<summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[var(--text)]">
									<span className="inline-flex items-center gap-1.5 font-medium">
										<GitBranch size={12} className="shrink-0 text-amber-300" />
										<span>
											{t("schedules.overviewWorktreeDiffTitle", {
												branch: worktreeState.branch,
											})}
										</span>
									</span>
									{(worktreeState.stats.added > 0 ||
										worktreeState.stats.removed > 0) && (
										<span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-[var(--text-60)]">
											+{worktreeState.stats.added} / -{worktreeState.stats.removed}
										</span>
									)}
								</summary>
								<div className="mt-2">
									{worktreeState.combinedDiff.trim() ? (
										<pre className="max-h-64 select-text overflow-auto rounded border border-[var(--border-divider)] bg-[var(--bg-panel)] p-2.5 font-mono text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-300">
											{worktreeState.combinedDiff}
										</pre>
									) : (
										<p className="text-[11.5px] text-[var(--text-40)]">
											{t("schedules.overviewWorktreeDiffEmpty")}
										</p>
									)}
								</div>
							</details>
						)
					)}

					<div className="flex flex-wrap items-center justify-end gap-2">
						{awaitingSessionId && (
							<button
								type="button"
								onClick={() =>
									void resumeOrOpenAutomationSession(
										schedule,
										awaitingSessionId,
										isAwaiting,
										awaitingRunId,
									)
								}
								className={clsx(
									"inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-3 py-1 text-[11.5px] font-medium",
									worktreeState
										? "border border-[var(--border-divider)] bg-[var(--bg-panel)] text-[var(--text)] hover:bg-[var(--bg-hover)]"
										: "bg-amber-300 font-semibold text-neutral-950 hover:bg-amber-200",
								)}
							>
								<MessageSquare size={11} className="shrink-0" />
								<span>
									{worktreeState
										? t("schedules.overviewTweakInChat")
										: t("schedules.overviewGoContinueChat")}
								</span>
							</button>
						)}

						{!awaitingSessionId && (
							<button
								type="button"
								onClick={() => openAutomationModifyChat(schedule)}
								className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text)] hover:bg-[var(--bg-hover)]"
							>
								<MessageSquare size={11} className="shrink-0" />
								<span>{t("schedules.overviewTweakInChat")}</span>
							</button>
						)}

						{worktreeState && (
							<>
								<button
									type="button"
									disabled={mergingWorktree}
									onClick={() => void handleDiscardWorktree()}
									className="inline-flex shrink-0 items-center whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-60)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-45"
								>
									{t("schedules.overviewDiscardWorktree")}
								</button>
								<button
									type="button"
									disabled={mergingWorktree}
									onClick={() => void handleMergeWorktree()}
									className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-amber-300 px-3 py-1 text-[11.5px] font-semibold text-neutral-950 hover:bg-amber-200 disabled:opacity-45"
								>
									{mergingWorktree && (
										<Loader2 size={11} className="shrink-0 animate-spin" />
									)}
									<span>
										{mergingWorktree
											? t("schedules.overviewMerging")
											: t("schedules.overviewApproveAndMerge")}
									</span>
								</button>
							</>
						)}
					</div>
				</section>
			)}

			{releasable?.scheduleId === schedule.id && releasable.runs
				.filter((run) => run.phase === "awaiting" && run.status !== "running" && run.status !== "skipped")
				.map((run) => (
					<div key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/35 bg-amber-500/8 p-3 text-xs">
						<span>{t("schedules.releaseAwaitingRun")}: {absoluteTime(run.startedAt)}</span>
						<div className="flex flex-wrap gap-2">
							{run.sessionId && (
								<button
									type="button"
									disabled={releasingRunId !== null}
									onClick={async () => {
										setReleasingRunId(run.id);
										try {
											await resumeOrOpenAutomationSession(schedule, run.sessionId!, true, run.id);
										} finally {
											setReleasingRunId(null);
										}
									}}
									className="rounded-lg bg-amber-300 px-2.5 py-1 font-medium text-neutral-950 hover:bg-amber-200 disabled:opacity-45"
								>
									{t("schedules.continueAwaiting")}
								</button>
							)}
							<button
								type="button"
								disabled={releasingRunId !== null}
								onClick={() => void handleReleaseAwaiting(run)}
								className="rounded-lg border border-amber-500/35 px-2.5 py-1 font-medium text-amber-700 hover:bg-amber-500/15 disabled:opacity-45 dark:text-amber-300"
							>
								{t("schedules.releaseAwaiting")}
							</button>
						</div>
					</div>
				))}

			{/* 3. Compact Run History */}
			<section aria-label={t("schedules.overviewHistoryHeader")} className="space-y-1.5">
				<div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
					<h2 className="text-[12px] font-medium text-[var(--text-60)]">
						{t("schedules.overviewHistoryHeader")}
					</h2>
					<span className="text-[11px] text-[var(--text-40)]">
						{t("schedules.overviewQuietCollapsedHint")}
					</span>
				</div>

				{runs.length === 0 ? (
					<div className="rounded-xl border border-[var(--border-divider)] bg-[var(--bg-panel)] py-10 text-center">
						<Clock size={16} className="mx-auto text-[var(--text-40)]" />
						<p className="mt-2 text-xs text-[var(--text-40)]">
							{t("schedules.noRunHistory")}
						</p>
					</div>
				) : (
					<div className="divide-y divide-[var(--border-divider)] rounded-xl border border-[var(--border-divider)] bg-[var(--bg-panel)]">
						{groupedRuns.map((seg) => {
							if (seg.kind === "quietGroup" || seg.kind === "skippedGroup") {
								const first = seg.runs[0]!;
								const last = seg.runs[seg.runs.length - 1]!;
								const isQuietGroup = seg.kind === "quietGroup";
								return (
									<details
										key={seg.key}
										className="group px-3.5 py-2.5 text-xs"
									>
										<summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
											<ChevronRight
												size={12}
												className="shrink-0 text-[var(--text-40)] transition-transform group-open:rotate-90"
											/>
											{isQuietGroup ? (
												<CheckCircle2
													size={12}
													className="shrink-0 text-emerald-400/80"
												/>
											) : (
												<PauseCircle
													size={12}
													className="shrink-0 text-amber-400/80"
												/>
											)}
											<span className="text-[var(--text-60)]">
												{isQuietGroup
													? t("schedules.quietChecksCollapsed", {
															count: seg.runs.length,
														})
													: t("schedules.overviewSkippedCollapsed", {
															count: seg.runs.length,
														})}
											</span>
											<span className="ml-auto whitespace-nowrap text-[11px] text-[var(--text-40)]">
												{absoluteTime(last.startedAt)} —{" "}
												{absoluteTime(first.startedAt)}
											</span>
										</summary>
										<div className="mt-2 space-y-1 border-t border-[var(--border-divider)] pt-2">
											{seg.runs.map((r) => (
												<div
													key={r.id}
													className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-40)]"
												>
													<span>{absoluteTime(r.startedAt)}</span>
													<span>{formatRunDuration(r)}</span>
													<span>
														{r.summary ||
															(isQuietGroup
																? t("schedules.probeOutcomeQuiet")
																: t("schedules.runStatusSkipped"))}
													</span>
												</div>
											))}
										</div>
									</details>
								);
							}

							const r = seg.run;
							const runIsAwaiting = r.phase === "awaiting" && Boolean(r.sessionId);
							const statusLabel = runIsAwaiting
								? t("schedules.badgeAwaiting")
								: r.phase === "probe_quiet" && r.status === "ok"
									? t("schedules.probeOutcomeQuiet")
									: r.status === "running"
										? t("schedules.runStatusRunning")
										: r.status === "ok"
											? t("schedules.runStatusOk")
											: r.status === "error"
												? t("schedules.runStatusError")
												: t("schedules.runStatusSkipped");

							return (
								<div key={r.id} className="space-y-1.5 px-3.5 py-2.5 text-xs">
									<div className="flex flex-wrap items-start justify-between gap-2">
										<div className="flex min-w-0 flex-1 items-start gap-2">
											<div className="mt-0.5">
												<RunStatusIcon
													status={r.status}
													isAwaiting={runIsAwaiting}
												/>
											</div>
											<div className="min-w-0 flex-1 space-y-0.5">
												<div className="flex flex-wrap items-center gap-2">
													<span
														className={clsx(
															"whitespace-nowrap font-medium",
															runIsAwaiting
																? "text-amber-300"
																: r.status === "ok"
																	? "text-emerald-300"
																	: r.status === "error"
																		? "text-rose-300"
																		: r.status === "running"
																			? "text-sky-300"
																			: "text-[var(--text-60)]",
														)}
													>
														{statusLabel}
													</span>
													<span
														className="text-[11px] text-[var(--text-40)]"
														title={absoluteTime(r.startedAt)}
													>
														{formatRelativeTime(r.startedAt, locale)}
													</span>
													<span className="text-[11px] text-[var(--text-40)]">
														{formatRunDuration(r)}
													</span>
												</div>
												{formatRunSummaryDisplay(r.summary, locale) && (
													<p className="select-text whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-[var(--text-60)]">
														{formatRunSummaryDisplay(r.summary, locale)}
													</p>
												)}
											</div>
										</div>

										<div className="flex shrink-0 items-center gap-1.5">
											{runIsAwaiting && r.sessionId && (
												<button
													type="button"
													onClick={() => {
														markRunSeen(r.id);
														void resumeOrOpenAutomationSession(
															schedule,
															r.sessionId!,
															true,
															r.id,
														);
													}}
													className="inline-flex shrink-0 items-center whitespace-nowrap rounded-lg border border-amber-500/35 bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25"
												>
													{t("schedules.continueAwaiting")}
												</button>
											)}
											{r.sessionId && (
												<button
													type="button"
													onClick={() => openRunSession(r)}
													className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-60)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
												>
													<span>{t("schedules.detailOpenSession")}</span>
													<ExternalLink size={10} className="shrink-0" />
												</button>
											)}
										</div>
									</div>

									{r.probeOutput &&
										r.probeOutput.trim() !== (r.summary ?? "").trim() &&
										!(isError && r.id === latestRun?.id) && (
											<details className="group pl-5 text-xs">
												<summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-[var(--text-40)] hover:text-[var(--text)]">
													<ChevronRight
														size={11}
														className="shrink-0 transition-transform group-open:rotate-90"
													/>
													<span>{t("schedules.detailViewProbeOutput")}</span>
												</summary>
												<pre className="mt-1.5 max-h-44 select-text overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--text-60)]">
													{r.probeOutput}
												</pre>
											</details>
										)}
								</div>
							);
						})}
					</div>
				)}
			</section>
		</div>
	);
}

/**
 * Mobile automation Overview view (Wave 5D):
 * - Workflow summary card with collapsible probe script & prompt
 * - Failure diagnosis & 1-click AI script fix (`POST /left/schedules/generate-draft` -> probe test -> apply & re-enable, or open AI troubleshooting chat)
 * - Scoped worktree changes review, diff preview, merge & cleanup, or discard
 * - Awaiting-confirmation runs (resume / release)
 * - Run history collapsing consecutive `probe_quiet` & `skipped` runs, formatting structured JSON summaries,
 *   showing expandable `probeOutput`, and opening linked chat sessions.
 */
import {
	AlertTriangle,
	CalendarClock,
	Check,
	ChevronDown,
	Cpu,
	FolderGit2,
	GitMerge,
	History,
	MessageSquare,
	Play,
	Sparkles,
	Terminal,
	Trash2,
	Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../core/api";
import { nav, paths } from "../../core/nav";
import { useMobileSchedules } from "../../core/stores/schedules";
import { Button, Chip, confirm, EmptyState, ListGroup, ListRow, PullToRefresh, toast } from "../../ui";
import { startAutomationChat } from "../chat/automation/automationStatus";
import { LoadState, useLoad } from "./controls";
import {
	AGENT_TRIGGER_LABEL,
	buildExistingAutomationSystemPrompt,
	cadenceText,
	fmtTime,
	formatRunSummary,
	formFromSchedule,
	buildPayload,
	resolveAgentTrigger,
	runPhaseBadge,
	RUN_STATUS_LABEL,
	runDurationText,
	runTone,
	type AutomationAuthorResult,
	type AutomationWorktreeState,
	type ProbeTestResult,
	type Schedule,
	type ScheduleRun,
} from "./schedule";

const enc = encodeURIComponent;

type HistoryEntry =
	| { kind: "run"; run: ScheduleRun }
	| { kind: "collapsed"; label: string; groupKind: "quiet" | "skipped"; runs: ScheduleRun[] };

/** Collapse consecutive quiet probe runs or skipped runs so actionable history stays prominent. */
export function collapseHistoryRuns(runs: readonly ScheduleRun[]): HistoryEntry[] {
	const out: HistoryEntry[] = [];
	let i = 0;
	while (i < runs.length) {
		const r = runs[i];
		const isQuiet = r.phase === "probe_quiet" && r.status === "ok";
		const isSkipped = r.status === "skipped";
		if (isQuiet || isSkipped) {
			const group: ScheduleRun[] = [r];
			let j = i + 1;
			while (j < runs.length) {
				const next = runs[j];
				const same = isQuiet
					? next.phase === "probe_quiet" && next.status === "ok"
					: next.status === "skipped";
				if (!same) break;
				group.push(next);
				j++;
			}
			if (group.length >= 2) {
				out.push({
					kind: "collapsed",
					groupKind: isQuiet ? "quiet" : "skipped",
					label: isQuiet
						? `连续 ${group.length} 次静默检查（无信号，0 Token）`
						: `连续 ${group.length} 次跳过`,
					runs: group,
				});
				i = j;
				continue;
			}
		}
		out.push({ kind: "run", run: r });
		i++;
	}
	return out;
}

export function AutomationOverviewView({
	id,
	schedule: externalSchedule,
	onScheduleChange,
}: {
	id: string;
	schedule?: Schedule | null;
	onScheduleChange?: () => void;
}) {
	const runs = useLoad(async () => {
		const res = await api<ScheduleRun[]>("GET", `/left/schedules/${enc(id)}/runs?limit=50`);
		return Array.isArray(res) ? res : [];
	}, [id]);
	const schedLoad = useLoad(async () => {
		const res = await api<Schedule[]>("GET", "/left/schedules");
		return Array.isArray(res) ? (res.find((s) => s.id === id) ?? null) : null;
	}, [id]);
	const awaiting = useLoad(async () => {
		const res = await api<ScheduleRun[]>("GET", `/left/schedules/${enc(id)}/awaiting`);
		return Array.isArray(res) ? res : [];
	}, [id]);
	const worktree = useLoad(
		() =>
			api<AutomationWorktreeState | null>("GET", `/left/schedules/${enc(id)}/worktree`).catch(
				() => null,
			),
		[id],
	);

	const schedule = externalSchedule ?? schedLoad.data;

	const [busyRun, setBusyRun] = useState<{ id: string; action: "resume" | "release" } | null>(null);
	const [showScript, setShowScript] = useState(false);
	const [showPrompt, setShowPrompt] = useState(false);
	const [showDiff, setShowDiff] = useState(false);
	const [wtBusy, setWtBusy] = useState<"merge" | "discard" | null>(null);
	const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
	const [expandedProbeRuns, setExpandedProbeRuns] = useState<Record<string, boolean>>({});

	// AI diagnosis / 1-click fix state
	const [diagnosing, setDiagnosing] = useState(false);
	const [fixSuggestion, setFixSuggestion] = useState<AutomationAuthorResult | null>(null);
	const [fixProbeTesting, setFixProbeTesting] = useState(false);
	const [fixProbeResult, setFixProbeResult] = useState<ProbeTestResult | null>(null);
	const [applyingFix, setApplyingFix] = useState(false);
	const [launchingChat, setLaunchingChat] = useState(false);

	useEffect(() => {
		if (schedule?.lastRunAt) {
			useMobileSchedules.getState().markSeen(schedule.id, schedule.lastRunAt);
		}
	}, [schedule?.id, schedule?.lastRunAt]);

	const reloadAll = async () => {
		await Promise.all([runs.reload(), schedLoad.reload(), awaiting.reload(), worktree.reload()]);
		onScheduleChange?.();
	};

	const detailVersion = useMobileSchedules((s) => s.detailVersion);
	const prevDetailVersionRef = useRef(detailVersion);
	useEffect(() => {
		useMobileSchedules.getState().ensureSse?.();
	}, []);
	useEffect(() => {
		if (prevDetailVersionRef.current === detailVersion) return;
		prevDetailVersionRef.current = detailVersion;
		void reloadAll().catch(() => {});
	}, [detailVersion]);
	const resume = async (run: ScheduleRun) => {
		setBusyRun({ id: run.id, action: "resume" });
		try {
			await api("POST", `/left/schedules/${enc(id)}/runs/${enc(run.id)}/resume-awaiting`);
			toast("已继续等待中的运行", { kind: "success" });
		} catch (e) {
			toast(`继续运行失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			await Promise.all([awaiting.reload(), runs.reload(), schedLoad.reload()]);
			onScheduleChange?.();
			setBusyRun(null);
		}
	};

	const release = async (run: ScheduleRun) => {
		if (
			!(await confirm({
				title: "解除等待确认",
				message:
					"解除后原运行将标记为失败，后续排队任务会继续。此操作不会停止原会话，原会话可能与后续任务同时运行。确定解除吗？",
				confirmText: "确认解除",
				danger: true,
			}))
		) {
			return;
		}
		setBusyRun({ id: run.id, action: "release" });
		try {
			await api("POST", `/left/schedules/${enc(id)}/runs/${enc(run.id)}/release-awaiting`);
			toast("已解除等待确认", { kind: "success" });
		} catch (e) {
			toast(`解除失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			await Promise.all([awaiting.reload(), runs.reload(), schedLoad.reload()]);
			onScheduleChange?.();
			setBusyRun(null);
		}
	};

	const hasRunningRun = Array.isArray(runs.data) && runs.data.some((r) => r.status === "running");

	const handleMergeWorktree = async () => {
		if (!worktree.data || wtBusy || hasRunningRun) return;
		if (
			!(await confirm({
				title: "合并并清理工作树",
				message: `将分支「${worktree.data.branch}」的改动合并回主分支并移除该临时工作树？`,
				confirmText: "合并并清理",
			}))
		) {
			return;
		}
		setWtBusy("merge");
		try {
			await useMobileSchedules.getState().mergeWorktree(id, {
				runId: worktree.data.runId ?? undefined,
				branch: worktree.data.branch,
				worktreePath: worktree.data.worktreePath,
			});
			toast("已合并改动并清理工作树", { kind: "success" });
			await reloadAll();
		} catch (e) {
			toast(`合并失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setWtBusy(null);
		}
	};

	const handleDiscardWorktree = async () => {
		if (!worktree.data || wtBusy || hasRunningRun) return;
		if (
			!(await confirm({
				title: "丢弃工作树改动",
				message: `确定丢弃分支「${worktree.data.branch}」中的所有改动并删除该工作树？此操作不可撤销。`,
				confirmText: "丢弃改动",
				danger: true,
			}))
		) {
			return;
		}
		setWtBusy("discard");
		try {
			await useMobileSchedules.getState().discardWorktree(id, {
				runId: worktree.data.runId ?? undefined,
				branch: worktree.data.branch,
				worktreePath: worktree.data.worktreePath,
			});
			toast("已丢弃工作树改动", { kind: "success" });
			await reloadAll();
		} catch (e) {
			toast(`丢弃失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setWtBusy(null);
		}
	};

	const latestRun = runs.data?.[0] ?? null;
	const latestFailed =
		latestRun?.status === "error" || schedule?.lastRunStatus === "error";

	const handleGenerateFix = async () => {
		if (!schedule || diagnosing) return;
		setDiagnosing(true);
		setFixProbeResult(null);
		try {
			const errorContext = [
				latestRun?.summary ? `最近运行报错摘要：${latestRun.summary}` : "",
				latestRun?.probeOutput ? `最近脚本输出：\n${latestRun.probeOutput}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
			const res = await useMobileSchedules.getState().generateDraft({
				cwd: schedule.cwd,
				request: `请诊断并修复自动化任务「${schedule.name}」最近一次失败的原因，输出修正后的脚本与配置。\n${errorContext}`,
				preview: true,
				current: {
					id: schedule.id,
					name: schedule.name,
					prompt: schedule.prompt,
					cwd: schedule.cwd,
					mode: schedule.mode,
					runMode: schedule.runMode,
					cadence: schedule.cadence,
					model: schedule.model,
					thinking: schedule.thinking,
					approvalMode: schedule.approvalMode,
					enabled: schedule.enabled,
					notify: schedule.notify,
					newChatEachRun: schedule.newChatEachRun,
					endAt: schedule.endAt,
					maxRuns: schedule.maxRuns,
					probeCommand: schedule.probeCommand,
					probeDescription: schedule.probeDescription,
					agentTrigger: resolveAgentTrigger(schedule),
					resultMode: schedule.resultMode,
					invokesExternalModel: schedule.invokesExternalModel,
				},
			});
			setFixSuggestion(res);
		} catch (e) {
			toast(`生成修复建议失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setDiagnosing(false);
		}
	};

	const handleTestSuggestedFix = async () => {
		if (!schedule || !fixSuggestion?.probeCommand?.trim() || fixProbeTesting) return;
		setFixProbeTesting(true);
		try {
			const res = await useMobileSchedules.getState().testProbe({
				cwd: schedule.cwd,
				probeCommand: fixSuggestion.probeCommand,
				agentTrigger: fixSuggestion.agentTrigger,
				scheduleId: schedule.id,
			});
			setFixProbeResult(res);
		} catch (e) {
			toast(`试跑失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setFixProbeTesting(false);
		}
	};

	const handleApplySuggestedFix = async () => {
		if (!schedule || !fixSuggestion || applyingFix) return;
		setApplyingFix(true);
		try {
			const nextForm = formFromSchedule({
				...schedule,
				name: fixSuggestion.name || schedule.name,
				cadence: fixSuggestion.cadence ?? schedule.cadence,
				agentTrigger: fixSuggestion.agentTrigger ?? schedule.agentTrigger,
				resultMode: fixSuggestion.resultMode ?? schedule.resultMode,
				invokesExternalModel: fixSuggestion.invokesExternalModel ?? schedule.invokesExternalModel,
				probeDescription: fixSuggestion.probeDescription ?? schedule.probeDescription,
				probeCommand: fixSuggestion.probeCommand ?? schedule.probeCommand,
				prompt: fixSuggestion.prompt || schedule.prompt,
				notify: fixSuggestion.notify ?? schedule.notify,
				id: schedule.id,
				enabled: true,
			});
			const payload = buildPayload(nextForm, schedule);
			await useMobileSchedules.getState().updateSchedule(schedule.id, payload);
			setFixSuggestion(null);
			setFixProbeResult(null);
			toast("已应用修复并恢复运行", { kind: "success" });
			await reloadAll();
		} catch (e) {
			toast(`应用修复失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setApplyingFix(false);
		}
	};

	const handleOpenDeepDebugChat = async () => {
		if (!schedule || launchingChat) return;
		setLaunchingChat(true);
		try {
			const errBits = [
				latestRun?.summary ? `报错摘要：${latestRun.summary}` : "",
				latestRun?.probeOutput ? `脚本输出：\n${latestRun.probeOutput}` : "",
			]
				.filter(Boolean)
				.join("\n");
			const firstPrompt = [
				`请帮我深度排查自动化任务「${schedule.name}」的失败原因并修复：`,
				errBits || "最近一次运行失败，请检查工作目录与脚本日志。",
				"修复并试跑通过后，请用确认卡提交更新方案。",
			].join("\n\n");
			await startAutomationChat({
				cwd: schedule.cwd,
				mode: schedule.mode,
				appendSystemPrompt: buildExistingAutomationSystemPrompt(schedule),
				prefill: firstPrompt,
				autoSend: true,
			});
		} catch (e) {
			toast(`打开排查会话失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setLaunchingChat(false);
		}
	};

	const historyEntries = useMemo(() => collapseHistoryRuns(runs.data ?? []), [runs.data]);
	const trigger = schedule ? resolveAgentTrigger(schedule) : "always";

	const renderRunRow = (r: ScheduleRun) => {
		const dur = runDurationText(r);
		const sid = r.sessionId;
		const formatted = formatRunSummary(r.summary);
		const probeOpen = Boolean(expandedProbeRuns[r.id]);
		return (
			<div key={r.id} className="m-list-row pl-4">
				<ListRow
					title={
						<span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="run-row">
							<span className="whitespace-nowrap">{fmtTime(r.startedAt)}</span>
							<Chip tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status] ?? r.status}</Chip>
							{r.phase && (() => {
								const badge = runPhaseBadge(r.phase, r.status);
								return badge ? <Chip tone={badge.tone}>{badge.label}</Chip> : null;
							})()}
						</span>
					}
					subtitle={
						dur || formatted ? (
							<>
								{dur && <span className="block">{dur}</span>}
								{formatted && (
									<span className="m-selectable mt-1 block text-m-sm whitespace-pre-wrap break-words text-m-text-2">
										{formatted.headline}
									</span>
								)}
								{formatted?.details && (
									<span className="m-selectable mt-1 block text-m-xs whitespace-pre-wrap break-words text-m-text-3">
										{formatted.details}
									</span>
								)}
							</>
						) : undefined
					}
					right={sid ? <MessageSquare size={18} strokeWidth={1.75} aria-label="打开会话" /> : undefined}
					chevron={!!sid}
					onClick={sid ? () => nav.push(paths.chat(sid)) : undefined}
				/>
				{r.probeOutput && (
					<div className="pr-4 pb-2.5 pl-1">
						<button
							type="button"
							onClick={() =>
								setExpandedProbeRuns((prev) => ({ ...prev, [r.id]: !prev[r.id] }))
							}
							className="inline-flex items-center gap-1 text-m-xs text-m-accent"
						>
							<Terminal size={12} />
							<span>{probeOpen ? "收起脚本输出" : "查看原始脚本输出"}</span>
						</button>
						{probeOpen && (
							<pre className="m-selectable mt-1.5 max-h-44 overflow-auto rounded-lg bg-m-bg p-2 font-m-mono text-[11px] whitespace-pre-wrap break-all text-m-text-2">
								{r.probeOutput}
							</pre>
						)}
					</div>
				)}
			</div>
		);
	};

	return (
		<PullToRefresh onRefresh={reloadAll}>
			<div className="flex flex-col gap-3 px-4 pt-3" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 28px)" }}>
				{/* Workflow summary card */}
				{schedule && (
					<section className="rounded-2xl border border-m-border bg-m-surface p-4">
						<div className="flex flex-wrap items-center gap-1.5">
							<Chip icon={<CalendarClock size={12} />}>{cadenceText(schedule.cadence)}</Chip>
							<Chip>{AGENT_TRIGGER_LABEL[trigger]}</Chip>
							{schedule.runMode === "worktree" && <Chip icon={<FolderGit2 size={12} />}>独立工作树</Chip>}
							{schedule.model && <Chip icon={<Cpu size={12} />}>{schedule.model}</Chip>}
						</div>
						<div className="mt-2 text-m-xs break-all text-m-text-3">目录：{schedule.cwd}</div>
						{schedule.probeCommand && (
							<div className="mt-2.5 border-t border-m-border pt-2">
								<button
									type="button"
									onClick={() => setShowScript((v) => !v)}
									className="flex w-full items-center justify-between text-m-xs font-medium text-m-text-2"
								>
									<span className="inline-flex items-center gap-1.5">
										<Terminal size={13} />
										<span>本地检测脚本</span>
									</span>
									<ChevronDown
										size={14}
										className={`transition-transform duration-(--m-dur-fast) ${showScript ? "rotate-180" : ""}`}
									/>
								</button>
								{showScript && (
									<div className="mt-1.5">
										{schedule.probeDescription && (
											<p className="mb-1 text-m-xs text-m-text-3">{schedule.probeDescription}</p>
										)}
										<pre className="m-selectable overflow-x-auto rounded-lg bg-m-bg p-2 font-m-mono text-[11px] whitespace-pre-wrap break-all text-m-text">
											{schedule.probeCommand}
										</pre>
									</div>
								)}
							</div>
						)}
						{schedule.prompt && (
							<div className="mt-2 border-t border-m-border pt-2">
								<button
									type="button"
									onClick={() => setShowPrompt((v) => !v)}
									className="flex w-full items-center justify-between text-m-xs font-medium text-m-text-2"
								>
									<span>执行提示词</span>
									<ChevronDown
										size={14}
										className={`transition-transform duration-(--m-dur-fast) ${showPrompt ? "rotate-180" : ""}`}
									/>
								</button>
								{showPrompt && (
									<pre className="m-selectable mt-1.5 font-m-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-m-text-2">
										{schedule.prompt}
									</pre>
								)}
							</div>
						)}
					</section>
				)}

				{/* Failed run AI diagnosis & 1-click fix card */}
				{schedule && latestFailed && (
					<section className="rounded-2xl border border-m-danger/30 bg-m-danger-bg/40 p-4">
						<div className="flex items-start gap-2.5">
							<AlertTriangle size={18} className="mt-0.5 shrink-0 text-m-danger" />
							<div className="min-w-0 flex-1">
								<h3 className="text-m-sm font-semibold text-m-text">最近一次运行失败</h3>
								{latestRun?.summary && (
									<p className="m-selectable mt-1 text-m-xs whitespace-pre-wrap break-words text-m-text-2">
										{latestRun.summary}
									</p>
								)}
							</div>
						</div>
						<div className="mt-3 flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="primary"
								busy={diagnosing}
								icon={<Sparkles size={14} />}
								onClick={() => void handleGenerateFix()}
							>
								AI 生成修复方案
							</Button>
							<Button
								size="sm"
								variant="tonal"
								busy={launchingChat}
								icon={<Wrench size={14} />}
								onClick={() => void handleOpenDeepDebugChat()}
							>
								打开 AI 深度排查会话
							</Button>
						</div>

						{fixSuggestion && (
							<div className="mt-3 rounded-xl border border-m-border bg-m-surface p-3">
								<div className="text-m-xs font-semibold text-m-text">建议修复方案</div>
								{fixSuggestion.explanation && (
									<p className="m-selectable mt-1 text-m-xs whitespace-pre-wrap break-words text-m-text-2">
										{fixSuggestion.explanation}
									</p>
								)}
								{fixSuggestion.probeCommand && (
									<pre className="m-selectable mt-2 overflow-x-auto rounded-lg bg-m-bg p-2 font-m-mono text-[11px] whitespace-pre-wrap break-all text-m-text">
										{fixSuggestion.probeCommand}
									</pre>
								)}
								{fixProbeResult && (
									<div className="mt-2 rounded-lg bg-m-bg p-2 text-m-xs">
										<div className="flex flex-wrap items-center gap-1.5">
											<Chip
												tone={
													fixProbeResult.outcome === "error" || fixProbeResult.timedOut
														? "danger"
														: fixProbeResult.outcome === "signal"
															? "accent"
															: "success"
												}
											>
												{fixProbeResult.timedOut
													? "试跑超时"
													: fixProbeResult.outcome === "error"
														? "试跑失败"
														: fixProbeResult.outcome === "signal"
															? "试跑有信号"
															: fixProbeResult.outcome === "ok"
																? "试跑成功"
																: "试跑静默通过"}
											</Chip>
											<span className="text-m-text-3">{fixProbeResult.durationMs}ms</span>
											{fixProbeResult.exitCode != null && (
												<span className="text-m-text-3">退出码 {fixProbeResult.exitCode}</span>
											)}
										</div>
										{fixProbeResult.output && (
											<pre
												className={`m-selectable mt-1 max-h-24 overflow-auto font-m-mono text-[11px] whitespace-pre-wrap break-all ${
													fixProbeResult.outcome === "error" || fixProbeResult.timedOut
														? "text-m-danger"
														: "text-m-text-2"
												}`}
											>
												{fixProbeResult.output}
											</pre>
										)}
									</div>
								)}
								<div className="mt-3 flex flex-wrap gap-2">
									{fixSuggestion.probeCommand && (
										<Button
											size="sm"
											variant="tonal"
											busy={fixProbeTesting}
											icon={<Play size={13} />}
											onClick={() => void handleTestSuggestedFix()}
										>
											就地试跑
										</Button>
									)}
									<Button
										size="sm"
										variant="primary"
										busy={applyingFix}
										icon={<Check size={13} />}
										onClick={() => void handleApplySuggestedFix()}
									>
										应用并恢复运行
									</Button>
								</div>
							</div>
						)}
					</section>
				)}

				{/* Worktree review & merge/discard card */}
				{worktree.data && (worktree.data.ahead > 0 || worktree.data.dirty > 0) && (
					<section className="rounded-2xl border border-m-accent/35 bg-m-surface p-4" data-testid="automation-worktree-card">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex min-w-0 items-center gap-2">
								<FolderGit2 size={17} className="shrink-0 text-m-accent" />
								<div className="min-w-0">
									<div className="text-m-sm font-semibold text-m-text">待合并工作树改动</div>
									<div className="font-m-mono text-m-xs break-all text-m-text-3">
										{worktree.data.branch}
									</div>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1.5 text-m-xs font-m-mono">
								<span className="text-emerald-500">+{worktree.data.addedLines}</span>
								<span className="text-m-danger">-{worktree.data.removedLines}</span>
							</div>
						</div>
						<div className="mt-2 flex flex-wrap gap-1.5 text-m-xs text-m-text-3">
							{worktree.data.ahead > 0 && <Chip tone="accent">{worktree.data.ahead} 个提交领先</Chip>}
							{worktree.data.dirty > 0 && <Chip tone="warn">{worktree.data.dirty} 个未提交改动</Chip>}
						</div>
						{worktree.data.combinedDiff && (
							<div className="mt-2.5">
								<button
									type="button"
									onClick={() => setShowDiff((v) => !v)}
									className="inline-flex items-center gap-1 text-m-xs font-medium text-m-accent"
								>
									<span>{showDiff ? "收起 Diff 预览" : "展开 Diff 预览"}</span>
									<ChevronDown
										size={13}
										className={`transition-transform duration-(--m-dur-fast) ${showDiff ? "rotate-180" : ""}`}
									/>
								</button>
								{showDiff && (
									<pre className="m-selectable mt-1.5 max-h-64 overflow-auto rounded-xl bg-m-bg p-2.5 font-m-mono text-[11px] leading-relaxed whitespace-pre text-m-text">
										{worktree.data.combinedDiff}
									</pre>
								)}
							</div>
						)}
						<div className="mt-3 flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="primary"
								busy={wtBusy === "merge"}
								disabled={wtBusy !== null || hasRunningRun}
								icon={<GitMerge size={14} />}
								onClick={() => void handleMergeWorktree()}
							>
								合并并清理工作树
							</Button>
							<Button
								size="sm"
								variant="danger"
								busy={wtBusy === "discard"}
								disabled={wtBusy !== null || hasRunningRun}
								icon={<Trash2 size={14} />}
								onClick={() => void handleDiscardWorktree()}
							>
								丢弃改动
							</Button>
						</div>
						{hasRunningRun && (
							<p className="mt-2 text-m-xs text-m-text-3">任务正在运行，完成后可操作</p>
						)}
					</section>
				)}

				{/* Awaiting confirmation section */}
				{awaiting.data === null ? (
					<LoadState loading={awaiting.loading} error={awaiting.error} onRetry={awaiting.reload} />
				) : (
					<>
						{awaiting.error && (
							<p className="m-selectable px-1 text-m-sm break-words text-m-danger">
								刷新等待确认记录失败：{awaiting.error}{" "}
								<Button size="sm" variant="ghost" onClick={() => void awaiting.reload()}>
									重试
								</Button>
							</p>
						)}
						{!awaiting.error && !awaiting.loading && awaiting.data.length > 0 && (
							<ListGroup
								className="!mx-0"
								title="等待确认"
								note="继续运行会尝试恢复原会话；解除等待不会停止原会话，请先确认是否允许后续任务继续。"
							>
								{awaiting.data.map((r) => (
									<ListRow
										key={r.id}
										title={fmtTime(r.startedAt)}
										subtitle={r.summary || "等待人工确认"}
										right={
											<div className="flex flex-wrap justify-end gap-2">
												<Button
													size="sm"
													busy={busyRun?.id === r.id && busyRun.action === "resume"}
													disabled={busyRun !== null}
													onClick={() => void resume(r)}
												>
													继续运行
												</Button>
												<Button
													size="sm"
													variant="danger"
													busy={busyRun?.id === r.id && busyRun.action === "release"}
													disabled={busyRun !== null}
													onClick={() => void release(r)}
												>
													解除等待
												</Button>
											</div>
										}
									/>
								))}
							</ListGroup>
						)}
					</>
				)}

				{/* Run history with collapsed quiet / skipped groups */}
				{runs.data === null ? (
					<LoadState loading={runs.loading} error={runs.error} onRetry={runs.reload} />
				) : runs.data.length === 0 ? (
					<EmptyState
						className="min-h-[45dvh]"
						icon={<History size={26} strokeWidth={1.75} />}
						title="暂无运行记录"
						hint="任务运行后会显示在这里"
					/>
				) : (
					<ListGroup className="!mx-0" title="运行记录" note="有会话的记录可轻点打开">
						{historyEntries.map((entry, idx) => {
							if (entry.kind === "run") return renderRunRow(entry.run);
							const groupKey = `${entry.groupKind}:${entry.runs[0]?.id ?? idx}`;
							const open = Boolean(expandedGroups[groupKey]);
							return (
								<div key={groupKey} className="m-list-row pl-4">
									<button
										type="button"
										onClick={() =>
											setExpandedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }))
										}
										className="m-list-sep flex min-h-12 w-full items-center justify-between gap-2 py-2.5 pr-4 text-left text-m-xs text-m-text-3"
									>
										<span>
											{entry.label}（{fmtTime(entry.runs[entry.runs.length - 1]?.startedAt)} ~{" "}
											{fmtTime(entry.runs[0]?.startedAt)}）
										</span>
										<ChevronDown
											size={14}
											className={`shrink-0 transition-transform duration-(--m-dur-fast) ${open ? "rotate-180" : ""}`}
										/>
									</button>
									{open && <div className="pl-2">{entry.runs.map(renderRunRow)}</div>}
								</div>
							);
						})}
					</ListGroup>
				)}
			</div>
		</PullToRefresh>
	);
}

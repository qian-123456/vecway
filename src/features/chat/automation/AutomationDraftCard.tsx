import clsx from "clsx";
import {
	Check,
	ChevronDown,
	ChevronRight,
	Clock,
	Cpu,
	FlaskConical,
	Folder,
	GitBranch,
	Loader2,
	MessageSquare,
	Play,
	RefreshCw,
	SlidersHorizontal,
	Sparkles,
	Terminal,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FloatingLayer } from "../../../components/FloatingLayer";
import type { ProbeTestResult } from "../../../lib/contracts";
import { testScheduleProbe } from "../../../lib/ipc";
import { basename } from "../../../lib/paths";
import { toast } from "../../../lib/toast";
import { useComposer } from "../../../stores/composer";
import { useT } from "../../../stores/language";
import { setAutomationDraftStatus } from "../../../stores/live";
import { useUi } from "../../../stores/ui";
import {
	type AutomationPromptKey,
	renderAutomationPrompt,
} from "../../schedules/automationPrompts";
import { formatCadence } from "../../schedules/humanCadence";
import { useSchedulesStore } from "../../schedules/schedulesStore";
import { useSettings } from "../../settings/store";
import {
	type AutomationDraftStatus,
	resolveAutomationDraftAction,
} from "./automationStatus";

interface CachedProbeOutcome {
	result: ProbeTestResult | null;
	error: string | null;
}

const probeResultCache = new Map<string, CachedProbeOutcome>();

/** Test helper to reset cached probe outcomes between unit tests. */
export function clearAutomationProbeCacheForTest(): void {
	probeResultCache.clear();
}

export function AutomationDraftCard({
	sessionId,
	status,
	embedded = false,
	highlighted = false,
}: {
	sessionId: string;
	status: AutomationDraftStatus;
	/** Rendered inside the right-hand AutomationDraftsPanel (parent controls horizontal padding & spacing). */
	embedded?: boolean;
	/** Briefly emphasize the card when jumped to from an inline conversation reference. */
	highlighted?: boolean;
}) {
	const { t, locale } = useT();
	const settings = useSettings((s) => s.settings);
	const cacheKey = `${sessionId}:${status.draftId}`;
	const cached = probeResultCache.get(cacheKey);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testMenuOpen, setTestMenuOpen] = useState(false);
	const [probeResult, setProbeResult] = useState<ProbeTestResult | null>(cached?.result ?? null);
	const [probeError, setProbeError] = useState<string | null>(cached?.error ?? null);
	const testBtnRef = useRef<HTMLButtonElement>(null);
	const probeResultRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const next = probeResultCache.get(cacheKey);
		setProbeResult(next?.result ?? null);
		setProbeError(next?.error ?? null);
	}, [cacheKey]);

	if (status.status === "dismissed") return null;

	const { draft } = status;

	if (status.status === "saved") {
		return (
			<div
				className={clsx(
					"flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs transition-shadow",
					!embedded && "mx-3 mb-2",
					highlighted && "ring-2 ring-amber-400/60",
				)}
			>
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<Check size={13} className="shrink-0 text-emerald-400" />
					<span className="break-words font-medium text-emerald-300 select-text">
						{t("schedules.draftEnabledDone")} · {draft.name}
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-1.5 select-none">
					<button
						type="button"
						onClick={() => useUi.getState().setCenter("schedules")}
						className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-emerald-500/35 bg-[var(--bg)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)]"
					>
						{t("schedules.viewAutomationsBoard")}
					</button>
					<button
						type="button"
						onClick={() =>
							setAutomationDraftStatus(sessionId, { ...status, status: "dismissed" })
						}
						aria-label={t("schedules.draftDismiss")}
						className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--text-40)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
					>
						<X size={11} />
					</button>
				</div>
			</div>
		);
	}

	const isScriptExternalModel =
		draft.agentTrigger === "never" && draft.invokesExternalModel === true;
	const triggerLabel = isScriptExternalModel
		? t("schedules.modeCardExternalModelTitle")
		: draft.agentTrigger === "never"
			? t("schedules.modeCardNeverTitle")
			: draft.agentTrigger === "on_signal" || Boolean(draft.probeCommand)
				? t("schedules.modeCardSignalTitle")
				: t("schedules.modeCardAlwaysTitle");

	const modelShort = draft.model
		? draft.model.split("/").pop() ?? draft.model
		: null;
	const modelBadge =
		draft.agentTrigger !== "never"
			? modelShort
				? draft.thinking
					? `${modelShort} · ${draft.thinking}`
					: modelShort
				: draft.thinking
					? `${t("schedules.defaultModel")} · ${draft.thinking}`
					: null
			: null;

	const resultModeLabel =
		draft.probeCommand
			? draft.resultMode === "llm_summary"
				? t("schedules.resultModeLlmSummaryShort")
				: t("schedules.resultModeStructuredShort")
			: null;

	const SHORT_PROMPT_PREVIEW_LIMIT = 120;
	const triggerSummary = draft.probeDescription?.trim() || null;
	const cleanPrompt = draft.prompt.trim().replace(/\s+/g, " ");
	const agentSummary =
		draft.agentTrigger === "never" && !status.summary?.trim()
			? null
			: status.summary?.trim()
				? status.summary.trim()
				: cleanPrompt.length > 0 && cleanPrompt.length <= SHORT_PROMPT_PREVIEW_LIMIT
					? cleanPrompt
					: cleanPrompt.length > SHORT_PROMPT_PREVIEW_LIMIT
						? t("schedules.draftSummaryPreparedHint")
						: null;

	const folderLabel =
		draft.cwd && draft.cwd !== "." ? basename(draft.cwd) : null;

	const prefillComposer = (
		key: AutomationPromptKey,
		showTestHint: boolean,
		testModeTitle?: string,
	) => {
		const store = useComposer.getState();
		const text = renderAutomationPrompt(key, draft.name, settings, locale);
		store.setDraft(sessionId, text);
		store.setPrefillHint(
			sessionId,
			showTestHint ? t("schedules.testPrefillHint") : null,
		);
		store.focusComposer(sessionId);
		if (testModeTitle) {
			toast.info(t("schedules.draftTestPrefilledToast", { mode: testModeTitle }));
		}
	};

	const handleAskAiAdjust = () => {
		const store = useComposer.getState();
		const currentDraft = store.drafts[sessionId] ?? "";
		if (!currentDraft.trim()) {
			prefillComposer("adjust", false);
		} else {
			store.focusComposer(sessionId);
		}
	};

	const probeOutcomeLabel = (outcome: ProbeTestResult["outcome"]) =>
		outcome === "quiet"
			? t("schedules.probeOutcomeQuiet")
			: outcome === "signal"
				? t("schedules.probeOutcomeSignal")
				: outcome === "ok"
					? t("schedules.probeOutcomeOk")
					: t("schedules.probeOutcomeError");

	const probeOutcomeHint = (outcome: ProbeTestResult["outcome"]) =>
		outcome === "quiet"
			? t("schedules.probeOutcomeQuietHint")
			: outcome === "signal"
				? t("schedules.probeOutcomeSignalHint")
				: outcome === "ok"
					? t("schedules.probeOutcomeOkHint")
					: t("schedules.probeOutcomeErrorHint");

	const clearProbeOutcome = () => {
		probeResultCache.delete(cacheKey);
		setProbeResult(null);
		setProbeError(null);
	};

	const handleScriptOnlyTest = async () => {
		if (!draft.probeCommand || testing) return;
		setTestMenuOpen(false);
		setTesting(true);
		setProbeError(null);
		try {
			const res = await testScheduleProbe({
				cwd: draft.cwd || ".",
				probeCommand: draft.probeCommand,
				agentTrigger: draft.agentTrigger ?? "on_signal",
				scheduleId: draft.id ?? null,
			});
			probeResultCache.set(cacheKey, { result: res, error: null });
			setProbeResult(res);
			const summary = t("schedules.probeToastDone", {
				outcome: probeOutcomeLabel(res.outcome),
				ms: res.durationMs,
			});
			if (res.outcome === "error") toast.error(summary);
			else if (res.outcome === "signal") toast.info(summary);
			else toast.success(summary);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			probeResultCache.set(cacheKey, { result: null, error: message });
			setProbeResult(null);
			setProbeError(message);
			toast.error(t("schedules.probeToastFailed", { error: message }));
		} finally {
			setTesting(false);
			requestAnimationFrame(() => {
				probeResultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
			});
		}
	};

	const handleConfirmEnable = async () => {
		if (saving) return;
		setSaving(true);
		try {
			const saved = await useSchedulesStore.getState().saveSchedule({
				...draft,
				enabled: true,
			});
			if (!saved) return;
			setAutomationDraftStatus(sessionId, { ...status, status: "saved" });
			void resolveAutomationDraftAction(sessionId, status.draftId, "saved");
			toast.success(t("schedules.draftEnabledDone"));
		} finally {
			setSaving(false);
		}
	};

	const handleCustomize = () => {
		setAutomationDraftStatus(sessionId, { ...status, status: "dismissed" });
		void resolveAutomationDraftAction(sessionId, status.draftId, "dismissed");
		useUi.getState().setCenter("schedules");
		useSchedulesStore.getState().openCreate(draft);
	};

	const handleDismiss = () => {
		setAutomationDraftStatus(sessionId, { ...status, status: "dismissed" });
		void resolveAutomationDraftAction(sessionId, status.draftId, "dismissed");
	};

	const annotationLabel =
		locale === "zh-CN"
			? `${t("schedules.draftCardTitle")}：${draft.name}`
			: `${t("schedules.draftCardTitle")}: ${draft.name}`;

	return (
		<div
			data-annotation-label={annotationLabel}
			data-automation-draft-id={status.draftId}
			className={clsx(
				"rounded-2xl border border-[var(--border-divider)] bg-[var(--bg-panel)] px-3.5 py-2.5 shadow-sm transition-shadow select-text",
				!embedded && "mx-3 mb-2",
				highlighted && "ring-2 ring-amber-400/60",
			)}
		>
			{/* Compact top header + action row */}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
					<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400 select-none">
						<Clock size={10} className="shrink-0" />
						<span>{t("schedules.draftCardTitle")}</span>
					</span>
					<h4 className="break-words text-[13px] font-semibold text-[var(--text)]">
						{draft.name}
					</h4>
					<span
						className={clsx(
							"shrink-0 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
							isScriptExternalModel
								? "border-amber-500/35 bg-amber-500/10 text-amber-400"
								: "border-[var(--border-divider)] bg-[var(--bg)] text-[var(--text-60)]",
						)}
					>
						{triggerLabel}
					</span>
					<span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--text-40)]">
						{formatCadence(draft.cadence, locale)}
					</span>
					{modelBadge && (
						<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-divider)] bg-[var(--bg)] px-1.5 py-0.5 text-[10px] text-[var(--text-60)]">
							<Cpu size={9.5} className="shrink-0 text-[var(--text-40)]" />
							<span>{modelBadge}</span>
						</span>
					)}
					{resultModeLabel && (
						<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-divider)] bg-[var(--bg)] px-1.5 py-0.5 text-[10px] text-[var(--text-60)]">
							<Sparkles size={9.5} className="shrink-0 text-[var(--text-40)]" />
							<span>{resultModeLabel}</span>
						</span>
					)}
					{folderLabel && (
						<span
							title={draft.cwd}
							className="inline-flex max-w-36 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-divider)] bg-[var(--bg)] px-1.5 py-0.5 text-[10px] text-[var(--text-60)]"
						>
							<Folder size={9.5} className="shrink-0 text-[var(--text-40)]" />
							<span className="truncate">{folderLabel}</span>
						</span>
					)}
					{draft.runMode === "worktree" && (
						<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-divider)] bg-[var(--bg)] px-1.5 py-0.5 text-[10px] text-[var(--text-60)]">
							<GitBranch size={9.5} className="shrink-0 text-[var(--text-40)]" />
							<span>Worktree</span>
						</span>
					)}
				</div>

				<div className="flex flex-wrap shrink-0 items-center gap-1.5 select-none">
					<button
						ref={testBtnRef}
						type="button"
						disabled={testing}
						onClick={() => setTestMenuOpen((v) => !v)}
						className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-60)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-45"
					>
						{testing ? (
							<Loader2 size={10} className="shrink-0 animate-spin" />
						) : (
							<Play size={9} className="shrink-0" />
						)}
						<span>
							{testing ? t("schedules.testingProbeBtn") : t("schedules.testMenuBtn")}
						</span>
						<ChevronDown size={10} className="shrink-0 opacity-70" />
					</button>

					{testMenuOpen && (
						<FloatingLayer
							anchor={testBtnRef.current}
							placement="top-end"
							offset={6}
							layer="popover"
							ignoreRefs={[testBtnRef]}
							onDismiss={() => setTestMenuOpen(false)}
							className="w-[300px] rounded-xl border-[var(--line,var(--border-divider))] !bg-[var(--bg-panel)] p-1"
						>
							{draft.probeCommand && (
								<>
									<button
										type="button"
										onClick={() => void handleScriptOnlyTest()}
										className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--ghost-hover,var(--bg-hover))]"
									>
										<Terminal size={13} className="mt-0.5 shrink-0 text-emerald-400" />
										<span className="min-w-0 flex-1">
											<span className="block text-[12px] font-medium text-[var(--text)]">
												{t("schedules.testScriptOnlyTitle")}
											</span>
											<span className="block text-[10.5px] leading-snug text-[var(--text-40)]">
												{t("schedules.testScriptOnlyDesc")}
											</span>
										</span>
									</button>
									<div className="my-1 border-t border-[var(--border-divider)]" />
								</>
							)}
							<button
								type="button"
								onClick={() => {
									setTestMenuOpen(false);
									prefillComposer("mockTest", true, t("schedules.testMockTitle"));
								}}
								className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--ghost-hover,var(--bg-hover))]"
							>
								<FlaskConical size={13} className="mt-0.5 shrink-0 text-sky-400" />
								<span className="min-w-0 flex-1">
									<span className="block text-[12px] font-medium text-[var(--text)]">
										{t("schedules.testMockTitle")}
									</span>
									<span className="block text-[10.5px] leading-snug text-[var(--text-40)]">
										{t("schedules.testMockDesc")}
									</span>
								</span>
							</button>
							<button
								type="button"
								onClick={() => {
									setTestMenuOpen(false);
									prefillComposer("realOnceTest", true, t("schedules.testRealOnceTitle"));
								}}
								className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--ghost-hover,var(--bg-hover))]"
							>
								<Play size={13} className="mt-0.5 shrink-0 text-amber-400" />
								<span className="min-w-0 flex-1">
									<span className="block text-[12px] font-medium text-[var(--text)]">
										{t("schedules.testRealOnceTitle")}
									</span>
									<span className="block text-[10.5px] leading-snug text-[var(--text-40)]">
										{t("schedules.testRealOnceDesc")}
									</span>
								</span>
							</button>
							<button
								type="button"
								onClick={() => {
									setTestMenuOpen(false);
									prefillComposer("realLoopTest", true, t("schedules.testRealLoopTitle"));
								}}
								className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--ghost-hover,var(--bg-hover))]"
							>
								<RefreshCw size={13} className="mt-0.5 shrink-0 text-violet-400" />
								<span className="min-w-0 flex-1">
									<span className="block text-[12px] font-medium text-[var(--text)]">
										{t("schedules.testRealLoopTitle")}
									</span>
									<span className="block text-[10.5px] leading-snug text-[var(--text-40)]">
										{t("schedules.testRealLoopDesc")}
									</span>
								</span>
							</button>
						</FloatingLayer>
					)}

					<button
						type="button"
						onClick={handleAskAiAdjust}
						className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-60)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
					>
						<MessageSquare size={10} className="shrink-0" />
						<span>{t("schedules.draftAskAiAdjust")}</span>
					</button>

					<button
						type="button"
						onClick={handleCustomize}
						className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-60)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
					>
						<SlidersHorizontal size={10} className="shrink-0" />
						<span>{t("schedules.draftCustomize")}</span>
					</button>

					<button
						type="button"
						disabled={saving}
						onClick={() => void handleConfirmEnable()}
						className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--text)] px-3 py-1 text-[11px] font-semibold text-[var(--bg)] transition-opacity hover:opacity-85 disabled:opacity-45"
					>
						{saving ? (
							<Loader2 size={10} className="shrink-0 animate-spin" />
						) : (
							<Check size={11} className="shrink-0" />
						)}
						<span>
							{draft.id
								? t("schedules.draftConfirmUpdate")
								: t("schedules.draftConfirmEnable")}
						</span>
					</button>

					<button
						type="button"
						onClick={handleDismiss}
						title={t("schedules.draftDismiss")}
						aria-label={t("schedules.draftDismiss")}
						className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-transparent text-[var(--text-40)] transition-colors hover:border-[var(--border-divider)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
					>
						<X size={12} />
					</button>
				</div>
			</div>

			{/* Human-readable 2-step summary (fully readable and selectable; never truncated) */}
			{(triggerSummary || agentSummary) && (
				<div className="mt-2 space-y-1 text-[11.5px] leading-relaxed text-[var(--text-60)] select-text">
					{triggerSummary && (
						<p className="break-words">
							<span className="font-medium text-[var(--text-80,var(--text))]">
								{t("schedules.draftSummaryStepTrigger")}：
							</span>
							{triggerSummary}
						</p>
					)}
					{agentSummary && (
						<p className="break-words">
							<span className="font-medium text-[var(--text-80,var(--text))]">
								{t("schedules.draftSummaryStepAgent")}：
							</span>
							{agentSummary}
						</p>
					)}
				</div>
			)}

			{/* Inline dry-run outcome if tested */}
			{(probeResult || probeError) && (
				<div
					ref={probeResultRef}
					data-probe-result=""
					className="mt-2 rounded-xl border border-[var(--border-divider)] bg-[var(--bg)] px-3 py-2 text-xs select-text"
				>
					{probeError ? (
						<div className="flex items-start justify-between gap-2">
							<p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[11px] text-rose-400">
								{probeError}
							</p>
							<button
								type="button"
								onClick={clearProbeOutcome}
								aria-label={t("schedules.probeClearResult")}
								title={t("schedules.probeClearResult")}
								className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--text-40)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] select-none"
							>
								<X size={11} />
							</button>
						</div>
					) : (
						probeResult && (
							<div className="space-y-1.5">
								<div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
									<div className="flex flex-wrap items-center gap-1.5">
										<span
											className={clsx(
												"inline-flex shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold",
												probeResult.outcome === "error"
													? "border-rose-500/35 bg-rose-500/15 text-rose-400"
													: probeResult.outcome === "signal"
														? "border-amber-500/35 bg-amber-500/15 text-amber-400"
														: "border-emerald-500/35 bg-emerald-500/15 text-emerald-400",
											)}
										>
											{probeOutcomeLabel(probeResult.outcome)}
										</span>
										<span className="shrink-0 whitespace-nowrap text-[var(--text-40)]">
											{probeResult.durationMs}ms
										</span>
										{probeResult.timedOut ? (
											<span className="shrink-0 whitespace-nowrap rounded-md border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-400">
												{t("schedules.probeTimedOut")}
											</span>
										) : (
											probeResult.exitCode !== null && (
												<span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border-divider)] bg-[var(--bg-panel)] px-1.5 py-0.5 text-[10px] text-[var(--text-40)]">
													{t("schedules.probeExitCode", { code: probeResult.exitCode })}
												</span>
											)
										)}
									</div>
									<button
										type="button"
										onClick={clearProbeOutcome}
										aria-label={t("schedules.probeClearResult")}
										title={t("schedules.probeClearResult")}
										className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--text-40)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] select-none"
									>
										<X size={11} />
									</button>
								</div>
								<p className="text-[11px] leading-snug text-[var(--text-60)]">
									{probeOutcomeHint(probeResult.outcome)}
								</p>
								{probeResult.output.trim() && (
									<pre className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] p-2 font-mono text-[11px] text-[var(--text-60)]">
										{probeResult.output}
									</pre>
								)}
							</div>
						)
					)}
				</div>
			)}

			{/* On-demand disclosure for raw command & full prompt */}
			{(draft.probeCommand || draft.prompt) && (
				<details className="group mt-1.5 text-xs">
					<summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-[var(--text-40)] hover:text-[var(--text)] select-none">
						<ChevronRight
							size={11}
							className="shrink-0 transition-transform group-open:rotate-90"
						/>
						<Terminal size={10} className="shrink-0" />
						<span>{t("schedules.draftViewDetails")}</span>
					</summary>
					<div className="mt-2 max-h-56 space-y-2 overflow-y-auto rounded-xl border border-[var(--border-divider)] bg-[var(--bg)] p-2.5">
						{draft.probeCommand && (
							<div>
								<div className="text-[10px] font-medium text-[var(--text-40)]">
									{t("schedules.draftProbeLabel")}
								</div>
								<pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--text-60)]">
									{draft.probeCommand}
								</pre>
							</div>
						)}
						{draft.prompt && (
							<div>
								<div className="text-[10px] font-medium text-[var(--text-40)]">
									{t("schedules.draftPromptLabel")}
								</div>
								<p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--text)]">
									{draft.prompt}
								</p>
							</div>
						)}
					</div>
				</details>
			)}
		</div>
	);
}

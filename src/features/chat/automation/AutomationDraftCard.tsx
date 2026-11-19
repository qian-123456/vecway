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
import { useRef, useState } from "react";
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

export function AutomationDraftCard({
	sessionId,
	status,
}: {
	sessionId: string;
	status: AutomationDraftStatus;
}) {
	const { t, locale } = useT();
	const settings = useSettings((s) => s.settings);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testMenuOpen, setTestMenuOpen] = useState(false);
	const [probeResult, setProbeResult] = useState<ProbeTestResult | null>(null);
	const [probeError, setProbeError] = useState<string | null>(null);
	const testBtnRef = useRef<HTMLButtonElement>(null);

	if (status.status === "dismissed") return null;

	const { draft } = status;

	if (status.status === "saved") {
		return (
			<div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs">
				<div className="flex min-w-0 items-center gap-2">
					<Check size={13} className="shrink-0 text-emerald-400" />
					<span className="truncate font-medium text-emerald-300">
						{t("schedules.draftEnabledDone")} · {draft.name}
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
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

	const prefillComposer = (key: AutomationPromptKey, showTestHint: boolean) => {
		const store = useComposer.getState();
		const text = renderAutomationPrompt(key, draft.name, settings, locale);
		store.setDraft(sessionId, text);
		store.setPrefillHint(
			sessionId,
			showTestHint ? t("schedules.testPrefillHint") : null,
		);
		store.focusComposer(sessionId);
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
			setProbeResult(res);
		} catch (e) {
			setProbeResult(null);
			setProbeError(e instanceof Error ? e.message : String(e));
		} finally {
			setTesting(false);
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

	return (
		<div className="mx-3 mb-2 rounded-2xl border border-[var(--border-divider)] bg-[var(--bg-panel)] px-3.5 py-2.5 shadow-sm">
			{/* Compact top action row */}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
					<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
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

				<div className="flex flex-wrap shrink-0 items-center gap-1.5">
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
									prefillComposer("mockTest", true);
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
									prefillComposer("realOnceTest", true);
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
									prefillComposer("realLoopTest", true);
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

			{/* Human-readable 2-step summary (capped; never dumps long machine prompts) */}
			{(triggerSummary || agentSummary) && (
				<div className="mt-2 space-y-1 text-[11.5px] leading-snug text-[var(--text-60)]">
					{triggerSummary && (
						<p className="line-clamp-2 break-words" title={triggerSummary}>
							<span className="font-medium text-[var(--text-80,var(--text))]">
								{t("schedules.draftSummaryStepTrigger")}：
							</span>
							{triggerSummary}
						</p>
					)}
					{agentSummary && (
						<p className="line-clamp-2 break-words" title={status.summary?.trim() || undefined}>
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
				<div className="mt-2 rounded-xl border border-[var(--border-divider)] bg-[var(--bg)] px-3 py-2 text-xs">
					{probeError ? (
						<p className="whitespace-pre-wrap break-words text-[11px] text-rose-400">
							{probeError}
						</p>
					) : (
						probeResult && (
							<div className="space-y-1">
								<div className="flex items-center gap-2 text-[11px]">
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
										{probeResult.outcome === "quiet"
											? t("schedules.probeOutcomeQuiet")
											: probeResult.outcome === "signal"
												? t("schedules.probeOutcomeSignal")
												: probeResult.outcome === "ok"
													? t("schedules.probeOutcomeOk")
													: t("schedules.probeOutcomeError")}
									</span>
									<span className="text-[var(--text-40)]">{probeResult.durationMs}ms</span>
								</div>
								{probeResult.output.trim() && (
									<pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--text-60)]">
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
					<summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-[var(--text-40)] hover:text-[var(--text)]">
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

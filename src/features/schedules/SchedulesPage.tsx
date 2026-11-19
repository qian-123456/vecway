import { open as openDialog } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import {
	ArrowRight,
	ArrowUp,
	Check,
	ChevronDown,
	FolderPlus,
	Loader2,
	Play,
	Plus,
	RefreshCw,
	Search,
	Settings as SettingsIcon,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { InfoTip } from "../../components/InfoTip";
import { LoadFailed } from "../../components/LoadFailed";
import { SearchInput } from "../../components/SearchInput";
import { Segmented } from "../../components/Segmented";
import type { Schedule, ScheduleDraft, ScheduleRun } from "../../lib/contracts";
import { errMsg } from "../../lib/dialogs";
import { addWorkspace } from "../../lib/ipc";
import { deriveLoadState } from "../../lib/loadState";
import { basename } from "../../lib/paths";
import { toast } from "../../lib/toast";
import { useComposer } from "../../stores/composer";
import { useT } from "../../stores/language";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { Composer } from "../chat/Composer";
import { resolveNewSessionTargetWorkspace } from "../sessions/modes";
import { isLocalDraftId, usePendingSession } from "../sessions/pendingSession";
import { useSidebarStore } from "../sessions/sidebarStore";
import { Switch } from "../settings/Switch";
import { useSettings } from "../settings/store";
import {
	AutomationConfigTab,
	type AutomationConfigHandle,
} from "./AutomationConfigTab";
import { AutomationOverviewTab } from "./AutomationOverviewTab";
import { ScheduleRow } from "./ScheduleRow";
import {
	AUTOMATION_COMPOSER_SYSTEM_PROMPT,
	useAutomationAttention,
} from "./automationAttention";
import { inspectAutomationWorktree } from "./automationWorktree";
import { formatCadence } from "./humanCadence";
import {
	draftFromSchedule,
	isRecentRun,
	lifecycleOf,
	renameDraft,
} from "./scheduleUtils";
import { useSchedulesStore } from "./schedulesStore";

type StatusFilter = "all" | "active" | "paused" | "completed";

function countPendingSkips(runs: ScheduleRun[] | undefined): number {
	if (!runs || runs.length === 0) return 0;
	let count = 0;
	for (const r of runs) {
		if (r.status === "skipped") count++;
		else break;
	}
	return count;
}

/**
 * Real `<Composer />` studio when the user explicitly chooses AI conversational
 * creation. Gates behind project directory selection matching `StartPage`.
 */
function AutomationComposerStudio() {
	const { t } = useT();
	const activeMode = useSidebarStore((s) => s.activeMode);
	const workspaces = useSessions((s) => s.workspaces);
	const sessions = useSessions((s) => s.sessions);
	const selectedSessionId = useUi((s) => s.selectedSessionId);
	const ready = workspaces.some((w) => w.mode === activeMode);
	const sessionsLoadState = deriveLoadState(
		useSessions((s) => s.hasLoaded),
		useSessions((s) => s.loadError),
	);
	const sessionsLoadError = useSessions((s) => s.loadError);

	const targetWs = useMemo(
		() =>
			resolveNewSessionTargetWorkspace(
				activeMode,
				selectedSessionId,
				sessions,
				workspaces,
			) ??
			workspaces.find((w) => w.mode === activeMode) ??
			null,
		[activeMode, selectedSessionId, sessions, workspaces],
	);

	const selectedDraftId = usePendingSession((s) =>
		s.selectedId &&
		isLocalDraftId(s.selectedId) &&
		(s.drafts[s.selectedId]?.opts.automationMode ||
			s.drafts[s.selectedId]?.opts.appendSystemPrompt ===
				AUTOMATION_COMPOSER_SYSTEM_PROMPT)
			? s.selectedId
			: null,
	);
	const startError = usePendingSession((s) =>
		selectedDraftId ? (s.drafts[selectedDraftId]?.startError ?? null) : null,
	);

	useEffect(() => {
		if (!ready || sessionsLoadState !== "ready" || !targetWs) return;
		const pending = usePendingSession.getState();
		const current = pending.selectedId
			? pending.drafts[pending.selectedId]
			: undefined;
		if (
			current &&
			current.mode === activeMode &&
			(current.opts.automationMode ||
				current.opts.appendSystemPrompt === AUTOMATION_COMPOSER_SYSTEM_PROMPT)
		) {
			useComposer.getState().focusComposer(current.id);
			return;
		}
		const draftId = pending.open({
			cwd: targetWs.path,
			workspaceId: targetWs.id,
			mode: activeMode,
			appendSystemPrompt: AUTOMATION_COMPOSER_SYSTEM_PROMPT,
			automationMode: true,
		});
		useComposer.getState().focusComposer(draftId);
	}, [ready, sessionsLoadState, targetWs, activeMode]);

	const pickDirectory = async () => {
		try {
			const sel = await openDialog({ directory: true, multiple: false });
			if (typeof sel !== "string") return;
			const ws = await addWorkspace(sel, activeMode);
			await useSessions.getState().load();
			const draftId = usePendingSession.getState().open({
				cwd: ws.path,
				workspaceId: ws.id,
				mode: activeMode,
				appendSystemPrompt: AUTOMATION_COMPOSER_SYSTEM_PROMPT,
				automationMode: true,
			});
			useComposer.getState().focusComposer(draftId);
		} catch (e) {
			toast.error(errMsg(e));
		}
	};

	return (
		<div className="flex flex-1 flex-col overflow-y-auto px-6 py-5">
			<div className="mx-auto flex w-full max-w-[780px] flex-1 flex-col">
				<div className="flex flex-1 flex-col items-center justify-center py-8">
					<div className="w-full max-w-[720px] space-y-5">
						<div className="space-y-1.5 text-center">
							<h2 className="text-[19px] font-semibold tracking-tight text-[var(--text)]">
								{t("schedules.composerStudioTitle")}
							</h2>
							<p className="mx-auto max-w-lg text-xs leading-relaxed text-[var(--text-60)]">
								{t("schedules.composerSubtitle")}
							</p>
						</div>

						{sessionsLoadState === "loading" ? (
							<div
								role="status"
								className="composer-optical-card flex w-full animate-pulse items-center gap-2 rounded-[22px] border border-[var(--composer-border,var(--border))] px-4 py-6 text-[14px] text-[var(--text-40,var(--text-dim))]"
							>
								<Loader2 size={14} className="animate-spin" />
								<span>{t("home.loading")}</span>
							</div>
						) : sessionsLoadState === "error" ? (
							<div className="composer-optical-card w-full rounded-[22px] border border-[var(--composer-border,var(--border))]">
								<LoadFailed
									what={t("home.projectList")}
									error={sessionsLoadError}
									onRetry={() =>
										void useSessions
											.getState()
											.load()
											.catch(() => {})
									}
								/>
							</div>
						) : !ready ? (
							<button
								type="button"
								onClick={() => void pickDirectory()}
								aria-label={t("home.selectProjectDirToStart")}
								className="group w-full cursor-pointer text-left focus-visible:outline-none"
							>
								<div className="relative z-0 flex items-center justify-between px-[22px]">
									<span className="inline-flex items-center gap-1.5 rounded-t-[14px] border border-b-0 border-[var(--composer-border,var(--border))] bg-[var(--bg-ear)] px-3 pt-1.5 pb-2.5 -mb-2 text-[12px] font-medium text-[var(--text)] transition-colors group-hover:text-[var(--accent)]">
										<FolderPlus size={13} className="shrink-0 text-[var(--text-muted)]" />
										<span>{t("home.selectProjectDir")}</span>
										<ChevronDown
											size={11}
											className="shrink-0 text-[var(--text-40,var(--text-dim))]"
										/>
									</span>
								</div>
								<div className="composer-optical-card relative z-10 w-full rounded-[22px] border border-[var(--composer-border,var(--border))] transition-colors group-hover:border-[var(--text-30,var(--border))] group-focus-visible:ring-1 group-focus-visible:ring-[var(--hairline-strong)]">
									<div className="px-4 pb-3 pt-3.5 text-[14px] text-[var(--text-40,var(--text-dim))]">
										{t("home.selectProjectDirFirst")}
									</div>
									<div className="flex items-center justify-between px-3.5 pb-3">
										<Plus size={16} className="text-[var(--text-40,var(--text-dim))]" />
										<span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-active-fill)] text-[var(--text-40,var(--text-dim))]">
											<ArrowUp size={15} />
										</span>
									</div>
								</div>
							</button>
						) : selectedDraftId ? (
							<div className="@container w-full">
								<Composer
									key={selectedDraftId}
									sessionId={selectedDraftId}
									placeholder={t("schedules.composerPlaceholder")}
								/>
								<div className="mt-3 flex flex-wrap items-center justify-center gap-2">
									{(
										[
											{
												labelKey: "schedules.composerStarterDaily",
												promptKey: "schedules.composerStarterDailyPrompt",
											},
											{
												labelKey: "schedules.composerStarterWatch",
												promptKey: "schedules.composerStarterWatchPrompt",
											},
											{
												labelKey: "schedules.composerStarterScript",
												promptKey: "schedules.composerStarterScriptPrompt",
											},
										] as const
									).map((starter) => (
										<button
											key={starter.labelKey}
											type="button"
											onClick={() => {
												useComposer
													.getState()
													.setDraft(selectedDraftId, t(starter.promptKey));
												useComposer.getState().focusComposer(selectedDraftId);
											}}
											className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg-panel)] px-3 py-1 text-xs font-medium text-[var(--text-60)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
										>
											{t(starter.labelKey)}
										</button>
									))}
								</div>
								{startError && (
									<div
										role="alert"
										className="mt-2 select-text px-2 text-[12px] text-rose-400"
									>
										{t("sessions.createSessionFailed", { error: startError })}
									</div>
								)}
							</div>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}

export function SchedulesPage() {
	const schedules = useSchedulesStore((s) => s.schedules);
	const runs = useSchedulesStore((s) => s.runs);
	const loading = useSchedulesStore((s) => s.loading);
	const loadError = useSchedulesStore((s) => s.loadError);
	const runningScheduleIds = useSchedulesStore((s) => s.runningScheduleIds);
	const seenRuns = useSchedulesStore((s) => s.seenRuns);
	const selectedScheduleId = useSchedulesStore((s) => s.selectedScheduleId);
	const workspaceTab = useSchedulesStore((s) => s.workspaceTab);
	const isCreating = useSchedulesStore((s) => s.isCreating);
	const creatingViaChat = useSchedulesStore((s) => s.creatingViaChat);
	const draftTemplate = useSchedulesStore((s) => s.draftTemplate);

	const load = useSchedulesStore((s) => s.load);
	const loadRuns = useSchedulesStore((s) => s.loadRuns);
	const toggleEnabled = useSchedulesStore((s) => s.toggleEnabled);
	const runNow = useSchedulesStore((s) => s.runNow);
	const removeSchedule = useSchedulesStore((s) => s.removeSchedule);
	const saveSchedule = useSchedulesStore((s) => s.saveSchedule);
	const setCreatingViaChat = useSchedulesStore((s) => s.setCreatingViaChat);
	const setSubpageBackHandler = useSchedulesStore(
		(s) => s.setSubpageBackHandler,
	);
	const openHome = useSchedulesStore((s) => s.openHome);
	const openWorkspace = useSchedulesStore((s) => s.openWorkspace);
	const setWorkspaceTab = useSchedulesStore((s) => s.setWorkspaceTab);
	const openCreate = useSchedulesStore((s) => s.openCreate);

	const { t, locale } = useT();
	const settings = useSettings((s) => s.settings);
	const loadSettings = useSettings((s) => s.load);
	const updateSettings = useSettings((s) => s.update);
	const sessions = useSessions((s) => s.sessions);
	const automationAttention = useAutomationAttention();

	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<StatusFilter>("all");
	const [pendingWorktreeIds, setPendingWorktreeIds] = useState<
		Record<string, boolean>
	>({});
	const [configUiState, setConfigUiState] = useState({
		dirty: false,
		saving: false,
	});
	const configRef = useRef<AutomationConfigHandle>(null);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (!settings) void loadSettings();
	}, [settings, loadSettings]);

	useEffect(() => {
		for (const s of schedules) {
			if (runs[s.id] !== undefined) continue;
			if (
				s.lastRunStatus === "ok" ||
				s.lastRunStatus === "error" ||
				s.lastRunStatus === "running" ||
				s.lastRunPhase === "awaiting"
			) {
				void loadRuns(s.id, 12);
			}
		}
	}, [schedules, runs, loadRuns]);

	useEffect(() => {
		const wtCandidates = schedules.filter(
			(s) =>
				s.runMode === "worktree" &&
				(s.lastRunStatus === "ok" ||
					s.lastRunStatus === "error" ||
					s.lastRunPhase === "awaiting"),
		);
		if (wtCandidates.length === 0) {
			setPendingWorktreeIds({});
			return;
		}
		let active = true;
		void Promise.all(
			wtCandidates.map(async (s) => {
				const wtState = await inspectAutomationWorktree(
					s,
					runs[s.id] ?? [],
					sessions,
				);
				return [
					s.id,
					Boolean(
						wtState &&
							(wtState.worktree.ahead > 0 ||
								wtState.worktree.dirty > 0 ||
								wtState.combinedDiff.trim().length > 0),
					),
				] as const;
			}),
		).then((entries) => {
			if (!active) return;
			const map: Record<string, boolean> = {};
			for (const [id, pending] of entries) {
				if (pending) map[id] = true;
			}
			setPendingWorktreeIds(map);
		});
		return () => {
			active = false;
		};
	}, [schedules, runs, sessions]);

	const activeSchedule = useMemo(
		() =>
			selectedScheduleId
				? (schedules.find((s) => s.id === selectedScheduleId) ?? null)
				: null,
		[schedules, selectedScheduleId],
	);

	const orderedList = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matches = (s: Schedule) => {
			if (!q) return true;
			return (
				s.name.toLowerCase().includes(q) ||
				s.prompt.toLowerCase().includes(q) ||
				(s.probeDescription ?? "").toLowerCase().includes(q) ||
				basename(s.cwd).toLowerCase().includes(q) ||
				formatCadence(s.cadence, locale).toLowerCase().includes(q)
			);
		};
		const filtered = schedules.filter(
			(s) => matches(s) && (filter === "all" || lifecycleOf(s) === filter),
		);

		const attentionWeight = (s: Schedule) => {
			const att = automationAttention.byScheduleId[s.id];
			if (att?.tone === "error" || s.lastRunStatus === "error") return 0;
			if (att?.tone === "awaiting" || pendingWorktreeIds[s.id]) return 1;
			if (att?.tone === "unread") return 2;
			if (lifecycleOf(s) === "active") return 3;
			if (lifecycleOf(s) === "paused") return 4;
			return 5;
		};

		return [...filtered].sort((a, b) => {
			const wa = attentionWeight(a);
			const wb = attentionWeight(b);
			if (wa !== wb) return wa - wb;
			return (b.lastRunAt ?? b.updatedAt).localeCompare(
				a.lastRunAt ?? a.updatedAt,
			);
		});
	}, [schedules, query, filter, locale, automationAttention, pendingWorktreeIds]);

	const handleSave = async (draft: ScheduleDraft) => {
		const saved = await saveSchedule(draft);
		if (saved) {
			setCreatingViaChat(false);
		}
		return saved;
	};

	const handleBackFromWorkspace = () => {
		if ((isCreating || workspaceTab === "config") && configRef.current) {
			void configRef.current.requestClose();
			return;
		}
		openHome();
	};

	useEffect(() => {
		if (creatingViaChat) {
			setSubpageBackHandler(() => setCreatingViaChat(false));
		} else if (isCreating || activeSchedule) {
			setSubpageBackHandler(handleBackFromWorkspace);
		} else {
			setSubpageBackHandler(null);
		}
		return () => setSubpageBackHandler(null);
	});

	// 1 & 2. Unified Subpage Workspace: Pinned Header (Create Chat / Create Manual / Inspect / Edit)
	if (creatingViaChat || isCreating || activeSchedule) {
		const isNewCreation = creatingViaChat || (isCreating && !draftTemplate?.id);
		const effectiveTab = isCreating ? "config" : workspaceTab;
		const completed = activeSchedule
			? lifecycleOf(activeSchedule) === "completed"
			: false;
		const runningNow = activeSchedule
			? Boolean(
					runningScheduleIds[activeSchedule.id] ||
						activeSchedule.lastRunStatus === "running",
				)
			: false;

		const switchCreationMode = (mode: "chat" | "manual") => {
			if (mode === "chat" && !creatingViaChat) {
				openHome();
				setCreatingViaChat(true);
				return;
			}
			if (mode === "manual" && creatingViaChat) {
				const pending = usePendingSession.getState();
				const curDraft = pending.selectedId
					? pending.drafts[pending.selectedId]
					: undefined;
				const cwd =
					curDraft &&
					(curDraft.opts.automationMode ||
						curDraft.opts.appendSystemPrompt ===
							AUTOMATION_COMPOSER_SYSTEM_PROMPT)
						? curDraft.opts.cwd
						: undefined;
				setCreatingViaChat(false);
				openCreate(cwd ? { cwd } : undefined);
			}
		};

		return (
			<div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
				{/* Single-Row Sticky Workspace Header — creation mode switcher stays dead-center pinned */}
				<header className="shrink-0 border-b border-[var(--border-divider)] px-6 py-2.5">
					{isNewCreation ? (
						<div className="mx-auto grid w-full max-w-[780px] grid-cols-[1fr_auto_1fr] items-center gap-2.5">
							<h1 className="truncate text-[16px] font-semibold tracking-tight text-[var(--text)]">
								{t("schedules.createTitle")}
							</h1>

							<Segmented<"chat" | "manual">
								pill
								size="sm"
								aria-label={t("schedules.createModeAria")}
								value={creatingViaChat ? "chat" : "manual"}
								onChange={switchCreationMode}
								options={[
									{ value: "chat", label: t("schedules.createModeChat") },
									{ value: "manual", label: t("schedules.createModeManual") },
								]}
							/>

							<div className="flex shrink-0 items-center justify-end gap-2">
								{!creatingViaChat && (
									<button
										type="button"
										disabled={configUiState.saving}
										onClick={() => void configRef.current?.submit()}
										className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-[var(--text)] px-3 text-[11.5px] font-semibold text-[var(--bg)] transition-opacity hover:opacity-85 disabled:opacity-45"
									>
										{configUiState.saving ? (
											<Loader2 size={11} className="shrink-0 animate-spin" />
										) : (
											<Check size={12} className="shrink-0" />
										)}
										<span>{t("schedules.createSchedule")}</span>
									</button>
								)}
							</div>
						</div>
					) : (
						<div className="mx-auto flex w-full max-w-[780px] flex-wrap items-center justify-between gap-2.5">
							<div className="flex min-w-0 items-center gap-2.5">
								<h1 className="truncate text-[16px] font-semibold tracking-tight text-[var(--text)]">
									{isCreating
										? t("schedules.editTitle")
										: activeSchedule!.name}
								</h1>

								{activeSchedule && (
									<span className="hidden truncate whitespace-nowrap text-[11.5px] text-[var(--text-40)] sm:inline">
										{basename(activeSchedule.cwd) || activeSchedule.cwd} ·{" "}
										{formatCadence(activeSchedule.cadence, locale)}
									</span>
								)}
							</div>

							<div className="flex shrink-0 items-center gap-2">
								{effectiveTab === "config" || isCreating ? (
									<button
										type="button"
										disabled={configUiState.saving}
										onClick={() => void configRef.current?.submit()}
										className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-[var(--text)] px-3 text-[11.5px] font-semibold text-[var(--bg)] transition-opacity hover:opacity-85 disabled:opacity-45"
									>
										{configUiState.saving ? (
											<Loader2 size={11} className="shrink-0 animate-spin" />
										) : (
											<Check size={12} className="shrink-0" />
										)}
										<span>{t("schedules.saveChanges")}</span>
									</button>
								) : (
									activeSchedule && (
										<>
											<button
												type="button"
												disabled={runningNow}
												onClick={() => void runNow(activeSchedule.id)}
												className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 text-[11.5px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-45"
											>
												{runningNow ? (
													<Loader2 size={11} className="shrink-0 animate-spin" />
												) : (
													<Play size={10} className="shrink-0" />
												)}
												<span>{t("schedules.runNow")}</span>
											</button>
											<Switch
												checked={activeSchedule.enabled}
												disabled={completed}
												onChange={(enabled) =>
													void toggleEnabled(activeSchedule.id, enabled)
												}
												ariaLabel={
													activeSchedule.enabled
														? t("schedules.pauseTask")
														: t("schedules.resumeTask")
												}
											/>
										</>
									)
								)}

								{!isCreating && activeSchedule && (
									<div
										role="tablist"
										aria-label={t("schedules.tabViewAria")}
										className="inline-flex rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] p-0.5 text-[11.5px]"
									>
										<button
											type="button"
											role="tab"
											aria-selected={effectiveTab === "overview"}
											onClick={() => setWorkspaceTab("overview")}
											className={clsx(
												"whitespace-nowrap rounded-md px-2.5 py-0.5 transition-colors",
												effectiveTab === "overview"
													? "bg-[var(--bg-active-fill)] font-medium text-[var(--text)]"
													: "text-[var(--text-60)] hover:text-[var(--text)]",
											)}
										>
											{t("schedules.tabOverview")}
										</button>
										<button
											type="button"
											role="tab"
											aria-selected={effectiveTab === "config"}
											onClick={() => setWorkspaceTab("config")}
											className={clsx(
												"whitespace-nowrap rounded-md px-2.5 py-0.5 transition-colors",
												effectiveTab === "config"
													? "bg-[var(--bg-active-fill)] font-medium text-[var(--text)]"
													: "text-[var(--text-60)] hover:text-[var(--text)]",
											)}
										>
											{t("schedules.tabConfig")}
										</button>
									</div>
								)}
							</div>
						</div>
					)}
				</header>

				{/* Canvas Body */}
				{creatingViaChat ? (
					<AutomationComposerStudio />
				) : (
					<div className="flex-1 overflow-y-auto px-6 py-4">
						<div className="mx-auto w-full max-w-[780px]">
							{effectiveTab === "overview" && activeSchedule ? (
								<AutomationOverviewTab
									schedule={activeSchedule}
									attention={
										automationAttention.byScheduleId[activeSchedule.id] ?? null
									}
									onSwitchToConfig={() => setWorkspaceTab("config")}
								/>
							) : (
								<AutomationConfigTab
									ref={configRef}
									editingSchedule={isCreating ? null : activeSchedule}
									template={isCreating ? draftTemplate : null}
									onSave={handleSave}
									onClose={openHome}
									onStateChange={setConfigUiState}
								/>
							)}
						</div>
					</div>
				)}
			</div>
		);
	}

	// 3. Load Error State (empty list)
	if (schedules.length === 0 && loadError) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center bg-[var(--bg)] px-6 py-12 text-[var(--text)]">
				<div
					role="alert"
					className="flex w-full max-w-xl items-start justify-between gap-3 rounded-xl border border-rose-800/60 bg-rose-950/40 p-4 text-xs text-rose-300"
				>
					<span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words">
						{t("schedules.loadFailed", { error: loadError })}
					</span>
					<button
						type="button"
						onClick={() => void load()}
						className="shrink-0 whitespace-nowrap rounded-lg bg-rose-900/60 px-2.5 py-1 font-medium text-rose-200 transition-colors hover:bg-rose-800/80"
					>
						{t("common.retry")}
					</button>
				</div>
			</div>
		);
	}

	// 4. Clean Typographic Dual-Card Empty State (no boxed icons, clear primary vs secondary hierarchy)
	if (schedules.length === 0) {
		const bgEnabled = settings?.automationBackgroundEnabled ?? true;
		return (
			<div className="flex flex-1 items-center justify-center bg-[var(--bg)] p-8 text-[var(--text)]">
				<div className="w-full max-w-[600px] space-y-5">
					<div className="space-y-1 px-0.5">
						<h1 className="text-[19px] font-semibold tracking-tight text-[var(--text)]">
							{t("schedules.emptyTitle")}
						</h1>
						<p className="text-[12.5px] leading-relaxed text-[var(--text-60)]">
							{t("schedules.emptyPlainDesc")}
						</p>
					</div>

					<div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
						<button
							type="button"
							onClick={() => setCreatingViaChat(true)}
							className="group flex flex-col justify-between rounded-2xl border border-[var(--hairline-strong)] bg-[var(--bg-panel)] p-5 text-left transition-colors hover:border-[var(--text-40)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--hairline-strong)]"
						>
							<div className="space-y-2.5">
								<span className="inline-flex whitespace-nowrap text-[11px] font-medium text-[var(--accent)]">
									{t("schedules.emptyRecommendedBadge")}
								</span>
								<div className="space-y-1">
									<div className="text-[14px] font-semibold text-[var(--text)]">
										{t("schedules.createInChatBtn")}
									</div>
									<p className="text-[12px] leading-relaxed text-[var(--text-60)]">
										{t("schedules.emptyAiRowDesc")}
									</p>
								</div>
							</div>

							<div className="mt-5 pt-1">
								<span className="inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--text)] px-3.5 py-2 text-xs font-medium text-[var(--bg)] transition-opacity group-hover:opacity-90">
									<span>{t("schedules.emptyAiAction")}</span>
									<ArrowRight
										size={13}
										className="shrink-0 transition-transform group-hover:translate-x-0.5"
									/>
								</span>
							</div>
						</button>

						<button
							type="button"
							onClick={() => openCreate()}
							className="group flex flex-col justify-between rounded-2xl border border-[var(--border-divider)] bg-[var(--bg-panel)] p-5 text-left transition-colors hover:border-[var(--hairline-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--hairline-strong)]"
						>
							<div className="space-y-2.5">
								<span className="inline-flex whitespace-nowrap text-[11px] font-medium text-[var(--text-40)]">
									{t("schedules.emptyManualBadge")}
								</span>
								<div className="space-y-1">
									<div className="text-[14px] font-semibold text-[var(--text)]">
										{t("schedules.emptyManualTitle")}
									</div>
									<p className="text-[12px] leading-relaxed text-[var(--text-60)]">
										{t("schedules.emptyManualRowDesc")}
									</p>
								</div>
							</div>

							<div className="mt-5 pt-1">
								<span className="inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg-hover)]/50 px-3.5 py-2 text-xs font-medium text-[var(--text)] transition-colors group-hover:border-[var(--hairline-strong)] group-hover:bg-[var(--bg-hover)]">
									<span>{t("schedules.emptyManualAction")}</span>
									<ArrowRight
										size={13}
										className="shrink-0 text-[var(--text-60)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--text)]"
									/>
								</span>
							</div>
						</button>
					</div>

					<div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-divider)] bg-[var(--bg-panel)] px-4 py-3.5">
						<div className="min-w-0 space-y-0.5">
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-[12.5px] font-medium text-[var(--text)]">
									{bgEnabled
										? t("schedules.emptyBgEnabledTitle")
										: t("schedules.emptyBgDisabledTitle")}
								</span>
								<span
									className={clsx(
										"inline-flex shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10.5px] font-medium",
										bgEnabled
											? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
											: "bg-[var(--bg-hover)] text-[var(--text-40)]",
									)}
								>
									{bgEnabled
										? t("schedules.emptyBgOnBadge")
										: t("schedules.emptyBgOffBadge")}
								</span>
							</div>
							<p className="text-[11.5px] leading-snug text-[var(--text-60)]">
								{bgEnabled
									? t("schedules.emptyBgEnabled")
									: t("schedules.emptyBgDisabled")}
							</p>
						</div>

						<div className="shrink-0">
							<Switch
								checked={bgEnabled}
								onChange={(v) =>
									void updateSettings({ automationBackgroundEnabled: v })
								}
								ariaLabel={t("schedules.bgRunLabel")}
							/>
						</div>
					</div>
				</div>
			</div>
		);
	}

	// 5. Compact Single-Canvas Automations Home (Strictly 2-Column Viewport)
	const isFiltering = query.trim().length > 0 || filter !== "all";

	return (
		<div className="flex h-full flex-1 flex-col overflow-y-auto bg-[var(--bg)] text-[var(--text)]">
			<div className="mx-auto w-full max-w-[780px] space-y-3 px-6 py-5">
				{/* Single-Row Header Bar (compact height <= 36px, zero clutter) */}
				<div className="flex min-h-[36px] flex-wrap items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						<h1 className="whitespace-nowrap text-[17px] font-semibold tracking-tight text-[var(--text)]">
							{t("schedules.title")}
						</h1>
						<span className="rounded-full bg-[var(--bg-panel)] px-2 py-0.5 text-[11px] font-medium leading-none text-[var(--text-60)] border border-[var(--border-divider)]">
							{schedules.length}
						</span>
					</div>

					<div className="flex shrink-0 items-center gap-2">
						<div className="flex items-center gap-1.5 rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1">
							<span className="whitespace-nowrap text-[11.5px] text-[var(--text-60)]">
								{t("schedules.bgRunLabel")}
							</span>
							<InfoTip text={t("schedules.bgRunTooltip")} />
							<Switch
								checked={settings?.automationBackgroundEnabled ?? true}
								onChange={(v) =>
									void updateSettings({ automationBackgroundEnabled: v })
								}
								ariaLabel={t("schedules.bgRunLabel")}
							/>
						</div>

						<button
							type="button"
							aria-expanded={searchOpen}
							aria-label={t("schedules.searchAriaLabel")}
							onClick={() => {
								if (searchOpen) {
									setSearchOpen(false);
									setQuery("");
									setFilter("all");
								} else {
									setSearchOpen(true);
								}
							}}
							className={clsx(
								"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] transition-colors",
								searchOpen || isFiltering
									? "text-[var(--text)] bg-[var(--bg-active-fill)]"
									: "text-[var(--text-40)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
							)}
						>
							<Search size={13} />
						</button>

						<button
							type="button"
							onClick={() => void load()}
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] text-[var(--text-40)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
							aria-label={t("schedules.refreshList")}
						>
							<RefreshCw size={13} className={clsx(loading && "animate-spin")} />
						</button>

						<button
							type="button"
							onClick={() => useUi.getState().openSettings("automations")}
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] text-[var(--text-40)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
							aria-label={t("schedules.openSettingsAria")}
							title={t("schedules.openSettingsAria")}
						>
							<SettingsIcon size={13} />
						</button>

						<button
							type="button"
							onClick={() => openCreate()}
							className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-[var(--text)] px-3 text-xs font-semibold text-[var(--bg)] transition-opacity hover:opacity-85"
						>
							<Plus size={13} className="shrink-0" />
							<span>{t("schedules.newSchedule")}</span>
						</button>
					</div>
				</div>

				{/* Optional expandable search & filter toolbar */}
				{(searchOpen || isFiltering) && (
					<div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-divider)] bg-[var(--bg-panel)] px-3 py-2">
						<Segmented<StatusFilter>
							size="sm"
							aria-label={t("schedules.filterAriaLabel")}
							value={filter}
							onChange={setFilter}
							options={[
								{ value: "all", label: t("schedules.filterAll") },
								{ value: "active", label: t("schedules.filterActive") },
								{ value: "paused", label: t("schedules.filterPaused") },
								{ value: "completed", label: t("schedules.filterCompleted") },
							]}
						/>
						<div className="flex items-center gap-1.5">
							<SearchInput
								value={query}
								onChange={setQuery}
								placeholder={t("schedules.searchPlaceholder")}
								ariaLabel={t("schedules.searchAriaLabel")}
								iconSize={13}
								className="w-48 sm:w-56"
								inputClassName="h-7 w-full rounded-lg hairline bg-[var(--bg)] pl-8 pr-7 text-xs text-[var(--text)] placeholder-neutral-500 transition-all focus:outline-none focus:ring-1 focus:ring-[var(--hairline-strong)]"
							/>
							<button
								type="button"
								aria-label={t("schedules.dismissHint")}
								onClick={() => {
									setSearchOpen(false);
									setQuery("");
									setFilter("all");
								}}
								className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-40)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
							>
								<X size={13} />
							</button>
						</div>
					</div>
				)}

				{/* Unified High-Density Automations List */}
				{isFiltering && orderedList.length === 0 ? (
					<EmptyState
						icon={Search}
						title={t("schedules.noMatchTitle")}
						description={t("schedules.noMatchDesc")}
					/>
				) : (
					<section aria-label={t("schedules.title")}>
						<div className="divide-y divide-[var(--border-divider)] rounded-xl border border-[var(--border-divider)] bg-[var(--bg-panel)]">
							{orderedList.map((schedule) => {
								const scheduleRuns = runs[schedule.id];
								const latestRun = scheduleRuns?.[0] ?? null;
								return (
									<ScheduleRow
										key={schedule.id}
										schedule={schedule}
										isRunning={Boolean(runningScheduleIds[schedule.id])}
										isUnread={
											Boolean(latestRun) &&
											isRecentRun(latestRun) &&
											!seenRuns[latestRun!.id]
										}
										attention={
											automationAttention.byScheduleId[schedule.id] ?? null
										}
										latestRun={latestRun}
										skippedCount={countPendingSkips(scheduleRuns)}
										hasPendingWorktree={Boolean(pendingWorktreeIds[schedule.id])}
										onOpenOverview={() => openWorkspace(schedule, "overview")}
										onOpenConfig={() => openWorkspace(schedule, "config")}
										onToggleEnabled={(enabled) =>
											void toggleEnabled(schedule.id, enabled)
										}
										onRunNow={() => void runNow(schedule.id)}
										onDuplicate={() => openCreate(draftFromSchedule(schedule))}
										onDelete={() => void removeSchedule(schedule.id)}
										onRename={(name) =>
											void saveSchedule(renameDraft(schedule, name))
										}
									/>
								);
							})}
						</div>
					</section>
				)}
			</div>
		</div>
	);
}

import clsx from "clsx";
import {
	Copy,
	Edit2,
	Loader2,
	MoreHorizontal,
	Pause,
	PenLine,
	Play,
	Trash2,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import type { Schedule, ScheduleRun } from "../../lib/contracts";
import { claimEscape } from "../../lib/escapeClaim";
import { isComposing } from "../../lib/hooks";
import { basename } from "../../lib/paths";
import { useT } from "../../stores/language";
import { Switch } from "../settings/Switch";
import {
	type AutomationScheduleAttention,
	acknowledgeAutomationAttention,
} from "./automationAttention";
import { formatCadence, formatRelativeTime } from "./humanCadence";
import { lifecycleOf } from "./scheduleUtils";

interface Props {
	schedule: Schedule;
	isRunning: boolean;
	isUnread: boolean;
	attention?: AutomationScheduleAttention | null;
	latestRun?: ScheduleRun | null;
	skippedCount?: number;
	hasPendingWorktree?: boolean;
	onOpenOverview: () => void;
	onOpenConfig: () => void;
	onToggleEnabled: (enabled: boolean) => void;
	onRunNow: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
	/** Persist a new display name (already trimmed, non-empty, changed). */
	onRename: (name: string) => void;
}

const MENU_ITEM =
	"flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 pr-3 py-1.5 text-left text-[var(--text-60)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40 transition-all active:scale-[0.98]";

function deriveRowSubtitle(
	schedule: Schedule,
	latestRun: ScheduleRun | null | undefined,
	skippedCount: number,
	locale: "zh-CN" | "en-US",
	t: (k: string, vars?: Record<string, string | number>) => string,
): string {
	const parts: string[] = [];
	if (schedule.lastRunAt) {
		parts.push(formatRelativeTime(schedule.lastRunAt, locale));
	}
	if (latestRun?.phase === "probe_quiet" && latestRun.status === "ok") {
		parts.push(t("schedules.statusLastQuiet"));
	} else if (latestRun?.summary?.trim()) {
		parts.push(latestRun.summary.trim().split("\n")[0]!);
	} else if (schedule.agentTrigger === "on_signal") {
		parts.push(t("schedules.modeCardSignalDesc"));
	} else if (schedule.agentTrigger === "never") {
		parts.push(t("schedules.modeCardNeverDesc"));
	} else {
		parts.push(t("schedules.modeCardAlwaysDesc"));
	}
	if (skippedCount > 0) {
		parts.push(
			locale === "zh-CN"
				? `暂停期间已自动跳过 ${skippedCount} 次重复触发`
				: `${skippedCount} due runs coalesced`,
		);
	}
	return parts.join(" · ");
}

export const ScheduleRow = React.memo(function ScheduleRow({
	schedule,
	isRunning,
	isUnread,
	attention = null,
	latestRun = null,
	skippedCount = 0,
	hasPendingWorktree = false,
	onOpenOverview,
	onOpenConfig,
	onToggleEnabled,
	onRunNow,
	onDuplicate,
	onDelete,
	onRename,
}: Props) {
	const { t, locale } = useT();
	const [menuOpen, setMenuOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const menuBtnRef = useRef<HTMLButtonElement>(null);
	const [renaming, setRenaming] = useState(false);
	const [nameDraft, setNameDraft] = useState(schedule.name);
	const nameInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!renaming) return;
		nameInputRef.current?.focus();
		nameInputRef.current?.select();
	}, [renaming]);

	const startRename = () => {
		setNameDraft(schedule.name);
		setRenaming(true);
	};
	const finishRename = (commit: boolean) => {
		setRenaming(false);
		const next = nameDraft.trim();
		if (commit && next && next !== schedule.name) onRename(next);
	};

	const lifecycle = lifecycleOf(schedule);
	const runningNow = isRunning || schedule.lastRunStatus === "running";
	const lastFailed = schedule.lastRunStatus === "error";
	const lastQuiet =
		schedule.lastRunStatus === "ok" && schedule.lastRunPhase === "probe_quiet";
	const completed = lifecycle === "completed";

	const isError = !runningNow && (attention?.tone === "error" || lastFailed);
	const isScriptError =
		isError &&
		Boolean(attention?.probeError || latestRun?.phase === "probe_only");
	const isAwaiting = !runningNow && !isError && attention?.tone === "awaiting";
	const isPatchReady = !runningNow && !isError && hasPendingWorktree;
	const isNewResult =
		!runningNow &&
		!isError &&
		!isAwaiting &&
		!isPatchReady &&
		(attention?.tone === "unread" || (isUnread && !lastQuiet));

	const cadenceLabel = formatCadence(schedule.cadence, locale);
	const projectLabel = basename(schedule.cwd) || schedule.cwd;
	const subtitle = deriveRowSubtitle(schedule, latestRun, skippedCount, locale, t);

	const handleInspect = () => {
		if (attention && attention.tone !== "awaiting") {
			void acknowledgeAutomationAttention(schedule.id);
		}
		onOpenOverview();
	};

	const closeMenu = () => {
		setMenuOpen(false);
		setConfirmDelete(false);
	};

	const dotClass = runningNow
		? "bg-sky-400 animate-pulse motion-reduce:animate-none"
		: isError
			? "bg-rose-400"
			: isAwaiting || isPatchReady
				? "bg-amber-400"
				: schedule.enabled
					? "bg-emerald-400"
					: "bg-neutral-500";

	return (
		<div className="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-hover)]/45">
			{/* Left: Semantic clickable inspection region (strictly status + factual context) */}
			{renaming ? (
				<div className="flex min-w-0 flex-1 items-center gap-2.5">
					<span className={clsx("h-2 w-2 shrink-0 rounded-full", dotClass)} />
					<input
						ref={nameInputRef}
						value={nameDraft}
						aria-label={t("schedules.taskTitle")}
						maxLength={80}
						onChange={(e) => setNameDraft(e.target.value)}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (isComposing(e)) return;
							if (e.key === "Enter") {
								e.preventDefault();
								finishRename(true);
							} else if (e.key === "Escape") {
								claimEscape(e);
								finishRename(false);
							}
						}}
						onBlur={() => finishRename(true)}
						className="min-w-0 flex-1 rounded-md bg-[var(--bg)] px-2 py-1 text-[13px] font-medium text-[var(--text)] hairline-outset focus:outline-none"
					/>
				</div>
			) : (
				<button
					type="button"
					onClick={handleInspect}
					className="min-w-0 flex-1 cursor-pointer space-y-0.5 text-left focus:outline-none focus-visible:underline"
				>
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<span className={clsx("h-2 w-2 shrink-0 rounded-full", dotClass)} />
						<span className="truncate text-[13px] font-medium text-[var(--text)]">
							{schedule.name}
						</span>

						{/* Passive non-interactive Status Badge (never a bare verb) */}
						{runningNow ? (
							<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-sky-700 dark:text-sky-300">
								<Loader2 size={10} className="shrink-0 animate-spin" />
								<span>{t("schedules.statusRunningNow")}</span>
							</span>
						) : isError ? (
							<span className="inline-flex shrink-0 items-center whitespace-nowrap rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-rose-700 dark:text-rose-300">
								{isScriptError
									? t("schedules.statusBadgeScriptError")
									: t("schedules.statusBadgeRunError")}
							</span>
						) : isPatchReady ? (
							<span className="inline-flex shrink-0 items-center whitespace-nowrap rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
								{t("schedules.statusBadgePatchReady")}
							</span>
						) : isAwaiting ? (
							<span className="inline-flex shrink-0 items-center whitespace-nowrap rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
								{t("schedules.statusBadgeAwaitingConfirm")}
							</span>
						) : isNewResult ? (
							<span className="inline-flex shrink-0 items-center whitespace-nowrap rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-sky-700 dark:text-sky-300">
								{t("schedules.statusBadgeNewResult")}
							</span>
						) : (
							<span className="shrink-0 whitespace-nowrap text-[11.5px] text-[var(--text-40)]">
								{completed
									? `${t("schedules.statusCompleted")} · ${cadenceLabel}`
									: schedule.enabled
										? `${t("schedules.statusRunningNormal")} · ${cadenceLabel}`
										: `${t("schedules.statusPaused")} · ${cadenceLabel}`}
							</span>
						)}

						{projectLabel && (
							<span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-[var(--text-40)]">
								{projectLabel}
							</span>
						)}
					</div>

					<div className="truncate pl-4 text-[11.5px] text-[var(--text-60)]">
						{subtitle}
					</div>
				</button>
			)}

			{/* Right: Explicit Action Button (Verb + ->) + Switch + Overflow */}
			<div className="flex shrink-0 items-center gap-2">
				{isError ? (
					<button
						type="button"
						onClick={handleInspect}
						className="inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg border border-rose-500/35 bg-rose-500/15 px-2.5 text-[11.5px] font-medium text-rose-800 transition-colors hover:bg-rose-500/25 dark:text-rose-200 dark:hover:text-white"
					>
						{t("schedules.actionInspectAndFix")}
					</button>
				) : isPatchReady ? (
					<button
						type="button"
						onClick={handleInspect}
						className="inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg border border-amber-500/35 bg-amber-500/15 px-2.5 text-[11.5px] font-medium text-amber-800 transition-colors hover:bg-amber-500/25 dark:text-amber-200 dark:hover:text-white"
					>
						{t("schedules.actionReviewPatch")}
					</button>
				) : isAwaiting ? (
					<button
						type="button"
						onClick={handleInspect}
						className="inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg border border-amber-500/35 bg-amber-500/15 px-2.5 text-[11.5px] font-medium text-amber-800 transition-colors hover:bg-amber-500/25 dark:text-amber-200 dark:hover:text-white"
					>
						{t("schedules.actionReviewAndHandle")}
					</button>
				) : (
					<button
						type="button"
						disabled={runningNow}
						onClick={onRunNow}
						aria-label={t("schedules.runNow")}
						className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-2.5 text-[11.5px] font-medium text-[var(--text-60)] transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--text)] disabled:opacity-45"
					>
						{runningNow ? (
							<Loader2 size={10} className="shrink-0 animate-spin" />
						) : (
							<Play size={9} className="shrink-0" />
						)}
						<span>{t("schedules.runNow")}</span>
					</button>
				)}

				<Switch
					checked={schedule.enabled}
					disabled={completed}
					onChange={onToggleEnabled}
					title={
						completed
							? t("schedules.taskCompleted")
							: schedule.enabled
								? t("schedules.pauseTask")
								: t("schedules.resumeTask")
					}
					ariaLabel={
						schedule.enabled
							? `${t("schedules.pauseTask")} ${schedule.name}`
							: `${t("schedules.resumeTask")} ${schedule.name}`
					}
				/>

				<div className="relative">
					<button
						ref={menuBtnRef}
						type="button"
						aria-label={t("schedules.moreActions")}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						onClick={() => {
							setConfirmDelete(false);
							setMenuOpen((v) => !v);
						}}
						className={clsx(
							"flex h-7 w-7 items-center justify-center rounded-lg transition-all active:scale-95",
							menuOpen
								? "bg-[var(--bg-active-fill)] text-[var(--text)]"
								: "text-[var(--text-40)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
						)}
					>
						<MoreHorizontal size={14} />
					</button>

					<FloatingLayer
						anchor={menuOpen ? menuBtnRef.current : null}
						placement="bottom-end"
						offset={4}
						layer="menu"
						ignoreRefs={[menuBtnRef]}
						onDismiss={closeMenu}
						role="menu"
						aria-orientation="vertical"
						className="w-max min-w-[130px] max-w-[260px] p-1 text-xs"
					>
						<button
							type="button"
							role="menuitem"
							disabled={runningNow}
							onClick={() => {
								closeMenu();
								onRunNow();
							}}
							className={MENU_ITEM}
						>
							<Play size={13} className="shrink-0 text-[var(--text-40)]" />
							<span className="flex-1 whitespace-nowrap">{t("schedules.runNow")}</span>
						</button>

						<button
							type="button"
							role="menuitem"
							disabled={completed}
							onClick={() => {
								closeMenu();
								onToggleEnabled(!schedule.enabled);
							}}
							className={MENU_ITEM}
						>
							{schedule.enabled ? (
								<Pause size={13} className="shrink-0 text-[var(--text-40)]" />
							) : (
								<Play size={13} className="shrink-0 text-[var(--text-40)]" />
							)}
							<span className="flex-1 whitespace-nowrap">
								{schedule.enabled ? t("schedules.pause") : t("schedules.resume")}
							</span>
						</button>

						<button
							type="button"
							role="menuitem"
							onClick={() => {
								closeMenu();
								onOpenConfig();
							}}
							className={MENU_ITEM}
						>
							<Edit2 size={13} className="shrink-0 text-[var(--text-40)]" />
							<span className="flex-1 whitespace-nowrap">{t("schedules.tabConfig")}</span>
						</button>

						<button
							type="button"
							role="menuitem"
							onClick={() => {
								closeMenu();
								startRename();
							}}
							className={MENU_ITEM}
						>
							<PenLine size={13} className="shrink-0 text-[var(--text-40)]" />
							<span className="flex-1 whitespace-nowrap">{t("schedules.rename")}</span>
						</button>

						<button
							type="button"
							role="menuitem"
							onClick={() => {
								closeMenu();
								onDuplicate();
							}}
							className={MENU_ITEM}
						>
							<Copy size={13} className="shrink-0 text-[var(--text-40)]" />
							<span className="flex-1 whitespace-nowrap">{t("schedules.duplicate")}</span>
						</button>

						<div className="my-1 border-t border-[var(--border-divider)]" />

						{confirmDelete ? (
							<div className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1.5">
								<span className="flex-1 text-[11px] text-rose-300">
									{t("schedules.deleteConfirm")}
								</span>
								<button
									type="button"
									onClick={() => {
										closeMenu();
										onDelete();
									}}
									className="whitespace-nowrap rounded-md bg-rose-500/20 px-2 py-0.5 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/35"
								>
									{t("common.delete")}
								</button>
								<button
									type="button"
									onClick={() => setConfirmDelete(false)}
									className="whitespace-nowrap rounded-md border border-[var(--border-divider)] px-2 py-0.5 text-[11px] text-[var(--text-60)] hover:text-[var(--text)]"
								>
									{t("common.cancel")}
								</button>
							</div>
						) : (
							<button
								type="button"
								role="menuitem"
								onClick={() => setConfirmDelete(true)}
								className={clsx(
									MENU_ITEM,
									"text-rose-400 hover:!bg-rose-500/10 hover:!text-rose-300",
								)}
							>
								<Trash2 size={13} className="shrink-0" />
								<span className="flex-1 whitespace-nowrap">{t("common.delete")}</span>
							</button>
						)}
					</FloatingLayer>
				</div>
			</div>
		</div>
	);
});

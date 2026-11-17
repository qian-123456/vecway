import clsx from "clsx";
import { Check, ChevronRight } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import { markSeen } from "../../lib/ipc";
import { useT } from "../../stores/language";
import { useSessions } from "../../stores/sessions";
import { useSettings } from "../settings/store";
import {
	type SidebarGroupBy,
	type SidebarProjectSort,
	type SidebarSessionSort,
	type SidebarStatusFilter,
	type SidebarTimeFilter,
	useSidebarStore,
} from "./sidebarStore";

export interface SidebarFilterPopoverProps {
	anchor: HTMLElement | null;
	ignoreRefs: RefObject<HTMLElement | null>[];
	onClose: () => void;
}

type SubmenuKey =
	| "groupBy"
	| "sortConversations"
	| "sortProjects"
	| "filter"
	| "display";

export function SidebarFilterPopover({
	anchor,
	ignoreRefs,
	onClose,
}: SidebarFilterPopoverProps) {
	const { t } = useT();
	const activeMode = useSidebarStore((s) => s.activeMode);
	const groupBy = useSidebarStore((s) => s.groupBy);
	const setGroupBy = useSidebarStore((s) => s.setGroupBy);
	const sessionSort = useSidebarStore((s) => s.sessionSort);
	const setSessionSort = useSidebarStore((s) => s.setSessionSort);
	const projectSort = useSidebarStore((s) => s.projectSort);
	const setProjectSort = useSidebarStore((s) => s.setProjectSort);
	const statusFilter = useSidebarStore((s) => s.statusFilter);
	const setStatusFilter = useSidebarStore((s) => s.setStatusFilter);
	const timeFilter = useSidebarStore((s) => s.timeFilter);
	const setTimeFilter = useSidebarStore((s) => s.setTimeFilter);
	const showArchived = useSidebarStore((s) => s.showArchived);
	const setShowArchived = useSidebarStore((s) => s.setShowArchived);
	const hideEmptyProjects = useSidebarStore((s) => s.hideEmptyProjects);
	const setHideEmptyProjects = useSidebarStore((s) => s.setHideEmptyProjects);
	const showUnassigned = useSidebarStore((s) => s.showUnassigned);
	const setShowUnassigned = useSidebarStore((s) => s.setShowUnassigned);
	const autoPin = useSidebarStore((s) => s.autoPin);
	const setAutoPin = useSidebarStore((s) => s.setAutoPin);
	const archivedOnly = useSidebarStore((s) => s.archivedOnly);
	const setArchivedOnly = useSidebarStore((s) => s.setArchivedOnly);
	const resetSidebarFilters = useSidebarStore((s) => s.resetSidebarFilters);

	const settings = useSettings((s) => s.settings);
	const sessions = useSessions((s) => s.sessions);

	const [activeSubmenu, setActiveSubmenu] = useState<SubmenuKey | null>(null);
	const rootMenuRef = useRef<HTMLDivElement>(null);
	const triggerRefs = useRef<Partial<Record<SubmenuKey, HTMLButtonElement | null>>>({});
	const closeTimerRef = useRef<number | null>(null);

	useEffect(() => {
		return () => {
			if (closeTimerRef.current !== null) {
				clearTimeout(closeTimerRef.current);
				closeTimerRef.current = null;
			}
		};
	}, []);

	if (!anchor) return null;

	const clearCloseTimer = () => {
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};

	const openSubmenu = (key: SubmenuKey) => {
		clearCloseTimer();
		setActiveSubmenu(key);
	};

	const scheduleCloseSubmenu = () => {
		clearCloseTimer();
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			setActiveSubmenu(null);
		}, 120);
	};

	const closeSubmenuNow = () => {
		clearCloseTimer();
		setActiveSubmenu(null);
	};

	const groupByWorktreeSetting = settings?.sessionGroupByWorktree ?? true;
	const effectiveGroupBy: SidebarGroupBy =
		groupBy === "none"
			? "none"
			: activeMode === "code" && groupBy === "worktree" && groupByWorktreeSetting
				? "worktree"
				: "project";

	const groupBySummary =
		effectiveGroupBy === "worktree"
			? t("sidebar.groupByWorktree")
			: effectiveGroupBy === "none"
				? t("sidebar.groupByNone")
				: t("sidebar.groupByProject");

	const sessionSortSummary =
		sessionSort === "created"
			? t("sidebar.sortCreated")
			: sessionSort === "title"
				? t("sidebar.sortTitle")
				: t("sidebar.sortLastUpdated");

	const projectSortSummary =
		projectSort === "updated"
			? t("sidebar.sortLastUpdated")
			: projectSort === "name"
				? t("sidebar.sortProjectName")
				: t("sidebar.sortCustomOrder");

	const unreadSessions = Object.values(sessions).filter(
		(s) => s.mode === activeMode && s.unread,
	);

	const filterSummary =
		statusFilter !== "all"
			? statusFilter === "attention"
				? t("sidebar.filterStatusAttention")
				: statusFilter === "running"
					? t("sidebar.filterStatusRunning")
					: t("sidebar.filterStatusUnread")
			: timeFilter !== "all"
				? timeFilter === "today"
					? t("sessions.filterTimeToday")
					: timeFilter === "7days"
						? t("sessions.filterTime7Days")
						: t("sessions.filterTime30Days")
				: undefined;

	const groupByOptions: Array<{ value: SidebarGroupBy; label: string }> =
		activeMode === "code"
			? [
					{ value: "worktree", label: t("sidebar.groupByWorktree") },
					{ value: "project", label: t("sidebar.groupByProject") },
					{ value: "none", label: t("sidebar.groupByNone") },
				]
			: [
					{ value: "project", label: t("sidebar.groupByProject") },
					{ value: "none", label: t("sidebar.groupByNone") },
				];

	const sessionSortOptions: Array<{ value: SidebarSessionSort; label: string }> = [
		{ value: "updated", label: t("sidebar.sortLastUpdated") },
		{ value: "created", label: t("sidebar.sortCreated") },
		{ value: "title", label: t("sidebar.sortTitle") },
	];

	const projectSortOptions: Array<{ value: SidebarProjectSort; label: string }> = [
		{ value: "custom", label: t("sidebar.sortCustomOrder") },
		{ value: "updated", label: t("sidebar.sortLastUpdated") },
		{ value: "name", label: t("sidebar.sortProjectName") },
	];

	const statusOptions: Array<{ value: SidebarStatusFilter; label: string }> = [
		{ value: "all", label: t("sidebar.filterStatusAll") },
		{ value: "attention", label: t("sidebar.filterStatusAttention") },
		{ value: "running", label: t("sidebar.filterStatusRunning") },
		{ value: "unread", label: t("sidebar.filterStatusUnread") },
	];

	const timeOptions: Array<{ value: SidebarTimeFilter; label: string }> = [
		{ value: "all", label: t("sessions.filterTimeAll") },
		{ value: "today", label: t("sessions.filterTimeToday") },
		{ value: "7days", label: t("sessions.filterTime7Days") },
		{ value: "30days", label: t("sessions.filterTime30Days") },
	];

	const handleSelectGroupBy = (next: SidebarGroupBy) => {
		setGroupBy(next);
		if (next === "worktree" && settings !== null) {
			void useSettings.getState().update({ sessionGroupByWorktree: true });
		} else if (next === "project" && settings !== null) {
			void useSettings.getState().update({ sessionGroupByWorktree: false });
		}
	};

	const handleMarkAllRead = () => {
		if (unreadSessions.length === 0) return;
		useSessions
			.getState()
			.upsert(unreadSessions.map((s) => ({ ...s, unread: false })));
		void Promise.allSettled(unreadSessions.map((s) => markSeen(s.id)));
		onClose();
	};

	const activeTriggerEl = activeSubmenu ? (triggerRefs.current[activeSubmenu] ?? null) : null;

	return (
		<>
			<FloatingLayer
				anchor={anchor}
				placement="bottom-start"
				offset={4}
				layer="popover"
				ignoreRefs={ignoreRefs}
				onDismiss={onClose}
				className="w-max select-none rounded-xl border border-[var(--border-divider)] !bg-[var(--bg-panel)] p-1 text-xs text-[var(--text)] shadow-apple-modal"
			>
				<div
					ref={rootMenuRef}
					role="menu"
					aria-label={t("sidebar.displayOptionsTitle")}
				>
					<SubmenuTriggerRow
						label={t("sidebar.displayGroupBy")}
						summary={groupBySummary}
						active={activeSubmenu === "groupBy"}
						buttonRef={(el) => {
							triggerRefs.current.groupBy = el;
						}}
						onOpen={() => openSubmenu("groupBy")}
						onLeave={scheduleCloseSubmenu}
					/>
					<SubmenuTriggerRow
						label={t("sidebar.sortConversations")}
						summary={sessionSortSummary}
						active={activeSubmenu === "sortConversations"}
						buttonRef={(el) => {
							triggerRefs.current.sortConversations = el;
						}}
						onOpen={() => openSubmenu("sortConversations")}
						onLeave={scheduleCloseSubmenu}
					/>
					<SubmenuTriggerRow
						label={t("sidebar.sortProjects")}
						summary={projectSortSummary}
						active={activeSubmenu === "sortProjects"}
						buttonRef={(el) => {
							triggerRefs.current.sortProjects = el;
						}}
						onOpen={() => openSubmenu("sortProjects")}
						onLeave={scheduleCloseSubmenu}
					/>

					<div className="my-1 h-px bg-[var(--border-divider)]" />

					<SubmenuTriggerRow
						label={t("sidebar.displayMenuFilter")}
						summary={filterSummary}
						active={activeSubmenu === "filter"}
						buttonRef={(el) => {
							triggerRefs.current.filter = el;
						}}
						onOpen={() => openSubmenu("filter")}
						onLeave={scheduleCloseSubmenu}
					/>
					<SubmenuTriggerRow
						label={t("sidebar.displayMenuDisplay")}
						active={activeSubmenu === "display"}
						buttonRef={(el) => {
							triggerRefs.current.display = el;
						}}
						onOpen={() => openSubmenu("display")}
						onLeave={scheduleCloseSubmenu}
					/>
					<CheckboxMenuRow
						label={t("sidebar.autoPin")}
						checked={autoPin}
						onToggle={() => setAutoPin(!autoPin)}
						onHover={closeSubmenuNow}
					/>
					<CheckboxMenuRow
						label={t("sidebar.archivedOnly")}
						checked={archivedOnly}
						onToggle={() => setArchivedOnly(!archivedOnly)}
						onHover={closeSubmenuNow}
					/>

					<div className="my-1 h-px bg-[var(--border-divider)]" />

					<button
						type="button"
						role="menuitem"
						disabled={unreadSessions.length === 0}
						onMouseEnter={closeSubmenuNow}
						onClick={handleMarkAllRead}
						className={clsx(
							"flex w-full items-center whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
							unreadSessions.length === 0
								? "cursor-not-allowed text-[var(--text-dim)]"
								: "text-[var(--text)] hover:bg-[var(--bg-hover)]",
						)}
					>
						{t("sidebar.markAllRead")}
					</button>
				</div>
			</FloatingLayer>

			{activeSubmenu && activeTriggerEl && (
				<FloatingLayer
					anchor={activeTriggerEl}
					placement="right-start"
					offset={4}
					layer="menu"
					ignoreRefs={[rootMenuRef]}
					onDismiss={() => setActiveSubmenu(null)}
					className="w-max select-none rounded-xl border border-[var(--border-divider)] !bg-[var(--bg-panel)] p-1 text-xs text-[var(--text)] shadow-apple-modal"
				>
					<div
						role="menu"
						aria-label={t(`sidebar.${submenuAriaKey(activeSubmenu)}`)}
						onMouseEnter={clearCloseTimer}
						onMouseLeave={scheduleCloseSubmenu}
					>
						{activeSubmenu === "groupBy" &&
							groupByOptions.map((opt) => (
								<RadioMenuRow
									key={opt.value}
									label={opt.label}
									selected={effectiveGroupBy === opt.value}
									onSelect={() => handleSelectGroupBy(opt.value)}
								/>
							))}

						{activeSubmenu === "sortConversations" &&
							sessionSortOptions.map((opt) => (
								<RadioMenuRow
									key={opt.value}
									label={opt.label}
									selected={sessionSort === opt.value}
									onSelect={() => setSessionSort(opt.value)}
								/>
							))}

						{activeSubmenu === "sortProjects" &&
							projectSortOptions.map((opt) => (
								<RadioMenuRow
									key={opt.value}
									label={opt.label}
									selected={projectSort === opt.value}
									onSelect={() => setProjectSort(opt.value)}
								/>
							))}

						{activeSubmenu === "filter" && (
							<>
								<div className="px-2 py-0.5 text-[10.5px] font-medium text-[var(--text-dim)]">
									{t("sidebar.filterStatusLabel")}
								</div>
								{statusOptions.map((opt) => (
									<RadioMenuRow
										key={opt.value}
										label={opt.label}
										selected={statusFilter === opt.value}
										onSelect={() => setStatusFilter(opt.value)}
									/>
								))}
								<div className="my-1 h-px bg-[var(--border-divider)]" />
								<div className="px-2 py-0.5 text-[10.5px] font-medium text-[var(--text-dim)]">
									{t("sessions.filterTimeRange")}
								</div>
								{timeOptions.map((opt) => (
									<RadioMenuRow
										key={opt.value}
										label={opt.label}
										selected={timeFilter === opt.value}
										onSelect={() => setTimeFilter(opt.value)}
									/>
								))}
								{(statusFilter !== "all" || timeFilter !== "all") && (
									<>
										<div className="my-1 h-px bg-[var(--border-divider)]" />
										<button
											type="button"
											role="menuitem"
											onClick={resetSidebarFilters}
											className="flex w-full items-center whitespace-nowrap rounded-lg px-2 py-1.5 text-left text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
										>
											{t("sessions.filterClear")}
										</button>
									</>
								)}
							</>
						)}

						{activeSubmenu === "display" && (
							<>
								<CheckboxMenuRow
									label={t("sidebar.filterHideEmptyProjects")}
									checked={hideEmptyProjects}
									onToggle={() => setHideEmptyProjects(!hideEmptyProjects)}
								/>
								<CheckboxMenuRow
									label={t("sidebar.filterShowArchived")}
									checked={showArchived}
									onToggle={() => setShowArchived(!showArchived)}
								/>
								<CheckboxMenuRow
									label={t("sidebar.displayShowUnassigned")}
									checked={showUnassigned}
									onToggle={() => setShowUnassigned(!showUnassigned)}
								/>
							</>
						)}
					</div>
				</FloatingLayer>
			)}
		</>
	);
}

function submenuAriaKey(key: SubmenuKey) {
	switch (key) {
		case "groupBy":
			return "displayGroupBy";
		case "sortConversations":
			return "sortConversations";
		case "sortProjects":
			return "sortProjects";
		case "filter":
			return "displayMenuFilter";
		case "display":
			return "displayMenuDisplay";
	}
}

function SubmenuTriggerRow({
	label,
	summary,
	active,
	buttonRef,
	onOpen,
	onLeave,
}: {
	label: string;
	summary?: string;
	active: boolean;
	buttonRef: (el: HTMLButtonElement | null) => void;
	onOpen: () => void;
	onLeave: () => void;
}) {
	return (
		<button
			ref={buttonRef}
			type="button"
			role="menuitem"
			aria-haspopup="menu"
			aria-expanded={active}
			onMouseEnter={onOpen}
			onMouseLeave={onLeave}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "ArrowRight") {
					e.preventDefault();
					onOpen();
				}
			}}
			className={clsx(
				"flex w-full items-center justify-between gap-6 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
				active
					? "bg-[var(--bg-hover)] text-[var(--text)]"
					: "text-[var(--text)] hover:bg-[var(--bg-hover)]",
			)}
		>
			<span>{label}</span>
			<span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-dim)]">
				{summary && <span>{summary}</span>}
				<ChevronRight size={13} className="shrink-0" />
			</span>
		</button>
	);
}

function RadioMenuRow({
	label,
	selected,
	onSelect,
}: {
	label: string;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={selected}
			onClick={onSelect}
			className={clsx(
				"flex w-full items-center justify-between gap-4 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-hover)]",
				selected ? "font-medium text-[var(--text)]" : "text-[var(--text-muted)]",
			)}
		>
			<span>{label}</span>
			{selected && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
		</button>
	);
}

function CheckboxMenuRow({
	label,
	checked,
	onToggle,
	onHover,
}: {
	label: string;
	checked: boolean;
	onToggle: () => void;
	onHover?: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitemcheckbox"
			aria-checked={checked}
			onMouseEnter={onHover}
			onClick={onToggle}
			className="flex w-full items-center justify-between gap-4 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)]"
		>
			<span>{label}</span>
			{checked && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
		</button>
	);
}

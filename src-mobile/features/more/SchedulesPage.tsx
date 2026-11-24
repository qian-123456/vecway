/**
 * Mobile Automations dashboard (Wave 5D):
 * - Header background daemon toggle, automation settings sheet shortcut, search & status filter pills
 * - Attention-tiered sorting: error -> awaiting/patch -> unread -> active -> paused -> completed
 * - Empty state & creation sheet offering both "AI 对话定制" and "手动配置"
 * - Per-row status/worktree/attention chips and popover menu with Overview, Edit, Duplicate, Rename, Run Now, Delete
 */
import {
	CalendarClock,
	Copy,
	Edit3,
	FolderGit2,
	History,
	MoreHorizontal,
	Pencil,
	Play,
	Plus,
	Search,
	SlidersHorizontal,
	Sparkles,
	Terminal,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../core/api";
import { nav, paths } from "../../core/nav";
import {
	deriveScheduleAttention,
	sortSchedulesForDashboard,
	useMobileSchedules,
} from "../../core/stores/schedules";
import {
	AnchoredPopover,
	BottomSheet,
	Button,
	Chip,
	confirm,
	EmptyState,
	IconButton,
	inputCls,
	ListGroup,
	MenuRow,
	PageHeader,
	PullToRefresh,
	Switch,
	toast,
} from "../../ui";
import type { ChipTone } from "../../ui";
import { startAutomationChat } from "../chat/automation/automationStatus";
import { AutomationSettingsSheet } from "../settings/sheets/AutomationSettingsSheet";
import { LoadState } from "./controls";
import {
	AGENT_TRIGGER_LABEL,
	cadenceText,
	LIFECYCLE_LABEL,
	resolveAgentTrigger,
	scheduleMeta,
	type AutomationSettingsSnapshot,
	type Schedule,
} from "./schedule";

const ICON = { size: 20, strokeWidth: 1.75 } as const;

type FilterTab = "all" | "active" | "paused" | "completed";
const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
	{ id: "all", label: "全部" },
	{ id: "active", label: "运行中" },
	{ id: "paused", label: "已暂停" },
	{ id: "completed", label: "已完成" },
];

const lifecycleTone = (s: Schedule): ChipTone =>
	s.lifecycle === "active"
		? s.enabled
			? "success"
			: "neutral"
		: s.lifecycle === "paused"
			? "warn"
			: "neutral";

function ScheduleRow({
	s,
	busy,
	attention,
	hasWorktreePatch,
	onOpenDetail,
	onOpenMenu,
	onToggle,
}: {
	s: Schedule;
	busy: boolean;
	attention: ReturnType<typeof deriveScheduleAttention>;
	hasWorktreePatch: boolean;
	onOpenDetail: () => void;
	onOpenMenu: (anchorEl: HTMLElement) => void;
	onToggle: () => void;
}) {
	const meta = scheduleMeta(s);
	const trigger = resolveAgentTrigger(s);
	const attTone: ChipTone =
		attention?.tone === "error"
			? "danger"
			: attention?.tone === "awaiting" || attention?.tone === "patch"
				? "warn"
				: "accent";
	return (
		<div className="m-list-row flex w-full items-stretch pl-4" data-testid="schedule-card">
			<div className="m-list-sep flex min-w-0 flex-1 items-center gap-1.5 pr-3">
				<button
					type="button"
					onClick={onOpenDetail}
					className="min-w-0 flex-1 py-3.5 text-left active:opacity-60"
				>
					<span className="block text-m-md font-medium break-words text-m-text">{s.name}</span>
					<span className="mt-0.5 block text-m-sm break-words text-m-text-2">
						{cadenceText(s.cadence)}
					</span>
					<span className="mt-2 flex flex-wrap items-center gap-1.5">
						<Chip tone={lifecycleTone(s)}>{LIFECYCLE_LABEL[s.lifecycle] ?? s.lifecycle}</Chip>
						{attention && <Chip tone={attTone}>{attention.label}</Chip>}
						{trigger !== "always" && (
							<Chip icon={<Terminal size={12} />}>{AGENT_TRIGGER_LABEL[trigger]}</Chip>
						)}
						{s.runMode === "worktree" && (
							<Chip tone={hasWorktreePatch ? "accent" : "neutral"} icon={<FolderGit2 size={12} />}>
								{hasWorktreePatch ? "工作树待合并" : "工作树"}
							</Chip>
						)}
					</span>
					{meta && <span className="mt-1.5 block text-m-xs break-words text-m-text-3">{meta}</span>}
					<span className="mt-0.5 block text-m-xs break-all text-m-text-3">{s.cwd}</span>
				</button>
				<IconButton
					icon={<MoreHorizontal size={18} />}
					label={`更多操作 ${s.name}`}
					onClick={(e) => onOpenMenu(e.currentTarget)}
				/>
				<Switch
					checked={s.enabled}
					label={`启用 ${s.name}`}
					disabled={busy || s.lifecycle === "completed"}
					onChange={onToggle}
				/>
			</div>
		</div>
	);
}

export function SchedulesPage() {
	const schedules = useMobileSchedules((s) => s.schedules);
	const loaded = useMobileSchedules((s) => s.loaded);
	const loading = useMobileSchedules((s) => s.loading);
	const error = useMobileSchedules((s) => s.error);
	const awaitingById = useMobileSchedules((s) => s.awaitingById);
	const worktreeById = useMobileSchedules((s) => s.worktreeById);
	const seenRuns = useMobileSchedules((s) => s.seenRuns);

	const [busy, setBusy] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<FilterTab>("all");
	const [createSheetOpen, setCreateSheetOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsSnap, setSettingsSnap] = useState<Partial<AutomationSettingsSnapshot> | null>(null);
	const [bgBusy, setBgBusy] = useState(false);
	const [launchingAi, setLaunchingAi] = useState(false);

	const [menuState, setMenuState] = useState<{ id: string; anchorEl: HTMLElement | null } | null>(null);
	const lastAnchorRef = useRef<HTMLElement | null>(null);
	const menu = schedules.find((s) => s.id === menuState?.id) ?? null;
	if (menuState?.anchorEl) lastAnchorRef.current = menuState.anchorEl;

	// Rename dialog sheet state
	const [renameTarget, setRenameTarget] = useState<Schedule | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [renaming, setRenaming] = useState(false);

	const loadSettings = async () => {
		try {
			const res = await api<Partial<AutomationSettingsSnapshot>>("GET", "/left/settings");
			setSettingsSnap(res);
		} catch {
			/* ignore non-fatal settings summary error */
		}
	};

	const reload = async () => {
		await Promise.allSettled([useMobileSchedules.getState().loadSchedules(), loadSettings()]);
	};

	useEffect(() => {
		void reload();
	}, []);

	const sortedFiltered = useMemo(() => {
		const sorted = sortSchedulesForDashboard(schedules, { awaitingById, worktreeById, seenRuns });
		const q = query.trim().toLowerCase();
		return sorted.filter((s) => {
			if (filter === "active" && !(s.lifecycle === "active" && s.enabled)) return false;
			if (filter === "paused" && !(s.lifecycle === "paused" || (s.lifecycle === "active" && !s.enabled))) {
				return false;
			}
			if (filter === "completed" && s.lifecycle !== "completed") return false;
			if (q) {
				const hay = `${s.name} ${s.cwd} ${s.prompt} ${s.probeDescription ?? ""}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		});
	}, [schedules, awaitingById, worktreeById, seenRuns, query, filter]);

	const toggleBgDaemon = async (checked: boolean) => {
		if (bgBusy) return;
		setBgBusy(true);
		try {
			const updated = await api<AutomationSettingsSnapshot>("POST", "/left/settings/automation", {
				automationBackgroundEnabled: checked,
			});
			setSettingsSnap(updated);
			toast(checked ? "已开启后台常驻运行" : "已关闭后台常驻运行", { kind: "success" });
		} catch (e) {
			toast(`设置失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setBgBusy(false);
		}
	};

	const launchAiComposer = async () => {
		if (launchingAi) return;
		setLaunchingAi(true);
		setCreateSheetOpen(false);
		try {
			const res = await api<{ dirs: Array<{ path: string; mode?: Schedule["mode"] }> }>("GET", "/left/dirs");
			const first = res.dirs?.[0];
			const cwd = first?.path ?? ".";
			await startAutomationChat({
				cwd,
				mode: first?.mode ?? "code",
				prefill: "帮我定制一个自动化任务：",
			});
		} catch (e) {
			toast(`启动对话定制失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setLaunchingAi(false);
		}
	};

	const runAction = async (s: Schedule, action: () => Promise<unknown>, ok: string, fail: string) => {
		setBusy(s.id);
		try {
			await action();
			if (ok) toast(ok, { kind: "success" });
		} catch (e) {
			toast(`${fail}：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setBusy(null);
		}
	};

	const toggle = (s: Schedule) =>
		runAction(s, () => useMobileSchedules.getState().toggleSchedule(s), "", "操作失败");

	const runNow = async (s: Schedule) => {
		setMenuState(null);
		if (
			!(await confirm({
				title: "立即运行",
				message: `立即运行「${s.name}」一次？`,
				confirmText: "运行",
			}))
		) {
			return;
		}
		await runAction(s, () => useMobileSchedules.getState().runNow(s.id), "已触发运行", "运行失败");
	};

	const duplicate = async (s: Schedule) => {
		setMenuState(null);
		await runAction(s, () => useMobileSchedules.getState().duplicateSchedule(s), "已复制自动化", "复制失败");
	};

	const openRename = (s: Schedule) => {
		setMenuState(null);
		setRenameTarget(s);
		setRenameValue(s.name);
	};

	const submitRename = async () => {
		if (!renameTarget || !renameValue.trim() || renaming) return;
		setRenaming(true);
		try {
			await useMobileSchedules.getState().renameSchedule(renameTarget, renameValue.trim());
			toast("已重命名", { kind: "success" });
			setRenameTarget(null);
		} catch (e) {
			toast(`重命名失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setRenaming(false);
		}
	};

	const del = async (s: Schedule) => {
		setMenuState(null);
		if (
			!(await confirm({
				title: "删除自动化",
				message: `删除自动化「${s.name}」？此操作不可撤销。`,
				danger: true,
				confirmText: "删除",
			}))
		) {
			return;
		}
		await runAction(s, () => useMobileSchedules.getState().deleteSchedule(s.id), "已删除", "删除失败");
	};

	const go = (path: string) => {
		setMenuState(null);
		nav.push(path);
	};

	const bgEnabled = settingsSnap?.automationBackgroundEnabled ?? true;

	return (
		<div className="flex h-full min-h-0 flex-col bg-m-bg-elev text-m-text">
			<PageHeader
				title="自动化"
				className="bg-m-bg-elev!"
				right={
					<div className="flex items-center gap-1">
						<IconButton
							icon={<SlidersHorizontal size={19} strokeWidth={1.75} />}
							label="自动化设置"
							onClick={() => setSettingsOpen(true)}
						/>
						<IconButton
							variant="filled"
							icon={<Plus size={20} strokeWidth={1.75} />}
							label="新建自动化"
							onClick={() => setCreateSheetOpen(true)}
						/>
					</div>
				}
			/>

			<PullToRefresh onRefresh={reload}>
				{!loaded && schedules.length === 0 ? (
					<LoadState loading={loading} error={error} onRetry={reload} />
				) : schedules.length === 0 ? (
					<EmptyState
						className="min-h-[70dvh]"
						icon={<CalendarClock size={26} strokeWidth={1.75} />}
						title="还没有自动化"
						hint="用自然语言让 AI 帮你编写脚本与计划，或手动配置定时任务"
						action={
							<div className="flex flex-wrap justify-center gap-2">
								<Button
									variant="primary"
									busy={launchingAi}
									icon={<Sparkles size={16} />}
									onClick={() => void launchAiComposer()}
								>
									AI 对话定制
								</Button>
								<Button
									variant="tonal"
									icon={<Plus size={16} />}
									onClick={() => nav.push(paths.scheduleNew())}
								>
									手动配置
								</Button>
							</div>
						}
					/>
				) : (
					<div className="flex flex-col gap-3 px-4 pt-2" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 28px)" }}>
						{/* Background daemon bar */}
						<div className="flex items-center justify-between gap-3 rounded-2xl bg-m-surface px-4 py-2.5">
							<div className="min-w-0 flex-1">
								<div className="text-m-sm font-medium text-m-text">后台常驻运行</div>
								<div className="text-m-xs text-m-text-3">
									{bgEnabled ? "电脑关闭窗口后仍会按计划触发" : "仅应用打开期间触发"}
								</div>
							</div>
							<Switch
								label="后台常驻运行"
								checked={bgEnabled}
								disabled={bgBusy}
								onChange={(v) => void toggleBgDaemon(v)}
							/>
						</div>

						{/* Search & filter pills */}
						<div className="flex flex-col gap-2">
							<div className="relative">
								<Search
									size={16}
									className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-m-text-3"
								/>
								<input
									type="search"
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder="搜索自动化名称、目录或说明…"
									className={`${inputCls} pl-9 pr-9`}
								/>
								{query && (
									<button
										type="button"
										aria-label="清除搜索"
										onClick={() => setQuery("")}
										className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1 text-m-text-3 active:opacity-70"
									>
										<X size={15} />
									</button>
								)}
							</div>
							<div className="m-noscrollbar flex gap-1.5 overflow-x-auto py-0.5">
								{FILTER_TABS.map((tab) => {
									const active = filter === tab.id;
									return (
										<button
											key={tab.id}
											type="button"
											onClick={() => setFilter(tab.id)}
											className={`shrink-0 rounded-full px-3.5 py-1.5 text-m-xs font-medium whitespace-nowrap transition-colors duration-(--m-dur-fast) ${
												active
													? "bg-m-accent text-m-accent-fg"
													: "bg-m-surface text-m-text-2 active:bg-m-surface-hover"
											}`}
										>
											{tab.label}
										</button>
									);
								})}
							</div>
						</div>

						{error && (
							<p className="m-selectable px-1 text-m-sm break-words text-m-danger">刷新失败：{error}</p>
						)}

						{sortedFiltered.length === 0 ? (
							<EmptyState
								className="min-h-[36dvh]"
								icon={<Search size={22} />}
								title="没有匹配的自动化"
								hint="尝试清除筛选条件或搜索关键词"
								action={
									<Button
										variant="tonal"
										size="sm"
										onClick={() => {
											setQuery("");
											setFilter("all");
										}}
									>
										清除筛选
									</Button>
								}
							/>
						) : (
							<ListGroup className="!mx-0" note="轻点进入运维总览与配置，右上角可快速切换开关">
								{sortedFiltered.map((s) => {
									const wt = worktreeById[s.id] ?? null;
									const hasPatch = Boolean(wt && (wt.ahead > 0 || wt.dirty > 0));
									const att = deriveScheduleAttention(s, {
										awaitingCount: awaitingById[s.id]?.length ?? 0,
										worktree: wt,
										seenAt: seenRuns[s.id],
									});
									return (
										<ScheduleRow
											key={s.id}
											s={s}
											busy={busy === s.id}
											attention={att}
											hasWorktreePatch={hasPatch}
											onOpenDetail={() => nav.push(paths.schedule(s.id))}
											onOpenMenu={(el) => setMenuState({ id: s.id, anchorEl: el })}
											onToggle={() => void toggle(s)}
										/>
									);
								})}
							</ListGroup>
						)}
					</div>
				)}
			</PullToRefresh>

			{/* Row action menu */}
			<AnchoredPopover
				open={!!menu}
				onClose={() => setMenuState(null)}
				anchorEl={menuState?.anchorEl ?? lastAnchorRef.current}
				placement="bottom-end"
				title={menu?.name}
				subtitle={menu ? cadenceText(menu.cadence) : undefined}
				maxWidth={320}
				minWidth={220}
			>
				{menu && (
					<div className="py-1.5">
						<MenuRow icon={<History {...ICON} />} label="运维总览与记录" onClick={() => go(paths.schedule(menu.id))} />
						<MenuRow icon={<Pencil {...ICON} />} label="编辑配置" onClick={() => go(`${paths.schedule(menu.id)}?tab=config`)} />
						<MenuRow icon={<Play {...ICON} />} label="立即运行" hint="触发执行一次" disabled={busy === menu.id} onClick={() => void runNow(menu)} />
						<MenuRow icon={<Copy {...ICON} />} label="复制任务" disabled={busy === menu.id} onClick={() => void duplicate(menu)} />
						<MenuRow icon={<Edit3 {...ICON} />} label="重命名" disabled={busy === menu.id} onClick={() => openRename(menu)} />
						<MenuRow icon={<Trash2 {...ICON} />} label="删除" danger disabled={busy === menu.id} onClick={() => void del(menu)} />
					</div>
				)}
			</AnchoredPopover>

			{/* Create choice sheet */}
			<BottomSheet open={createSheetOpen} onClose={() => setCreateSheetOpen(false)} title="新建自动化">
				<div className="pb-4">
					<MenuRow
						icon={<Sparkles {...ICON} className="text-m-accent" />}
						label="AI 对话定制（推荐）"
						hint="描述需求，AI 自动检查仓库、编写检测脚本并出确认卡"
						onClick={() => void launchAiComposer()}
					/>
					<MenuRow
						icon={<Pencil {...ICON} />}
						label="手动配置"
						hint="直接填写名称、检测脚本、提示词与重复节奏"
						onClick={() => {
							setCreateSheetOpen(false);
							nav.push(paths.scheduleNew());
						}}
					/>
				</div>
			</BottomSheet>

			{/* Rename sheet */}
			<BottomSheet
				open={!!renameTarget}
				onClose={() => setRenameTarget(null)}
				title="重命名自动化"
				footer={
					<div className="flex gap-2">
						<Button block className="flex-1" onClick={() => setRenameTarget(null)}>
							取消
						</Button>
						<Button
							variant="primary"
							block
							className="flex-1"
							busy={renaming}
							disabled={!renameValue.trim()}
							onClick={() => void submitRename()}
						>
							保存
						</Button>
					</div>
				}
			>
				<div className="px-4 pb-4">
					<input
						className={inputCls}
						value={renameValue}
						placeholder="输入新的自动化名称"
						onChange={(e) => setRenameValue(e.target.value)}
					/>
				</div>
			</BottomSheet>

			{/* Global automation settings sheet */}
			<AutomationSettingsSheet
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				snapshot={settingsSnap}
				onUpdate={(next) => setSettingsSnap(next)}
			/>
		</div>
	);
}

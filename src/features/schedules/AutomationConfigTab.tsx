import clsx from "clsx";
import {
	AlertCircle,
	Check,
	ChevronDown,
	ChevronRight,
	FolderOpen,
	Info,
	Loader2,
	Minus,
	Play,
	Plus,
	ShieldCheck,
	Sparkles,
	Terminal,
} from "lucide-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useId,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ReactNode } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import { InfoTip } from "../../components/InfoTip";
import type {
	ProbeTestResult,
	Schedule,
	ScheduleDraft,
	ScheduleNotify,
} from "../../lib/contracts";
import { confirmDialog } from "../../lib/dialogs";
import { isComposing, useEscapeKey } from "../../lib/hooks";
import { gitRepoRoot, testScheduleProbe } from "../../lib/ipc";
import { basename, trimTrailingSlash } from "../../lib/paths";
import { useT } from "../../stores/language";
import { useSessions } from "../../stores/sessions";
import { PromptComposer } from "../chat/PromptComposer";
import { WorkspacePickerPopover } from "../chat/ContextPillBar";
import { useSidebarStore } from "../sessions/sidebarStore";
import { Switch } from "../settings/Switch";
import {
	fixAutomationProbeWithAi,
	openAutomationAiAssistChat,
} from "./automationAttention";
import {
	CADENCE_UNITS,
	MONTH_DAYS,
	WEEKDAY_CHIPS,
	buildDraft,
	defaultForm,
	formFromSchedule,
	formFromTemplate,
	localTimezoneLabel,
	presetOfForm,
	timeSlotOptions,
	toLocalDateValue,
	toLocalInputValue,
	validateForm,
} from "./scheduleUtils";
import type { CadencePreset, EditorForm } from "./scheduleUtils";

export interface AutomationConfigHandle {
	submit: () => Promise<void>;
	requestClose: () => Promise<void>;
}

export interface AutomationConfigTabProps {
	editingSchedule: Schedule | null;
	template?: Partial<ScheduleDraft> | null;
	onSave: (draft: ScheduleDraft) => Promise<Schedule | null>;
	onClose: () => void;
	onStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
}

type QuickPreset = CadencePreset | "30m";

type MenuId =
	| "unit"
	| "time"
	| "monthDay"
	| "endMode"
	| "workspace"
	| "approval"
	| "notify";

const INPUT_CLASS =
	"w-full h-9 px-3 rounded-xl bg-[var(--bg)] hairline-outset text-[var(--text)] placeholder:text-[var(--text-40)] text-xs focus:outline-none focus:ring-1 focus:ring-[var(--hairline-strong)] transition-shadow";

const TOOLBAR_CHIP_CLASS =
	"inline-flex select-none items-center gap-1 whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg)] px-2.5 py-1 text-[11px] text-[var(--text-60)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]";

const MENU_CLASS =
	"!rounded-2xl border-[var(--line,var(--border-divider))] !bg-[var(--bg-panel)] p-1.5";

const APPROVAL_OPTIONS = [
	{
		value: "always-ask",
		labelKey: "schedules.approvalAlwaysAsk",
		descKey: "schedules.approvalAlwaysAskDesc",
	},
	{
		value: "write",
		labelKey: "schedules.approvalWrite",
		descKey: "schedules.approvalWriteDesc",
	},
	{
		value: "yolo",
		labelKey: "schedules.approvalYolo",
		descKey: "schedules.approvalYoloDesc",
	},
] as const;

const NOTIFY_OPTIONS: {
	value: ScheduleNotify;
	labelKey: string;
	descKey: string;
}[] = [
	{
		value: "important",
		labelKey: "schedules.notifyImportant",
		descKey: "schedules.notifyImportantDesc",
	},
	{
		value: "all",
		labelKey: "schedules.notifyAll",
		descKey: "schedules.notifyAllDesc",
	},
	{
		value: "none",
		labelKey: "schedules.notifyNone",
		descKey: "schedules.notifyNoneDesc",
	},
];

function approvalLabel(value: string, t: (k: string) => string): string {
	const opt = APPROVAL_OPTIONS.find((o) => o.value === value);
	return opt ? t(opt.labelKey) : value || t("schedules.approvalFollowDefault");
}

function createInitialBlankForm(defaultCwd: string): EditorForm {
	const blank = defaultForm(defaultCwd);
	blank.hasSchedule = true;
	blank.repeat = "recur";
	blank.every = 30;
	blank.unit = "minute";
	blank.agentTrigger = "always";
	return blank;
}

export const AutomationConfigTab = forwardRef<
	AutomationConfigHandle,
	AutomationConfigTabProps
>(function AutomationConfigTab(
	{ editingSchedule, template, onSave, onClose, onStateChange },
	ref,
) {
	const { t, locale } = useT();
	const baseId = useId();
	const cwdErrId = `${baseId}-cwd-err`;
	const cadenceErrId = `${baseId}-cadence-err`;
	const probeErrId = `${baseId}-probe-err`;
	const promptErrId = `${baseId}-prompt-err`;

	const workspaces = useSessions((s) => s.workspaces);
	const activeMode = useSidebarStore((s) => s.activeMode);
	const targetMode = editingSchedule?.mode ?? template?.mode ?? activeMode;
	const modeWorkspaces = useMemo(
		() => workspaces.filter((w) => w.mode === targetMode),
		[workspaces, targetMode],
	);

	const [form, setForm] = useState<EditorForm>(() => createInitialBlankForm(""));
	const [initialSnapshot, setInitialSnapshot] = useState("");
	const [repoRoot, setRepoRoot] = useState<string | null>(null);
	const isGitRepo = repoRoot !== null;
	const [customOpen, setCustomOpen] = useState(false);
	const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
	const [submitAttempted, setSubmitAttempted] = useState(false);
	const [saving, setSaving] = useState(false);
	const [testingProbe, setTestingProbe] = useState(false);
	const [probeTestResult, setProbeTestResult] =
		useState<ProbeTestResult | null>(null);
	const [probeTestError, setProbeTestError] = useState<string | null>(null);

	const promptComposerId = `automation-config:${editingSchedule?.id ?? template?.id ?? baseId}`;
	const workspaceBtnRef = useRef<HTMLButtonElement>(null);
	const approvalBtnRef = useRef<HTMLButtonElement>(null);
	const unitBtnRef = useRef<HTMLButtonElement>(null);
	const timeBtnRef = useRef<HTMLButtonElement>(null);
	const monthDayBtnRef = useRef<HTMLButtonElement>(null);
	const endModeBtnRef = useRef<HTMLButtonElement>(null);
	const notifyBtnRef = useRef<HTMLButtonElement>(null);

	const toggleMenu = (id: MenuId) =>
		setOpenMenu((prev) => (prev === id ? null : id));

	const tzLabel = useMemo(() => localTimezoneLabel(), []);

	const set = <K extends keyof EditorForm>(key: K, value: EditorForm[K]) =>
		setForm((f) => ({ ...f, [key]: value }));

	useEffect(() => {
		const defaultCwd =
			modeWorkspaces.find((w) => w.kind === "project")?.path ??
			modeWorkspaces[0]?.path ??
			"";
		const next = editingSchedule
			? formFromSchedule(editingSchedule)
			: template
				? formFromTemplate(template, defaultCwd)
				: createInitialBlankForm(defaultCwd);
		if (!next.hasSchedule) {
			next.hasSchedule = true;
		}
		setForm(next);
		setInitialSnapshot(JSON.stringify(next));
		setCustomOpen(false);
		setOpenMenu(null);
		setSubmitAttempted(false);
		setProbeTestResult(null);
		setProbeTestError(null);
	}, [editingSchedule, template, modeWorkspaces]);

	useEffect(() => {
		const cwd = form.cwd.trim();
		if (!cwd) {
			setRepoRoot(null);
			return;
		}
		let active = true;
		gitRepoRoot(cwd)
			.then((root) => {
				if (active) {
					setRepoRoot(root ?? null);
					if (!root) {
						setForm((f) =>
							f.runMode === "worktree" ? { ...f, runMode: "local" } : f,
						);
					}
				}
			})
			.catch(() => {
				if (active) setRepoRoot(null);
			});
		return () => {
			active = false;
		};
	}, [form.cwd]);

	const isDirty = JSON.stringify(form) !== initialSnapshot;

	useEffect(() => {
		onStateChange?.({ dirty: isDirty, saving });
	}, [isDirty, saving, onStateChange]);

	const onceAtUnchanged =
		editingSchedule?.cadence.kind === "once" &&
		form.onceAt !== "" &&
		form.onceAt ===
			toLocalInputValue(
				editingSchedule.cadence.kind === "once"
					? editingSchedule.cadence.at
					: null,
			);

	const { cadence, endAt, maxRuns, errors } = useMemo(
		() => validateForm(form, { onceAtUnchanged }),
		[form, onceAtUnchanged],
	);

	const onceRescheduled = cadence?.kind === "once" && !onceAtUnchanged;

	const confirmingRef = useRef(false);
	const requestClose = useCallback(async () => {
		if (!isDirty) {
			onClose();
			return;
		}
		if (confirmingRef.current) return;
		confirmingRef.current = true;
		try {
			const discard = await confirmDialog(t("schedules.discardMsg"), {
				title: t("schedules.discardTitle"),
				okLabel: t("schedules.discardOk"),
				cancelLabel: t("schedules.discardCancel"),
				danger: true,
			});
			if (discard) onClose();
		} finally {
			confirmingRef.current = false;
		}
	}, [isDirty, onClose, t]);

	useEscapeKey(() => void requestClose(), openMenu === null);

	const handleSubmit = useCallback(async () => {
		setSubmitAttempted(true);
		if (
			!cadence ||
			errors.prompt ||
			errors.probe ||
			errors.cwd ||
			errors.endAt ||
			errors.maxRuns
		) {
			if (errors.cwd && form.agentTrigger === "never") setOpenMenu("workspace");
			return;
		}
		setSaving(true);
		try {
			const draft = buildDraft(
				form,
				cadence,
				endAt,
				maxRuns,
				editingSchedule?.id ?? template?.id ?? undefined,
				editingSchedule ? editingSchedule.enabled || onceRescheduled : true,
			);
			draft.mode = editingSchedule?.mode ?? template?.mode ?? activeMode;
			await onSave(draft);
		} finally {
			setSaving(false);
		}
	}, [
		cadence,
		endAt,
		maxRuns,
		form,
		editingSchedule,
		template,
		activeMode,
		onSave,
		errors,
		onceRescheduled,
	]);

	useImperativeHandle(
		ref,
		() => ({
			submit: handleSubmit,
			requestClose,
		}),
		[handleSubmit, requestClose],
	);

	const handleTestProbe = async () => {
		if (!form.cwd.trim()) {
			setSubmitAttempted(true);
			setOpenMenu("workspace");
			return;
		}
		if (!form.probeCommand.trim()) {
			setSubmitAttempted(true);
			return;
		}
		setTestingProbe(true);
		setProbeTestError(null);
		try {
			const res = await testScheduleProbe({
				cwd: form.cwd.trim(),
				probeCommand: form.probeCommand.trim(),
				agentTrigger: form.agentTrigger,
				scheduleId: editingSchedule?.id ?? template?.id ?? null,
			});
			setProbeTestResult(res);
		} catch (e) {
			setProbeTestResult(null);
			setProbeTestError(e instanceof Error ? e.message : String(e));
		} finally {
			setTestingProbe(false);
		}
	};

	const openChatWithContext = (focus: "script" | "prompt") => {
		const isDirectAgent = form.agentTrigger === "always";
		openAutomationAiAssistChat({
			id: editingSchedule?.id ?? template?.id ?? undefined,
			name: form.name.trim() || undefined,
			cwd: form.cwd.trim() || ".",
			mode: targetMode,
			cadence: cadence ?? undefined,
			agentTrigger: form.agentTrigger,
			probeDescription: isDirectAgent ? null : form.probeDescription.trim() || null,
			probeCommand: isDirectAgent ? null : form.probeCommand.trim() || null,
			prompt: form.prompt.trim() || undefined,
			notify: form.notify,
			runMode: form.agentTrigger === "never" ? "local" : form.runMode,
			focus,
		});
	};

	const promptErr = submitAttempted ? errors.prompt : undefined;
	const probeErr = submitAttempted ? errors.probe : undefined;
	const cwdErr = submitAttempted ? errors.cwd : undefined;
	const cadenceErr =
		submitAttempted ||
		(form.hasSchedule &&
			((form.repeat === "once" && form.onceAt !== "") ||
				(form.repeat === "recur" &&
					form.unit === "week" &&
					form.weekdays.length === 0)))
			? errors.cadence
			: undefined;
	const endErr =
		submitAttempted ||
		(form.repeat === "recur" && form.endMode === "date" && form.endDate !== "")
			? errors.endAt
			: undefined;
	const runsErr =
		submitAttempted ||
		(form.repeat === "recur" && form.endMode === "count" && form.endRuns < 1)
			? errors.maxRuns
			: undefined;

	const cwdKey = trimTrailingSlash(form.cwd);
	const selectedWorkspace =
		modeWorkspaces.find((w) => trimTrailingSlash(w.path) === cwdKey) ??
		(repoRoot
			? (modeWorkspaces.find(
					(w) => trimTrailingSlash(w.path) === trimTrailingSlash(repoRoot),
				) ?? null)
			: null);
	const workspaceLabel = selectedWorkspace
		? selectedWorkspace.name
		: form.cwd
			? basename(form.cwd)
			: t("schedules.selectDir");

	const is30MinPreset =
		form.repeat === "recur" && form.unit === "minute" && form.every === 30;
	const rawPreset = presetOfForm(form);
	const activeQuickPreset: QuickPreset = is30MinPreset
		? "30m"
		: customOpen
			? "custom"
			: rawPreset;
	const showCustomInterval =
		form.repeat === "recur" &&
		(customOpen || (!is30MinPreset && rawPreset === "custom"));

	const applyQuickPreset = (preset: QuickPreset) => {
		setOpenMenu(null);
		setCustomOpen(preset === "custom");
		switch (preset) {
			case "30m":
				setForm((f) => ({
					...f,
					hasSchedule: true,
					repeat: "recur",
					every: 30,
					unit: "minute",
				}));
				break;
			case "hourly":
				setForm((f) => ({
					...f,
					hasSchedule: true,
					repeat: "recur",
					every: 1,
					unit: "hour",
				}));
				break;
			case "daily":
				setForm((f) => ({
					...f,
					hasSchedule: true,
					repeat: "recur",
					every: 1,
					unit: "day",
				}));
				break;
			case "weekdays":
				setForm((f) => ({
					...f,
					hasSchedule: true,
					repeat: "recur",
					every: 1,
					unit: "week",
					weekdays: [1, 2, 3, 4, 5],
				}));
				break;
			case "weekly":
				setForm((f) => ({
					...f,
					hasSchedule: true,
					repeat: "recur",
					every: 1,
					unit: "week",
					weekdays:
						f.weekdays.length > 0 &&
						f.weekdays.length < 7 &&
						!(
							f.weekdays.length === 5 &&
							[1, 2, 3, 4, 5].every((d) => f.weekdays.includes(d))
						)
							? f.weekdays
							: [1],
				}));
				break;
			case "monthly":
				setForm((f) => ({
					...f,
					hasSchedule: true,
					repeat: "recur",
					every: 1,
					unit: "month",
				}));
				break;
			case "once":
				setForm((f) => ({ ...f, hasSchedule: true, repeat: "once" }));
				break;
			case "custom":
				setForm((f) => ({ ...f, hasSchedule: true, repeat: "recur" }));
				break;
		}
	};

	const quickPresets: { id: QuickPreset; label: string }[] = [
		{ id: "30m", label: t("schedules.preset30Min") },
		{ id: "hourly", label: t("schedules.presetHourly") },
		{ id: "daily", label: t("schedules.presetDaily") },
		{ id: "weekdays", label: t("schedules.presetWeekdays") },
		{ id: "weekly", label: t("schedules.presetWeekly") },
		{ id: "monthly", label: t("schedules.presetMonthly") },
		{ id: "once", label: t("schedules.presetOnce") },
		{ id: "custom", label: t("schedules.presetCustom") },
	];

	const showProbeSection = form.agentTrigger !== "always";

	return (
		<div
			className="space-y-4 pb-8"
			onKeyDown={(e) => {
				if (
					(e.metaKey || e.ctrlKey) &&
					e.key === "Enter" &&
					!isComposing(e)
				) {
					e.preventDefault();
					void handleSubmit();
				}
			}}
		>
			{/* Section 1: Cadence (& Project Folder when agent Composer is hidden in pure-script mode) */}
			<section className="divide-y divide-[var(--border-divider)] rounded-xl border border-[var(--border-divider)] bg-[var(--bg-panel)]">
				{form.agentTrigger === "never" && (
				<div className="px-4 py-3">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="min-w-0 flex-1">
							<div className="text-[12.5px] font-medium text-[var(--text)]">
								{t("schedules.configFolderQuestion")}
							</div>
							{form.cwd && (
								<p className="mt-0.5 select-text break-all font-mono text-[11px] text-[var(--text-40)]">
									{form.cwd}
								</p>
							)}
						</div>

						<button
							ref={workspaceBtnRef}
							type="button"
							aria-invalid={cwdErr ? "true" : "false"}
							aria-describedby={cwdErr ? cwdErrId : undefined}
							onClick={() => toggleMenu("workspace")}
							className={clsx(
								"inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
								cwdErr
									? "border-rose-500/50 bg-rose-500/10 text-rose-300"
									: "border-[var(--border-divider)] bg-[var(--bg)] text-[var(--text)] hover:bg-[var(--bg-hover)]",
							)}
						>
							<FolderOpen size={12} className="shrink-0 text-[var(--text-40)]" />
							<span>{workspaceLabel}</span>
							<ChevronDown size={11} className="shrink-0 text-[var(--text-40)]" />
						</button>

						{openMenu === "workspace" && (
							<WorkspacePickerPopover
								anchor={workspaceBtnRef.current}
								ignoreRefs={[workspaceBtnRef]}
								activeWorkspaceId={selectedWorkspace?.id ?? null}
								mode={targetMode}
								placement="bottom-end"
								onSelectPath={(path) => set("cwd", path)}
								onClose={() => setOpenMenu(null)}
							/>
						)}
					</div>
					{cwdErr && <ErrorLine id={cwdErrId} message={cwdErr} />}
				</div>
				)}

				<div className="space-y-2.5 px-4 py-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span className="text-[12.5px] font-medium text-[var(--text)]">
							{t("schedules.configCadenceQuestion")}
						</span>
						<div className="flex flex-wrap items-center justify-end gap-1">
							{quickPresets.map((p) => {
								const active = form.hasSchedule && activeQuickPreset === p.id;
								return (
									<button
										key={p.id}
										type="button"
										onClick={() => applyQuickPreset(p.id)}
										className={clsx(
											"inline-flex items-center whitespace-nowrap rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-colors",
											active
												? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]"
												: "border-[var(--border-divider)] bg-[var(--bg)] text-[var(--text-60)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
										)}
									>
										{p.label}
									</button>
								);
							})}
						</div>
					</div>

					{form.hasSchedule && showCustomInterval && (
						<div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs">
							<span className="text-[var(--text-60)]">
								{t("schedules.everyPrefix")}
							</span>
							<NumberStepper
								value={form.every}
								min={1}
								onChange={(v) => set("every", v)}
								ariaLabel={t("schedules.repeatInterval")}
							/>
							<button
								ref={unitBtnRef}
								type="button"
								onClick={() => toggleMenu("unit")}
								className={TOOLBAR_CHIP_CLASS}
							>
								<span>
									{CADENCE_UNITS.find((u) => u.value === form.unit)?.labelKey
										? t(
												CADENCE_UNITS.find((u) => u.value === form.unit)!
													.labelKey,
											)
										: ""}
								</span>
								<ChevronDown size={10} className="shrink-0" />
							</button>
							{openMenu === "unit" && (
								<FloatingLayer
									anchor={unitBtnRef.current}
									placement="bottom-start"
									offset={6}
									layer="popover"
									ignoreRefs={[unitBtnRef]}
									onDismiss={() => setOpenMenu(null)}
									className={clsx("w-32", MENU_CLASS)}
								>
									{CADENCE_UNITS.map((u) => (
										<MenuItem
											key={u.value}
											selected={form.unit === u.value}
											onClick={() => {
												setOpenMenu(null);
												setForm((f) => ({
													...f,
													unit: u.value,
													every: Math.max(1, f.every),
												}));
											}}
										>
											{t(u.labelKey)}
										</MenuItem>
									))}
								</FloatingLayer>
							)}
						</div>
					)}
					{form.hasSchedule && form.repeat === "recur" && form.unit === "minute" && form.every >= 1 && form.every < 5 && (
						<div className="space-y-1 text-[11px] text-amber-700 dark:text-amber-300">
							{form.agentTrigger !== "always" && (
								<p>{t("schedules.highFrequencyScriptWarning")}</p>
							)}
							<p>{t("schedules.highFrequencyAgentWarning")}</p>
						</div>
					)}

					{form.hasSchedule &&
						form.repeat === "recur" &&
						(form.unit === "day" ||
							form.unit === "week" ||
							form.unit === "month") && (
							<div className="flex flex-wrap items-center gap-3 pt-0.5 text-xs">
								<div className="flex items-center gap-2">
									<span className="text-[var(--text-60)]">
										{t("schedules.fieldTime")}
									</span>
									<button
										ref={timeBtnRef}
										type="button"
										onClick={() => toggleMenu("time")}
										className={TOOLBAR_CHIP_CLASS}
									>
										<span>{form.time}</span>
										<ChevronDown size={10} className="shrink-0" />
									</button>
									{openMenu === "time" && (
										<FloatingLayer
											anchor={timeBtnRef.current}
											placement="bottom-start"
											offset={6}
											layer="popover"
											ignoreRefs={[timeBtnRef]}
											onDismiss={() => setOpenMenu(null)}
											className={clsx("max-h-60 w-36 overflow-y-auto", MENU_CLASS)}
										>
											{timeSlotOptions(form.time).map((slot) => (
												<MenuItem
													key={slot}
													selected={form.time === slot}
													onClick={() => {
														setOpenMenu(null);
														set("time", slot);
													}}
												>
													{slot}
												</MenuItem>
											))}
										</FloatingLayer>
									)}
									<span className="text-[11px] text-[var(--text-40)]">
										{tzLabel}
									</span>
								</div>

								{form.unit === "week" && (
									<div className="flex items-center gap-1">
										{WEEKDAY_CHIPS.map((w) => {
											const on = form.weekdays.includes(w.id);
											return (
												<button
													key={w.id}
													type="button"
													onClick={() =>
														set(
															"weekdays",
															on
																? form.weekdays.filter((d) => d !== w.id)
																: [...form.weekdays, w.id].sort((a, b) => a - b),
														)
													}
													className={clsx(
														"h-6 w-6 rounded-full border text-[11px] transition-colors",
														on
															? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]"
															: "border-[var(--border-divider)] bg-[var(--bg)] text-[var(--text-40)] hover:text-[var(--text)]",
													)}
												>
													{locale === "en-US" ? w.labelEn : w.label}
												</button>
											);
										})}
									</div>
								)}

								{form.unit === "month" && (
									<div className="flex items-center gap-2">
										<button
											ref={monthDayBtnRef}
											type="button"
											onClick={() => toggleMenu("monthDay")}
											className={TOOLBAR_CHIP_CLASS}
										>
											<span>
												{t("schedules.dayUnit", { day: form.monthDay })}
											</span>
											<ChevronDown size={10} className="shrink-0" />
										</button>
										{openMenu === "monthDay" && (
											<FloatingLayer
												anchor={monthDayBtnRef.current}
												placement="bottom-start"
												offset={6}
												layer="popover"
												ignoreRefs={[monthDayBtnRef]}
												onDismiss={() => setOpenMenu(null)}
												className={clsx("max-h-60 w-32 overflow-y-auto", MENU_CLASS)}
											>
												{MONTH_DAYS.map((d) => (
													<MenuItem
														key={d}
														selected={form.monthDay === d}
														onClick={() => {
															setOpenMenu(null);
															set("monthDay", d);
														}}
													>
														{t("schedules.dayUnit", { day: d })}
													</MenuItem>
												))}
											</FloatingLayer>
										)}
									</div>
								)}
							</div>
						)}

					{form.hasSchedule && form.repeat === "once" && (
						<div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs">
							<span className="text-[var(--text-60)]">
								{t("schedules.fieldRunTime")}
							</span>
							<input
								type="datetime-local"
								value={form.onceAt}
								aria-invalid={cadenceErr ? "true" : "false"}
								aria-describedby={cadenceErr ? cadenceErrId : undefined}
								onChange={(e) => set("onceAt", e.target.value)}
								className="h-7 rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-2.5 text-xs text-[var(--text)] focus:border-[var(--hairline-strong)] focus:outline-none"
							/>
							<span className="text-[11px] text-[var(--text-40)]">
								{tzLabel}
							</span>
						</div>
					)}

					{cadenceErr && <ErrorLine id={cadenceErrId} message={cadenceErr} />}
				</div>
			</section>

			{/* Section 2: Zero-Jargon Working Mode Selector */}
			<section className="@container space-y-2.5 rounded-xl border border-[var(--border-divider)] bg-[var(--bg-panel)] p-3.5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="text-[12.5px] font-medium text-[var(--text)]">
						{t("schedules.configTriggerSectionTitle")}
					</span>
					<span className="text-[11px] text-[var(--text-40)]">
						{t("schedules.configTriggerRecommendedHint")}
					</span>
				</div>

				<div
					role="radiogroup"
					aria-label={t("schedules.configTriggerSectionTitle")}
					className="grid grid-cols-1 gap-2 @[520px]:grid-cols-3"
				>
					{(
						[
							{
								value: "always" as const,
								title: t("schedules.configTriggerAlwaysTitle"),
								desc: t("schedules.configTriggerAlwaysDesc"),
								badge: null,
							},
							{
								value: "on_signal" as const,
								title: t("schedules.configTriggerSignalTitle"),
								desc: t("schedules.configTriggerSignalDesc"),
								badge: t("schedules.configTriggerSignalBadge"),
							},
							{
								value: "never" as const,
								title: t("schedules.configTriggerNeverTitle"),
								desc: t("schedules.configTriggerNeverDesc"),
								badge: null,
							},
						]
					).map((card) => {
						const active = form.agentTrigger === card.value;
						return (
							<button
								key={card.value}
								type="button"
								role="radio"
								aria-checked={active}
								onClick={() => {
									setForm((f) => ({
										...f,
										agentTrigger: card.value,
										...(card.value === "never" ? { runMode: "local" as const } : {}),
									}));
									setProbeTestResult(null);
									setProbeTestError(null);
								}}
								className={clsx(
									"flex flex-col items-start rounded-lg border p-2.5 text-left transition-colors",
									active
										? "border-emerald-500/45 bg-emerald-500/10"
										: "border-[var(--border-divider)] bg-[var(--bg)] hover:border-[var(--hairline-strong)]",
								)}
							>
								<div className="flex w-full items-start justify-between gap-1.5">
									<span className="text-xs font-semibold leading-snug text-[var(--text)]">
										{card.title}
									</span>
									{card.badge && (
										<span className="shrink-0 whitespace-nowrap rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
											{card.badge}
										</span>
									)}
								</div>
								<p className="mt-1 text-[11px] leading-snug text-[var(--text-60)]">
									{card.desc}
								</p>
							</button>
						);
					})}
				</div>
			</section>

			{/* Section 3 (Step 1): Free Local Script (Composer ear-tab + optical card) */}
			{showProbeSection && (
				<div>
					<div className="relative z-0 flex flex-wrap items-center justify-between gap-2 px-[22px]">
						<div className="inline-flex max-w-full items-center gap-2 rounded-t-[14px] border border-b-0 border-[var(--composer-border,var(--border))] bg-[var(--bg-ear)] px-3 pt-1.5 pb-2.5 -mb-2">
							<span className="inline-flex shrink-0 whitespace-nowrap rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300">
								{t("schedules.configStep1Badge")}
							</span>
							<span className="text-[12px] font-medium text-[var(--text)]">
								{t("schedules.configStep1Title")}
							</span>
							{form.agentTrigger === "on_signal" && form.cwd && (
								<span
									title={form.cwd}
									className="max-w-40 truncate font-mono text-[11px] text-[var(--text-40)]"
								>
									· {workspaceLabel}
								</span>
							)}
							<InfoTip text={t("schedules.probeRuleTooltip")} />
						</div>

						<div className="mb-1 flex flex-wrap items-center gap-1.5">
							<button
								type="button"
								onClick={() => openChatWithContext("script")}
								className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-60)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
							>
								{t("schedules.configAiWriteScript")}
							</button>

							{probeTestResult?.outcome === "error" && (
								<button
									type="button"
									onClick={() =>
										void fixAutomationProbeWithAi(
											{
												id: editingSchedule?.id ?? template?.id ?? undefined,
												name:
													form.name.trim() ||
													form.probeDescription.trim() ||
													t("schedules.placeholderTitle"),
												cwd: form.cwd.trim() || ".",
												mode: targetMode,
												probeCommand: form.probeCommand,
												probeDescription: form.probeDescription,
											},
											probeTestResult.output,
										)
									}
									className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-rose-500/35 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-300 transition-colors hover:bg-rose-500/20"
								>
									<Sparkles size={11} className="shrink-0" />
									<span>{t("schedules.fixWithAi")}</span>
								</button>
							)}

							<button
								type="button"
								disabled={testingProbe || !form.probeCommand.trim()}
								onClick={() => void handleTestProbe()}
								className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
							>
								{testingProbe ? (
									<Loader2 size={11} className="shrink-0 animate-spin" />
								) : (
									<Play size={10} className="shrink-0" />
								)}
								<span>
									{testingProbe
										? t("schedules.testingProbeBtn")
										: t("schedules.testProbeBtn")}
								</span>
							</button>
						</div>
					</div>

					<section
						className={clsx(
							"composer-optical-card relative z-10 rounded-[22px] border transition-colors duration-150",
							probeErr
								? "border-rose-500/50"
								: "border-[var(--composer-border,var(--border))]",
						)}
					>
						<textarea
							rows={2}
							aria-label={t("schedules.probeCommandLabel")}
							aria-invalid={probeErr ? "true" : "false"}
							aria-describedby={probeErr ? probeErrId : undefined}
							placeholder={t("schedules.probeCommandPlaceholder")}
							value={form.probeCommand}
							onChange={(e) => {
								const nextCommand = e.target.value;
								setForm((f) => ({
									...f,
									probeCommand: nextCommand,
									...(nextCommand.trim() ? {} : { probeDescription: "" }),
								}));
								setProbeTestResult(null);
								setProbeTestError(null);
							}}
							className="min-h-[68px] w-full resize-y bg-transparent px-4 pt-3.5 pb-2 font-mono text-[12px] leading-relaxed text-[var(--text)] placeholder:text-[var(--text-40,var(--text-dim))] focus:outline-none"
						/>

						{(probeTestResult || probeTestError) && (
							<div className="mx-3.5 mb-2 rounded-xl border border-[var(--border-divider)] bg-[var(--bg)]/75 p-2.5 text-xs">
								{probeTestError ? (
									<p className="select-text whitespace-pre-wrap break-words text-rose-400">
										{probeTestError}
									</p>
								) : (
									probeTestResult && (
										<div className="space-y-1.5">
											<div className="flex flex-wrap items-center gap-2">
												<span
													className={clsx(
														"inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold",
														probeTestResult.outcome === "error"
															? "border-rose-500/35 bg-rose-500/15 text-rose-400"
															: probeTestResult.outcome === "signal"
																? "border-amber-500/35 bg-amber-500/15 text-amber-400"
																: "border-emerald-500/35 bg-emerald-500/15 text-emerald-400",
													)}
												>
													{probeTestResult.outcome === "quiet"
														? t("schedules.probeOutcomeQuiet")
														: probeTestResult.outcome === "signal"
															? t("schedules.probeOutcomeSignal")
															: probeTestResult.outcome === "ok"
																? t("schedules.probeOutcomeOk")
																: t("schedules.probeOutcomeError")}
												</span>
												<span className="text-[11px] text-[var(--text-40)]">
													{probeTestResult.durationMs}ms
												</span>
											</div>
											{probeTestResult.output.trim() && (
												<pre className="max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--text-60)]">
													{probeTestResult.output}
												</pre>
											)}
											{probeTestResult.outcome !== "ok" && (
												<p className="text-[11px] leading-snug text-[var(--text-60)]">
													{probeTestResult.outcome === "quiet"
														? t("schedules.probeOutcomeQuietHint")
														: probeTestResult.outcome === "signal"
															? t("schedules.probeOutcomeSignalHint")
															: t("schedules.probeOutcomeErrorHint")}
												</p>
											)}
										</div>
									)
								)}
							</div>
						)}

						<div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-divider)]/60 px-4 py-2 text-[11px] text-[var(--text-40)]">
							<span className="inline-flex items-center gap-1.5">
								<Terminal size={11} className="shrink-0" />
								<span>{t("schedules.configCursorHint")}</span>
								<InfoTip text={t("schedules.configCursorTooltip")} />
							</span>
						</div>

						{probeErr && (
							<div className="px-4 pb-3">
								<ErrorLine id={probeErrId} message={probeErr} />
							</div>
						)}
					</section>
				</div>
			)}

			{/* Causal Connector */}
			{form.agentTrigger === "on_signal" && (
				<div className="flex items-center justify-center text-[11.5px] font-medium text-emerald-700 dark:text-emerald-300/90">
					<span>{t("schedules.configCausalConnector")}</span>
				</div>
			)}

			{/* Section 4 (Step 2): Wake Agent (shared PromptComposer building block) */}
			{form.agentTrigger !== "never" && (
				<div className="space-y-1.5">
					<PromptComposer
						id={promptComposerId}
						placeholder={t("schedules.promptPlaceholder")}
						cwd={form.cwd}
						repoRoot={repoRoot}
						onChangeCwd={(cwd) => set("cwd", cwd)}
						workspaceMode={targetMode}
						runMode={form.runMode}
						isGitRepo={isGitRepo}
						onChangeRunMode={(mode) =>
							setForm((f) => ({
								...f,
								runMode: mode,
								...(mode === "worktree" ? { newChatEachRun: true } : {}),
							}))
						}
						hasPromptError={Boolean(promptErr)}
						hasCwdError={Boolean(cwdErr)}
						modelValue={form.modelSel}
						onChangeModel={(val) => set("modelSel", val)}
						promptValue={form.prompt}
						onChangePrompt={(prompt) => set("prompt", prompt)}
						earRightAction={
							<div className="mb-1 flex flex-wrap items-center gap-1.5">
								{form.agentTrigger === "on_signal" && (
									<span className="inline-flex shrink-0 whitespace-nowrap rounded bg-sky-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-sky-700 dark:text-sky-300">
										{t("schedules.configStep2BadgeOnSignal")}
									</span>
								)}
								<button
									type="button"
									onClick={() => openChatWithContext("prompt")}
									className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-60)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
								>
									{t("schedules.configStep2AiJump")}
								</button>
							</div>
						}
						trailingControls={
							<div className="relative flex items-center">
								<button
									ref={approvalBtnRef}
									type="button"
									title={t("schedules.configApprovalTooltip")}
									onClick={() => toggleMenu("approval")}
									className={clsx(
										"inline-flex shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-[var(--ghost-hover,var(--bg-hover))]",
										form.approvalMode === "yolo"
											? "text-amber-500 hover:text-amber-400"
											: "text-[var(--text-60,var(--text-muted))] hover:text-[var(--text)]",
									)}
								>
									<ShieldCheck
										size={12.5}
										className={clsx(
											"shrink-0",
											form.approvalMode === "yolo"
												? "text-amber-500"
												: "text-[var(--text-40,var(--text-dim))]",
										)}
									/>
									<span>{approvalLabel(form.approvalMode, t)}</span>
									<ChevronDown
										size={10}
										className="shrink-0 text-[var(--text-30,var(--text-dim))]"
									/>
								</button>

								{openMenu === "approval" && (
									<FloatingLayer
										anchor={approvalBtnRef.current}
										placement="top-end"
										offset={6}
										layer="popover"
										ignoreRefs={[approvalBtnRef]}
										onDismiss={() => setOpenMenu(null)}
										className={clsx("w-[280px]", MENU_CLASS)}
									>
										<MenuHeader>{t("schedules.approvalModeHeader")}</MenuHeader>
										{APPROVAL_OPTIONS.map((o) => (
											<MenuItem
												key={o.value}
												selected={form.approvalMode === o.value}
												label={t(o.labelKey)}
												desc={t(o.descKey)}
												onClick={() => {
													setOpenMenu(null);
													set("approvalMode", o.value);
												}}
											/>
										))}
									</FloatingLayer>
								)}
							</div>
						}
					/>
					{(cwdErr || promptErr) && (
						<div className="space-y-1 px-1">
							{cwdErr && <ErrorLine id={cwdErrId} message={cwdErr} />}
							{promptErr && <ErrorLine id={promptErrId} message={promptErr} />}
						</div>
					)}
				</div>
			)}

			{/* Advanced options */}
			<details
				open={Boolean(endErr || runsErr)}
				className="group rounded-xl border border-[var(--border-divider)] bg-[var(--bg-panel)]"
			>
				<summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-xs font-medium text-[var(--text-60)] hover:text-[var(--text)]">
					<span>{t("schedules.advancedOptions")}</span>
					<ChevronRight
						size={14}
						className="shrink-0 text-[var(--text-40)] transition-transform group-open:rotate-90"
					/>
				</summary>

				<div className="divide-y divide-[var(--border-divider)] border-t border-[var(--border-divider)]">
					<div className="space-y-1.5 px-4 py-3">
						<div className="text-xs font-medium text-[var(--text)]">
							{t("schedules.fieldTitle")}
						</div>
						<input
							type="text"
							placeholder={t("schedules.placeholderTitle")}
							value={form.name}
							onChange={(e) => set("name", e.target.value)}
							className={INPUT_CLASS}
						/>
						<p className="text-[11px] text-[var(--text-40)]">
							{t("schedules.titleHint")}
						</p>
					</div>

					<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
						<div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
							<span>{t("schedules.notifyLabel")}</span>
							<InfoTip text={t("schedules.notifyHint")} />
						</div>
						<button
							ref={notifyBtnRef}
							type="button"
							onClick={() => toggleMenu("notify")}
							className={TOOLBAR_CHIP_CLASS}
						>
							<span>
								{NOTIFY_OPTIONS.find((o) => o.value === form.notify)?.labelKey
									? t(
											NOTIFY_OPTIONS.find((o) => o.value === form.notify)!
												.labelKey,
										)
									: form.notify}
							</span>
							<ChevronDown size={10} className="shrink-0" />
						</button>
						{openMenu === "notify" && (
							<FloatingLayer
								anchor={notifyBtnRef.current}
								placement="top-end"
								offset={6}
								layer="popover"
								ignoreRefs={[notifyBtnRef]}
								onDismiss={() => setOpenMenu(null)}
								className={clsx("w-60", MENU_CLASS)}
							>
								<MenuHeader>{t("schedules.notifyLabel")}</MenuHeader>
								{NOTIFY_OPTIONS.map((o) => (
									<MenuItem
										key={o.value}
										selected={form.notify === o.value}
										label={t(o.labelKey)}
										desc={t(o.descKey)}
										onClick={() => {
											setOpenMenu(null);
											set("notify", o.value);
										}}
									/>
								))}
							</FloatingLayer>
						)}
					</div>

					{form.repeat === "recur" && (
						<div className="space-y-1.5 px-4 py-3">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<span className="text-xs font-medium text-[var(--text)]">
									{t("schedules.fieldEndRepeat")}
								</span>
								<div className="flex flex-wrap items-center gap-2">
									{form.endMode === "date" && (
										<input
											type="date"
											value={form.endDate}
											min={toLocalDateValue(new Date().toISOString())}
											onChange={(e) => set("endDate", e.target.value)}
											className="h-7 rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-2.5 text-xs text-[var(--text)] focus:outline-none"
										/>
									)}
									{form.endMode === "count" && (
										<NumberStepper
											value={form.endRuns}
											min={1}
											onChange={(v) => set("endRuns", v)}
											ariaLabel={t("schedules.repeatCount")}
										/>
									)}
									<button
										ref={endModeBtnRef}
										type="button"
										onClick={() => toggleMenu("endMode")}
										className={TOOLBAR_CHIP_CLASS}
									>
										<span>
											{form.endMode === "date"
												? form.endDate || t("schedules.endDate")
												: form.endMode === "count"
													? t("schedules.endCountLabel", {
															count: Math.max(1, Math.floor(form.endRuns)),
														})
													: t("schedules.endNever")}
										</span>
										<ChevronDown size={10} className="shrink-0" />
									</button>
									{openMenu === "endMode" && (
										<FloatingLayer
											anchor={endModeBtnRef.current}
											placement="top-end"
											offset={6}
											layer="popover"
											ignoreRefs={[endModeBtnRef]}
											onDismiss={() => setOpenMenu(null)}
											className={clsx("w-40", MENU_CLASS)}
										>
											<MenuItem
												selected={form.endMode === "never"}
												onClick={() => {
													setOpenMenu(null);
													set("endMode", "never");
												}}
											>
												{t("schedules.endNever")}
											</MenuItem>
											<MenuItem
												selected={form.endMode === "date"}
												onClick={() => {
													setOpenMenu(null);
													set("endMode", "date");
												}}
											>
												{t("schedules.endDate")}
											</MenuItem>
											<MenuItem
												selected={form.endMode === "count"}
												onClick={() => {
													setOpenMenu(null);
													set("endMode", "count");
												}}
											>
												{t("schedules.endCount")}
											</MenuItem>
										</FloatingLayer>
									)}
								</div>
							</div>
							{endErr && <ErrorLine message={endErr} />}
							{runsErr && <ErrorLine message={runsErr} />}
						</div>
					)}

					{form.agentTrigger !== "never" && (
						<div className="px-4 py-3">
							<div className="flex items-center justify-between gap-3">
								<span className="text-xs font-medium text-[var(--text)]">
									{t("schedules.newSessionEachRun")}
								</span>
								<Switch
									checked={
										form.runMode === "worktree" ? true : form.newChatEachRun
									}
									disabled={form.runMode === "worktree"}
									onChange={(v) => set("newChatEachRun", v)}
									ariaLabel={t("schedules.newSessionEachRun")}
								/>
							</div>
							<p className="mt-1 text-[11px] text-[var(--text-40)]">
								{form.runMode === "worktree"
									? t("schedules.newSessionWorktreeHint")
									: t("schedules.newSessionReuseHint")}
							</p>
						</div>
					)}

					{form.agentTrigger !== "never" && form.approvalMode !== "yolo" && (
						<div className="flex items-center gap-1.5 px-4 py-2.5 text-[11px] text-[var(--text-40)]">
							<Info size={12} className="shrink-0" />
							<span>{t("schedules.unattendedApprovalHint")}</span>
						</div>
					)}
				</div>
			</details>
		</div>
	);
});

function ErrorLine({ id, message }: { id?: string; message: string }) {
	return (
		<p
			id={id}
			className="mt-1.5 flex items-center gap-1 text-[11px] text-rose-400"
		>
			<AlertCircle size={12} className="shrink-0" aria-hidden="true" />
			<span>{message}</span>
		</p>
	);
}

function NumberStepper({
	value,
	min,
	onChange,
	ariaLabel,
}: {
	value: number;
	min: number;
	onChange: (next: number) => void;
	ariaLabel: string;
}) {
	const { t } = useT();
	const n = Number.isFinite(value) ? Math.floor(value) : min;
	return (
		<div className="inline-flex h-7 items-center rounded-lg border border-[var(--border-divider)] bg-[var(--bg)]">
			<button
				type="button"
				disabled={n <= min}
				onClick={() => onChange(Math.max(min, n - 1))}
				aria-label={t("schedules.stepperDecrease")}
				className="flex h-full w-6 items-center justify-center rounded-l-lg text-[var(--text-60)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-30"
			>
				<Minus size={11} />
			</button>
			<input
				type="number"
				min={min}
				max={999}
				aria-label={ariaLabel}
				value={Number.isFinite(value) ? value : ""}
				onChange={(e) => {
					const parsed = parseInt(e.target.value, 10);
					onChange(Number.isNaN(parsed) ? 0 : Math.min(999, parsed));
				}}
				className="w-10 [appearance:textfield] bg-transparent text-center text-xs text-[var(--text)] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
			/>
			<button
				type="button"
				disabled={n >= 999}
				onClick={() => onChange(Math.min(999, n + 1))}
				aria-label={t("schedules.stepperIncrease")}
				className="flex h-full w-6 items-center justify-center rounded-r-lg text-[var(--text-60)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-30"
			>
				<Plus size={11} />
			</button>
		</div>
	);
}

function MenuHeader({ children }: { children: ReactNode }) {
	return (
		<div className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-40)]">
			{children}
		</div>
	);
}

function MenuItem({
	children,
	label,
	desc,
	selected = false,
	disabled = false,
	onClick,
}: {
	children?: ReactNode;
	label?: ReactNode;
	desc?: string;
	selected?: boolean;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={clsx(
				"flex w-full items-start justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40",
				selected
					? "bg-[var(--bg-active-fill)] text-[var(--text)]"
					: "text-[var(--text-60)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
			)}
		>
			<div className="min-w-0 flex-1">
				<div className="font-medium leading-snug">{label ?? children}</div>
				{desc && (
					<div className="mt-0.5 break-all text-[11px] leading-snug text-[var(--text-40)]">
						{desc}
					</div>
				)}
			</div>
			{selected && (
				<Check size={13} className="mt-0.5 shrink-0 text-[var(--text)]" />
			)}
		</button>
	);
}

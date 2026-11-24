import { ChevronRight, Cpu, Play, Sparkles, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, errorMessage } from "../../core/api";
import { nav } from "../../core/nav";
import type { PageProps } from "../../core/nav";
import { useMobileSchedules } from "../../core/stores/schedules";
import {
	BottomSheet,
	Button,
	Chip,
	confirm,
	Field,
	inputCls,
	ListGroup,
	PageHeader,
	SelectRow,
	Spinner,
	Switch,
	toast,
} from "../../ui";
import { scrollBehavior } from "../../ui/motion";
import { ModelPicker } from "../../ui/ModelPicker";
import type { PickerModel } from "../../ui/ModelPicker";
import { startAutomationChat, takeManualScheduleDraft } from "../chat/automation/automationStatus";
import { AutomationOverviewView } from "./AutomationOverviewView";
import { LoadState, useLoad } from "./controls";
import {
	AGENT_TRIGGER_HINT,
	AGENT_TRIGGER_LABEL,
	APPROVAL_MODE_LABEL,
	buildExistingAutomationSystemPrompt,
	buildPayload,
	emptyForm,
	formFromSchedule,
	KIND_LABEL,
	modelString,
	NOTIFY_HINT,
	NOTIFY_LABEL,
	parseModel,
	resolveAgentTrigger,
	RESULT_MODE_HINT,
	RESULT_MODE_LABEL,
	RUN_MODE_HINT,
	RUN_MODE_LABEL,
	validateForm,
	WEEK,
} from "./schedule";
import type {
	AutomationSettingsSnapshot,
	CadenceKind,
	FormErrors,
	FormField,
	NotifyMode,
	ProbeTestResult,
	RunMode,
	Schedule,
	ScheduleAgentTrigger,
	ScheduleForm,
	ScheduleResultMode,
} from "./schedule";

interface Dir {
	path: string;
	label?: string;
	mode?: Schedule["mode"];
}

// Native iOS date/time inputs have an intrinsic minimum width; constrain them to the field.
const formInputCls = `${inputCls} block min-w-0 max-w-full box-border`;

function DateTimeInput({
	type,
	value,
	onChange,
	onBlur,
}: {
	type: "time" | "datetime-local";
	value: string;
	onChange: (value: string) => void;
	onBlur?: () => void;
}) {
	return (
		<span
			data-date-input-frame
			className="relative block h-12 min-w-0 w-full overflow-hidden rounded-[14px] bg-m-surface focus-within:ring-2 focus-within:ring-m-accent"
		>
			<input
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
				className={`${formInputCls} absolute inset-0 h-full appearance-none bg-transparent focus:ring-0`}
				style={{
					WebkitAppearance: "none",
					width: "100%",
					maxWidth: "100%",
					minWidth: 0,
					boxSizing: "border-box",
					background: "transparent",
				}}
			/>
		</span>
	);
}

const KIND_OPTIONS = (Object.keys(KIND_LABEL) as CadenceKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }));
const RUN_MODE_OPTIONS = (Object.keys(RUN_MODE_LABEL) as RunMode[]).map((k) => ({ value: k, label: RUN_MODE_LABEL[k] }));
const NOTIFY_OPTIONS = (Object.keys(NOTIFY_LABEL) as NotifyMode[]).map((k) => ({ value: k, label: NOTIFY_LABEL[k] }));
const TRIGGER_OPTIONS = (["always", "on_signal", "never"] as ScheduleAgentTrigger[]).map((k) => ({
	value: k,
	label: AGENT_TRIGGER_LABEL[k],
	hint: AGENT_TRIGGER_HINT[k],
}));
const RESULT_MODE_OPTIONS = (["structured", "llm_summary"] as ScheduleResultMode[]).map((k) => ({
	value: k,
	label: RESULT_MODE_LABEL[k],
	hint: RESULT_MODE_HINT[k],
}));
const APPROVAL_OPTIONS = (["", "always-ask", "write", "yolo"] as const).map((v) => ({
	value: v,
	label: APPROVAL_MODE_LABEL[v],
}));

const FIELD_ORDER: readonly FormField[] = [
	"name",
	"probeCommand",
	"prompt",
	"cwd",
	"iv",
	"time",
	"at",
	"mday",
	"mTime",
	"endAt",
	"maxRuns",
];

const DRAFT_STORAGE_PREFIX = "omp:mobile:schedule-draft:";

interface StoredScheduleDraft {
	baseRevision: string;
	dirtyKeys: Array<keyof ScheduleForm>;
	form: ScheduleForm;
}

function computeBaseRevision(existing: Schedule | null, baseline: ScheduleForm): string {
	const rev = existing?.updatedAt ?? existing?.id ?? "new";
	return `${rev}::${JSON.stringify(baseline)}`;
}

function diffFormKeys(form: ScheduleForm, baseline: ScheduleForm): Array<keyof ScheduleForm> {
	const keys = new Set([...Object.keys(form), ...Object.keys(baseline)]) as Set<keyof ScheduleForm>;
	const dirty: Array<keyof ScheduleForm> = [];
	for (const k of keys) {
		if (JSON.stringify(form[k]) !== JSON.stringify(baseline[k])) dirty.push(k);
	}
	return dirty;
}

function readStoredDraft(key: string): StoredScheduleDraft | null {
	try {
		if (typeof sessionStorage === "undefined") return null;
		const raw = sessionStorage.getItem(`${DRAFT_STORAGE_PREFIX}${key}`);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			Array.isArray(parsed) ||
			typeof (parsed as StoredScheduleDraft).baseRevision !== "string" ||
			!Array.isArray((parsed as StoredScheduleDraft).dirtyKeys) ||
			!(parsed as StoredScheduleDraft).form ||
			typeof (parsed as StoredScheduleDraft).form !== "object"
		) {
			return null;
		}
		return parsed as StoredScheduleDraft;
	} catch {
		return null;
	}
}

function writeStoredDraft(key: string, draft: StoredScheduleDraft): void {
	try {
		if (typeof sessionStorage === "undefined") return;
		sessionStorage.setItem(`${DRAFT_STORAGE_PREFIX}${key}`, JSON.stringify(draft));
	} catch {
		/* storage unavailable */
	}
}

function clearStoredDraft(key: string): void {
	try {
		if (typeof sessionStorage === "undefined") return;
		sessionStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${key}`);
	} catch {
		/* storage unavailable */
	}
}

function readHashTabQuery(): "overview" | "config" | null {
	if (typeof window === "undefined") return null;
	const hash = window.location.hash || "";
	const qIdx = hash.indexOf("?");
	if (qIdx < 0) return null;
	return new URLSearchParams(hash.slice(qIdx + 1)).get("tab") === "config" ? "config" : null;
}

/** Inline error node; `role="alert"` so screen readers announce it. */
const err = (msg?: string): ReactNode => (msg ? <span role="alert">{msg}</span> : undefined);

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex items-center justify-between gap-2 px-1">
				<h2 className="text-m-lg text-m-text">{title}</h2>
				{right}
			</div>
			{children}
		</section>
	);
}

/** Label + hint for button groups (not a `<label>`, so tapping the caption never toggles a button). */
function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<div role="group" aria-label={label}>
			<span className="mb-1.5 block px-1 text-m-xs font-medium text-m-text-3">{label}</span>
			{children}
			{hint && <span className="mt-1.5 block px-1 text-m-xs break-words text-m-text-3">{hint}</span>}
		</div>
	);
}

function SwitchRow({
	label,
	hint,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	hint?: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<div className="flex min-h-14 items-center gap-3 rounded-[14px] bg-m-surface py-1.5 pr-3 pl-4">
			<span className="min-w-0 flex-1">
				<span className="block text-m-md text-m-text">{label}</span>
				{hint && <span className="block text-m-xs break-words text-m-text-3">{hint}</span>}
			</span>
			<Switch checked={checked} disabled={disabled} label={label} onChange={onChange} />
		</div>
	);
}

interface GlobalAutomationDefaults {
	resultMode: ScheduleResultMode;
	model: string | null;
	thinking: string | null;
}

interface Loaded {
	dirs: Dir[];
	existing: Schedule | null;
	defaults?: GlobalAutomationDefaults;
}

export function ScheduleFormPage({
	id,
	initialTab,
}: {
	id?: string;
	initialTab?: "overview" | "config";
}) {
	const { data, error, loading, reload } = useLoad<Loaded>(async () => {
		const [{ dirs }, list, settings] = await Promise.all([
			api<{ dirs: Dir[] }>("GET", "/left/dirs"),
			id ? api<Schedule[]>("GET", "/left/schedules") : Promise.resolve<Schedule[]>([]),
			!id
				? api<Partial<AutomationSettingsSnapshot>>("GET", "/left/settings").catch(() => null)
				: Promise.resolve(null),
		]);
		const existing = id ? (list.find((s) => s.id === id) ?? null) : null;
		if (id && !existing) throw new Error("任务不存在");
		const defaults: GlobalAutomationDefaults | undefined =
			!id && settings
				? {
						resultMode: settings.automationDefaultResultMode === "llm_summary" ? "llm_summary" : "structured",
						model:
							typeof settings.automationDefaultModel === "string" && settings.automationDefaultModel.trim()
								? settings.automationDefaultModel.trim()
								: null,
						thinking:
							typeof settings.automationDefaultThinking === "string" && settings.automationDefaultThinking.trim()
								? settings.automationDefaultThinking.trim()
								: null,
					}
				: undefined;
		return { dirs: dirs ?? [], existing, defaults };
	}, [id]);

	const isDetail = Boolean(id);
	const [activeTab, setActiveTab] = useState<"overview" | "config">(() =>
		isDetail ? (initialTab ?? readHashTabQuery() ?? "overview") : "config",
	);
	useEffect(() => {
		if (!isDetail) {
			setActiveTab("config");
			return;
		}
		if (initialTab) setActiveTab(initialTab);
	}, [isDetail, initialTab, id]);
	const dirtyBackHandlerRef = useRef<(() => void) | null>(null);
	const handleHeaderBack = () => {
		if (activeTab === "config" && dirtyBackHandlerRef.current) {
			dirtyBackHandlerRef.current();
			return;
		}
		nav.back();
	};

	return (
		<div className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-m-bg text-m-text">
			<PageHeader
				title={isDetail ? (data?.existing?.name || "自动化详情") : "新建自动化"}
				onBack={handleHeaderBack}
			/>
			{isDetail && (
				<div className="shrink-0 px-4 pb-2">
					<div
						role="tablist"
						aria-label="自动化视图"
						className="grid grid-cols-2 gap-1 rounded-2xl bg-m-surface p-1"
					>
						<button
							type="button"
							role="tab"
							aria-selected={activeTab === "overview"}
							onClick={() => setActiveTab("overview")}
							className={`min-h-9 rounded-xl text-m-sm font-medium whitespace-nowrap transition-colors duration-(--m-dur-fast) ${
								activeTab === "overview"
									? "bg-m-accent text-m-accent-fg"
									: "text-m-text-2 active:text-m-text"
							}`}
						>
							运维总览
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={activeTab === "config"}
							onClick={() => setActiveTab("config")}
							className={`min-h-9 rounded-xl text-m-sm font-medium whitespace-nowrap transition-colors duration-(--m-dur-fast) ${
								activeTab === "config"
									? "bg-m-accent text-m-accent-fg"
									: "text-m-text-2 active:text-m-text"
							}`}
						>
							配置
						</button>
					</div>
				</div>
			)}

			{isDetail && activeTab === "overview" ? (
				<AutomationOverviewView
					id={id!}
					schedule={data?.existing}
					onScheduleChange={() => void reload()}
				/>
			) : data ? (
				<Form
					key={data.existing?.id ?? "new"}
					draftKey={data.existing?.id ?? "new"}
					dirs={data.dirs}
					existing={data.existing}
					defaults={data.defaults}
					registerBackGuard={(fn) => {
						dirtyBackHandlerRef.current = fn;
					}}
					onSaved={() => {
						if (isDetail) {
							void reload();
							setActiveTab("overview");
						} else {
							nav.back();
						}
					}}
				/>
			) : (
				<LoadState loading={loading} error={error} onRetry={reload} />
			)}
		</div>
	);
}

function Form({
	draftKey,
	dirs,
	existing,
	defaults,
	registerBackGuard,
	onSaved,
}: {
	draftKey: string;
	dirs: Dir[];
	existing: Schedule | null;
	defaults?: GlobalAutomationDefaults;
	registerBackGuard: (fn: (() => void) | null) => void;
	onSaved: () => void;
}) {
	const baseline = useMemo<ScheduleForm>(() => {
		if (existing) return formFromSchedule(existing);
		const f0 = emptyForm(dirs[0]?.path ?? "");
		if (defaults) {
			f0.resultMode = defaults.resultMode;
			if (defaults.model) {
				f0.model = defaults.model;
				f0.thinking = defaults.thinking;
			}
		}
		return f0;
	}, [existing, dirs, defaults]);
	const baseRevision = useMemo(() => computeBaseRevision(existing, baseline), [existing, baseline]);

	const initRef = useRef<{ form: ScheduleForm; restored: boolean } | null>(null);
	if (!initRef.current) {
		const handoff = takeManualScheduleDraft(draftKey);
		if (handoff) {
			initRef.current = { form: formFromSchedule(handoff), restored: false };
		} else {
			const cached = readStoredDraft(draftKey);
			if (cached) {
				if (cached.baseRevision === baseRevision) {
					const nextForm = { ...baseline, ...cached.form };
					const dirty = diffFormKeys(nextForm, baseline);
					initRef.current = { form: nextForm, restored: dirty.length > 0 };
				} else {
					const nextForm: ScheduleForm = { ...baseline };
					const allowedKeys = new Set(Object.keys(baseline) as Array<keyof ScheduleForm>);
					let rebasedAny = false;
					for (const k of cached.dirtyKeys) {
						if (allowedKeys.has(k) && k in cached.form) {
							(nextForm as unknown as Record<string, unknown>)[k] = cached.form[k];
							rebasedAny = true;
						}
					}
					const dirty = rebasedAny ? diffFormKeys(nextForm, baseline) : [];
					if (dirty.length > 0) {
						initRef.current = { form: nextForm, restored: true };
					} else {
						clearStoredDraft(draftKey);
						initRef.current = { form: baseline, restored: false };
					}
				}
			} else {
				initRef.current = { form: baseline, restored: false };
			}
		}
	}

	const [f, setF] = useState<ScheduleForm>(() => initRef.current!.form);
	const [restoredFromCache, setRestoredFromCache] = useState<boolean>(() => initRef.current!.restored);
	const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
	const [errors, setErrors] = useState<FormErrors>({});
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [models, setModels] = useState<PickerModel[] | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [testingProbe, setTestingProbe] = useState(false);
	const [probeResult, setProbeResult] = useState<ProbeTestResult | null>(null);
	const [probeError, setProbeError] = useState<string | null>(null);
	const [launchingAi, setLaunchingAi] = useState(false);

	const formBodyRef = useRef<HTMLDivElement>(null);
	const latestFormRef = useRef(f);
	latestFormRef.current = f;

	const dirtyKeys = useMemo(() => diffFormKeys(f, baseline), [f, baseline]);
	const isDirty = dirtyKeys.length > 0;

	useEffect(() => {
		if (isDirty) writeStoredDraft(draftKey, { baseRevision, dirtyKeys, form: f });
		else clearStoredDraft(draftKey);
	}, [draftKey, baseRevision, dirtyKeys, f, isDirty]);
	useEffect(() => {
		registerBackGuard(() => {
			if (!isDirty) {
				nav.back();
				return;
			}
			void confirm({
				title: "有未保存修改",
				message: "返回时是否放弃当前修改？点击「放弃修改」将清空未保存草稿；取消可继续编辑（草稿已自动暂存）。",
				confirmText: "放弃修改",
				cancelText: "继续编辑",
				danger: true,
			}).then((discard) => {
				if (discard) {
					clearStoredDraft(draftKey);
					nav.back();
				}
			});
		});
		return () => registerBackGuard(null);
	}, [draftKey, isDirty, registerBackGuard]);

	const set = (patch: Partial<ScheduleForm>) => {
		setF((prev) => {
			const next: ScheduleForm = { ...prev, ...patch };
			if (next.agentTrigger === "never") {
				next.runMode = "local";
			}
			if (next.runMode === "worktree") {
				next.fresh = true;
			}
			// Re-validate touched fields immediately on change.
			const allErrs = validateForm(next);
			setErrors((curErrs) => {
				const updated: FormErrors = { ...curErrs };
				for (const field of FIELD_ORDER) {
					if (touched[field] || field in curErrs) {
						if (allErrs[field]) updated[field] = allErrs[field];
						else delete updated[field];
					}
				}
				return updated;
			});
			return next;
		});
	};

	const markTouched = (field: FormField) => {
		setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
		const allErrs = validateForm(f);
		setErrors((prev) => {
			const next = { ...prev };
			if (allErrs[field]) next[field] = allErrs[field];
			else delete next[field];
			return next;
		});
	};

	const focusFirstError = (errs: FormErrors) => {
		const firstKey = FIELD_ORDER.find((k) => Boolean(errs[k]));
		if (!firstKey || !formBodyRef.current) return;
		const container = formBodyRef.current.querySelector<HTMLElement>(`[data-field="${firstKey}"]`);
		if (!container) return;
		if (typeof container.scrollIntoView === "function") {
			container.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
		}
		const focusable = container.querySelector<HTMLElement>("input, textarea, button, select");
		focusable?.focus?.();
	};

	// A stored cwd that is no longer listed must stay selectable, or saving would silently change it.
	const cwdOptions: Dir[] = f.cwd && !dirs.some((d) => d.path === f.cwd) ? [{ path: f.cwd }, ...dirs] : dirs;

	const openModels = () => {
		setModelOpen(true);
		if (models) return;
		setModelsError(null);
		api<{ models: PickerModel[] }>("GET", "/left/roles")
			.then((r) => setModels(r.models ?? []))
			.catch((e) => setModelsError(errorMessage(e, "模型列表加载失败")));
	};

	const runProbeTest = async () => {
		if (!f.probeCommand.trim() || testingProbe) return;
		if (!f.cwd) {
			markTouched("cwd");
			toast("请先选择工作目录", { kind: "error" });
			return;
		}
		setTestingProbe(true);
		setProbeError(null);
		try {
			const res = await useMobileSchedules.getState().testProbe({
				cwd: f.cwd,
				probeCommand: f.probeCommand.trim(),
				agentTrigger: f.agentTrigger,
				scheduleId: existing?.id ?? f.id,
			});
			setProbeResult(res);
		} catch (e) {
			setProbeError(errorMessage(e));
		} finally {
			setTestingProbe(false);
		}
	};

	const openAiAssist = async (purpose: "script" | "prompt" | "edit") => {
		if (launchingAi) return;
		setLaunchingAi(true);
		try {
			const cwd = f.cwd || dirs[0]?.path || ".";
			const dirMode = dirs.find((d) => d.path === cwd)?.mode ?? existing?.mode ?? "code";
			const prefill =
				purpose === "script"
					? `帮我为自动化任务「${f.name.trim() || "未命名自动化"}」编写或优化本地检测脚本：`
					: purpose === "prompt"
						? `帮我为自动化任务「${f.name.trim() || "未命名自动化"}」编写清晰的执行提示词：`
						: `我想调整自动化任务「${f.name.trim() || "未命名自动化"}」：`;
			const systemPrompt = existing
				? buildExistingAutomationSystemPrompt(existing)
				: buildExistingAutomationSystemPrompt({
						id: f.id,
						name: f.name.trim() || "未命名自动化",
						prompt: f.prompt,
						cwd,
						runMode: f.runMode,
						cadence: { kind: "daily", time: f.time || "09:00" },
						probeCommand: f.probeCommand.trim() || null,
						probeDescription: f.probeDescription.trim() || null,
						agentTrigger: f.agentTrigger,
						resultMode: f.resultMode,
					});
			await startAutomationChat({
				cwd,
				mode: dirMode,
				appendSystemPrompt: systemPrompt,
				prefill,
			});
		} catch (e) {
			toast(`打开 AI 协助失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setLaunchingAi(false);
		}
	};

	const save = async () => {
		const submitted = f;
		const errs = validateForm(submitted);
		setErrors(errs);
		setSubmitError(null);
		if (Object.keys(errs).length) {
			focusFirstError(errs);
			return;
		}
		setSaving(true);
		try {
			const body = buildPayload(submitted, existing);
			if (!existing) body.mode = dirs.find((dir) => dir.path === submitted.cwd)?.mode ?? "code";
			if (existing) await api("PUT", `/left/schedules/${encodeURIComponent(existing.id)}`, body);
			else await api("POST", "/left/schedules", body);
			const unchangedSinceSubmit = JSON.stringify(latestFormRef.current) === JSON.stringify(submitted);
			if (unchangedSinceSubmit) {
				clearStoredDraft(draftKey);
				setRestoredFromCache(false);
			} else {
				const remainingDirty = diffFormKeys(latestFormRef.current, submitted);
				if (remainingDirty.length > 0) {
					writeStoredDraft(draftKey, {
						baseRevision: computeBaseRevision(existing, submitted),
						dirtyKeys: remainingDirty,
						form: latestFormRef.current,
					});
				}
			}
			toast("已保存", { kind: "success" });
			void useMobileSchedules.getState().loadSchedules().catch(() => {});
			onSaved();
		} catch (e) {
			setSubmitError(`保存失败：${errorMessage(e)}`);
		} finally {
			setSaving(false);
		}
	};

	const errCount = Object.keys(errors).length;
	const selected = models ? parseModel(f.model, models) : null;
	const toggleDay = (d: number) =>
		set({ weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d] });
	const existingHasProbe = Boolean(existing?.probeCommand?.trim() || (existing && resolveAgentTrigger(existing) !== "always"));

	return (
		<>
			<div ref={formBodyRef} className="min-h-0 min-w-0 w-full flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
				<div className="flex min-w-0 w-full flex-col gap-9 px-4 pt-3 pb-4">
					{restoredFromCache && isDirty && (
						<div className="flex items-center justify-between gap-2 rounded-2xl border border-m-accent/30 bg-m-accent-soft/40 px-3.5 py-2.5 text-m-xs text-m-text">
							<span>已自动恢复上次未保存草稿</span>
							<button
								type="button"
								onClick={() => {
									clearStoredDraft(draftKey);
									setF(baseline);
									setErrors({});
									setTouched({});
									setRestoredFromCache(false);
								}}
								className="shrink-0 font-medium whitespace-nowrap text-m-accent"
							>
								还原
							</button>
						</div>
					)}

					{existingHasProbe && (
						<div className="flex items-start gap-2 rounded-2xl border border-m-border bg-m-surface px-3.5 py-2.5 text-m-xs text-m-text-2">
							<Terminal size={15} className="mt-0.5 shrink-0 text-m-accent" />
							<span>
								该任务已配置本地脚本与触发策略（{AGENT_TRIGGER_LABEL[resolveAgentTrigger(existing!)]}），修改保存时会自动完整保留。
							</span>
						</div>
					)}

					<Section
						title="任务内容"
						right={
							<button
								type="button"
								disabled={launchingAi}
								onClick={() => void openAiAssist(existing ? "edit" : "prompt")}
								className="inline-flex items-center gap-1 rounded-full bg-m-accent-soft px-3 py-1 text-m-xs font-medium whitespace-nowrap text-m-accent-soft-text active:opacity-70"
							>
								<Sparkles size={13} />
								<span>{existing ? "AI 修改任务" : "AI 对话定制"}</span>
							</button>
						}
					>
						<div data-field="name">
							<Field label="名称" error={err(errors.name)}>
								<input
									className={formInputCls}
									value={f.name}
									placeholder="例如：每日晨报"
									onChange={(e) => set({ name: e.target.value })}
									onBlur={() => markTouched("name")}
								/>
							</Field>
						</div>

						<Group label="触发方式" hint={AGENT_TRIGGER_HINT[f.agentTrigger]}>
							<div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="触发方式">
								{TRIGGER_OPTIONS.map((opt) => {
									const on = f.agentTrigger === opt.value;
									return (
										<button
											key={opt.value}
											type="button"
											role="radio"
											aria-checked={on}
											onClick={() => set({ agentTrigger: opt.value })}
											className={`min-h-11 rounded-xl px-2 py-2 text-center text-m-xs font-medium transition-colors duration-(--m-dur-fast) ${
												on
													? "bg-m-accent-soft text-m-accent-soft-text ring-1 ring-m-accent/40"
													: "bg-m-surface text-m-text-2"
											}`}
										>
											{opt.label}
										</button>
									);
								})}
							</div>
						</Group>

						{f.agentTrigger !== "always" && (
							<div className="flex flex-col gap-3 rounded-2xl border border-m-border bg-m-surface/50 p-3.5">
								<div className="flex items-center justify-between gap-2">
									<span className="inline-flex items-center gap-1.5 text-m-sm font-medium text-m-text">
										<Terminal size={15} className="text-m-accent" />
										<span>本地检测脚本</span>
									</span>
									<div className="flex items-center gap-1.5">
										<button
											type="button"
											disabled={launchingAi}
											onClick={() => void openAiAssist("script")}
											className="inline-flex items-center gap-1 rounded-full bg-m-surface px-2.5 py-1 text-[11px] font-medium whitespace-nowrap text-m-accent active:opacity-70"
										>
											<Sparkles size={11} />
											<span>AI 帮写/修</span>
										</button>
										<Button
											size="sm"
											variant="tonal"
											busy={testingProbe}
											disabled={!f.probeCommand.trim()}
											icon={<Play size={12} />}
											onClick={() => void runProbeTest()}
										>
											立即试跑
										</Button>
									</div>
								</div>

								<div data-field="probeCommand">
									<Field
										label="脚本命令"
										error={err(errors.probeCommand)}
										hint="退出码 0 且无 stdout 表示静默跳过（0 Token）；有 stdout 输出即产生信号。试跑将在电脑宿主机目录直接执行（30 秒超时）。"
									>
										<textarea
											className={`${formInputCls} min-h-24 resize-y font-m-mono text-[12px] leading-5`}
											rows={3}
											value={f.probeCommand}
											placeholder="例如：python3 scripts/check_updates.py"
											onChange={(e) => set({ probeCommand: e.target.value })}
											onBlur={() => markTouched("probeCommand")}
										/>
									</Field>
								</div>

								<Field label="脚本说明（可选）">
									<input
										className={formInputCls}
										value={f.probeDescription}
										placeholder="用一句人话说明这个脚本检查什么"
										onChange={(e) => set({ probeDescription: e.target.value })}
									/>
								</Field>

								{probeError && (
									<div role="alert" className="m-selectable rounded-xl bg-m-danger-bg p-2.5 text-m-xs break-words text-m-danger">
										试跑失败：{probeError}
									</div>
								)}
								{probeResult && (
									<div className="rounded-xl bg-m-bg p-3 text-m-xs">
										<div className="flex flex-wrap items-center gap-1.5">
											<Chip
												tone={
													probeResult.outcome === "error" || probeResult.timedOut
														? "danger"
														: probeResult.outcome === "signal"
															? "accent"
															: "success"
												}
											>
												{probeResult.timedOut
													? "执行超时"
													: probeResult.outcome === "error"
														? "脚本报错"
														: probeResult.outcome === "signal"
															? "有信号"
															: probeResult.outcome === "ok"
																? "脚本完成"
																: "静默无信号"}
											</Chip>
											<span className="text-m-text-3">{probeResult.durationMs}ms</span>
											{probeResult.exitCode != null && (
												<span className="text-m-text-3">退出码 {probeResult.exitCode}</span>
											)}
										</div>
										{probeResult.output ? (
											<pre
												className={`m-selectable mt-1.5 max-h-32 overflow-auto rounded-lg p-2 font-m-mono text-[11px] whitespace-pre-wrap break-all ${
													probeResult.outcome === "error" || probeResult.timedOut
														? "bg-m-danger-bg text-m-danger"
														: "bg-m-surface text-m-text"
												}`}
											>
												{probeResult.output}
											</pre>
										) : (
											<p className="mt-1 text-m-text-3">（无输出）</p>
										)}
									</div>
								)}

								<ListGroup className="!mx-0">
									<SelectRow
										title="结果汇报模式"
										subtitle={RESULT_MODE_HINT[f.resultMode]}
										presentation="menu"
										value={f.resultMode}
										options={RESULT_MODE_OPTIONS}
										onChange={(v) => set({ resultMode: v })}
									/>
								</ListGroup>
							</div>
						)}

						{f.agentTrigger !== "never" && (
							<div data-field="prompt">
								<Field label="提示词" error={err(errors.prompt)} hint="每次运行时发送给 agent">
									<textarea
										className={`${formInputCls} min-h-32 resize-none leading-6`}
										rows={5}
										value={f.prompt}
										placeholder="定时发送给 agent 的提示词"
										onChange={(e) => set({ prompt: e.target.value })}
										onBlur={() => markTouched("prompt")}
									/>
								</Field>
							</div>
						)}
					</Section>

					<Section title="运行环境">
						<ListGroup className="!mx-0">
							<div data-field="cwd">
								<SelectRow
									title="工作目录"
									subtitle={f.cwd || undefined}
									presentation="list"
									value={f.cwd}
									options={cwdOptions.map((d) => ({ value: d.path, label: d.label || d.path, hint: d.path }))}
									onChange={(v) => {
										set({ cwd: v });
										markTouched("cwd");
									}}
									error={err(errors.cwd)}
								/>
							</div>
							{f.agentTrigger !== "never" && (
								<SelectRow
									title="运行方式"
									subtitle={RUN_MODE_HINT[f.runMode]}
									presentation="menu"
									value={f.runMode}
									options={RUN_MODE_OPTIONS}
									onChange={(v) => set({ runMode: v })}
								/>
							)}
							{f.agentTrigger !== "never" && (
								<SelectRow
									title="审批模式"
									subtitle={APPROVAL_MODE_LABEL[f.approvalMode ?? ""]}
									presentation="menu"
									value={f.approvalMode ?? ""}
									options={APPROVAL_OPTIONS}
									onChange={(v) => set({ approvalMode: v || null })}
								/>
							)}
						</ListGroup>
						{f.agentTrigger !== "never" && (
							<Group label="模型" hint={f.model ? undefined : "留空使用默认模型"}>
								<button
									type="button"
									onClick={openModels}
									className="flex min-h-14 w-full items-center gap-3 rounded-[14px] bg-m-surface px-4 py-2.5 text-left active:bg-m-surface-hover"
								>
									<Cpu size={20} strokeWidth={1.75} className="shrink-0 text-m-text-2" aria-hidden />
									<span className="min-w-0 flex-1">
										<span className="block truncate font-m-mono text-m-sm text-m-text">
											{f.model ? `${f.model}${f.thinking ? ` · ${f.thinking}` : ""}` : "使用默认模型"}
										</span>
									</span>
									<ChevronRight size={18} className="shrink-0 text-m-text-3" aria-hidden />
								</button>
							</Group>
						)}
					</Section>

					<Section title="重复节奏">
						<ListGroup className="!mx-0">
							<SelectRow
								title="重复方式"
								presentation="menu"
								value={f.kind}
								options={KIND_OPTIONS}
								onChange={(v) => set({ kind: v })}
							/>
							{f.kind === "interval" && (
								<SelectRow
									title="单位"
									label="单位"
									presentation="menu"
									value={f.ivUnit}
									options={[
										{ value: "min", label: "分钟" },
										{ value: "hour", label: "小时" },
									]}
									onChange={(v) => set({ ivUnit: v as "min" | "hour" })}
								/>
							)}
						</ListGroup>
						{f.kind === "interval" && (
							<div data-field="iv">
								<Field label="每隔" error={err(errors.iv)}>
									<input
										className={formInputCls}
										type="number"
										inputMode="numeric"
										min={1}
										value={f.ivNum}
										onChange={(e) => set({ ivNum: e.target.value })}
										onBlur={() => markTouched("iv")}
									/>
								</Field>
							</div>
						)}
						{f.kind === "daily" && (
							<>
								<div data-field="time">
									<Field label="时间" error={err(errors.time)}>
										<DateTimeInput
											type="time"
											value={f.time}
											onChange={(value) => set({ time: value })}
											onBlur={() => markTouched("time")}
										/>
									</Field>
								</div>
								<Group label="星期" hint="不选则按天重复">
									<div className="flex flex-wrap justify-between gap-1">
										{WEEK.map((w, i) => {
											const on = f.weekdays.includes(i);
											return (
												<button
													key={w}
													type="button"
													aria-pressed={on}
													aria-label={`周${w}`}
													onClick={() => toggleDay(i)}
													className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-m-pill text-m-sm whitespace-nowrap transition-colors duration-(--m-dur-fast) ${
														on ? "bg-m-accent-soft font-medium text-m-accent-soft-text" : "bg-m-surface text-m-text-2"
													}`}
												>
													{w}
												</button>
											);
										})}
									</div>
								</Group>
								<Field label={f.weekdays.length ? "每隔几周" : "每隔几天"}>
									<input
										className={formInputCls}
										type="number"
										inputMode="numeric"
										min={1}
										value={f.every}
										onChange={(e) => set({ every: e.target.value })}
									/>
								</Field>
							</>
						)}
						{f.kind === "once" && (
							<div data-field="at">
								<Field label="运行时间" error={err(errors.at)}>
									<DateTimeInput
										type="datetime-local"
										value={f.at}
										onChange={(value) => set({ at: value })}
										onBlur={() => markTouched("at")}
									/>
								</Field>
							</div>
						)}
						{f.kind === "monthly" && (
							<>
								<div data-field="mday">
									<Field label="每月几号" error={err(errors.mday)} hint="超过当月天数时按当月最后一天运行">
										<input
											className={formInputCls}
											type="number"
											inputMode="numeric"
											min={1}
											max={31}
											value={f.mday}
											onChange={(e) => set({ mday: e.target.value })}
											onBlur={() => markTouched("mday")}
										/>
									</Field>
								</div>
								<div data-field="mTime">
									<Field label="时间" error={err(errors.mTime)}>
										<DateTimeInput
											type="time"
											value={f.mTime}
											onChange={(value) => set({ mTime: value })}
											onBlur={() => markTouched("mTime")}
										/>
									</Field>
								</div>
								<Field label="每隔几个月">
									<input
										className={formInputCls}
										type="number"
										inputMode="numeric"
										min={1}
										value={f.mEvery}
										onChange={(e) => set({ mEvery: e.target.value })}
									/>
								</Field>
							</>
						)}
						{f.kind !== "once" && (
							<>
								<div data-field="endAt">
									<Field label="结束时间（可选）" error={err(errors.endAt)}>
										<DateTimeInput
											type="datetime-local"
											value={f.endAt}
											onChange={(value) => set({ endAt: value })}
											onBlur={() => markTouched("endAt")}
										/>
									</Field>
								</div>
								<div data-field="maxRuns">
									<Field label="最多运行次数（可选）" error={err(errors.maxRuns)}>
										<input
											className={formInputCls}
											type="number"
											inputMode="numeric"
											min={1}
											value={f.maxRuns}
											placeholder="不限"
											onChange={(e) => set({ maxRuns: e.target.value })}
											onBlur={() => markTouched("maxRuns")}
										/>
									</Field>
								</div>
							</>
						)}
					</Section>

					<Section title="通知与开关">
						<ListGroup className="!mx-0">
							<SelectRow
								title="通知"
								subtitle={NOTIFY_HINT[f.notify]}
								presentation="menu"
								value={f.notify}
								options={NOTIFY_OPTIONS}
								onChange={(v) => set({ notify: v })}
							/>
						</ListGroup>
						<div className="flex flex-col gap-2">
							{f.agentTrigger !== "never" && (
								<SwitchRow
									label="每次运行新建会话"
									hint={
										f.runMode === "worktree"
											? "独立工作树模式下每次运行自动新建独立会话以隔离目录改动"
											: "关闭则在同一个会话里继续"
									}
									checked={f.runMode === "worktree" ? true : f.fresh}
									disabled={f.runMode === "worktree"}
									onChange={(v) => set({ fresh: v })}
								/>
							)}
							<SwitchRow label="启用" checked={f.enabled} onChange={(v) => set({ enabled: v })} />
						</div>
					</Section>
				</div>
			</div>

			<div
				className="min-w-0 w-full shrink-0 bg-m-bg px-4 pt-2"
				style={{ paddingBottom: "max(12px, min(var(--m-safe-bottom), 34px))" }}
			>
				{errCount > 0 && (
					<div role="alert" className="mb-2 px-1 text-m-sm text-m-danger">
						有 {errCount} 项需要修改，请查看上方标红提示
					</div>
				)}
				{submitError && (
					<div role="alert" className="m-selectable mb-2 px-1 text-m-sm break-words text-m-danger">
						{submitError}
					</div>
				)}
				<Button variant="primary" block busy={saving} onClick={() => void save()}>
					保存
				</Button>
			</div>

			<BottomSheet
				open={modelOpen}
				onClose={() => setModelOpen(false)}
				title="选择模型"
				fullHeight
				footer={
					<div className="flex gap-2">
						<Button
							block
							className="flex-1"
							onClick={() => {
								set({ model: null, thinking: null });
								setModelOpen(false);
							}}
						>
							使用默认模型
						</Button>
						<Button variant="primary" block className="flex-1" onClick={() => setModelOpen(false)}>
							完成
						</Button>
					</div>
				}
			>
				{models ? (
					<ModelPicker
						className="h-full px-4 pb-4"
						models={models}
						value={selected}
						onChange={(next) => {
							if (!next) return;
							set({ model: modelString({ provider: next.provider, id: next.id }) });
						}}
					/>
				) : modelsError ? (
					<div role="alert" className="px-4 py-6 text-center text-m-sm text-m-danger">
						{modelsError}
					</div>
				) : (
					<div className="flex items-center justify-center py-12">
						<Spinner />
					</div>
				)}
			</BottomSheet>
		</>
	);
}

export function ScheduleNewPage() {
	return <ScheduleFormPage />;
}

export function ScheduleDetailPage({ route }: PageProps) {
	const tab = route.query.tab === "config" ? "config" : "overview";
	return <ScheduleFormPage id={route.params.id} initialTab={tab} />;
}

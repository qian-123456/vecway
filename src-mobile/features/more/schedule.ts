import { formatDuration } from "../../core/lib/format";

export type CadenceKind = "interval" | "daily" | "once" | "monthly";
export type RunMode = "local" | "worktree";
export type NotifyMode = "all" | "important" | "none";
export type ScheduleAgentTrigger = "always" | "on_signal" | "never";
export type ScheduleResultMode = "structured" | "llm_summary";
export type ScheduleRunPhase = "probe_quiet" | "probe_only" | "agent" | "awaiting";
export type RunStatus = "running" | "ok" | "error" | "skipped";

export type Cadence =
	| { kind: "interval"; minutes: number }
	| { kind: "daily"; time: string; weekdays?: number[]; every?: number; anchor?: string }
	| { kind: "once"; at: string }
	| { kind: "monthly"; day: number; time: string; every?: number; anchor?: string };

export interface Schedule {
	id: string;
	name: string;
	prompt: string;
	cwd: string;
	mode: "code" | "work" | "study" | "research" | "chat";
	runMode: RunMode;
	cadence: Cadence;
	model: string | null;
	thinking: string | null;
	approvalMode: string | null;
	enabled: boolean;
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastRunStatus: RunStatus | null;
	lastRunPhase?: ScheduleRunPhase | null;
	lastRunSessionId?: string | null;
	notify: NotifyMode;
	newChatEachRun: boolean;
	endAt: string | null;
	lifecycle: "active" | "paused" | "completed";
	maxRuns: number | null;
	runsDone: number;
	probeCommand?: string | null;
	probeDescription?: string | null;
	agentTrigger?: ScheduleAgentTrigger;
	resultMode?: ScheduleResultMode;
	invokesExternalModel?: boolean;
	createdAt?: string;
	updatedAt?: string;
}

export interface ScheduleRun {
	id: string;
	scheduleId: string;
	sessionId: string | null;
	status: RunStatus;
	phase?: ScheduleRunPhase;
	probeOutput?: string | null;
	startedAt: string;
	finishedAt: string | null;
	summary: string | null;
}

export interface ScheduleDraft {
	id?: string;
	name: string;
	prompt: string;
	cwd: string;
	mode?: Schedule["mode"];
	runMode: RunMode;
	cadence: Cadence;
	model?: string | null;
	thinking?: string | null;
	approvalMode?: string | null;
	enabled?: boolean;
	notify?: NotifyMode;
	newChatEachRun?: boolean;
	endAt?: string | null;
	maxRuns?: number | null;
	probeCommand?: string | null;
	probeDescription?: string | null;
	agentTrigger?: ScheduleAgentTrigger;
	resultMode?: ScheduleResultMode;
	invokesExternalModel?: boolean;
}

export interface ProbeTestResult {
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	output: string;
	outcome: "quiet" | "signal" | "ok" | "error";
}

export interface AutomationAuthorResult {
	scheduleId: string;
	name: string;
	cadence: Cadence;
	agentTrigger: ScheduleAgentTrigger;
	resultMode?: ScheduleResultMode;
	invokesExternalModel?: boolean;
	probeDescription: string | null;
	probeCommand: string | null;
	prompt: string;
	notify: NotifyMode;
	explanation: string;
}

export interface AutomationWorktreeState {
	repoRoot: string;
	worktreePath: string;
	branch: string;
	ahead: number;
	dirty: number;
	committedDiff: string;
	uncommittedDiff: string;
	combinedDiff: string;
	addedLines: number;
	removedLines: number;
	runId?: string | null;
	sessionId?: string | null;
}

export interface AutomationSettingsSnapshot {
	automationBackgroundEnabled: boolean;
	automationOverlapPolicy: "skip" | "coalesce" | "queue" | "parallel";
	automationDefaultResultMode: ScheduleResultMode;
	automationDefaultModel: string | null;
	automationDefaultThinking: string | null;
	automationPromptMockTest: string | null;
	automationPromptRealOnceTest: string | null;
	automationPromptRealLoopTest: string | null;
	automationPromptAdjust: string | null;
}

export const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
export const RUN_STATUS_LABEL: Record<string, string> = { running: "运行中", ok: "成功", error: "失败", skipped: "跳过" };
export const RUN_PHASE_LABEL: Record<ScheduleRunPhase, string> = {
	probe_quiet: "静默无信号",
	probe_only: "脚本执行",
	agent: "智能体执行",
	awaiting: "等待确认",
};

export function runPhaseBadge(
	phase: ScheduleRunPhase | string | null | undefined,
	status?: string | null,
): { label: string; tone: "danger" | "neutral" | "warn" } | null {
	if (!phase) return null;
	if (phase === "probe_only") {
		if (status === "error") return { label: "脚本报错", tone: "danger" };
		if (status === "ok") return { label: "脚本完成", tone: "neutral" };
		return { label: RUN_PHASE_LABEL.probe_only, tone: "neutral" };
	}
	if (phase === "awaiting") return { label: RUN_PHASE_LABEL.awaiting, tone: "warn" };
	if (phase === "probe_quiet") return { label: RUN_PHASE_LABEL.probe_quiet, tone: "neutral" };
	if (phase === "agent") return { label: RUN_PHASE_LABEL.agent, tone: "neutral" };
	return { label: phase, tone: status === "error" ? "danger" : "neutral" };
}
export const LIFECYCLE_LABEL: Record<string, string> = { active: "进行中", paused: "已暂停", completed: "已完成" };
export const KIND_LABEL: Record<CadenceKind, string> = { interval: "间隔", daily: "每天/周", once: "仅一次", monthly: "每月" };
export const NOTIFY_LABEL: Record<NotifyMode, string> = { all: "全部", important: "仅重要", none: "不通知" };
export const NOTIFY_HINT: Record<NotifyMode, string> = {
	all: "每次运行结束都通知",
	important: "仅在失败或需要回复时通知",
	none: "从不通知",
};
export const RUN_MODE_LABEL: Record<RunMode, string> = { local: "直接运行", worktree: "新建工作树" };
export const RUN_MODE_HINT: Record<RunMode, string> = {
	local: "在所选目录中直接运行",
	worktree: "每次运行新建一个 Git 工作树，互不影响",
};
export const AGENT_TRIGGER_LABEL: Record<ScheduleAgentTrigger, string> = {
	always: "始终唤醒智能体",
	on_signal: "脚本有信号时唤醒",
	never: "仅跑本地脚本",
};
export const AGENT_TRIGGER_HINT: Record<ScheduleAgentTrigger, string> = {
	always: "每次到点直接启动智能体执行提示词",
	on_signal: "先运行本地检测脚本，无输出则静默跳过（0 Token），有输出再唤醒智能体",
	never: "只运行本地脚本，不调用智能体",
};
export const RESULT_MODE_LABEL: Record<ScheduleResultMode, string> = {
	structured: "结构化回报",
	llm_summary: "轻量模型总结",
};
export const RESULT_MODE_HINT: Record<ScheduleResultMode, string> = {
	structured: "脚本直接按结构化 JSON/人话回报（0 额外 Token）",
	llm_summary: "脚本有非静默输出时交由轻量模型总结",
};
export const APPROVAL_MODE_LABEL: Record<string, string> = {
	"": "跟随全局设置",
	"always-ask": "每步都确认",
	write: "修改前确认",
	yolo: "全自动执行",
};

export const AUTOMATION_COMPOSER_SYSTEM_PROMPT = [
	"The user started this conversation from Vecway's Automations page to create or update a Vecway Automation.",
	"Workflow:",
	"1. Inspect the workspace with your tools as needed so file paths, logs, and commands match the real repository.",
	"2. Decide cadence/schedule timing yourself from the user's goal when it is clear (e.g. daily digest or periodic watch); if timing is genuinely unclear or depends on user preference, ask the user briefly before proposing.",
	"3. Pick the right trigger mode: `on_signal` when a lightweight local script can filter out quiet runs at 0 LLM tokens, `never` for script-only jobs, or `always` when the agent should run every time.",
	'4. Whenever a local script is used, write it via `vecway_automation` (`action: "stage_script"`) and run/verify it in `cwd` before proposing.',
	'5. Call `vecway_automation` (`action: "propose"`, preserving `draft.id` when updating an existing automation) so the confirmation card appears above the composer. Always provide a concise human-readable `draft.summary` (1-2 sentences in the user\'s language describing what the agent will do and key guardrails, since humans will review `summary` rather than the raw `prompt`). Never edit OS `crontab` or `LaunchAgents` directly.',
].join("\n");

export type AutomationPromptKey = "mockTest" | "realOnceTest" | "realLoopTest" | "adjust";

export const DEFAULT_AUTOMATION_PROMPTS: Record<AutomationPromptKey, string> = {
	mockTest:
		"帮我在模拟环境下测试「{{name}}」，用模拟数据验证整个流程，不改动真实环境。遇到问题在不改变我原意的前提下自行修复并复测，稳定通过后更新确认卡并展示预期汇报效果；需要我做取舍或多次修复仍过不了时再停下来说明。",
	realOnceTest:
		"帮我在真实环境下测试「{{name}}」，实际执行一轮验证效果。成功的话汇报真实结果；如果遇到异常或卡住，立刻停止并说明原因，不要盲目重试，给出下一步修复建议。",
	realLoopTest:
		"帮我在真实环境下测试「{{name}}」。通过后汇报实际结果并按需更新确认卡；遇到问题时定位原因并修复复测直到稳定，涉及高风险或不可逆操作、或需要我做决策时再先停下来确认。",
	adjust: "我对「{{name}}」方案还想调整：",
};

const SETTINGS_FIELD_MAP: Record<AutomationPromptKey, keyof AutomationSettingsSnapshot> = {
	mockTest: "automationPromptMockTest",
	realOnceTest: "automationPromptRealOnceTest",
	realLoopTest: "automationPromptRealLoopTest",
	adjust: "automationPromptAdjust",
};

export function renderAutomationPrompt(
	key: AutomationPromptKey,
	name: string,
	settings?: Partial<AutomationSettingsSnapshot> | null,
): string {
	const field = SETTINGS_FIELD_MAP[key];
	const custom = settings?.[field];
	const template = typeof custom === "string" && custom.trim() ? custom : DEFAULT_AUTOMATION_PROMPTS[key];
	return template.replace(/\{\{\s*name\s*\}\}/g, name.trim() || "未命名自动化");
}

export function buildExistingAutomationSystemPrompt(schedule: Schedule | ScheduleDraft): string {
	const summary = JSON.stringify(
		{
			id: "id" in schedule ? schedule.id : undefined,
			name: schedule.name,
			cwd: schedule.cwd,
			cadence: schedule.cadence,
			agentTrigger: schedule.agentTrigger ?? (schedule.probeCommand ? "on_signal" : "always"),
			probeCommand: schedule.probeCommand ?? null,
			probeDescription: schedule.probeDescription ?? null,
			resultMode: schedule.resultMode ?? "structured",
			runMode: schedule.runMode,
			model: schedule.model ?? null,
			thinking: schedule.thinking ?? null,
			notify: schedule.notify ?? "important",
			prompt: schedule.prompt,
		},
		null,
		2,
	);
	const hasId = Boolean("id" in schedule && schedule.id);
	const idNote = hasId
		? 'Existing automation being updated (keep its `id` in `vecway_automation` `action: "propose"` `draft`)'
		: "Current automation draft being edited";
	return `${AUTOMATION_COMPOSER_SYSTEM_PROMPT}\n\n${idNote}:\n${summary}`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "M-DD HH:mm" in local time, "" for an unparsable instant. */
export function fmtTime(iso: string | null | undefined): string {
	const d = new Date(iso ?? "");
	return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Value for `<input type="datetime-local">` (local time) from an RFC3339 instant. */
export function toLocalInput(iso: string | null | undefined): string {
	const d = new Date(iso ?? "");
	return Number.isNaN(d.getTime())
		? ""
		: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Human description of a cadence, e.g. "每 2 小时", "每周 周一、周三 09:00". */
export function cadenceText(c: Cadence | null | undefined): string {
	if (!c) return "";
	switch (c.kind) {
		case "interval":
			if (!Number.isFinite(c.minutes) || c.minutes < 1) return "周期未设置";
			return c.minutes % 60 === 0 ? `每 ${c.minutes / 60} 小时` : `每 ${c.minutes} 分钟`;
		case "daily": {
			const wd = c.weekdays ?? [];
			const ev = c.every ?? 1;
			if (wd.length) return `每${ev > 1 ? ` ${ev} ` : ""}周 ${wd.map((d) => `周${WEEK[d % 7]}`).join("、")} ${c.time}`;
			return `${ev > 1 ? `每 ${ev} 天` : "每天"} ${c.time}`;
		}
		case "once":
			return `一次 · ${fmtTime(c.at)}`;
		case "monthly":
			return `每${(c.every ?? 1) > 1 ? ` ${c.every} ` : ""}月 ${c.day} 日 ${c.time}`;
	}
	return "";
}

/** Resolve effective agentTrigger for schedules created before agentTrigger existed. */
export function resolveAgentTrigger(s: Pick<Schedule, "agentTrigger" | "probeCommand">): ScheduleAgentTrigger {
	if (s.agentTrigger === "always" || s.agentTrigger === "on_signal" || s.agentTrigger === "never") {
		return s.agentTrigger;
	}
	return s.probeCommand?.trim() ? "on_signal" : "always";
}

/* ---------------------------------------------------------------- form <-> payload */

export interface ScheduleForm {
	/** Preserved staged/existing ID when coming from an AI draft or edit. */
	id?: string;
	name: string;
	prompt: string;
	cwd: string;
	runMode: RunMode;
	kind: CadenceKind;
	ivNum: string;
	ivUnit: "min" | "hour";
	time: string;
	every: string;
	weekdays: number[];
	at: string;
	mday: string;
	mTime: string;
	mEvery: string;
	endAt: string;
	maxRuns: string;
	notify: NotifyMode;
	fresh: boolean;
	enabled: boolean;
	model: string | null;
	thinking: string | null;
	approvalMode: string | null;
	agentTrigger: ScheduleAgentTrigger;
	probeCommand: string;
	probeDescription: string;
	resultMode: ScheduleResultMode;
	invokesExternalModel: boolean;
	/** Preserved from the stored cadence so editing does not shift the day/week/month phase. */
	anchor?: string;
}

export function emptyForm(defaultCwd = ""): ScheduleForm {
	return {
		name: "",
		prompt: "",
		cwd: defaultCwd,
		runMode: "local",
		kind: "daily",
		ivNum: "1",
		ivUnit: "hour",
		time: "09:00",
		every: "1",
		weekdays: [],
		at: "",
		mday: "1",
		mTime: "09:00",
		mEvery: "1",
		endAt: "",
		maxRuns: "",
		notify: "important",
		fresh: true,
		enabled: true,
		model: null,
		thinking: null,
		approvalMode: null,
		agentTrigger: "always",
		probeCommand: "",
		probeDescription: "",
		resultMode: "structured",
		invokesExternalModel: false,
	};
}

export function formFromSchedule(s: Schedule | ScheduleDraft): ScheduleForm {
	const f = emptyForm(s.cwd);
	const c = s.cadence;
	const trigger = resolveAgentTrigger(s);
	Object.assign(f, {
		id: s.id,
		name: s.name,
		prompt: s.prompt ?? "",
		runMode: trigger === "never" ? "local" : s.runMode,
		kind: c.kind,
		endAt: toLocalInput(s.endAt),
		maxRuns: s.maxRuns ? String(s.maxRuns) : "",
		notify: s.notify ?? "important",
		fresh: s.newChatEachRun !== false,
		enabled: s.enabled !== false,
		model: s.model ?? null,
		thinking: s.thinking ?? null,
		approvalMode: s.approvalMode ?? null,
		agentTrigger: trigger,
		probeCommand: s.probeCommand ?? "",
		probeDescription: s.probeDescription ?? "",
		resultMode: s.resultMode === "llm_summary" ? "llm_summary" : "structured",
		invokesExternalModel: s.invokesExternalModel === true,
	});
	if (c.kind === "interval") {
		const hour = c.minutes % 60 === 0;
		f.ivUnit = hour ? "hour" : "min";
		f.ivNum = String(hour ? c.minutes / 60 : c.minutes);
	} else if (c.kind === "daily") {
		f.time = c.time;
		f.every = String(c.every ?? 1);
		f.weekdays = [...(c.weekdays ?? [])];
		f.anchor = c.anchor;
	} else if (c.kind === "once") {
		f.at = toLocalInput(c.at);
	} else {
		f.mday = String(c.day);
		f.mTime = c.time;
		f.mEvery = String(c.every ?? 1);
		f.anchor = c.anchor;
	}
	return f;
}

export type FormField =
	| "name"
	| "prompt"
	| "probeCommand"
	| "cwd"
	| "iv"
	| "time"
	| "at"
	| "mday"
	| "mTime"
	| "endAt"
	| "maxRuns";
export type FormErrors = Partial<Record<FormField, string>>;

const validDate = (local: string): boolean => !!local && !Number.isNaN(new Date(local).getTime());

/** Field-level validation; an empty object means the form is valid. Messages are shown in full under the field. */
export function validateForm(f: ScheduleForm): FormErrors {
	const e: FormErrors = {};
	if (!f.name.trim()) e.name = "请填写任务名称";
	if (f.agentTrigger !== "never" && !f.prompt.trim()) {
		e.prompt = "请填写提示词，它会在每次运行时发送给 agent";
	}
	if ((f.agentTrigger === "on_signal" || f.agentTrigger === "never") && !f.probeCommand.trim()) {
		e.probeCommand = "请填写本地检测脚本命令";
	}
	if (!f.cwd) e.cwd = "请选择工作目录";
	if (f.kind === "interval") {
		const n = Math.round(Number(f.ivNum));
		if (!(n >= 1)) e.iv = "间隔至少为 1";
	} else if (f.kind === "daily") {
		if (!f.time) e.time = "请选择运行时间";
	} else if (f.kind === "once") {
		if (!validDate(f.at)) e.at = "请选择运行时间";
	} else {
		const d = Math.round(Number(f.mday));
		if (!(d >= 1 && d <= 31)) e.mday = "日期需在 1 到 31 之间";
		if (!f.mTime) e.mTime = "请选择运行时间";
	}
	if (f.kind !== "once") {
		if (f.endAt && !validDate(f.endAt)) e.endAt = "结束时间格式不正确";
		if (f.maxRuns.trim()) {
			const n = Number(f.maxRuns);
			if (!(Number.isInteger(n) && n >= 1)) e.maxRuns = "最多运行次数需为不小于 1 的整数，留空表示不限";
		}
	}
	return e;
}

const every = (raw: string): number => Math.max(1, Math.round(Number(raw) || 1));

export function buildCadence(f: ScheduleForm): Cadence {
	switch (f.kind) {
		case "interval": {
			const n = Math.round(Number(f.ivNum));
			return { kind: "interval", minutes: f.ivUnit === "hour" ? n * 60 : n };
		}
		case "daily": {
			const c: Cadence = { kind: "daily", time: f.time, every: every(f.every) };
			if (f.weekdays.length) c.weekdays = [...new Set(f.weekdays)].sort((a, b) => a - b);
			if (f.anchor) c.anchor = f.anchor;
			return c;
		}
		case "once":
			return { kind: "once", at: new Date(f.at).toISOString() };
		case "monthly": {
			const c: Cadence = { kind: "monthly", day: Math.round(Number(f.mday)), time: f.mTime, every: every(f.mEvery) };
			if (f.anchor) c.anchor = f.anchor;
			return c;
		}
	}
}

/** Body for POST/PUT `/left/schedules`. Caller must validate first. `existing` keeps fields the form does not edit. */
export function buildPayload(f: ScheduleForm, existing?: Schedule | null): Record<string, unknown> {
	const recurring = f.kind !== "once";
	const effectiveRunMode: RunMode = f.agentTrigger === "never" ? "local" : f.runMode;
	const effectiveFresh = effectiveRunMode === "worktree" ? true : f.fresh;
	const probeCommand = f.probeCommand.trim() || null;
	const probeDescription = f.probeDescription.trim() || null;
	const draft: Record<string, unknown> = {
		name: f.name.trim(),
		prompt: f.agentTrigger === "never" ? "" : f.prompt.trim(),
		cwd: f.cwd,
		mode: existing?.mode ?? "code",
		runMode: effectiveRunMode,
		cadence: buildCadence(f),
		model: f.model,
		thinking: f.model ? f.thinking : null,
		approvalMode: f.approvalMode || null,
		enabled: f.enabled,
		notify: f.notify,
		newChatEachRun: effectiveFresh,
		endAt: recurring && f.endAt ? new Date(f.endAt).toISOString() : null,
		maxRuns: recurring && f.maxRuns.trim() ? Math.max(1, Math.round(Number(f.maxRuns))) : null,
		probeCommand,
		probeDescription,
		agentTrigger: f.agentTrigger,
		resultMode: f.resultMode,
		invokesExternalModel: f.invokesExternalModel,
	};
	// Clear probe fields explicitly when user switches to `always` and clears command.
	if (f.agentTrigger === "always" && !probeCommand) {
		draft.probeCommand = null;
		draft.probeDescription = null;
	}
	const resolvedId = existing?.id ?? f.id;
	if (resolvedId) draft.id = resolvedId;
	return draft;
}

/**
 * Serialize a merged `Schedule` directly to a `ScheduleDraft` PUT payload
 * without round-tripping `endAt` or `once.at` through minute-precision `<input>` strings.
 */
export function scheduleDraftFromSchedule(s: Schedule): Record<string, unknown> {
	const trigger = resolveAgentTrigger(s);
	const effectiveRunMode: RunMode = trigger === "never" ? "local" : s.runMode;
	const effectiveFresh = effectiveRunMode === "worktree" ? true : s.newChatEachRun !== false;
	const probeCommand = s.probeCommand?.trim() || null;
	const probeDescription = s.probeDescription?.trim() || null;
	const recurring = s.cadence.kind !== "once";
	const payload: Record<string, unknown> = {
		id: s.id,
		name: s.name.trim(),
		prompt: trigger === "never" ? "" : s.prompt.trim(),
		cwd: s.cwd,
		mode: s.mode ?? "code",
		runMode: effectiveRunMode,
		cadence: s.cadence,
		model: s.model ?? null,
		thinking: s.model ? (s.thinking ?? null) : null,
		approvalMode: s.approvalMode || null,
		enabled: s.enabled !== false,
		notify: s.notify ?? "important",
		newChatEachRun: effectiveFresh,
		endAt: recurring ? (s.endAt ?? null) : null,
		maxRuns: recurring ? (s.maxRuns ?? null) : null,
		probeCommand,
		probeDescription,
		agentTrigger: trigger,
		resultMode: s.resultMode === "llm_summary" ? "llm_summary" : "structured",
		invokesExternalModel: s.invokesExternalModel === true,
	};
	if (trigger === "always" && !probeCommand) {
		payload.probeCommand = null;
		payload.probeDescription = null;
	}
	return payload;
}

/** Clone a schedule into a new creation payload (strips `id`, resets name suffix, starts paused or enabled). */
export function draftFromSchedule(s: Schedule): Record<string, unknown> {
	const form = formFromSchedule(s);
	form.id = undefined;
	form.name = `${s.name}（副本）`;
	const payload = buildPayload(form, null);
	payload.mode = s.mode;
	delete payload.id;
	return payload;
}

/** Minimal lossless update payload when renaming a schedule from the dashboard menu. */
export function renamePayload(s: Schedule, nextName: string): Record<string, unknown> {
	const form = formFromSchedule(s);
	form.name = nextName.trim();
	return buildPayload(form, s);
}

/** Parse structured JSON run summary when present; falls back to raw summary text. */
export function formatRunSummary(raw: string | null | undefined): { headline: string; details?: string } | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			const title =
				typeof parsed.summary === "string"
					? parsed.summary
					: typeof parsed.headline === "string"
						? parsed.headline
						: typeof parsed.title === "string"
							? parsed.title
							: typeof parsed.message === "string"
								? parsed.message
								: null;
			if (title?.trim()) {
				const detail =
					typeof parsed.details === "string"
						? parsed.details
						: typeof parsed.detail === "string"
							? parsed.detail
							: Array.isArray(parsed.items)
								? parsed.items.map((item) => `• ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n")
								: undefined;
				return { headline: title.trim(), details: detail?.trim() || undefined };
			}
		} catch {
			/* fall back to plain text */
		}
	}
	return { headline: trimmed };
}

/* ---------------------------------------------------------------- list / runs formatting */

/** Secondary line of a schedule row: next run · last result · progress (lifecycle is a chip). */
export function scheduleMeta(s: Schedule): string {
	const parts: string[] = [];
	if (s.nextRunAt && s.enabled) parts.push(`下次 ${fmtTime(s.nextRunAt)}`);
	if (s.lastRunStatus) {
		const phaseNote = s.lastRunPhase === "probe_quiet" ? "（静默）" : "";
		parts.push(`上次${RUN_STATUS_LABEL[s.lastRunStatus] ?? s.lastRunStatus}${phaseNote}`);
	}
	if (s.maxRuns) parts.push(`${s.runsDone}/${s.maxRuns} 次`);
	return parts.join(" · ");
}

/** "耗时 1m 05s" for a finished run, "" while running or when timestamps are unusable. */
export function runDurationText(r: Pick<ScheduleRun, "startedAt" | "finishedAt">): string {
	if (!r.finishedAt) return "";
	const ms = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
	if (Number.isNaN(ms)) return "";
	return `耗时 ${formatDuration(Math.max(0, ms))}`;
}

export function runTone(status: string): "success" | "danger" | "accent" | "neutral" {
	return status === "ok" ? "success" : status === "error" ? "danger" : status === "running" ? "accent" : "neutral";
}

/** A stored model string "provider/id" matched against the catalog; null when not listed. */
export function parseModel(
	value: string | null | undefined,
	models: ReadonlyArray<{ provider: string; id: string }>,
): { provider: string; modelId: string } | null {
	if (!value) return null;
	const hit = models.find((m) => `${m.provider}/${m.id}` === value) ?? models.find((m) => m.id === value);
	return hit ? { provider: hit.provider, modelId: hit.id } : null;
}

export const modelString = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`;

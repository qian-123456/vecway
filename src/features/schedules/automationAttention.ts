import { useEffect, useMemo } from "react";
import type {
	Schedule,
	ScheduleCadence,
	SessionMeta,
	SpaceMode,
	Todo,
} from "../../lib/contracts";
import { dispatchPrompt, resumeAwaitingScheduleRun, rpcStart } from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { tNow } from "../../stores/language";
import { useComposer } from "../../stores/composer";
import { useLive } from "../../stores/live";
import { markSessionSeen, useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { usePendingSession } from "../sessions/pendingSession";
import { startTodos, useTodos } from "../todos/store";
import { formatCadence } from "./humanCadence";
import { useSchedulesStore } from "./schedulesStore";

export const AUTOMATION_COMPOSER_SYSTEM_PROMPT = [
	"The user started this conversation from Vecway's Automations page to create or update a Vecway Automation.",
	"Workflow:",
	"1. Inspect the workspace with your tools as needed so file paths, logs, and commands match the real repository.",
	"2. Decide cadence/schedule timing yourself from the user's goal when it is clear (e.g. daily digest or periodic watch); if timing is genuinely unclear or depends on user preference, ask the user briefly before proposing.",
	"3. Pick the right trigger mode: `on_signal` when a lightweight local script can filter out quiet runs at 0 LLM tokens, `never` for script-only jobs, or `always` when the agent should run every time.",
	'4. Whenever a local script is used, write it via `vecway_automation` (`action: "stage_script"`) and run/verify it in `cwd` before proposing.',
	'5. Call `vecway_automation` (`action: "propose"`, preserving `draft.id` when updating an existing automation) so the confirmation card appears above the composer. Always provide a concise human-readable `draft.summary` (1-2 sentences in the user\'s language describing what the agent will do and key guardrails, since humans will review `summary` rather than the raw `prompt`). Never edit OS `crontab` or `LaunchAgents` directly.',
].join("\n");

export type AutomationAttentionTone = "awaiting" | "error" | "unread";

export interface AutomationScheduleAttention {
	scheduleId: string;
	tone: AutomationAttentionTone;
	count: number;
	todoIds: string[];
	sessionId: string | null;
	probeError: boolean;
}

export interface AutomationAttentionSummary {
	byScheduleId: Record<string, AutomationScheduleAttention>;
	totalCount: number;
	highestTone: AutomationAttentionTone | null;
}

interface ScheduleTodoPayload {
	scheduleId?: unknown;
	ok?: unknown;
	probeError?: unknown;
	awaiting?: unknown;
}

function readPayload(todo: Todo): ScheduleTodoPayload | null {
	return todo.payload && typeof todo.payload === "object"
		? (todo.payload as ScheduleTodoPayload)
		: null;
}

/**
 * Pure derivation of per-automation & sidebar notification state.
 * Keeps sidebar, row badges, and Inbox synchronized around open `schedule_run`
 * todos and live session `awaiting` attention. `probe_quiet` runs produce no
 * todos and never create badges.
 */
export function deriveAutomationAttention(
	schedules: Schedule[],
	todos: Todo[],
	sessions: Record<string, SessionMeta>,
): AutomationAttentionSummary {
	const openTodos = todos.filter(
		(t) => t.kind === "schedule_run" && t.status === "open",
	);

	const todosBySchedule = new Map<string, Todo[]>();
	const knownIds = new Set(schedules.map((s) => s.id));
	let orphanCount = 0;

	for (const todo of openTodos) {
		const sid = readPayload(todo)?.scheduleId;
		if (typeof sid === "string" && sid.length > 0 && knownIds.has(sid)) {
			const list = todosBySchedule.get(sid);
			if (list) list.push(todo);
			else todosBySchedule.set(sid, [todo]);
		} else {
			orphanCount++;
		}
	}

	const byScheduleId: Record<string, AutomationScheduleAttention> = {};
	let hasError = false;
	let hasAwaiting = false;

	for (const s of schedules) {
		const sTodos = todosBySchedule.get(s.id) ?? [];
		const todoSessionId = sTodos.find((t) => typeof t.sessionId === "string" && t.sessionId)?.sessionId ?? null;
		const sessionId = s.lastRunSessionId ?? todoSessionId;
		const linkedSession = sessionId ? sessions[sessionId] : undefined;

		const isAwaiting =
			(linkedSession !== undefined &&
				!linkedSession.archived &&
				linkedSession.attention === "awaiting") ||
			sTodos.some((t) => readPayload(t)?.awaiting === true);

		const hasErrorTodo = sTodos.some((t) => readPayload(t)?.ok === false);
		const hasUnreadTodo = sTodos.some((t) => {
			const p = readPayload(t);
			return p?.ok !== false && p?.awaiting !== true;
		});

		let tone: AutomationAttentionTone | null = null;
		if (isAwaiting) {
			tone = "awaiting";
			hasAwaiting = true;
		} else if (hasErrorTodo) {
			tone = "error";
			hasError = true;
		} else if (hasUnreadTodo) {
			tone = "unread";
		}

		if (!tone) continue;

		byScheduleId[s.id] = {
			scheduleId: s.id,
			tone,
			count: Math.max(1, sTodos.length),
			todoIds: sTodos.map((t) => t.id),
			sessionId,
			probeError: sTodos.some((t) => readPayload(t)?.probeError === true),
		};
	}

	const totalCount = Object.keys(byScheduleId).length + orphanCount;
	const highestTone: AutomationAttentionTone | null = hasError
		? "error"
		: hasAwaiting
			? "awaiting"
			: totalCount > 0
				? "unread"
				: null;

	return { byScheduleId, totalCount, highestTone };
}

let schedulesBootstrapped = false;

/** Subscribe to synchronized automation attention counts (loads stores once at startup). */
export function useAutomationAttention(): AutomationAttentionSummary {
	const schedules = useSchedulesStore((s) => s.schedules);
	const todos = useTodos((s) => s.todos);
	const sessions = useSessions((s) => s.sessions);

	useEffect(() => {
		void startTodos();
		if (!schedulesBootstrapped) {
			schedulesBootstrapped = true;
			void useSchedulesStore.getState().load();
		}
	}, []);

	return useMemo(
		() => deriveAutomationAttention(schedules, todos, sessions),
		[schedules, todos, sessions],
	);
}

/**
 * Mark an automation's pending unread/error attention acknowledged from either
 * the Automations list or Inbox. Never dismisses an active `awaiting` session.
 */
export async function acknowledgeAutomationAttention(scheduleId: string): Promise<void> {
	const todosState = useTodos.getState();
	const matching = todosState.todos.filter(
		(t) =>
			t.kind === "schedule_run" &&
			t.status === "open" &&
			readPayload(t)?.scheduleId === scheduleId,
	);
	if (matching.length > 0) {
		await Promise.all(matching.map((t) => todosState.act(t.id, "done")));
	}

	const schedState = useSchedulesStore.getState();
	const latestRun = schedState.runs[scheduleId]?.[0];
	if (latestRun) {
		schedState.markRunSeen(latestRun.id);
	}

	const schedule = schedState.schedules.find((s) => s.id === scheduleId);
	const sid = schedule?.lastRunSessionId;
	if (sid) {
		const session = useSessions.getState().sessions[sid];
		if (session && (session.attention === "unread" || session.attention === "error")) {
			await markSessionSeen(sid);
		}
	}
}

/**
 * Open the automation session, resuming an identified waiting run if offline.
 */
export async function resumeOrOpenAutomationSession(
	schedule: Pick<Schedule, "id">,
	sessionId: string,
	isAwaiting: boolean,
	runId?: string,
): Promise<void> {
	if (schedule.id) {
		void acknowledgeAutomationAttention(schedule.id);
	}
	useUi.getState().selectSession(sessionId);

	if (isAwaiting && runId && !useLive.getState().sessions[sessionId]?.alive) {
		try {
			await resumeAwaitingScheduleRun(schedule.id, runId);
			await Promise.all([
				useSchedulesStore.getState().loadRuns(schedule.id, 30),
				useSchedulesStore.getState().load(),
				useSessions.getState().load(),
			]);
		} catch (e) {
			toast.error(String(e));
		}
	}
}

/** Launch an agent troubleshooting session to repair a broken automation script. */
export async function fixAutomationProbeWithAi(
	target: {
		id?: string;
		name: string;
		cwd: string;
		mode?: SpaceMode;
		probeCommand?: string | null;
		probeDescription?: string | null;
	},
	errorOutput: string,
): Promise<void> {
	const lines = [
		`请帮我排查并修复自动化「${target.name || "未命名自动化"}」的前置脚本/命令。`,
		target.probeDescription?.trim() ? `脚本目标：${target.probeDescription.trim()}` : "",
		target.probeCommand?.trim() ? `当前脚本命令：\n\`\`\`sh\n${target.probeCommand.trim()}\n\`\`\`` : "",
		errorOutput.trim() ? `<error_output>\n${errorOutput.trim()}\n</error_output>` : "",
		"",
		"要求：",
		"1. 先定位失败原因（路径、依赖、权限、退出码语义或语法问题）并修复；注意不要去修改系统的 crontab 或 LaunchAgents。",
		"2. 修改后在当前工作目录实际试跑验证：无新变化时返回退出码 0 且标准输出为空（或退出码 10）；发现新变化时返回退出码 0 且输出变化摘要（或退出码 20）。",
		'3. 修复并试跑通过后，务必调用 `vecway_automation` 工具（`action: "propose"`' +
			(target.id ? `，并在 \`draft\` 中保留 \`id: "${target.id}"\`` : "") +
			"）提交修复后的配置，让我可以在确认卡片里预览并一键采用恢复运行。",
	].filter(Boolean);

	try {
		const info = await rpcStart({
			cwd: target.cwd?.trim() || ".",
			mode: target.mode,
			appendSystemPrompt: AUTOMATION_COMPOSER_SYSTEM_PROMPT,
		});
		await dispatchPrompt(info.sessionId, lines.join("\n"));
		toast.success(tNow("schedules.fixWithAiStarted"));
		useUi.getState().selectSession(info.sessionId);
	} catch (e) {
		toast.error(String(e));
	}
}

export type AutomationAssistFocus = "script" | "prompt" | "modify";

function isScheduleCadence(value: unknown): value is ScheduleCadence {
	if (!value || typeof value !== "object") return false;
	const kind = (value as { kind?: unknown }).kind;
	return kind === "interval" || kind === "daily" || kind === "once" || kind === "monthly";
}

function buildAssistPrefill(context: {
	name?: string;
	cwd: string;
	cadence?: ScheduleCadence | unknown;
	agentTrigger?: string;
	probeCommand?: string | null;
	prompt?: string;
	focus?: AutomationAssistFocus;
}): string {
	const cwdLabel = context.cwd?.trim() || ".";
	const cadenceText = isScheduleCadence(context.cadence)
		? formatCadence(context.cadence)
		: "";
	const cadencePart = cadenceText ? `（${cadenceText}）` : "";
	const existingPrompt = context.prompt?.trim() ?? "";

	if (context.focus === "modify") {
		const nameLabel = context.name?.trim() || "未命名自动化";
		return `我想修改自动化「${nameLabel}」：\n- 需要调整的内容：`;
	}

	if (context.focus === "script") {
		const existingScriptPart = context.probeCommand?.trim()
			? `\n- 当前已有脚本（请在此基础上完善）：\n\`\`\`sh\n${context.probeCommand.trim()}\n\`\`\``
			: "";
		return `请帮我编写并验证在「${cwdLabel}」下定时执行的本地脚本${cadencePart}：${existingScriptPart}\n- 监听什么变化 / 满足什么条件时才唤醒智能体：\n- 触发后希望智能体做什么：${existingPrompt}`;
	}

	if (context.focus === "prompt") {
		const triggerLabel =
			context.agentTrigger === "on_signal"
				? "先运行脚本，按结果调用智能体"
				: context.agentTrigger === "never"
					? "运行脚本并发送通知"
					: "到点直接运行智能体";
		const scriptPart =
			context.agentTrigger === "on_signal" && context.probeCommand?.trim()
				? `\n- 前置脚本：\n\`\`\`sh\n${context.probeCommand.trim()}\n\`\`\``
				: "";
		return `请帮我编写在「${cwdLabel}」下执行的自动化智能体指令${cadencePart}（触发方式：${triggerLabel}）：${scriptPart}\n- 希望智能体完成什么任务：${existingPrompt}\n- 期望输出格式 / 处理规范：`;
	}

	return `请帮我配置「${cwdLabel}」下的自动化任务${cadencePart}：\n- 希望实现的目标：${existingPrompt}`;
}

/** Open the full session Composer pre-seeded with current form/draft context so user never re-explains directory or cadence. */
export function openAutomationAiAssistChat(context: {
	id?: string;
	name?: string;
	cwd: string;
	mode?: SpaceMode;
	cadence?: unknown;
	agentTrigger?: string;
	probeDescription?: string | null;
	probeCommand?: string | null;
	prompt?: string;
	notify?: string;
	runMode?: string;
	focus?: AutomationAssistFocus;
}): void {
	const existingSummary = JSON.stringify(context, null, 2);
	const idNote = context.id
		? 'Existing automation being updated (keep its `id` in `vecway_automation` `action: "propose"` `draft`)'
		: "Current form context from Automations Config (preserve user's chosen cwd/cadence when relevant)";
	const systemPrompt = `${AUTOMATION_COMPOSER_SYSTEM_PROMPT}\n\n${idNote}:\n${existingSummary}`;
	const draftId = usePendingSession.getState().open({
		cwd: context.cwd?.trim() || ".",
		mode: context.mode,
		appendSystemPrompt: systemPrompt,
		automationMode: true,
	});
	const prefilledText = buildAssistPrefill(context);
	useComposer.getState().setDraft(draftId, prefilledText);
	useUi.setState({ selectedSessionId: null, centerView: "session" });
	useComposer.getState().focusComposer(draftId);
}

/** Open the full session Composer pre-seeded with an existing automation's context for conversational modification. */
export function openAutomationModifyChat(schedule: Schedule): void {
	openAutomationAiAssistChat({
		id: schedule.id,
		name: schedule.name,
		cwd: schedule.cwd,
		mode: schedule.mode,
		cadence: schedule.cadence,
		agentTrigger: schedule.agentTrigger,
		probeDescription: schedule.probeDescription,
		probeCommand: schedule.probeCommand,
		prompt: schedule.prompt,
		notify: schedule.notify,
		runMode: schedule.runMode,
		focus: "modify",
	});
}

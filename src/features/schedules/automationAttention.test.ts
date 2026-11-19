import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule, SessionMeta, Todo } from "../../lib/contracts";

const mocks = vi.hoisted(() => ({
	todoAct: vi.fn(async () => {}),
	markSessionSeen: vi.fn(async () => {}),
	markRunSeen: vi.fn(),
	todos: [] as Todo[],
	sessions: {} as Record<string, SessionMeta>,
	schedules: [] as Schedule[],
}));

vi.mock("../../lib/ensureLive", () => ({
	ensureLive: vi.fn(async () => ({ sessionId: "s1", sessionFile: "", pid: 1, cwd: "/tmp" })),
}));
vi.mock("../../lib/ipc", () => ({
	dispatchPrompt: vi.fn(async () => {}),
	rpcStart: vi.fn(async () => ({ sessionId: "new-s", sessionFile: "", pid: 1, cwd: "/tmp" })),
}));
vi.mock("../../lib/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../todos/store", () => ({
	startTodos: vi.fn(async () => {}),
	useTodos: {
		getState: () => ({
			todos: mocks.todos,
			act: mocks.todoAct,
		}),
	},
}));
vi.mock("../../stores/sessions", () => ({
	markSessionSeen: mocks.markSessionSeen,
	useSessions: {
		getState: () => ({ sessions: mocks.sessions }),
	},
}));
vi.mock("./schedulesStore", () => ({
	useSchedulesStore: {
		getState: () => ({
			schedules: mocks.schedules,
			runs: { s1: [{ id: "r1" }] },
			markRunSeen: mocks.markRunSeen,
			load: vi.fn(async () => {}),
		}),
	},
}));

import { useComposer } from "../../stores/composer";
import { usePendingSession } from "../sessions/pendingSession";
import {
	AUTOMATION_COMPOSER_SYSTEM_PROMPT,
	acknowledgeAutomationAttention,
	deriveAutomationAttention,
	openAutomationAiAssistChat,
	openAutomationModifyChat,
} from "./automationAttention";

function makeSchedule(id: string, extra: Partial<Schedule> = {}): Schedule {
	return {
		id,
		name: `Auto ${id}`,
		prompt: "do work",
		cwd: "/repo",
		mode: "code",
		runMode: "local",
		cadence: { kind: "daily", time: "09:00", weekdays: [] },
		model: null,
		thinking: null,
		approvalMode: "write",
		enabled: true,
		nextRunAt: null,
		lastRunAt: null,
		lastRunStatus: "ok",
		createdAt: "2026-11-17T00:00:00Z",
		updatedAt: "2026-11-17T00:00:00Z",
		endAt: null,
		lifecycle: "active",
		maxRuns: null,
		runsDone: 0,
		notify: "important",
		newChatEachRun: true,
		agentTrigger: "on_signal",
		lastRunPhase: null,
		lastRunSessionId: null,
		...extra,
	};
}

function makeTodo(id: string, scheduleId: string, payload: Record<string, unknown>, extra: Partial<Todo> = {}): Todo {
	return {
		id,
		kind: "schedule_run",
		source: "schedule",
		status: "open",
		sessionId: null,
		title: id,
		detail: "detail",
		payload: { scheduleId, ...payload },
		priority: 0,
		createdAt: "2026-11-17T00:00:00Z",
		updatedAt: "2026-11-17T00:00:00Z",
		...extra,
	};
}

function makeSession(id: string, attention: SessionMeta["attention"]): SessionMeta {
	return {
		id,
		tool: "omp",
		file: `/tmp/${id}.jsonl`,
		cwd: "/repo",
		title: id,
		label: id,
		createdAt: "2026-11-17T00:00:00Z",
		updatedAt: "2026-11-17T00:00:00Z",
		parentId: null,
		forkDepth: 0,
		status: attention === "awaiting" ? "awaiting_approval" : "idle",
		unread: attention === "unread",
		pending: null,
		live: false,
		externalPid: null,
		pinned: false,
		archived: false,
		workspaceId: null,
		repoRoot: null,
		git: null,
		result: null,
		lastAssistant: null,
		model: null,
		attention,
		mode: "code",
		groupId: null,
	};
}

describe("deriveAutomationAttention", () => {
	it("ranks awaiting > error > unread per schedule and computes highestTone", () => {
		const s1 = makeSchedule("s1", { lastRunSessionId: "sess-wait" });
		const s2 = makeSchedule("s2");
		const s3 = makeSchedule("s3", { lastRunPhase: "probe_quiet" });
		const s4 = makeSchedule("s4");

		const todos = [
			makeTodo("t1", "s1", { ok: false }),
			makeTodo("t2", "s2", { ok: false, probeError: true }),
			makeTodo("t3", "s4", { ok: true }),
		];
		const sessions = { "sess-wait": makeSession("sess-wait", "awaiting") };

		const summary = deriveAutomationAttention([s1, s2, s3, s4], todos, sessions);
		expect(summary.byScheduleId.s1?.tone).toBe("awaiting");
		expect(summary.byScheduleId.s2?.tone).toBe("error");
		expect(summary.byScheduleId.s2?.probeError).toBe(true);
		expect(summary.byScheduleId.s3).toBeUndefined();
		expect(summary.byScheduleId.s4?.tone).toBe("unread");
		expect(summary.totalCount).toBe(3);
		expect(summary.highestTone).toBe("error");
	});

	it("returns awaiting as highestTone when no errors exist", () => {
		const s1 = makeSchedule("s1");
		const todos = [makeTodo("t1", "s1", { ok: true, awaiting: true }, { sessionId: "sess-a" })];
		const summary = deriveAutomationAttention([s1], todos, {});
		expect(summary.byScheduleId.s1?.tone).toBe("awaiting");
		expect(summary.byScheduleId.s1?.sessionId).toBe("sess-a");
		expect(summary.highestTone).toBe("awaiting");
	});

	it("includes orphan schedule_run todos in totalCount", () => {
		const orphan = makeTodo("t-orphan", "missing-id", { ok: true });
		const summary = deriveAutomationAttention([], [orphan], {});
		expect(summary.totalCount).toBe(1);
		expect(summary.highestTone).toBe("unread");
	});
});

describe("acknowledgeAutomationAttention", () => {
	beforeEach(() => {
		mocks.todoAct.mockClear();
		mocks.markSessionSeen.mockClear();
		mocks.markRunSeen.mockClear();
	});

	it("marks open schedule todos done without dismissing awaiting session attention", async () => {
		mocks.schedules = [makeSchedule("s1", { lastRunSessionId: "sess-await" })];
		mocks.todos = [
			makeTodo("t1", "s1", { ok: false }),
			makeTodo("t2", "s1", { ok: true }, { status: "done" }),
		];
		mocks.sessions = { "sess-await": makeSession("sess-await", "awaiting") };

		await acknowledgeAutomationAttention("s1");
		expect(mocks.todoAct).toHaveBeenCalledTimes(1);
		expect(mocks.todoAct).toHaveBeenCalledWith("t1", "done");
		expect(mocks.markRunSeen).toHaveBeenCalledWith("r1");
		expect(mocks.markSessionSeen).not.toHaveBeenCalled();
	});

	it("marks unread linked session seen alongside todo acknowledgement", async () => {
		mocks.schedules = [makeSchedule("s1", { lastRunSessionId: "sess-unread" })];
		mocks.todos = [makeTodo("t1", "s1", { ok: true })];
		mocks.sessions = { "sess-unread": makeSession("sess-unread", "unread") };

		await acknowledgeAutomationAttention("s1");
		expect(mocks.todoAct).toHaveBeenCalledWith("t1", "done");
		expect(mocks.markSessionSeen).toHaveBeenCalledWith("sess-unread");
	});
});

describe("openAutomationAiAssistChat & tool prompt", () => {
	beforeEach(() => {
		usePendingSession.setState({ drafts: {}, selectedId: null });
		useComposer.setState({ drafts: {}, focusNonce: {} });
	});

	it("instructs LLM to use vecway_automation instead of legacy tool names", () => {
		expect(AUTOMATION_COMPOSER_SYSTEM_PROMPT).toContain("vecway_automation");
		expect(AUTOMATION_COMPOSER_SYSTEM_PROMPT).toContain("stage_script");
		expect(AUTOMATION_COMPOSER_SYSTEM_PROMPT).toContain("propose");
		expect(AUTOMATION_COMPOSER_SYSTEM_PROMPT).not.toContain("stage_automation_script");
		expect(AUTOMATION_COMPOSER_SYSTEM_PROMPT).not.toContain("propose_automation");
	});

	it("prefills composer draft for script focus with directory, cadence, and existing command", () => {
		openAutomationAiAssistChat({
			cwd: "/tmp/my-app",
			cadence: { kind: "interval", minutes: 30 },
			agentTrigger: "on_signal",
			probeCommand: "git status --porcelain",
			prompt: "总结未提交改动",
			focus: "script",
		});

		const draftId = usePendingSession.getState().selectedId!;
		expect(draftId).toBeTruthy();
		const prefill = useComposer.getState().drafts[draftId];
		expect(prefill).toBeTruthy();
		expect(prefill).toContain("/tmp/my-app");
		expect(prefill).toContain("30");
		expect(prefill).toContain("git status --porcelain");
		expect(prefill).toContain("总结未提交改动");
		expect(useComposer.getState().focusNonce[draftId]).toBeGreaterThan(0);
	});

	it("prefills composer draft for prompt focus with directory, cadence, and trigger mode", () => {
		openAutomationAiAssistChat({
			cwd: "/tmp/my-app",
			cadence: { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
			agentTrigger: "always",
			prompt: "输出昨日提交简报",
			focus: "prompt",
		});

		const draftId = usePendingSession.getState().selectedId!;
		expect(draftId).toBeTruthy();
		const prefill = useComposer.getState().drafts[draftId];
		expect(prefill).toBeTruthy();
		expect(prefill).toContain("/tmp/my-app");
		expect(prefill).toContain("09:00");
		expect(prefill).toContain("到点直接运行智能体");
		expect(prefill).toContain("输出昨日提交简报");
	});

	it("prefills composer draft for modify focus via openAutomationModifyChat", () => {
		openAutomationModifyChat(makeSchedule("s1", { name: "每日巡检" }));

		const draftId = usePendingSession.getState().selectedId!;
		const prefill = useComposer.getState().drafts[draftId];
		expect(prefill).toContain("我想修改自动化「每日巡检」");
		expect(prefill).toContain("需要调整的内容");
	});
});

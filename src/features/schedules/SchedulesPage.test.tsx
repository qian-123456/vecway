// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule, ScheduleRun } from "../../lib/contracts";

const ipcMocks = vi.hoisted(() => ({
	listSchedules: vi.fn<() => Promise<Schedule[]>>(),
	listScheduleRuns: vi.fn<() => Promise<ScheduleRun[]>>(),
	listReleasableScheduleRuns: vi.fn<() => Promise<ScheduleRun[]>>().mockResolvedValue([]),
	releaseAwaitingScheduleRun: vi.fn(),
	resumeAwaitingScheduleRun: vi.fn(),
	confirmDialog: vi.fn(),
	saveSchedule: vi.fn(),
	setScheduleEnabled: vi.fn(),
	runScheduleNow: vi.fn(),
	deleteSchedule: vi.fn(),
	testScheduleProbe: vi.fn(),
	generateScheduleDraft: vi.fn(),
	gitRepoRoot: vi.fn().mockResolvedValue("/tmp/repo"),
	gitListWorktrees: vi.fn().mockResolvedValue([]),
	gitDiffBase: vi.fn().mockResolvedValue(""),
	gitDiff: vi.fn().mockResolvedValue(""),
	gitCommit: vi.fn().mockResolvedValue(""),
	gitMergeBranch: vi.fn().mockResolvedValue(""),
	gitRemoveWorktree: vi.fn().mockResolvedValue(undefined),
	listTodos: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn().mockResolvedValue(null),
}));

vi.mock("../chat/Composer", () => ({
	Composer: ({
		sessionId,
		placeholder,
	}: {
		sessionId: string;
		placeholder?: string;
	}) => (
		<div data-testid="real-composer" data-session-id={sessionId}>
			{placeholder}
		</div>
	),
}));

vi.mock("../chat/PromptComposer", () => ({
	PromptComposer: ({
		id,
		placeholder,
		runMode,
		promptValue,
		onChangePrompt,
		earRightAction,
		trailingControls,
	}: {
		id?: string;
		placeholder?: string;
		runMode?: "local" | "worktree";
		promptValue?: string;
		onChangePrompt?: (v: string) => void;
		earRightAction?: React.ReactNode;
		trailingControls?: React.ReactNode;
	}) => (
		<div data-testid="prompt-composer" data-composer-id={id}>
			<span>{runMode}</span>
			{earRightAction}
			<textarea
				aria-label="prompt"
				placeholder={placeholder}
				value={promptValue ?? ""}
				onChange={(e) => onChangePrompt?.(e.target.value)}
			/>
			{trailingControls}
		</div>
	),
}));

vi.mock("../../lib/events", () => ({
	onSchedulesChanged: vi.fn().mockResolvedValue(() => {}),
	onTodosChanged: vi.fn().mockResolvedValue(() => {}),
}));


vi.mock("../../lib/dialogs", async (importOriginal) => ({
	...await importOriginal<typeof import("../../lib/dialogs")>(),
	confirmDialog: ipcMocks.confirmDialog,
}));
vi.mock("../../lib/ipc", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/ipc")>();
	return {
		...actual,
		...ipcMocks,
	};
});

vi.mock("../settings/store", () => ({
	useSettings: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
			settings: { automationBackgroundEnabled: true },
			load: vi.fn(),
			update: vi.fn(),
		}),
}));

vi.mock("../../stores/modelCatalog", () => ({
	useModelCatalog: Object.assign(
		(selector: (s: { status: string; unavailable: never[] }) => unknown) =>
			selector({ status: "ok", unavailable: [] }),
		{
			getState: () => ({ refresh: vi.fn() }),
		},
	),
	useModelOptions: () => [],
}));

import { useComposer } from "../../stores/composer";
import { useSessions } from "../../stores/sessions";
import { useToasts } from "../../lib/toast";
import { useLive } from "../../stores/live";
import { useUi } from "../../stores/ui";
import { usePendingSession } from "../sessions/pendingSession";
import { AUTOMATION_COMPOSER_SYSTEM_PROMPT } from "./automationAttention";
import { SchedulesPage } from "./SchedulesPage";
import { AutomationOverviewTab } from "./AutomationOverviewTab";
import { useSchedulesStore } from "./schedulesStore";

const sampleSchedule: Schedule = {
	id: "sched-1",
	name: "盯紧线上错误日志",
	prompt: "分析新增错误并给出修复建议",
	cwd: "/tmp/repo",
	mode: "code",
	runMode: "worktree",
	cadence: { kind: "interval", minutes: 30 },
	notify: "important",
	newChatEachRun: true,
	model: null,
	thinking: null,
	approvalMode: "write",
	enabled: true,
	endAt: null,
	maxRuns: null,
	runsDone: 2,
	lifecycle: "active",
	lastRunAt: "2026-11-17T18:00:00Z",
	lastRunStatus: "ok",
	lastRunPhase: "probe_quiet",
	lastRunSessionId: null,
	probeCommand: "bash '/tmp/check.sh'",
	probeDescription: "监听最近是否有新增 ERROR",
	agentTrigger: "on_signal",
	nextRunAt: "2026-11-17T20:00:00Z",
	createdAt: "2026-11-17T10:00:00Z",
	updatedAt: "2026-11-17T18:00:00Z",
};

beforeEach(() => {
	vi.clearAllMocks();
	ipcMocks.listReleasableScheduleRuns.mockReset().mockResolvedValue([]);
	ipcMocks.releaseAwaitingScheduleRun.mockReset().mockResolvedValue(undefined);
	ipcMocks.resumeAwaitingScheduleRun.mockReset().mockResolvedValue(undefined);
	useToasts.setState({ items: [] });
	useLive.setState({ sessions: {} });
	ipcMocks.confirmDialog.mockReset();
	usePendingSession.setState({ drafts: {}, selectedId: null });
	useUi.setState({ centerView: "schedules", selectedSessionId: null });
	useSessions.setState({
		hasLoaded: true,
		loadError: null,
		workspaces: [],
		sessions: {},
	});
	useSchedulesStore.setState({
		schedules: [],
		runs: {},
		loading: false,
		loadError: null,
		runningScheduleIds: {},
		seenRuns: {},
		selectedScheduleId: null,
		workspaceTab: "overview",
		isCreating: false,
		isEditorOpen: false,
		editingSchedule: null,
		draftTemplate: null,
		editorTab: "settings",
	});
});

afterEach(() => {
	cleanup();
});

describe("SchedulesPage 2-column Home & Unified 2-Tab Workspace", () => {
	it("shows clean empty state without forced Composer or preset templates, and gates AI chat composer behind folder selection", async () => {
		ipcMocks.listSchedules.mockResolvedValue([]);
		render(<SchedulesPage />);

		expect(await screen.findByText("暂无自动化")).toBeTruthy();
		expect(screen.queryByTestId("real-composer")).toBeNull();
		expect(screen.queryByText(/每天早上总结昨天的提交/)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /在对话中让 AI 生成/ }));
		expect(
			await screen.findByRole("button", { name: /选择项目目录/ }),
		).toBeTruthy();

		// Pinned header switcher stays the exact same DOM node across chat <-> manual toggles.
		const switcherGroup = screen.getByRole("radiogroup", { name: "创建方式" });
		fireEvent.click(screen.getByRole("radio", { name: "手动配置" }));
		expect(await screen.findByText("选择工作方式")).toBeTruthy();
		expect(screen.getByRole("radiogroup", { name: "创建方式" })).toBe(switcherGroup);

		fireEvent.click(screen.getByRole("radio", { name: "对话生成" }));
		expect(
			await screen.findByRole("button", { name: /选择项目目录/ }),
		).toBeTruthy();
		expect(screen.getByRole("radiogroup", { name: "创建方式" })).toBe(switcherGroup);

		act(() => {
			useSchedulesStore.getState().leaveSubpage();
		});
		expect(await screen.findByText("暂无自动化")).toBeTruthy();
	});

	it("does not offer a per-automation overlap policy in the create form", async () => {
		ipcMocks.listSchedules.mockResolvedValue([]);
		render(<SchedulesPage />);
		fireEvent.click(await screen.findByRole("button", { name: /手动配置任务/ }));
		expect(screen.getByText("选择工作方式")).toBeTruthy();
		expect(screen.queryByLabelText("运行重合策略")).toBeNull();
		expect(screen.queryByText("运行重合策略")).toBeNull();

		const directRadio = screen.getByRole("radio", { name: /到点直接运行智能体/ });
		expect(directRadio.getAttribute("aria-checked")).toBe("true");
		expect(screen.queryByText("第一步 · 运行脚本")).toBeNull();

		fireEvent.click(screen.getByRole("radio", { name: /先运行脚本，按结果调用智能体/ }));
		expect(screen.getByText("第一步 · 运行脚本")).toBeTruthy();
		expect(screen.queryByPlaceholderText(/一句话说明/)).toBeNull();
	});

	it("opens AI studio cleanly without forced draft text and lets starter chips fill the prompt", async () => {
		ipcMocks.listSchedules.mockResolvedValue([]);
		useComposer.setState({ drafts: {}, focusNonce: {} });
		useSessions.setState({
			hasLoaded: true,
			loadError: null,
			workspaces: [
				{
					id: "ws-1",
					name: "omp-workspace",
					path: "/tmp/repo",
					kind: "project",
					sort: 0,
					mode: "code",
				},
			],
			sessions: {},
		});

		render(<SchedulesPage />);
		fireEvent.click(await screen.findByRole("button", { name: /在对话中让 AI 生成/ }));
		expect(await screen.findByTestId("real-composer")).toBeTruthy();

		const draftId = usePendingSession.getState().selectedId ?? "";
		expect(usePendingSession.getState().drafts[draftId]?.opts.automationMode).toBe(true);
		expect(useComposer.getState().drafts[draftId] ?? "").toBe("");
		expect(useComposer.getState().focusNonce[draftId]).toBeGreaterThan(0);

		const dailyChip = screen.getByRole("button", { name: "每天总结代码提交" });
		expect(screen.getByRole("button", { name: "监听报错再分析" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "定时跑本地脚本" })).toBeTruthy();

		fireEvent.click(dailyChip);
		expect(useComposer.getState().drafts[draftId]).toContain("git");
	});

	it("shows edit title and save button when customizing an existing automation draft", async () => {
		ipcMocks.listSchedules.mockResolvedValue([]);
		useSchedulesStore.getState().openCreate({
			id: sampleSchedule.id,
			name: sampleSchedule.name,
			prompt: sampleSchedule.prompt,
			cwd: sampleSchedule.cwd,
			cadence: sampleSchedule.cadence,
			agentTrigger: sampleSchedule.agentTrigger,
			probeCommand: sampleSchedule.probeCommand,
		});

		render(<SchedulesPage />);
		expect(await screen.findByRole("heading", { name: "编辑自动化" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /保存更改/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /创建自动化/ })).toBeNull();
	});

	it("opens config studio on New Automation, mounts PromptComposer when workspace exists, and jumps with context preserved", async () => {
		ipcMocks.listSchedules.mockResolvedValue([]);
		useSessions.setState({
			hasLoaded: true,
			loadError: null,
			workspaces: [
				{
					id: "ws-1",
					name: "omp-workspace",
					path: "/tmp/repo",
					kind: "project",
					sort: 0,
					mode: "code",
				},
			],
			sessions: {},
		});

		render(<SchedulesPage />);
		fireEvent.click(await screen.findByRole("button", { name: /手动配置任务/ }));

		expect(screen.getByText("选择工作方式")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: /带当前配置去对话让 AI 帮写/ }),
		);

		expect(useUi.getState().centerView).toBe("session");
		const draftId = usePendingSession.getState().selectedId ?? "";
		expect(draftId.startsWith("local-draft:")).toBe(true);
		expect(
			usePendingSession.getState().drafts[draftId]?.opts.appendSystemPrompt,
		).toContain(AUTOMATION_COMPOSER_SYSTEM_PROMPT);
		expect(
			usePendingSession.getState().drafts[draftId]?.opts.appendSystemPrompt,
		).toContain("/tmp/repo");
	});

	it("renders single-canvas Home list with Status-vs-Action separation and opens unified 2-tab Workspace", async () => {
		const errorSchedule: Schedule = {
			...sampleSchedule,
			lastRunStatus: "error",
			lastRunPhase: "probe_only",
		};
		ipcMocks.listSchedules.mockResolvedValue([errorSchedule]);
		ipcMocks.listScheduleRuns.mockResolvedValue([
			{
				id: "r-err",
				scheduleId: "sched-1",
				sessionId: null,
				startedAt: "2026-11-17T18:30:00Z",
				finishedAt: "2026-11-17T18:30:01Z",
				status: "error",
				phase: "probe_only",
				probeOutput: "zsh: command not found: pnpm",
				summary: "前置脚本执行失败",
			},
			{
				id: "r-2",
				scheduleId: "sched-1",
				sessionId: null,
				startedAt: "2026-11-17T18:00:00Z",
				finishedAt: "2026-11-17T18:00:01Z",
				status: "ok",
				phase: "probe_quiet",
				probeOutput: "",
				summary: null,
			},
			{
				id: "r-1",
				scheduleId: "sched-1",
				sessionId: null,
				startedAt: "2026-11-17T17:30:00Z",
				finishedAt: "2026-11-17T17:30:01Z",
				status: "ok",
				phase: "probe_quiet",
				probeOutput: "",
				summary: null,
			},
		]);

		render(<SchedulesPage />);

		expect(await screen.findByText("已中止 · 脚本报错")).toBeTruthy();
		const inspectBtn = screen.getByRole("button", {
			name: /查看报错与修复方案/,
		});
		fireEvent.click(inspectBtn);

		expect(await screen.findByRole("tab", { name: "概览与记录" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "规则配置" })).toBeTruthy();
		expect(
			await screen.findByText(/本地脚本执行报错，已安全中止/),
		).toBeTruthy();
		expect(await screen.findByText(/已折叠 2 次无新变化运行/)).toBeTruthy();
		expect(screen.getByText(/zsh: command not found: pnpm/)).toBeTruthy();

		fireEvent.click(screen.getByRole("tab", { name: "规则配置" }));
		expect(
			screen.getByRole("button", { name: /保存更改/ }),
		).toBeTruthy();
		expect(screen.queryByLabelText("运行重合策略")).toBeNull();
		expect(screen.queryByText("运行重合策略")).toBeNull();

		act(() => {
			useSchedulesStore.getState().leaveSubpage();
		});
		expect(await screen.findByText("关闭 Vecway 后继续运行")).toBeTruthy();
	});

	it("requires explicit confirmation before releasing an unpaged awaiting run", async () => {
		const waiting: ScheduleRun = {
			id: "old-wait", scheduleId: "sched-1", sessionId: "session-1",
			startedAt: "2026-11-17T17:00:00Z", finishedAt: "2026-11-17T17:01:00Z",
			status: "ok", phase: "awaiting", summary: null,
		};
		ipcMocks.listScheduleRuns.mockResolvedValue([]);
		ipcMocks.listSchedules.mockResolvedValue([sampleSchedule]);
		ipcMocks.listReleasableScheduleRuns.mockResolvedValue([
			waiting,
			{ ...waiting, id: "active", status: "running" },
			{ ...waiting, id: "other", phase: "agent" },
		]);
		ipcMocks.confirmDialog.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		ipcMocks.releaseAwaitingScheduleRun.mockImplementation(async () => {
			ipcMocks.listReleasableScheduleRuns.mockResolvedValue([]);
		});
		render(<AutomationOverviewTab schedule={{ ...sampleSchedule, runMode: "local" }} attention={null} onSwitchToConfig={() => {}} />);

		const button = await screen.findByRole("button", { name: "解除等待并继续排队" });
		expect(screen.getAllByRole("button", { name: "解除等待并继续排队" })).toHaveLength(1);
		fireEvent.click(button);
		await waitFor(() => expect(ipcMocks.confirmDialog).toHaveBeenCalledTimes(1));
		expect(ipcMocks.confirmDialog.mock.calls[0][0]).toContain("原会话不会停止");
		expect(ipcMocks.releaseAwaitingScheduleRun).not.toHaveBeenCalled();
		await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(button);
		await waitFor(() => expect(ipcMocks.releaseAwaitingScheduleRun).toHaveBeenCalledWith("sched-1", "old-wait"));
		await waitFor(() => expect(screen.queryByRole("button", { name: "解除等待并继续排队" })).toBeNull());
		expect(ipcMocks.listScheduleRuns).toHaveBeenCalled();
		expect(ipcMocks.listSchedules).toHaveBeenCalled();
	});

	it("resumes the identified unpaged waiting run and refreshes schedule data", async () => {
		const waiting: ScheduleRun = {
			id: "old-wait", scheduleId: "sched-1", sessionId: "session-1",
			startedAt: "2026-11-17T17:00:00Z", finishedAt: "2026-11-17T17:01:00Z",
			status: "ok", phase: "awaiting", summary: null,
		};
		ipcMocks.listScheduleRuns.mockResolvedValue([]);
		ipcMocks.listSchedules.mockResolvedValue([sampleSchedule]);
		ipcMocks.listReleasableScheduleRuns.mockResolvedValue([waiting]);
		const loadSessions = vi.spyOn(useSessions.getState(), "load").mockResolvedValue();
		render(<AutomationOverviewTab schedule={{ ...sampleSchedule, runMode: "local" }} attention={null} onSwitchToConfig={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: "继续处理" }));
		await waitFor(() => expect(ipcMocks.resumeAwaitingScheduleRun).toHaveBeenCalledWith("sched-1", "old-wait"));
		await waitFor(() => expect(loadSessions).toHaveBeenCalled());
		expect(ipcMocks.listScheduleRuns).toHaveBeenCalled();
		expect(ipcMocks.listSchedules).toHaveBeenCalled();
		loadSessions.mockRestore();
	});

	it("shows the actual resume error without releasing the waiting run", async () => {
		const waiting: ScheduleRun = {
			id: "old-wait", scheduleId: "sched-1", sessionId: "session-1",
			startedAt: "2026-11-17T17:00:00Z", finishedAt: "2026-11-17T17:01:00Z",
			status: "ok", phase: "awaiting", summary: null,
		};
		ipcMocks.listScheduleRuns.mockResolvedValue([]);
		ipcMocks.listReleasableScheduleRuns.mockResolvedValue([waiting]);
		ipcMocks.resumeAwaitingScheduleRun.mockRejectedValue("resume failed");
		render(<AutomationOverviewTab schedule={{ ...sampleSchedule, runMode: "local" }} attention={null} onSwitchToConfig={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: "继续处理" }));
		await waitFor(() => expect(useToasts.getState().items.some((item) => item.text.includes("resume failed"))).toBe(true));
		expect(ipcMocks.releaseAwaitingScheduleRun).not.toHaveBeenCalled();
	});
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../../core/api";
import { events } from "../../core/sse";
import { useMobileSchedules } from "../../core/stores/schedules";
import * as uiModule from "../../ui";
import { AutomationOverviewView } from "./AutomationOverviewView";
import type { AutomationWorktreeState, Schedule, ScheduleRun } from "./schedule";

vi.mock("../../core/nav", () => ({
	nav: { back: vi.fn(), push: vi.fn(), pushLayer: () => () => {} },
	paths: { chat: (id: string) => `/s/${id}` },
}));
vi.mock("../../ui", async (orig) => ({
	...(await orig<typeof uiModule>()),
	confirm: vi.fn(async () => true),
	toast: vi.fn(),
}));

const sampleSchedule: Schedule = {
	id: "sched-1",
	name: "巡检任务",
	prompt: "分析告警",
	cwd: "/repo",
	mode: "code",
	runMode: "worktree",
	cadence: { kind: "interval", minutes: 30 },
	model: null,
	thinking: null,
	approvalMode: null,
	enabled: true,
	nextRunAt: null,
	lastRunAt: "2026-11-24T10:00:00Z",
	lastRunStatus: "error",
	lastRunPhase: "probe_only",
	notify: "important",
	newChatEachRun: true,
	endAt: null,
	lifecycle: "active",
	maxRuns: null,
	runsDone: 1,
	probeCommand: "exit 1",
	probeDescription: "检查脚本",
	agentTrigger: "on_signal",
	resultMode: "structured",
};

const sampleWorktree: AutomationWorktreeState = {
	repoRoot: "/repo",
	worktreePath: "/repo/.worktrees/sched-1",
	branch: "omp/sched-1",
	ahead: 1,
	dirty: 0,
	committedDiff: "+ok",
	uncommittedDiff: "",
	combinedDiff: "+ok",
	addedLines: 1,
	removedLines: 0,
	runId: "run-wt-1",
	sessionId: "sess-1",
};

describe("AutomationOverviewView & schedules store fixes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useMobileSchedules.setState({
			schedules: [],
			loaded: false,
			loading: false,
			error: null,
			detailVersion: 0,
			runsById: {},
			awaitingById: {},
			worktreeById: {},
			seenRuns: {},
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("passes target metadata on mergeWorktree/discardWorktree and disables buttons while a run is running", async () => {
		let currentRuns: ScheduleRun[] = [
			{
				id: "run-active",
				scheduleId: "sched-1",
				sessionId: "sess-1",
				status: "running",
				phase: "agent",
				startedAt: "2026-11-24T10:00:00Z",
				finishedAt: null,
				summary: null,
			},
		];
		const apiSpy = vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "GET" && path.includes("/runs?")) return currentRuns;
			if (method === "GET" && path.endsWith("/awaiting")) return [];
			if (method === "GET" && path.endsWith("/worktree")) return sampleWorktree;
			if (method === "GET" && path === "/left/schedules") return [sampleSchedule];
			return {};
		});

		render(<AutomationOverviewView id="sched-1" schedule={sampleSchedule} />);

		const mergeBtn = (await screen.findByRole("button", { name: /合并并清理工作树/ })) as HTMLButtonElement;
		const discardBtn = screen.getByRole("button", { name: /丢弃改动/ }) as HTMLButtonElement;
		expect(mergeBtn.disabled).toBe(true);
		expect(discardBtn.disabled).toBe(true);
		expect(screen.getByText("任务正在运行，完成后可操作")).toBeTruthy();

		// Finish run -> SSE schedules event triggers automatic refresh and enables actions
		currentRuns = [
			{
				id: "run-done",
				scheduleId: "sched-1",
				sessionId: "sess-1",
				status: "error",
				phase: "probe_only",
				startedAt: "2026-11-24T10:00:00Z",
				finishedAt: "2026-11-24T10:00:05Z",
				summary: "exit 1",
			},
		];
		act(() => {
			events.emit("schedules", {});
		});

		await waitFor(() => expect(mergeBtn.disabled).toBe(false));
		expect(discardBtn.disabled).toBe(false);
		expect(screen.getByText("脚本报错")).toBeTruthy();

		fireEvent.click(mergeBtn);
		await waitFor(() =>
			expect(apiSpy).toHaveBeenCalledWith("POST", "/left/schedules/sched-1/worktree/merge", {
				runId: "run-wt-1",
				branch: "omp/sched-1",
				worktreePath: "/repo/.worktrees/sched-1",
			}),
		);
	});

	it("passes preview: true on repair generateDraft and explicit long timeouts on testProbe/generateDraft", async () => {
		const apiSpy = vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "POST" && path === "/left/schedules/generate-draft") {
				return {
					scheduleId: "sched-1",
					name: "巡检任务",
					cadence: { kind: "interval", minutes: 30 },
					agentTrigger: "on_signal",
					probeDescription: "fixed",
					probeCommand: "echo ok",
					prompt: "分析告警",
					notify: "important",
					explanation: "已修复退出码",
				};
			}
			if (method === "POST" && path === "/left/schedules/probe-test") {
				return { exitCode: 0, timedOut: false, durationMs: 12, output: "ok", outcome: "signal" };
			}
			if (method === "GET" && path.includes("/runs?")) {
				return [
					{
						id: "r1",
						scheduleId: "sched-1",
						sessionId: null,
						status: "error",
						phase: "probe_only",
						startedAt: "2026-11-24T10:00:00Z",
						finishedAt: "2026-11-24T10:00:02Z",
						summary: "failed",
					},
				];
			}
			if (method === "GET" && path.endsWith("/awaiting")) return [];
			if (method === "GET" && path.endsWith("/worktree")) return null;
			return [sampleSchedule];
		});

		render(<AutomationOverviewView id="sched-1" schedule={sampleSchedule} />);
		fireEvent.click(await screen.findByRole("button", { name: /AI 生成修复方案/ }));

		await waitFor(() =>
			expect(apiSpy).toHaveBeenCalledWith(
				"POST",
				"/left/schedules/generate-draft",
				expect.objectContaining({ preview: true, cwd: "/repo" }),
				{ timeoutMs: 110_000 },
			),
		);

		fireEvent.click(await screen.findByRole("button", { name: /就地试跑/ }));
		await waitFor(() =>
			expect(apiSpy).toHaveBeenCalledWith(
				"POST",
				"/left/schedules/probe-test",
				expect.objectContaining({ probeCommand: "echo ok" }),
				{ timeoutMs: 45_000 },
			),
		);
	});

	it("refreshes awaitingById on SSE schedules event without unhandled rejections", async () => {
		const awaitingRun: ScheduleRun = {
			id: "await-1",
			scheduleId: "sched-1",
			sessionId: "sess-1",
			status: "running",
			phase: "awaiting",
			startedAt: "2026-11-24T10:00:00Z",
			finishedAt: null,
			summary: "等待人工确认",
		};
		let phase = 1;
		vi.spyOn(apiModule, "api").mockImplementation(async (_m, path) => {
			if (path === "/left/schedules") return [sampleSchedule];
			if (path === "/left/schedules/sched-1/worktree") return null;
			if (path === "/left/schedules/sched-1/awaiting") return phase === 1 ? [] : [awaitingRun];
			return [];
		});

		await useMobileSchedules.getState().loadSchedules();
		await waitFor(() => expect(useMobileSchedules.getState().awaitingById["sched-1"]).toEqual([]));

		phase = 2;
		act(() => {
			events.emit("schedules", {});
		});
		await waitFor(() =>
			expect(useMobileSchedules.getState().awaitingById["sched-1"]).toHaveLength(1),
		);
	});
});

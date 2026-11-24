// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nav } from "../../../core/nav";
import { useMobileSchedules } from "../../../core/stores/schedules";
import { useRightDrawer } from "../../panels/rightDrawerStore";
import {
	createAutomationDraftAutoOpenTracker,
	getCachedProbeResult,
	parseAutomationSessionState,
	takeManualScheduleDraft,
	type AutomationDraftStatus,
} from "./automationStatus";
import { AutomationDraftCard } from "./AutomationDraftCard";
import {
	AutomationTurnCard,
	extractAutomationProposeCalls,
	matchAutomationDraft,
} from "./AutomationTurnCard";

vi.mock("../../../core/nav", () => ({
	nav: { push: vi.fn(), back: vi.fn(), pushLayer: () => () => {} },
	paths: { schedule: (id: string) => `/schedules/${id}`, scheduleNew: () => "/schedules/new" },
}));

describe("mobile automation draft parsing, turn card & probe caching", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useRightDrawer.setState({
			open: false,
			openSeq: 0,
			sessionId: null,
			tabBySession: {},
			visitedBySession: {},
			pendingMain: null,
			focusedAutomationDraft: null,
		});
		useMobileSchedules.setState({ schedules: [], loaded: true });
	});
	afterEach(cleanup);

	it("parses ompws-automation status JSON and matches propose calls by draftId", () => {
		const parsed = parseAutomationSessionState(
			JSON.stringify({
				mode: "active",
				drafts: [
					{
						draftId: "d-1",
						status: "pending",
						summary: "每小时检查构建状态",
						draft: {
							name: "构建巡检",
							prompt: "发现失败则分析原因",
							cwd: "/repo",
							runMode: "local",
							cadence: { kind: "interval", minutes: 60 },
							probeCommand: "python3 check.py",
							agentTrigger: "on_signal",
						},
					},
				],
			}),
		);
		expect(parsed?.mode).toBe("active");
		expect(parsed?.drafts).toHaveLength(1);
		expect(parsed?.drafts[0].summary).toBe("每小时检查构建状态");

		const calls = extractAutomationProposeCalls([
			{
				id: "tc-1",
				name: "vecway_automation",
				args: { action: "propose", draft: { name: "构建巡检" } },
				status: "done",
				result: "ok",
				details: { action: "propose", draftId: "d-1" },
			},
		]);
		expect(calls).toHaveLength(1);
		expect(matchAutomationDraft(calls[0], parsed)?.draftId).toBe("d-1");

		render(<AutomationTurnCard sessionId="s-1" calls={calls} automationState={parsed} />);
		fireEvent.click(screen.getByRole("button", { name: /构建巡检/ }));
		expect(useRightDrawer.getState().open).toBe(true);
		expect(useRightDrawer.getState().tabBySession["s-1"]).toBe("automation");
		expect(useRightDrawer.getState().focusedAutomationDraft?.draftId).toBe("d-1");
	});

	it("caches probe test results across remounts and quotes sections back to main composer", async () => {
		const testProbe = vi.fn(async () => ({
			exitCode: 0,
			timedOut: false,
			output: "ALERT: disk 92%",
			durationMs: 42,
			outcome: "signal" as const,
		}));
		useMobileSchedules.setState({ testProbe } as never);

		const item: AutomationDraftStatus = {
			draftId: "d-cache-1",
			status: "pending",
			summary: "检查磁盘剩余空间并在超过 90% 时通知",
			draft: {
				name: "磁盘监控",
				prompt: "汇报磁盘占用最高的目录",
				cwd: "/repo",
				runMode: "local",
				cadence: { kind: "interval", minutes: 30 },
				probeCommand: "df -h",
				agentTrigger: "on_signal",
			},
		};
		const onResolve = vi.fn(async () => {});

		const view = render(<AutomationDraftCard sessionId="s-cache" item={item} onResolve={onResolve} />);
		fireEvent.click(screen.getByRole("button", { name: /试跑脚本/ }));
		await screen.findByText(/ALERT: disk 92%/);
		expect(testProbe).toHaveBeenCalledTimes(1);
		expect(getCachedProbeResult("s-cache", "d-cache-1")?.output).toBe("ALERT: disk 92%");

		// Unmount & remount: cached probe result shows immediately without re-running probe
		view.unmount();
		render(<AutomationDraftCard sessionId="s-cache" item={item} onResolve={onResolve} />);
		expect(screen.getByText(/ALERT: disk 92%/)).toBeTruthy();

		// Quick quote sends section to main composer via rightDrawerStore
		fireEvent.click(screen.getByRole("button", { name: /引用并调整/ }));
		const pendingMain = useRightDrawer.getState().pendingMain;
		expect(pendingMain?.sessionId).toBe("s-cache");
		expect(pendingMain?.payload.quote).toContain("检查磁盘剩余空间");
	});

	it("stages empty-quote prompt templates cleanly without emitting bare markdown blockquote markers", async () => {
		const { ChatController } = await import("../chatStore");
		const ctrl = new ChatController("s-stage-1");
		let composerValue = "已有草稿";
		ctrl.composer = {
			get: () => composerValue,
			set: (next: string) => {
				composerValue = next;
			},
			clear: () => {
				composerValue = "";
			},
			focus: vi.fn(),
		};
		ctrl.stageAnnotation("", "请对「磁盘监控」做模拟测试。");
		expect(composerValue).toBe("已有草稿\n\n请对「磁盘监控」做模拟测试。");
		expect(composerValue).not.toContain("> ");
		ctrl.dispose();
	});

	it("does not auto-open drawer on initial hydration, opens once on newly arriving pending draft, and does not re-pop after manual close", () => {
		const tracker = createAutomationDraftAutoOpenTracker();
		const makeDraft = (draftId: string): AutomationDraftStatus => ({
			draftId,
			status: "pending",
			draft: {
				name: `任务 ${draftId}`,
				prompt: "检查",
				cwd: "/repo",
				runMode: "local",
				cadence: { kind: "interval", minutes: 10 },
			},
		});

		// Before hydration: never opens
		expect(tracker.next(false, { mode: "active", drafts: [makeDraft("d-pre")] })).toBeNull();
		// First hydrated snapshot seeds baseline without opening (reconnect/mount safety)
		expect(tracker.next(true, { mode: "active", drafts: [makeDraft("d-existing")] })).toBeNull();
		// Brand-new pending draft arrives -> returns newest draftId to open right drawer
		const nextId = tracker.next(true, { mode: "active", drafts: [makeDraft("d-existing"), makeDraft("d-new")] });
		expect(nextId).toBe("d-new");
		useRightDrawer.getState().openAutomationDraft("s-auto", nextId!);
		expect(useRightDrawer.getState().open).toBe(true);
		expect(useRightDrawer.getState().tabBySession["s-auto"]).toBe("automation");
		expect(useRightDrawer.getState().focusedAutomationDraft?.draftId).toBe("d-new");

		// User closes drawer -> subsequent streaming updates carrying the same draftId must NOT re-open
		useRightDrawer.getState().closeDrawer();
		expect(tracker.next(true, { mode: "active", drafts: [makeDraft("d-existing"), makeDraft("d-new")] })).toBeNull();
		expect(useRightDrawer.getState().open).toBe(false);

		// Reconnect snapshot with a newer unseen pending draftId must baseline without auto-opening
		expect(
			tracker.next(true, { mode: "active", drafts: [makeDraft("d-existing"), makeDraft("d-new"), makeDraft("d-reconn")] }, "snapshot"),
		).toBeNull();
		expect(
			tracker.next(true, { mode: "active", drafts: [makeDraft("d-existing"), makeDraft("d-new"), makeDraft("d-reconn")] }, "live"),
		).toBeNull();
	});

	it("preserves all optional draft fields, records presentFields, and merges updates losslessly without overwriting non-proposed fields", async () => {
		const parsed = parseAutomationSessionState({
			mode: "active",
			drafts: [
				{
					draftId: "d-upd",
					status: "pending",
					draft: {
						id: "sched-existing",
						name: "晨报更新",
						prompt: "新提示词",
						cwd: "/repo",
						runMode: "local",
						cadence: { kind: "daily", time: "10:00", weekdays: [1, 5], every: 2 },
					},
				},
			],
		});
		const item = parsed!.drafts[0];
		expect(item.presentFields?.has("enabled")).toBe(false);
		expect(item.draft.enabled).toBeUndefined();
		expect(item.draft.cadence).toEqual({ kind: "daily", time: "10:00", weekdays: [1, 5], every: 2 });

		const parsedFull = parseAutomationSessionState({
			mode: "active",
			drafts: [
				{
					draftId: "d-full",
					status: "pending",
					draft: {
						name: "完整",
						prompt: "p",
						cwd: "/repo",
						mode: "work",
						runMode: "local",
						approvalMode: "yolo",
						newChatEachRun: false,
						endAt: "2026-12-31T00:00:00Z",
						maxRuns: 10,
						enabled: false,
						probeDescription: "desc",
						resultMode: "llm_summary",
						invokesExternalModel: true,
						cadence: { kind: "monthly", day: 15, time: "08:30", every: 3, anchor: "2026-01-15" },
					},
				},
			],
		});
		expect(parsedFull?.drafts[0].draft).toMatchObject({
			mode: "work",
			approvalMode: "yolo",
			newChatEachRun: false,
			endAt: "2026-12-31T00:00:00Z",
			maxRuns: 10,
			enabled: false,
			probeDescription: "desc",
			resultMode: "llm_summary",
			invokesExternalModel: true,
			cadence: { kind: "monthly", day: 15, time: "08:30", every: 3, anchor: "2026-01-15" },
		});

		const existingOnServer = {
			id: "sched-existing",
			name: "旧晨报",
			prompt: "旧提示词",
			cwd: "/repo",
			mode: "work" as const,
			runMode: "local" as const,
			cadence: { kind: "daily" as const, time: "09:00", weekdays: [1, 3], every: 2, anchor: "2026-01-05" },
			model: "anthropic/claude",
			thinking: "high",
			approvalMode: "write",
			enabled: false,
			nextRunAt: null,
			lastRunAt: null,
			lastRunStatus: null,
			notify: "all" as const,
			newChatEachRun: false,
			endAt: "2026-12-31T00:00:00Z",
			lifecycle: "paused" as const,
			maxRuns: 8,
			runsDone: 1,
		};
		const updateSchedule = vi.fn(async (_id: string, _body: Record<string, unknown>) => existingOnServer);
		const createSchedule = vi.fn();
		const loadSchedules = vi.fn(async () => [existingOnServer]);
		useMobileSchedules.setState({ schedules: [], loaded: false, loadSchedules, updateSchedule, createSchedule } as never);
		const onResolve = vi.fn(async () => {});

		render(<AutomationDraftCard sessionId="s-1" item={item} onResolve={onResolve} />);
		fireEvent.click(screen.getByRole("button", { name: /确认保存|确认更新/ }));
		await waitFor(() => expect(updateSchedule).toHaveBeenCalledTimes(1));
		expect(createSchedule).not.toHaveBeenCalled();
		const [updId, updPayload] = updateSchedule.mock.calls[0];
		expect(updId).toBe("sched-existing");
		expect(updPayload).toMatchObject({
			name: "晨报更新",
			prompt: "新提示词",
			enabled: false,
			mode: "work",
			approvalMode: "write",
			newChatEachRun: false,
			endAt: "2026-12-31T00:00:00Z",
			maxRuns: 8,
			notify: "all",
			cadence: { kind: "daily", time: "10:00", weekdays: [1, 5], every: 2, anchor: "2026-01-05" },
		});

		useMobileSchedules.setState({ schedules: [existingOnServer], loaded: true });
		fireEvent.click(screen.getByRole("button", { name: /转手动精调/ }));
		await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/schedules/sched-existing?tab=config"));
		expect(takeManualScheduleDraft("new")).toBeNull();
		expect(takeManualScheduleDraft("other-id")).toBeNull();
		const taken = takeManualScheduleDraft("sched-existing");
		expect(taken?.name).toBe("晨报更新");
		expect(taken?.enabled).toBe(false);
		expect(taken?.approvalMode).toBe("write");
	});

	it("extracts vecway_automation with truncated string args when details.draftId exists and never falls back by name when draftId mismatches", () => {
		const calls = extractAutomationProposeCalls([
			{
				id: "tc-trunc",
				name: "vecway_automation",
				args: '{"action":"propose","draft":{"name":"构建',
				status: "done",
				result: "ok",
				details: { draftId: "d-missing" },
			},
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0].draftId).toBe("d-missing");

		const state = parseAutomationSessionState({
			mode: "active",
			drafts: [
				{
					draftId: "d-newer",
					status: "pending",
					draft: {
						name: "自动化草案",
						prompt: "p",
						cwd: "/repo",
						runMode: "local",
						cadence: { kind: "interval", minutes: 10 },
					},
				},
			],
		});
		expect(matchAutomationDraft(calls[0], state)).toBeNull();
	});
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../../../core/api";
import { nav } from "../../../core/nav";
import { useMobileSchedules } from "../../../core/stores/schedules";
import * as uiModule from "../../../ui";
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
const initialSchedulesState = useMobileSchedules.getState();

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
		useMobileSchedules.setState(initialSchedulesState, true);
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
			updatedAt: "2026-11-24T11:22:33Z",
		};
		const updateSchedule = vi.fn(
			async (_id: string, _body: Record<string, unknown>, _expectedUpdatedAt?: string) => existingOnServer,
		);
		const createSchedule = vi.fn();
		const loadSchedules = vi.fn(async () => [existingOnServer]);
		useMobileSchedules.setState({ schedules: [], loaded: false, loadSchedules, updateSchedule, createSchedule } as never);
		const onResolve = vi.fn(async () => {});

		render(<AutomationDraftCard sessionId="s-1" item={item} onResolve={onResolve} />);
		fireEvent.click(screen.getByRole("button", { name: /确认保存|确认更新/ }));
		await waitFor(() => expect(updateSchedule).toHaveBeenCalledTimes(1));
		expect(createSchedule).not.toHaveBeenCalled();
		const [updId, updPayload, updExpectedAt] = updateSchedule.mock.calls[0];
		expect(updId).toBe("sched-existing");
		expect(updExpectedAt).toBe("2026-11-24T11:22:33Z");
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
		expect(taken?.draft.name).toBe("晨报更新");
		expect(taken?.presentFields).not.toContain("enabled");
		expect(taken?.presentFields).not.toContain("approvalMode");
	});

	it("H5 + M5: omits defaulted cwd/prompt/cadence from presentFields, preserves same-kind cadence subfields & byte-identical timestamps on update, and applies global defaults on create", async () => {
		// 1. H5: Minimal proposal omits cwd, prompt, cadence -> not in presentFields
		const minimal = parseAutomationSessionState({
			mode: "active",
			drafts: [
				{
					draftId: "d-min",
					status: "pending",
					draft: { id: "sched-ts", name: "改名而已" },
				},
			],
		});
		expect(minimal?.drafts[0].presentFields?.has("cwd")).toBe(false);
		expect(minimal?.drafts[0].presentFields?.has("prompt")).toBe(false);
		expect(minimal?.drafts[0].presentFields?.has("cadence")).toBe(false);

		// 2. H5 + M5: Update with byte-identical endAt & once.at and partial monthly cadence update
		const monthlyExisting = {
			id: "sched-month",
			name: "月报",
			prompt: "生成月报",
			cwd: "/repo",
			mode: "work" as const,
			runMode: "local" as const,
			cadence: { kind: "monthly" as const, day: 5, time: "08:30", every: 2, anchor: "2026-01-05" },
			model: null,
			thinking: null,
			approvalMode: null,
			enabled: true,
			nextRunAt: null,
			lastRunAt: null,
			lastRunStatus: null,
			notify: "important" as const,
			newChatEachRun: true,
			endAt: "2026-12-31T23:59:45.123Z",
			lifecycle: "active" as const,
			maxRuns: null,
			runsDone: 0,
		};
		const partialMonthly = parseAutomationSessionState({
			mode: "active",
			drafts: [
				{
					draftId: "d-month",
					status: "pending",
					draft: {
						id: "sched-month",
						cadence: { kind: "monthly", day: 15 },
					},
				},
			],
		})!.drafts[0];

		const updateSchedule = vi.fn(async (_id: string, _body: Record<string, unknown>) => monthlyExisting);
		const createSchedule = vi.fn(async (body: Record<string, unknown>) => ({ ...monthlyExisting, id: "sched-new", ...body }));
		const loadSchedules = vi.fn(async () => [monthlyExisting]);
		useMobileSchedules.setState({ schedules: [monthlyExisting], loaded: true, loadSchedules, updateSchedule, createSchedule } as never);
		const onResolve = vi.fn(async () => {});

		const view = render(<AutomationDraftCard sessionId="s-m5" item={partialMonthly} onResolve={onResolve} />);
		fireEvent.click(screen.getByRole("button", { name: /确认更新/ }));
		await waitFor(() => expect(updateSchedule).toHaveBeenCalledTimes(1));
		const [, updBody] = updateSchedule.mock.calls[0];
		expect(updBody.endAt).toBe("2026-12-31T23:59:45.123Z");
		expect(updBody.cadence).toEqual({
			kind: "monthly",
			day: 15,
			time: "08:30",
			every: 2,
			anchor: "2026-01-05",
		});
		view.unmount();

		// 3. M5: Create applies /left/settings defaults to omitted fields
		const apiSpy = vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "GET" && path === "/left/settings") {
				return {
					automationDefaultResultMode: "llm_summary",
					automationDefaultModel: "openai/gpt-5",
					automationDefaultThinking: "high",
				};
			}
			return {};
		});
		try {
			const createItem = parseAutomationSessionState({
				mode: "active",
				drafts: [
					{
						draftId: "d-create",
						status: "pending",
						draft: {
							name: "新建任务",
							prompt: "执行",
							cwd: "/repo",
							runMode: "local",
							cadence: { kind: "once", at: "2026-12-01T09:00:30.500Z" },
						},
					},
				],
			})!.drafts[0];
			render(<AutomationDraftCard sessionId="s-m5-create" item={createItem} onResolve={onResolve} />);
			fireEvent.click(screen.getByRole("button", { name: /确认保存/ }));
			await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
			expect(createSchedule.mock.calls[0][0]).toMatchObject({
				resultMode: "llm_summary",
				model: "openai/gpt-5",
				thinking: "high",
				enabled: true,
			});
		} finally {
			apiSpy.mockRestore();
		}
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

	it("P1-3: prefers producer presentFields & cadencePresentFields over defaulted draft keys", () => {
		const parsed = parseAutomationSessionState({
			mode: "active",
			drafts: [
				{
					draftId: "d-prod-pf",
					status: "pending",
					presentFields: ["id", "name"],
					cadencePresentFields: [],
					draft: {
						id: "sched-prod",
						name: "仅改名",
						cwd: "/default-added-by-extension",
						prompt: "",
						cadence: { kind: "interval", minutes: 30 },
					},
				},
			],
		});
		const item = parsed!.drafts[0];
		expect([...(item.presentFields ?? [])]).toEqual(["id", "name"]);
		expect([...(item.cadencePresentFields ?? [])]).toEqual([]);
	});

	it("P1-4 + P2-5: retries resolve without duplicating schedule, handles 409 on create, and refreshes schedules before manual edit", async () => {
		const existingRow = {
			id: "sched-manual-refresh",
			name: "服务端任务",
			prompt: "p",
			cwd: "/repo",
			mode: "code" as const,
			runMode: "local" as const,
			cadence: { kind: "interval" as const, minutes: 30 },
			model: null,
			thinking: null,
			approvalMode: null,
			enabled: true,
			nextRunAt: null,
			lastRunAt: null,
			lastRunStatus: null,
			notify: "important" as const,
			newChatEachRun: true,
			endAt: null,
			lifecycle: "active" as const,
			maxRuns: null,
			runsDone: 0,
		};

		// 1. P1-4: deterministic id + retry resolve without duplicate createSchedule
		const createSchedule = vi.fn(async (body: Record<string, unknown>) => ({
			...existingRow,
			id: String(body.id),
			name: String(body.name),
		}));
		useMobileSchedules.setState({ schedules: [], loaded: true, createSchedule } as never);
		let resolveCalls = 0;
		const onResolve = vi.fn(async () => {
			resolveCalls++;
			if (resolveCalls === 1) throw new Error("rpc timeout");
		});
		const newItem: AutomationDraftStatus = {
			draftId: "draft-p14-retry",
			status: "pending",
			draft: {
				name: "不重复创建",
				prompt: "run",
				cwd: "/repo",
				runMode: "local",
				cadence: { kind: "interval", minutes: 15 },
			},
		};
		const view = render(<AutomationDraftCard sessionId="s-p14" item={newItem} onResolve={onResolve} />);
		fireEvent.click(screen.getByRole("button", { name: /确认保存/ }));
		await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
		expect(createSchedule).toHaveBeenCalledTimes(1);
		expect(createSchedule.mock.calls[0][0].id).toBe("draft-p14-retry");

		// Retry Save -> skips createSchedule and only retries onResolve
		fireEvent.click(screen.getByRole("button", { name: /确认保存/ }));
		await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
		expect(createSchedule).toHaveBeenCalledTimes(1);
		view.unmount();

		// 2. P1-4: 409 Conflict on deterministic create proceeds to onResolve
		const createConflict = vi.fn(async () => {
			throw new apiModule.ApiError(409, "duplicate id");
		});
		const loadSchedules = vi.fn(async () => [{ ...existingRow, id: "draft-p14-409" }]);
		useMobileSchedules.setState({ schedules: [], loaded: true, loadSchedules, createSchedule: createConflict } as never);
		const onResolve409 = vi.fn(async () => {});
		const item409: AutomationDraftStatus = {
			draftId: "draft-p14-409",
			status: "pending",
			draft: {
				name: "幂等冲突",
				prompt: "run",
				cwd: "/repo",
				runMode: "local",
				cadence: { kind: "interval", minutes: 15 },
			},
		};
		const view409 = render(<AutomationDraftCard sessionId="s-p14-409" item={item409} onResolve={onResolve409} />);
		fireEvent.click(screen.getByRole("button", { name: /确认保存/ }));
		await waitFor(() => expect(onResolve409).toHaveBeenCalledWith("draft-p14-409", "saved"));
		view409.unmount();

		// 3. P2-5: handleManualEdit refreshes schedule list even when schedulesLoaded is already true
		const loadManual = vi.fn(async () => [existingRow]);
		useMobileSchedules.setState({ schedules: [], loaded: true, loadSchedules: loadManual } as never);
		const onResolveManual = vi.fn(async () => {});
		const manualItem: AutomationDraftStatus = {
			draftId: "d-p25",
			status: "pending",
			draft: {
				id: "sched-manual-refresh",
				name: "更新",
				prompt: "p",
				cwd: "/repo",
				runMode: "local",
				cadence: { kind: "interval", minutes: 30 },
			},
		};
		render(<AutomationDraftCard sessionId="s-p25" item={manualItem} onResolve={onResolveManual} />);
		fireEvent.click(screen.getByRole("button", { name: /转手动精调/ }));
		await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/schedules/sched-manual-refresh?tab=config"));
		expect(loadManual).toHaveBeenCalledTimes(1);
		expect(onResolveManual).toHaveBeenCalledWith("d-p25", "dismissed");
		expect(takeManualScheduleDraft("sched-manual-refresh")?.draft.name).toBe("更新");
	});

	it("Round 4 (P1-3, P1-4, P2-3, P2-4): guards 409 create retries, passes expectedUpdatedAt on updateSchedule, prefers lastProposedDraftId, and keeps draft pending when manual refresh fails", async () => {
		// 1. P1-4: store updateSchedule appends ?expectedUpdatedAt=...
		const apiSpy = vi.spyOn(apiModule, "api").mockResolvedValue({
			id: "sched-put",
			name: "已更新",
			prompt: "p",
			cwd: "/repo",
			mode: "code",
			runMode: "local",
			cadence: { kind: "interval", minutes: 10 },
			model: null,
			thinking: null,
			approvalMode: null,
			enabled: true,
			nextRunAt: null,
			lastRunAt: null,
			lastRunStatus: null,
			notify: "important",
			newChatEachRun: true,
			endAt: null,
			lifecycle: "active",
			maxRuns: null,
			runsDone: 0,
			updatedAt: "2026-11-24T12:00:00Z",
		});
		try {
			await useMobileSchedules.getState().updateSchedule("sched-put", { name: "已更新" }, "2026-11-24T11:00:00Z");
			expect(apiSpy).toHaveBeenCalledWith(
				"PUT",
				"/left/schedules/sched-put?expectedUpdatedAt=2026-11-24T11%3A00%3A00Z",
				{ name: "已更新" },
			);
		} finally {
			apiSpy.mockRestore();
		}

		// 2. P1-3: create 409 with explicit draft.id MUST NOT be treated as saved
		const createConflictExplicit = vi.fn(async () => {
			throw new apiModule.ApiError(409, "schedule already exists");
		});
		const loadExplicit = vi.fn(async () => []);
		useMobileSchedules.setState({
			schedules: [],
			loaded: true,
			loadSchedules: loadExplicit,
			createSchedule: createConflictExplicit,
		} as never);
		const onResolveExplicit = vi.fn(async () => {});
		const toastSpy = vi.spyOn(uiModule, "toast").mockImplementation(() => 1 as never);
		try {
			const explicitItem: AutomationDraftStatus = {
				draftId: "d-explicit-409",
				status: "pending",
				draft: {
					id: "desktop-concurrent-id",
					name: "并发冲突",
					prompt: "p",
					cwd: "/repo",
					runMode: "local",
					cadence: { kind: "interval", minutes: 10 },
				},
			};
			const v1 = render(<AutomationDraftCard sessionId="s-r4-1" item={explicitItem} onResolve={onResolveExplicit} />);
			fireEvent.click(screen.getByRole("button", { name: /确认保存/ }));
			await waitFor(() => expect(createConflictExplicit).toHaveBeenCalledTimes(1));
			expect(onResolveExplicit).not.toHaveBeenCalled();
			expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining("schedule already exists"), { kind: "error" });
			v1.unmount();

			// 3. P1-3: create 409 with deterministic id where refresh does NOT contain deterministic id MUST NOT resolve
			toastSpy.mockClear();
			const loadWithoutMatch = vi.fn(async () => []);
			useMobileSchedules.setState({
				schedules: [],
				loaded: true,
				loadSchedules: loadWithoutMatch,
				createSchedule: createConflictExplicit,
			} as never);
			const detItem: AutomationDraftStatus = {
				draftId: "draft-det-missing",
				status: "pending",
				draft: {
					name: "非幂等冲突",
					prompt: "p",
					cwd: "/repo",
					runMode: "local",
					cadence: { kind: "interval", minutes: 10 },
				},
			};
			const v2 = render(<AutomationDraftCard sessionId="s-r4-2" item={detItem} onResolve={onResolveExplicit} />);
			fireEvent.click(screen.getByRole("button", { name: /确认保存/ }));
			await waitFor(() => expect(loadWithoutMatch).toHaveBeenCalledTimes(1));
			expect(onResolveExplicit).not.toHaveBeenCalled();
			expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining("schedule already exists"), { kind: "error" });
			v2.unmount();

			// 4. P2-4: handleManualEdit keeps proposal pending and aborts navigation when loadSchedules fails
			toastSpy.mockClear();
			const loadFail = vi.fn(async () => {
				throw new Error("offline");
			});
			useMobileSchedules.setState({ schedules: [], loaded: true, loadSchedules: loadFail } as never);
			const onResolveManual = vi.fn(async () => {});
			const manualFailItem: AutomationDraftStatus = {
				draftId: "d-manual-fail",
				status: "pending",
				draft: {
					id: "sched-fail",
					name: "刷新失败",
					prompt: "p",
					cwd: "/repo",
					runMode: "local",
					cadence: { kind: "interval", minutes: 10 },
				},
			};
			const v3 = render(<AutomationDraftCard sessionId="s-r4-3" item={manualFailItem} onResolve={onResolveManual} />);
			fireEvent.click(screen.getByRole("button", { name: /转手动精调/ }));
			await waitFor(() => expect(loadFail).toHaveBeenCalledTimes(1));
			expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining("刷新自动化列表失败：offline"), { kind: "error" });
			expect(onResolveManual).not.toHaveBeenCalled();
			expect(nav.push).not.toHaveBeenCalled();
			expect(takeManualScheduleDraft("sched-fail")).toBeNull();
			v3.unmount();
		} finally {
			toastSpy.mockRestore();
		}

		// 5. P2-3: parseAutomationSessionState preserves lastProposedDraftId and tracker prefers it over historical drafts
		const parsedLast = parseAutomationSessionState({
			mode: "active",
			lastProposedDraftId: "d-new",
			drafts: [
				{
					draftId: "d-hist",
					status: "pending",
					draft: { name: "历史", prompt: "p", cwd: ".", runMode: "local", cadence: { kind: "interval", minutes: 10 } },
				},
				{
					draftId: "d-new",
					status: "pending",
					draft: { name: "新提案", prompt: "p", cwd: ".", runMode: "local", cadence: { kind: "interval", minutes: 15 } },
				},
			],
		});
		expect(parsedLast?.lastProposedDraftId).toBe("d-new");

		const tracker = createAutomationDraftAutoOpenTracker();
		expect(tracker.next(true, { mode: "active", drafts: [] }, "snapshot")).toBeNull();
		// Live frame carrying both an unseen historical draft and lastProposedDraftId opens ONLY lastProposedDraftId
		expect(tracker.next(true, parsedLast, "live")).toBe("d-new");
		// Re-emitting the same already-seen lastProposedDraftId never falls back to d-hist
		expect(tracker.next(true, parsedLast, "live")).toBeNull();
		// Live broadcast without lastProposedDraftId containing multiple unseen drafts does not arbitrarily open
		const trackerMulti = createAutomationDraftAutoOpenTracker();
		expect(trackerMulti.next(true, { mode: "active", drafts: [] }, "snapshot")).toBeNull();
		expect(
			trackerMulti.next(true, { mode: "active", drafts: parsedLast!.drafts }, "live"),
		).toBeNull();
	});
});

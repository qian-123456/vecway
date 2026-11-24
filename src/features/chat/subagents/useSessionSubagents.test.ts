// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionMeta, SubagentSummary } from "../../../lib/contracts";
import * as ipc from "../../../lib/ipc";
import { useLive } from "../../../stores/live";
import { useSessions } from "../../../stores/sessions";
import { subagentCounts } from "./counts";
import { DISK_POLL_MS, mergeDiskAndLive, useSessionSubagents } from "./useSessionSubagents";

const disk = (over: Partial<SubagentSummary>): SubagentSummary => ({
	id: "0-Explore",
	status: "running",
	model: "p/m",
	thinkingLevel: null,
	agent: null,
	prompt: "Complete assignment thoroughly:\nScan the repo",
	messageCount: 2,
	toolCallCount: 3,
	requestCount: 1,
	tokens: 10,
	cost: 0,
	startedAt: "2026-01-01T00:00:00Z",
	endedAt: "2026-01-01T00:00:05Z",
	outputPath: null,
	filePath: "/s/p/parent/0-Explore.jsonl",
	...over,
});

describe("mergeDiskAndLive", () => {
	it("builds rows from on-disk subagents of an external CLI session", () => {
		const { subagents, rows } = mergeDiskAndLive([disk({})], {});
		expect(subagents["0-Explore"].label).toBe("Scan the repo");
		expect(subagents["0-Explore"].status).toBe("running");
		expect(rows["0-Explore"].filePath).toBe("/s/p/parent/0-Explore.jsonl");
		expect(rows["0-Explore"].durationMs).toBe(5000);
	});

	it("terminal status cannot be revived by stale live status", () => {
		const { rows } = mergeDiskAndLive([disk({ status: "completed" })], {
			"0-Explore": { status: "running", label: "x", agent: "explore" },
		});
		expect(rows["0-Explore"].status).toBe("completed");
		expect(rows["0-Explore"].agent).toBe("explore");
		expect(rows["0-Explore"].filePath).toBe("/s/p/parent/0-Explore.jsonl");
	});

	it("uses a newer disk run when the last live status is from a previous run", () => {
		const newRun = { startedAt: "2026-01-01T00:01:00Z", endedAt: "2026-01-01T00:01:01Z" };
		const live = { "0-Explore": { status: "completed" as const, label: "x", lastUpdate: Date.parse("2026-01-01T00:00:05Z") } };
		const current = { endedAt: newRun.endedAt, runSegments: [newRun] };
		expect(mergeDiskAndLive([disk({ ...current, status: "running" })], live).rows["0-Explore"].status).toBe("running");
		expect(mergeDiskAndLive([disk({ ...current, status: "failed" })], live).rows["0-Explore"].status).toBe("failed");
	});

	it("live running status wins over disk pending status", () => {
		const { rows } = mergeDiskAndLive([disk({ status: "pending" })], {
			"0-Explore": { status: "running", label: "x", agent: "explore" },
		});
		expect(rows["0-Explore"].status).toBe("running");
	});

	it("preserves a recorded zero cost", () => {
		const { rows } = mergeDiskAndLive([disk({ cost: 0 })], {});
		expect(rows["0-Explore"].cost).toBe(0);
	});

	it("adds queued agents of a running task call and counts them", () => {
		const { subagents } = mergeDiskAndLive(
			[disk({ status: "completed" })],
			{},
			{
				t1: {
					toolCallId: "t1",
					toolName: "task",
					args: {
						tasks: [
							{ id: "Explore", task: "Scan the repo" },
							{ id: "Later", task: "Not started yet" },
						],
					},
					intent: null,
					status: "running",
					text: "",
					details: null,
				},
			},
		);
		expect(subagentCounts(subagents)).toEqual({ running: 0, queued: 1, done: 1, failed: 0 });
		expect(subagents.Later?.status).toBe("pending");
	});

	it("counts queued agents of a task call still being streamed (no tool entry yet)", () => {
		const streaming = {
			role: "assistant",
			content: [
				{ type: "text", text: "dispatching" },
				{
					type: "toolCall",
					id: "t9",
					name: "task",
					arguments: { tasks: [{ id: "ImportBackend" }, { id: "ImportFrontend" }] },
				},
			],
		};
		const { subagents } = mergeDiskAndLive([], {}, {}, streaming);
		expect(subagentCounts(subagents)).toEqual({ running: 0, queued: 2, done: 0, failed: 0 });

		// Once omp starts the call, the tool entry owns the rows (no double count).
		const started = {
			t9: {
				toolCallId: "t9",
				toolName: "task",
				args: { tasks: [{ id: "ImportBackend" }, { id: "ImportFrontend" }] },
				intent: null,
				status: "running" as const,
				text: "",
				details: null,
			},
		};
		const after = mergeDiskAndLive([], {}, started, streaming);
		expect(subagentCounts(after.subagents).queued).toBe(2);
	});
});

it("shows the same subagent running after it wakes under an idle parent, until it finishes", async () => {
	const id = "0-Explore";
	const sessionId = "parent";
	const sessions = useSessions.getState().sessions;
	const live = useLive.getState().sessions;
	vi.useFakeTimers();
	const list = vi.spyOn(ipc, "subagentList").mockResolvedValue([disk({ status: "completed" })]);
	useSessions.setState({ sessions: { [sessionId]: { id: sessionId, file: "/s/p.jsonl", status: "idle" } as SessionMeta } });
	const { result, unmount } = renderHook(() => useSessionSubagents(sessionId));
	const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
	const lifecycle = (status: "started" | "completed") => act(() => {
		useLive.getState().reduceFrame({ sessionId, frame: { type: "subagent_lifecycle", payload: { id, status } } });
	});
	try {
		await advance(DISK_POLL_MS);
		expect(result.current.rows[id].status).toBe("completed");
		expect(list).toHaveBeenCalledTimes(1);

		vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
		lifecycle("started");
		await advance(DISK_POLL_MS);
		expect(result.current.rows[id].status).toBe("running");
		expect(subagentCounts(result.current.subagents).running).toBe(1);
		expect(list).toHaveBeenCalledTimes(3);

		list.mockResolvedValue([disk({ status: "completed", endedAt: "2026-01-01T00:01:03Z" })]);
		lifecycle("completed");
		await advance(DISK_POLL_MS);
		expect(result.current.rows[id].status).toBe("completed");
		expect(subagentCounts(result.current.subagents).running).toBe(0);
		expect(list).toHaveBeenCalledTimes(4);
	} finally {
		unmount();
		list.mockRestore();
		vi.useRealTimers();
		useSessions.setState({ sessions });
		useLive.setState({ sessions: live });
	}
});

describe("mergeDiskAndLive context + status", () => {
	const tools = {
		t1: {
			toolCallId: "t1",
			toolName: "task",
			args: {
				context: "SHARED CTX",
				tasks: [{ id: "0-Explore", agent: "explore", task: "Scan the repo", solutionSpace: "narrow" }],
			},
			intent: null,
			status: "done" as const,
			text: "",
			details: null,
		},
	};

	it("attaches sharedContext and solutionSpace to disk/live rows from a finished task call", () => {
		const { rows } = mergeDiskAndLive(
			[disk({ status: "completed" })],
			{ "0-Explore": { status: "completed", label: "x", agent: "explore", parentToolCallId: "t1" } },
			tools,
		);
		expect(rows["0-Explore"].sharedContext).toBe("SHARED CTX");
		expect(rows["0-Explore"].solutionSpace).toBe("narrow");
	});

	it("live terminal wins over stale disk running; duration comes from child progress, not batch times", () => {
		const { rows, subagents } = mergeDiskAndLive(
			[disk({ status: "running", startedAt: null, endedAt: null })],
			{
				"0-Explore": {
					status: "completed",
					label: "x",
					agent: "explore",
					parentToolCallId: "t1",
					progress: { durationMs: 22000, status: "completed" } as never,
				},
			},
			{ t1: { ...tools.t1, startedAt: 1000, endedAt: 999999 } },
		);
		expect(subagents["0-Explore"].status).toBe("completed");
		expect(rows["0-Explore"].status).toBe("completed");
		expect(rows["0-Explore"].durationMs).toBe(22000);
		expect(rows["0-Explore"].endedAt).toBeUndefined();
	});

	it("keeps active runSegments duration on terminal disk rows instead of single-segment live progress.durationMs", () => {
		const seg1 = { startedAt: "2026-11-19T20:16:12Z", endedAt: "2026-11-19T20:31:32Z" }; // 920s
		const seg2 = { startedAt: "2026-11-19T20:34:22Z", endedAt: "2026-11-19T20:38:37Z" }; // 255s
		const { rows } = mergeDiskAndLive(
			[
				disk({
					status: "completed",
					startedAt: seg1.startedAt,
					endedAt: seg2.endedAt,
					runSegments: [seg1, seg2],
				}),
			],
			{
				"0-Explore": {
					status: "completed",
					label: "x",
					agent: "explore",
					progress: { durationMs: 255_000, status: "completed" } as never,
				},
			},
		);
		expect(rows["0-Explore"].runSegments).toEqual([seg1, seg2]);
		expect(rows["0-Explore"].durationMs).toBe(1_175_000);
	});

	it("adds prior closed segments when live finishes resumed run before disk poll catches up", () => {
		const seg1 = { startedAt: "2026-11-19T20:16:12Z", endedAt: "2026-11-19T20:31:32Z" }; // 920s
		const seg2 = { startedAt: "2026-11-19T20:34:22Z", endedAt: "2026-11-19T20:35:00Z" }; // partial on disk
		const { rows } = mergeDiskAndLive(
			[
				disk({
					status: "running",
					startedAt: seg1.startedAt,
					endedAt: seg2.endedAt,
					runSegments: [seg1, seg2],
				}),
			],
			{
				"0-Explore": {
					status: "completed",
					label: "x",
					agent: "explore",
					progress: { durationMs: 255_000, status: "completed" } as never,
				},
			},
		);
		expect(rows["0-Explore"].durationMs).toBe(920_000 + 255_000);
	});
});

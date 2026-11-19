import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule, ScheduleRun, SessionMeta, WorktreeInfo } from "../../lib/contracts";

const gitMocks = vi.hoisted(() => ({
	gitRepoRoot: vi.fn(),
	gitListWorktrees: vi.fn(),
	gitDiffBase: vi.fn(),
	gitDiff: vi.fn(),
	gitCommit: vi.fn(),
	gitMergeBranch: vi.fn(),
	gitRemoveWorktree: vi.fn(),
}));

vi.mock("../../lib/ipc", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/ipc")>();
	return {
		...actual,
		...gitMocks,
	};
});

import {
	countDiffLines,
	discardAndCleanupWorktree,
	findAutomationWorktree,
	inspectAutomationWorktree,
	mergeAndCleanupWorktree,
} from "./automationWorktree";

const sampleSchedule: Schedule = {
	id: "sched-1",
	name: "Fix errors",
	prompt: "Fix them",
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
	runsDone: 1,
	lifecycle: "active",
	lastRunAt: "2026-11-18T00:00:00Z",
	lastRunStatus: "ok",
	lastRunPhase: "awaiting",
	lastRunSessionId: "sess-1",
	nextRunAt: "2026-11-18T00:30:00Z",
	createdAt: "2026-11-18T00:00:00Z",
	updatedAt: "2026-11-18T00:00:00Z",
};

const sampleRuns: ScheduleRun[] = [
	{
		id: "run-abcd1234-9999",
		scheduleId: "sched-1",
		sessionId: "sess-1",
		status: "ok",
		phase: "awaiting",
		startedAt: "2026-11-18T00:00:00Z",
		finishedAt: "2026-11-18T00:01:00Z",
		summary: "Paused awaiting confirmation",
	},
];

describe("automationWorktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("counts added and removed lines while ignoring unified diff headers", () => {
		const diff = [
			"--- a/src/app.ts",
			"+++ b/src/app.ts",
			"@@ -1,2 +1,3 @@",
			"-const oldVal = 1;",
			"+const newVal = 2;",
			"+const extra = 3;",
		].join("\n");
		expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 });
	});

	it("matches isolated worktree by run sessionId or sched-* branch prefix, ignoring main checkout", () => {
		const worktrees: WorktreeInfo[] = [
			{ path: "/tmp/repo", branch: "main", head: "aaa", dirty: 0, sessionIds: [], ahead: 0, behind: 0 },
			{
				path: "/tmp/repo/.worktrees/sched-fix-run-abcd",
				branch: "sched-fix-run-abcd",
				head: "bbb",
				dirty: 1,
				sessionIds: ["sess-1"],
				ahead: 1,
				behind: 0,
			},
		];
		const match = findAutomationWorktree("/tmp/repo", worktrees, sampleRuns, {} as Record<string, SessionMeta>);
		expect(match?.worktree.branch).toBe("sched-fix-run-abcd");
		expect(match?.run?.id).toBe("run-abcd1234-9999");
	});

	it("inspects committed and uncommitted diffs and commits dirty worktree before merging", async () => {
		gitMocks.gitRepoRoot.mockResolvedValue("/tmp/repo");
		gitMocks.gitListWorktrees.mockResolvedValue([
			{ path: "/tmp/repo", branch: "main", head: "aaa", dirty: 0, sessionIds: [], ahead: 0, behind: 0 },
			{
				path: "/tmp/repo/.worktrees/sched-fix-run-abcd",
				branch: "sched-fix-run-abcd",
				head: "bbb",
				dirty: 1,
				sessionIds: ["sess-1"],
				ahead: 1,
				behind: 0,
			},
		]);
		gitMocks.gitDiffBase.mockResolvedValue("--- a/x.ts\n+++ b/x.ts\n+committed");
		gitMocks.gitDiff.mockResolvedValue("--- a/y.ts\n+++ b/y.ts\n-old\n+dirty");

		const inspected = await inspectAutomationWorktree(sampleSchedule, sampleRuns, {});
		expect(inspected).not.toBeNull();
		expect(inspected!.stats).toEqual({ added: 2, removed: 1 });

		await mergeAndCleanupWorktree(inspected!, sampleSchedule.name);
		expect(gitMocks.gitCommit).toHaveBeenCalledWith(
			"/tmp/repo/.worktrees/sched-fix-run-abcd",
			"chore(automation): Fix errors",
		);
		expect(gitMocks.gitMergeBranch).toHaveBeenCalledWith("/tmp/repo", "sched-fix-run-abcd");
		expect(gitMocks.gitRemoveWorktree).toHaveBeenCalledWith(
			"/tmp/repo",
			"/tmp/repo/.worktrees/sched-fix-run-abcd",
			true,
			false,
			false,
		);

		await discardAndCleanupWorktree(inspected!);
		expect(gitMocks.gitRemoveWorktree).toHaveBeenCalledWith(
			"/tmp/repo",
			"/tmp/repo/.worktrees/sched-fix-run-abcd",
			true,
			true,
			false,
		);
	});
});

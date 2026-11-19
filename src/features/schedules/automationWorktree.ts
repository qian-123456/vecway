import type {
	Schedule,
	ScheduleRun,
	SessionMeta,
	WorktreeInfo,
} from "../../lib/contracts";
import {
	gitCommit,
	gitDiff,
	gitDiffBase,
	gitListWorktrees,
	gitMergeBranch,
	gitRemoveWorktree,
	gitRepoRoot,
} from "../../lib/ipc";
import { trimTrailingSlash } from "../../lib/paths";

export interface AutomationWorktreeState {
	repoRoot: string;
	worktree: WorktreeInfo;
	branch: string;
	run: ScheduleRun | null;
	committedDiff: string;
	uncommittedDiff: string;
	combinedDiff: string;
	stats: { added: number; removed: number };
}

/** Count added and removed lines in a unified diff string. */
export function countDiffLines(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++ ")) added++;
		else if (line.startsWith("-") && !line.startsWith("--- ")) removed++;
	}
	return { added, removed };
}

/**
 * Locate the isolated worktree belonging to an automation's run(s), ignoring the
 * main checkout (`repoRoot`) itself.
 */
export function findAutomationWorktree(
	repoRoot: string,
	worktrees: WorktreeInfo[],
	runs: ScheduleRun[],
	sessions: Record<string, SessionMeta>,
): { worktree: WorktreeInfo; run: ScheduleRun | null } | null {
	const mainPath = trimTrailingSlash(repoRoot);
	const candidates = worktrees.filter(
		(wt) => trimTrailingSlash(wt.path) !== mainPath,
	);
	if (candidates.length === 0) return null;

	for (const run of runs) {
		const runPrefix = run.id.slice(0, 8);
		const sess = run.sessionId ? sessions[run.sessionId] : undefined;
		const sessCwd = sess ? trimTrailingSlash(sess.cwd) : "";

		const match = candidates.find(
			(wt) =>
				(run.sessionId && wt.sessionIds.includes(run.sessionId)) ||
				(sessCwd && trimTrailingSlash(wt.path) === sessCwd) ||
				(runPrefix.length >= 6 &&
					Boolean(wt.branch?.startsWith("sched-") && wt.branch.endsWith(runPrefix))),
		);
		if (match) return { worktree: match, run };
	}
	return null;
}

/** Inspect whether the automation currently holds an isolated worktree with pending diffs. */
export async function inspectAutomationWorktree(
	schedule: Schedule,
	runs: ScheduleRun[],
	sessions: Record<string, SessionMeta>,
): Promise<AutomationWorktreeState | null> {
	const cwd = schedule.cwd.trim();
	if (!cwd) return null;
	const repoRoot = await gitRepoRoot(cwd).catch(() => null);
	if (!repoRoot) return null;

	const worktrees = await gitListWorktrees(repoRoot).catch(() => []);
	const hit = findAutomationWorktree(repoRoot, worktrees, runs, sessions);
	const branch = hit?.worktree.branch ?? null;
	if (!hit || !branch) return null;

	const wt = hit.worktree;
	const [committedDiff, uncommittedDiff] = await Promise.all([
		wt.ahead > 0 ? gitDiffBase(wt.path).catch(() => "") : Promise.resolve(""),
		wt.dirty > 0 ? gitDiff(wt.path).catch(() => "") : Promise.resolve(""),
	]);
	const combinedDiff = [committedDiff.trim(), uncommittedDiff.trim()]
		.filter(Boolean)
		.join("\n\n");

	return {
		repoRoot,
		worktree: wt,
		branch,
		run: hit.run,
		committedDiff,
		uncommittedDiff,
		combinedDiff,
		stats: countDiffLines(combinedDiff),
	};
}

/** Commit any pending edits inside the isolated worktree, merge into current branch, and clean up. */
export async function mergeAndCleanupWorktree(
	state: AutomationWorktreeState,
	scheduleName: string,
): Promise<void> {
	if (state.worktree.dirty > 0) {
		await gitCommit(state.worktree.path, `chore(automation): ${scheduleName}`);
	}
	await gitMergeBranch(state.repoRoot, state.branch);
	await gitRemoveWorktree(state.repoRoot, state.worktree.path, true, false, false);
}

/** Discard uncommitted & committed worktree changes and remove the temporary branch. */
export async function discardAndCleanupWorktree(
	state: AutomationWorktreeState,
): Promise<void> {
	await gitRemoveWorktree(state.repoRoot, state.worktree.path, true, true, false);
}

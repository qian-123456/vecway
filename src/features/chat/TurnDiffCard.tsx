/** [B] Codex-style Turn Diff summary card rendered directly below an assistant
 * turn's final reply whenever files were added, modified, or deleted. */

import clsx from "clsx";
import { ChevronRight, ExternalLink, FileDiff } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { ToolResultInfo, TurnCheckpoint } from "../../lib/contracts";
import { errMsg } from "../../lib/dialogs";
import { useHomeDir } from "../../lib/hooks";
import { gitDiff } from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { openFileLink } from "../../stores/filePreview";
import { useT } from "../../stores/language";
import { diffCounts, DiffView, parseDiff } from "./DiffView";
import type { StepShape } from "./ExecutionDisclosure";
import {
	collectTurnDiffSummary,
	normalizeTurnFilePath,
	splitToolDiffByFile,
	type TurnDiffStatus,
} from "./turnDiffs";

const STATUS_CHIP_STYLE: Record<TurnDiffStatus, string> = {
	A: "bg-[color-mix(in_oklab,var(--status-success)_14%,transparent)] text-[var(--status-success)]",
	M: "bg-[color-mix(in_oklab,var(--status-warning)_14%,transparent)] text-[var(--status-warning)]",
	D: "bg-[color-mix(in_oklab,var(--status-error)_14%,transparent)] text-[var(--status-error)]",
};

function openableFile(path: string): boolean {
	return !/^(?!file:)[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

interface FetchedFileDiff {
	loading: boolean;
	diff: string | null;
	error: string | null;
	adds: number;
	dels: number;
	hasCounts: boolean;
}

export const TurnDiffCard = memo(function TurnDiffCard({
	sessionId,
	steps,
	toolResultsByCallId,
	liveTools,
	turnCheckpoint,
	sessionCwd = "",
	isLatestTurn = false,
}: {
	sessionId: string;
	steps: readonly StepShape[];
	toolResultsByCallId?: ReadonlyMap<string, ToolResultInfo>;
	liveTools?: Readonly<Record<string, { status?: string; details?: unknown }>>;
	turnCheckpoint?: TurnCheckpoint;
	sessionCwd?: string;
	isLatestTurn?: boolean;
}) {
	const { t } = useT();
	const home = useHomeDir();
	const summary = useMemo(
		() =>
			collectTurnDiffSummary({
				steps,
				toolResultsByCallId,
				liveTools,
				turnCheckpoint,
				cwd: sessionCwd,
			}),
		[steps, toolResultsByCallId, liveTools, turnCheckpoint, sessionCwd],
	);

	const [open, setOpen] = useState(false);
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
	const [fetchedByPath, setFetchedByPath] = useState<Record<string, FetchedFileDiff>>({});

	const commitSha = turnCheckpoint?.commits?.[0];
	const canFetchFromGit =
		Boolean(sessionCwd) && (Boolean(commitSha) || (isLatestTurn && !turnCheckpoint?.undone));

	// When an archived commit exists and some checkpoint files lack tool diffs (e.g. bash edits),
	// hydrate their patches in one background git_diff call without altering collapsed card height.
	const missingCommitDiffKey = useMemo(() => {
		if (!sessionCwd || !commitSha) return "";
		const missing = summary.files.filter((f) => f.diff === null).map((f) => f.path);
		return missing.length > 0 ? `${sessionCwd}:${commitSha}:${missing.join("|")}` : "";
	}, [sessionCwd, commitSha, summary.files]);

	useEffect(() => {
		if (!missingCommitDiffKey || !commitSha || !sessionCwd) return;
		let cancelled = false;
		gitDiff(sessionCwd, undefined, commitSha)
			.then((patch) => {
				if (cancelled || !patch.trim()) return;
				const sections = splitToolDiffByFile(patch, []);
				if (sections.length === 0) return;
				setFetchedByPath((prev) => {
					const next = { ...prev };
					for (const sec of sections) {
						const norm = normalizeTurnFilePath(sec.rawPath, sessionCwd);
						const counts = diffCounts(parseDiff(sec.diff));
						next[norm] = {
							loading: false,
							diff: sec.diff,
							error: null,
							adds: counts.adds,
							dels: counts.dels,
							hasCounts: true,
						};
					}
					return next;
				});
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [missingCommitDiffKey, sessionCwd, commitSha]);

	if (summary.files.length === 0) return null;

	const mergedFiles = summary.files.map((f) => {
		const fetched = fetchedByPath[f.path];
		if (f.diff !== null || !fetched) return { ...f, loading: false, error: null as string | null };
		return {
			...f,
			diff: fetched.diff,
			adds: fetched.hasCounts ? fetched.adds : f.adds,
			dels: fetched.hasCounts ? fetched.dels : f.dels,
			hasCounts: fetched.hasCounts || f.hasCounts,
			loading: fetched.loading,
			error: fetched.error,
		};
	});

	let totalAdds = 0;
	let totalDels = 0;
	let hasAnyCounts = false;
	for (const f of mergedFiles) {
		if (f.hasCounts) {
			totalAdds += f.adds;
			totalDels += f.dels;
			hasAnyCounts = true;
		}
	}

	const loadSingleFileDiff = (path: string) => {
		if (!canFetchFromGit) return;
		const cur = fetchedByPath[path];
		if (cur?.loading || cur?.diff !== undefined && cur.diff !== null) return;
		setFetchedByPath((prev) => ({
			...prev,
			[path]: {
				loading: true,
				diff: null,
				error: null,
				adds: 0,
				dels: 0,
				hasCounts: false,
			},
		}));
		void gitDiff(sessionCwd, path, commitSha)
			.then((patch) => {
				const trimmed = patch.trim() ? patch : null;
				const counts = trimmed ? diffCounts(parseDiff(trimmed)) : { adds: 0, dels: 0 };
				setFetchedByPath((prev) => ({
					...prev,
					[path]: {
						loading: false,
						diff: trimmed,
						error: null,
						adds: counts.adds,
						dels: counts.dels,
						hasCounts: trimmed !== null,
					},
				}));
			})
			.catch((e) => {
				setFetchedByPath((prev) => ({
					...prev,
					[path]: {
						loading: false,
						diff: null,
						error: errMsg(e),
						adds: 0,
						dels: 0,
						hasCounts: false,
					},
				}));
			});
	};

	const toggleCard = () => {
		const nextOpen = !open;
		setOpen(nextOpen);
		if (nextOpen && mergedFiles.length === 1 && expandedPaths.size === 0) {
			const only = mergedFiles[0];
			setExpandedPaths(new Set([only.path]));
			if (only.diff === null) loadSingleFileDiff(only.path);
		}
	};

	const toggleFile = (path: string, hasInlineDiff: boolean) => {
		setExpandedPaths((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
				if (!hasInlineDiff) loadSingleFileDiff(path);
			}
			return next;
		});
	};

	const allExpanded =
		mergedFiles.length > 0 && mergedFiles.every((f) => expandedPaths.has(f.path));

	const toggleExpandAll = () => {
		if (allExpanded) {
			setExpandedPaths(new Set());
			return;
		}
		const next = new Set<string>();
		for (const f of mergedFiles) {
			next.add(f.path);
			if (f.diff === null) loadSingleFileDiff(f.path);
		}
		setExpandedPaths(next);
	};

	const statusTitle = (st: TurnDiffStatus): string =>
		st === "A"
			? t("chat.turnDiff.statusAdded")
			: st === "D"
				? t("chat.turnDiff.statusDeleted")
				: t("chat.turnDiff.statusModified");

	const headerCountLabel =
		mergedFiles.length === 1
			? t("chat.turnDiff.oneFileChanged")
			: t("chat.turnDiff.filesChanged", { count: mergedFiles.length });

	return (
		<div
			data-turn-diff-card=""
			className={clsx(
				"mt-2 w-full overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] transition-opacity",
				summary.undone && "opacity-65",
			)}
		>
			{/* Summary header row */}
			<div className="flex items-center justify-between gap-2 px-3 py-2">
				<button
					type="button"
					onClick={toggleCard}
					aria-expanded={open}
					title={open ? t("chat.turnDiff.collapseCard") : t("chat.turnDiff.expandCard")}
					className="flex min-w-0 flex-1 items-center gap-2 rounded text-left transition-colors hover:text-[var(--text)]"
				>
					<FileDiff size={14} className="shrink-0 text-[var(--text-40)]" aria-hidden />
					<span className="whitespace-nowrap text-[12px] font-medium text-[var(--text)]">
						{headerCountLabel}
					</span>
					{hasAnyCounts && (
						<span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-[12px] font-medium tabular-nums">
							<span className="text-[var(--status-success)]">+{totalAdds}</span>
							<span className="text-[var(--status-error)]">−{totalDels}</span>
						</span>
					)}
					{summary.undone && (
						<span
							className="shrink-0 whitespace-nowrap rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] text-[var(--text-40)]"
							title={t("chat.undo.undoneTitle")}
						>
							{t("chat.undo.undoneBadge")}
						</span>
					)}
					<ChevronRight
						size={14}
						aria-hidden
						className={clsx(
							"ml-auto shrink-0 text-[var(--text-40)] transition-transform duration-150",
							open && "rotate-90",
						)}
					/>
				</button>

				{open && mergedFiles.length > 1 && (
					<button
						type="button"
						onClick={toggleExpandAll}
						className="shrink-0 whitespace-nowrap rounded-full border border-[var(--line)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--text-60)] transition-colors hover:bg-[var(--ghost-hover)] hover:text-[var(--text)]"
					>
						{allExpanded ? t("chat.turnDiff.collapseAll") : t("chat.turnDiff.expandAll")}
					</button>
				)}
			</div>

			{/* Non-exclusive per-file diff rows */}
			{open && (
				<div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
					{mergedFiles.map((f) => {
						const fileOpen = expandedPaths.has(f.path);
						const canOpenInEditor = openableFile(f.openPath) && f.status !== "D";
						return (
							<div key={f.path} className="flex flex-col">
								<div className="flex items-center justify-between gap-2 px-3 py-1.5 transition-colors hover:bg-[var(--ghost-hover)]">
									<button
										type="button"
										onClick={() => toggleFile(f.path, f.diff !== null)}
										aria-expanded={fileOpen}
										className="flex min-w-0 flex-1 items-center gap-2 text-left"
									>
										<ChevronRight
											size={12}
											aria-hidden
											className={clsx(
												"shrink-0 text-[var(--text-40)] transition-transform duration-150",
												fileOpen && "rotate-90",
											)}
										/>
										<span
											className={clsx(
												"shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none",
												STATUS_CHIP_STYLE[f.status],
											)}
											title={statusTitle(f.status)}
										>
											{f.status}
										</span>
										<span className="min-w-0 flex-1 break-all font-mono text-[12px] leading-5 text-[var(--text)]">
											{f.path}
										</span>
										{f.hasCounts && (
											<span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums">
												<span className="text-[var(--status-success)]">+{f.adds}</span>
												<span className="text-[var(--status-error)]">−{f.dels}</span>
											</span>
										)}
									</button>

									{canOpenInEditor && (
										<button
											type="button"
											onClick={async () => {
												try {
													await openFileLink(f.openPath, {
														cwd: sessionCwd || null,
														home,
													});
												} catch (e) {
													toast.error(t("chat.openFileFailed", { error: errMsg(e) }));
												}
											}}
											className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-[var(--text-40)] transition-colors hover:border-[var(--line)] hover:bg-[var(--bg-panel)] hover:text-[var(--text)]"
											title={t("chat.turnDiff.openFile")}
											aria-label={t("chat.turnDiff.openFile")}
										>
											<ExternalLink size={12} />
										</button>
									)}
								</div>

								{fileOpen && (
									<div className="border-t border-[var(--line)] bg-[var(--well-bg)]/50 px-3 py-2.5">
										{f.diff !== null && f.diff.trim().length > 0 ? (
											<DiffView diff={f.diff} file={f.path} sessionId={sessionId} />
										) : f.loading ? (
											<p className="text-[12px] text-[var(--text-40)]">
												{t("chat.loadingShort")}
											</p>
										) : f.error ? (
											<p className="whitespace-pre-wrap break-words text-[12px] text-[var(--status-error)]">
												{f.error}
											</p>
										) : (
											<p className="text-[12px] text-[var(--text-40)]">
												{t("chat.turnDiff.noInlineDiff")}
											</p>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});

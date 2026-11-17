import { AlertCircle, Bot, FileEdit, FolderGit2, GitBranch, GitFork, Loader2, Sparkles } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import type { SessionMeta, SessionSnapshot, UsageSummary, Workspace } from "../../lib/contracts";
import { relativeTime, timeAgo } from "../../lib/format";
import { useHomeDir } from "../../lib/hooks";
import { sessionSnapshot, sessionUsage } from "../../lib/ipc";
import { resolveCurrentModel } from "../../lib/models";
import { isInside, shortPath, trimTrailingSlash } from "../../lib/paths";
import { sessionDisplayName } from "../../lib/sessionName";
import { useComposer } from "../../stores/composer";
import { useT } from "../../stores/language";
import { useLive } from "../../stores/live";
import { useSessions } from "../../stores/sessions";
import { useWorktrees } from "../../stores/worktrees";
import { formatShortModel } from "../chat/turnGrouping";
import { isLocalDraftId } from "./pendingSession";

export interface SessionHoverCardProps {
	session: SessionMeta;
	anchorRect: DOMRect | null;
	open: boolean;
	workspaces: Workspace[];
	/** Optional callback when hovering the card itself (kept optional for callers). */
	onMouseEnterCard?: () => void;
	onMouseLeaveCard?: () => void;
	onClose?: () => void;
}

interface HoverDetails {
	snapshot: SessionSnapshot | null;
	usage: UsageSummary | null;
}

const HOVER_DETAILS_CACHE_LIMIT = 120;
const hoverDetailsCache = new Map<string, HoverDetails>();

export function clearHoverDetailsCache(): void {
	hoverDetailsCache.clear();
}

/** Strip markdown noise from the assistant snippet so hover preview reads like prose. */
export function cleanAssistantPreview(raw: string | null | undefined): string {
	if (!raw) return "";
	return raw
		.replace(/```[a-zA-Z0-9_-]*\s*/g, " ")
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s?/gm, "")
		.replace(/[*_~`]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Compact token formatting (e.g. 840, 12.4k, 1.8M); empty when nullish/negative. */
export function formatCompactTokens(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n) || n < 0) return "";
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
	}
	const m = n / 1_000_000;
	return `${Number(m.toFixed(1))}M`;
}

function cacheHoverDetails(key: string, value: HoverDetails): void {
	if (hoverDetailsCache.size >= HOVER_DETAILS_CACHE_LIMIT) {
		const oldest = hoverDetailsCache.keys().next().value;
		if (oldest) hoverDetailsCache.delete(oldest);
	}
	hoverDetailsCache.set(key, value);
}

function useSessionHoverDetails(session: SessionMeta, active: boolean): HoverDetails | null {
	const cacheKey = `${session.id}|${session.updatedAt}`;
	const cached = hoverDetailsCache.get(cacheKey) ?? null;
	const [fetched, setFetched] = useState<{ key: string; data: HoverDetails } | null>(null);

	useEffect(() => {
		if (!active || isLocalDraftId(session.id) || hoverDetailsCache.has(cacheKey)) return;
		let cancelled = false;
		Promise.all([
			sessionSnapshot(session.id).catch(() => null),
			sessionUsage(session.id).catch(() => null),
		]).then(([snapshot, usage]) => {
			if (cancelled) return;
			const data = { snapshot, usage };
			cacheHoverDetails(cacheKey, data);
			setFetched({ key: cacheKey, data });
		});
		return () => {
			cancelled = true;
		};
	}, [active, cacheKey, session.id]);

	if (cached) return cached;
	if (fetched?.key === cacheKey) return fetched.data;
	return null;
}

/**
 * Strictly read-only, pointer-transparent floating session preview card:
 * Renders via FloatingLayer (layer="hovercard", placement="right-start") without
 * stealing pointer events or blocking underlying controls.
 */
export function SessionHoverCard({
	session,
	anchorRect,
	open,
	workspaces,
}: SessionHoverCardProps) {
	const { t } = useT();
	const home = useHomeDir();
	const active = open && Boolean(anchorRect);
	const details = useSessionHoverDetails(session, active);

	const live = useLive((s) => (active ? s.sessions[session.id] : undefined));
	const draftText = useComposer((s) => (active ? (s.drafts[session.id] ?? "") : ""));
	const draftImageCount = useComposer((s) => (active ? (s.images[session.id]?.length ?? 0) : 0));
	const parentSession = useSessions((s) =>
		active && session.parentId ? s.sessions[session.parentId] : undefined,
	);
	const wsWorktrees = useWorktrees((s) =>
		active && session.workspaceId ? s.byWorkspace[session.workspaceId] : undefined,
	);

	const matchedWorktree = useMemo(() => {
		if (!wsWorktrees || !session.cwd) return null;
		const matches = wsWorktrees.filter((w) => isInside(session.cwd, w.path));
		if (matches.length === 0) return null;
		matches.sort((a, b) => b.path.length - a.path.length);
		return matches[0];
	}, [wsWorktrees, session.cwd]);

	if (!active || !anchorRect) return null;

	const title = sessionDisplayName(session);
	const hasGit = session.git !== null;
	const branch = matchedWorktree?.branch ?? session.git?.branch ?? null;
	const worktree = session.git?.worktree ?? null;
	const dirty = matchedWorktree?.dirty ?? session.git?.dirty ?? 0;
	const ahead = matchedWorktree?.ahead ?? 0;
	const behind = matchedWorktree?.behind ?? 0;
	const result = session.result;
	const matchedWs = workspaces.find((w) => w.id === session.workspaceId);

	const activeTool = live ? Object.values(live.tools).find((tool) => tool.status === "running") : undefined;
	const runningSubagents = live
		? Object.values(live.subagents).filter((sa) => String(sa.status).toLowerCase() === "running").length
		: 0;
	const liveState = live?.state as
		| {
				model?: unknown;
				thinkingLevel?: unknown;
				contextUsage?: { tokens?: unknown; contextWindow?: unknown } | null;
		  }
		| null
		| undefined;

	const resolvedLiveModel = resolveCurrentModel(liveState?.model).value;
	const modelDisplay = formatShortModel(resolvedLiveModel || session.model);
	const rawThinking =
		(typeof liveState?.thinkingLevel === "string" ? liveState.thinkingLevel : null) ??
		details?.snapshot?.thinkingLevel ??
		null;
	const thinkingDisplay = rawThinking && rawThinking !== "off" ? rawThinking : null;

	const liveCtxTokens =
		typeof liveState?.contextUsage?.tokens === "number" ? liveState.contextUsage.tokens : null;
	const contextTokens = liveCtxTokens ?? details?.snapshot?.contextTokens ?? null;
	const totalTokens = details?.usage?.available ? details.usage.tokens : null;

	const hasDraft = Boolean(draftText.trim() || draftImageCount > 0);
	const assistantSummary = cleanAssistantPreview(session.lastAssistant);
	const parentTitle = parentSession ? sessionDisplayName(parentSession) : undefined;
	const isReview = session.status === "review" || session.pending === "review";
	const isExternal = session.status === "external" || session.externalPid != null;

	const showDirectory =
		Boolean(session.cwd) &&
		(!matchedWs ||
			matchedWs.kind === "global" ||
			trimTrailingSlash(session.cwd) !== trimTrailingSlash(matchedWs.path));

	const updatedAgo = timeAgo(session.updatedAt || session.createdAt) || relativeTime(session.updatedAt || session.createdAt);

	const headerMetaItems: Array<{ key: string; node: ReactNode }> = [];
	if (session.status === "working") {
		headerMetaItems.push({
			key: "status-working",
			node: (
				<span className="inline-flex items-center gap-1 font-medium text-sky-600 dark:text-sky-300 whitespace-nowrap">
					<Loader2 size={11} className="shrink-0 animate-spin" />
					<span>{t("sessions.statusRunning")}</span>
				</span>
			),
		});
	} else if (session.status === "awaiting_approval" || session.status === "awaiting_answer") {
		headerMetaItems.push({
			key: "status-awaiting",
			node: (
				<span className="font-medium text-sky-600 dark:text-sky-300 whitespace-nowrap">
					{t("sessions.statusAwaiting")}
				</span>
			),
		});
	} else if (session.status === "error") {
		headerMetaItems.push({
			key: "status-error",
			node: (
				<span className="inline-flex items-center gap-1 font-medium text-rose-600 dark:text-rose-300 whitespace-nowrap">
					<AlertCircle size={11} className="shrink-0" />
					<span>{t("sessions.statusAbnormal")}</span>
				</span>
			),
		});
	} else if (session.status === "interrupted") {
		headerMetaItems.push({
			key: "status-interrupted",
			node: (
				<span className="font-medium text-amber-600 dark:text-amber-300 whitespace-nowrap">
					{t("sessions.statusInterrupted")}
				</span>
			),
		});
	}
	if (isReview) {
		headerMetaItems.push({
			key: "status-review",
			node: (
				<span className="font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
					{t("sessions.hoverPendingReview")}
				</span>
			),
		});
	}
	if (isExternal) {
		headerMetaItems.push({
			key: "status-external",
			node: (
				<span className="font-medium text-purple-600 dark:text-purple-300 whitespace-nowrap">
					{session.externalPid != null
						? t("sessions.hoverExternalPid", { pid: session.externalPid })
						: t("sessions.hoverExternal")}
				</span>
			),
		});
	}
	if (session.unread && !isReview) {
		headerMetaItems.push({
			key: "status-unread",
			node: (
				<span className="font-medium text-sky-600 dark:text-sky-300 whitespace-nowrap">
					{t("sessions.unread")}
				</span>
			),
		});
	}
	if (session.archived) {
		headerMetaItems.push({
			key: "status-archived",
			node: (
				<span className="text-[var(--text-dim)] whitespace-nowrap">
					{t("sessionActions.archived")}
				</span>
			),
		});
	}
	if (hasDraft) {
		headerMetaItems.push({
			key: "status-draft",
			node: (
				<span className="inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-300 whitespace-nowrap">
					<FileEdit size={11} className="shrink-0" />
					<span>{t("sessions.hoverHasDraft")}</span>
				</span>
			),
		});
	}
	if (session.kind === "side") {
		headerMetaItems.push({
			key: "lineage-side",
			node: (
				<span className="inline-flex min-w-0 items-center gap-1 text-[var(--text-muted)]">
					<GitFork size={11} className="shrink-0 text-[var(--text-dim)]" />
					<span className="max-w-[190px] truncate">
						{t("sessions.sideChatFrom", {
							title: parentTitle || t("sessions.missingSessionTitle"),
						})}
					</span>
				</span>
			),
		});
	} else if (session.parentId) {
		headerMetaItems.push({
			key: "lineage-fork",
			node: (
				<span className="inline-flex min-w-0 items-center gap-1 text-[var(--text-muted)]">
					<GitFork size={11} className="shrink-0 text-[var(--text-dim)]" />
					<span className="max-w-[190px] truncate">
						{parentTitle
							? t("sessions.forkedFrom", { title: parentTitle })
							: t("sessions.forkedSession")}
					</span>
				</span>
			),
		});
	}

	return (
		<FloatingLayer
			anchor={anchorRect}
			placement="right-start"
			offset={8}
			layer="hovercard"
			className="pointer-events-none w-max min-w-[210px] max-w-[min(310px,calc(100vw-32px))] p-3 text-xs text-[var(--text)] select-none space-y-2.5 bg-[var(--bg-panel)] shadow-apple-modal hairline rounded-xl"
		>
			{/* Header: Full unclipped Title + inline Status / Draft / Lineage metadata */}
			<div className="space-y-1">
				<div className="text-[13px] font-semibold text-[var(--text)] break-words leading-snug">
					{title}
				</div>

				{headerMetaItems.length > 0 && (
					<div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-snug text-[var(--text-muted)]">
						{headerMetaItems.map((item, idx) => (
							<Fragment key={item.key}>
								{idx > 0 && (
									<span aria-hidden="true" className="text-[var(--text-dim)]">
										·
									</span>
								)}
								{item.node}
							</Fragment>
						))}
					</div>
				)}
			</div>

			{/* Live Execution Activity (running tool / subagents) */}
			{session.status === "working" && (activeTool || runningSubagents > 0) && (
				<div className="space-y-1 pt-2 border-t border-[var(--border-divider)]">
					<div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
						{activeTool ? (
							<span className="min-w-0 truncate text-sky-600 dark:text-sky-300 font-medium">
								{t("sessions.hoverLiveTool", {
									tool: activeTool.intent || activeTool.toolName,
								})}
							</span>
						) : (
							<span className="text-[var(--text-muted)]">{t("sessions.statusRunning")}</span>
						)}
						{runningSubagents > 0 && (
							<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-medium text-sky-600 dark:text-sky-300">
								<Bot size={11} className="shrink-0" />
								<span>{t("sessions.hoverRunningSubagents", { count: runningSubagents })}</span>
							</span>
						)}
					</div>
				</div>
			)}

			{/* Latest Assistant Reply Summary (or Draft Preview if no reply yet) */}
			{assistantSummary ? (
				<div className="space-y-1 pt-2 border-t border-[var(--border-divider)]">
					<div className="text-[10px] font-semibold text-[var(--text-dim)]">
						{t("sessions.hoverLatestReply")}
					</div>
					<div className="line-clamp-3 text-[11.5px] leading-relaxed text-[var(--text-muted)] break-words">
						{assistantSummary}
					</div>
				</div>
			) : (
				draftText.trim() && (
					<div className="space-y-1 pt-2 border-t border-[var(--border-divider)]">
						<div className="text-[10px] font-semibold text-[var(--text-dim)]">
							{t("sessions.hoverDraftPreview")}
						</div>
						<div className="line-clamp-2 text-[11.5px] leading-relaxed text-[var(--text-muted)] break-words">
							{draftText.trim()}
						</div>
					</div>
				)
			)}

			{/* Model, Thinking & Context / Token Footprint */}
			{(modelDisplay || thinkingDisplay || (contextTokens != null && contextTokens > 0) || (totalTokens != null && totalTokens > 0)) && (
				<div className="space-y-1 pt-2 border-t border-[var(--border-divider)]">
					<div className="text-[10px] font-semibold text-[var(--text-dim)]">
						{t("sessions.hoverModelAndBudget")}
					</div>
					<div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px]">
						<div className="flex min-w-0 items-center gap-1.5">
							{modelDisplay && (
								<span className="inline-flex items-center gap-1 truncate font-medium text-[var(--text)]">
									<Sparkles size={11} className="shrink-0 text-[var(--accent)]" />
									<span className="truncate">{modelDisplay}</span>
								</span>
							)}
							{modelDisplay && thinkingDisplay && (
								<span aria-hidden="true" className="text-[var(--text-dim)]">
									·
								</span>
							)}
							{thinkingDisplay && (
								<span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] text-[var(--text-muted)]">
									{thinkingDisplay}
								</span>
							)}
						</div>
						{((contextTokens != null && contextTokens > 0) || (totalTokens != null && totalTokens > 0)) && (
							<div className="flex items-center gap-2 font-mono text-[10.5px] tabular-nums text-[var(--text-muted)] whitespace-nowrap">
								{contextTokens != null && contextTokens > 0 && (
									<span>
										{t("sessions.hoverContextTokens", {
											count: formatCompactTokens(contextTokens),
										})}
									</span>
								)}
								{totalTokens != null && totalTokens > 0 && (
									<span>
										{t("sessions.hoverTotalTokens", {
											count: formatCompactTokens(totalTokens),
										})}
									</span>
								)}
							</div>
						)}
					</div>
				</div>
			)}

			{/* Branch + Ahead/Behind + Uncommitted + Worktree */}
			<div className="space-y-1 pt-2 border-t border-[var(--border-divider)]">
				<div className="text-[10px] font-semibold text-[var(--text-dim)]">
					{t("sessions.branch")}
				</div>
				{hasGit ? (
					<div className="space-y-1">
						<div className="flex items-center justify-between gap-1.5 font-mono text-xs text-[var(--text)] min-w-0">
							<div className="flex items-center gap-1.5 min-w-0 truncate">
								<GitBranch size={12} className="shrink-0 text-[var(--text-muted)]" />
								<span className="truncate" title={branch ?? t("sessions.defaultBranch")}>
									{branch ?? t("sessions.defaultBranch")}
								</span>
							</div>
							<div className="flex shrink-0 items-center gap-1.5 font-sans">
								{(ahead > 0 || behind > 0) && (
									<span className="text-[10px] font-mono text-[var(--text-muted)] whitespace-nowrap">
										{ahead > 0 ? `↑${ahead}` : ""}
										{ahead > 0 && behind > 0 ? " " : ""}
										{behind > 0 ? `↓${behind}` : ""}
									</span>
								)}
								{dirty > 0 && (
									<span className="shrink-0 text-[10px] text-amber-500 dark:text-amber-400 whitespace-nowrap">
										●{dirty} {t("sessions.uncommitted")}
									</span>
								)}
							</div>
						</div>
						{worktree && (
							<div className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--text)] min-w-0">
								<FolderGit2 size={12} className="shrink-0 text-emerald-500 dark:text-emerald-400" />
								<span className="truncate" title={worktree}>
									{worktree}
								</span>
								<span aria-hidden="true" className="text-[var(--text-dim)] font-sans">
									·
								</span>
								<span className="shrink-0 whitespace-nowrap font-sans text-[10.5px] text-emerald-600 dark:text-emerald-400">
									{t("sessions.isolatedWorktree")}
								</span>
							</div>
						)}
					</div>
				) : (
					<div className="text-[11px] text-[var(--text-dim)]">
						{t("sessions.nonGitDir")}
					</div>
				)}
			</div>

			{/* Result Badge Section (when result present) */}
			{result && (
				<div className="space-y-1 pt-2 border-t border-[var(--border-divider)]">
					<div className="text-[10px] font-semibold text-[var(--text-dim)]">
						{t("sessions.result")}
					</div>
					<div className="flex items-center gap-1.5 text-xs text-[var(--text)] min-w-0">
						<span className="shrink-0">{result.ok ? "✅" : "❌"}</span>
						<span className="font-medium capitalize shrink-0">{result.kind}</span>
						{result.summary && (
							<span
								className="truncate text-[11px] text-[var(--text-muted)] font-mono"
								title={result.summary}
							>
								{result.summary}
							</span>
						)}
					</div>
				</div>
			)}

			{/* Smart Directory Section: deduplicated when cwd equals project workspace root */}
			{showDirectory && (
				<div className="space-y-0.5 text-[11px] text-[var(--text-muted)] pt-2 border-t border-[var(--border-divider)]">
					<div className="text-[10px] font-semibold text-[var(--text-dim)]">
						{t("sessions.directory")}
					</div>
					<div className="font-mono truncate text-[11px] text-[var(--text)]" title={session.cwd}>
						{shortPath(session.cwd, home)}
					</div>
				</div>
			)}

			{/* Footer: relative time & workspace */}
			<div className="pt-2 border-t border-[var(--border-divider)] flex items-center justify-between gap-2 text-[10px] text-[var(--text-dim)]">
				<span className="whitespace-nowrap">{t("sessions.hoverUpdatedAgo", { time: updatedAgo })}</span>
				{matchedWs ? (
					<span className="truncate max-w-[130px]" title={matchedWs.name}>
						{matchedWs.name}
					</span>
				) : (
					session.mode !== "chat" && (
						<span className="truncate max-w-[130px]">{t("sidebar.unassignedWorkspaces")}</span>
					)
				)}
			</div>
		</FloatingLayer>
	);
}

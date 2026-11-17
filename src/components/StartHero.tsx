import { ChevronDown, FolderOpen, FolderPlus, Globe, History } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { WorkspacePickerPopover } from "../features/chat/ContextPillBar";
import { resolveSessionLocation } from "../features/chat/sessionWorkspace";
import { resolveNewSessionTargetWorkspace } from "../features/sessions/modes";
import { draftMeta, isLocalDraftId, usePendingSession } from "../features/sessions/pendingSession";
import { useSidebarStore } from "../features/sessions/sidebarStore";
import type { GitBadge, SessionMeta } from "../lib/contracts";
import { timeAgo } from "../lib/format";
import { gitBadge } from "../lib/ipc";
import { sessionDisplayName } from "../lib/sessionName";
import { useT } from "../stores/language";
import { useSessions } from "../stores/sessions";
import { useUi } from "../stores/ui";

/** Flat clean background; soft gradient glow removed per user design preference. */
export function StartGlow() {
	return null;
}

interface StartContextProps {
	sessionId?: string | null;
	onPickDirectory?: () => void;
}

function useHomeTarget(sessionId?: string | null) {
	const isDraft = Boolean(sessionId && isLocalDraftId(sessionId));
	const realMeta = useSessions((s) => (sessionId && !isDraft ? s.sessions[sessionId] : undefined));
	const draft = usePendingSession((s) => (sessionId && isDraft ? s.drafts[sessionId] : undefined));
	const activeMode = useSidebarStore((s) => s.activeMode);
	const workspaces = useSessions((s) => s.workspaces);
	const sessions = useSessions((s) => s.sessions);

	return useMemo(() => {
		if (sessionId) {
			const meta = isDraft ? (draft ? draftMeta(draft) : undefined) : realMeta;
			const loc = resolveSessionLocation(meta, workspaces);
			const isGlobal = loc.kind === "global";
			const label = isGlobal
				? loc.label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "")
				: loc.label;
			return {
				workspaceId: meta?.workspaceId ?? null,
				cwd: meta?.cwd ?? "",
				isGlobal,
				hasProject: loc.kind !== "unknown",
				label,
				knownGit: meta?.git ?? null,
				mode: meta?.mode ?? activeMode,
			};
		}

		const targetWs = resolveNewSessionTargetWorkspace(activeMode, null, sessions, workspaces);
		if (targetWs) {
			const isGlobal = targetWs.kind === "global";
			const label = isGlobal
				? targetWs.name.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "")
				: targetWs.name;
			return {
				workspaceId: targetWs.id,
				cwd: targetWs.path,
				isGlobal,
				hasProject: true,
				label,
				knownGit: null,
				mode: activeMode,
			};
		}

		return {
			workspaceId: null,
			cwd: "",
			isGlobal: false,
			hasProject: false,
			label: "",
			knownGit: null,
			mode: activeMode,
		};
	}, [sessionId, isDraft, draft, realMeta, activeMode, workspaces, sessions]);
}

function selectRecentWorkspaceSessions(
	sessions: Record<string, SessionMeta>,
	workspaceId: string | null,
	cwd: string,
	isGlobal: boolean,
	mode: SessionMeta["mode"],
	excludeId?: string | null,
): SessionMeta[] {
	const items = Object.values(sessions).filter((s) => {
		if (!s || s.id === excludeId || s.archived || s.kind === "side" || (s.forkDepth ?? 0) > 0) {
			return false;
		}
		if (!s.title?.trim() && !s.lastAssistant) return false;
		if (isGlobal) return s.mode === mode;
		if (workspaceId && s.workspaceId === workspaceId) return true;
		if (cwd && s.cwd === cwd) return true;
		return false;
	});
	items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	return items;
}

/**
 * Editorial left-aligned home task headline with frameless clickable folder +
 * project trigger and live workspace status subtitle directly underneath.
 */
export function StartHero({ sessionId, onPickDirectory }: StartContextProps) {
	const { t } = useT();
	const target = useHomeTarget(sessionId);
	const sessions = useSessions((s) => s.sessions);
	const [pickerOpen, setPickerOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [probedGit, setProbedGit] = useState<GitBadge | null>(null);

	useEffect(() => {
		if (!target.cwd || target.isGlobal) {
			setProbedGit(null);
			return;
		}
		let cancelled = false;
		gitBadge(target.cwd)
			.then((b) => {
				if (!cancelled) setProbedGit(b ?? null);
			})
			.catch(() => {
				if (!cancelled) setProbedGit(null);
			});
		return () => {
			cancelled = true;
		};
	}, [target.cwd, target.isGlobal]);

	const recent = useMemo(
		() =>
			selectRecentWorkspaceSessions(
				sessions,
				target.workspaceId,
				target.cwd,
				target.isGlobal,
				target.mode,
				sessionId,
			),
		[sessions, target.workspaceId, target.cwd, target.isGlobal, target.mode, sessionId],
	);

	const git = probedGit ?? target.knownGit;
	const subtitle = useMemo(() => {
		const parts: string[] = [];
		if (git?.branch) {
			parts.push(t("home.branchSegment", { branch: git.branch }));
			const dirtyCount = git.dirty ?? 0;
			parts.push(
				dirtyCount > 0
					? t("home.dirtySegment", { count: dirtyCount })
					: t("home.cleanSegment"),
			);
		}
		if (recent[0]?.updatedAt) {
			const rel = timeAgo(recent[0].updatedAt);
			if (rel) parts.push(t("home.lastActiveSegment", { time: rel }));
		}
		if (parts.length > 0) return parts.join(" · ");
		return target.cwd && !target.isGlobal ? target.cwd : t("home.readySubtitle");
	}, [git, recent, target.cwd, target.isGlobal, t]);

	const displayLabel = target.hasProject
		? (target.isGlobal ? t("home.globalSpace") : target.label)
		: t("home.selectProjectDir");
	const suffix = target.isGlobal ? t("home.headlineGlobalSuffix") : t("home.headlineSuffix");

	const handleTriggerClick = () => {
		if (!target.hasProject && onPickDirectory) {
			onPickDirectory();
			return;
		}
		setPickerOpen((v) => !v);
	};

	return (
		<div className="start-rise mx-auto w-full max-w-[780px] px-6 select-none">
			<div className="px-3.5 pb-4 text-center">
				<h1 className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[25px] font-semibold leading-snug tracking-[-0.02em] text-[var(--text)]">
					<span>{t("home.headlinePrefix")}</span>
					<button
						ref={triggerRef}
						type="button"
						onClick={handleTriggerClick}
						title={target.cwd || t("home.switchProjectTip")}
						className="group inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-[var(--text)] transition-opacity hover:opacity-85 active:opacity-75 cursor-pointer"
					>
						{!target.hasProject ? (
							<FolderPlus
								size={20}
								strokeWidth={1.8}
								className="shrink-0 translate-y-[0.5px] text-[var(--accent)]"
							/>
						) : target.isGlobal ? (
							<Globe
								size={20}
								strokeWidth={1.8}
								className="shrink-0 translate-y-[0.5px] text-[var(--accent)]"
							/>
						) : (
							<FolderOpen
								size={20}
								strokeWidth={1.8}
								className="shrink-0 translate-y-[0.5px] text-[var(--accent)]"
							/>
						)}
						<span className="truncate underline decoration-1 underline-offset-[6px] decoration-[var(--text-30)] transition-colors group-hover:decoration-[var(--text-60)]">
							{displayLabel}
						</span>
						<ChevronDown
							size={14}
							strokeWidth={2}
							className="shrink-0 text-[var(--text-muted)] opacity-60 transition-opacity group-hover:opacity-100"
						/>
					</button>
					{suffix ? <span>{suffix}</span> : null}
				</h1>

				<p className="mt-1.5 text-center text-[12.5px] leading-relaxed text-[var(--text-muted)] tabular-nums">
					{subtitle}
				</p>

				{pickerOpen && (
					<WorkspacePickerPopover
						anchor={triggerRef.current}
						ignoreRefs={[triggerRef]}
						activeWorkspaceId={target.workspaceId}
						placement="bottom-start"
						onClose={() => setPickerOpen(false)}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * Quiet two-row frameless continuation list placed below the home Composer.
 */
export function HomeRecentSessions({ sessionId }: { sessionId?: string | null }) {
	const { t } = useT();
	const target = useHomeTarget(sessionId);
	const sessions = useSessions((s) => s.sessions);

	const recent = useMemo(
		() =>
			selectRecentWorkspaceSessions(
				sessions,
				target.workspaceId,
				target.cwd,
				target.isGlobal,
				target.mode,
				sessionId,
			).slice(0, 2),
		[sessions, target.workspaceId, target.cwd, target.isGlobal, target.mode, sessionId],
	);

	if (recent.length === 0) return null;

	return (
		<div className="start-rise px-4 pt-3 text-[12.5px] tabular-nums select-none">
			<div className="pb-1 text-[11.5px] text-[var(--text-dim)]">
				{t("home.continueRecent")}
			</div>
			<div className="divide-y divide-[var(--border-divider)]">
				{recent.map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => useUi.getState().selectSession(item.id)}
						title={sessionDisplayName(item)}
						className="flex w-full items-center justify-between gap-4 py-1.5 text-left transition-opacity hover:opacity-75 active:opacity-65 cursor-pointer"
					>
						<span className="inline-flex min-w-0 items-center gap-2 text-[var(--text)]">
							<History size={13} className="shrink-0 text-[var(--text-dim)]" />
							<span className="truncate">{sessionDisplayName(item)}</span>
						</span>
						<span className="shrink-0 whitespace-nowrap text-[11.5px] text-[var(--text-dim)]">
							{timeAgo(item.updatedAt)}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

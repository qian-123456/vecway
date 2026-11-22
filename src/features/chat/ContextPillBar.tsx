/**
 * Codex-style context pills on the top edge of the Composer card:
 * project (workspace) picker on the left, git branch picker on the right.
 */
import clsx from "clsx";
import {
	Check,
	ChevronDown,
	Folder,
	FolderPlus,
	GitBranch,
	Globe,
	Loader2,
	PanelRight,
	Plus,
	Tag,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FloatingLayer, usableViewport } from "../../components/FloatingLayer";
import type { BranchInfo, Workspace, WorktreeInfo } from "../../lib/contracts";
import { errMsg } from "../../lib/dialogs";
import { addWorkspace, gitBadge, gitListBranchesDetailed, gitListWorktrees, gitRepoRoot } from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { draftMeta, isLocalDraftId, usePendingSession } from "../sessions/pendingSession";
import { useComposer } from "../../stores/composer";
import { prewarmDraft } from "../sessions/draftSession";
import { requestMoveToGroup } from "../sessions/sessionActions";
import { useSessionGroups } from "../sessions/sessionGroups";
import { startSessionInDir, startSessionInWorktree } from "../sessions/newSession";
import { resolveSessionLocation } from "./sessionWorkspace";
import { runSessionBash, shellQuote } from "./sessionShell";
import { SearchInput } from "../../components/SearchInput";
import { claimEscape } from "../../lib/escapeClaim";
import { isComposing } from "../../lib/hooks";

import { useT } from "../../stores/language";
import { validateBranchName } from "./branchName";
const PILL =
	"inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-medium text-[var(--text-80,var(--text))] transition-colors hover:bg-[var(--ghost-hover,var(--bg-hover))] hover:text-[var(--text)] select-none cursor-pointer";
const ROW =
	"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text)] hover:bg-[var(--ghost-hover,var(--bg-hover))]";

function PopoverSearch({
	value,
	onChange,
	placeholder,
	onEnter,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder: string;
	onEnter?: () => void;
}) {
	return (
		<div className="border-b border-[var(--line,var(--border-divider))] px-1 py-0.5">
			<SearchInput
				autoFocus
				value={value}
				onChange={onChange}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !isComposing(e) && onEnter) {
						e.preventDefault();
						onEnter();
					}
				}}
				placeholder={placeholder}
				iconSize={13}
				inputClassName="w-full bg-transparent py-1.5 pl-8 pr-7 text-[12.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-30,var(--text-dim))]"
			/>
		</div>
	);
}

function ActionRow({
	icon,
	label,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<button type="button" onClick={onClick} className={clsx(ROW, "text-[var(--text-60,var(--text-muted))]")}>
			<span className="flex w-4 shrink-0 justify-center">{icon}</span>
			<span className="truncate">{label}</span>
		</button>
	);
}

export function WorkspacePickerPopover({
	anchor,
	ignoreRefs,
	activeWorkspaceId,
	mode,
	onSelectPath,
	placement = "top-start",
	onClose,
}: {
	anchor: HTMLElement | null;
	ignoreRefs: RefObject<HTMLElement | null>[];
	activeWorkspaceId: string | null;
	/** Filter project workspaces to a specific mode when provided. */
	mode?: Workspace["mode"];
	/** Override selection action (e.g. automation config editing) instead of starting/switching a session. */
	onSelectPath?: (path: string) => void;
	placement?: "top-start" | "bottom-start" | "bottom-end";
	onClose: () => void;
}) {
	const { t } = useT();
	const workspaces = useSessions((s) => s.workspaces);
	const [query, setQuery] = useState("");
	const projects = useMemo(() => {
		const q = query.trim().toLowerCase();
		return workspaces
			.filter((w) => w.kind !== "global" && (!mode || w.mode === mode))
			.filter((w) => !q || w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q))
			.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
	}, [workspaces, query, mode]);

	const switchOnSchedules = (ws: Workspace): boolean => {
		if (useUi.getState().centerView !== "schedules") return false;
		const pending = usePendingSession.getState();
		const cur = pending.selectedId ? pending.drafts[pending.selectedId] : undefined;
		const id = pending.open({
			cwd: ws.path,
			workspaceId: ws.id,
			mode: ws.mode,
			appendSystemPrompt: cur?.opts.appendSystemPrompt ?? null,
			automationMode: cur?.opts.automationMode,
		});
		useComposer.getState().focusComposer(id);
		return true;
	};

	const pick = (ws: Workspace) => {
		onClose();
		if (onSelectPath) {
			onSelectPath(ws.path);
			return;
		}
		if (ws.id === activeWorkspaceId) return;
		if (switchOnSchedules(ws)) return;
		void startSessionInDir(ws, false);
	};

	const browse = async () => {
		onClose();
		try {
			const selected = await openDialog({ directory: true, multiple: false, title: t("chat.pill.selectProjectDir") });
			const path = typeof selected === "string" ? selected : selected?.[0];
			if (!path) return;
			if (onSelectPath) {
				onSelectPath(path);
				return;
			}
			const ws = await addWorkspace(path);
			await useSessions.getState().refreshWorkspaces();
			if (switchOnSchedules(ws)) return;
			await startSessionInDir(ws, false);
		} catch (err) {
			toast.error(t("chat.pill.addWorkspaceFailed", { error: errMsg(err) }));
		}
	};

	const goGlobal = () => {
		onClose();
		const globalWs =
			workspaces.find((w) => w.kind === "global" && (!mode || w.mode === mode)) ??
			workspaces.find((w) => w.kind === "global");
		if (!globalWs) {
			toast.error(t("chat.pill.globalWorkspaceNotFound"));
			return;
		}
		if (onSelectPath) {
			onSelectPath(globalWs.path);
			return;
		}
		if (globalWs.id === activeWorkspaceId) return;
		if (switchOnSchedules(globalWs)) return;
		void startSessionInDir(globalWs, false);
	};

	return (
		<FloatingLayer
			anchor={anchor}
			placement={placement}
			offset={6}
			layer="popover"
			ignoreRefs={ignoreRefs}
			onDismiss={onClose}
			className="w-[300px] rounded-xl border-[var(--line,var(--border-divider))] !bg-[var(--bg-panel)]"
		>
			<PopoverSearch
				value={query}
				onChange={setQuery}
				placeholder={t("chat.pill.searchWorkspace")}
				onEnter={() => projects[0] && pick(projects[0])}
			/>
			<div className="max-h-64 overflow-y-auto p-1">
				{projects.length === 0 ? (
					<div className="px-2 py-2 text-[12px] text-[var(--text-40,var(--text-dim))]">{t("chat.pill.noMatchingWorkspace")}</div>
				) : (
					projects.map((ws) => (
						<button key={ws.id} type="button" onClick={() => pick(ws)} title={ws.path} className={ROW}>
							<Folder size={13} className="shrink-0 text-[var(--text-40,var(--text-dim))]" />
							<span className="min-w-0 flex-1 truncate">{ws.name}</span>
							{ws.id === activeWorkspaceId && <Check size={13} className="shrink-0" />}
						</button>
					))
				)}
			</div>
			<div className="border-t border-[var(--line,var(--border-divider))] p-1">
				<ActionRow icon={<FolderPlus size={13} />} label={t("chat.pill.newWorkspace")} onClick={() => void browse()} />
				<ActionRow icon={<Globe size={13} />} label={t("chat.pill.globalMode")} onClick={goGlobal} />
			</div>
		</FloatingLayer>
	);
}
export function CreateBranchDialog({
	resolveSession,
	initialName,
	onClose,
	onCreated,
}: {
	/** Resolves the live omp session that runs the git command (a draft starts its own on demand). */
	resolveSession: () => Promise<string>;
	initialName?: string;
	onClose: () => void;
	onCreated: () => void;
}) {
	const { t } = useT();
	const [prefix, setPrefix] = useState("omp/");
	const [branchName, setBranchName] = useState(initialName || prefix);
	const [busy, setBusy] = useState(false);
	const [editingPrefix, setEditingPrefix] = useState(false);
	const backdropPressedRef = useRef(false);
	const applyPrefix = () => {
		// Replace the untouched prefix-only name with the new prefix.
		setBranchName((cur) => (!cur || cur === lastPrefix.current ? prefix : cur));
		lastPrefix.current = prefix;
		setEditingPrefix(false);
	};
	const lastPrefix = useRef("omp/");

	const error = validateBranchName(branchName);
	const isValid = branchName.trim().length > 0 && !error;

	const handleCreate = async () => {
		if (!isValid || busy) return;
		setBusy(true);
		try {
			await runSessionBash(await resolveSession(), `git checkout -b ${shellQuote(branchName.trim())}`);
			toast.success(t("chat.pill.branchCreated", { name: branchName.trim() }));
			onCreated();
		} catch (err) {
			toast.error(t("chat.pill.createBranchFailed", { error: errMsg(err) }));
		} finally {
			setBusy(false);
		}
	};

	return createPortal(
		<div
			data-layer="modal"
			role="dialog"
			aria-modal="true"
			aria-label={t("chat.pill.createAndCheckoutBranch")}
			className="apple-modal-backdrop fixed inset-0 z-(--z-modal) flex items-center justify-center bg-[var(--overlay)] backdrop-blur-md p-4"
			onMouseDown={(e) => {
				backdropPressedRef.current = e.target === e.currentTarget;
			}}
			onClick={(e) => {
				const pressed = backdropPressedRef.current;
				backdropPressedRef.current = false;
				if (pressed && e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="apple-modal-panel apple-modal-surface w-[440px] max-w-[calc(100vw-2rem)] rounded-2xl hairline p-5 shadow-apple-modal text-[var(--text)]"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					if (isComposing(e)) return;
					if (e.key === "Escape") {
						e.stopPropagation();
						claimEscape(e);
						onClose();
					}
					if (e.key === "Enter" && isValid && !busy && !editingPrefix) {
						e.stopPropagation();
						void handleCreate();
					}
				}}
			>
				<div className="flex items-center justify-between mb-3.5">
					<h3 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">{t("chat.pill.createAndCheckoutBranch")}</h3>
					<button
						type="button"
						onClick={onClose}
						aria-label={t("common.close")}
						title={t("common.close")}
						className="rounded-lg p-1 text-[var(--text-40,var(--text-dim))] hover:bg-[var(--ghost-hover,var(--bg-hover))] hover:text-[var(--text)] transition-colors"
					>
						<X size={15} />
					</button>
				</div>

				<div className="mb-1.5 flex items-center justify-between text-xs">
					<label className="text-[12px] font-medium text-[var(--text-60,var(--text-muted))]">{t("chat.pill.branchName")}</label>
					{editingPrefix ? (
						<span className="flex items-center gap-1.5">
							<input
								autoFocus
								type="text"
								value={prefix}
								onChange={(e) => setPrefix(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !isComposing(e)) {
										e.preventDefault();
										e.stopPropagation();
										applyPrefix();
									}
								}}
								aria-label={t("chat.pill.defaultBranchPrefix")}
								className="w-28 rounded-md border border-[var(--line,var(--border-divider))] bg-[var(--well-bg,#18181b)] px-2 py-0.5 font-mono text-[11.5px] text-[var(--text)] outline-none"
							/>
							<button
								type="button"
								onClick={applyPrefix}
								className="whitespace-nowrap rounded-md border border-[var(--line,var(--border-divider))] px-2 py-0.5 text-[11.5px] text-[var(--text-60,var(--text-muted))] hover:bg-[var(--ghost-hover,var(--bg-hover))] hover:text-[var(--text)] transition-colors"
							>
								{t("chat.pill.apply")}
							</button>
						</span>
					) : (
						<button
							type="button"
							onClick={() => setEditingPrefix(true)}
							className="whitespace-nowrap rounded-md border border-[var(--line,var(--border-divider))] px-2 py-0.5 text-[11.5px] text-[var(--text-60,var(--text-muted))] hover:bg-[var(--ghost-hover,var(--bg-hover))] hover:text-[var(--text)] transition-colors"
						>
							{t("chat.pill.setPrefix")}
						</button>
					)}
				</div>

				<div className="relative mb-2">
					<input
						autoFocus
						type="text"
						value={branchName}
						onChange={(e) => setBranchName(e.target.value)}
						placeholder="codex/feature-name"
						className={clsx(
							"w-full rounded-xl border bg-[var(--well-bg,#18181b)] px-3 py-2 text-[13px] font-mono text-[var(--text)] outline-none transition-colors",
							error
								? "border-rose-500/80 focus:border-rose-500 ring-1 ring-rose-500/30"
								: "border-[var(--line,var(--border-divider))] focus:border-neutral-400 focus:ring-1 focus:ring-neutral-400/30",
						)}
					/>
				</div>

				{error && (
					<div className="mb-4 text-[12px] text-rose-400">
						{error}
					</div>
				)}

				<div className="flex items-center justify-end gap-2.5 mt-5">
					<button
						type="button"
						onClick={onClose}
						className="whitespace-nowrap rounded-xl border border-[var(--line,var(--border-divider))] px-4 py-2 text-[12.5px] font-medium text-[var(--text-60,var(--text-muted))] hover:bg-[var(--ghost-hover,var(--bg-hover))] hover:text-[var(--text)] transition-colors"
					>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						disabled={!isValid || busy}
						onClick={() => void handleCreate()}
						className="whitespace-nowrap rounded-xl bg-[var(--text)] px-4 py-2 text-[12.5px] font-semibold text-[var(--bg)] hover:opacity-90 disabled:opacity-35 transition-opacity"
					>
						{busy ? t("chat.pill.creating") : t("chat.pill.createAndCheckout")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

function BranchPickerPopover({
	anchor,
	ignoreRef,
	resolveSession,
	cwd,
	currentBranch,
	onChanged,
	onClose,
}: {
	anchor: HTMLElement | null;
	ignoreRef: RefObject<HTMLElement | null>;
	resolveSession: () => Promise<string>;
	cwd: string;
	currentBranch: string;
	onChanged: () => void;
	onClose: () => void;
}) {
	const { t } = useT();
	const [query, setQuery] = useState("");
	const [branches, setBranches] = useState<BranchInfo[] | null>(null);
	// branch name -> path of the *other* worktree that has it checked out
	// (git refuses `checkout` of such a branch).
	const [occupied, setOccupied] = useState<Record<string, string>>({});
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const root = (await gitRepoRoot(cwd).catch(() => null)) ?? cwd;
			const [list, wts] = await Promise.all([
				gitListBranchesDetailed(root).catch(() => []),
				gitListWorktrees(root).catch(() => []),
			]);
			if (cancelled) return;
			const here = cwd.replace(/\/+$/, "");
			const occ: Record<string, string> = {};
			for (const w of wts) {
				if (w.branch && w.path.replace(/\/+$/, "") !== here) occ[w.branch] = w.path;
			}
			setOccupied(occ);
			setBranches(list.filter((b) => !b.isRemote));
		})();
		return () => {
			cancelled = true;
		};
	}, [cwd]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));
	}, [branches, query]);

	const run = async (cmd: string, okMsg: string) => {
		onClose();
		try {
			await runSessionBash(await resolveSession(), cmd);
			toast.success(okMsg);
			onChanged();
		} catch (err) {
			toast.error(t("chat.pill.gitOpFailed", { error: errMsg(err) }));
		}
	};

	const checkout = (name: string) => {
		if (name === currentBranch) {
			onClose();
			return;
		}
		const other = occupied[name];
		if (other) {
			onClose();
			void startSessionInWorktree(other);
			return;
		}
		void run(`git checkout ${shellQuote(name)}`, t("chat.pill.switchedBranch", { name }));
	};

	const [showCreateDialog, setShowCreateDialog] = useState(false);
	// Pick the side once on open (from the room around the anchor) so typing /
	// loading, which resize the content, can never flip the popover.
	const [placement] = useState<"top-start" | "bottom-start">(() => {
		if (!(anchor instanceof Element)) return "top-start";
		const r = anchor.getBoundingClientRect();
		const vp = usableViewport();
		const above = r.top - 6 - vp.top;
		const below = vp.bottom - (r.bottom + 6);
		return above >= 380 || above >= below ? "top-start" : "bottom-start";
	});

	return (
		<FloatingLayer
			anchor={anchor}
			placement={placement}
			flip={false}
			offset={6}
			layer="popover"
			ignoreRefs={[ignoreRef]}
			onDismiss={onClose}
			className="flex w-[280px] flex-col !overflow-hidden rounded-xl border-[var(--line,var(--border-divider))] !bg-[var(--bg-panel)]"
		>
			<PopoverSearch
				value={query}
				onChange={setQuery}
				placeholder={t("chat.pill.searchBranch")}
				onEnter={() => {
					if (filtered[0]) {
						checkout(filtered[0].name);
					} else {
						setShowCreateDialog(true);
					}
				}}
			/>
			<div className="shrink-0 px-3 pt-2 pb-1 text-[11px] font-medium text-[var(--text-40,var(--text-dim))]">{t("chat.pill.branchSection")}</div>
			<div className="min-h-0 max-h-56 flex-1 overflow-y-auto px-1 pb-1">
				{branches === null ? (
					<div className="px-2 py-2 text-[12px] text-[var(--text-40,var(--text-dim))]">{t("common.loading")}</div>
				) : filtered.length === 0 ? (
					<div className="px-2 py-2 text-[12px] text-[var(--text-40,var(--text-dim))]">{t("chat.pill.noMatchingBranch")}</div>
				) : (
					filtered.map((b) => {
						const other = occupied[b.name];
						return (
							<button
								key={b.name}
								type="button"
								title={other ? t("chat.pill.worktreeExistsNewSession", { path: other }) : undefined}
								onClick={() => checkout(b.name)}
								className={ROW}
							>
								<GitBranch size={13} className="shrink-0 text-[var(--text-40,var(--text-dim))]" />
								<span className="min-w-0 flex-1 truncate">{b.displayName || b.name}</span>
								{other && (
									<span className="shrink-0 rounded-full border border-[var(--line,var(--border-divider))] px-1.5 text-[10.5px] text-[var(--text-40,var(--text-dim))]">
										{t("chat.pill.worktreeExistsSwitch")}
									</span>
								)}
								{b.name === currentBranch && <Check size={13} className="shrink-0" />}
							</button>
						);
					})
				)}
			</div>
			<div className="shrink-0 border-t border-[var(--line,var(--border-divider))] p-1">
				<ActionRow
					icon={<Plus size={13} />}
					label={query.trim() ? t("chat.pill.createAndCheckoutNamed", { name: query.trim() }) : t("chat.pill.createAndCheckoutNew")}
					onClick={() => setShowCreateDialog(true)}
				/>
				<ActionRow
					icon={<PanelRight size={13} />}
					label={t("chat.pill.openGitPanel")}
					onClick={() => {
						onClose();
						useUi.getState().setRightTab("git");
					}}
				/>
			</div>
			{showCreateDialog && (
				<CreateBranchDialog
					resolveSession={resolveSession}
					initialName={query.trim()}
					onClose={() => setShowCreateDialog(false)}
					onCreated={() => {
						setShowCreateDialog(false);
						onChanged();
						onClose();
					}}
				/>
			)}
		</FloatingLayer>
	);
}

export interface AutomationEarConfig {
	cwd: string;
	repoRoot?: string | null;
	workspaceMode?: Workspace["mode"];
	runMode: "local" | "worktree";
	isGitRepo: boolean;
	onChangeRunMode: (mode: "local" | "worktree") => void;
	onChangeCwd?: (cwd: string) => void;
	hasCwdError?: boolean;
	rightAction?: ReactNode;
}

function normPath(p: string): string {
	return p.replace(/[\\/]+$/, "");
}

function shortDirName(p: string): string {
	const cleaned = normPath(p);
	const parts = cleaned.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cleaned;
}

export function ContextPillBar({
	sessionId,
	onWorkspaceClick,
	workspaceBtnRef,
	automationEar,
}: {
	sessionId: string;
	/** Workspace pill click — Composer owns the picker so it can also be
	 * opened from the Add menu after this bar has unmounted. */
	onWorkspaceClick: () => void;
	workspaceBtnRef: RefObject<HTMLButtonElement | null>;
	/** Automation config ear mode: project picker + Worktree/run-location picker and optional right action. */
	automationEar?: AutomationEarConfig;
}) {
	const { t } = useT();
	const isDraft = !automationEar && isLocalDraftId(sessionId);
	const realMeta = useSessions((s) => (automationEar ? undefined : s.sessions[sessionId]));
	const draft = usePendingSession((s) => (isDraft ? s.drafts[sessionId] : undefined));
	const workspaces = useSessions((s) => s.workspaces);
	// draftMeta stamps new Dates, so it must be memoised, never built in a selector.
	const meta = useMemo(() => {
		if (automationEar) {
			return {
				cwd: automationEar.cwd,
				repoRoot: automationEar.repoRoot ?? null,
				workspaceId: "",
				mode: automationEar.workspaceMode ?? ("code" as Workspace["mode"]),
				kind: undefined,
				forkDepth: 0,
				groupId: null,
				git: undefined,
			};
		}
		return isDraft ? (draft ? draftMeta(draft) : undefined) : realMeta;
	}, [automationEar, isDraft, draft, realMeta]);
	// Display never spawns; only an actual git operation starts the draft's own retained process.
	const resolveSession = useCallback(
		() => (isDraft ? prewarmDraft(sessionId) : Promise.resolve(sessionId)),
		[isDraft, sessionId],
	);
	const cwd = meta?.cwd ?? "";
	// Resolve from the stored catalog facts (cwd / repoRoot / workspaceId) — a
	// session that was never started still knows where it lives, and 全局 is
	// only shown when the cwd really is the project-less workspace.
	const location = resolveSessionLocation(meta, workspaces);
	const isGlobal = location.kind === "global";
	// The stored global workspace name carries a "🌐 " prefix; the pill draws its own Globe icon.
	const wsLabel = isGlobal ? location.label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "") : location.label;
	const pillTitle =
		location.kind === "location"
			? t("chat.pill.pathNotInProjects", { path: location.path })
			: location.kind === "unknown"
				? t("chat.pill.noLinkedDir")
				: cwd || location.label;
	const groups = useSessionGroups((s) => s.groups);
	const group = !automationEar && isGlobal && meta?.groupId ? groups.find((g) => g.id === meta.groupId) : null;

	const branchRef = useRef<HTMLButtonElement>(null);
	const [branchOpen, setBranchOpen] = useState(false);
	const runModeRef = useRef<HTMLButtonElement>(null);
	const [runModeOpen, setRunModeOpen] = useState(false);
	const [earWorktrees, setEarWorktrees] = useState<WorktreeInfo[]>([]);
	const [branch, setBranch] = useState<string | null | undefined>(undefined);
	const [nonce, setNonce] = useState(0);
	const branchRefreshSession = useRef(sessionId);

	const earRepoLookup = automationEar?.isGitRepo
		? (automationEar.repoRoot?.trim() || automationEar.cwd.trim() || null)
		: null;
	useEffect(() => {
		if (!earRepoLookup) {
			setEarWorktrees([]);
			return;
		}
		let cancelled = false;
		void gitListWorktrees(earRepoLookup)
			.then((list) => {
				if (!cancelled) setEarWorktrees(list ?? []);
			})
			.catch(() => {
				if (!cancelled) setEarWorktrees([]);
			});
		return () => {
			cancelled = true;
		};
	}, [earRepoLookup, runModeOpen]);

	const { mainWorktree, linkedWorktrees, activeLinkedWorktree } = useMemo(() => {
		if (!automationEar || earWorktrees.length === 0) {
			return {
				mainWorktree: null as WorktreeInfo | null,
				linkedWorktrees: [] as WorktreeInfo[],
				activeLinkedWorktree: null as WorktreeInfo | null,
			};
		}
		const main = earWorktrees[0] ?? null;
		const mainPath = main ? normPath(main.path) : "";
		const linked = earWorktrees.filter((w) => normPath(w.path) !== mainPath);
		const curPath = normPath(automationEar.cwd);
		const activeLinked =
			linked.find((w) => normPath(w.path) === curPath) ?? null;
		return {
			mainWorktree: main,
			linkedWorktrees: linked,
			activeLinkedWorktree: activeLinked,
		};
	}, [automationEar, earWorktrees]);

	useEffect(() => {
		if (automationEar) return;
		// Session metadata is the source of truth for display; do not probe Git
		// merely to paint the composer for a stopped session. An explicit Git
		// operation may refresh its result once.
		if (!isDraft && (branchRefreshSession.current !== sessionId || nonce === 0)) {
			branchRefreshSession.current = sessionId;
			setBranch(meta?.git?.branch ?? null);
			return;
		}
		branchRefreshSession.current = sessionId;
		// A draft has no session metadata yet: read the branch straight from its cwd.
		if (isDraft && nonce === 0) setBranch(undefined);
		let cancelled = false;
		gitBadge(cwd)
			.then((b) => !cancelled && setBranch(b?.branch ?? null))
			.catch(() => !cancelled && setBranch(null));
		return () => {
			cancelled = true;
		};
	}, [automationEar, cwd, meta?.git?.branch, nonce, isDraft, sessionId]);

	// A side chat inherits its parent's workspace; the bar (and its divider line) would only add a stray rule above the composer.
	if (!automationEar && (meta?.kind === "side" || (meta?.forkDepth ?? 0) > 0)) return null;

	return (
		<div className="relative z-0 flex flex-wrap items-center justify-between gap-2 px-[22px]">
			<div
				className={clsx(
					"inline-flex max-w-full flex-wrap items-center gap-x-1 gap-y-0.5 rounded-t-[14px] border border-b-0 bg-[var(--bg-ear)] px-2.5 pt-1 pb-2.5 -mb-2 text-[var(--text-60,var(--text-muted))]",
					automationEar?.hasCwdError
						? "border-rose-500/50"
						: "border-[var(--composer-border,var(--border))]",
				)}
			>
				<button
					ref={workspaceBtnRef}
					type="button"
					onClick={onWorkspaceClick}
					title={pillTitle}
					className={clsx(PILL, automationEar?.hasCwdError && "text-rose-400")}
				>
					{isGlobal ? (
						<Globe size={13} className="shrink-0 text-[var(--text-muted)]" />
					) : (
						<Folder size={13} className="shrink-0 text-[var(--text-muted)]" />
					)}
					<span className="max-w-52 truncate">{wsLabel}</span>
					<ChevronDown size={11} className="shrink-0 text-[var(--text-40,var(--text-dim))]" />
				</button>

				{automationEar ? (
					<>
						<span aria-hidden="true" className="h-3 w-px shrink-0 bg-[var(--border)]" />
						<button
							ref={runModeRef}
							type="button"
							onClick={() => setRunModeOpen((v) => !v)}
							title={t("schedules.configWorktreeTooltip")}
							className={PILL}
						>
							<GitBranch
								size={12.5}
								className={clsx(
									"shrink-0",
									automationEar.runMode === "worktree"
										? "text-[var(--text)]"
										: "text-[var(--text-muted)]",
								)}
							/>
							<span className="max-w-44 truncate whitespace-nowrap">
								{automationEar.runMode === "worktree"
									? t("schedules.runModeWorktree")
									: activeLinkedWorktree
										? (activeLinkedWorktree.branch || shortDirName(activeLinkedWorktree.path))
										: t("schedules.runModeLocal")}
							</span>
							<ChevronDown size={11} className="shrink-0 text-[var(--text-40,var(--text-dim))]" />
						</button>
						{runModeOpen && (
							<FloatingLayer
								anchor={runModeRef.current}
								placement="bottom-start"
								offset={6}
								layer="popover"
								ignoreRefs={[runModeRef]}
								onDismiss={() => setRunModeOpen(false)}
								className="max-h-[340px] w-[320px] overflow-y-auto rounded-xl border-[var(--line,var(--border-divider))] !bg-[var(--bg-panel)] p-1"
							>
								<button
									type="button"
									onClick={() => {
										setRunModeOpen(false);
										if (mainWorktree && automationEar.onChangeCwd && normPath(automationEar.cwd) !== normPath(mainWorktree.path)) {
											automationEar.onChangeCwd(mainWorktree.path);
										}
										automationEar.onChangeRunMode("local");
									}}
									className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-[var(--ghost-hover,var(--bg-hover))]"
								>
									<Folder size={13.5} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text)]">
											<span className="whitespace-nowrap">{t("schedules.runModeLocal")}</span>
											{mainWorktree?.branch && (
												<span className="truncate rounded bg-[var(--bg-hover)] px-1.5 py-0.5 font-mono text-[10.5px] font-normal text-[var(--text-60)]">
													{mainWorktree.branch}
												</span>
											)}
										</span>
										<span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-40,var(--text-dim))]">
											{t("schedules.runModeLocalDesc")}
										</span>
									</span>
									{automationEar.runMode === "local" && !activeLinkedWorktree && (
										<Check size={13} className="mt-0.5 shrink-0 text-[var(--text)]" />
									)}
								</button>

								{linkedWorktrees.length > 0 && automationEar.onChangeCwd && (
									<>
										<div className="my-1 border-t border-[var(--line,var(--border-divider))]" />
										<div className="px-2.5 pt-1 pb-1 text-[10.5px] font-medium text-[var(--text-40,var(--text-dim))]">
											{t("schedules.runModeExistingWorktreesHeader")} ({linkedWorktrees.length})
										</div>
										{linkedWorktrees.map((wt) => {
											const selected =
												automationEar.runMode === "local" &&
												normPath(automationEar.cwd) === normPath(wt.path);
											const label = wt.branch || shortDirName(wt.path);
											return (
												<button
													key={wt.path}
													type="button"
													onClick={() => {
														setRunModeOpen(false);
														automationEar.onChangeCwd?.(wt.path);
														automationEar.onChangeRunMode("local");
													}}
													className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--ghost-hover,var(--bg-hover))]"
												>
													<GitBranch size={13} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
													<span className="min-w-0 flex-1">
														<span className="block truncate text-[12.5px] font-medium text-[var(--text)]">
															{label}
														</span>
														<span className="mt-0.5 block truncate text-[11px] text-[var(--text-40,var(--text-dim))]" title={wt.path}>
															{shortDirName(wt.path)} · {t("schedules.runModeExistingWorktreeDesc")}
														</span>
													</span>
													{selected && (
														<Check size={13} className="mt-0.5 shrink-0 text-[var(--text)]" />
													)}
												</button>
											);
										})}
									</>
								)}

								<div className="my-1 border-t border-[var(--line,var(--border-divider))]" />
								<button
									type="button"
									disabled={!automationEar.isGitRepo}
									onClick={() => {
										setRunModeOpen(false);
										automationEar.onChangeRunMode("worktree");
									}}
									className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-[var(--ghost-hover,var(--bg-hover))] disabled:cursor-not-allowed disabled:opacity-45"
								>
									<GitBranch size={13.5} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
									<span className="min-w-0 flex-1">
										<span className="block text-[12.5px] font-medium text-[var(--text)]">
											{t("schedules.runModeWorktree")}
										</span>
										<span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-40,var(--text-dim))]">
											{automationEar.isGitRepo
												? t("schedules.runModeWorktreeDesc")
												: t("schedules.runModeWorktreeDisabled")}
										</span>
									</span>
									{automationEar.runMode === "worktree" && (
										<Check size={13} className="mt-0.5 shrink-0 text-[var(--text)]" />
									)}
								</button>
							</FloatingLayer>
						)}
					</>
				) : (
					<>
						{group && isDraft && (
							<>
								<span aria-hidden="true" className="h-3 w-px shrink-0 bg-[var(--border)]" />
								<span title={t("chat.pill.currentGroup", { name: group.name })} className={PILL}>
									<Tag size={12.5} className="shrink-0 text-[var(--text-muted)]" />
									<span className="max-w-40 truncate">{group.name}</span>
								</span>
							</>
						)}
						{group && !isDraft && (
							<>
								<span aria-hidden="true" className="h-3 w-px shrink-0 bg-[var(--border)]" />
								<button
									type="button"
									onClick={() => requestMoveToGroup([sessionId])}
									title={t("chat.pill.currentGroup", { name: group.name })}
									className={PILL}
								>
									<Tag size={12.5} className="shrink-0 text-[var(--text-muted)]" />
									<span className="max-w-40 truncate">{group.name}</span>
								</button>
							</>
						)}

						{branch === null ? (
							<>
								<span aria-hidden="true" className="h-3 w-px shrink-0 bg-[var(--border)]" />
								<span className="px-2 py-0.5 text-[12px] text-[var(--text-40,var(--text-dim))]">{t("chat.pill.noGitRepo")}</span>
							</>
						) : branch !== undefined ? (
							<>
								<span aria-hidden="true" className="h-3 w-px shrink-0 bg-[var(--border)]" />
								<button
									ref={branchRef}
									type="button"
									onClick={() => setBranchOpen((v) => !v)}
									title={t("chat.pill.currentBranch", { branch })}
									className={PILL}
								>
									<GitBranch size={12.5} className="shrink-0 text-[var(--text-muted)]" />
									<span className="max-w-44 truncate">{branch}</span>
									<ChevronDown size={11} className="shrink-0 text-[var(--text-40,var(--text-dim))]" />
								</button>
								{branchOpen && (
									<BranchPickerPopover
										anchor={branchRef.current}
										ignoreRef={branchRef}
										resolveSession={resolveSession}
										cwd={cwd}
										currentBranch={branch}
										onChanged={() => setNonce((n) => n + 1)}
										onClose={() => setBranchOpen(false)}
									/>
								)}
							</>
						) : (
							<>
								<span aria-hidden="true" className="h-3 w-px shrink-0 bg-[var(--border)]" />
								<span className="flex items-center gap-1.5 px-2 py-0.5 text-[12px] text-[var(--text-40,var(--text-dim))]">
									<Loader2 size={11.5} className="animate-spin" />
									{t("chat.pill.loadingBranch")}
								</span>
							</>
						)}
					</>
				)}
			</div>
			{automationEar?.rightAction}
		</div>
	);
}

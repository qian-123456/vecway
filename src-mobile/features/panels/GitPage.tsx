import {
	AlertTriangle,
	ArrowLeft,
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	FileDiff,
	GitBranch,
	GitCommitHorizontal,
	MinusCircle,
	MoreHorizontal,
	Plus,
	PlusCircle,
	RefreshCw,
	RotateCcw,
	Search,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../core/api";
import { copyText, relTime, sessionName } from "../../core/lib/format";
import { nav, paths, type PageProps } from "../../core/nav";
import { useSessions } from "../../core/stores/sessions";
import { STATUS_LABEL, isDraftId } from "../../core/types";
import {
	BottomSheet,
	Button,
	Dialog,
	DiffView,
	EmptyState,
	IconButton,
	ListGroup,
	ListRow,
	MenuRow,
	PageHeader,
	PullToRefresh,
	confirm,
	inputCls,
	toast,
} from "../../ui";
import { abbreviateHomePath } from "../sessions/NewSessionSheet";
import type { SessionTree, Subgroup } from "../sessions/tree";
import { ErrorState, LoadGate, Loading } from "./PanelState";
import { useLayer, useLoad } from "./hooks";
import { fenced, splitPath, type GitFile } from "./pure";
import { useRightDrawer } from "./rightDrawerStore";

interface GitStatus {
	isRepo: boolean;
	branch: string | null;
	files: GitFile[];
	truncated?: boolean;
}
interface Commit {
	sha: string;
	short: string;
	subject: string;
	author: string;
	ts: string;
}
interface BranchInfo {
	name: string;
	displayName: string;
	isRemote: boolean;
	remote: string | null;
	upstream: string | null;
	isCurrentWorktree: boolean;
	lastCommitSha: string | null;
	lastCommitMessage: string | null;
	lastCommitTime: string | null;
	ahead: number;
	behind: number;
	isMerged: boolean;
}

type DiffTarget =
	| { kind: "file"; title: string; filePath: string; query: string }
	| { kind: "commit"; title: string; commit: Commit; query: string };

type GitTab = "changes" | "commits" | "topology";

const q = encodeURIComponent;

const FILES_PAGE_SIZE = 30;
const COMMITS_INITIAL = 15;
const COMMITS_STEP = 20;
const WORKTREE_COLLAPSE_AT = 5;

const GIT_FILE_STATUS_LABEL: Record<string, string> = {
	M: "修改",
	A: "新增",
	D: "删除",
	R: "重命名",
	"??": "新文件",
};

const KNOWN_COMMIT_TYPES: Record<string, string> = {
	feat: "bg-m-accent-soft text-m-accent-soft-text",
	fix: "bg-m-danger-bg text-m-danger",
	refactor: "bg-m-surface-2 text-m-text-2",
	docs: "bg-m-surface-2 text-m-text-2",
	test: "bg-m-success-bg text-m-success",
	chore: "bg-m-surface-2 text-m-text-3",
	perf: "bg-m-warn-bg text-m-warn",
	style: "bg-m-surface-2 text-m-text-3",
	build: "bg-m-surface-2 text-m-text-3",
	ci: "bg-m-surface-2 text-m-text-3",
	revert: "bg-m-danger-bg text-m-danger",
};

function parseCommitSubject(subject: string): { badge: string | null; badgeCls: string; text: string } {
	const m = /^([a-zA-Z]+)(?:\([^)]*\))?!?:[ \t]*(.+)$/.exec(subject);
	if (m) {
		const kind = m[1].toLowerCase();
		if (KNOWN_COMMIT_TYPES[kind]) {
			return { badge: kind, badgeCls: KNOWN_COMMIT_TYPES[kind], text: m[2].trim() };
		}
	}
	return { badge: null, badgeCls: "", text: subject };
}

function commitDayLabel(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "更早";
	const now = new Date();
	const dayKey = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
	if (dayKey(d) === dayKey(now)) return "今天";
	const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	if (dayKey(d) === dayKey(yest)) return "昨天";
	if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
	return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

interface DiffFileSection {
	path: string;
	additions: number;
	deletions: number;
	patch: string;
}

function parseDiffFiles(rawDiff: string): DiffFileSection[] {
	const text = rawDiff.trim();
	if (!text) return [];
	const parts = text.split(/(?=^diff --git )/m).filter((p) => p.trim().length > 0);
	if (parts.length === 0) return [];
	const sections: DiffFileSection[] = [];
	for (const part of parts) {
		const lines = part.split("\n");
		const header = lines[0] ?? "";
		const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
		if (!m) continue;
		const path = m[2];
		let additions = 0;
		let deletions = 0;
		for (let i = 1; i < lines.length; i++) {
			const ln = lines[i];
			if (ln.startsWith("+++") || ln.startsWith("---")) continue;
			if (ln.startsWith("+")) additions++;
			else if (ln.startsWith("-")) deletions++;
		}
		sections.push({ path, additions, deletions, patch: part });
	}
	return sections;
}

export async function gitCommitSuggest(base: string): Promise<string> {
	const res = await api<{ suggestion?: string }>("POST", `${base}/suggest`);
	return res?.suggestion ?? "";
}

function statusLetter(status: string): { letter: string; cls: string } {
	if (status === "??" || status === "A") return { letter: status === "??" ? "?" : "A", cls: "text-m-success" };
	if (status === "D") return { letter: "D", cls: "text-m-danger" };
	if (status === "R") return { letter: "R", cls: "text-m-accent" };
	return { letter: status.slice(0, 1) || "M", cls: "text-m-warn" };
}

function pathMatchesOrInside(target: string | null | undefined, root: string | null | undefined): boolean {
	if (!target || !root) return false;
	const a = target.replace(/\/+$/, "");
	const b = root.replace(/\/+$/, "");
	return a === b || a.startsWith(`${b}/`);
}

function resolveWorktrees(
	tree: SessionTree | null | undefined,
	sessionId: string,
	sessionCwd?: string | null,
	workspaceId?: string | null,
): Subgroup[] {
	if (!tree?.workspaceGroups?.length) return [];
	const group =
		tree.workspaceGroups.find((g) => workspaceId && g.workspace.id === workspaceId) ??
		tree.workspaceGroups.find((g) =>
			g.subgroups.some(
				(sub) =>
					sub.sessions.some((s) => s.id === sessionId) ||
					(sessionCwd && (sub.path === sessionCwd || sub.createCwd === sessionCwd)),
			),
		) ??
		tree.workspaceGroups.find((g) => pathMatchesOrInside(sessionCwd, g.workspace.path));
	if (!group) return [];
	return group.subgroups.filter((sub) => sub.kind === "worktree" && !sub.deleted);
}

type GitOp =
	| { kind: "idle" }
	| { kind: "suggesting"; seq: number }
	| { kind: "aiSaving"; seq: number }
	| { kind: "committing"; seq: number }
	| { kind: "fileOp"; seq: number; path: string };

export function GitPanel({
	sessionId,
	embedded = false,
	active = true,
	visible = true,
}: {
	sessionId: string;
	embedded?: boolean;
	active?: boolean;
	visible?: boolean;
}) {
	const isActive = active && visible;
	const draft = isDraftId(sessionId);
	const base = `/sessions/${q(sessionId)}/git`;
	const session = useSessions((s) => s.byId[sessionId]);
	const [diff, setDiff] = useState<DiffTarget | null>(null);
	const [refreshNonce, setRefreshNonce] = useState(0);
	const [selectedWorktree, setSelectedWorktree] = useState<Subgroup | null>(null);
	const [creatingWtSession, setCreatingWtSession] = useState(false);

	const [manualTab, setManualTab] = useState<GitTab | null>(null);
	const [fileQuery, setFileQuery] = useState("");
	const [showAllFiles, setShowAllFiles] = useState(false);
	const [commitQuery, setCommitQuery] = useState("");
	const [commitLimit, setCommitLimit] = useState(COMMITS_INITIAL);
	const [topologyQuery, setTopologyQuery] = useState("");
	const [showAllWorktrees, setShowAllWorktrees] = useState(false);
	const [showRemoteBranches, setShowRemoteBranches] = useState(false);

	const [commitOpen, setCommitOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [op, setOpState] = useState<GitOp>({ kind: "idle" });
	const opRef = useRef<GitOp>({ kind: "idle" });
	const opSeq = useRef(0);
	const userEditedRef = useRef(false);
	const [commitError, setCommitError] = useState<string | null>(null);
	const [actionFile, setActionFile] = useState<GitFile | null>(null);
	const [branches, setBranches] = useState<BranchInfo[] | null>(null);
	const [branchLoading, setBranchLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const branchSeq = useRef(0);

	const closeDiff = () => setDiff(null);
	useLayer(isActive && diff !== null, closeDiff);

	const statusState = useLoad(
		(signal) =>
			draft
				? Promise.resolve<GitStatus>({ isRepo: false, branch: null, files: [] })
				: api<GitStatus>("GET", `${base}/status`, undefined, { signal }),
		[base, draft, refreshNonce],
	);
	const logState = useLoad(
		(signal) =>
			draft
				? Promise.resolve<Commit[]>([])
				: api<Commit[] | { commits?: Commit[] }>("GET", `${base}/log?limit=50`, undefined, { signal }),
		[base, draft, refreshNonce],
	);
	const treeState = useLoad(
		(signal) =>
			draft
				? Promise.resolve<SessionTree | null>(null)
				: api<SessionTree>("GET", `/left/sessions${session?.mode ? `?mode=${q(session.mode)}` : ""}`, undefined, { signal }).catch(() => null),
		[draft, session?.mode, refreshNonce],
	);

	const refreshAll = useCallback(() => {
		setRefreshNonce((n) => n + 1);
	}, []);

	const loadBranches = useCallback(async () => {
		if (draft) return;
		const mine = ++branchSeq.current;
		setBranchLoading(true);
		setBranchError(null);
		try {
			const list = await api<BranchInfo[] | { branches?: BranchInfo[] }>("GET", `${base}/branches`);
			if (mine !== branchSeq.current) return;
			setBranches(Array.isArray(list) ? list : Array.isArray(list?.branches) ? list.branches : []);
		} catch (e) {
			if (mine !== branchSeq.current) return;
			setBranchError(errorMessage(e));
		} finally {
			if (mine === branchSeq.current) setBranchLoading(false);
		}
	}, [base, draft]);

	useEffect(() => {
		if (!draft && statusState.data?.isRepo) {
			void loadBranches();
		}
	}, [draft, statusState.data?.isRepo, refreshNonce, loadBranches]);

	const refreshButton = useMemo(
		() => (
			<IconButton
				variant="plain"
				size={embedded ? "sm" : "md"}
				icon={<RefreshCw size={17} strokeWidth={1.75} />}
				label="刷新 Git 状态"
				onClick={refreshAll}
			/>
		),
		[embedded, refreshAll],
	);

	useEffect(() => {
		if (!embedded) return;
		useRightDrawer.getState().setTabHeader(sessionId, "git", {
			title: "Git",
			subtitle: statusState.data?.isRepo ? statusState.data.branch ?? "游离 HEAD" : undefined,
			rightAction: draft ? undefined : refreshButton,
		});
	}, [embedded, sessionId, draft, statusState.data?.isRepo, statusState.data?.branch, refreshButton]);

	useEffect(() => {
		if (!embedded) return;
		return () => {
			useRightDrawer.getState().clearTabHeader(sessionId, "git");
		};
	}, [embedded, sessionId]);

	const files = Array.isArray(statusState.data?.files) ? statusState.data.files : [];
	const worktrees = useMemo(
		() => resolveWorktrees(treeState.data, sessionId, session?.cwd, session?.workspaceId),
		[treeState.data, sessionId, session?.cwd, session?.workspaceId],
	);
	const commits = useMemo(() => {
		const raw = logState.data;
		if (Array.isArray(raw)) return raw;
		if (raw && Array.isArray(raw.commits)) return raw.commits;
		return [];
	}, [logState.data]);

	const activeTab: GitTab = manualTab ?? (files.length > 0 ? "changes" : "commits");
	const stagedCount = useMemo(() => files.filter((f) => f.staged).length, [files]);
	const unstagedCount = useMemo(() => files.filter((f) => f.unstaged || f.status === "??").length, [files]);
	const currentBranchInfo = useMemo(
		() => branches?.find((b) => b.isCurrentWorktree) ?? null,
		[branches],
	);

	const setOp = (next: GitOp) => {
		opRef.current = next;
		setOpState(next);
	};
	const isCurrentOp = (kind: Exclude<GitOp["kind"], "idle">, seq: number) =>
		opRef.current.kind === kind && opRef.current.seq === seq;

	const suggesting = op.kind === "suggesting";
	const aiSaving = op.kind === "aiSaving";
	const committing = op.kind === "committing";
	const fileOperating = op.kind === "fileOp";
	const busy = op.kind !== "idle";

	const stageAndCommit = async (msg: string) => {
		const pendingPaths = files.filter((f) => f.unstaged || f.status === "??").map((f) => f.path);
		if (pendingPaths.length > 0) {
			await api("POST", `${base}/stage`, { paths: pendingPaths });
		}
		await api("POST", `${base}/commit`, { message: msg });
		setCommitOpen(false);
		setMessage("");
		userEditedRef.current = false;
		toast(statusState.data?.truncated ? "已提交当前列表内改动" : "已提交全部改动", { kind: "success" });
		refreshAll();
	};

	const generateSuggestion = async () => {
		if (opRef.current.kind === "aiSaving" || opRef.current.kind === "committing" || opRef.current.kind === "fileOp") return;
		const mine = ++opSeq.current;
		userEditedRef.current = false;
		setOp({ kind: "suggesting", seq: mine });
		setCommitError(null);
		try {
			const text = await gitCommitSuggest(base);
			if (!isCurrentOp("suggesting", mine)) return;
			if (!userEditedRef.current) {
				if (text) setMessage(text);
				else toast("没能生成提交说明，可手动填写", { kind: "info" });
			}
		} catch (e) {
			if (isCurrentOp("suggesting", mine)) {
				setCommitError(`AI 生成失败：${errorMessage(e)}`);
			}
		} finally {
			if (isCurrentOp("suggesting", mine)) setOp({ kind: "idle" });
		}
	};

	const saveWithAi = async () => {
		if (opRef.current.kind !== "idle") return;
		const mine = ++opSeq.current;
		setOp({ kind: "aiSaving", seq: mine });
		setCommitError(null);
		try {
			const suggested = (await gitCommitSuggest(base)).trim();
			if (!isCurrentOp("aiSaving", mine)) return;
			if (!suggested) {
				setCommitOpen(true);
				toast("没能生成提交说明，可手动填写", { kind: "info" });
				return;
			}
			await stageAndCommit(suggested);
		} catch (e) {
			if (isCurrentOp("aiSaving", mine)) {
				setCommitError(errorMessage(e));
				setCommitOpen(true);
			}
		} finally {
			if (isCurrentOp("aiSaving", mine)) setOp({ kind: "idle" });
		}
	};

	const openCommitModal = () => {
		if (opRef.current.kind === "aiSaving" || opRef.current.kind === "committing" || opRef.current.kind === "fileOp") return;
		setCommitOpen(true);
		setCommitError(null);
		setMessage("");
		userEditedRef.current = false;
		void generateSuggestion();
	};

	const closeCommitModal = () => {
		if (opRef.current.kind === "committing") return;
		opSeq.current++;
		if (opRef.current.kind === "suggesting") setOp({ kind: "idle" });
		setCommitOpen(false);
	};

	const commitAll = async () => {
		const msg = message.trim();
		if (!msg || opRef.current.kind === "committing" || opRef.current.kind === "aiSaving" || opRef.current.kind === "fileOp") return;
		const mine = ++opSeq.current;
		setOp({ kind: "committing", seq: mine });
		setCommitError(null);
		try {
			await stageAndCommit(msg);
		} catch (e) {
			if (isCurrentOp("committing", mine)) setCommitError(errorMessage(e));
		} finally {
			if (isCurrentOp("committing", mine)) setOp({ kind: "idle" });
		}
	};

	const runFileOp = async (f: GitFile, fn: () => Promise<void>, okText: string) => {
		if (opRef.current.kind !== "idle") return;
		const mine = ++opSeq.current;
		setOp({ kind: "fileOp", seq: mine, path: f.path });
		try {
			await fn();
			toast(okText, { kind: "success" });
			refreshAll();
		} catch (e) {
			toast(`操作失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			if (isCurrentOp("fileOp", mine)) setOp({ kind: "idle" });
		}
	};

	const discardFile = async (f: GitFile) => {
		const isUntracked = f.status === "??";
		setActionFile(null);
		const ok = await confirm({
			title: isUntracked ? "删除未跟踪文件" : "丢弃工作区改动",
			message: isUntracked
				? `确定删除未跟踪文件 ${f.path}？此操作不可撤销。`
				: `确定丢弃 ${f.path} 的未暂存改动？此操作不可撤销。`,
			confirmText: isUntracked ? "删除" : "丢弃",
			danger: true,
		});
		if (!ok) return;
		await runFileOp(
			f,
			() => api("POST", `${base}/discard`, { path: f.path, untracked: isUntracked }),
			isUntracked ? "已删除未跟踪文件" : "已丢弃改动",
		);
	};

	const openFileDiff = (f: GitFile) => {
		const { name } = splitPath(f.path);
		setDiff({
			kind: "file",
			title: name,
			filePath: f.path,
			query: `path=${q(f.path)}&staged=${f.staged && !f.unstaged}`,
		});
	};

	const sendFileToMain = (f: GitFile) => {
		useRightDrawer.getState().sendToMainChat(sessionId, {
			quote: `文件：\`${f.path}\``,
			comment: `请帮我审查或修改 \`${f.path}\`：`,
			sourceLabel: `Git 改动 · ${f.path}`,
		});
		setActionFile(null);
		if (!embedded) nav.push(paths.chat(sessionId));
	};

	const sendCommitQuickToMain = (c: Commit) => {
		useRightDrawer.getState().sendToMainChat(sessionId, {
			quote: `Commit ${c.short} (${c.subject})`,
			comment: `请帮我审查提交 ${c.short}（${c.subject}）的改动是否有风险或遗漏：`,
			sourceLabel: `Git 提交 · ${c.short}`,
		});
		if (!embedded) nav.push(paths.chat(sessionId));
	};

	const createSessionInWorktree = async (wt: Subgroup) => {
		const cwd = wt.createCwd || wt.path;
		if (!cwd || creatingWtSession) return;
		setCreatingWtSession(true);
		try {
			const created = await useSessions.getState().createSession({
				cwd,
				...(session?.mode ? { mode: session.mode } : {}),
			});
			setSelectedWorktree(null);
			if (embedded) useRightDrawer.getState().closeDrawer();
			nav.push(paths.chat(created.id));
		} catch (e) {
			toast(`创建会话失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setCreatingWtSession(false);
		}
	};

	if (draft) {
		const empty = <EmptyState icon={<GitBranch size={22} strokeWidth={1.75} />} title="当前为新草稿" hint="发送第一条消息后可查看仓库改动" />;
		return embedded ? (
			<div className="flex h-full min-h-0 flex-1 flex-col bg-m-bg">{empty}</div>
		) : (
			<div className="flex h-full flex-col bg-m-bg">
				<PageHeader title="Git" onBack={() => nav.back()} />
				{empty}
			</div>
		);
	}

	const actionInfo = actionFile ? splitPath(actionFile.path) : null;

	const filteredFiles = useMemo(() => {
		const term = fileQuery.trim().toLowerCase();
		if (!term) return files;
		return files.filter((f) => f.path.toLowerCase().includes(term));
	}, [files, fileQuery]);
	const visibleFiles = showAllFiles ? filteredFiles : filteredFiles.slice(0, FILES_PAGE_SIZE);

	const filteredCommits = useMemo(() => {
		const term = commitQuery.trim().toLowerCase();
		if (!term) return commits;
		return commits.filter(
			(c) =>
				c.subject.toLowerCase().includes(term) ||
				c.author.toLowerCase().includes(term) ||
				c.short.toLowerCase().includes(term),
		);
	}, [commits, commitQuery]);
	const visibleCommits = filteredCommits.slice(0, commitLimit);
	const groupedCommits = useMemo(() => {
		const groups: { day: string; items: { commit: Commit; isHead: boolean }[] }[] = [];
		const headSha = commits[0]?.sha;
		for (const c of visibleCommits) {
			const day = commitDayLabel(c.ts);
			const last = groups[groups.length - 1];
			const entry = { commit: c, isHead: c.sha === headSha };
			if (last && last.day === day) last.items.push(entry);
			else groups.push({ day, items: [entry] });
		}
		return groups;
	}, [visibleCommits, commits]);

	const sortedWorktrees = useMemo(() => {
		const isCurrent = (wt: Subgroup) =>
			wt.sessions.some((s) => s.id === sessionId) ||
			Boolean(session?.cwd && (wt.path === session.cwd || wt.createCwd === session.cwd));
		const term = topologyQuery.trim().toLowerCase();
		const list = term
			? worktrees.filter((wt) => wt.label.toLowerCase().includes(term) || wt.path?.toLowerCase().includes(term))
			: worktrees;
		return [...list].sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)));
	}, [worktrees, sessionId, session?.cwd, topologyQuery]);
	const visibleWorktrees = showAllWorktrees || topologyQuery.trim() !== ""
		? sortedWorktrees
		: sortedWorktrees.slice(0, WORKTREE_COLLAPSE_AT);

	const { localBranches, remoteBranches } = useMemo(() => {
		const term = topologyQuery.trim().toLowerCase();
		const list = (branches ?? []).filter((b) => !term || b.name.toLowerCase().includes(term));
		return {
			localBranches: list.filter((b) => !b.isRemote),
			remoteBranches: list.filter((b) => b.isRemote),
		};
	}, [branches, topologyQuery]);

	const showStickyCommitBar = activeTab === "changes" && files.length > 0;

	const body = (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
			<LoadGate state={statusState}>
				{(st) => {
					if (!st.isRepo) {
						return <EmptyState icon={<GitBranch size={22} strokeWidth={1.75} />} title="当前目录不是 Git 仓库" />;
					}
					const syncLabel =
						currentBranchInfo && (currentBranchInfo.ahead > 0 || currentBranchInfo.behind > 0)
							? `↑${currentBranchInfo.ahead} ↓${currentBranchInfo.behind}`
							: null;
					const statusLine =
						files.length === 0
							? "工作区干净，暂无未提交改动"
							: `${stagedCount} 已暂存 · ${unstagedCount} 未暂存${st.truncated ? "（列表已截断）" : ""}`;

					return (
						<div className="flex min-h-0 flex-1 flex-col">
							{/* Fixed 2-row summary card + 3-tab bar: never crowded out by worktrees or files */}
							<div className="shrink-0 space-y-2.5 border-b border-m-border bg-m-bg px-4 pt-2 pb-2.5">
								<div className="rounded-m-lg border border-m-border/70 bg-m-surface px-3.5 py-2.5">
									<div className="flex items-center justify-between gap-2">
										<div className="flex min-w-0 items-center gap-1.5">
											<GitBranch size={14} strokeWidth={1.9} className="shrink-0 text-m-accent" aria-hidden />
											<span className="truncate text-[13.5px] font-semibold text-m-text">
												{st.branch ?? "游离 HEAD"}
											</span>
											{syncLabel && (
												<span className="shrink-0 rounded-m-pill bg-m-surface-2 px-1.5 py-0.5 font-m-mono text-[10.5px] whitespace-nowrap text-m-text-2">
													{syncLabel}
												</span>
											)}
										</div>
										{worktrees.length > 0 && (
											<button
												type="button"
												onClick={() => setManualTab("topology")}
												className="m-press shrink-0 rounded-m-pill bg-m-bg-elev px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-m-accent active:bg-m-surface-hover"
											>
												{worktrees.length} 个工作树 ›
											</button>
										)}
									</div>
									<div className="mt-1 truncate text-[11.5px] text-m-text-3">{statusLine}</div>
								</div>

								<div role="tablist" aria-label="Git 视图" className="grid grid-cols-3 gap-1 rounded-m-md bg-m-surface p-1">
									{(
										[
											{ id: "changes", label: `改动 (${files.length}${st.truncated ? "+" : ""})` },
											{ id: "commits", label: `提交 (${commits.length})` },
											{ id: "topology", label: worktrees.length > 0 ? `分支/树 (${worktrees.length})` : "分支" },
										] as const
									).map((tab) => {
										const selected = activeTab === tab.id;
										return (
											<button
												key={tab.id}
												type="button"
												role="tab"
												aria-selected={selected}
												onClick={() => setManualTab(tab.id)}
												className={`m-press min-h-8 rounded-m-sm px-2 text-[12px] font-medium whitespace-nowrap transition-colors ${
													selected ? "bg-m-bg-elev text-m-text shadow-xs" : "text-m-text-3 active:text-m-text"
												}`}
											>
												{tab.label}
											</button>
										);
									})}
								</div>
							</div>

							<PullToRefresh
								className="min-h-0 flex-1"
								onRefresh={() => Promise.all([statusState.reload(true), logState.reload(true), treeState.reload(true), loadBranches()]).then(() => {})}
							>
								<div className="space-y-3 pt-3" style={{ paddingBottom: showStickyCommitBar ? "16px" : "calc(var(--m-safe-bottom) + 24px)" }}>
									{activeTab === "changes" && (
										<>
											{st.truncated && (
												<div
													role="status"
													className="mx-4 flex items-start gap-2 rounded-m-md bg-m-warn-bg px-3 py-2 text-m-xs text-m-warn"
												>
													<AlertTriangle size={15} className="mt-0.5 shrink-0" />
													<span>改动文件超过 1000 个，列表已截断；暂存与提交操作仅覆盖当前显示范围内的文件。</span>
												</div>
											)}
											{files.length > 15 && (
												<div className="px-4">
													<label className="flex min-h-9 items-center gap-2 rounded-m-md border border-m-border bg-m-surface px-3">
														<Search size={14} className="shrink-0 text-m-text-3" aria-hidden />
														<input
															type="search"
															value={fileQuery}
															onChange={(e) => setFileQuery(e.target.value)}
															placeholder="筛选改动文件路径"
															aria-label="筛选改动文件"
															className="min-w-0 flex-1 bg-transparent text-m-sm text-m-text outline-none placeholder:text-m-text-3"
														/>
													</label>
												</div>
											)}
											<ListGroup>
												{files.length === 0 ? (
													<div className="px-4 py-6 text-center text-m-sm text-m-text-3">工作区干净，暂无未提交改动</div>
												) : filteredFiles.length === 0 ? (
													<div className="px-4 py-6 text-center text-m-sm text-m-text-3">没有匹配的改动文件</div>
												) : (
													<>
														{visibleFiles.map((f) => {
															const { name, dir } = splitPath(f.path);
															const badge = statusLetter(f.status);
															return (
																<div key={f.path} className="m-list-row flex w-full items-center pl-4">
																	<div className="m-list-sep flex min-w-0 flex-1 items-center gap-2 pr-1">
																		<button
																			type="button"
																			onClick={() => openFileDiff(f)}
																			className="flex min-h-12 min-w-0 flex-1 items-center gap-3 py-2.5 text-left active:bg-m-surface-hover"
																		>
																			<span className={`w-4 shrink-0 text-center font-m-mono text-m-xs font-semibold ${badge.cls}`} aria-label={GIT_FILE_STATUS_LABEL[f.status] ?? f.status}>
																				{badge.letter}
																			</span>
																			<span className="min-w-0 flex-1">
																				<span className="block text-m-sm font-medium break-all text-m-text">{name}</span>
																				{(dir || f.staged) && (
																					<span className="mt-0.5 block text-m-xs break-all text-m-text-3">
																						{f.staged ? (f.unstaged ? "部分暂存 · " : "已暂存 · ") : ""}
																						{dir}
																					</span>
																				)}
																			</span>
																		</button>
																		<button
																			type="button"
																			aria-label={`操作 ${name}`}
																			onClick={() => setActionFile(f)}
																			className="flex h-10 w-10 shrink-0 items-center justify-center rounded-m-pill text-m-text-3 active:bg-m-surface-hover"
																		>
																			<MoreHorizontal size={18} strokeWidth={1.75} />
																		</button>
																	</div>
																</div>
															);
														})}
														{!showAllFiles && filteredFiles.length > FILES_PAGE_SIZE && (
															<button
																type="button"
																onClick={() => setShowAllFiles(true)}
																className="m-list-row flex min-h-10 w-full items-center justify-center px-4 py-2 text-m-xs font-medium text-m-accent active:bg-m-surface-hover"
															>
																显示全部 {filteredFiles.length} 个改动文件
															</button>
														)}
													</>
												)}
											</ListGroup>
										</>
									)}

									{activeTab === "commits" && (
										<>
											{commits.length > 10 && (
												<div className="px-4">
													<label className="flex min-h-9 items-center gap-2 rounded-m-md border border-m-border bg-m-surface px-3">
														<Search size={14} className="shrink-0 text-m-text-3" aria-hidden />
														<input
															type="search"
															value={commitQuery}
															onChange={(e) => setCommitQuery(e.target.value)}
															placeholder="搜索提交说明、作者或哈希"
															aria-label="搜索提交记录"
															className="min-w-0 flex-1 bg-transparent text-m-sm text-m-text outline-none placeholder:text-m-text-3"
														/>
													</label>
												</div>
											)}
											{logState.loading && !logState.data ? (
												<div className="px-4 py-6">
													<Loading label="读取提交记录" />
												</div>
											) : commits.length === 0 ? (
												<EmptyState icon={<GitCommitHorizontal size={22} strokeWidth={1.75} />} title="还没有提交记录" />
											) : filteredCommits.length === 0 ? (
												<div className="px-4 py-8 text-center text-m-sm text-m-text-3">没有匹配的提交记录</div>
											) : (
												<div className="space-y-3">
													{groupedCommits.map((grp) => (
														<ListGroup key={grp.day} title={grp.day}>
															{grp.items.map(({ commit: c, isHead }) => {
																const parsed = parseCommitSubject(c.subject);
																return (
																	<div key={c.sha} className="m-list-row flex w-full items-center pl-4">
																		<div className="m-list-sep flex min-w-0 flex-1 items-center gap-1 pr-1.5">
																			<button
																				type="button"
																				onClick={() => setDiff({ kind: "commit", title: c.subject, commit: c, query: `commit=${q(c.sha)}` })}
																				className="flex min-h-13 min-w-0 flex-1 flex-col justify-center py-2.5 text-left active:bg-m-surface-hover"
																			>
																				<div className="flex flex-wrap items-center gap-1.5">
																					{parsed.badge && (
																						<span className={`rounded px-1.5 py-0.5 font-m-mono text-[10.5px] font-medium whitespace-nowrap ${parsed.badgeCls}`}>
																							{parsed.badge}
																						</span>
																					)}
																					<span className="line-clamp-2 text-m-sm font-medium break-words text-m-text">
																						{parsed.text}
																					</span>
																				</div>
																				<div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-m-text-3">
																					{isHead && (
																						<span className="rounded-m-pill bg-m-accent-soft px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-m-accent-soft-text">
																							HEAD
																						</span>
																					)}
																					{c.author && <span className="truncate">{c.author}</span>}
																					<span aria-hidden>·</span>
																					<span className="font-m-mono">{c.short}</span>
																					<span aria-hidden>·</span>
																					<span className="whitespace-nowrap">{relTime(c.ts)}</span>
																				</div>
																			</button>
																			<button
																				type="button"
																				aria-label={`让 AI 审查提交 ${c.short}`}
																				title="让 AI 审查这次提交"
																				onClick={() => sendCommitQuickToMain(c)}
																				className="flex h-10 w-10 shrink-0 items-center justify-center rounded-m-pill text-m-accent active:bg-m-surface-hover"
																			>
																				<Sparkles size={16} strokeWidth={1.8} />
																			</button>
																		</div>
																	</div>
																);
															})}
														</ListGroup>
													))}
													{filteredCommits.length > commitLimit && (
														<div className="px-4">
															<Button
																variant="tonal"
																size="sm"
																block
																onClick={() => setCommitLimit((n) => n + COMMITS_STEP)}
															>
																加载更早的提交（还有 {filteredCommits.length - commitLimit} 条）
															</Button>
														</div>
													)}
												</div>
											)}
										</>
									)}

									{activeTab === "topology" && (
										<div className="space-y-3">
											{(worktrees.length > WORKTREE_COLLAPSE_AT || (branches?.length ?? 0) > 8) && (
												<div className="px-4">
													<label className="flex min-h-9 items-center gap-2 rounded-m-md border border-m-border bg-m-surface px-3">
														<Search size={14} className="shrink-0 text-m-text-3" aria-hidden />
														<input
															type="search"
															value={topologyQuery}
															onChange={(e) => setTopologyQuery(e.target.value)}
															placeholder="筛选工作树或分支名"
															aria-label="筛选工作树或分支"
															className="min-w-0 flex-1 bg-transparent text-m-sm text-m-text outline-none placeholder:text-m-text-3"
														/>
													</label>
												</div>
											)}

											{worktrees.length > 0 && (
												<ListGroup title={`工作树 · ${sortedWorktrees.length}`}>
													{visibleWorktrees.map((wt) => {
														const isCurrent =
															wt.sessions.some((s) => s.id === sessionId) ||
															Boolean(session?.cwd && (wt.path === session.cwd || wt.createCwd === session.cwd));
														const sessionCount = wt.totalCount || wt.sessions.length;
														const subline = isCurrent
															? `${sessionCount} 个会话 · ${files.length} 处改动`
															: `${sessionCount} 个会话`;
														return (
															<ListRow
																key={wt.key}
																icon={<GitBranch size={17} strokeWidth={1.75} className={isCurrent ? "text-m-accent" : "text-m-text-3"} />}
																title={
																	<span className="flex items-center gap-2">
																		<span className="break-all">{wt.label}</span>
																		{wt.isMain && <span className="text-[11px] font-normal text-m-text-3">主目录</span>}
																	</span>
																}
																subtitle={
																	<span>
																		<span>{subline}</span>
																		{wt.path ? <span className="block truncate font-m-mono text-[11px] text-m-text-3">{abbreviateHomePath(wt.path)}</span> : null}
																	</span>
																}
																right={isCurrent ? <span className="text-m-xs font-medium text-m-accent">当前</span> : undefined}
																onClick={() => setSelectedWorktree(wt)}
															/>
														);
													})}
													{!showAllWorktrees && topologyQuery.trim() === "" && sortedWorktrees.length > WORKTREE_COLLAPSE_AT && (
														<button
															type="button"
															onClick={() => setShowAllWorktrees(true)}
															className="m-list-row flex min-h-10 w-full items-center justify-center px-4 py-2 text-m-xs font-medium text-m-accent active:bg-m-surface-hover"
														>
															展开全部 {sortedWorktrees.length} 个工作树
														</button>
													)}
												</ListGroup>
											)}

											<ListGroup title={`本地分支 · ${localBranches.length}`}>
												{branchError && <p className="m-selectable px-4 py-2.5 text-m-xs break-words text-m-danger">{branchError}</p>}
												{branchLoading && !branches ? (
													<div className="px-4 py-3">
														<Loading label="读取分支中" />
													</div>
												) : localBranches.length === 0 ? (
													<div className="px-4 py-3 text-m-xs text-m-text-3">没有匹配的本地分支</div>
												) : (
													localBranches.map((b) => {
														const badges: string[] = [];
														if (b.isCurrentWorktree) badges.push("当前");
														if (b.ahead > 0) badges.push(`↑${b.ahead}`);
														if (b.behind > 0) badges.push(`↓${b.behind}`);
														return (
															<div key={`l:${b.name}`} className="m-list-row space-y-0.5 px-4 py-2.5">
																<div className="flex items-baseline justify-between gap-2">
																	<span className={`min-w-0 truncate text-m-sm font-medium ${b.isCurrentWorktree ? "text-m-accent" : "text-m-text"}`}>
																		{b.name}
																	</span>
																	{badges.length > 0 && (
																		<span className="shrink-0 font-m-mono text-[11px] whitespace-nowrap text-m-text-3">
																			{badges.join(" · ")}
																		</span>
																	)}
																</div>
																{b.lastCommitMessage && (
																	<div className="truncate text-m-xs text-m-text-3">
																		{b.lastCommitMessage}
																		{b.lastCommitTime ? ` · ${b.lastCommitTime}` : ""}
																	</div>
																)}
															</div>
														);
													})
												)}
											</ListGroup>

											{remoteBranches.length > 0 && (
												<ListGroup>
													<button
														type="button"
														aria-expanded={showRemoteBranches}
														onClick={() => setShowRemoteBranches((v) => !v)}
														className="m-list-row flex min-h-11 w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-m-sm font-medium text-m-text-2 active:bg-m-surface-hover"
													>
														<span className="whitespace-nowrap">远程分支 ({remoteBranches.length})</span>
														{showRemoteBranches ? <ChevronDown size={17} className="text-m-text-3" /> : <ChevronRight size={17} className="text-m-text-3" />}
													</button>
													{showRemoteBranches &&
														remoteBranches.map((b) => (
															<div key={`r:${b.name}`} className="m-list-row space-y-0.5 border-t border-m-border/40 px-4 py-2.5">
																<div className="truncate text-m-sm font-medium text-m-text-2">{b.name}</div>
																{b.lastCommitMessage && (
																	<div className="truncate text-m-xs text-m-text-3">
																		{b.lastCommitMessage}
																		{b.lastCommitTime ? ` · ${b.lastCommitTime}` : ""}
																	</div>
																)}
															</div>
														))}
												</ListGroup>
											)}
										</div>
									)}
								</div>
							</PullToRefresh>

							{showStickyCommitBar && (
								<div
									className="flex shrink-0 items-center gap-2 border-t border-m-border bg-m-bg-elev/95 px-4 pt-2.5 backdrop-blur-md"
									style={{ paddingBottom: "calc(var(--m-safe-bottom) + 10px)" }}
								>
									<Button
										variant="primary"
										size="sm"
										className="flex-1"
										icon={<Sparkles size={14} strokeWidth={1.85} />}
										busy={aiSaving}
										disabled={committing || suggesting || fileOperating}
										onClick={() => void saveWithAi()}
									>
										AI 生成并提交
									</Button>
									<Button
										variant="tonal"
										size="sm"
										className="flex-1"
										disabled={aiSaving || committing || fileOperating}
										onClick={openCommitModal}
									>
										填写说明提交
									</Button>
								</div>
							)}
						</div>
					);
				}}
			</LoadGate>

			{diff && (
				<DiffOverlay
					sessionId={sessionId}
					base={base}
					target={diff}
					embedded={embedded}
					onClose={closeDiff}
				/>
			)}

			{/* Worktree Sessions Sheet */}
			<BottomSheet
				open={isActive && selectedWorktree !== null}
				onClose={() => setSelectedWorktree(null)}
				title={selectedWorktree?.label}
				subtitle={selectedWorktree?.path ? abbreviateHomePath(selectedWorktree.path) : undefined}
			>
				{selectedWorktree && (
					<div className="space-y-3 pb-4">
						{selectedWorktree.sessions.length === 0 ? (
							<div className="px-5 py-4 text-center text-m-sm text-m-text-3">该工作树下暂无活跃会话</div>
						) : (
							<ListGroup>
								{selectedWorktree.sessions.map((s) => (
									<ListRow
										key={s.id}
										title={sessionName(s)}
										subtitle={`${STATUS_LABEL[s.status] ?? s.status} · ${relTime(s.updatedAt)}`}
										right={s.id === sessionId ? <span className="text-m-xs font-medium text-m-accent">当前</span> : undefined}
										onClick={() => {
											setSelectedWorktree(null);
											if (embedded) useRightDrawer.getState().closeDrawer();
											nav.push(paths.chat(s.id));
										}}
									/>
								))}
							</ListGroup>
						)}
						{(selectedWorktree.createCwd || selectedWorktree.path) && (
							<div className="px-4">
								<Button
									variant="primary"
									block
									icon={<Plus size={16} strokeWidth={2} />}
									busy={creatingWtSession}
									onClick={() => void createSessionInWorktree(selectedWorktree)}
								>
									在此工作树新建会话
								</Button>
							</div>
						)}
					</div>
				)}
			</BottomSheet>

			{/* File Action Sheet */}
			<BottomSheet
				open={isActive && actionFile !== null}
				onClose={() => setActionFile(null)}
				title={actionInfo?.name}
				subtitle={actionInfo ? actionInfo.dir || actionFile?.path : undefined}
			>
				{actionFile && (
					<div className="py-1">
						<MenuRow
							icon={<Sparkles size={19} strokeWidth={1.75} />}
							label="让 Agent 审查或修改此文件"
							hint="带入文件上下文并返回主对话"
							onClick={() => sendFileToMain(actionFile)}
						/>
						<MenuRow
							icon={<FileDiff size={19} strokeWidth={1.75} />}
							label="查看改动差异"
							onClick={() => {
								const targetFile = actionFile;
								setActionFile(null);
								openFileDiff(targetFile);
							}}
						/>
						{(actionFile.unstaged || actionFile.status === "??") && (
							<MenuRow
								icon={<PlusCircle size={19} strokeWidth={1.75} />}
								label="暂存此文件"
								disabled={busy}
								onClick={() => {
									const targetFile = actionFile;
									setActionFile(null);
									void runFileOp(
										targetFile,
										() => api("POST", `${base}/stage`, { paths: [targetFile.path] }),
										"已暂存文件",
									);
								}}
							/>
						)}
						{actionFile.staged && (
							<MenuRow
								icon={<MinusCircle size={19} strokeWidth={1.75} />}
								label="取消暂存"
								disabled={busy}
								onClick={() => {
									const targetFile = actionFile;
									setActionFile(null);
									void runFileOp(
										targetFile,
										() => api("POST", `${base}/unstage`, { paths: [targetFile.path] }),
										"已取消暂存",
									);
								}}
							/>
						)}
						{(actionFile.unstaged || actionFile.status === "??") && (
							<MenuRow
								icon={<RotateCcw size={19} strokeWidth={1.75} />}
								label={actionFile.status === "??" ? "删除未跟踪文件" : "丢弃工作区改动"}
								danger
								disabled={busy}
								onClick={() => void discardFile(actionFile)}
							/>
						)}
						<MenuRow
							icon={<Copy size={19} strokeWidth={1.75} />}
							label="复制文件路径"
							hint={actionFile.path}
							onClick={() => {
								const pathToCopy = actionFile.path;
								setActionFile(null);
								void copyText(pathToCopy).then((ok) => {
									if (ok) toast("已复制文件路径", { kind: "success" });
								});
							}}
						/>
					</div>
				)}
			</BottomSheet>

			{/* Commit Dialog */}
			<Dialog
				open={isActive && commitOpen}
				onClose={closeCommitModal}
				title="提交全部改动"
				actions={
					<div className="flex justify-end gap-2">
						<Button variant="ghost" disabled={committing} onClick={closeCommitModal}>
							取消
						</Button>
						<Button
							variant="primary"
							busy={committing}
							disabled={aiSaving || fileOperating || !message.trim()}
							onClick={() => void commitAll()}
						>
							确认提交
						</Button>
					</div>
				}
			>
				<div className="space-y-3">
					<div className="flex items-center justify-between gap-2">
						<span className="text-m-xs text-m-text-3">
							将暂存并提交全部 {files.length}{statusState.data?.truncated ? "+" : ""} 个改动文件
						</span>
						<Button
							variant="tonal"
							size="sm"
							icon={<Sparkles size={14} strokeWidth={1.85} />}
							busy={suggesting}
							disabled={committing || aiSaving || fileOperating}
							onClick={() => void generateSuggestion()}
						>
							重新生成
						</Button>
					</div>
					{suggesting && !message && (
						<p className="m-shimmer text-m-xs text-m-text-3">正在根据全部改动生成提交说明…</p>
					)}
					<textarea
						value={message}
						onChange={(e) => {
							userEditedRef.current = true;
							setMessage(e.target.value);
						}}
						rows={4}
						aria-label="提交说明"
						placeholder="输入或编辑提交说明"
						autoCapitalize="off"
						className={`${inputCls} block resize-none rounded-m-lg`}
					/>
					{commitError && (
						<p role="alert" className="m-selectable text-m-xs break-words text-m-danger">
							{commitError}
						</p>
					)}
				</div>
			</Dialog>
		</div>
	);

	if (embedded) return <div className="flex h-full min-h-0 flex-1 flex-col bg-m-bg">{body}</div>;

	return (
		<div className="flex h-full flex-col bg-m-bg">
			<PageHeader
				title="Git"
				subtitle={statusState.data?.isRepo ? statusState.data.branch ?? "游离 HEAD" : undefined}
				onBack={() => (diff ? closeDiff() : nav.back())}
				right={refreshButton}
			/>
			{body}
		</div>
	);
}

export function GitPage({ route }: PageProps) {
	return <GitPanel sessionId={route.params.id} />;
}

function DiffOverlay({
	sessionId,
	base,
	target,
	embedded,
	onClose,
}: {
	sessionId: string;
	base: string;
	target: DiffTarget;
	embedded: boolean;
	onClose: () => void;
}) {
	const [copiedSha, setCopiedSha] = useState(false);
	const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
	const state = useLoad(
		(signal) => api<{ diff: string }>("GET", `${base}/diff?${target.query}`, undefined, { signal }),
		[base, target.query],
	);

	const diffFiles = useMemo(
		() => (target.kind === "commit" && state.data?.diff ? parseDiffFiles(state.data.diff) : []),
		[target.kind, state.data?.diff],
	);

	const toggleFile = (path: string) => {
		setExpandedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	const sendAiPrompt = (mode: "review" | "continue" = "review") => {
		const diffText = state.data?.diff?.trim() ?? "";
		const clipped = diffText.length > 6000 ? `${diffText.slice(0, 6000)}\n... (已截断)` : diffText;
		if (target.kind === "file") {
			useRightDrawer.getState().sendToMainChat(sessionId, {
				quote: clipped ? fenced(clipped, "diff") : `文件：\`${target.filePath}\``,
				comment: `请帮我检查并修改 \`${target.filePath}\` 的这些改动：`,
				sourceLabel: `Git 改动 · ${target.filePath}`,
			});
		} else {
			const comment =
				mode === "continue"
					? `基于提交 ${target.commit.short}（${target.commit.subject}），请帮我继续修改或调整：`
					: `针对提交 ${target.commit.short}（${target.commit.subject}），请帮我审查改动是否有风险或遗漏：`;
			useRightDrawer.getState().sendToMainChat(sessionId, {
				quote: clipped
					? `Commit ${target.commit.short} (${target.commit.subject})\n\n${fenced(clipped, "diff")}`
					: `Commit ${target.commit.short}: ${target.commit.subject}`,
				comment,
				sourceLabel: `Git 提交 · ${target.commit.short}`,
			});
		}
		if (!embedded) nav.push(paths.chat(sessionId));
	};

	const copyTarget = () => {
		const text = target.kind === "file" ? target.filePath : target.commit.sha;
		void copyText(text).then((ok) => {
			if (!ok) return;
			if (target.kind === "commit") {
				setCopiedSha(true);
				window.setTimeout(() => setCopiedSha(false), 1500);
			}
			toast(target.kind === "file" ? "已复制文件路径" : "已复制完整 SHA", { kind: "success" });
		});
	};

	return (
		<div className="absolute inset-0 z-(--z-base) flex flex-col bg-m-bg">
			<div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-m-border px-3">
				<button
					type="button"
					onClick={onClose}
					aria-label="返回列表"
					className="inline-flex min-h-10 items-center gap-1 rounded-m-pill px-2 text-m-sm font-medium whitespace-nowrap text-m-accent active:bg-m-surface"
				>
					<ArrowLeft size={18} />
					<span>{target.kind === "file" ? "改动差异" : "提交详情"}</span>
				</button>
				<Button
					variant="tonal"
					size="sm"
					icon={<Sparkles size={14} strokeWidth={1.85} />}
					disabled={state.loading || state.error !== null}
					onClick={() => sendAiPrompt("review")}
				>
					{target.kind === "file" ? "让 AI 修改" : "针对这次提交问 AI"}
				</Button>
			</div>
			<div
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3"
				style={{ paddingBottom: "calc(var(--m-safe-bottom) + 24px)" }}
			>
				<h1 className="m-selectable px-1 text-m-lg font-medium break-words text-m-text">{target.title}</h1>
				{target.kind === "file" ? (
					<div className="m-selectable mt-0.5 mb-3 px-1 font-m-mono text-m-xs break-all text-m-text-3">
						{target.filePath}
					</div>
				) : (
					<>
						<div className="mt-1.5 mb-3 flex flex-wrap items-center gap-2 px-1 text-m-xs text-m-text-3">
							<span className="whitespace-nowrap">{relTime(target.commit.ts)}</span>
							<span aria-hidden>·</span>
							<span className="break-all">{target.commit.author}</span>
							<button
								type="button"
								onClick={copyTarget}
								className="inline-flex items-center gap-1 font-m-mono text-m-text-2 active:opacity-75"
							>
								{copiedSha ? <Check size={12} /> : <Copy size={12} />}
								{target.commit.short}
							</button>
						</div>

						{/* AI-first action card placed above raw diffs */}
						<div className="mb-3 rounded-m-lg border border-m-border/70 bg-m-surface p-3">
							<div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-m-text">
								<Sparkles size={14} className="text-m-accent" aria-hidden />
								<span>让 Agent 处理这次提交</span>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button
									variant="primary"
									size="sm"
									className="flex-1"
									disabled={state.loading || state.error !== null}
									onClick={() => sendAiPrompt("review")}
								>
									审查风险与遗漏
								</Button>
								<Button
									variant="tonal"
									size="sm"
									className="flex-1"
									disabled={state.loading || state.error !== null}
									onClick={() => sendAiPrompt("continue")}
								>
									基于此继续修改
								</Button>
							</div>
						</div>
					</>
				)}

				{state.loading && <Loading />}
				{state.error !== null && <ErrorState message={state.error} onRetry={() => void state.reload()} />}
				{state.data &&
					(target.kind === "file" ? (
						state.data.diff.trim() ? (
							<DiffView diff={state.data.diff} className="m-selectable rounded-m-lg" />
						) : (
							<EmptyState icon={<FileDiff size={22} strokeWidth={1.75} />} title="没有差异" />
						)
					) : diffFiles.length > 0 ? (
						<div className="space-y-2">
							<div className="px-1 text-m-xs font-medium text-m-text-3">涉及文件 ({diffFiles.length})</div>
							<div className="overflow-hidden rounded-m-lg border border-m-border/70 bg-m-surface">
								{diffFiles.map((f) => {
									const isOpen = expandedFiles.has(f.path);
									const { name, dir } = splitPath(f.path);
									return (
										<div key={f.path} className="border-b border-m-border/50 last:border-b-0">
											<button
												type="button"
												aria-expanded={isOpen}
												onClick={() => toggleFile(f.path)}
												className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left active:bg-m-surface-hover"
											>
												{isOpen ? (
													<ChevronDown size={15} className="shrink-0 text-m-text-3" aria-hidden />
												) : (
													<ChevronRight size={15} className="shrink-0 text-m-text-3" aria-hidden />
												)}
												<span className="min-w-0 flex-1">
													<span className="block truncate text-m-sm font-medium text-m-text">{name}</span>
													{dir && <span className="block truncate font-m-mono text-[11px] text-m-text-3">{dir}</span>}
												</span>
												<span className="flex shrink-0 items-center gap-1.5 font-m-mono text-[11px] whitespace-nowrap">
													{f.additions > 0 && <span className="text-m-success">+{f.additions}</span>}
													{f.deletions > 0 && <span className="text-m-danger">-{f.deletions}</span>}
												</span>
											</button>
											{isOpen && (
												<div className="border-t border-m-border/40 bg-m-bg p-2">
													<DiffView diff={f.patch} className="m-selectable rounded-m-md" />
												</div>
											)}
										</div>
									);
								})}
							</div>
						</div>
					) : state.data.diff.trim() ? (
						<DiffView diff={state.data.diff} className="m-selectable rounded-m-lg" />
					) : (
						<EmptyState icon={<FileDiff size={22} strokeWidth={1.75} />} title="没有差异" />
					))}
			</div>
			<div
				className="flex shrink-0 items-center justify-between gap-2 border-t border-m-border bg-m-bg-elev/90 px-4 pt-2.5 backdrop-blur-md"
				style={{ paddingBottom: "calc(var(--m-safe-bottom) + 10px)" }}
			>
				<Button variant="tonal" size="sm" icon={<Copy size={14} strokeWidth={1.75} />} onClick={copyTarget}>
					{target.kind === "file" ? "复制路径" : "复制 SHA"}
				</Button>
				<Button
					variant="primary"
					size="sm"
					icon={<Sparkles size={14} strokeWidth={1.85} />}
					disabled={state.loading || state.error !== null}
					onClick={() => sendAiPrompt("review")}
				>
					发给主对话
				</Button>
			</div>
		</div>
	);
}

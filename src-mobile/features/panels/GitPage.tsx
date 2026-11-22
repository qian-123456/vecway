import {
	ArrowLeft,
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	FileDiff,
	GitBranch,
	GitCommitHorizontal,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../core/api";
import { copyText, relTime } from "../../core/lib/format";
import { nav, paths, type PageProps } from "../../core/nav";
import { isDraftId } from "../../core/types";
import {
	Button,
	Chip,
	Dialog,
	DiffView,
	EmptyState,
	ListGroup,
	ListRow,
	PageHeader,
	PullToRefresh,
	Segmented,
	inputCls,
	toast,
} from "../../ui";
import { ErrorState, LoadGate, Loading } from "./PanelState";
import { useLayer, useLoad } from "./hooks";
import { fenced, splitPath, statusTone, type GitFile } from "./pure";
import { useRightDrawer } from "./rightDrawerStore";

interface GitStatus {
	isRepo: boolean;
	branch: string | null;
	files: GitFile[];
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

type Tab = "status" | "log";
type DiffTarget =
	| { kind: "file"; title: string; filePath: string; query: string }
	| { kind: "commit"; title: string; commit: Commit; query: string };

const q = encodeURIComponent;

export async function gitCommitSuggest(base: string): Promise<string> {
	const res = await api<{ suggestion?: string }>("POST", `${base}/suggest`);
	return res?.suggestion ?? "";
}

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
	{ value: "status", label: "改动" },
	{ value: "log", label: "历史" },
];

const STATUS_LABEL: Record<string, string> = {
	M: "修改",
	A: "新增",
	D: "删除",
	R: "重命名",
	"??": "新文件",
};

export function GitPanel({
	sessionId,
	embedded = false,
	visible = true,
}: {
	sessionId: string;
	embedded?: boolean;
	visible?: boolean;
}) {
	const draft = isDraftId(sessionId);
	const base = `/sessions/${q(sessionId)}/git`;
	const [tab, setTab] = useState<Tab>("status");
	const [diff, setDiff] = useState<DiffTarget | null>(null);
	const [refreshNonce, setRefreshNonce] = useState(0);
	const closeDiff = () => setDiff(null);
	useLayer(diff !== null, closeDiff);

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

	const body = (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
			<div className="shrink-0 border-b border-m-border px-4 pt-2 pb-2.5">
				<Segmented label="Git 视图" value={tab} options={TABS} onChange={setTab} />
			</div>
			<div className={tab === "status" ? "flex min-h-0 flex-1 flex-col" : "hidden"} aria-hidden={tab !== "status"}>
				<StatusTab
					base={base}
					visible={visible && tab === "status" && diff === null}
					refreshNonce={refreshNonce}
					onCommitted={() => setRefreshNonce((n) => n + 1)}
					onDiff={setDiff}
				/>
			</div>
			<div className={tab === "log" ? "flex min-h-0 flex-1 flex-col" : "hidden"} aria-hidden={tab !== "log"}>
				<LogTab
					base={base}
					visible={visible && tab === "log" && diff === null}
					refreshNonce={refreshNonce}
					onRefreshAll={() => setRefreshNonce((n) => n + 1)}
					onDiff={setDiff}
				/>
			</div>
			{diff && (
				<DiffOverlay
					sessionId={sessionId}
					base={base}
					target={diff}
					embedded={embedded}
					onClose={closeDiff}
				/>
			)}
		</div>
	);

	if (embedded) return <div className="flex h-full min-h-0 flex-1 flex-col bg-m-bg">{body}</div>;

	return (
		<div className="flex h-full flex-col bg-m-bg">
			<PageHeader title="Git" onBack={() => (diff ? closeDiff() : nav.back())} />
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
	const state = useLoad(
		(signal) => api<{ diff: string }>("GET", `${base}/diff?${target.query}`, undefined, { signal }),
		[base, target.query],
	);

	const sendAiPrompt = () => {
		const diffText = state.data?.diff?.trim() ?? "";
		const clipped = diffText.length > 6000 ? `${diffText.slice(0, 6000)}\n... (已截断)` : diffText;
		if (target.kind === "file") {
			useRightDrawer.getState().sendToMainChat(sessionId, {
				quote: clipped ? fenced(clipped, "diff") : `文件：\`${target.filePath}\``,
				comment: `请帮我检查并修改 \`${target.filePath}\` 的这些改动：`,
				sourceLabel: `Git 改动 · ${target.filePath}`,
			});
		} else {
			useRightDrawer.getState().sendToMainChat(sessionId, {
				quote: clipped
					? `Commit ${target.commit.short} (${target.commit.subject})\n\n${fenced(clipped, "diff")}`
					: `Commit ${target.commit.short}: ${target.commit.subject}`,
				comment: `针对提交 ${target.commit.short}（${target.commit.subject}），请帮我分析：`,
				sourceLabel: `Git 提交 · ${target.commit.short}`,
			});
		}
		if (!embedded) nav.push(paths.chat(sessionId));
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
				<Button variant="tonal" size="sm" icon={<Sparkles size={14} strokeWidth={1.85} />} onClick={sendAiPrompt}>
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
					<div className="mt-1.5 mb-3 flex flex-wrap items-center gap-2 px-1 text-m-xs text-m-text-3">
						<span className="whitespace-nowrap">{relTime(target.commit.ts)}</span>
						<span aria-hidden>·</span>
						<span className="break-all">{target.commit.author}</span>
						<button
							type="button"
							onClick={() =>
								void copyText(target.commit.sha).then((ok) => {
									if (!ok) return;
									setCopiedSha(true);
									toast("已复制完整 SHA", { kind: "success" });
									window.setTimeout(() => setCopiedSha(false), 1500);
								})
							}
							className="inline-flex items-center gap-1 rounded-m-pill bg-m-surface px-2 py-0.5 font-m-mono text-m-text-2 active:bg-m-surface-2"
						>
							{copiedSha ? <Check size={12} /> : <Copy size={12} />}
							{target.commit.short}
						</button>
					</div>
				)}
				{state.loading && <Loading />}
				{state.error !== null && <ErrorState message={state.error} onRetry={() => void state.reload()} />}
				{state.data &&
					(state.data.diff.trim() ? (
						<DiffView diff={state.data.diff} className="m-selectable rounded-m-lg" />
					) : (
						<EmptyState icon={<FileDiff size={22} strokeWidth={1.75} />} title="没有差异" />
					))}
			</div>
		</div>
	);
}

function usePreservedScroll(visible: boolean) {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const savedScrollRef = useRef(0);
	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const onScroll = () => {
			savedScrollRef.current = el.scrollTop;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);
	useLayoutEffect(() => {
		if (visible && scrollerRef.current) {
			scrollerRef.current.scrollTop = savedScrollRef.current;
		}
	}, [visible]);
	return scrollerRef;
}

function StatusTab({
	base,
	visible,
	refreshNonce,
	onCommitted,
	onDiff,
}: {
	base: string;
	visible: boolean;
	refreshNonce: number;
	onCommitted: () => void;
	onDiff: (t: DiffTarget) => void;
}) {
	const state = useLoad((signal) => api<GitStatus>("GET", `${base}/status`, undefined, { signal }), [base, refreshNonce]);
	const scrollerRef = usePreservedScroll(visible);

	const [commitOpen, setCommitOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [suggesting, setSuggesting] = useState(false);
	const [committing, setCommitting] = useState(false);
	const [commitError, setCommitError] = useState<string | null>(null);
	const suggestSeq = useRef(0);
	const files = Array.isArray(state.data?.files) ? state.data.files : [];

	const generateSuggestion = async () => {
		const mine = ++suggestSeq.current;
		setSuggesting(true);
		setCommitError(null);
		try {
			const text = await gitCommitSuggest(base);
			if (mine !== suggestSeq.current) return;
			if (text) setMessage(text);
			else toast("没能生成提交说明，可手动填写", { kind: "info" });
		} catch (e) {
			if (mine === suggestSeq.current) setCommitError(`AI 生成失败：${errorMessage(e)}`);
		} finally {
			if (mine === suggestSeq.current) setSuggesting(false);
		}
	};

	const openCommitModal = () => {
		setCommitOpen(true);
		setCommitError(null);
		setMessage("");
		void generateSuggestion();
	};

	const commitAll = async () => {
		const msg = message.trim();
		if (!msg || committing) return;
		setCommitting(true);
		setCommitError(null);
		try {
			const pendingPaths = files.filter((f) => f.unstaged || f.status === "??").map((f) => f.path);
			if (pendingPaths.length > 0) {
				await api("POST", `${base}/stage`, { paths: pendingPaths });
			}
			await api("POST", `${base}/commit`, { message: msg });
			setCommitOpen(false);
			setMessage("");
			toast("已提交全部改动", { kind: "success" });
			await state.reload(true);
			onCommitted();
		} catch (e) {
			setCommitError(errorMessage(e));
		} finally {
			setCommitting(false);
		}
	};

	return (
		<>
			<PullToRefresh ref={scrollerRef} onRefresh={() => state.reload(true)}>
				<LoadGate state={state}>
					{(st) => {
						if (!st.isRepo) {
							return <EmptyState icon={<GitBranch size={22} strokeWidth={1.75} />} title="当前目录不是 Git 仓库" />;
						}
						const stFiles = Array.isArray(st.files) ? st.files : [];
						return (
							<div className="pb-6">
								<div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2">
									<div className="flex min-w-0 flex-wrap items-center gap-2">
										<Chip tone="accent">
											<GitBranch size={13} strokeWidth={1.85} />
											<span className="max-w-[160px] truncate">{st.branch ?? "游离 HEAD"}</span>
										</Chip>
										<span className="text-m-xs whitespace-nowrap text-m-text-3">
											{stFiles.length > 0 ? `${stFiles.length} 个改动` : "工作区干净"}
										</span>
									</div>
									{stFiles.length > 0 && (
										<Button variant="primary" size="sm" onClick={openCommitModal}>
											提交全部改动
										</Button>
									)}
								</div>
								{stFiles.length === 0 ? (
									<EmptyState icon={<GitCommitHorizontal size={22} strokeWidth={1.75} />} title="没有改动" hint="工作区是干净的" />
								) : (
									<ListGroup>
										{stFiles.map((f) => {
											const { name, dir } = splitPath(f.path);
											return (
												<ListRow
													key={f.path}
													icon={
														<Chip tone={statusTone(f.status)} className="min-w-11 justify-center">
															{STATUS_LABEL[f.status] ?? f.status}
														</Chip>
													}
													title={<span className="break-all">{name}</span>}
													subtitle={dir ? <span className="break-all">{dir}</span> : undefined}
													onClick={() =>
														onDiff({
															kind: "file",
															title: name,
															filePath: f.path,
															query: `path=${q(f.path)}&staged=${f.staged && !f.unstaged}`,
														})
													}
												/>
											);
										})}
									</ListGroup>
								)}
							</div>
						);
					}}
				</LoadGate>
			</PullToRefresh>

			<Dialog
				open={commitOpen}
				onClose={() => {
					if (!committing) {
						suggestSeq.current++;
						setCommitOpen(false);
					}
				}}
				title="提交全部改动"
				actions={
					<div className="flex justify-end gap-2">
						<Button
							variant="ghost"
							disabled={committing}
							onClick={() => {
								suggestSeq.current++;
								setCommitOpen(false);
							}}
						>
							取消
						</Button>
						<Button
							variant="primary"
							busy={committing}
							disabled={suggesting || !message.trim()}
							onClick={() => void commitAll()}
						>
							确认提交
						</Button>
					</div>
				}
			>
				<div className="space-y-3">
					<div className="flex items-center justify-between gap-2">
						<span className="text-m-xs text-m-text-3">将暂存并提交全部 {files.length} 个改动文件</span>
						<Button
							variant="tonal"
							size="sm"
							icon={<Sparkles size={14} strokeWidth={1.85} />}
							busy={suggesting}
							disabled={committing}
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
						onChange={(e) => setMessage(e.target.value)}
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
		</>
	);
}

function LogTab({
	base,
	visible,
	refreshNonce,
	onRefreshAll,
	onDiff,
}: {
	base: string;
	visible: boolean;
	refreshNonce: number;
	onRefreshAll: () => void;
	onDiff: (t: DiffTarget) => void;
}) {
	const state = useLoad((signal) => api<Commit[] | { commits?: Commit[] }>("GET", `${base}/log?limit=50`, undefined, { signal }), [base, refreshNonce]);
	const [branchOpen, setBranchOpen] = useState(false);
	const [branches, setBranches] = useState<BranchInfo[] | null>(null);
	const [branchLoading, setBranchLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const scrollerRef = usePreservedScroll(visible);

	const loadBranches = async () => {
		setBranchLoading(true);
		setBranchError(null);
		try {
			const list = await api<BranchInfo[] | { branches?: BranchInfo[] }>("GET", `${base}/branches`);
			setBranches(Array.isArray(list) ? list : Array.isArray(list?.branches) ? list.branches : []);
		} catch (e) {
			setBranchError(errorMessage(e));
		} finally {
			setBranchLoading(false);
		}
	};

	useEffect(() => {
		if (branchOpen) void loadBranches();
	}, [branchOpen, refreshNonce]);

	return (
		<PullToRefresh ref={scrollerRef} onRefresh={() => state.reload(true)}>
			<LoadGate state={state}>
				{(raw) => {
					const cs = Array.isArray(raw) ? raw : Array.isArray(raw?.commits) ? raw.commits : [];
					return (
						<div className="space-y-4 pt-2" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 24px)" }}>
							{cs.length === 0 ? (
								<EmptyState icon={<GitCommitHorizontal size={22} strokeWidth={1.75} />} title="还没有提交" />
							) : (
								<ListGroup>
									{cs.map((c) => (
										<ListRow
											key={c.sha}
											title={<span className="line-clamp-2 break-words">{c.subject}</span>}
											subtitle={<span className="whitespace-nowrap">{relTime(c.ts)}</span>}
											onClick={() => onDiff({ kind: "commit", title: c.subject, commit: c, query: `commit=${q(c.sha)}` })}
										/>
									))}
								</ListGroup>
							)}

						<div className="mx-4 rounded-m-lg border border-m-border bg-m-card">
							<button
								type="button"
								aria-expanded={branchOpen}
								onClick={() => setBranchOpen((v) => !v)}
								className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-m-sm font-medium text-m-text-2 active:bg-m-surface-hover"
							>
								<span className="flex items-center gap-2 whitespace-nowrap">
									<GitBranch size={16} strokeWidth={1.75} />
									分支与高级操作
								</span>
								{branchOpen ? <ChevronDown size={17} className="shrink-0 text-m-text-3" /> : <ChevronRight size={17} className="shrink-0 text-m-text-3" />}
							</button>
							{branchOpen && (
								<div className="space-y-3 border-t border-m-border px-4 py-3">
									<div className="flex items-center justify-between gap-2">
										<span className="text-m-xs text-m-text-3">仓库分支拓扑</span>
										<Button
											variant="tonal"
											size="sm"
											icon={<RefreshCw size={14} />}
											busy={branchLoading}
											onClick={() => {
												onRefreshAll();
												void loadBranches();
											}}
										>
											刷新仓库状态
										</Button>
									</div>
									{branchError && <p className="text-m-xs text-m-danger break-words">{branchError}</p>}
									{branchLoading && !branches && <Loading label="读取分支中" />}
									{branches && (
										<div className="space-y-2">
											{branches.slice(0, 12).map((b) => (
												<div
													key={`${b.isRemote ? "r" : "l"}:${b.name}`}
													className={`rounded-m-md border px-3 py-2 ${
														b.isCurrentWorktree ? "border-m-accent bg-m-accent-soft/30" : "border-m-border bg-m-surface/40"
													}`}
												>
													<div className="flex flex-wrap items-center justify-between gap-1.5">
														<span className="min-w-0 truncate text-m-xs font-medium text-m-text">{b.name}</span>
														<div className="flex shrink-0 items-center gap-1">
															{b.isCurrentWorktree && <Chip tone="accent">当前</Chip>}
															{b.isRemote && <Chip>远程</Chip>}
															{b.ahead > 0 && <Chip tone="success">+{b.ahead}</Chip>}
															{b.behind > 0 && <Chip tone="warn">-{b.behind}</Chip>}
														</div>
													</div>
													{b.lastCommitMessage && (
														<div className="mt-1 truncate text-m-xs text-m-text-3">
															{b.lastCommitMessage}
															{b.lastCommitTime ? ` · ${b.lastCommitTime}` : ""}
														</div>
													)}
												</div>
											))}
										</div>
									)}
								</div>
							)}
						</div>
					</div>
					);
				}}
			</LoadGate>
		</PullToRefresh>
	);
}

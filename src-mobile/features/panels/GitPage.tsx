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
	PlusCircle,
	RefreshCw,
	RotateCcw,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../core/api";
import { copyText, relTime } from "../../core/lib/format";
import { nav, paths, type PageProps } from "../../core/nav";
import { isDraftId } from "../../core/types";
import {
	BottomSheet,
	Button,
	Chip,
	Dialog,
	DiffView,
	EmptyState,
	ListGroup,
	ListRow,
	MenuRow,
	PageHeader,
	PullToRefresh,
	Segmented,
	confirm,
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
	const [tab, setTab] = useState<Tab>("status");
	const [diff, setDiff] = useState<DiffTarget | null>(null);
	const [refreshNonce, setRefreshNonce] = useState(0);
	const closeDiff = () => setDiff(null);
	useLayer(isActive && diff !== null, closeDiff);
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
			<div className="shrink-0 border-b border-m-border px-4 pt-2.5 pb-2.5">
				<Segmented label="Git 视图" value={tab} options={TABS} onChange={setTab} />
			</div>
			<div className={tab === "status" ? "flex min-h-0 flex-1 flex-col" : "hidden"} aria-hidden={tab !== "status"}>
				<StatusTab
					sessionId={sessionId}
					base={base}
					embedded={embedded}
					active={isActive}
					visible={isActive && tab === "status" && diff === null}
					refreshNonce={refreshNonce}
					onCommitted={() => setRefreshNonce((n) => n + 1)}
					onDiff={setDiff}
				/>
			</div>
			<div className={tab === "log" ? "flex min-h-0 flex-1 flex-col" : "hidden"} aria-hidden={tab !== "log"}>
				<LogTab
					base={base}
					visible={isActive && tab === "log" && diff === null}
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
					onClick={sendAiPrompt}
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
					<div className="mt-1.5 mb-3 flex flex-wrap items-center gap-2 px-1 text-m-xs text-m-text-3">
						<span className="whitespace-nowrap">{relTime(target.commit.ts)}</span>
						<span aria-hidden>·</span>
						<span className="break-all">{target.commit.author}</span>
						<button
							type="button"
							onClick={copyTarget}
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
					onClick={sendAiPrompt}
				>
					发给主对话
				</Button>
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

type GitOp =
	| { kind: "idle" }
	| { kind: "suggesting"; seq: number }
	| { kind: "aiSaving"; seq: number }
	| { kind: "committing"; seq: number }
	| { kind: "fileOp"; seq: number; path: string };

function StatusTab({
	sessionId,
	base,
	active,
	visible,
	embedded,
	refreshNonce,
	onCommitted,
	onDiff,
}: {
	sessionId: string;
	base: string;
	active: boolean;
	visible: boolean;
	embedded: boolean;
	refreshNonce: number;
	onCommitted: () => void;
	onDiff: (t: DiffTarget) => void;
}) {
	const state = useLoad((signal) => api<GitStatus>("GET", `${base}/status`, undefined, { signal }), [base]);
	const prevRefreshNonce = useRef(refreshNonce);
	useEffect(() => {
		if (refreshNonce === prevRefreshNonce.current) return;
		prevRefreshNonce.current = refreshNonce;
		void state.reload(true);
	}, [refreshNonce, state.reload]);
	const scrollerRef = usePreservedScroll(visible);

	const [commitOpen, setCommitOpen] = useState(false);
	const [manualOpen, setManualOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [op, setOpState] = useState<GitOp>({ kind: "idle" });
	const opRef = useRef<GitOp>({ kind: "idle" });
	const opSeq = useRef(0);
	const userEditedRef = useRef(false);
	const [commitError, setCommitError] = useState<string | null>(null);
	const [actionFile, setActionFile] = useState<GitFile | null>(null);
	const files = Array.isArray(state.data?.files) ? state.data.files : [];
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
		setManualOpen(false);
		setMessage("");
		userEditedRef.current = false;
		toast(state.data?.truncated ? "已提交当前列表内改动" : "已提交全部改动", { kind: "success" });
		await state.reload(true);
		onCommitted();
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
			if (isCurrentOp("suggesting", mine)) {
				setOp({ kind: "idle" });
			}
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
				setManualOpen(true);
				toast("没能生成提交说明，可手动填写", { kind: "info" });
				return;
			}
			await stageAndCommit(suggested);
		} catch (e) {
			if (isCurrentOp("aiSaving", mine)) {
				setCommitError(errorMessage(e));
				setManualOpen(true);
			}
		} finally {
			if (isCurrentOp("aiSaving", mine)) {
				setOp({ kind: "idle" });
			}
		}
	};

	const openCommitModal = () => {
		if (opRef.current.kind === "aiSaving" || opRef.current.kind === "committing" || opRef.current.kind === "fileOp") return;
		setManualOpen(false);
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
			await state.reload(true);
			onCommitted();
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
		onDiff({
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

	const actionInfo = actionFile ? splitPath(actionFile.path) : null;

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
							<div className="pb-[calc(var(--m-safe-bottom)+5.5rem)]">
								<div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2.5">
									<div className="flex min-w-0 flex-wrap items-center gap-2">
										<Chip tone="accent">
											<GitBranch size={13} strokeWidth={1.85} />
											<span className="max-w-[160px] truncate">{st.branch ?? "游离 HEAD"}</span>
										</Chip>
										<span className="text-m-xs whitespace-nowrap text-m-text-3">
											{stFiles.length > 0 ? `${stFiles.length}${st.truncated ? "+" : ""} 个改动` : "工作区干净"}
										</span>
									</div>
									{stFiles.length > 0 && (
										<Button variant="tonal" size="sm" disabled={aiSaving || committing || fileOperating} onClick={openCommitModal}>
											提交全部改动
										</Button>
									)}
								</div>

								{st.truncated && (
									<div
										role="status"
										className="mx-4 mb-3 flex items-start gap-2 rounded-m-md bg-m-warn-bg px-3 py-2 text-m-xs text-m-warn"
									>
										<AlertTriangle size={15} className="mt-0.5 shrink-0" />
										<span>改动文件超过 1000 个，列表已截断；暂存与提交操作仅覆盖当前显示范围内的文件。</span>
									</div>
								)}
								{stFiles.length > 0 && (
									<div className="mx-4 mb-3 space-y-2.5 rounded-m-lg border border-m-border bg-m-card p-3.5">
										<Button
											variant="primary"
											icon={<Sparkles size={15} strokeWidth={1.85} />}
											busy={aiSaving}
											disabled={committing || suggesting || fileOperating}
											onClick={() => void saveWithAi()}
											className="w-full"
										>
											AI 生成说明并保存
										</Button>
										<div className="flex items-center justify-between gap-2">
											<button
												type="button"
												aria-expanded={manualOpen}
												onClick={() => {
													setCommitError(null);
													setManualOpen((v) => !v);
												}}
												className="inline-flex min-h-8 items-center gap-1 rounded-m-pill px-1.5 text-m-xs font-medium whitespace-nowrap text-m-text-2 active:bg-m-surface"
											>
												{manualOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
												<span>自填提交说明</span>
											</button>
											<span className="text-m-xs whitespace-nowrap text-m-text-3">
												共 {stFiles.length}{st.truncated ? "+" : ""} 个文件
											</span>
										</div>
										{manualOpen && !commitOpen && (
											<div className="space-y-2.5 pt-0.5">
												<textarea
													value={message}
													onChange={(e) => {
														userEditedRef.current = true;
														setMessage(e.target.value);
													}}
													rows={3}
													aria-label="提交说明"
													placeholder="输入或编辑提交说明"
													autoCapitalize="off"
													className={`${inputCls} block resize-none rounded-m-lg`}
												/>
												<div className="flex items-center justify-between gap-2">
													<Button
														variant="tonal"
														size="sm"
														icon={<Sparkles size={14} strokeWidth={1.85} />}
														busy={suggesting}
														disabled={committing || aiSaving || fileOperating}
														onClick={() => void generateSuggestion()}
													>
														生成说明
													</Button>
													<Button
														variant="primary"
														size="sm"
														busy={committing}
														disabled={aiSaving || fileOperating || !message.trim()}
														onClick={() => void commitAll()}
													>
														提交改动
													</Button>
												</div>
											</div>
										)}
										{commitError && !commitOpen && (
											<p role="alert" className="m-selectable text-m-xs break-words text-m-danger">
												{commitError}
											</p>
										)}
									</div>
								)}

								{stFiles.length === 0 ? (
									<EmptyState icon={<GitCommitHorizontal size={22} strokeWidth={1.75} />} title="没有改动" hint="工作区是干净的" />
								) : (
									<ListGroup>
										{stFiles.map((f) => {
											const { name, dir } = splitPath(f.path);
											return (
												<div key={f.path} className="m-list-row flex w-full items-center pl-4">
													<div className="m-list-sep flex min-w-0 flex-1 items-center gap-2 pr-1.5">
														<button
															type="button"
															onClick={() => openFileDiff(f)}
															className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-3 text-left transition-colors duration-(--m-dur-fast) ease-m active:bg-m-surface-hover"
														>
															<Chip tone={statusTone(f.status)} className="min-w-11 shrink-0 justify-center">
																{STATUS_LABEL[f.status] ?? f.status}
															</Chip>
															<span className="min-w-0 flex-1">
																<span className="block text-m-md font-medium break-all text-m-text">{name}</span>
																{(dir || f.staged) && (
																	<span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-m-xs text-m-text-3">
																		{f.staged && (
																			<span className="rounded-sm bg-m-accent-soft/60 px-1.5 py-0.2 text-[11px] font-medium text-m-accent-soft-text">
																				{f.unstaged ? "部分暂存" : "已暂存"}
																			</span>
																		)}
																		{dir && <span className="break-all">{dir}</span>}
																	</span>
																)}
															</span>
														</button>
														<button
															type="button"
															aria-label={`操作 ${name}`}
															onClick={() => setActionFile(f)}
															className="flex h-11 w-11 shrink-0 items-center justify-center rounded-m-pill text-m-text-3 active:bg-m-surface-hover"
														>
															<MoreHorizontal size={18} strokeWidth={1.75} />
														</button>
													</div>
												</div>
											);
										})}
									</ListGroup>
								)}
							</div>
						);
					}}
				</LoadGate>
			</PullToRefresh>

			<BottomSheet
				open={active && actionFile !== null}
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

			<Dialog
				open={active && commitOpen}
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
							将暂存并提交全部 {files.length}{state.data?.truncated ? "+" : ""} 个改动文件
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
	const [showAllBranches, setShowAllBranches] = useState(false);
	const [branches, setBranches] = useState<BranchInfo[] | null>(null);
	const [branchLoading, setBranchLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const branchSeq = useRef(0);
	const scrollerRef = usePreservedScroll(visible);

	const loadBranches = useCallback(async () => {
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
	}, [base]);

	useEffect(() => {
		if (branchOpen) void loadBranches();
	}, [branchOpen, refreshNonce, loadBranches]);

	return (
		<PullToRefresh
			ref={scrollerRef}
			onRefresh={() =>
				Promise.all([state.reload(true), branchOpen ? loadBranches() : Promise.resolve()]).then(() => {})
			}
		>
			<LoadGate state={state}>
				{(raw) => {
					const cs = Array.isArray(raw) ? raw : Array.isArray(raw?.commits) ? raw.commits : [];
					const visibleBranches = branches ? (showAllBranches ? branches : branches.slice(0, 12)) : [];
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
											{visibleBranches.map((b) => (
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
											{branches.length > 12 && (
												<Button
													variant="ghost"
													size="sm"
													className="w-full"
													onClick={() => setShowAllBranches((v) => !v)}
												>
													{showAllBranches ? "收起分支列表" : `展开全部 ${branches.length} 个分支`}
												</Button>
											)}
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

import {
	ArrowLeft,
	ArrowUp,
	Code2,
	Eye,
	File as FileIcon,
	Folder,
	Image as ImageIcon,
	Search,
	Sparkles,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiUrl } from "../../core/api";
import { nav, paths, type PageProps } from "../../core/nav";
import { isDraftId } from "../../core/types";
import {
	Button,
	Chip,
	CodeBlock,
	EmptyState,
	IconButton,
	ListGroup,
	ListRow,
	PageHeader,
	PullToRefresh,
	Segmented,
	openImage,
} from "../../ui";
import { Markdown } from "../../ui/Markdown";
import { LoadGate } from "./PanelState";
import { useLayer, useLoad } from "./hooks";
import { breadcrumbs, fmtSize, langFromPath, splitPath, statusTone, type GitFile } from "./pure";
import { useRightDrawer } from "./rightDrawerStore";

interface DirEntry {
	name: string;
	path: string;
	kind: "dir" | "file";
	size: number;
}
interface DirData {
	path: string;
	parent: string | null;
	roots?: string[];
	entries: DirEntry[];
}
interface FileData {
	path: string;
	size: number;
	binary: boolean;
	truncated: boolean;
	text: string;
}
interface GitStatus {
	isRepo?: boolean;
	branch?: string | null;
	files?: GitFile[];
}

type FileScope = "changed" | "all";

const SCOPE_OPTIONS: ReadonlyArray<{ value: FileScope; label: string }> = [
	{ value: "changed", label: "本次改动" },
	{ value: "all", label: "全部文件" },
];

const STATUS_LABEL: Record<string, string> = {
	M: "修改",
	A: "新增",
	D: "删除",
	R: "重命名",
	"??": "新文件",
};

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
const RASTER_IMAGE_RE = /\.(png|jpe?g|gif|webp|ico|bmp)$/i;
const q = encodeURIComponent;
const ICON = { size: 20, strokeWidth: 1.75 } as const;

export function FilesPanel({ sessionId, embedded = false, active = true }: { sessionId: string; embedded?: boolean; active?: boolean }) {
	const draft = isDraftId(sessionId);
	const [dir, setDir] = useState<string | null>(null);
	const [file, setFile] = useState<{ entry: DirEntry; deleted?: boolean; repoRelative?: boolean } | null>(null);
	const [query, setQuery] = useState("");
	const [manualScope, setManualScope] = useState<FileScope | null>(null);

	const gitState = useLoad(
		(signal) =>
			draft
				? Promise.resolve<GitStatus>({ isRepo: false, files: [] })
				: api<GitStatus>("GET", `/sessions/${q(sessionId)}/git/status`, undefined, { signal }).catch(() => ({
						isRepo: false,
						files: [],
					})),
		[sessionId, draft],
	);

	const dirState = useLoad(
		(signal) => api<DirData>("GET", `/sessions/${q(sessionId)}/files${dir ? `?path=${q(dir)}` : ""}`, undefined, { signal }),
		[sessionId, dir],
	);

	const gitFiles = useMemo(
		() => (gitState.data?.isRepo && Array.isArray(gitState.data.files) ? gitState.data.files : []),
		[gitState.data],
	);
	const hasChanges = gitFiles.length > 0;
	const scope: FileScope = manualScope ?? (hasChanges ? "changed" : "all");

	const openDir = (p: string) => {
		setDir(p);
		setQuery("");
	};

	const closeFile = () => setFile(null);
	const parentDir = dirState.data?.parent ?? null;
	// Back gesture closes file preview first, or climbs directory levels in "全部文件" mode.
	useLayer(active && (file !== null || (scope === "all" && parentDir !== null)), () => {
		if (file) {
			closeFile();
		} else if (scope === "all" && parentDir) {
			openDir(parentDir);
		}
	});

	const data = dirState.data;
	const entries = useMemo(() => {
		if (!data || !Array.isArray(data.entries)) return [];
		const needle = query.trim().toLowerCase();
		if (!needle) return data.entries;
		return data.entries.filter((e) => e.name.toLowerCase().includes(needle) || e.path.toLowerCase().includes(needle));
	}, [data, query]);

	const filteredGitFiles = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return gitFiles;
		return gitFiles.filter((f) => f.path.toLowerCase().includes(needle));
	}, [gitFiles, query]);

	if (file) {
		return (
			<FileViewer
				sessionId={sessionId}
				entry={file.entry}
				deleted={file.deleted}
				repoRelative={file.repoRelative}
				embedded={embedded}
				onClose={closeFile}
			/>
		);
	}

	const refresh = () => Promise.all([dirState.reload(true), gitState.reload(true)]).then(() => {});

	const body = (
		<>
			<div className="shrink-0 space-y-2 border-b border-m-border px-4 pt-2 pb-2.5">
				<Segmented label="文件范围" value={scope} options={SCOPE_OPTIONS} onChange={setManualScope} />
				{scope === "all" && data && <Crumbs data={data} onOpen={openDir} />}
				<label className="flex min-h-10 items-center gap-2 rounded-m-pill bg-m-surface px-3.5">
					<Search size={16} strokeWidth={1.75} className="shrink-0 text-m-text-3" />
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={scope === "changed" ? "筛选改动文件" : "在当前目录中查找"}
						aria-label={scope === "changed" ? "筛选改动文件" : "在当前目录中查找"}
						className="min-h-10 min-w-0 flex-1 bg-transparent text-[16px] text-m-text outline-none placeholder:text-m-text-3 [&::-webkit-search-cancel-button]:hidden"
					/>
					{query && (
						<button
							type="button"
							aria-label="清空"
							onClick={() => setQuery("")}
							className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-m-pill text-m-text-3 active:bg-m-surface-hover"
						>
							<X size={16} />
						</button>
					)}
				</label>
			</div>

			<PullToRefresh onRefresh={refresh}>
				{scope === "changed" ? (
					<LoadGate state={gitState}>
						{() =>
							filteredGitFiles.length === 0 ? (
								<EmptyState
									icon={<FileIcon {...ICON} />}
									title={query ? "没有匹配的改动文件" : "当前没有改动文件"}
									hint={query ? undefined : "可以切换到「全部文件」浏览完整目录"}
									action={
										!query ? (
											<Button variant="tonal" onClick={() => setManualScope("all")}>
												浏览全部文件
											</Button>
										) : undefined
									}
								/>
							) : (
								<div className="pt-2" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 24px)" }}>
									<ListGroup>
										{filteredGitFiles.map((f) => {
											const { name, dir: relDir } = splitPath(f.path);
											return (
												<ListRow
													key={f.path}
													icon={
														<Chip tone={statusTone(f.status)} className="min-w-11 justify-center">
															{STATUS_LABEL[f.status] ?? f.status}
														</Chip>
													}
													title={<span className="break-all">{name}</span>}
													subtitle={relDir ? <span className="break-all">{relDir}</span> : undefined}
													onClick={() =>
														setFile({
															entry: { name, path: f.path, kind: "file", size: 0 },
															deleted: f.status === "D",
															repoRelative: true,
														})
													}
												/>
											);
										})}
									</ListGroup>
								</div>
							)
						}
					</LoadGate>
				) : (
					<LoadGate state={dirState}>
						{(d) =>
							entries.length === 0 ? (
								<EmptyState
									icon={<Folder {...ICON} />}
									title={query ? "没有找到匹配的文件" : "这个目录是空的"}
									action={
										d.parent && !query ? (
											<Button variant="tonal" icon={<ArrowUp size={17} />} onClick={() => openDir(d.parent as string)}>
												返回上一级
											</Button>
										) : undefined
									}
								/>
							) : (
								<div className="pt-2" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 24px)" }}>
									<ListGroup>
										{d.parent && !query && (
											<ListRow
												icon={<ArrowUp {...ICON} />}
												title="上一级"
												onClick={() => openDir(d.parent as string)}
												chevron={false}
											/>
										)}
										{entries.map((e) =>
											e.kind === "dir" ? (
												<ListRow
													key={e.path}
													icon={<Folder {...ICON} />}
													title={<span className="break-all">{e.name}</span>}
													onClick={() => openDir(e.path)}
												/>
											) : (
												<ListRow
													key={e.path}
													icon={IMAGE_EXT_RE.test(e.path) ? <ImageIcon {...ICON} /> : <FileIcon {...ICON} />}
													title={<span className="break-all">{e.name}</span>}
													right={fmtSize(e.size)}
													onClick={() => setFile({ entry: e })}
													chevron={false}
												/>
											),
										)}
									</ListGroup>
								</div>
							)
						}
					</LoadGate>
				)}
			</PullToRefresh>
		</>
	);

	if (embedded) return <div className="flex h-full min-h-0 flex-1 flex-col bg-m-bg">{body}</div>;

	return (
		<div className="flex h-full flex-col bg-m-bg">
			<PageHeader title="文件" subtitle="只读浏览" onBack={() => (parentDir && scope === "all" ? openDir(parentDir) : nav.back())} />
			{body}
		</div>
	);
}

export function FilesPage({ route }: PageProps) {
	return <FilesPanel sessionId={route.params.id} />;
}

/** Horizontally scrollable capsule breadcrumb; scrolled to the deepest segment. */
function Crumbs({ data, onOpen }: { data: DirData; onOpen: (path: string) => void }) {
	const dirPath = data.path ?? "";
	const roots = Array.isArray(data.roots) ? data.roots : [];
	const segs = useMemo(() => breadcrumbs(dirPath, roots), [dirPath, roots]);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el) el.scrollLeft = el.scrollWidth;
	}, [dirPath]);
	return (
		<div className="flex items-center gap-1">
			{data.parent && (
				<IconButton
					variant="plain"
					size="sm"
					icon={<ArrowUp size={17} strokeWidth={1.85} />}
					label="返回上一级"
					onClick={() => onOpen(data.parent as string)}
				/>
			)}
			<nav aria-label="路径" ref={ref} className="m-noscrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
				{segs.map((s, i) => {
					const last = i === segs.length - 1;
					return (
						<button
							key={s.path}
							type="button"
							aria-current={last ? "location" : undefined}
							onClick={() => !last && onOpen(s.path)}
							className="flex min-h-9 shrink-0 items-center justify-center"
						>
							<span
								className={`flex h-8 items-center rounded-m-pill px-3 text-m-xs whitespace-nowrap ${
									last ? "bg-m-accent-soft font-medium text-m-accent-soft-text" : "bg-m-surface text-m-text-2 active:bg-m-surface-2"
								}`}
							>
								{s.name}
							</span>
						</button>
					);
				})}
			</nav>
		</div>
	);
}

function FileViewer({
	sessionId,
	entry,
	deleted = false,
	repoRelative = false,
	embedded,
	onClose,
}: {
	sessionId: string;
	entry: DirEntry;
	deleted?: boolean;
	repoRelative?: boolean;
	embedded: boolean;
	onClose: () => void;
}) {
	const lang = langFromPath(entry.path);
	const isMd = lang === "markdown";
	const isImg = IMAGE_EXT_RE.test(entry.path);
	const isRasterImg = RASTER_IMAGE_RE.test(entry.path);
	const [preview, setPreview] = useState(isMd || isImg);

	useEffect(() => {
		setPreview(isMd || isImg);
	}, [entry.path, isMd, isImg]);

	const state = useLoad(
		(signal) =>
			deleted || isRasterImg
				? Promise.resolve<FileData>({ path: entry.path, size: entry.size, binary: isRasterImg, truncated: false, text: "" })
				: api<FileData>(
						"GET",
						`/sessions/${q(sessionId)}/file?path=${q(entry.path)}${repoRelative ? "&repoRelative=1" : ""}`,
						undefined,
						{ signal },
					),
		[sessionId, entry.path, entry.size, deleted, repoRelative, isRasterImg],
	);
	const askAi = () => {
		useRightDrawer.getState().sendToMainChat(sessionId, {
			quote: `文件：\`${entry.path}\``,
			comment: `请帮我查看并说明 \`${entry.path}\`：`,
			sourceLabel: `文件 · ${entry.name}`,
		});
		if (!embedded) nav.push(paths.chat(sessionId));
	};

	const headerRight = (
		<div className="flex shrink-0 items-center gap-1.5">
			{(isMd || (!isRasterImg && isImg)) && (
				<IconButton
					variant="filled"
					size="sm"
					icon={preview ? <Code2 size={18} strokeWidth={1.75} /> : <Eye size={18} strokeWidth={1.75} />}
					label={preview ? "查看源码" : "预览排版"}
					onClick={() => setPreview((v) => !v)}
				/>
			)}
			<Button variant="tonal" size="sm" icon={<Sparkles size={14} strokeWidth={1.85} />} onClick={askAi}>
				问 AI
			</Button>
		</div>
	);

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col bg-m-bg">
			{embedded ? (
				<div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-m-border px-3">
					<button
						type="button"
						onClick={onClose}
						aria-label="返回文件列表"
						className="inline-flex min-h-10 items-center gap-1 rounded-m-pill px-2 text-m-sm font-medium whitespace-nowrap text-m-accent active:bg-m-surface"
					>
						<ArrowLeft size={18} />
						<span>文件预览</span>
					</button>
					{headerRight}
				</div>
			) : (
				<PageHeader
					title="文件预览"
					subtitle={entry.size > 0 ? fmtSize(entry.size) : undefined}
					onBack={onClose}
					right={headerRight}
				/>
			)}
			<div
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3"
				style={{ paddingBottom: "calc(var(--m-safe-bottom) + 24px)" }}
			>
				<h1 className="m-selectable mb-1 px-1 text-m-lg font-medium break-all text-m-text">{entry.name}</h1>
				<div className="m-selectable mb-3 px-1 font-m-mono text-m-xs break-all text-m-text-3">{entry.path}</div>
				{deleted ? (
					<EmptyState
						icon={<FileIcon {...ICON} />}
						title="文件已在工作区删除"
						hint="可在 Git 面板查看该文件的删除差异"
					/>
				) : isRasterImg ? (
					<RasterImagePreview sessionId={sessionId} entry={entry} repoRelative={repoRelative} onAskAi={askAi} />
				) : (
					<LoadGate state={state}>
						{(data) => (
							<FileBody
								file={data}
								lang={lang}
								preview={preview}
								isSvg={isImg && entry.path.toLowerCase().endsWith(".svg")}
								name={entry.name}
							/>
						)}
					</LoadGate>
				)}
			</div>
		</div>
	);
}

function RasterImagePreview({
	sessionId,
	entry,
	repoRelative = false,
	onAskAi,
}: {
	sessionId: string;
	entry: DirEntry;
	repoRelative?: boolean;
	onAskAi: () => void;
}) {
	const candidates = useMemo(
		() => [
			apiUrl(`/sessions/${q(sessionId)}/files/raw?path=${q(entry.path)}${repoRelative ? "&repoRelative=1" : ""}`),
		],
		[sessionId, entry.path, repoRelative],
	);
	const [attempt, setAttempt] = useState(0);
	const [loaded, setLoaded] = useState(false);
	useEffect(() => {
		setAttempt(0);
		setLoaded(false);
	}, [entry.path, sessionId]);

	if (attempt >= candidates.length) {
		return (
			<EmptyState
				icon={<ImageIcon {...ICON} />}
				title="暂不支持直接预览此图片"
				hint={entry.size > 0 ? `${entry.name}（${fmtSize(entry.size)}）` : entry.name}
				action={
					<Button variant="tonal" icon={<Sparkles size={16} />} onClick={onAskAi}>
						让 AI 查看说明
					</Button>
				}
			/>
		);
	}

	const src = candidates[attempt];
	return (
		<div className="space-y-3">
			<button
				type="button"
				onClick={() => loaded && openImage({ src, alt: entry.name })}
				className="flex w-full items-center justify-center overflow-hidden rounded-m-lg border border-m-border bg-m-card p-3"
			>
				<img
					src={src}
					alt={entry.name}
					onLoad={() => setLoaded(true)}
					onError={() => {
						setLoaded(false);
						setAttempt((n) => n + 1);
					}}
					className="max-h-[55vh] w-auto max-w-full rounded-m-sm object-contain"
				/>
			</button>
			{loaded && <p className="text-center text-m-xs text-m-text-3">点击图片可放大查看</p>}
		</div>
	);
}

function FileBody({
	file,
	lang,
	preview,
	isSvg,
	name,
}: {
	file: FileData;
	lang?: string;
	preview: boolean;
	isSvg: boolean;
	name: string;
}) {
	if (file.binary) return <EmptyState icon={<FileIcon {...ICON} />} title="无法预览" hint={`二进制文件（${fmtSize(file.size)}）`} />;
	if (!file.text) return <EmptyState icon={<FileIcon {...ICON} />} title="空文件" />;

	if (isSvg && preview && file.text.includes("<svg")) {
		const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`;
		return (
			<button
				type="button"
				onClick={() => openImage({ src: svgUrl, alt: name })}
				className="flex w-full items-center justify-center overflow-hidden rounded-m-lg border border-m-border bg-m-card p-4"
			>
				<img src={svgUrl} alt={name} className="max-h-[55vh] w-auto max-w-full object-contain" />
			</button>
		);
	}

	return (
		<>
			{file.truncated && (
				<div className="mb-3 rounded-m-md bg-m-warn-bg px-4 py-3 text-m-sm text-m-warn">
					文件较大（{fmtSize(file.size)}），只显示前 512 KB
				</div>
			)}
			{preview && lang === "markdown" ? (
				<div className="m-selectable rounded-m-lg border border-m-border bg-m-card p-4">
					<Markdown text={file.text} />
				</div>
			) : (
				<CodeBlock code={file.text} lang={lang} wrap className="m-selectable" />
			)}
		</>
	);
}

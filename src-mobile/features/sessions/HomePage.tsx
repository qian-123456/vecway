import { Camera, FolderOpen, FolderPlus, History, ImagePlus, Lightbulb, Monitor, Paperclip, PenLine, Target } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../core/api";
import { baseName, relTime, sessionName } from "../../core/lib/format";
import { nav, paths, type PageProps } from "../../core/nav";
import { useSessions } from "../../core/stores/sessions";
import { BottomSheet, MenuRow, Switch, toast } from "../../ui";
import { ActionTile } from "../../ui/ActionTile";
import { ChatHeader } from "../chat/components/ChatHeader";
import { ComposerCapsule, type ComposerApi } from "../chat/components/ComposerCapsule";
import { useKeyboardOpen } from "../chat/components/ComposerToolbar";
import { HeaderMenu } from "../chat/components/HeaderMenu";
import { ModelThinkingSheet } from "../chat/components/ModelThinkingSheet";
import type { ModelSource } from "../chat/components/useModelFacts";
import { draftBook, queueComposerAction, queueFirstSend, type ComposerAction } from "../chat/lib/drafts";
import { parseModelRef, type ModelFacts, type ModelOpt } from "../chat/lib/models";
import { MenuSheet } from "./MenuSheet";
import { abbreviateHomePath, NewSessionSheet, setCachedHomeDir } from "./NewSessionSheet";
import { useTree } from "./treeStore";
import type { DirEntry } from "./tree";
export function HomePage(_props: PageProps) {
	const [newOpen, setNewOpen] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [toolMenu, setToolMenu] = useState(false);
	const [plusOpen, setPlusOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [sending, setSending] = useState(false);
	const mode = useTree((s) => s.mode);
	const allSessions = useSessions((s) => s.list);
	const kbOpen = useKeyboardOpen();
	const [directoryOpen, setDirectoryOpen] = useState(false);
	const [directory, setDirectory] = useState<DirEntry | null>(null);
	const [homeDir, setHomeDir] = useState<string | null>(null);
	const [directoryError, setDirectoryError] = useState<string | null>(null);
	const [planOn, setPlanOn] = useState(false);
	const appliedPlan = useRef(false);
	const submitting = useRef(false);
	const [facts, setFacts] = useState<ModelFacts>({ current: null, thinkingLevel: null, liveThinking: [] });
	const selection = useRef<ModelOpt | null>(null);
	const factsRef = useRef(facts);
	factsRef.current = facts;
	const apiRef = useRef<ComposerApi | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const cameraRef = useRef<HTMLInputElement>(null);
	const galleryRef = useRef<HTMLInputElement>(null);
	const creating = useRef<Promise<string> | null>(null);
	const modelSource = useMemo<ModelSource>(() => ({
		load: async () => {
			const r = await api<{ models?: ModelOpt[] }>("GET", "/left/roles");
			return { ...factsRef.current, models: r.models ?? [] };
		},
		setModel: async (m) => {
			selection.current = m;
			const next = { current: { provider: m.provider, id: m.id }, thinkingLevel: null, liveThinking: m.thinking ?? [] };
			setFacts(next);
			return next;
		},
		setThinking: async (level) => {
			const next = { ...factsRef.current, thinkingLevel: level };
			setFacts(next);
			return next;
		},
	}), []);

	useEffect(() => {
		let alive = true;
		void api<{ defaultModel?: string | null }>("GET", "/left/settings").then((r) => {
			const ref = parseModelRef(r.defaultModel);
			if (alive && ref && !selection.current) setFacts({ current: { provider: ref.provider, id: ref.id }, thinkingLevel: ref.thinking, liveThinking: [] });
		}).catch(() => {});
		return () => { alive = false; };
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		setDirectoryError(null);
		void api<{ dirs: DirEntry[]; homeDir?: string | null }>("GET", "/left/dirs", undefined, { signal: controller.signal }).then((response) => {
			if (controller.signal.aborted) return;
			const dirs = response.dirs ?? [];
			setHomeDir(response.homeDir ?? null);
			setCachedHomeDir(response.homeDir ?? null);
			setDirectory((current) => dirs.find((d) => d.path === current?.path && (!d.mode || d.mode === mode)) ?? dirs.find((d) => d.kind === "workspace" && d.mode === mode) ?? dirs.find((d) => d.mode === mode) ?? dirs[0] ?? null);
		}).catch((error) => { if (!controller.signal.aborted) setDirectoryError(errorMessage(error)); });
		return () => controller.abort();
	}, [mode]);

	const ensureDraft = (): Promise<string> => {
		if (creating.current) return creating.current;
		creating.current = (async () => {
			const res = await api<{ dirs: DirEntry[] }>("GET", "/left/dirs");
			const dirs = res.dirs ?? [];
			const mode = useTree.getState().mode;
			const dir = directory ? dirs.find((d) => d.path === directory.path) : dirs.find((d) => d.kind === "workspace" && d.mode === mode) ?? dirs.find((d) => d.mode === mode) ?? dirs[0];
			if (!dir?.path) throw new Error(directory ? "所选目录已不可用，请重新选择目录" : "未找到可用目录，请先在菜单或设置中添加工作区");
			const model = selection.current;
			const level = factsRef.current.thinkingLevel;
			const { id } = await useSessions.getState().createSession({ cwd: dir.path, mode: dir.kind === "global" ? "chat" : dir.mode ?? mode, ...(model ? { model: { provider: model.provider, modelId: model.id } } : {}), ...(level ? { thinking: level } : {}) });
			return id;
		})().catch((e) => { creating.current = null; throw e; });
		return creating.current;
	};

	const prepareDraft = async (): Promise<string> => {
		let id = await ensureDraft();
		if (planOn !== appliedPlan.current) {
			const result = await api<{ on: boolean; sessionId?: string }>("POST", `/sessions/${id}/plan-mode`, { on: planOn });
			// Enabling plan mode can materialize a process-free draft; use its real session id.
			if (result.sessionId) {
				id = result.sessionId;
				creating.current = Promise.resolve(id);
				void useSessions.getState().refresh().catch(() => {});
			}
			appliedPlan.current = result.on;
			if (result.on !== planOn) throw new Error("规划模式尚未切换成功，请重试");
		}
		return id;
	};

	const handleSend = async (value: string) => {
		const text = value.trim();
		if (!text || submitting.current) return;
		submitting.current = true;
		setSending(true);
		try {
			const id = await prepareDraft();
			queueFirstSend(id, text);
			const cur = apiRef.current?.get();
			if (cur === value) {
				apiRef.current?.clear();
			} else if (cur !== undefined) {
				const extra = cur.startsWith(value) ? cur.slice(value.length) : cur;
				draftBook.stash(id, extra, []);
			}
			nav.replace(paths.chat(id));
		} catch (e) {
			toast(`创建会话失败：${errorMessage(e)}`, { kind: "error" });
		} finally { submitting.current = false; setSending(false); }
	};

	const openAction = async (action?: ComposerAction, files?: File[]) => {
		if (submitting.current) return;
		submitting.current = true;
		setPlusOpen(false);
		setSending(true);
		try {
			const id = await prepareDraft();
			draftBook.stash(id, apiRef.current?.get() ?? "", []);
			queueComposerAction(id, action, files);
			nav.replace(paths.chat(id));
		} catch (e) {
			toast(`创建会话失败：${errorMessage(e)}`, { kind: "error" });
		} finally { submitting.current = false; setSending(false); }
	};

	const dirName = directory ? directory.label || baseName(directory.path) : directoryError ? "目录加载失败" : "选择项目目录";
	const dirSub = directory ? abbreviateHomePath(directory.path, homeDir) : directoryError ? "点击重试或切换目录" : "准备就绪";
	const recentSessions = useMemo(() => {
		const active = allSessions
			.filter((s) => !s.archived && (!s.mode || s.mode === mode))
			.sort((a, b) => Date.parse(String(b.updatedAt ?? "")) - Date.parse(String(a.updatedAt ?? "")));
		const matching = directory?.path ? active.filter((s) => s.cwd === directory.path) : active;
		return (matching.length > 0 ? matching : active).slice(0, 2);
	}, [allSessions, directory?.path, mode]);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col bg-m-bg">
			<ChatHeader
				title="Vecway"
				onMenu={() => setMenuOpen(true)}
				onTools={() => setToolMenu(true)}
			/>
			<div className="m-kb-lift relative flex min-h-0 flex-1 flex-col justify-center px-6 pb-8">
				<div className="text-center">
					<h1 className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[23px] font-semibold leading-snug tracking-[-0.02em] text-m-text">
						<span>在</span>
						<button
							type="button"
							aria-label={directory ? `当前目录：${directory.path}，点击切换` : "选择当前目录"}
							onClick={() => setDirectoryOpen(true)}
							className="inline-flex max-w-full items-center gap-1.5 border-b border-dashed border-m-border-strong pb-0.5 text-m-text transition-opacity active:opacity-70"
						>
							{directory ? (
								<FolderOpen size={19} strokeWidth={1.85} className="shrink-0 text-m-accent" aria-hidden />
							) : (
								<FolderPlus size={19} strokeWidth={1.85} className="shrink-0 text-m-accent" aria-hidden />
							)}
							<span className="truncate">{dirName}</span>
						</button>
						<span>中开始</span>
					</h1>
					<p className="mt-2 truncate font-m-mono text-[12px] leading-relaxed text-m-text-3 tabular-nums">
						{dirSub}
					</p>
				</div>

				{recentSessions.length > 0 && (
					<div className="mx-auto mt-8 w-full max-w-[360px] border-t border-m-border pt-3">
						<div className="pb-1 text-[11.5px] font-medium text-m-text-3">继续最近对话</div>
						<div className="divide-y divide-m-border">
							{recentSessions.map((item) => (
								<button
									key={item.id}
									type="button"
									onClick={() => nav.push(paths.chat(item.id))}
									className="flex min-h-10 w-full items-center justify-between gap-3 py-2 text-left text-m-sm text-m-text transition-opacity active:opacity-65"
								>
									<span className="inline-flex min-w-0 items-center gap-2">
										<History size={14} strokeWidth={1.75} className="shrink-0 text-m-text-3" aria-hidden />
										<span className="truncate">{sessionName(item)}</span>
									</span>
									<span className="shrink-0 text-[11.5px] whitespace-nowrap text-m-text-3 tabular-nums">
										{relTime(item.updatedAt)}
									</span>
								</button>
							))}
						</div>
					</div>
				)}
			</div>
			<div
				className="m-kb-dock relative shrink-0 bg-gradient-to-t from-m-bg via-m-bg/95 to-transparent px-3 pt-2"
				style={{ paddingBottom: kbOpen ? "8px" : "calc(var(--m-safe-bottom) + 8px)" }}
			>
				<ComposerCapsule
					apiRef={apiRef}
					placeholder="今天想做点什么？"
					busy={sending}
					onPlus={() => setPlusOpen(true)}
					onSend={(text) => void handleSend(text)}
					model={facts.current?.id}
					thinking={facts.thinkingLevel}
					onModel={() => setModelOpen(true)}
					onThinking={() => setModelOpen(true)}
				/>
			</div>
			<input ref={fileRef} type="file" multiple hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) void openAction(undefined, files); }} />
			<input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) void openAction(undefined, files); }} />
			<input ref={galleryRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) void openAction(undefined, files); }} />
			<BottomSheet open={plusOpen} onClose={() => setPlusOpen(false)}>
				<div className="grid grid-cols-3 gap-3 px-4 pt-1">
					<ActionTile icon={<Paperclip size={24} />} label="文件" onClick={() => fileRef.current?.click()} />
					<ActionTile icon={<Camera size={24} />} label="拍照" onClick={() => cameraRef.current?.click()} />
					<ActionTile icon={<ImagePlus size={24} />} label="相册" onClick={() => galleryRef.current?.click()} />
					<ActionTile icon={<Monitor size={24} />} label="电脑端选中项" onClick={() => void openAction("finder")} />
					<ActionTile icon={<PenLine size={24} />} label="草图" onClick={() => void openAction("sketch")} />
				</div>
				<div className="pt-3 pb-3">
					<MenuRow icon={<FolderOpen size={22} />} label="在项目中工作" hint="选择项目目录" onClick={() => { setPlusOpen(false); setDirectoryOpen(true); }} />
					<MenuRow icon={<Target size={22} />} label="目标" hint="设定后会持续朝它推进" onClick={() => void openAction("goal")} />
					<div className="flex min-h-13 items-center gap-4 py-1 pr-4 pl-5"><Lightbulb size={22} className="shrink-0 text-m-text-2" /><span className="flex-1 whitespace-nowrap text-m-md">规划模式</span><Switch label="规划模式" checked={planOn} disabled={sending} onChange={setPlanOn} /></div>
				</div>
			</BottomSheet>
			<MenuSheet open={menuOpen} onClose={() => setMenuOpen(false)} onNewSession={() => setNewOpen(true)} />
			<HeaderMenu open={toolMenu} onClose={() => setToolMenu(false)} resolveSessionId={ensureDraft} />
			<NewSessionSheet open={newOpen} onClose={() => setNewOpen(false)} defaultCwd={directory?.path} />
			<NewSessionSheet open={directoryOpen} onClose={() => setDirectoryOpen(false)} defaultCwd={directory?.path} onSelectDirectory={(dir) => {
				if (dir.path !== directory?.path) { creating.current = null; appliedPlan.current = false; }
				setDirectory(dir);
			}} />
			<ModelThinkingSheet open={modelOpen} onClose={() => setModelOpen(false)} source={modelSource} currentLevel={facts.thinkingLevel} onFacts={(next) => setFacts(next)} />
		</div>
	);
}

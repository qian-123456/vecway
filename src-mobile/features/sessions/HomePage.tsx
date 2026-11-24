import { Camera, FileText, FolderOpen, ImagePlus, Lightbulb, Monitor, Paperclip, PenLine, RotateCcw, Target, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, upload } from "../../core/api";
import { baseName } from "../../core/lib/format";
import { imageFromBlob } from "../../core/lib/images";
import { nav, paths, type PageProps } from "../../core/nav";
import { useSessions } from "../../core/stores/sessions";
import { BottomSheet, MenuRow, openImage, Spinner, Switch, toast, type ViewerImage } from "../../ui";
import { ActionTile } from "../../ui/ActionTile";
import { quoteMarkdown, type Attachment } from "../chat/chatStore";
import { ChatHeader } from "../chat/components/ChatHeader";
import { ComposerCapsule, type ComposerApi } from "../chat/components/ComposerCapsule";
import { useKeyboardOpen } from "../chat/components/ComposerToolbar";
import { EmptyChatCanvas } from "../chat/components/EmptyChatCanvas";
import { ModelThinkingSheet } from "../chat/components/ModelThinkingSheet";
import { ThinkingSourcePopover } from "../chat/components/ThinkingLevelPopover";
import { SketchPad } from "../chat/components/SketchPad";
import type { ModelSource } from "../chat/components/useModelFacts";
import { draftBook, queueComposerAction, queueFirstSend, type ComposerAction } from "../chat/lib/drafts";
import { parseModelRef, type ModelFacts, type ModelOpt } from "../chat/lib/models";
import { attachmentBlocker } from "../chat/lib/prompt";
import { hasBlockingOverlay } from "../../ui/overlay";
import { useRightDrawer } from "../panels/rightDrawerStore";
import { RightWorkspaceDrawer, useRightEdgeSwipe } from "../panels/RightWorkspaceDrawer";
import { MenuSheet } from "./MenuSheet";
import { abbreviateHomePath, NewSessionSheet, setCachedHomeDir } from "./NewSessionSheet";
import { useTree } from "./treeStore";
import type { DirEntry } from "./tree";

const MAX_BYTES = 20 * 1024 * 1024;
export function HomePage(_props: PageProps) {
	const [newOpen, setNewOpen] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [sketchOpen, setSketchOpen] = useState(false);
	const [atts, setAtts] = useState<Attachment[]>([]);
	const [plusOpen, setPlusOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [thinkingAnchor, setThinkingAnchor] = useState<HTMLElement | null>(null);
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
	const [draftId, setDraftId] = useState<string>("");
	const draftIdRef = useRef("");
	draftIdRef.current = draftId;
	const cachedDraftCwd = useRef<string | null>(null);
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
	const attSeq = useRef(0);
	const attsRef = useRef(atts);
	attsRef.current = atts;
	const modelKey = selection.current
		? `${selection.current.provider}/${selection.current.id}`
		: facts.current
			? `${facts.current.provider}/${facts.current.id}`
			: "";
	const draftScopeKey = JSON.stringify({
		cwd: directory?.path ?? "",
		spaceId: mode,
		modelKey,
		thinking: facts.thinkingLevel ?? "",
	});
	const draftScopeRef = useRef(draftScopeKey);

	useLayoutEffect(() => {
		if (draftScopeRef.current === draftScopeKey) return;
		draftScopeRef.current = draftScopeKey;
		creating.current = null;
		appliedPlan.current = false;
		cachedDraftCwd.current = null;
		const prevId = draftIdRef.current;
		if (prevId) {
			setDraftId("");
			useRightDrawer.getState().resetSession(prevId);
		}
		if (attsRef.current.some((a) => !a.isImage && a.path)) {
			setAtts((prev) => prev.map((a) => (!a.isImage && a.path ? { ...a, path: undefined } : a)));
		}
	}, [draftScopeKey]);
	const transferredUrls = useRef(new Set<string>());
	const pendingMain = useRightDrawer((s) => s.pendingMain);
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
	useEffect(() => {
		return () => {
			for (const a of attsRef.current) {
				if (a.url && !transferredUrls.current.has(a.url)) URL.revokeObjectURL(a.url);
			}
		};
	}, []);

	useEffect(() => {
		if (!pendingMain) return;
		const payload = useRightDrawer.getState().consumeMainAnnotation(pendingMain.sessionId);
		if (!payload) return;
		const block = quoteMarkdown(payload.quote);
		const formatted = payload.comment?.trim() ? `${block}\n\n${payload.comment.trim()}` : `${block}\n\n`;
		const cur = apiRef.current?.get() ?? "";
		const next = cur ? `${cur.replace(/\s+$/, "")}\n\n${formatted}` : formatted;
		apiRef.current?.set(next, true);
	}, [pendingMain]);

	useRightEdgeSwipe(() => {
		if (!hasBlockingOverlay()) useRightDrawer.getState().openDrawer(draftIdRef.current);
	}, true);

	const addFiles = (files: readonly File[], forceImage = false) => {
		if (submitting.current) return;
		for (const f of files) {
			if (f.size > MAX_BYTES) {
				toast(`「${f.name}」超过 20MB 上限，无法上传`);
				continue;
			}
			const isImage = forceImage || f.type.startsWith("image/");
			const attId = ++attSeq.current;
			const url = isImage ? URL.createObjectURL(f) : "";
			let attRef: Attachment = {
				id: attId,
				name: f.name || (isImage ? "image.jpg" : "file"),
				isImage,
				url,
				status: isImage ? "up" : "ok",
				file: f,
			};
			setAtts((prev) => [...prev, attRef]);
			if (isImage) {
				void imageFromBlob(f)
					.then((image) => {
						const updated: Attachment = { ...attRef, status: "ok", image, err: undefined };
						draftBook.replaceAttachment(attRef, updated);
						attRef = updated;
						setAtts((prev) => prev.map((a) => (a.id === attId ? { ...a, status: "ok", image, err: undefined } : a)));
					})
					.catch((e: unknown) => {
						const err = errorMessage(e);
						const updated: Attachment = { ...attRef, status: "err", err };
						draftBook.replaceAttachment(attRef, updated);
						attRef = updated;
						setAtts((prev) => prev.map((a) => (a.id === attId ? { ...a, status: "err", err } : a)));
						toast(`读取图片失败：${err}`, { kind: "error" });
					});
			}
		}
	};

	const removeAtt = (attId: number) => {
		if (submitting.current) return;
		setAtts((prev) => {
			const target = prev.find((a) => a.id === attId);
			if (target?.url) URL.revokeObjectURL(target.url);
			return prev.filter((a) => a.id !== attId);
		});
	};

	const resolveActiveDirectory = (dirs: readonly DirEntry[], targetDir: DirEntry | null, activeMode: string): DirEntry => {
		const dir = targetDir
			? dirs.find((d) => d.path === targetDir.path)
			: dirs.find((d) => d.kind === "workspace" && d.mode === activeMode) ?? dirs.find((d) => d.mode === activeMode) ?? dirs[0];
		if (!dir?.path) throw new Error(targetDir ? "所选目录已不可用，请重新选择目录" : "未找到可用目录，请先在菜单或设置中添加工作区");
		return dir;
	};

	const invalidateDraftCache = (clearMissingSelection = false) => {
		creating.current = null;
		appliedPlan.current = false;
		cachedDraftCwd.current = null;
		const prevId = draftIdRef.current;
		if (prevId) {
			setDraftId("");
			useRightDrawer.getState().resetSession(prevId);
		}
		if (clearMissingSelection) setDirectory(null);
	};

	const createFreshDraft = (): Promise<string> => {
		const scopeAtStart = draftScopeRef.current;
		const targetDir = directory;
		const promise = (async () => {
			const res = await api<{ dirs: DirEntry[] }>("GET", "/left/dirs");
			const activeMode = useTree.getState().mode;
			const dir = resolveActiveDirectory(res.dirs ?? [], targetDir, activeMode);
			const model = selection.current;
			const level = factsRef.current.thinkingLevel;
			const { id } = await useSessions.getState().createSession({
				cwd: dir.path,
				mode: dir.kind === "global" ? "chat" : dir.mode ?? activeMode,
				...(model ? { model: { provider: model.provider, modelId: model.id } } : {}),
				...(level ? { thinking: level } : {}),
			});
			if (draftScopeRef.current !== scopeAtStart) {
				throw new Error("会话设置已变更，请重试");
			}
			cachedDraftCwd.current = dir.path;
			setDraftId(id);
			return id;
		})().catch((e) => {
			if (creating.current === promise) creating.current = null;
			throw e;
		});
		creating.current = promise;
		return promise;
	};

	const ensureDraft = async (revalidateDir = false): Promise<string> => {
		if (creating.current) {
			const existingId = await creating.current;
			if (!revalidateDir) return existingId;
			const res = await api<{ dirs: DirEntry[] }>("GET", "/left/dirs");
			const activeMode = useTree.getState().mode;
			let dir: DirEntry;
			try {
				dir = resolveActiveDirectory(res.dirs ?? [], directory, activeMode);
			} catch (e) {
				invalidateDraftCache(Boolean(directory));
				throw e;
			}
			if (!cachedDraftCwd.current || dir.path === cachedDraftCwd.current) return existingId;
			invalidateDraftCache();
			return createFreshDraft();
		}
		return createFreshDraft();
	};

	const prepareDraft = async (revalidateDir = false): Promise<string> => {
		let id = await ensureDraft(revalidateDir);
		if (planOn !== appliedPlan.current) {
			const result = await api<{ on: boolean; sessionId?: string }>("POST", `/sessions/${id}/plan-mode`, { on: planOn });
			// Enabling plan mode can materialize a process-free draft; use its real session id.
			if (result.sessionId) {
				id = result.sessionId;
				creating.current = Promise.resolve(id);
				setDraftId(id);
				void useSessions.getState().refresh().catch(() => {});
			}
			appliedPlan.current = result.on;
			if (result.on !== planOn) throw new Error("规划模式尚未切换成功，请重试");
		}
		return id;
	};

	const retryAtt = async (attId: number) => {
		if (submitting.current) return;
		const target = attsRef.current.find((a) => a.id === attId);
		if (!target || target.status !== "err" || !target.file) return;
		setAtts((prev) => prev.map((a) => (a.id === attId ? { ...a, status: "up", err: undefined } : a)));
		if (target.isImage) {
			try {
				const image = await imageFromBlob(target.file);
				setAtts((prev) => prev.map((a) => (a.id === attId ? { ...a, status: "ok", image, err: undefined } : a)));
			} catch (e: unknown) {
				const err = errorMessage(e);
				setAtts((prev) => prev.map((a) => (a.id === attId ? { ...a, status: "err", err } : a)));
				toast(`读取图片失败：${err}`, { kind: "error" });
			}
			return;
		}
		try {
			const id = await ensureDraft();
			const res = await upload<{ path: string }>(`/sessions/${id}/upload`, target.file, { name: target.name });
			setAtts((prev) => prev.map((a) => (a.id === attId ? { ...a, status: "ok", path: res.path, err: undefined } : a)));
		} catch (e: unknown) {
			const err = errorMessage(e);
			setAtts((prev) => prev.map((a) => (a.id === attId ? { ...a, status: "err", err } : a)));
			toast(`上传失败：${err}`, { kind: "error" });
		}
	};

	const uploadPendingFiles = async (id: string, snapshot: Attachment[]): Promise<Attachment[] | null> => {
		if (!snapshot.some((a) => !a.isImage && a.file && !a.path)) return snapshot;
		const uploaded: Attachment[] = [];
		for (const a of snapshot) {
			if (!a.isImage && a.file && !a.path) {
				setAtts((prev) => prev.map((x) => (x.id === a.id ? { ...x, status: "up", err: undefined } : x)));
				try {
					const res = await upload<{ path: string }>(`/sessions/${id}/upload`, a.file, { name: a.name });
					const nextAtt: Attachment = { ...a, status: "ok", path: res.path, err: undefined };
					setAtts((prev) => prev.map((x) => (x.id === a.id ? nextAtt : x)));
					uploaded.push(nextAtt);
				} catch (e) {
					const err = errorMessage(e);
					setAtts((prev) => prev.map((x) => (x.id === a.id ? { ...x, status: "err", err } : x)));
					toast(`上传失败：${err}`, { kind: "error" });
					return null;
				}
			} else {
				uploaded.push(a);
			}
		}
		return uploaded;
	};

	const handleSend = async (value: string) => {
		const text = value.trim();
		const currentAtts = attsRef.current;
		if ((!text && currentAtts.length === 0) || submitting.current) return;
		const blocker = attachmentBlocker(currentAtts);
		if (blocker) {
			toast(blocker);
			return;
		}
		submitting.current = true;
		setSending(true);
		try {
			const id = await prepareDraft(true);
			const finalAtts = await uploadPendingFiles(id, currentAtts);
			if (!finalAtts) return;
			for (const a of finalAtts) if (a.url) transferredUrls.current.add(a.url);
			const cur = apiRef.current?.get();
			let extra = "";
			if (cur === value) {
				apiRef.current?.clear();
			} else if (cur !== undefined) {
				extra = cur.startsWith(value) ? cur.slice(value.length) : cur;
			}
			if (finalAtts.length > 0 || extra !== "") {
				draftBook.stash(id, extra, finalAtts);
			}
			setAtts([]);
			queueFirstSend(id, text);
			nav.replace(paths.chat(id));
		} catch (e) {
			toast(`创建会话失败：${errorMessage(e)}`, { kind: "error" });
		} finally { submitting.current = false; setSending(false); }
	};

	const openAction = async (action?: ComposerAction, files?: File[]) => {
		if (submitting.current) return;
		const currentAtts = attsRef.current;
		if (currentAtts.length > 0) {
			const blocker = attachmentBlocker(currentAtts);
			if (blocker) {
				toast(blocker);
				return;
			}
		}
		submitting.current = true;
		setPlusOpen(false);
		setSending(true);
		try {
			const id = await prepareDraft(true);
			const finalAtts = await uploadPendingFiles(id, currentAtts);
			if (!finalAtts) return;
			for (const a of finalAtts) if (a.url) transferredUrls.current.add(a.url);
			draftBook.stash(id, apiRef.current?.get() ?? "", finalAtts);
			setAtts([]);
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
	const imageAtts = atts.filter((a) => a.isImage);
	const fileAtts = atts.filter((a) => !a.isImage);
	const imageGallery: ViewerImage[] = imageAtts.filter((a) => a.url).map((a) => ({ src: a.url, alt: a.name }));
	const attachments =
		atts.length > 0 ? (
			<div className="m-noscrollbar flex max-h-[24vh] flex-col gap-1.5 overflow-y-auto overscroll-contain px-1 pt-1 pb-2">
				{imageAtts.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{imageAtts.map((a, idx) => {
							const galleryIndex = imageGallery.findIndex((g) => g.src === a.url);
							const isErr = a.status === "err";
							return (
								<div
									key={a.id}
									className={`relative h-13 w-13 shrink-0 overflow-hidden rounded-m-md bg-m-surface-2 ring-1 shadow-m-card ${isErr ? "ring-m-danger" : "ring-m-border/75"}`}
								>
									{a.url && (
										<button
											type="button"
											disabled={sending}
											aria-label={isErr ? `重试上传 ${a.name}` : `预览图片 ${idx + 1}`}
											onClick={() => (isErr ? void retryAtt(a.id) : openImage({ src: a.url, alt: a.name }, imageGallery, galleryIndex >= 0 ? galleryIndex : 0))}
											className="m-press block h-full w-full"
										>
											<img src={a.url} alt={a.name} className="h-full w-full object-cover" />
										</button>
									)}
									<span className="pointer-events-none absolute top-1 left-1 flex h-4 min-w-4 items-center justify-center rounded-m-pill bg-m-scrim/75 px-1 text-[10px] font-medium text-white tabular-nums">
										{idx + 1}
									</span>
									{a.status === "up" && (
										<span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-m-scrim/40 text-white">
											<Spinner size={14} />
										</span>
									)}
									{isErr && (
										<span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-m-danger-bg/85 text-m-danger">
											<RotateCcw size={13} aria-hidden />
											<span className="text-[9px] font-medium whitespace-nowrap">重试</span>
										</span>
									)}
									<button
										type="button"
										disabled={sending}
										aria-label="移除附件"
										onClick={() => removeAtt(a.id)}
										className="m-press absolute top-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-m-scrim/75 text-white active:opacity-80 disabled:opacity-40"
									>
										<X size={12} strokeWidth={2} />
									</button>
								</div>
							);
						})}
					</div>
				)}
				{fileAtts.length > 0 && (
					<div className="m-noscrollbar flex gap-2 overflow-x-auto">
						{fileAtts.map((a) => (
							<div key={a.id} className={`relative flex shrink-0 items-center gap-2 rounded-m-md bg-m-surface-2/90 py-1.5 pr-8 pl-2 ring-1 shadow-m-card ${a.status === "err" ? "ring-m-danger" : "ring-m-border/75"}`}>
								<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-m-sm bg-m-surface text-m-text-2">
									<FileText size={16} strokeWidth={1.75} />
								</span>
								<span className="flex min-w-0 flex-col">
									<span className="max-w-36 truncate text-m-xs text-m-text">{a.name}</span>
									{a.status === "up" && (
										<span className="flex items-center gap-1 text-[11px] whitespace-nowrap text-m-text-3">
											<Spinner size={11} />
											上传中
										</span>
									)}
									{a.status === "err" && (
										<button
											type="button"
											disabled={sending}
											onClick={() => void retryAtt(a.id)}
											className="inline-flex items-center gap-1 text-left text-[11px] font-medium whitespace-nowrap text-m-danger active:opacity-75 disabled:opacity-40"
										>
											<RotateCcw size={10} aria-hidden />
											<span>上传失败，点击重试</span>
										</button>
									)}
								</span>
								<button
									type="button"
									disabled={sending}
									aria-label="移除附件"
									onClick={() => removeAtt(a.id)}
									className="m-press absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-m-text-3 active:bg-m-surface-hover disabled:opacity-40"
								>
									<X size={14} />
								</button>
							</div>
						))}
					</div>
				)}
			</div>
		) : undefined;

	return (
		<div className="relative flex min-h-0 flex-1 flex-col bg-m-bg">
			<div className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: "var(--m-glow)" }} aria-hidden="true" />
			<ChatHeader
				title="Vecway"
				onMenu={() => setMenuOpen(true)}
				onTools={() => useRightDrawer.getState().toggleDrawer(draftId)}
			/>
			<EmptyChatCanvas
				dirName={dirName}
				dirSub={dirSub}
				hasDirectory={Boolean(directory)}
				directoryPath={directory?.path ?? null}
				onPickDirectory={() => setDirectoryOpen(true)}
				recentSessions={recentSessions}
			/>
			<div
				className="m-kb-dock relative shrink-0 bg-gradient-to-t from-m-bg via-m-bg/95 to-transparent px-3.5 pt-3"
				style={{ paddingBottom: kbOpen ? "10px" : "calc(var(--m-safe-bottom) + 12px)" }}
			>
				{planOn && (
					<div className="mb-2 flex justify-start">
						<button
							type="button"
							aria-label="关闭规划模式"
							disabled={sending}
							onClick={() => setPlanOn(false)}
							className="m-press m-liquid-surface inline-flex min-h-8 items-center gap-1.5 rounded-m-pill px-3 py-1 text-m-xs font-medium whitespace-nowrap text-m-accent disabled:opacity-50"
						>
							<Lightbulb size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
							<span>规划模式已开启</span>
							<X size={12} strokeWidth={1.85} className="shrink-0 text-m-text-3" aria-hidden="true" />
						</button>
					</div>
				)}
				<ComposerCapsule
					apiRef={apiRef}
					placeholder="今天想做点什么？"
					busy={sending}
					hasExtra={atts.length > 0}
					top={attachments}
					onPlus={() => { if (!submitting.current) setPlusOpen(true); }}
					onSend={(text) => void handleSend(text)}
					model={facts.current?.id}
					thinking={facts.thinkingLevel}
					onModel={() => setModelOpen(true)}
					onThinking={(el) => {
						setThinkingAnchor(el ?? null);
						setThinkingOpen(true);
					}}
				/>
			</div>
			<input ref={fileRef} type="file" multiple hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) { setPlusOpen(false); addFiles(files); } }} />
			<input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) { setPlusOpen(false); addFiles(files, true); } }} />
			<input ref={galleryRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) { setPlusOpen(false); addFiles(files, true); } }} />
			<BottomSheet open={plusOpen} onClose={() => setPlusOpen(false)}>
				<div className="grid grid-cols-4 gap-2 px-4 pt-1">
					<ActionTile icon={<Camera size={22} strokeWidth={1.75} />} label="拍照" onClick={() => cameraRef.current?.click()} />
					<ActionTile icon={<ImagePlus size={22} strokeWidth={1.75} />} label="相册" onClick={() => galleryRef.current?.click()} />
					<ActionTile icon={<Paperclip size={22} strokeWidth={1.75} />} label="文件" onClick={() => fileRef.current?.click()} />
					<ActionTile icon={<PenLine size={22} strokeWidth={1.75} />} label="草图" onClick={() => { setPlusOpen(false); setSketchOpen(true); }} />
				</div>
				<div className="pt-3 pb-3">
					<MenuRow icon={<Monitor size={21} strokeWidth={1.75} />} label="电脑端文件" hint="插入电脑工作区中的文件" onClick={() => void openAction("finder")} />
					<MenuRow icon={<FolderOpen size={21} strokeWidth={1.75} />} label="在项目中工作" hint="选择项目目录" onClick={() => { setPlusOpen(false); setDirectoryOpen(true); }} />
					<MenuRow icon={<Target size={21} strokeWidth={1.75} />} label="目标" hint="设定持续推进的任务目标" onClick={() => void openAction("goal")} />
					<div className="flex min-h-13 items-center gap-3.5 py-1.5 pr-4 pl-5"><Lightbulb size={21} strokeWidth={1.75} className="shrink-0 text-m-text-2" /><span className="flex-1 whitespace-nowrap text-m-md">规划模式</span><Switch label="规划模式" checked={planOn} disabled={sending} onChange={setPlanOn} /></div>
				</div>
			</BottomSheet>
			<MenuSheet open={menuOpen} onClose={() => setMenuOpen(false)} onNewSession={() => setNewOpen(true)} />
			<RightWorkspaceDrawer sessionId={draftId || undefined} resolveSessionId={() => ensureDraft(false)} />
			<NewSessionSheet open={newOpen} onClose={() => setNewOpen(false)} defaultCwd={directory?.path} />
			<NewSessionSheet open={directoryOpen} onClose={() => setDirectoryOpen(false)} defaultCwd={directory?.path} onSelectDirectory={(dir) => {
				if (dir.path !== directory?.path) { creating.current = null; appliedPlan.current = false; }
				setDirectory(dir);
			}} />
			<ModelThinkingSheet open={modelOpen} onClose={() => setModelOpen(false)} source={modelSource} currentLevel={facts.thinkingLevel} onFacts={(next) => setFacts(next)} />
			<ThinkingSourcePopover
				open={thinkingOpen}
				onClose={() => setThinkingOpen(false)}
				anchorEl={thinkingAnchor}
				source={modelSource}
				currentLevel={facts.thinkingLevel}
				onFacts={(next) => setFacts(next)}
			/>
			<SketchPad
				open={sketchOpen}
				onClose={() => setSketchOpen(false)}
				onDone={(blob) => {
					setSketchOpen(false);
					addFiles([new File([blob], `sketch-${Date.now()}.png`, { type: "image/png" })], true);
				}}
			/>
		</div>
	);
}

import { CalendarClock, Camera, FileText, FolderOpen, GitBranch, ImageOff, ImagePlus, Lightbulb, Monitor, Paperclip, PenLine, RotateCcw, Target, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { api, errorMessage } from "../../../core/api";
import { baseName } from "../../../core/lib/format";
import { toDataUrl } from "../../../core/lib/images";
import { nav, paths } from "../../../core/nav";
import { usePref } from "../../../core/stores/prefs";
import { useSession, useSessions } from "../../../core/stores/sessions";
import { BottomSheet, IconButton, MenuRow, openImage, Spinner, Switch, toast, type ViewerImage } from "../../../ui";
import { ActionTile } from "../../../ui/ActionTile";
import type { Attachment } from "../chatStore";
import { useChat, useChatUi } from "../ChatContext";
import { contextTone, formatContextPercent, queueChipText, resolveContextPercent } from "../lib/context";
import { draftBook, takeComposerAction } from "../lib/drafts";
import { BEHAVIOR_HINT, BEHAVIOR_LABEL, type StreamBehavior } from "../lib/prompt";
import { commandAction, commandInput, detectSlashQuery, type SlashCmd } from "../lib/slash";
import { clearUnsent, saveUnsent, UNSENT_DEBOUNCE_MS } from "../lib/unsent";
import { ComposerCapsule, type ComposerApi } from "./ComposerCapsule";
import { useKeyboardOpen } from "./ComposerToolbar";
import { ContextSheet } from "./ContextSheet";
import { GoalSheet, goalLabel } from "./GoalSheet";
import { RemoteFilePickerSheet } from "./RemoteFilePickerSheet";
import { SketchPad } from "./SketchPad";
import { SlashPopup } from "./SlashSheet";
import { WorkspacePickerSheet } from "./WorkspacePickerSheet";

type Sheet = "plus" | "goal" | "context" | "finder" | "workspace" | null;
const TONE_TEXT = { neutral: "text-m-text-3", warn: "text-m-warn", danger: "text-m-danger" } as const;

export function Composer({
	sessionId,
	onOpenPicker,
	onOpenThinking,
	thinkingSupported,
}: {
	sessionId: string;
	onOpenPicker?: () => void;
	onOpenThinking?: (anchor: HTMLElement | null) => void;
	thinkingSupported?: boolean | null;
}) {
	const { controller } = useChatUi();
	const session = useSession(sessionId);
	const working = useChat((s) => s.working);
	const stopping = useChat((s) => s.stopping);
	const atts = useChat((s) => s.atts);
	const cstate = useChat((s) => s.cstate);
	const automationState = useChat((s) => s.automationState);
	const forkFrom = useChat((s) => s.forkFrom);
	const treeEdit = useChat((s) => s.treeEdit);
	const compacting = useChat((s) => s.compacting);
	const [behavior, setBehavior] = usePref<StreamBehavior>("chat.streamBehavior", "followUp");
	const kbOpen = useKeyboardOpen();
	const [slashQuery, setSlashQuery] = useState<string | null>(null);
	const [sheet, setSheet] = useState<Sheet>(null);
	const [sketch, setSketch] = useState(false);
	const [canSend, setCanSend] = useState(false);
	const composerRef = useRef<HTMLDivElement>(null);
	const apiRef = useRef<ComposerApi | null>(null);
	const [contextAnchor, setContextAnchor] = useState<HTMLElement | null>(null);
	const saveTimer = useRef<number | undefined>(undefined);
	const fileAny = useRef<HTMLInputElement>(null);
	const fileCamera = useRef<HTMLInputElement>(null);
	const fileGallery = useRef<HTMLInputElement>(null);
	const onInput = useCallback(() => {
		clearTimeout(saveTimer.current);
		saveTimer.current = window.setTimeout(() => saveUnsent(sessionId, apiRef.current?.get() ?? ""), UNSENT_DEBOUNCE_MS);
		controller.noteEdit();
	}, [controller, sessionId]);

	const onSync = useCallback((v: string) => setSlashQuery(detectSlashQuery(v)), []);

	const onUnmount = useCallback(
		(v: string) => {
			controller.lastText = v;
			clearTimeout(saveTimer.current);
			saveUnsent(sessionId, v);
		},
		[controller, sessionId],
	);

	// Hand the textarea to the controller (restore on failed send, annotations, edit/fork).
	useLayoutEffect(() => {
		controller.composer = apiRef.current;
		return () => {
			controller.composer = null;
		};
	}, [controller]);

	// Flush pending text if the tab is closed/backgrounded before the debounce fires.
	useEffect(() => {
		const onHide = () => saveUnsent(sessionId, apiRef.current?.get() ?? "");
		window.addEventListener("pagehide", onHide);
		return () => window.removeEventListener("pagehide", onHide);
	}, [sessionId]);

	const pickCommand = (c: SlashCmd) => {
		if (commandAction(c) === "run") {
			apiRef.current?.set("");
			void controller.runCommand(c.name, "");
		} else {
			apiRef.current?.set(commandInput(c), true);
		}
	};

	const togglePlan = async () => {
		const next = !planOn;
		try {
			const r = await api<{ on: boolean; sessionId?: string }>("POST", `/sessions/${sessionId}/plan-mode`, { on: next });
			controller.patchState({ planMode: r.on });
			toast(r.on ? "规划模式已开启" : "规划模式已关闭");
			if (r.sessionId && r.sessionId !== sessionId) {
				const text = apiRef.current?.get() ?? controller.lastText;
				draftBook.stash(r.sessionId, text, controller.state.atts);
				draftBook.forget(sessionId);
				if (text.trim() !== "") saveUnsent(r.sessionId, text);
				clearUnsent(sessionId);
				controller.markDraftTransferred?.(r.sessionId);
				void useSessions.getState().refresh().catch(() => {});
				nav.replace(paths.chat(r.sessionId));
			}
		} catch (e) {
			toast(`切换失败：${errorMessage(e)}`, { kind: "error" });
		}
	};

	const automationOn = automationState?.mode === "active";
	const toggleAutomation = async () => {
		const next = !automationOn;
		try {
			await controller.setAutomationMode(next);
			toast(next ? "自动化定制模式已开启" : "自动化定制模式已关闭");
		} catch (e) {
			toast(`切换失败：${errorMessage(e)}`, { kind: "error" });
		}
	};

	const handleSend = async (raw: string) => {
		const trimmed = raw.trim();
		if (/^\/automate(?:\s|$)/i.test(trimmed)) {
			const goalText = trimmed.replace(/^\/automate\s*/i, "").trim();
			try {
				const targetId = await controller.setAutomationMode(true, goalText || undefined);
				toast("自动化定制模式已开启");
				if (targetId === sessionId) {
					if (goalText) {
						const sent = await controller.send(goalText, behavior);
						if (!sent) {
							apiRef.current?.set(raw, true);
							saveUnsent(sessionId, raw);
						}
					} else if (apiRef.current?.get() === raw) {
						apiRef.current?.set("");
						clearUnsent(sessionId);
					}
				}
			} catch (e) {
				toast(`开启自动化定制失败：${errorMessage(e)}`, { kind: "error" });
			}
			return;
		}
		await controller.send(raw, behavior);
	};

	useEffect(() => {
		const handoff = takeComposerAction(sessionId);
		if (!handoff) return;
		if (handoff.files?.length) controller.addFiles(handoff.files);
		if (handoff.action === "sketch") setSketch(true);
		else if (handoff.action === "plan") void togglePlan();
		else if (handoff.action === "automation") void controller.setAutomationMode(true);
		else if (handoff.action) setSheet(handoff.action);
	}, [controller, sessionId]);

	const cwd = session?.cwd ?? null;
	const pct = cstate ? resolveContextPercent(cstate) : null;
	const tone = contextTone(pct);
	const goal = cstate?.goal && cstate.goal.objective ? cstate.goal : null;
	const planOn = !!cstate?.planMode;
	const queued = queueChipText(cstate?.queue);
	const close = () => setSheet(null);

	const imageAtts = atts.filter((a) => a.isImage);
	const fileAtts = atts.filter((a) => !a.isImage);
	const openComposerPreview = (target: Attachment) => {
		const gallery: ViewerImage[] = [];
		let startIndex = -1;
		for (let i = 0; i < imageAtts.length; i++) {
			const item = imageAtts[i];
			const src = item.url || (item.image ? toDataUrl(item.image) : "");
			if (!src) continue;
			if (item.id === target.id) startIndex = gallery.length;
			gallery.push({ src, alt: item.name || `图片 #${i + 1}` });
		}
		if (startIndex >= 0 && gallery.length > 0) {
			openImage(gallery[startIndex], gallery, startIndex);
		}
	};

	const attachments =
		atts.length > 0 ? (
			<div className="flex flex-col gap-1.5 px-1 pt-0.5 pb-1">
				{imageAtts.length > 0 && (
					<div className="flex flex-wrap items-center gap-1.5">
						{imageAtts.map((a, idx) => {
							const src = a.url || (a.image ? toDataUrl(a.image) : "");
							const isErr = a.status === "err";
							const isUp = a.status === "up";
							return (
								<div
									key={a.id}
									className={`relative h-[52px] w-[52px] shrink-0 overflow-hidden rounded-m-md border bg-m-surface-2 ${
										isErr ? "border-m-danger ring-2 ring-m-danger" : "border-m-border"
									}`}
								>
									<button
										type="button"
										aria-label={isErr ? `重试上传 ${a.name}` : `预览图片 ${a.name}`}
										title={isErr ? (a.err ? `上传失败：${a.err}（点击重试）` : "上传失败（点击重试）") : a.name}
										onClick={() => (isErr ? controller.retryAtt(a.id) : openComposerPreview(a))}
										className="block h-full w-full overflow-hidden active:opacity-80"
									>
										{src ? (
											<img src={src} alt={a.name} className="block h-full w-full object-cover" />
										) : (
											<span className="flex h-full w-full items-center justify-center text-m-text-3">
												<ImageOff size={18} aria-hidden />
											</span>
										)}
									</button>
									<span className="pointer-events-none absolute top-0.5 left-0.5 flex h-4 min-w-4 items-center justify-center rounded-m-sm bg-m-bg-elev/90 px-1 font-m-mono text-[10px] font-semibold leading-none text-m-text ring-1 ring-m-border">
										{idx + 1}
									</span>
									{isUp && (
										<span
											role="status"
											aria-label="上传中"
											className="pointer-events-none absolute inset-0 flex items-center justify-center bg-m-scrim/60 text-m-text"
										>
											<Spinner size={15} />
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
										aria-label="移除附件"
										onClick={(e) => {
											e.stopPropagation();
											controller.removeAtt(a.id);
										}}
										className="absolute top-0.5 right-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-m-pill bg-m-bg-elev/90 text-m-text ring-1 ring-m-border active:scale-95"
									>
										<X size={11} strokeWidth={2.5} />
									</button>
								</div>
							);
						})}
					</div>
				)}
				{fileAtts.length > 0 && (
					<div className="flex flex-wrap items-center gap-1.5">
						{fileAtts.map((a) => (
							<div
								key={a.id}
								title={a.status === "err" && a.err ? a.err : a.name}
								className={`relative flex max-w-[220px] shrink-0 items-center gap-2 rounded-m-md border bg-m-surface-2 py-1.5 pr-7 pl-2 ${
									a.status === "err" ? "border-m-danger ring-1 ring-m-danger" : "border-m-border"
								}`}
							>
								<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-m-sm bg-m-surface text-m-text-2">
									<FileText size={16} />
								</span>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-m-xs text-m-text">{a.name}</span>
									{a.status === "up" && (
										<span className="flex items-center gap-1 text-[11px] whitespace-nowrap text-m-text-3">
											<Spinner size={11} />
											上传中
										</span>
									)}
									{a.status === "err" && (
										<button
											type="button"
											onClick={() => controller.retryAtt(a.id)}
											className="inline-flex items-center gap-1 text-left text-[11px] font-medium whitespace-nowrap text-m-danger active:opacity-75"
										>
											<RotateCcw size={10} aria-hidden />
											<span>上传失败，点击重试</span>
										</button>
									)}
								</span>
								<button
									type="button"
									aria-label="移除附件"
									onClick={() => controller.removeAtt(a.id)}
									className="absolute top-1 right-1 flex h-4.5 w-4.5 items-center justify-center rounded-m-pill bg-m-bg-elev/90 text-m-text-2 ring-1 ring-m-border active:scale-95"
								>
									<X size={11} strokeWidth={2.5} />
								</button>
							</div>
						))}
					</div>
				)}
			</div>
		) : undefined;

	const showEarBar = working || planOn || automationOn || Boolean(goal) || Boolean(queued);

	return (
		<div
			ref={composerRef}
			className="relative shrink-0 bg-gradient-to-t from-m-bg via-m-bg/95 to-transparent pt-1.5"
			style={{
				paddingBottom: kbOpen ? "8px" : "calc(var(--m-safe-bottom) + 8px)",
				paddingInlineStart: "calc(var(--m-safe-left) + 12px)",
				paddingInlineEnd: "calc(var(--m-safe-right) + 12px)",
			}}
		>
			{slashQuery !== null && sheet === null && <SlashPopup sessionId={sessionId} query={slashQuery} onPick={pickCommand} />}

			{forkFrom && (
				<div className="mb-2 flex items-start gap-3 rounded-m-lg bg-m-surface py-2 pr-1 pl-4">
					<GitBranch size={18} className="mt-2.5 shrink-0 text-m-accent" />
					<div className="min-w-0 flex-1 py-2">
						<div className="text-m-sm font-medium">从这条回复分支</div>
						<div className="text-m-xs break-words text-m-text-2">{forkFrom.preview}</div>
					</div>
					<IconButton icon={<X size={18} />} label="取消分支" onClick={() => controller.cancelFork()} />
				</div>
			)}

			{treeEdit && (
				<div className="mb-2 flex items-start gap-3 rounded-m-lg bg-m-surface py-2 pr-1 pl-4">
					<PenLine size={18} className="mt-2.5 shrink-0 text-m-accent" />
					<div className="min-w-0 flex-1 py-2">
						<div className="text-m-sm font-medium">将从这条消息重新开始</div>
						<div className="text-m-xs break-words text-m-text-2">下面的回答会保留为另一个版本，发送后从这里分出新的回答</div>
					</div>
					<IconButton icon={<X size={18} />} label="取消" onClick={() => void controller.cancelTreeEdit()} />
				</div>
			)}

			{showEarBar && (
				<div className="mb-1.5 flex items-center justify-between gap-2 px-2.5 text-m-xs">
					<div className="m-noscrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-x-2.5 overflow-x-auto py-0.5">
						{working && (
							<button
								type="button"
								aria-label={`发送方式：${BEHAVIOR_LABEL[behavior]}，点击切换`}
								title={BEHAVIOR_HINT[behavior]}
								onClick={() => setBehavior(behavior === "followUp" ? "steer" : "followUp")}
								className="inline-flex shrink-0 items-center gap-1.5 font-medium whitespace-nowrap text-m-text active:opacity-70"
							>
								<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-m-accent m-pulse" />
								<span>{BEHAVIOR_LABEL[behavior]} ⇄</span>
							</button>
						)}
						{planOn && (
							<button
								type="button"
								onClick={() => void togglePlan()}
								className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-m-text-2 active:text-m-text"
							>
								<Lightbulb size={12} className="shrink-0 text-m-accent" aria-hidden />
								<span>规划模式</span>
								<X size={11} className="shrink-0 text-m-text-3" aria-hidden />
							</button>
						)}
						{automationOn && (
							<button
								type="button"
								onClick={() => void toggleAutomation()}
								className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-m-text-2 active:text-m-text"
							>
								<CalendarClock size={12} className="shrink-0 text-m-accent" aria-hidden />
								<span>定制自动化</span>
								<X size={11} className="shrink-0 text-m-text-3" aria-hidden />
							</button>
						)}
						{goal && (
							<button
								type="button"
								onClick={() => setSheet("goal")}
								className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-m-text-2 active:text-m-text"
							>
								<Target size={12} className="shrink-0 text-m-text-3" aria-hidden />
								<span>目标</span>
							</button>
						)}
						{queued && (
							<span className="shrink-0 whitespace-nowrap text-m-accent">{queued}</span>
						)}
					</div>
					{working && canSend && (
						<button
							type="button"
							disabled={stopping}
							aria-label={stopping ? "正在停止" : "停止"}
							onClick={() => void controller.stop()}
							className="shrink-0 px-1 py-0.5 font-medium whitespace-nowrap text-m-danger active:opacity-70 disabled:opacity-60"
						>
							{stopping ? "正在停止" : "停止"}
						</button>
					)}
				</div>
			)}

			<ComposerCapsule
				apiRef={apiRef}
				initialText={controller.initialText}
				placeholder={forkFrom ? "输入分支后的第一条消息" : treeEdit ? "编辑这条消息后发送" : "今天想做点什么？"}
				hasExtra={atts.length > 0}
				top={attachments}
				onPlus={() => setSheet("plus")}
				onSend={(v) => void handleSend(v)}
				onStop={() => void controller.stop()}
				working={working}
				stopping={stopping}
				onInput={onInput}
				onSync={onSync}
				onUnmount={onUnmount}
				onCanSendChange={setCanSend}
				externalStopBar
				model={cstate?.model}
				thinking={cstate?.thinkingLevel}
				thinkingSupported={thinkingSupported}
				onModel={() => onOpenPicker?.()}
				onThinking={(el) => (onOpenThinking ? onOpenThinking(el ?? null) : onOpenPicker?.())}
				contextText={formatContextPercent(pct) ?? "未知"}
				contextPercent={pct}
				contextToneClass={TONE_TEXT[tone]}
				onContext={(ev?: ReactMouseEvent<HTMLElement>) => {
					setContextAnchor(
						ev?.currentTarget ??
							composerRef.current?.querySelector<HTMLElement>('button[aria-label^="上下文用量"]') ??
							null,
					);
					setSheet("context");
				}}
			/>
			<input ref={fileAny} type="file" multiple hidden onChange={(e) => pickFiles(e, controller)} />
			<input ref={fileCamera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pickFiles(e, controller, true)} />
			<input ref={fileGallery} type="file" accept="image/*" multiple hidden onChange={(e) => pickFiles(e, controller, true)} />

			{/* Native photo/gallery inputs share the existing attachment upload and error flow. */}
			<BottomSheet open={sheet === "plus"} onClose={close}>
				<div className="grid grid-cols-4 gap-2 px-4 pt-1">
					<ActionTile icon={<Camera size={22} strokeWidth={1.75} />} label="拍照" onClick={() => { close(); fileCamera.current?.click(); }} />
					<ActionTile icon={<ImagePlus size={22} strokeWidth={1.75} />} label="相册" onClick={() => { close(); fileGallery.current?.click(); }} />
					<ActionTile
						icon={<Paperclip size={22} strokeWidth={1.75} />}
						label="文件"
						onClick={() => {
							close();
							fileAny.current?.click();
						}}
					/>
					<ActionTile
						icon={<PenLine size={22} strokeWidth={1.75} />}
						label="草图"
						onClick={() => {
							close();
							setSketch(true);
						}}
					/>
				</div>
				<div className="pt-3 pb-3">
					<MenuRow
						icon={<Monitor size={21} strokeWidth={1.75} />}
						label="电脑端文件"
						hint="插入电脑工作区中的文件"
						onClick={() => setSheet("finder")}
					/>
					<MenuRow
						icon={<FolderOpen size={21} strokeWidth={1.75} />}
						label="切换工作目录"
						hint={cwd ? baseName(cwd) : "选择项目目录"}
						onClick={() => setSheet("workspace")}
					/>
					<MenuRow
						icon={<Target size={21} strokeWidth={1.75} />}
						label="目标"
						hint={goal ? `${goalLabel(goal)}：${goal.objective}` : "设定持续推进的任务目标"}
						onClick={() => setSheet("goal")}
					/>
					<div className="flex min-h-13 w-full items-center gap-3.5 py-1.5 pr-4 pl-5">
						<span className="flex w-6 shrink-0 items-center justify-center text-m-text-2">
							<Lightbulb size={21} strokeWidth={1.75} />
						</span>
						<span className="min-w-0 flex-1">
							<span className="block text-m-md text-m-text">规划模式</span>
							<span className="mt-0.5 block text-m-xs text-m-text-3">先出计划，确认后再动手</span>
						</span>
						<Switch label="规划模式" checked={planOn} onChange={() => void togglePlan()} />
					</div>
					<div className="flex min-h-13 w-full items-center gap-3.5 py-1.5 pr-4 pl-5">
						<span className="flex w-6 shrink-0 items-center justify-center text-m-text-2">
							<CalendarClock size={21} strokeWidth={1.75} />
						</span>
						<span className="min-w-0 flex-1">
							<span className="block text-m-md text-m-text">定制自动化</span>
							<span className="mt-0.5 block text-m-xs text-m-text-3">对话式设计定时或脚本触发自动化草案</span>
						</span>
						<Switch label="定制自动化" checked={automationOn} onChange={() => void toggleAutomation()} />
					</div>
				</div>
			</BottomSheet>

			<GoalSheet open={sheet === "goal"} onClose={close} sessionId={sessionId} goal={goal} onGoal={(g) => controller.patchState({ goal: g })} />
			<ContextSheet open={sheet === "context"} onClose={close} anchorEl={contextAnchor} cstate={cstate} compacting={compacting} controller={controller} />
			<RemoteFilePickerSheet
				open={sheet === "finder"}
				onClose={close}
				sessionId={sessionId}
				onSelectFile={(f) => apiRef.current?.insert(`[${f.name}](${f.path})`)}
			/>
			<WorkspacePickerSheet open={sheet === "workspace"} onClose={close} sessionId={sessionId} currentCwd={cwd} />
			<SketchPad
				open={sketch}
				onClose={() => setSketch(false)}
				onDone={(blob) => {
					setSketch(false);
					controller.addFiles([new File([blob], `sketch-${Date.now()}.png`, { type: "image/png" })], true);
				}}
			/>
		</div>
	);
}

function pickFiles(e: React.ChangeEvent<HTMLInputElement>, controller: { addFiles(f: File[], img: boolean): void }, image = false) {
	const files = Array.from(e.target.files ?? []);
	e.target.value = "";
	if (files.length) controller.addFiles(files, image);
}

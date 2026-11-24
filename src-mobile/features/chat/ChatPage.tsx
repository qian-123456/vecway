import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { nav, paths, type PageProps } from "../../core/nav";
import { api, errorMessage } from "../../core/api";
import { startViewingPresence } from "../../core/presence";
import { useSession, useSessions } from "../../core/stores/sessions";
import { Spinner, toast, type AnchorBox } from "../../ui";
import { hasBlockingOverlay } from "../../ui/overlay";
import { STATUS_LABEL } from "../../core/types";
import { MenuSheet } from "../sessions/MenuSheet";
import { NewSessionSheet } from "../sessions";
import type { DirEntry } from "../sessions/tree";
import "./chat.css";
import { ChatCtx, type ChatUi, type MessageTarget } from "./ChatContext";
import {
	createAutomationDraftAutoOpenTracker,
	type AutomationSessionState,
} from "./automation/automationStatus";
import { ChatController, isDeadStatus } from "./chatStore";
import { Composer } from "./components/Composer";
import { WorkspacePickerSheet } from "./components/WorkspacePickerSheet";
import { useRightDrawer } from "../panels/rightDrawerStore";
import { RightWorkspaceDrawer, useRightEdgeSwipe } from "../panels/RightWorkspaceDrawer";
import { ChatHeader } from "./components/ChatHeader";
import { PathSheet } from "./components/PathSheet";
import { abbreviateHomePath } from "../sessions/NewSessionSheet";
import { sessionModelSource } from "./components/useModelFacts";
import { resolveThinkingSupported, type ModelFacts, type ModelOpt } from "./lib/models";
import { takeFirstSend } from "./lib/drafts";
import { saveUnsent } from "./lib/unsent";
import { MessageActionsSheet } from "./components/MessageActions";
import { MessageList } from "./components/MessageList";
import { PlanSheet, type PlanSheetStatus } from "./components/PlanSheet";
import { ModelThinkingSheet } from "./components/ModelThinkingSheet";
import { ThinkingSourcePopover } from "./components/ThinkingLevelPopover";
import { PendingCards } from "./components/PendingCards";
import { StatCard } from "./components/StatLine";
import { TurnNotices } from "./components/TurnNotices";
import type { RequestStat } from "./lib/requestStats";
import { useChat, useChatUi as useUi } from "./ChatContext";

function Header({
	sessionId,
	titleButtonRef,
	onOpenMenu,
	onOpenPicker,
	onNew,
	onToolMenu,
	onOpenPath,
}: {
	sessionId: string;
	titleButtonRef?: Ref<HTMLButtonElement>;
	onOpenMenu: () => void;
	onOpenPicker: () => void;
	onNew: () => void;
	onToolMenu: () => void;
	onOpenPath?: () => void;
}) {
	const session = useSession(sessionId);
	const cstate = useChat((s) => s.cstate);
	const title = session?.customName || session?.title || session?.label || "对话";
	const subtitle = session?.cwd ? abbreviateHomePath(session.cwd) : null;
	return (
		<ChatHeader
			title={title}
			subtitle={subtitle}
			titleButtonRef={titleButtonRef}
			onTitleClick={onOpenPath}
			onMenu={onOpenMenu}
			onNew={onNew}
			onTools={onToolMenu}
			model={cstate?.model}
			thinking={cstate?.thinkingLevel}
			onModel={onOpenPicker}
		/>
	);
}

function ResumeBar({ sessionId }: { sessionId: string }) {
	const { controller } = useUi();
	const session = useSession(sessionId);
	const working = useChat((s) => s.working);
	const [busy, setBusy] = useState(false);
	if (!isDeadStatus(session?.status, working)) return null;
	return (
		<div className="flex shrink-0 justify-center px-4 py-2">
			<div className="inline-flex max-w-full items-center gap-2 rounded-m-pill bg-m-surface py-1 pl-4 pr-1 shadow-m-pop">
				<span className="min-w-0 break-words text-m-xs text-m-text-2">
					会话{STATUS_LABEL[session?.status ?? ""] ?? "已停止"}
				</span>
				<button
					type="button"
					disabled={busy}
					aria-busy={busy}
					onClick={async () => {
						if (busy) return;
						setBusy(true);
						try {
							await controller.resume();
						} catch (e) {
							// The controller reports API failures; this covers unexpected rejections.
							toast(`恢复失败：${errorMessage(e)}`, { kind: "error" });
						} finally {
							setBusy(false);
						}
					}}
					className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-m-pill bg-m-accent-soft px-4 text-m-sm font-medium text-m-accent-soft-text active:opacity-80 disabled:opacity-50"
				>
					{busy && <Spinner size={14} />}
					{busy ? "恢复中" : "恢复"}
				</button>
			</div>
		</div>
	);
}
function SessionPlanSheet({ sessionId, cwd }: { sessionId: string; cwd?: string }) {
	const { controller } = useUi();
	const open = useChat((s) => s.planSheetOpen);
	const mode = useChat((s) => s.planSheetMode);
	const working = useChat((s) => s.working);
	const approving = useChat((s) => s.planApproving);
	const planStatus = useChat((s) => s.cstate?.planStatus ?? null);
	const acceptedPlan = useChat((s) => s.acceptedPlan);
	const approved = planStatus?.approved;
	const isApprovedView = Boolean(approved?.content);
	const planText =
		approved?.content ??
		acceptedPlan?.content ??
		(planStatus?.enabled && planStatus.phase === "review" ? planStatus.content : null);
	const prevContent = isApprovedView
		? (approved?.prevContent ?? null)
		: (planStatus?.prevContent ?? null);
	const sheetStatus: PlanSheetStatus = approved?.status ?? (acceptedPlan ? "pending" : "review");

	if (!planText) return null;
	return (
		<PlanSheet
			open={open}
			mode={mode}
			onModeChange={(next) => controller.setPlanSheetMode(next)}
			onClose={() => controller.closePlanSheet()}
			text={planText}
			sessionId={sessionId}
			status={sheetStatus}
			title={approved?.title ?? planStatus?.title}
			version={approved?.version ?? planStatus?.version}
			prevContent={prevContent}
			planStatus={planStatus}
			canFresh={Boolean(planStatus?.planFile && cwd)}
			running={working}
			approving={approving}
			onApprove={(opts) => controller.approvePlan(opts)}
			onAnnotate={() => controller.stageAnnotation(planText, "请按以下要求修改计划：\n")}
		/>
	);
}


export function ChatPage({ route }: PageProps) {
	const id = route.params.id;
	const [controller, setController] = useState<ChatController | null>(null);
	const [target, setTarget] = useState<MessageTarget | null>(null);
	const [stat, setStat] = useState<RequestStat | null>(null);
	const [menuSheet, setMenuSheet] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [thinkingAnchor, setThinkingAnchor] = useState<HTMLElement | null>(null);
	const [newOpen, setNewOpen] = useState(false);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const session = useSession(id);

	const [pathOpen, setPathOpen] = useState(false);
	const titleBtnRef = useRef<HTMLButtonElement | null>(null);
	const creatingNew = useRef(false);
	const [targetAnchor, setTargetAnchor] = useState<{ el: HTMLElement | null; rect: AnchorBox | null } | null>(null);
	const [statAnchor, setStatAnchor] = useState<{ el: HTMLElement | null; rect: AnchorBox | null } | null>(null);
	const lastTriggerRef = useRef<{ el: HTMLElement | null; rect: AnchorBox | null; at: number } | null>(null);
	const modelSource = useMemo(() => sessionModelSource(id), [id]);
	const [modelCaps, setModelCaps] = useState<{ models: ModelOpt[]; current: ModelFacts["current"]; liveThinking: string[] } | null>(null);
	const [cstateModel, setCstateModel] = useState<string | null | undefined>(undefined);
	const [cstateThinking, setCstateThinking] = useState<string | null | undefined>(undefined);
	const [automationState, setAutomationState] = useState<AutomationSessionState | null>(null);
	const [automationHydrated, setAutomationHydrated] = useState(false);
	const [automationBaselineIds, setAutomationBaselineIds] = useState<readonly string[]>([]);
	const [automationSource, setAutomationSource] = useState<"snapshot" | "live">("snapshot");
	const autoOpenTrackerRef = useRef(createAutomationDraftAutoOpenTracker());
	const pendingMain = useRightDrawer((s) => s.pendingMain);
	const drawerOpen = useRightDrawer((s) => s.open);
	useEffect(() => {
		setModelCaps(null);
		let alive = true;
		void modelSource
			.load()
			.then((res) => {
				if (!alive) return;
				setModelCaps({ models: res.models ?? [], current: res.current ?? null, liveThinking: res.liveThinking ?? [] });
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [modelSource]);
	useEffect(() => {
		if (!controller || controller.id !== id) return;
		const first = takeFirstSend(id);
		if (first === null) return;
		let cancelled = false;
		void controller.send(first, "followUp").then((sent) => {
			if (cancelled || sent) return;
			const cur = controller.composer?.get() ?? controller.lastText;
			const trimmedFirst = first.trim();
			const restored = !cur.trim()
				? first
				: trimmedFirst && cur.includes(trimmedFirst)
					? cur
					: `${first}\n\n${cur}`;
			controller.composer?.set(restored);
			controller.lastText = restored;
			saveUnsent(id, restored);
		});
		return () => {
			cancelled = true;
		};
	}, [controller, id]);
	useEffect(() => {
		const c = new ChatController(id);
		c.start();
		const stopPresence = startViewingPresence(id);
		setController(c);
		setCstateModel(c.state.cstate?.model);
		setCstateThinking(c.state.cstate?.thinkingLevel);
		setAutomationState(c.state.automationState);
		setAutomationHydrated(c.state.automationHydrated);
		setAutomationBaselineIds(c.state.automationBaselineIds);
		setAutomationSource(c.state.automationSource);
		autoOpenTrackerRef.current.reset();
		const unsubState = c.store.subscribe((next, prev) => {
			if (next.cstate !== prev.cstate) {
				setCstateModel(next.cstate?.model);
				setCstateThinking(next.cstate?.thinkingLevel);
			}
			if (next.automationState !== prev.automationState) {
				setAutomationState(next.automationState);
			}
			if (next.automationHydrated !== prev.automationHydrated) {
				setAutomationHydrated(next.automationHydrated);
			}
			if (next.automationBaselineIds !== prev.automationBaselineIds) {
				setAutomationBaselineIds(next.automationBaselineIds);
			}
			if (next.automationSource !== prev.automationSource) {
				setAutomationSource(next.automationSource);
			}
		});
		return () => {
			unsubState();
			stopPresence();
			c.dispose();
			setController(null);
		};
	}, [id]);

	// Auto-open the right workspace drawer on the "automation" tab ONLY when a brand-new
	// pending draftId arrives AFTER initial composer-state hydration (never on reconnect or
	// repeated streaming frames for an already-seen draftId).
	useEffect(() => {
		const nextDraftId = autoOpenTrackerRef.current.next(
			automationHydrated,
			automationState,
			automationSource,
			automationBaselineIds,
		);
		if (nextDraftId) {
			useRightDrawer.getState().openAutomationDraft(id, nextDraftId);
		}
	}, [id, automationHydrated, automationState, automationSource, automationBaselineIds]);
	useEffect(() => {
		if (!controller || controller.id !== id || !pendingMain || pendingMain.sessionId !== id) return;
		const payload = useRightDrawer.getState().consumeMainAnnotation(id);
		if (!payload) return;
		controller.stageAnnotation(payload.quote, payload.comment);
	}, [controller, id, pendingMain]);

	const canEdgeSwipe =
		!drawerOpen &&
		!menuSheet &&
		!pickerOpen &&
		!thinkingOpen &&
		!newOpen &&
		!workspaceOpen &&
		!pathOpen &&
		!target &&
		!stat;
	useRightEdgeSwipe(() => {
		if (useRightDrawer.getState().open || hasBlockingOverlay()) return;
		useRightDrawer.getState().openDrawer(id);
	}, canEdgeSwipe);

	const createFreshChat = async () => {
		if (creatingNew.current) return;
		creatingNew.current = true;
		try {
			let cwd = session?.cwd;
			let mode = session?.mode;
			if (!cwd) {
				const res = await api<{ dirs?: DirEntry[] }>("GET", "/left/dirs");
				const dirs = res.dirs ?? [];
				const picked = dirs.find((d) => d.kind === "workspace") ?? dirs[0];
				cwd = picked?.path;
				if (!mode && picked?.kind !== "global") mode = picked?.mode;
			}
			if (!cwd) {
				setNewOpen(true);
				return;
			}
			const { id: nextId } = await useSessions.getState().createSession({ cwd, ...(mode ? { mode } : {}) });
			nav.push(paths.chat(nextId));
			toast("已在当前工作区新建会话", {
				action: { label: "更换目录/模型", onClick: () => setNewOpen(true) },
			});
		} catch (e) {
			toast(`新建失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			creatingNew.current = false;
		}
	};

	const recordTrigger = (node: EventTarget | null, x = 0, y = 0) => {
		if (!(node instanceof Element)) return;
		const btn = node.closest("button");
		if (btn instanceof HTMLElement) {
			lastTriggerRef.current = { el: btn, rect: null, at: Date.now() };
		} else if (x !== 0 || y !== 0) {
			lastTriggerRef.current = {
				el: null,
				rect: { left: x - 4, top: y - 4, right: x + 4, bottom: y + 4, width: 8, height: 8 },
				at: Date.now(),
			};
		} else if (node instanceof HTMLElement) {
			lastTriggerRef.current = { el: node, rect: null, at: Date.now() };
		}
	};

	const thinkingSupported = useMemo(
		() => resolveThinkingSupported(modelCaps, cstateModel, cstateThinking),
		[modelCaps, cstateModel, cstateThinking],
	);

	const ui = useMemo<ChatUi | null>(
		() =>
			controller
				? {
						controller,
						openActions: (t, anchorEl) => {
							if (anchorEl) {
								setTargetAnchor({ el: anchorEl, rect: null });
							} else {
								const recent = lastTriggerRef.current && Date.now() - lastTriggerRef.current.at < 2000 ? lastTriggerRef.current : null;
								setTargetAnchor(recent ? { el: recent.el, rect: recent.rect } : null);
							}
							setTarget(t);
						},
						openStat: (s, anchorEl) => {
							if (anchorEl) {
								setStatAnchor({ el: anchorEl, rect: null });
							} else {
								const recent = lastTriggerRef.current && Date.now() - lastTriggerRef.current.at < 2000 ? lastTriggerRef.current : null;
								setStatAnchor(recent ? { el: recent.el, rect: recent.rect } : null);
							}
							setStat(s);
						},
					}
				: null,
		[controller],
	);

	if (!ui || !controller || controller.id !== id) {
		return (
			<div className="flex flex-1 items-center justify-center text-m-text-3">
				<Spinner size={22} />
			</div>
		);
	}

	return (
		<ChatCtx.Provider value={ui}>
			<div
				className="flex min-h-0 flex-1 flex-col bg-m-bg"
				onPointerDownCapture={(e) => recordTrigger(e.target, e.clientX, e.clientY)}
				onClickCapture={(e) => recordTrigger(e.target, e.clientX, e.clientY)}
			>
				<Header
					sessionId={id}
					titleButtonRef={titleBtnRef}
					onOpenMenu={() => setMenuSheet(true)}
					onOpenPicker={() => setPickerOpen(true)}
					onNew={() => void createFreshChat()}
					onToolMenu={() => useRightDrawer.getState().toggleDrawer(id)}
					onOpenPath={() => setPathOpen(true)}
				/>
				<MessageList sessionId={id} onPickDirectory={() => setWorkspaceOpen(true)} />
				<div className="m-kb-dock relative z-(--z-composer) shrink-0">
					<PendingCards />
					<ResumeBar sessionId={id} />
					<TurnNotices sessionId={id} />
					<Composer
						sessionId={id}
						onOpenPicker={() => setPickerOpen(true)}
						onOpenThinking={(el) => {
							setThinkingAnchor(el);
							setThinkingOpen(true);
						}}
						thinkingSupported={thinkingSupported}
					/>
				</div>
			</div>
			<MessageActionsSheet
				target={target}
				onClose={() => setTarget(null)}
				controller={controller}
				anchorEl={targetAnchor?.el}
				anchorRect={targetAnchor?.rect}
			/>
			<StatCard
				stat={stat}
				onClose={() => setStat(null)}
				anchorEl={statAnchor?.el}
				anchorRect={statAnchor?.rect}
			/>
			<RightWorkspaceDrawer
				sessionId={id}
				automationState={automationState}
				onResolveAutomation={(draftId, resolution) => controller.resolveAutomationDraft(draftId, resolution)}
			/>
			<SessionPlanSheet sessionId={id} cwd={session?.cwd} />
			<MenuSheet open={menuSheet} onClose={() => setMenuSheet(false)} onNewSession={() => { if (session?.cwd) void createFreshChat(); else setNewOpen(true); }} />
			<NewSessionSheet open={newOpen} onClose={() => setNewOpen(false)} defaultCwd={session?.cwd} title={session?.cwd ? "更换目录/模型" : undefined} />
			<WorkspacePickerSheet open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} sessionId={id} currentCwd={session?.cwd} />
			<ModelThinkingSheet
				open={pickerOpen}
				onClose={() => setPickerOpen(false)}
				source={modelSource}
				currentLevel={controller.state.cstate?.thinkingLevel ?? null}
				onFacts={(f) => {
					controller.patchState({ ...(f.model ? { model: f.model } : {}), thinkingLevel: f.thinkingLevel });
					setModelCaps((prev) => (prev ? { ...prev, current: f.current ?? prev.current, liveThinking: f.liveThinking } : prev));
				}}
			/>
			<ThinkingSourcePopover
				open={thinkingOpen}
				onClose={() => setThinkingOpen(false)}
				anchorEl={thinkingAnchor}
				source={modelSource}
				currentLevel={controller.state.cstate?.thinkingLevel ?? null}
				onFacts={(f) => {
					controller.patchState({ thinkingLevel: f.thinkingLevel });
					setModelCaps((prev) => (prev ? { ...prev, current: f.current ?? prev.current, liveThinking: f.liveThinking } : prev));
				}}
			/>
			<PathSheet
				open={pathOpen}
				onClose={() => setPathOpen(false)}
				cwd={session?.cwd}
				sessionId={id}
				anchorEl={titleBtnRef.current}
				onSwitchProject={() => setWorkspaceOpen(true)}
			/>
		</ChatCtx.Provider>
	);
}

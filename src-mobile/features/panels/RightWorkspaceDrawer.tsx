import { ChevronDown, ChevronLeft, MoreHorizontal } from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactElement,
	type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../../core/api";
import { DRAFT_PREFIX } from "../../core/types";
import { AnchoredPopover, MenuRow, toast } from "../../ui";
import { useOverlay } from "../../ui/overlay";
import { FilesPanel } from "./FilesPage";
import { GitPanel } from "./GitPage";
import { ErrorState, Loading } from "./PanelState";
import { PlanPanel } from "./PlanPage";
import { ServicesPanel } from "./ServicesPage";
import { SidechatPanel } from "./SidechatPage";
import { TerminalPanel } from "./TerminalPage";
import { tabHeaderKey, useRightDrawer, type WorkspaceTab } from "./rightDrawerStore";
import { usePlanExecution } from "./usePlanExecution";

const BASE_TABS: ReadonlyArray<{ id: WorkspaceTab; label: string }> = [
	{ id: "sidechat", label: "辅助对话" },
	{ id: "git", label: "Git" },
	{ id: "files", label: "文件" },
	{ id: "terminal", label: "终端" },
	{ id: "services", label: "服务" },
];

const EDGE_ZONE_PX = 24;
const EDGE_SWIPE_PX = 44;
const EDGE_MAX_VERT_PX = 30;
const CLOSE_SWIPE_PX = 72;
const CLOSE_SWIPE_V = 0.4;

function hasHorizontalScrollableAncestor(target: EventTarget | null, boundary: HTMLElement | null): boolean {
	let node = target instanceof Element ? target : null;
	while (node && node !== boundary) {
		if (node.classList.contains("xterm") || node.getAttribute("role") === "tablist") return true;
		if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 2) return true;
		node = node.parentElement;
	}
	return false;
}

/**
 * Listen for a horizontal swipe-left starting within the rightmost 24px edge of the viewport
 * to open the right workspace drawer in a single gesture.
 */
export function useRightEdgeSwipe(onOpen: () => void, enabled = true): void {
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;

	useEffect(() => {
		if (!enabled) return;
		let track: { startX: number; startY: number; triggered: boolean } | null = null;

		const onTouchStart = (e: TouchEvent) => {
			if (e.touches.length !== 1) {
				track = null;
				return;
			}
			const touch = e.touches[0];
			const vw = window.innerWidth || document.documentElement.clientWidth || 0;
			if (!touch || vw <= 0 || touch.clientX < vw - EDGE_ZONE_PX) {
				track = null;
				return;
			}
			track = { startX: touch.clientX, startY: touch.clientY, triggered: false };
		};

		const onTouchMove = (e: TouchEvent) => {
			if (!track || track.triggered) return;
			if (e.touches.length !== 1) {
				track = null;
				return;
			}
			const touch = e.touches[0];
			if (!touch) return;
			const dx = touch.clientX - track.startX;
			const dy = Math.abs(touch.clientY - track.startY);
			if (dy >= EDGE_MAX_VERT_PX) {
				track = null;
				return;
			}
			if (dx < -EDGE_SWIPE_PX) {
				track.triggered = true;
				onOpenRef.current();
			}
		};

		const clear = () => {
			track = null;
		};

		document.addEventListener("touchstart", onTouchStart, { passive: true });
		document.addEventListener("touchmove", onTouchMove, { passive: true });
		document.addEventListener("touchend", clear, { passive: true });
		document.addEventListener("touchcancel", clear, { passive: true });
		return () => {
			document.removeEventListener("touchstart", onTouchStart);
			document.removeEventListener("touchmove", onTouchMove);
			document.removeEventListener("touchend", clear);
			document.removeEventListener("touchcancel", clear);
		};
	}, [enabled]);
}

export function RightWorkspaceDrawer({
	sessionId,
	resolveSessionId,
}: {
	sessionId?: string;
	resolveSessionId?: () => Promise<string>;
}): ReactElement | null {
	const open = useRightDrawer((s) => s.open);
	const drawerSessionId = useRightDrawer((s) => s.sessionId);
	const tabBySession = useRightDrawer((s) => s.tabBySession);
	const visitedBySession = useRightDrawer((s) => s.visitedBySession);
	const closeDrawer = useRightDrawer((s) => s.closeDrawer);
	const setTab = useRightDrawer((s) => s.setTab);

	const [resolving, setResolving] = useState(false);
	const [resolveError, setResolveError] = useState<string | null>(null);
	const resolveAttempted = useRef(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const swipeRef = useRef<{ x: number; y: number; t: number; dx: number; axis: "x" | "y" | null } | null>(null);

	// Effective session id prefers explicit prop, then store sessionId (ignoring empty pending sentinel).
	const effectiveId = sessionId || (drawerSessionId && drawerSessionId !== "__pending__" ? drawerSessionId : "") || "";

	const triggerResolve = useCallback(async () => {
		if (!resolveSessionId) return;
		setResolving(true);
		setResolveError(null);
		try {
			const resolved = await resolveSessionId();
			const wantedTab = useRightDrawer.getState().tabBySession[useRightDrawer.getState().sessionId ?? ""];
			useRightDrawer.getState().openDrawer(resolved, wantedTab);
		} catch (e) {
			const msg = errorMessage(e, "准备会话工作区失败");
			setResolveError(msg);
			toast(msg, { kind: "error" });
		} finally {
			setResolving(false);
		}
	}, [resolveSessionId]);

	// Lazily resolve draft session once when opened from Home before a draft exists.
	useEffect(() => {
		if (!open) {
			resolveAttempted.current = false;
			setResolveError(null);
			return;
		}
		if (effectiveId || !resolveSessionId || resolveAttempted.current) return;
		resolveAttempted.current = true;
		void triggerResolve();
	}, [open, effectiveId, resolveSessionId, triggerResolve]);

	useOverlay(open, closeDrawer);

	// Sync `inert` attribute when drawer is collapsed so hidden kept-alive panels are non-interactive.
	useEffect(() => {
		const el = panelRef.current;
		if (!el) return;
		if (open) {
			el.removeAttribute("inert");
			if (document.activeElement instanceof HTMLElement && !el.contains(document.activeElement)) {
				document.activeElement.blur();
			}
		} else {
			el.setAttribute("inert", "");
		}
	}, [open]);

	const plan = usePlanExecution(effectiveId || `${DRAFT_PREFIX}drawer`);
	const activeTab: WorkspaceTab = (effectiveId ? tabBySession[effectiveId] : undefined) ?? (drawerSessionId ? tabBySession[drawerSessionId] : undefined) ?? "git";
	const visitedTabs = useMemo(() => {
		if (!effectiveId) return [] as WorkspaceTab[];
		const list = visitedBySession[effectiveId] ?? [];
		if (open && !list.includes(activeTab)) return [...list, activeTab];
		return list;
	}, [effectiveId, visitedBySession, open, activeTab]);

	const tabs = useMemo(
		() => (plan.hasPlan || activeTab === "plan" ? [...BASE_TABS, { id: "plan" as const, label: "计划" }] : BASE_TABS),
		[plan.hasPlan, activeTab],
	);

	const tabHeader = useRightDrawer((s) => (effectiveId ? s.tabHeaders?.[tabHeaderKey(effectiveId, activeTab)] : undefined));
	const moreActions = tabHeader?.moreActions ?? [];
	const sidechatSwitcher = activeTab === "sidechat" ? tabHeader?.sidechatSwitcher : undefined;
	const activeTabMeta = tabs.find((t) => t.id === activeTab);
	const headerTitle = tabHeader?.title?.trim() || activeTabMeta?.label || "工作区";

	const [moreOpen, setMoreOpen] = useState(false);
	const moreBtnRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open || moreActions.length === 0) setMoreOpen(false);
	}, [open, activeTab, effectiveId, moreActions.length]);

	// Nothing to keep alive yet if drawer has never been opened for this session.
	if (!open && visitedTabs.length === 0) return null;

	const resetSwipe = () => {
		swipeRef.current = null;
		const el = panelRef.current;
		if (el) {
			el.style.transition = "";
			el.style.transform = "";
		}
	};

	const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
		resetSwipe();
		if (e.touches.length !== 1) return;
		if (hasHorizontalScrollableAncestor(e.target, panelRef.current)) return;
		const p = e.touches[0];
		if (!p) return;
		swipeRef.current = { x: p.clientX, y: p.clientY, t: e.timeStamp, dx: 0, axis: null };
	};

	const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
		const s = swipeRef.current;
		const p = e.touches[0];
		const el = panelRef.current;
		if (e.touches.length !== 1) {
			resetSwipe();
			return;
		}
		if (!s || !p || !el) return;
		const dx = p.clientX - s.x;
		const dy = p.clientY - s.y;
		if (s.axis === null) {
			if (Math.abs(dx) <= 10 && Math.abs(dy) <= 10) return;
			s.axis = Math.abs(dx) > Math.abs(dy) * 1.5 && dx > 10 ? "x" : "y";
			if (s.axis === "x") el.style.transition = "none";
		}
		if (s.axis !== "x") return;
		s.dx = Math.max(0, dx);
		el.style.transform = `translate3d(${s.dx}px,0,0)`;
	};

	const onTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
		const s = swipeRef.current;
		resetSwipe();
		if (!s || s.axis !== "x") return;
		const v = s.dx / Math.max(1, e.timeStamp - s.t);
		if (s.dx > CLOSE_SWIPE_PX || v > CLOSE_SWIPE_V) closeDrawer();
	};

	const renderPanel = (tab: WorkspaceTab) => {
		const isTabVisible = open && activeTab === tab;
		switch (tab) {
			case "sidechat":
				return <SidechatPanel sessionId={effectiveId} embedded />;
			case "git":
				return <GitPanel sessionId={effectiveId} embedded visible={isTabVisible} />;
			case "files":
				return <FilesPanel sessionId={effectiveId} embedded />;
			case "terminal":
				return <TerminalPanel sessionId={effectiveId} embedded visible={isTabVisible} />;
			case "services":
				return <ServicesPanel sessionId={effectiveId} embedded />;
			case "plan":
				return <PlanPanel sessionId={effectiveId} embedded />;
		}
	};

	return createPortal(
		<div
			aria-hidden={!open}
			className={`fixed inset-0 z-(--z-sheet) ${open ? "" : "pointer-events-none"}`}
		>
			<div
				aria-hidden="true"
				onClick={closeDrawer}
				className={`absolute inset-0 bg-m-scrim transition-opacity duration-300 ${
					open ? "opacity-100" : "pointer-events-none opacity-0"
				}`}
			/>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal={open ? "true" : undefined}
				aria-label="工作区抽屉"
				tabIndex={-1}
				onTouchStart={onTouchStart}
				onTouchMove={onTouchMove}
				onTouchEnd={onTouchEnd}
				onTouchCancel={resetSwipe}
				className={`absolute inset-y-0 right-0 flex w-full sm:w-[92vw] max-w-[460px] touch-pan-y flex-col border-l border-m-border bg-m-bg text-m-text shadow-m-pop outline-none transition-transform duration-300 ease-m-sheet ${
					open ? "translate-x-0" : "translate-x-full"
				}`}
				style={{ paddingTop: "var(--m-safe-top)" }}
			>
				<header className="shrink-0 px-3 pt-2 pb-2.5">
					<div className="grid grid-cols-[36px_minmax(0,1fr)_36px] items-center gap-2 pb-2">
						<button
							type="button"
							aria-label="返回对话"
							onClick={closeDrawer}
							className="m-liquid-orb inline-flex h-9 w-9 items-center justify-center rounded-full text-m-text"
						>
							<ChevronLeft size={20} strokeWidth={1.85} aria-hidden />
						</button>
						<span className="truncate text-center text-[15px] font-semibold text-m-text">
							{headerTitle}
						</span>
						{moreActions.length > 0 ? (
							<button
								ref={moreBtnRef}
								type="button"
								aria-label="更多操作"
								aria-expanded={moreOpen}
								aria-haspopup="menu"
								onClick={() => setMoreOpen((v) => !v)}
								className="m-liquid-orb inline-flex h-9 w-9 items-center justify-center rounded-full text-m-text"
							>
								<MoreHorizontal size={18} strokeWidth={1.85} aria-hidden />
							</button>
						) : (
							<span aria-hidden className="h-9 w-9" />
						)}
					</div>

					<nav
						role="tablist"
						aria-label="工作区面板"
						className="m-liquid-track m-noscrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-full p-1"
					>
						{tabs.map((tab) => {
							const selected = activeTab === tab.id;
							const showChevron = tab.id === "sidechat" && selected;
							return (
								<button
									key={tab.id}
									type="button"
									role="tab"
									aria-selected={selected}
									aria-expanded={showChevron && sidechatSwitcher ? sidechatSwitcher.open : undefined}
									disabled={!effectiveId}
									onClick={() => {
										if (!effectiveId) return;
										if (showChevron && sidechatSwitcher) {
											sidechatSwitcher.toggle();
										} else if (!selected) {
											setTab(effectiveId, tab.id);
										}
									}}
									className={`m-press inline-flex min-h-8 flex-1 shrink-0 items-center justify-center gap-0.5 rounded-full px-2.5 text-m-xs whitespace-nowrap transition-colors ${
										selected
											? "m-liquid-lens font-semibold text-m-text"
											: "font-medium text-m-text-2 active:text-m-text"
									}`}
								>
									<span>{tab.label}</span>
									{showChevron && (
										<ChevronDown
											size={11}
											strokeWidth={2.2}
											aria-hidden
											className={`shrink-0 transition-transform duration-(--m-dur-fast) ${
												sidechatSwitcher?.open ? "rotate-180" : ""
											}`}
										/>
									)}
								</button>
							);
						})}
					</nav>

					<AnchoredPopover
						open={moreOpen && moreActions.length > 0}
						onClose={() => setMoreOpen(false)}
						anchorEl={moreBtnRef.current}
						placement="bottom-end"
						minWidth={196}
						maxWidth={260}
						className="m-liquid-surface rounded-2xl! border-(--m-liquid-border)! bg-[color-mix(in_srgb,var(--m-bg-elev)_88%,transparent)]!"
					>
						<div className="py-1">
							{moreActions.map((action) => (
								<MenuRow
									key={action.id}
									icon={action.icon}
									label={action.label}
									danger={action.danger}
									onClick={() => {
										setMoreOpen(false);
										action.onSelect();
									}}
								/>
							))}
						</div>
					</AnchoredPopover>
				</header>

				{!effectiveId ? (
					<div className="flex min-h-0 flex-1 flex-col">
						{resolveError ? (
							<ErrorState message={resolveError} onRetry={() => void triggerResolve()} />
						) : (
							<Loading label={resolving ? "正在准备会话工作区..." : "加载中"} />
						)}
					</div>
				) : (
					<div key={effectiveId} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
						{visitedTabs.map((tab) => {
							const active = open && activeTab === tab;
							return (
								<div
									key={tab}
									role="tabpanel"
									aria-hidden={!active}
									className={active ? "flex h-full min-h-0 flex-1 flex-col" : "hidden"}
								>
									{renderPanel(tab)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}

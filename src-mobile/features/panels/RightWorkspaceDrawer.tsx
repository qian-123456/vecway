import { ChevronDown, ChevronLeft, MoreHorizontal } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactElement,
	type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../../core/api";
import { AnchoredPopover, MenuRow, TitleSwitcher, toast } from "../../ui";
import { readTranslateXY, rubberBand, VelocityTracker } from "../../ui/gesturePhysics";
import { prefersReducedMotion } from "../../ui/motion";
import { hasBlockingOverlay, useOverlay, usePresence } from "../../ui/overlay";
import { FilesPanel } from "./FilesPage";
import { GitPanel } from "./GitPage";
import { ErrorState, Loading } from "./PanelState";
import { ServicesPanel } from "./ServicesPage";
import { SidechatPanel } from "./SidechatPage";
import { TerminalPanel } from "./TerminalPage";
import { AutomationDraftsPanel } from "../chat/automation/AutomationDraftsPanel";
import type { AutomationSessionState } from "../chat/automation/automationStatus";
import { tabHeaderKey, useRightDrawer, type WorkspaceTab } from "./rightDrawerStore";
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

function eventElement(target: EventTarget | null): Element | null {
	if (target instanceof Element) return target;
	if (target instanceof Node) return target.parentElement;
	return null;
}

function hasHorizontalScrollableAncestor(target: EventTarget | null, boundary: HTMLElement | null): boolean {
	let node = eventElement(target);
	while (node && node !== boundary) {
		if (node.classList.contains("xterm") || node.getAttribute("role") === "tablist") return true;
		if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 2) {
			const ov = getComputedStyle(node).overflowX;
			if (ov === "auto" || ov === "scroll") return true;
		}
		node = node.parentElement;
	}
	return false;
}

function hasActiveTextSelection(): boolean {
	const sel = typeof window !== "undefined" ? window.getSelection() : null;
	return Boolean(sel && !sel.isCollapsed && sel.toString().length > 0);
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
			if (useRightDrawer.getState().open || hasBlockingOverlay()) {
				track = null;
				return;
			}
			if (e.touches.length !== 1) {
				track = null;
				return;
			}
			const targetEl = eventElement(e.target);
			if (
				targetEl?.closest('[role="dialog"], [role="alertdialog"], [data-sheet], [data-overlay]') ||
				hasHorizontalScrollableAncestor(targetEl, document.body)
			) {
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
			if (useRightDrawer.getState().open || hasBlockingOverlay()) {
				track = null;
				return;
			}
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
	automationState,
	onResolveAutomation,
}: {
	sessionId?: string;
	resolveSessionId?: () => Promise<string>;
	automationState?: AutomationSessionState | null;
	onResolveAutomation?: (draftId: string, resolution: "saved" | "dismissed") => Promise<void>;
}): ReactElement | null {
	const open = useRightDrawer((s) => s.open);
	const drawerSessionId = useRightDrawer((s) => s.sessionId);
	const tabBySession = useRightDrawer((s) => s.tabBySession);
	const visitedBySession = useRightDrawer((s) => s.visitedBySession);
	const closeDrawer = useRightDrawer((s) => s.closeDrawer);
	const setTab = useRightDrawer((s) => s.setTab);

	const [resolving, setResolving] = useState(false);
	const [resolveError, setResolveError] = useState<string | null>(null);
	const [shown, setShown] = useState(false);
	const resolveAttempted = useRef(false);
	const outerRef = useRef<HTMLDivElement>(null);
	const scrimRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const trackerRef = useRef(new VelocityTracker());
	const swipeRef = useRef<{ x: number; y: number; baseX: number; dx: number; axis: "x" | "y" | null } | null>(null);
	// Effective session id prefers explicit prop, then store sessionId (ignoring empty pending sentinel).
	const effectiveId = sessionId || (drawerSessionId && drawerSessionId !== "__pending__" ? drawerSessionId : "") || "";

	const triggerResolve = useCallback(async () => {
		if (!resolveSessionId) return;
		const reqSeq = useRightDrawer.getState().openSeq ?? 0;
		setResolving(true);
		setResolveError(null);
		try {
			const resolved = await resolveSessionId();
			const st = useRightDrawer.getState();
			if (!st.open || (st.openSeq ?? 0) !== reqSeq) {
				st.bindResolvedSession(resolved);
				return;
			}
			const wantedTab = st.tabBySession[st.sessionId ?? ""] ?? st.tabBySession[""];
			st.openDrawer(resolved, wantedTab);
		} catch (e) {
			const st = useRightDrawer.getState();
			if (!st.open || (st.openSeq ?? 0) !== reqSeq) return;
			const msg = errorMessage(e, "准备会话工作区失败");
			setResolveError(msg);
			toast(msg, { kind: "error" });
		} finally {
			setResolving(false);
		}
	}, [resolveSessionId]);

	useEffect(() => {
		return () => {
			useRightDrawer.getState().clearActiveContext();
		};
	}, []);

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

	const isTopModal = useOverlay(open, closeDrawer);

	const reducedMotion = prefersReducedMotion();
	const { mounted: reducedHold } = usePresence(open && reducedMotion, 150);
	const swipedCloseRef = useRef(false);
	const keepOnscreen = !open && reducedMotion && reducedHold && !swipedCloseRef.current;
	const activeOpen = open && shown;
	const restTransform = activeOpen || keepOnscreen ? "translate3d(0,0,0)" : "translate3d(100%,0,0)";

	useEffect(() => {
		if (!open) {
			setShown(false);
			return;
		}
		swipedCloseRef.current = false;
		if (reducedMotion) {
			setShown(true);
			return;
		}
		const raf = requestAnimationFrame(() => setShown(true));
		return () => cancelAnimationFrame(raf);
	}, [open, reducedMotion]);

	// Sync `inert` attribute when drawer is collapsed so hidden kept-alive panels are non-interactive.
	useEffect(() => {
		const el = panelRef.current;
		const outer = outerRef.current;
		if (outer) {
			if (open) outer.removeAttribute("inert");
			else outer.setAttribute("inert", "");
		}
		if (!el) return;
		if (open) {
			swipedCloseRef.current = false;
			delete el.dataset.dragging;
			el.style.transition = "";
			el.style.transform = restTransform;
			if (scrimRef.current) {
				scrimRef.current.style.transition = "";
				scrimRef.current.style.opacity = "";
			}
			el.removeAttribute("inert");
			if (document.activeElement instanceof HTMLElement && !el.contains(document.activeElement)) {
				document.activeElement.blur();
			}
		} else {
			delete el.dataset.dragging;
			el.style.transition = "";
			el.style.transform = restTransform;
			if (scrimRef.current) {
				scrimRef.current.style.transition = "";
				scrimRef.current.style.opacity = "";
			}
			el.setAttribute("inert", "");
		}
	}, [open, restTransform]);
	const hasAutomationTab = Boolean(
		(automationState?.drafts ?? []).some((d) => d.status === "pending" || d.status === "saved"),
	);
	const tabs = useMemo(
		() => (hasAutomationTab ? [...BASE_TABS, { id: "automation" as const, label: "自动化" }] : BASE_TABS),
		[hasAutomationTab],
	);
	const rawActiveTab: WorkspaceTab =
		(effectiveId ? tabBySession[effectiveId] : undefined) ??
		(drawerSessionId ? tabBySession[drawerSessionId] : undefined) ??
		"git";
	const activeTab: WorkspaceTab = rawActiveTab === "automation" && !hasAutomationTab ? "git" : rawActiveTab;
	const visitedTabs = useMemo(() => {
		if (!effectiveId) return [] as WorkspaceTab[];
		const list = (visitedBySession[effectiveId] ?? []).filter((t) => t !== "automation" || hasAutomationTab);
		if (open && !list.includes(activeTab)) return [...list, activeTab];
		return list;
	}, [effectiveId, visitedBySession, open, activeTab, hasAutomationTab]);
	const tabHeader = useRightDrawer((s) => (effectiveId ? s.tabHeaders?.[tabHeaderKey(effectiveId, activeTab)] : undefined));
	const moreActions = tabHeader?.moreActions ?? [];
	const titleSwitcher = tabHeader?.titleSwitcher;
	const rightAction = tabHeader?.rightAction;
	const sidechatSwitcher = activeTab === "sidechat" ? tabHeader?.sidechatSwitcher : undefined;
	const activeTabMeta = tabs.find((t) => t.id === activeTab);
	const headerTitle = tabHeader?.title?.trim() || activeTabMeta?.label || "工作区";
	const headerSubtitle = tabHeader?.subtitle?.trim() || "";

	const [moreOpen, setMoreOpen] = useState(false);
	const moreBtnRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open || moreActions.length === 0) setMoreOpen(false);
	}, [open, activeTab, effectiveId, moreActions.length]);

	const tabListRef = useRef<HTMLElement>(null);
	const tabBtnRefs = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement | null>>>({});
	const [capsule, setCapsule] = useState<{ x: number; width: number; ready: boolean; animate: boolean }>({
		x: 0,
		width: 0,
		ready: false,
		animate: false,
	});
	const capsuleReadyRef = useRef(false);
	const measureCapsule = useCallback(() => {
		const nav = tabListRef.current;
		const btn = tabBtnRefs.current[activeTab];
		if (!nav || !btn) {
			capsuleReadyRef.current = false;
			setCapsule((c) => (c.ready || c.animate ? { ...c, ready: false, animate: false } : c));
			return;
		}
		const navRect = nav.getBoundingClientRect();
		const btnRect = btn.getBoundingClientRect();
		const x =
			btnRect.width > 0
				? Math.round((btnRect.left - navRect.left - nav.clientLeft + nav.scrollLeft) * 10) / 10
				: btn.offsetLeft;
		const width = btnRect.width > 0 ? Math.round(btnRect.width * 10) / 10 : btn.offsetWidth;
		const ready = width > 0;
		const shouldAnimate = ready && capsuleReadyRef.current;
		if (ready) capsuleReadyRef.current = true;
		setCapsule((c) =>
			c.x === x && c.width === width && c.ready === ready && c.animate === shouldAnimate
				? c
				: { x, width, ready, animate: shouldAnimate },
		);
	}, [activeTab]);

	useLayoutEffect(() => {
		if (!open) {
			capsuleReadyRef.current = false;
			setCapsule((c) => (c.ready || c.animate ? { ...c, ready: false, animate: false } : c));
			return;
		}
		measureCapsule();
		const btn = tabBtnRefs.current[activeTab];
		if (btn && typeof btn.scrollIntoView === "function") {
			btn.scrollIntoView({ inline: "nearest", block: "nearest" });
		}
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measureCapsule);
		if (tabListRef.current) ro.observe(tabListRef.current);
		for (const node of Object.values(tabBtnRefs.current)) {
			if (node) ro.observe(node);
		}
		return () => ro.disconnect();
	}, [open, activeTab, tabs.length, effectiveId, measureCapsule]);

	useEffect(() => {
		if (!open || !capsule.ready || capsule.animate) return;
		const raf = requestAnimationFrame(() => {
			setCapsule((c) => (c.ready && !c.animate ? { ...c, animate: true } : c));
		});
		return () => cancelAnimationFrame(raf);
	}, [open, capsule.ready, capsule.animate]);

	// Nothing to keep alive yet if drawer has never been opened for this session.
	if (!open && visitedTabs.length === 0) return null;

	const resetSwipe = () => {
		swipeRef.current = null;
		trackerRef.current.reset();
		if (scrimRef.current) {
			scrimRef.current.style.transition = "";
			scrimRef.current.style.opacity = "";
		}
		const el = panelRef.current;
		if (el) {
			delete el.dataset.dragging;
			el.style.transition = "";
			el.style.transform = restTransform;
		}
	};

	const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
		swipeRef.current = null;
		const el = panelRef.current;
		const targetEl = eventElement(e.target);
		// Ignore React synthetic touch events bubbling from portaled overlays outside the drawer DOM.
		if (!el || !targetEl || !el.contains(targetEl)) return;
		if (e.touches.length !== 1) return;
		if (
			targetEl.closest(
				'input, textarea, select, [contenteditable]:not([contenteditable="false"]), button, a, .xterm, [data-no-drawer-swipe]',
			) ||
			hasActiveTextSelection() ||
			hasHorizontalScrollableAncestor(targetEl, el)
		) {
			return;
		}
		const p = e.touches[0];
		if (!p) return;
		const baseX = Math.max(0, readTranslateXY(el).x);
		trackerRef.current.reset();
		trackerRef.current.add(p.clientX, p.clientY, e.timeStamp);
		swipeRef.current = { x: p.clientX, y: p.clientY, baseX, dx: baseX, axis: null };
	};

	const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
		const s = swipeRef.current;
		if (!s) return;
		const p = e.touches[0];
		const el = panelRef.current;
		if (e.touches.length !== 1) {
			resetSwipe();
			return;
		}
		if (!p || !el) return;
		const dx = p.clientX - s.x;
		const dy = p.clientY - s.y;
		if (s.axis === null) {
			if (Math.abs(dx) <= 10 && Math.abs(dy) <= 10) return;
			s.axis = Math.abs(dx) > Math.abs(dy) * 1.5 && dx > 10 ? "x" : "y";
			if (s.axis === "x") {
				const liveBaseX = Math.max(0, readTranslateXY(el).x);
				s.baseX = liveBaseX;
				s.x = p.clientX;
				s.dx = 0;
				el.style.transform = `translate3d(${liveBaseX}px,0,0)`;
				el.dataset.dragging = "true";
				el.style.transition = "none";
				if (scrimRef.current) scrimRef.current.style.transition = "none";
			}
		}
		if (s.axis !== "x") return;
		const rawDx = s.baseX + (p.clientX - s.x);
		const width = Math.max(200, el.clientWidth || 320);
		s.dx = rawDx < 0 ? rubberBand(rawDx, width, 0.25) : rawDx;
		trackerRef.current.add(p.clientX, p.clientY, e.timeStamp);
		el.style.transform = `translate3d(${s.dx}px,0,0)`;
		if (scrimRef.current) {
			scrimRef.current.style.opacity = String(Math.max(0, Math.min(1, 1 - Math.max(0, s.dx) / width)));
		}
	};

	const onTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
		const s = swipeRef.current;
		swipeRef.current = null;
		const { vx } = trackerRef.current.velocity(e.timeStamp);
		trackerRef.current.reset();
		if (!s || s.axis !== "x") {
			resetSwipe();
			return;
		}
		const el = panelRef.current;
		if (el) delete el.dataset.dragging;
		if (scrimRef.current) {
			scrimRef.current.style.transition = "";
			scrimRef.current.style.opacity = "";
		}
		if (s.dx > CLOSE_SWIPE_PX || vx > CLOSE_SWIPE_V) {
			// Settle directly from the dragged offset to off-screen without snapping back to 0 first.
			swipedCloseRef.current = true;
			if (el) {
				el.style.transition = "";
				el.style.transform = "translate3d(100%,0,0)";
			}
			closeDrawer();
			return;
		}
		resetSwipe();
	};

	const renderPanel = (tab: WorkspaceTab) => {
		const isTabActive = open && activeTab === tab;
		switch (tab) {
			case "sidechat":
				return <SidechatPanel sessionId={effectiveId} embedded active={isTabActive} />;
			case "git":
				return <GitPanel sessionId={effectiveId} embedded active={isTabActive} visible={isTabActive} />;
			case "files":
				return <FilesPanel sessionId={effectiveId} embedded active={isTabActive} />;
			case "terminal":
				return <TerminalPanel sessionId={effectiveId} embedded active={isTabActive} visible={isTabActive} />;
			case "services":
				return <ServicesPanel sessionId={effectiveId} embedded active={isTabActive} />;
			case "automation":
				return (
					<AutomationDraftsPanel
						sessionId={effectiveId}
						automationState={automationState ?? null}
						onResolve={onResolveAutomation ?? (async () => {})}
					/>
				);
		}
	};
	return createPortal(
		<div
			ref={outerRef}
			aria-hidden={!open}
			className={`fixed inset-x-0 z-(--z-sheet) ${open ? "" : "pointer-events-none"}`}
			style={{
				top: "var(--m-vv-top, 0px)",
				height: "var(--m-vh, 100dvh)",
			}}
		>
			<div
				ref={scrimRef}
				aria-hidden="true"
				onClick={closeDrawer}
				className={`absolute inset-0 bg-m-scrim transition-opacity ease-m motion-reduce:duration-150 ${
					activeOpen ? "opacity-100 duration-(--m-dur-sheet)" : "pointer-events-none opacity-0 duration-(--m-dur-sheet-exit)"
				}`}
			/>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal={open && isTopModal ? "true" : undefined}
				aria-label="工作区抽屉"
				data-visible={activeOpen ? "true" : "false"}
				tabIndex={-1}
				onTouchStart={onTouchStart}
				onTouchMove={onTouchMove}
				onTouchEnd={onTouchEnd}
				onTouchCancel={resetSwipe}
				className={`m-drawer-surface absolute inset-y-0 right-0 flex w-full sm:w-[92vw] max-w-[460px] touch-pan-y flex-col border-l border-m-border bg-m-bg text-m-text shadow-m-pop outline-none transition-transform ease-m-sheet ${
					activeOpen ? "duration-(--m-dur-sheet)" : "duration-(--m-dur-sheet-exit)"
				}`}
				style={{
					transform: restTransform,
					paddingTop: "var(--m-safe-top)",
					paddingLeft: "max(0px, calc(var(--m-safe-left, 0px) - (100vw - 100%)))",
					paddingRight: "var(--m-safe-right, 0px)",
				}}
			>
				<header className="shrink-0 px-3 pt-1.5 pb-2.5">
					<div className="grid grid-cols-[minmax(44px,auto)_minmax(0,1fr)_minmax(44px,auto)] items-center gap-1 pb-1.5">
						<div className="flex items-center justify-start">
							<button
								type="button"
								aria-label="返回对话"
								onClick={closeDrawer}
								className="m-press inline-flex h-11 w-11 items-center justify-center rounded-[10px] text-m-text active:bg-m-surface-hover"
							>
								<ChevronLeft size={21} strokeWidth={1.85} aria-hidden />
							</button>
						</div>
						{titleSwitcher ? (
							<TitleSwitcher
								label={titleSwitcher.label}
								subtitle={titleSwitcher.subtitle}
								ariaLabel={titleSwitcher.ariaLabel}
								items={titleSwitcher.items}
								activeId={titleSwitcher.activeId}
								onSelect={titleSwitcher.onSelect}
								onStep={titleSwitcher.onStep}
								onRemove={titleSwitcher.onRemove}
								create={titleSwitcher.create}
								popoverTitle={titleSwitcher.popoverTitle}
								emptyText={titleSwitcher.emptyText}
								disabled={!open}
							/>
						) : sidechatSwitcher ? (
							<button
								type="button"
								aria-label={`切换辅助对话，当前：${headerTitle}`}
								aria-expanded={sidechatSwitcher.open}
								onClick={sidechatSwitcher.toggle}
								className="m-press mx-auto inline-flex min-h-11 max-w-full items-center justify-center gap-1 rounded-[10px] px-2 text-center text-[15px] font-semibold text-m-text active:bg-m-surface-hover"
							>
								<span className="min-w-0 truncate">{headerTitle}</span>
								<ChevronDown
									size={14}
									strokeWidth={2}
									aria-hidden
									className={`shrink-0 text-m-text-3 transition-transform duration-(--m-dur-fast) ${
										sidechatSwitcher.open ? "rotate-180" : ""
									}`}
								/>
							</button>
						) : (
							<div className="min-w-0 text-center">
								<div className="truncate text-[15px] font-semibold text-m-text">
									{headerTitle}
								</div>
								{headerSubtitle && (
									<div className="truncate text-[11px] text-m-text-3">{headerSubtitle}</div>
								)}
							</div>
						)}
						<div className="flex items-center justify-end gap-0.5">
							{rightAction}
							{moreActions.length > 0 ? (
								<button
									ref={moreBtnRef}
									type="button"
									aria-label="更多操作"
									aria-expanded={moreOpen}
									aria-haspopup="menu"
									onClick={() => setMoreOpen((v) => !v)}
									className="m-press inline-flex h-11 w-11 items-center justify-center rounded-[10px] text-m-text active:bg-m-surface-hover"
								>
									<MoreHorizontal size={20} strokeWidth={1.85} aria-hidden />
								</button>
							) : (
								!rightAction && <span aria-hidden className="h-11 w-11" />
							)}
						</div>
					</div>

					<nav
						ref={tabListRef}
						role="tablist"
						aria-label="工作区面板"
						className="m-liquid-track m-noscrollbar relative flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-full p-1"
					>
						<span
							aria-hidden="true"
							className={`m-liquid-lens pointer-events-none absolute top-1 bottom-1 left-0 rounded-full motion-reduce:transition-none! ${
								capsule.animate ? "" : "transition-none! "
							}${capsule.ready ? "opacity-100" : "opacity-0"}`}
							style={{
								width: `${capsule.width}px`,
								transform: `translateX(${capsule.x}px)`,
							}}
						/>
						{tabs.map((tab) => {
							const selected = activeTab === tab.id;
							return (
								<button
									key={tab.id}
									ref={(node) => {
										tabBtnRefs.current[tab.id] = node;
									}}
									type="button"
									role="tab"
									aria-selected={selected}
									disabled={!effectiveId}
									onClick={() => {
										if (!effectiveId || selected) return;
										setTab(effectiveId, tab.id);
									}}
									className={`m-press relative z-1 inline-flex min-h-8 flex-1 shrink-0 items-center justify-center rounded-full px-2.5 text-m-xs whitespace-nowrap transition-colors ${
										selected ? "font-semibold text-m-text" : "font-medium text-m-text-2 active:text-m-text"
									}`}
								>
									<span>{tab.label}</span>
								</button>
							);
						})}
					</nav>

					<AnchoredPopover
						open={open && moreOpen && moreActions.length > 0}
						onClose={() => setMoreOpen(false)}
						anchorEl={moreBtnRef.current}
						placement="bottom-end"
						ariaLabel="更多操作"
						minWidth={196}
						maxWidth={260}
						className="m-liquid-surface rounded-2xl!"
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
							const selected = activeTab === tab;
							return (
								<div
									key={tab}
									role="tabpanel"
									aria-hidden={!selected}
									className={selected ? "flex h-full min-h-0 flex-1 flex-col" : "hidden"}
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

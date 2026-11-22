import { Bell, Check, Clock, FolderPlus, Gauge, Lightbulb, ListFilter, Search, Settings, SquarePen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, TouchEvent as ReactTouchEvent } from "react";
import { createPortal } from "react-dom";
import { api, errorMessage } from "../../core/api";
import {
	NATIVE_CHANNEL_LABEL,
	getNativeBridge,
	isNativeApp,
	nativeHaptic,
	notifyNativeConnectionStatus,
	subscribeNativeConnectionStatus,
	type NativeEndpointStatus,
} from "../../core/nativeBridge";
import { nav, paths } from "../../core/nav";
import { events, reconnectEvents } from "../../core/sse";
import { IconButton, toast } from "../../ui";
import { useOverlay, usePresence } from "../../ui/overlay";
import { ConnectionSheet, type MobileInfo } from "../settings/sheets/ConnectionSheet";
import { useSessionActions } from "./ActionSheets";
import { ChronologicalView } from "./ChronologicalView";
import { inboxCount, type InboxData } from "./inbox";
import { ModeSwitch } from "./ModeSwitch";
import { startTodosSync, useTodos } from "./todos";
import { TreeView } from "./TreeView";
import { startTreeSync, useTree } from "./treeStore";
import type { TreeSession } from "./tree";

export type LeftNavViewMode = "project" | "time";

const ANIM_MS = 300;
/** Horizontal swipe distance (px) or flick velocity (px/ms) that closes the drawer. */
const SWIPE_CLOSE_PX = 90;
const SWIPE_CLOSE_V = 0.5;


/**
 * Navigation drawer (docs/MOBILE_DESIGN.md §4.3): slides in from the left; scrim, ✕, back or a
 * leftward swipe closes it. While open it keeps the session tree and the inbox badge fresh.
 */
export function MenuSheet({
	open,
	onClose,
	onNewSession,
}: {
	open: boolean;
	onClose: () => void;
	onNewSession?: () => void;
}) {
	const { mounted, visible } = usePresence(open, ANIM_MS);
	useOverlay(open, onClose);
	const native = isNativeApp();
	const [viewMode, setViewMode] = useState<LeftNavViewMode>("project");
	const [filterOpen, setFilterOpen] = useState(false);
	const [inbox, setInbox] = useState<InboxData | null>(null);
	const [nativeStatus, setNativeStatus] = useState<NativeEndpointStatus | null>(null);
	const [switchingLan, setSwitchingLan] = useState(false);
	const [connOpen, setConnOpen] = useState(false);
	const outerRef = useRef<HTMLDivElement>(null);
	const filterRef = useRef<HTMLDivElement>(null);
	const filterTriggerRef = useRef<HTMLButtonElement>(null);
	const inboxSeq = useRef(0);
	const [mobileInfo, setMobileInfo] = useState<MobileInfo>({});
	const todos = useTodos((s) => s.todos);
	const openSession = useCallback((s: TreeSession) => {
		onClose();
		nav.push(paths.chat(s.id));
	}, [onClose]);
	const { openActions, node } = useSessionActions(openSession);
	const closeFilter = useCallback(() => {
		setFilterOpen(false);
		const trigger = filterTriggerRef.current;
		if (trigger?.isConnected && !trigger.closest("[inert],[aria-hidden='true']")) {
			trigger.focus({ preventScroll: true });
		}
	}, []);
	useOverlay(filterOpen, closeFilter);
	const panelRef = useRef<HTMLDivElement>(null);
	const swipe = useRef<{ x: number; y: number; t: number; dx: number; axis: "x" | "y" | null } | null>(null);
	const resetSwipe = useCallback(() => {
		swipe.current = null;
		const el = panelRef.current;
		if (!el) return;
		// Removing only the inline overrides restores the CSS spring-back transition.
		el.style.removeProperty("transition");
		el.style.removeProperty("transform");
	}, []);

	useEffect(() => {
		if (!open) {
			setFilterOpen(false);
			resetSwipe();
			return;
		}
		const frame = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
		return () => cancelAnimationFrame(frame);
	}, [open, mounted, resetSwipe]);

	useEffect(() => {
		const el = outerRef.current;
		if (!el) return;
		if (open) el.removeAttribute("inert");
		else el.setAttribute("inert", "");
	}, [open, mounted]);

	useEffect(() => {
		if (!filterOpen) return;
		const dismiss = (e: PointerEvent) => {
			if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false);
		};
		document.addEventListener("pointerdown", dismiss);
		return () => document.removeEventListener("pointerdown", dismiss);
	}, [filterOpen]);
	useEffect(() => {
		if (!open) return;
		void useTree.getState().load();
		const offTree = startTreeSync();
		const offTodos = startTodosSync();
		let alive = true;
		const loadInbox = () => {
			const req = ++inboxSeq.current;
			return api<InboxData>("GET", "/left/inbox")
				.then((d) => { if (alive && req === inboxSeq.current) setInbox(d); })
				.catch(() => {});
		};
		void loadInbox();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const soon = () => { clearTimeout(timer); timer = setTimeout(() => void loadInbox(), 400); };
		const offs = [events.on("session", soon), events.on("hello", soon), events.on("resync", soon)];
		return () => {
			alive = false;
			++inboxSeq.current;
			clearTimeout(timer);
			offs.forEach((off) => off());
			offTree();
			offTodos();
		};
	}, [open]);

	useEffect(() => {
		if (!open || !native) return;
		const bridge = getNativeBridge();
		if (!bridge) return;
		let active = true;
		void bridge
			.getConnectionStatus()
			.then((status) => {
				if (active) setNativeStatus(status);
			})
			.catch(() => {});
		const unsub = subscribeNativeConnectionStatus((status) => {
			if (active) setNativeStatus(status);
		});
		return () => {
			active = false;
			unsub();
		};
	}, [open, native]);

	useEffect(() => {
		if (!connOpen || !native) return;
		let active = true;
		void api<{ mobile?: MobileInfo }>("GET", "/left/settings")
			.then((res) => {
				if (active && res?.mobile) setMobileInfo(res.mobile);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [connOpen, native]);

	const quickSwitchToLan = async () => {
		const bridge = getNativeBridge();
		if (!bridge?.switchChannel || switchingLan) return;
		setSwitchingLan(true);
		try {
			const next = await bridge.switchChannel("lan_tls");
			setNativeStatus(next);
			notifyNativeConnectionStatus(next);
			if (next.paired && !next.pinMismatch) reconnectEvents();
			nativeHaptic(next.activeChannel === "lan_tls" ? "success" : "warning");
			toast(
				next.activeChannel === "lan_tls"
					? "已切换至局域网直连"
					: "未检测到局域网直连，请确认与电脑在同一 Wi-Fi",
				{ kind: next.activeChannel === "lan_tls" ? "success" : "info" },
			);
		} catch (e) {
			nativeHaptic("error");
			toast(`切换失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setSwitchingLan(false);
		}
	};

	if (!mounted) return null;

	const go = (path: string) => {
		onClose();
		nav.push(path);
	};
	const badge = inboxCount(inbox, todos);

	const onTouchStart = (e: ReactTouchEvent) => {
		resetSwipe();
		if (!open || filterOpen) return;
		if (e.target instanceof Element && (e.target.closest("[data-session-row]") || e.target.closest("[role='menu']"))) return;
		const p = e.touches[0];
		if (!p || e.touches.length !== 1) return;
		swipe.current = { x: p.clientX, y: p.clientY, t: e.timeStamp, dx: 0, axis: null };
	};
	const onTouchMove = (e: ReactTouchEvent) => {
		const s = swipe.current;
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
			s.axis = Math.abs(dx) > Math.abs(dy) * 1.6 && dx < -10 ? "x" : "y";
			if (s.axis === "x") el.style.transition = "none";
		}
		if (s.axis !== "x") return;
		s.dx = Math.min(0, dx);
		el.style.transform = `translate3d(${s.dx}px,0,0)`;
	};
	const onTouchEnd = (e: ReactTouchEvent) => {
		const s = swipe.current;
		resetSwipe();
		if (!s || s.axis !== "x") return;
		const v = -s.dx / Math.max(1, e.timeStamp - s.t);
		if (-s.dx > SWIPE_CLOSE_PX || v > SWIPE_CLOSE_V) onClose();
	};
	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "Tab") return;
		const panel = panelRef.current;
		if (!panel) return;
		const targets = Array.from(panel.querySelectorAll<HTMLElement>(
			"button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
		)).filter((target) => target.tabIndex >= 0 && !target.closest("[inert],[hidden],[aria-hidden='true']"));
		const first = targets[0];
		const last = targets[targets.length - 1];
		if (!first || !last) {
			e.preventDefault();
			panel.focus({ preventScroll: true });
		} else if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
			e.preventDefault();
			last.focus({ preventScroll: true });
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus({ preventScroll: true });
		}
	};

	return createPortal(
		<div ref={outerRef} aria-hidden={!open || undefined} className={`fixed inset-0 z-(--z-sheet) ${open ? "" : "pointer-events-none"}`}>
			<div
				aria-hidden="true"
				onClick={onClose}
				className={`absolute inset-0 bg-m-scrim transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}
			/>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-label="导航"
				tabIndex={-1}
				onKeyDown={onKeyDown}
				onTouchStart={onTouchStart}
				onTouchMove={onTouchMove}
				onTouchEnd={onTouchEnd}
				onTouchCancel={resetSwipe}
				className={`m-sheet-surface absolute inset-y-0 left-0 flex w-[85vw] max-w-[340px] touch-pan-y flex-col border-r border-m-border/80 bg-m-drawer-bg text-m-text shadow-m-pop backdrop-blur-2xl backdrop-saturate-150 outline-none transition-transform duration-300 ease-m-sheet ${
					visible ? "translate-x-0" : "-translate-x-full"
				}`}
				style={{ paddingTop: "var(--m-safe-top)", paddingBottom: "calc(var(--m-safe-bottom) + 6px)", paddingLeft: "var(--m-safe-left)" }}
			>
				<header className="flex h-13 shrink-0 items-center justify-between gap-2 border-b border-m-border/60 px-3">
					<ModeSwitch />
					<div className="flex shrink-0 items-center gap-0.5">
						<IconButton variant="plain" size="sm" className="m-press" icon={<Search size={18} strokeWidth={1.75} />} label="搜索会话" onClick={() => go(paths.search())} />
						<IconButton
							variant="plain"
							size="sm"
							className="m-press"
							badge={badge > 0 ? badge : undefined}
							icon={<Bell size={18} strokeWidth={1.75} />}
							label={badge > 0 ? `收件箱，${badge} 项待处理` : "收件箱"}
							onClick={() => go(paths.inbox())}
						/>
						<IconButton variant="plain" size="sm" className="m-press" icon={<X size={18} strokeWidth={1.75} />} label="关闭导航" onClick={onClose} />
					</div>
				</header>

				<nav aria-label="主导航" className="shrink-0 space-y-1 border-b border-m-border/70 px-2.5 py-2">
					<button
						type="button"
						onClick={() => {
							onClose();
							onNewSession?.();
						}}
						className="m-press flex min-h-10 w-full items-center gap-2.5 rounded-m-md bg-m-surface/75 px-3 text-left text-m-sm font-medium text-m-text ring-1 ring-m-border/60 transition-colors duration-(--m-dur-fast) ease-m active:bg-m-surface-hover"
					>
						<SquarePen size={17} strokeWidth={1.75} className="shrink-0 text-m-accent" />
						<span className="whitespace-nowrap">发起新对话</span>
					</button>
					<button
						type="button"
						onClick={() => go(paths.schedules())}
						className="m-press flex min-h-10 w-full items-center gap-2.5 rounded-m-md px-3 text-left text-m-sm font-medium text-m-text transition-colors duration-(--m-dur-fast) ease-m active:bg-m-surface-hover"
					>
						<Clock size={17} strokeWidth={1.75} className="shrink-0 text-m-text-2" />
						<span className="whitespace-nowrap">自动化</span>
					</button>
					<button
						type="button"
						onClick={() => go(paths.ideas())}
						className="m-press flex min-h-10 w-full items-center gap-2.5 rounded-m-md px-3 text-left text-m-sm font-medium text-m-text transition-colors duration-(--m-dur-fast) ease-m active:bg-m-surface-hover"
					>
						<Lightbulb size={17} strokeWidth={1.75} className="shrink-0 text-m-text-2" />
						<span className="whitespace-nowrap">灵感收件箱</span>
					</button>
				</nav>

				<div ref={filterRef} className="relative flex shrink-0 items-center justify-between px-3.5 pt-2.5 pb-1.5">
					<span className="text-[11.5px] font-semibold tracking-[0.03em] text-m-text-3">
						{viewMode === "project" ? "项目" : "全部对话"}
					</span>
					<div className="flex shrink-0 items-center gap-1">
						<button
							ref={filterTriggerRef}
							type="button"
							aria-label="切换视图"
							aria-haspopup="menu"
							aria-expanded={filterOpen}
							onClick={() => setFilterOpen((v) => !v)}
							className={`m-press inline-flex h-8 min-w-8 items-center justify-center rounded-m-pill px-2 transition-colors duration-(--m-dur-fast) ease-m ${
								filterOpen
									? "bg-m-drawer-active text-m-accent"
									: "bg-m-surface/65 text-m-text-2 active:bg-m-surface-hover active:text-m-text"
							}`}
						>
							<ListFilter size={14} strokeWidth={1.75} />
						</button>
						{onNewSession && (
							<button
								type="button"
								aria-label="在项目目录新建会话"
								onClick={() => {
									setFilterOpen(false);
									onClose();
									onNewSession();
								}}
								className="m-press inline-flex h-8 w-8 items-center justify-center rounded-m-pill text-m-text-3 transition-colors duration-(--m-dur-fast) ease-m active:bg-m-surface-hover active:text-m-text"
							>
								<FolderPlus size={15} strokeWidth={1.75} />
							</button>
						)}
					</div>
					{filterOpen && (
						<div
							role="menu"
							aria-label="视图方式"
							className="m-popover-surface m-liquid-surface absolute right-3 top-full z-(--z-banner) mt-1.5 w-40 rounded-m-lg p-1.5"
						>
							<div className="px-2 py-1 text-[11px] font-semibold tracking-[0.03em] text-m-text-3">分组方式</div>
							<button
								type="button"
								role="menuitemradio"
								aria-checked={viewMode === "project"}
								onClick={() => {
									setViewMode("project");
									closeFilter();
								}}
								className={`m-press flex min-h-9 w-full items-center justify-between rounded-m-md px-2.5 text-left text-m-xs whitespace-nowrap transition-colors duration-(--m-dur-fast) ease-m ${
									viewMode === "project" ? "bg-m-drawer-active font-medium text-m-accent" : "text-m-text-2 active:bg-m-surface-hover"
								}`}
							>
								<span>按项目</span>
								{viewMode === "project" && <Check size={14} strokeWidth={1.85} className="shrink-0 text-m-accent" />}
							</button>
							<button
								type="button"
								role="menuitemradio"
								aria-checked={viewMode === "time"}
								onClick={() => {
									setViewMode("time");
									closeFilter();
								}}
								className={`m-press flex min-h-9 w-full items-center justify-between rounded-m-md px-2.5 text-left text-m-xs whitespace-nowrap transition-colors duration-(--m-dur-fast) ease-m ${
									viewMode === "time" ? "bg-m-drawer-active font-medium text-m-accent" : "text-m-text-2 active:bg-m-surface-hover"
								}`}
							>
								<span>按时间</span>
								{viewMode === "time" && <Check size={14} strokeWidth={1.85} className="shrink-0 text-m-accent" />}
							</button>
						</div>
					)}
				</div>

				<div className="m-noscrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
					{viewMode === "project" ? (
						<TreeView onMore={openActions} onOpen={openSession} />
					) : (
						<ChronologicalView onMore={openActions} onOpen={openSession} />
					)}
				</div>

				<footer aria-label="更多入口" className="flex shrink-0 items-center justify-between gap-2 border-t border-m-border/80 px-3 pt-2">
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						{native && nativeStatus?.paired ? (
							<>
								<button
									type="button"
									aria-label="切换连接方式"
									onClick={() => setConnOpen(true)}
									className="m-press flex min-h-10 min-w-0 items-center gap-2 rounded-m-pill px-2.5 text-left text-m-xs text-m-text-2 transition-colors duration-(--m-dur-fast) active:bg-m-surface-hover"
								>
									<span
										aria-hidden="true"
										className={`h-2 w-2 shrink-0 rounded-full ${nativeStatus.activeChannel ? "bg-m-success" : "bg-m-warn"}`}
									/>
									<span className="truncate text-m-text">
										{nativeStatus.activeChannel ? NATIVE_CHANNEL_LABEL[nativeStatus.activeChannel] : "未连接"}
									</span>
								</button>
								{nativeStatus.candidates.lanTls && nativeStatus.certSha256 && nativeStatus.activeChannel === "tunnel" && (
									<button
										type="button"
										disabled={switchingLan}
										onClick={() => void quickSwitchToLan()}
										className="m-press min-h-8 shrink-0 rounded-m-pill bg-m-accent-soft px-2.5 text-m-xs font-medium whitespace-nowrap text-m-accent-soft-text active:opacity-80 disabled:opacity-40"
									>
										{switchingLan ? "切换中" : "切回局域网"}
									</button>
								)}
							</>
						) : (
							<span className="px-2 text-m-xs font-medium text-m-text-3">Vecway</span>
						)}
					</div>
					<div className="flex shrink-0 items-center gap-0.5">
						<IconButton variant="plain" size="sm" className="m-press" icon={<Gauge size={18} strokeWidth={1.75} />} label="订阅与配额" onClick={() => go(paths.quota())} />
						<IconButton variant="plain" size="sm" className="m-press" icon={<Settings size={18} strokeWidth={1.75} />} label="设置" onClick={() => go(paths.settings())} />
					</div>
				</footer>
			</div>
			{node}
			{native && <ConnectionSheet open={connOpen} onClose={() => setConnOpen(false)} mobile={mobileInfo} />}
		</div>,
		document.body,
	);
}

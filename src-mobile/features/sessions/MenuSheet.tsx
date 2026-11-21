import { Bell, ChevronRight, Clock, Gauge, Lightbulb, Search, Settings, SquarePen, Wifi, X } from "lucide-react";
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
import { AppMark, IconButton, toast } from "../../ui";
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

const VIEW_OPTIONS = [
	{ value: "project", label: "按项目" },
	{ value: "time", label: "按时间" },
] as const;

function ViewModeSegment({
	value,
	onChange,
}: {
	value: LeftNavViewMode;
	onChange: (v: LeftNavViewMode) => void;
}) {
	return (
		<div
			role="radiogroup"
			aria-label="切换视图"
			className="ml-auto inline-flex shrink-0 items-center rounded-m-pill bg-m-surface p-0.5"
		>
			{VIEW_OPTIONS.map((opt) => {
				const active = value === opt.value;
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={active}
						onClick={() => onChange(opt.value)}
						className={`min-h-8 rounded-m-pill px-2.5 text-m-xs whitespace-nowrap transition-colors duration-(--m-dur-fast) ${
							active ? "bg-m-segment-on font-medium text-m-text shadow-xs" : "text-m-text-2"
						}`}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}
const ANIM_MS = 300;
/** Horizontal swipe distance (px) or flick velocity (px/ms) that closes the drawer. */
const SWIPE_CLOSE_PX = 90;
const SWIPE_CLOSE_V = 0.5;

const I = { size: 22, strokeWidth: 1.75 } as const;

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
	const [inbox, setInbox] = useState<InboxData | null>(null);
	const [nativeStatus, setNativeStatus] = useState<NativeEndpointStatus | null>(null);
	const [switchingLan, setSwitchingLan] = useState(false);
	const [connOpen, setConnOpen] = useState(false);
	const [mobileInfo, setMobileInfo] = useState<MobileInfo>({});
	const todos = useTodos((s) => s.todos);
	const openSession = useCallback((s: TreeSession) => {
		onClose();
		nav.push(paths.chat(s.id));
	}, [onClose]);
	const { openActions, node } = useSessionActions(openSession);
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
			resetSwipe();
			return;
		}
		if (!mounted) return;
		const frame = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
		return () => cancelAnimationFrame(frame);
	}, [open, mounted, resetSwipe]);

	useEffect(() => {
		if (!open) return;
		if (!useTree.getState().data) void useTree.getState().load();
		const offTree = startTreeSync();
		const offTodos = startTodosSync();
		let alive = true;
		const loadInbox = () => api<InboxData>("GET", "/left/inbox")
			.then((d) => { if (alive) setInbox(d); })
			.catch(() => {});
		void loadInbox();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const soon = () => { clearTimeout(timer); timer = setTimeout(() => void loadInbox(), 400); };
		const offs = [events.on("session", soon), events.on("hello", soon), events.on("resync", soon)];
		return () => {
			alive = false;
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
		if (e.target instanceof Element && e.target.closest("[data-session-row]")) return;
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
		<div className="fixed inset-0 z-(--z-sheet)">
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
				className={`absolute inset-y-0 left-0 flex w-[85vw] max-w-[340px] touch-pan-y flex-col border-r border-m-border bg-m-drawer-bg text-m-text shadow-m-pop outline-none transition-transform duration-300 ease-m-sheet ${
					visible ? "translate-x-0" : "-translate-x-full"
				}`}
				style={{ paddingTop: "var(--m-safe-top)", paddingBottom: "calc(var(--m-safe-bottom) + 6px)" }}
			>
				<header className="flex h-13 shrink-0 items-center gap-2 px-3">
					<AppMark size={24} />
					<span className="min-w-0 flex-1 text-m-md font-semibold tracking-[-0.01em] whitespace-nowrap">Vecway</span>
					<IconButton variant="plain" size="sm" icon={<Search {...I} />} label="搜索会话" onClick={() => go(paths.search())} />
					<div className="relative">
						<IconButton variant="plain" size="sm" icon={<Bell {...I} />} label={badge > 0 ? `收件箱，${badge} 项待处理` : "收件箱"} onClick={() => go(paths.inbox())} />
						{badge > 0 && <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 rounded-m-pill bg-m-danger px-1 text-[10px] leading-4 text-m-bg">{badge > 99 ? "99+" : badge}</span>}
					</div>
					<IconButton variant="plain" size="sm" icon={<X {...I} />} label="关闭导航" onClick={onClose} />
				</header>

				<div className="shrink-0">
					<div className="flex flex-wrap gap-1.5 px-3 pb-1">
						<button
							type="button"
							onClick={() => {
								onClose();
								onNewSession?.();
							}}
							className="flex min-h-11 w-full items-center gap-2.5 rounded-m-md border border-m-border bg-m-card px-3.5 text-left text-m-md font-medium text-m-text shadow-m-card transition-colors duration-(--m-dur-fast) active:bg-m-surface"
						>
							<SquarePen {...I} size={19} className="shrink-0 text-m-accent" />
							<span className="whitespace-nowrap">发起新对话</span>
						</button>
						<button
							type="button"
							onClick={() => go(paths.schedules())}
							className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-m-md border border-m-border/70 bg-m-bg-elev/70 px-2.5 text-left text-m-sm text-m-text-2 transition-colors duration-(--m-dur-fast) active:bg-m-surface-hover"
						>
							<Clock {...I} size={17} className="shrink-0 text-m-text-2" />
							<span className="whitespace-nowrap">自动化</span>
						</button>
						<button
							type="button"
							onClick={() => go(paths.ideas())}
							className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-m-md border border-m-border/70 bg-m-bg-elev/70 px-2.5 text-left text-m-sm text-m-text-2 transition-colors duration-(--m-dur-fast) active:bg-m-surface-hover"
						>
							<Lightbulb {...I} size={17} className="shrink-0 text-m-text-2" />
							<span className="whitespace-nowrap">灵感收件箱</span>
						</button>
					</div>

					<div className="flex items-center gap-2 px-3 py-1.5">
						<ModeSwitch />
						<ViewModeSegment value={viewMode} onChange={setViewMode} />
					</div>
				</div>
				<div className="m-noscrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">

					{viewMode === "project" ? (
						<TreeView onMore={openActions} onOpen={openSession} />
					) : (
						<ChronologicalView onMore={openActions} onOpen={openSession} />
					)}
				</div>

				{native && nativeStatus?.paired && (
					<div className="flex shrink-0 items-center gap-2 border-t border-m-border px-3 py-2">
						<button
							type="button"
							aria-label="切换连接方式"
							onClick={() => setConnOpen(true)}
							className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-m-md px-2 text-left text-m-xs text-m-text-2 active:bg-m-surface-hover"
						>
							<span
								aria-hidden="true"
								className={`h-2 w-2 shrink-0 rounded-full ${nativeStatus.activeChannel ? "bg-m-success" : "bg-m-warn"}`}
							/>
							<Wifi size={14} strokeWidth={1.85} className="shrink-0 text-m-text-3" aria-hidden />
							<span className="min-w-0 flex-1 truncate text-m-text">
								{nativeStatus.activeChannel ? NATIVE_CHANNEL_LABEL[nativeStatus.activeChannel] : "未连接"}
							</span>
							<ChevronRight size={14} className="shrink-0 text-m-text-3" aria-hidden />
						</button>
						{nativeStatus.candidates.lanTls && nativeStatus.certSha256 && nativeStatus.activeChannel === "tunnel" && (
							<button
								type="button"
								disabled={switchingLan}
								onClick={() => void quickSwitchToLan()}
								className="min-h-8 shrink-0 rounded-m-pill bg-m-accent-soft px-3 text-m-xs font-medium whitespace-nowrap text-m-accent-soft-text active:opacity-80 disabled:opacity-40"
							>
								{switchingLan ? "切换中" : "切回局域网"}
							</button>
						)}
					</div>
				)}

				<nav aria-label="更多入口" className="flex shrink-0 items-center border-t border-m-border px-3">
					<button type="button" onClick={() => go(paths.settings())} className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-m-md px-2 text-m-sm text-m-text-2 active:bg-m-surface-hover"><Settings size={18} strokeWidth={1.75} />设置</button>
					<span aria-hidden="true" className="h-5 w-px shrink-0 bg-m-border" />
					<button type="button" onClick={() => go(paths.quota())} className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-m-md px-2 text-m-sm text-m-text-2 active:bg-m-surface-hover"><Gauge size={18} strokeWidth={1.75} />订阅与配额</button>
				</nav>
			</div>
			{node}
			{native && <ConnectionSheet open={connOpen} onClose={() => setConnOpen(false)} mobile={mobileInfo} />}
		</div>,
		document.body,
	);
}

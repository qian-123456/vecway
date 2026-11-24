import React, {
	Suspense,
	lazy,
	useCallback,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { QuickCapture } from "./features/backlog/QuickCapture";
import { HandbackDialog } from "./features/sidechat/HandbackDialog";
import { SessionView } from "./features/chat/SessionView";
import { SessionSidebar } from "./features/sessions/SessionSidebar";
import { useSidebarStore } from "./features/sessions/sidebarStore";
import { PendingSessionView } from "./features/sessions/PendingSessionView";
import { usePendingSession } from "./features/sessions/pendingSession";
import { ForkDraftView } from "./features/sessions/ForkDraftView";
import { useForkDraft } from "./features/sessions/forkDraft";
import { StartPage } from "./features/home/StartPage";
import { useDoctorAutoScheduler } from "./features/heatmap/doctorStore";
import { startTodos } from "./features/todos/store";
import { startSettingsSync } from "./features/settings/store";

import { terminalSetCurrentSession } from "./lib/ipc";
import { RESUME_MISSING_CWD_MODAL, RESUME_MISSING_MODEL_MODAL } from "./lib/ensureLive";
import { captureDiagnosticError } from "./lib/diagnostics";
import { claimEscape } from "./lib/escapeClaim";
import { installNativeShortcuts } from "./lib/nativeShortcuts";
import { installShortcutDispatcher } from "./features/shortcuts/dispatcher";
import { effectiveCenterViewOf } from "./features/shortcuts/actions/navigation";
import { suspendScrollPills } from "./lib/scrollPills";
import { useSessions } from "./stores/sessions";
import { tNow, useT } from "./stores/language";
import { OmpInstallDialog } from "./features/omp-install/OmpInstallDialog";
import { useOmpInstall } from "./stores/ompInstall";
import { useOmpUpdate, watchOmpStaleness, watchOmpUpdateChecks } from "./stores/ompUpdate";
import { useAppUpdate, watchAppUpdateChecks } from "./stores/appUpdate";
import { useStartupImageGc } from "./features/settings/useStartupImageGc";
import {
	MAX_RIGHT_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_RIGHT_WIDTH,
	MIN_SIDEBAR_WIDTH,
	type CenterView,
	useUi,
} from "./stores/ui";
import { computeShellWidths } from "./lib/shellWidths";
import { CopyFeedbackPill } from "./components/CopyFeedbackPill";
import { Toaster } from "./components/Toaster";
import { BottomBar } from "./components/BottomBar";
import { CENTER_WITHOUT_RIGHT_PANEL, CenterHeader } from "./components/CenterHeader";
import { RightAside } from "./components/RightAside";

const DocView = lazy(() =>
	import("./features/editor/DocView").then((m) => ({ default: m.DocView })),
);
const InboxPage = lazy(() =>
	import("./features/inbox/InboxPage").then((m) => ({ default: m.InboxPage })),
);
const SchedulesPage = lazy(() =>
	import("./features/schedules/SchedulesPage").then((m) => ({ default: m.SchedulesPage })),
);
const SkillsPage = lazy(() =>
	import("./features/skills/SkillsPage").then((m) => ({ default: m.SkillsPage })),
);

// Lazy-load heavy overlay modals so cold-start bundle stays small
const DiagnoseDialog = lazy(() =>
	import("./features/diagnose/DiagnoseDialog").then((m) => ({ default: m.DiagnoseDialog })),
);
const ShareImageDialog = lazy(() =>
	import("./features/chat/share/ShareImageDialog").then((m) => ({ default: m.ShareImageDialog })),
);
const NewSessionDialog = lazy(() =>
	import("./features/git/NewSessionDialog").then((m) => ({ default: m.NewSessionDialog })),
);
const ResumeMissingCwdDialog = lazy(() =>
	import("./features/sessions/ResumeMissingCwdDialog").then((m) => ({
		default: m.ResumeMissingCwdDialog,
	})),
);
const ResumeMissingModelDialog = lazy(() =>
	import("./features/sessions/ResumeMissingModelDialog").then((m) => ({
		default: m.ResumeMissingModelDialog,
	})),
);
const SettingsOverlay = lazy(() =>
	import("./features/settings/SettingsOverlay").then((m) => ({ default: m.SettingsOverlay })),
);

/** Catches render errors so a broken view shows a readable message, not a black screen. */
class ErrorBoundary extends React.Component<
	{ children: ReactNode; label: string },
	{ error: string | null; stack: string | null }
> {
	state = { error: null as string | null, stack: null as string | null };
	static getDerivedStateFromError(e: unknown) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
	componentDidCatch(error: unknown, info: React.ErrorInfo) {
		captureDiagnosticError("app_boundary", error);
		this.setState({ stack: info.componentStack ?? null });
	}
	render() {
		if (this.state.error) {
			return (
				<div className="flex h-full flex-col items-center justify-center p-6 text-center text-xs text-neutral-400">
					<div className="font-medium text-red-400">
						{tNow("shell.renderError", { label: this.props.label })}
					</div>
					<div className="mt-1 font-mono text-[11px] text-neutral-500">
						{this.state.error}
					</div>
					<button
						type="button"
						onClick={() => this.setState({ error: null, stack: null })}
						className="mt-3 rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-neutral-300 hover:bg-neutral-700"
					>
						{tNow("common.retry")}
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

function MainCenterView({ activeView }: { activeView: CenterView }) {
	const selectedSessionId = useUi((s) => s.selectedSessionId);
	const hasPending = usePendingSession((s) => s.selectedId !== null && s.drafts[s.selectedId] !== undefined);
	const hasForkDraft = useForkDraft((s) => s.draft !== null);
	const docPath = useUi((s) => s.docPath);
	let view: ReactNode;
	switch (activeView) {
		case "session":
			view = selectedSessionId ? (
				<SessionView key={selectedSessionId} sessionId={selectedSessionId} />
			) : hasForkDraft ? (
				<ForkDraftView />
			) : hasPending ? (
				<PendingSessionView />
			) : (
				<StartPage />
			);
			break;
		case "doc":
			view = docPath ? <DocView path={docPath} /> : <StartPage />;
			break;
		case "inbox":
			view = <InboxPage />;
			break;
		case "schedules":
			view = <SchedulesPage />;
			break;
		case "skills":
			view = <SkillsPage />;
			break;
		default:
			view = <StartPage />;
	}
	return <Suspense fallback={null}>{view}</Suspense>;
}

/** Gate each lazy overlay on its open condition so chunks are fetched only when opened. */
function LazyOverlays() {
	const modalName = useUi((s) => s.modal?.name ?? null);
	const settingsOpen = useUi((s) => s.centerView === "settings");
	const [settingsEverOpened, setSettingsEverOpened] = useState(settingsOpen);
	useEffect(() => {
		if (settingsOpen) setSettingsEverOpened(true);
	}, [settingsOpen]);
	return (
		<>
			{modalName === "diagnose" && (
				<Suspense fallback={null}>
					<DiagnoseDialog />
				</Suspense>
			)}
			{modalName === "share-image" && (
				<Suspense fallback={null}>
					<ShareImageDialog />
				</Suspense>
			)}
			{modalName === "new-session" && (
				<Suspense fallback={null}>
					<NewSessionDialog />
				</Suspense>
			)}
			{modalName === RESUME_MISSING_CWD_MODAL && (
				<Suspense fallback={null}>
					<ResumeMissingCwdDialog />
				</Suspense>
			)}
			{modalName === RESUME_MISSING_MODEL_MODAL && (
				<Suspense fallback={null}>
					<ResumeMissingModelDialog />
				</Suspense>
			)}
			{(settingsOpen || settingsEverOpened) && (
				<Suspense fallback={null}>
					<SettingsOverlay open={settingsOpen} />
				</Suspense>
			)}
		</>
	);
}

export default function App() {
	const { t } = useT();
	useStartupImageGc();
	const rightOpen = useUi((s) => s.rightOpen);
	const rightWidth = useUi((s) => s.rightWidth);
	const rightMaximized = useUi((s) => s.rightMaximized);
	const toggleRight = useUi((s) => s.toggleRight);
	const setRightWidth = useUi((s) => s.setRightWidth);

	const sidebarOpen = useUi((s) => s.sidebarOpen);
	const toggleSidebar = useUi((s) => s.toggleSidebar);
	const sidebarWidth = useUi((s) => s.sidebarWidth);
	const setSidebarWidth = useUi((s) => s.setSidebarWidth);
	const setSidebarOpen = useUi((s) => s.setSidebarOpen);

	const [viewportWidth, setViewportWidth] = useState(() =>
		typeof window !== "undefined" ? window.innerWidth : 1440,
	);
	const centerView = useUi((s) => s.centerView);
	const previousCenterView = useUi((s) => s.previousCenterView);
	const selectedSessionId = useUi((s) => s.selectedSessionId);
	useDoctorAutoScheduler();

	// Track the underlying view so when settings overlay opens, the center view stays mounted
	const lastNonSettingsCenterView = useRef<CenterView>("home");
	if (centerView !== "settings") {
		lastNonSettingsCenterView.current = centerView;
	}
	const effectiveCenterView = effectiveCenterViewOf(
		centerView,
		previousCenterView,
		lastNonSettingsCenterView.current,
	);
	// Full-width views drop the right dock entirely; the persisted `rightOpen`
	// preference stays untouched so it is restored on the next normal view.
	const rightVisible = rightOpen && !CENTER_WITHOUT_RIGHT_PANEL.has(effectiveCenterView);
	const isRightMaximized = rightVisible && rightMaximized;
	const rightVisibleRef = useRef(rightVisible);
	rightVisibleRef.current = rightVisible;
	const { leftWidth: effectiveSidebarWidth, rightWidth: effectiveRightWidth } = computeShellWidths({
		viewportWidth,
		sidebarOpen,
		sidebarWidth,
		rightVisible,
		rightWidth,
	});
	const effectiveSidebarWidthRef = useRef(effectiveSidebarWidth);
	effectiveSidebarWidthRef.current = effectiveSidebarWidth;
	const effectiveRightWidthRef = useRef(effectiveRightWidth);
	effectiveRightWidthRef.current = effectiveRightWidth;

	useEffect(() => {
		let raf = 0;
		let settleTimer = 0;
		const onResize = () => {
			document.documentElement.classList.add("is-window-resizing");
			window.clearTimeout(settleTimer);
			settleTimer = window.setTimeout(() => {
				document.documentElement.classList.remove("is-window-resizing");
			}, 140);
			if (raf !== 0) return;
			raf = window.requestAnimationFrame(() => {
				raf = 0;
				setViewportWidth(window.innerWidth);
			});
		};
		window.addEventListener("resize", onResize, { passive: true });
		return () => {
			window.removeEventListener("resize", onResize);
			window.cancelAnimationFrame(raf);
			window.clearTimeout(settleTimer);
			document.documentElement.classList.remove("is-window-resizing");
		};
	}, []);

	// Resizable sidebars: pointer capture + rAF-throttled direct DOM width updates (zero per-frame
	// App rerenders), hysteresis collapse preview, Escape rollback, and persistence only on commit.
	const LEFT_COLLAPSE_PREVIEW_THRESHOLD = 152;
	const LEFT_COLLAPSE_THRESHOLD = 124;
	const LEFT_EXPAND_THRESHOLD = 148;
	const leftPaneRef = useRef<HTMLDivElement>(null);
	const leftHandleRef = useRef<HTMLDivElement>(null);
	const rightHandleRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{
		side: "left" | "right";
		pointerId: number;
		handleEl: HTMLDivElement;
		startClientX: number;
		moved: boolean;
		startWidth: number;
		startLeftPref: number;
		startRightPref: number;
		startOpen: boolean;
		currentWidth: number;
		currentOpen: boolean;
		previewCollapse: boolean;
	} | null>(null);
	const [draggingSide, setDraggingSide] = useState<"left" | "right" | null>(null);
	const isDragging = draggingSide !== null;

	const onLeftDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || drag.current) return;
		e.preventDefault();
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			/* synthetic test events may not support pointer capture */
		}
		const startWidth = effectiveSidebarWidthRef.current;
		const ui = useUi.getState();
		const startLeftPref = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, ui.sidebarWidth));
		const startRightPref = Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, ui.rightWidth));
		drag.current = {
			side: "left",
			pointerId: e.pointerId,
			handleEl: e.currentTarget,
			startClientX: e.clientX,
			moved: false,
			startWidth,
			startLeftPref,
			startRightPref,
			startOpen: ui.sidebarOpen,
			currentWidth: startLeftPref,
			currentOpen: ui.sidebarOpen,
			previewCollapse: false,
		};
		setDraggingSide("left");
	}, []);

	const onRightDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || drag.current) return;
		e.preventDefault();
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			/* synthetic test events may not support pointer capture */
		}
		const startWidth = effectiveRightWidthRef.current;
		const ui = useUi.getState();
		const startLeftPref = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, ui.sidebarWidth));
		const startRightPref = Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, ui.rightWidth));
		drag.current = {
			side: "right",
			pointerId: e.pointerId,
			handleEl: e.currentTarget,
			startClientX: e.clientX,
			moved: false,
			startWidth,
			startLeftPref,
			startRightPref,
			startOpen: ui.sidebarOpen,
			currentWidth: startRightPref,
			currentOpen: true,
			previewCollapse: false,
		};
		setDraggingSide("right");
	}, []);
	useEffect(() => {
		if (!draggingSide) return;
		let rafId: number | null = null;
		let latestClientX: number | null = null;
		const handleEl = drag.current?.handleEl ?? null;

		const applyLeftDom = (open: boolean, width: number, preview: boolean) => {
			const pane = leftPaneRef.current;
			if (!pane) return;
			if (!open) {
				pane.style.width = "0px";
				pane.style.opacity = "0";
				delete pane.dataset.collapsePreview;
				return;
			}
			pane.style.width = `${Math.round(width)}px`;
			pane.style.opacity = preview ? "0.48" : "";
			if (preview) pane.dataset.collapsePreview = "true";
			else delete pane.dataset.collapsePreview;
		};

		const applyRightDom = (width: number) => {
			const rightEl = rightHandleRef.current?.nextElementSibling as HTMLElement | null;
			if (rightEl) rightEl.style.width = `${Math.round(width)}px`;
		};

		const restoreCommittedDom = (d: NonNullable<typeof drag.current>) => {
			const ui = useUi.getState();
			const committed = computeShellWidths({
				viewportWidth: window.innerWidth,
				sidebarOpen: d.startOpen,
				sidebarWidth: ui.sidebarWidth,
				rightVisible: rightVisibleRef.current,
				rightWidth: ui.rightWidth,
			});
			applyLeftDom(d.startOpen, committed.leftWidth, false);
			if (rightVisibleRef.current) applyRightDom(committed.rightWidth);
			d.handleEl.setAttribute(
				"aria-valuenow",
				String(
					Math.round(
						d.side === "left"
							? d.startOpen
								? committed.leftWidth
								: 0
							: committed.rightWidth,
					),
				),
			);
		};

		const updateWidth = () => {
			rafId = null;
			const d = drag.current;
			if (!d || latestClientX === null) return;
			const ui = useUi.getState();
			const vw = window.innerWidth;
			const dx = latestClientX - d.startClientX;
			if (d.side === "left") {
				const raw = d.startLeftPref + dx;
				if (d.currentOpen) {
					if (raw < LEFT_COLLAPSE_THRESHOLD) {
						d.currentOpen = false;
						d.previewCollapse = false;
					} else {
						d.currentOpen = true;
						d.previewCollapse = raw < LEFT_COLLAPSE_PREVIEW_THRESHOLD;
						d.currentWidth = Math.min(
							MAX_SIDEBAR_WIDTH,
							Math.max(MIN_SIDEBAR_WIDTH, Math.round(raw)),
						);
					}
				} else if (raw >= LEFT_EXPAND_THRESHOLD) {
					d.currentOpen = true;
					d.previewCollapse = raw < LEFT_COLLAPSE_PREVIEW_THRESHOLD;
					d.currentWidth = Math.min(
						MAX_SIDEBAR_WIDTH,
						Math.max(MIN_SIDEBAR_WIDTH, Math.round(raw)),
					);
				}
				const widths = computeShellWidths({
					viewportWidth: vw,
					sidebarOpen: d.currentOpen,
					sidebarWidth: d.currentWidth,
					rightVisible: rightVisibleRef.current,
					rightWidth: ui.rightWidth,
				});
				applyLeftDom(d.currentOpen, widths.leftWidth, d.previewCollapse);
				if (rightVisibleRef.current) applyRightDom(widths.rightWidth);
				d.handleEl.setAttribute(
					"aria-valuenow",
					String(Math.round(d.currentOpen ? widths.leftWidth : 0)),
				);
			} else {
				const raw = d.startRightPref - dx;
				d.currentWidth = Math.min(
					MAX_RIGHT_WIDTH,
					Math.max(MIN_RIGHT_WIDTH, Math.round(raw)),
				);
				const widths = computeShellWidths({
					viewportWidth: vw,
					sidebarOpen: ui.sidebarOpen,
					sidebarWidth: ui.sidebarWidth,
					rightVisible: true,
					rightWidth: d.currentWidth,
				});
				applyRightDom(widths.rightWidth);
				if (ui.sidebarOpen) applyLeftDom(true, widths.leftWidth, false);
				d.handleEl.setAttribute("aria-valuenow", String(Math.round(widths.rightWidth)));
			}
		};

		const onMove = (e: PointerEvent) => {
			const d = drag.current;
			if (!d || e.pointerId !== d.pointerId) return;
			const dx = e.clientX - d.startClientX;
			if (!d.moved) {
				if (Math.abs(dx) < 1) return;
				d.moved = true;
			}
			latestClientX = e.clientX;
			if (rafId === null) rafId = requestAnimationFrame(updateWidth);
		};

		const releaseCapture = (d: NonNullable<typeof drag.current>) => {
			try {
				if (d.handleEl.hasPointerCapture(d.pointerId)) {
					d.handleEl.releasePointerCapture(d.pointerId);
				}
			} catch {
				/* handle may have unmounted */
			}
		};

		const commit = () => {
			const d = drag.current;
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
				if (d?.moved) updateWidth();
			}
			drag.current = null;
			if (d) {
				releaseCapture(d);
				if (d.side === "left" && leftPaneRef.current) {
					leftPaneRef.current.style.opacity = "";
					delete leftPaneRef.current.dataset.collapsePreview;
				}
				if (!d.moved) {
					restoreCommittedDom(d);
				} else {
					const ui = useUi.getState();
					const vw = window.innerWidth;
					setViewportWidth(vw);
					if (d.side === "left") {
						if (!d.currentOpen) {
							setSidebarOpen(false);
						} else {
							const committed = Math.min(
								MAX_SIDEBAR_WIDTH,
								Math.max(MIN_SIDEBAR_WIDTH, Math.round(d.currentWidth)),
							);
							const widths = computeShellWidths({
								viewportWidth: vw,
								sidebarOpen: true,
								sidebarWidth: committed,
								rightVisible: rightVisibleRef.current,
								rightWidth: ui.rightWidth,
							});
							applyLeftDom(true, widths.leftWidth, false);
							if (rightVisibleRef.current) applyRightDom(widths.rightWidth);
							setSidebarOpen(true);
							setSidebarWidth(committed);
						}
					} else {
						const committed = Math.min(
							MAX_RIGHT_WIDTH,
							Math.max(MIN_RIGHT_WIDTH, Math.round(d.currentWidth)),
						);
						const widths = computeShellWidths({
							viewportWidth: vw,
							sidebarOpen: ui.sidebarOpen,
							sidebarWidth: ui.sidebarWidth,
							rightVisible: true,
							rightWidth: committed,
						});
						applyRightDom(widths.rightWidth);
						if (ui.sidebarOpen) applyLeftDom(true, widths.leftWidth, false);
						setRightWidth(committed);
					}
				}
			}
			setDraggingSide(null);
		};

		const cancel = (ev?: KeyboardEvent) => {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			if (ev) {
				ev.preventDefault();
				ev.stopPropagation();
				claimEscape(ev);
			}
			const d = drag.current;
			drag.current = null;
			if (d) {
				releaseCapture(d);
				restoreCommittedDom(d);
			}
			setDraggingSide(null);
		};

		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") cancel(e);
		};
		const onPointerUp = (e: PointerEvent) => {
			if (!drag.current || e.pointerId !== drag.current.pointerId) return;
			commit();
		};
		const onPointerCancel = (e: PointerEvent) => {
			if (!drag.current || e.pointerId !== drag.current.pointerId) return;
			cancel();
		};
		const onLostPointerCapture = (e: PointerEvent) => {
			if (!drag.current || e.pointerId !== drag.current.pointerId) return;
			cancel();
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerCancel);
		window.addEventListener("blur", commit);
		window.addEventListener("keydown", onKey, true);
		handleEl?.addEventListener("lostpointercapture", onLostPointerCapture);
		return () => {
			if (rafId !== null) cancelAnimationFrame(rafId);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerCancel);
			window.removeEventListener("blur", commit);
			window.removeEventListener("keydown", onKey, true);
			handleEl?.removeEventListener("lostpointercapture", onLostPointerCapture);
			const active = drag.current;
			if (active) {
				drag.current = null;
				releaseCapture(active);
				restoreCommittedDom(active);
			}
		};
	}, [draggingSide, setSidebarWidth, setRightWidth, setSidebarOpen]);

	useEffect(() => {
		suspendScrollPills(draggingSide !== null);
		return () => suspendScrollPills(false);
	}, [draggingSide]);

	useEffect(() => installNativeShortcuts(), []);
	useEffect(() => installShortcutDispatcher(), []);

	useEffect(() => startSettingsSync(), []);
	// Initialize todos subscription; load versions and auto-check omp updates at the configured interval
	useEffect(() => {
		startTodos();
		void useOmpUpdate
			.getState()
			.checkOnStartup()
			.then(() => useOmpInstall.getState().checkOnStartup());
		void useAppUpdate.getState().checkOnStartup();
		const stopAppChecks = watchAppUpdateChecks();
		const stopChecks = watchOmpUpdateChecks();
		const stopStaleness = watchOmpStaleness();
		return () => {
			stopChecks();
			stopStaleness();
			stopAppChecks();
		};
	}, []);



	// Keep ~/.omp-workspace/current-session in sync with selected session
	const selectedSessionFile = useSessions(
		useCallback(
			(s) => (selectedSessionId ? (s.sessions[selectedSessionId]?.file ?? null) : null),
			[selectedSessionId],
		),
	);
	useEffect(() => {
		terminalSetCurrentSession(selectedSessionId ? selectedSessionFile : null).catch(() => {});
	}, [selectedSessionId, selectedSessionFile]);

	// Follow selection at shell lifetime, including while the sidebar is unmounted.
	const selectedMode = useSessions((s) =>
		selectedSessionId ? s.sessions[selectedSessionId]?.mode : undefined,
	);
	useEffect(() => {
		if (selectedMode && selectedMode !== useSidebarStore.getState().activeMode) {
			useSidebarStore.getState().setActiveMode(selectedMode);
		}
	}, [selectedSessionId, selectedMode]);

	// Startup restoration owns only the untouched launch page. Navigation away
	// and back during loading still counts as user intent and cancels restoration.
	const restoreCancelledRef = useRef(false);
	useEffect(() => {
		const stopUi = useUi.subscribe((state, prev) => {
			if (state.centerView !== prev.centerView || state.selectedSessionId !== prev.selectedSessionId) {
				restoreCancelledRef.current = true;
			}
		});
		const stopMode = useSidebarStore.subscribe((state, prev) => {
			if (state.activeMode !== prev.activeMode) restoreCancelledRef.current = true;
		});
		return () => { stopUi(); stopMode(); };
	}, []);

	// Restore last session once the session list finishes loading
	const hasLoaded = useSessions((s) => s.hasLoaded);
	const restoredRef = useRef(false);
	useEffect(() => {
		if (!hasLoaded || restoredRef.current) return;
		restoredRef.current = true;
		const ui = useUi.getState();
		if (restoreCancelledRef.current || ui.centerView !== "home" || ui.selectedSessionId ||
			usePendingSession.getState().selectedId || useForkDraft.getState().draft) return;
		const last = useUi.getState().lastSessionId;
		if (!last) return;
		const exists = useSessions.getState().sessions[last];
		// Modes are isolated: only restore a session that belongs to the active mode.
		if (exists && exists.mode === useSidebarStore.getState().activeMode) {
			ui.selectSession(last);
		} else {
			useUi.getState().leaveSession();
		}
	}, [hasLoaded]);

	return (
		<div id="app-shell" className="relative flex h-full w-full flex-col overflow-hidden bg-neutral-950 text-neutral-200">
			<div
				id="app-wallpaper-background"
				aria-hidden
				className="pointer-events-none fixed inset-0 z-0 bg-cover bg-center transition-[filter,opacity] duration-300 ease-[var(--ease-out)]"
				style={{ backgroundImage: "var(--app-wallpaper-url)" }}
			/>
			<div
				id="app-wallpaper-veil"
				aria-hidden
				className="pointer-events-none fixed inset-0 z-0 transition-[background-color,opacity] duration-300 ease-[var(--ease-out)]"
			/>
			{/* Body row: the sidebar spans the full height beside the center/right status bar. */}
			<div className="relative z-10 flex min-h-0 flex-1">
				{/* Invisible drag overlay prevents text selection and event loss across iframes/terminals */}
				{isDragging && (
					<div className="fixed inset-0 z-(--z-pill) cursor-col-resize select-none" />
				)}

				{/* Left column: topbar cell + session sidebar, strictly matches sidebarWidth */}
				{sidebarOpen && !isRightMaximized && (
					<>
						<div
							ref={leftPaneRef}
							style={{ width: effectiveSidebarWidth }}
							className="flex shrink-0 flex-col overflow-hidden vibrancy-chrome transition-[opacity] duration-150 ease-[var(--ease-out)]"
						>
							<aside className="min-h-0 flex-1">
								<SessionSidebar />
							</aside>
						</div>
						{/* Sidebar drag handle */}
						{/* biome-ignore lint/a11y/useSemanticElements: interactive resize separator */}
						<div
							ref={leftHandleRef}
							role="separator"
							aria-orientation="vertical"
							aria-label={t("shortcuts.dragLeftCol")}
							aria-valuemin={MIN_SIDEBAR_WIDTH}
							aria-valuemax={MAX_SIDEBAR_WIDTH}
							aria-valuenow={Math.round(effectiveSidebarWidth)}
							tabIndex={0}
							onPointerDown={onLeftDragStart}
							onKeyDown={(e) => {
								if (e.key === "ArrowLeft") {
									e.preventDefault();
									setSidebarWidth(effectiveSidebarWidth - 16);
								} else if (e.key === "ArrowRight") {
									e.preventDefault();
									setSidebarWidth(effectiveSidebarWidth + 16);
								}
							}}
							className="group/handle relative z-40 w-0 shrink-0 cursor-col-resize touch-none outline-none"
							title={t("shortcuts.dragLeftCol")}
						>
							<div className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2" />
							<div
								className={`pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-[width,background-color] duration-150 ease-[var(--ease-out)] ${draggingSide === "left" ? "w-[2px] bg-[var(--accent)]/65" : "w-[1px] bg-[var(--border-divider)] group-hover/handle:w-[2px] group-hover/handle:bg-[var(--accent)]/65 group-focus-visible/handle:w-[2px] group-focus-visible/handle:bg-[var(--accent)]/65"}`}
							/>
						</div>
					</>
				)}

				{/* Center and right columns share a bottom bar; the sidebar stays full-height. */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
						{/* Center column: topbar + main conversation view */}
						{!isRightMaximized && (
							<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
								<CenterHeader
									sidebarOpen={sidebarOpen}
									toggleSidebar={toggleSidebar}
									rightOpen={rightOpen}
									toggleRight={toggleRight}
								/>

								{/* Center main view */}
								<main className="min-h-0 min-w-0 flex-1 overflow-hidden">
									<ErrorBoundary label={t("shell.mainView")}>
										<MainCenterView activeView={effectiveCenterView} />
									</ErrorBoundary>
								</main>
							</div>
						)}

						{/* Right panel — shares the center column's bottom edge. */}
						{rightVisible && (
							<>
								{/* Right panel drag handle */}
								{!isRightMaximized && (
									// biome-ignore lint/a11y/useSemanticElements: interactive resize separator
									<div
										ref={rightHandleRef}
										role="separator"
										aria-orientation="vertical"
										aria-label={t("shortcuts.dragRightCol")}
										aria-valuemin={MIN_RIGHT_WIDTH}
										aria-valuemax={MAX_RIGHT_WIDTH}
										aria-valuenow={Math.round(effectiveRightWidth)}
										tabIndex={0}
										onPointerDown={onRightDragStart}
										onKeyDown={(e) => {
											if (e.key === "ArrowLeft") {
												e.preventDefault();
												setRightWidth(effectiveRightWidth + 16);
											} else if (e.key === "ArrowRight") {
												e.preventDefault();
												setRightWidth(effectiveRightWidth - 16);
											}
										}}
										className="group/handle relative z-40 w-0 shrink-0 cursor-col-resize touch-none outline-none"
										title={t("shortcuts.dragRightCol")}
									>
										<div className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2" />
										<div
											className={`pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-[width,background-color] duration-150 ease-[var(--ease-out)] ${draggingSide === "right" ? "w-[2px] bg-[var(--accent)]/65" : "w-[1px] bg-[var(--border-divider)] group-hover/handle:w-[2px] group-hover/handle:bg-[var(--accent)]/65 group-focus-visible/handle:w-[2px] group-focus-visible/handle:bg-[var(--accent)]/65"}`}
										/>
									</div>
								)}
								<RightAside width={effectiveRightWidth} maximized={isRightMaximized} />
							</>
						)}
					</div>
					<BottomBar />
				</div>
			</div>
			{/* Global notifications stack */}
			<Toaster />
			<CopyFeedbackPill />
			{/* Global modals — render nothing unless ui.modal matches. Lazy loaded in Suspense */}
			<QuickCapture />
			<HandbackDialog />
			<OmpInstallDialog />
			<LazyOverlays />
		</div>
	);
}

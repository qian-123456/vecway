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

import { terminalSetCurrentSession } from "./lib/ipc";
import { RESUME_MISSING_CWD_MODAL, RESUME_MISSING_MODEL_MODAL } from "./lib/ensureLive";
import { captureDiagnosticError } from "./lib/diagnostics";
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
	MIN_CENTER_WIDTH,
	MIN_RIGHT_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SIDEBAR_COLLAPSE_THRESHOLD,
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
			{settingsOpen && (
				<Suspense fallback={null}>
					<SettingsOverlay />
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
	useEffect(() => {
		const onResize = () => setViewportWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
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

	// Resizable sidebars: delta-drag (seam keeps its grab offset under the pointer), rAF-throttled
	// live updates, persistence only on drag end. Cursor/user-select live on the overlay div, so
	// they disappear with it — no global body styles to leak.
	const drag = useRef<{ side: "left" | "right"; grabOffsetX: number } | null>(null);
	const [draggingSide, setDraggingSide] = useState<"left" | "right" | null>(null);
	const isDragging = draggingSide !== null;

	const onLeftDragStart = useCallback((e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		drag.current = { side: "left", grabOffsetX: e.clientX - effectiveSidebarWidthRef.current };
		setDraggingSide("left");
	}, []);

	const onRightDragStart = useCallback((e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const seamX = window.innerWidth - effectiveRightWidthRef.current;
		drag.current = { side: "right", grabOffsetX: e.clientX - seamX };
		setDraggingSide("right");
	}, []);
	useEffect(() => {
		if (!draggingSide) return;
		let rafId: number | null = null;
		let latestClientX: number | null = null;

		const updateWidth = () => {
			rafId = null;
			const d = drag.current;
			if (!d || latestClientX === null) return;
			// Live update without persisting; the store setter (which writes localStorage) runs on end.
			if (d.side === "left") {
				const raw = latestClientX - d.grabOffsetX;
				if (raw < SIDEBAR_COLLAPSE_THRESHOLD) {
					useUi.setState({ sidebarOpen: false });
				} else {
					const rightReserved = rightVisibleRef.current ? effectiveRightWidthRef.current : 0;
					const maxLeft = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - rightReserved - MIN_CENTER_WIDTH);
					const w = Math.min(MAX_SIDEBAR_WIDTH, maxLeft, Math.max(MIN_SIDEBAR_WIDTH, raw));
					useUi.setState({ sidebarOpen: true, sidebarWidth: w });
				}
			} else {
				const s = useUi.getState();
				const leftReserved = s.sidebarOpen ? effectiveSidebarWidthRef.current : 0;
				const maxRight = Math.max(MIN_RIGHT_WIDTH, window.innerWidth - leftReserved - MIN_CENTER_WIDTH);
				const w = Math.min(MAX_RIGHT_WIDTH, maxRight, Math.max(MIN_RIGHT_WIDTH, window.innerWidth - latestClientX + d.grabOffsetX));
				useUi.setState({ rightWidth: w });
			}
		};

		const onMove = (e: MouseEvent) => {
			latestClientX = e.clientX;
			if (rafId === null) rafId = requestAnimationFrame(updateWidth);
		};

		const end = () => {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				updateWidth();
			}
			const d = drag.current;
			drag.current = null;
			if (d) {
				const s = useUi.getState();
				if (d.side === "left") {
					if (!s.sidebarOpen) {
						setSidebarOpen(false);
					} else {
						setSidebarOpen(true);
						setSidebarWidth(s.sidebarWidth);
					}
				} else {
					setRightWidth(s.rightWidth);
				}
			}
			setDraggingSide(null);
		};

		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") end();
		};

		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", end);
		window.addEventListener("blur", end);
		window.addEventListener("keydown", onKey);
		return () => {
			if (rafId !== null) cancelAnimationFrame(rafId);
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", end);
			window.removeEventListener("blur", end);
			window.removeEventListener("keydown", onKey);
		};
	}, [draggingSide, setSidebarWidth, setRightWidth, setSidebarOpen]);

	useEffect(() => {
		suspendScrollPills(draggingSide !== null);
		return () => suspendScrollPills(false);
	}, [draggingSide]);

	useEffect(() => installNativeShortcuts(), []);
	useEffect(() => installShortcutDispatcher(), []);

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
		<div id="app-shell" className="relative flex h-screen flex-col overflow-hidden bg-neutral-950 text-neutral-200">
			<div
				id="app-wallpaper-background"
				aria-hidden
				className="pointer-events-none fixed inset-0 z-0 bg-cover bg-center transition-all duration-300"
				style={{ backgroundImage: "var(--app-wallpaper-url)" }}
			/>
			<div
				id="app-wallpaper-veil"
				aria-hidden
				className="pointer-events-none fixed inset-0 z-0 transition-all duration-300"
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
							style={{ width: effectiveSidebarWidth }}
							className="flex shrink-0 flex-col overflow-hidden vibrancy-chrome"
						>
							<aside className="min-h-0 flex-1">
								<SessionSidebar />
							</aside>
						</div>
						{/* Sidebar drag handle */}
						<div
							onMouseDown={onLeftDragStart}
							className="group/handle relative z-40 w-0 shrink-0 cursor-col-resize"
							title={t("shortcuts.dragLeftCol")}
						>
							<div className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2" />
							<div
								className={`pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 transition-colors ${draggingSide === "left" ? "bg-[#0A84FF]/60" : "bg-[var(--border-divider)] group-hover/handle:bg-[#0A84FF]/60"}`}
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
									<div
										onMouseDown={onRightDragStart}
										className="group/handle relative z-40 w-0 shrink-0 cursor-col-resize"
										title={t("shortcuts.dragRightCol")}
									>
										<div className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2" />
										<div
											className={`pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 transition-colors ${draggingSide === "right" ? "bg-[#0A84FF]/60" : "bg-[var(--border-divider)] group-hover/handle:bg-[#0A84FF]/60"}`}
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

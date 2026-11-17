import clsx from "clsx";
import {
	Activity,
	Coins,
	Gauge,
	GitBranch,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChatUi } from "../features/chat/chatUi";
import { PerfPopover } from "../features/chat/PerfPopover";
import { SessionStatsPopover } from "../features/chat/SessionStatsPopover";
import { computeSessionStats, formatTokens } from "../features/chat/sessionStats";
import { usePendingSession } from "../features/sessions/pendingSession";
import type { GitBadge, PerfBreakdown } from "../lib/contracts";
import { getAppMemoryUsage, gitBadge, perfBreakdown, type ProcessMemoryInfo } from "../lib/ipc";
import { useZoom } from "../lib/zoom";
import { useDisplayPrefs } from "../stores/displayPrefs";
import { useT } from "../stores/language";
import { useLive } from "../stores/live";
import { useSessions } from "../stores/sessions";
import { useUi } from "../stores/ui";

export function BottomBar() {
	const { t } = useT();
	const selectedSessionId = useUi((s) => s.selectedSessionId);
	const bottomBarVisible = useDisplayPrefs((s) => s.bottomBar);

	const rightTab = useUi((s) => s.rightTab);
	const setRightTab = useUi((s) => s.setRightTab);
	const rightOpen = useUi((s) => s.rightOpen);
	const setRightOpen = useUi((s) => s.setRightOpen);

	const activeSession = useSessions((s) =>
		selectedSessionId ? s.sessions[selectedSessionId] : undefined,
	);
	const live = useLive((s) =>
		selectedSessionId ? s.sessions[selectedSessionId] : undefined,
	);
	const streaming = live?.streaming === true;

	const draftCwd = usePendingSession((s) =>
		!selectedSessionId && s.selectedId ? (s.drafts[s.selectedId]?.cwd ?? "") : "",
	);
	const [draftGit, setDraftGit] = useState<GitBadge | null>(null);
	useEffect(() => {
		if (selectedSessionId || !draftCwd) {
			setDraftGit(null);
			return;
		}
		let cancelled = false;
		gitBadge(draftCwd)
			.then((b) => {
				if (!cancelled) setDraftGit(b ?? null);
			})
			.catch(() => {
				if (!cancelled) setDraftGit(null);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedSessionId, draftCwd]);

	// Global keyboard shortcuts (Cmd/Ctrl +/-, Cmd/Ctrl 0) and persisted zoom remain active
	useZoom();

	const handleToggleGit = () => {
		if (rightTab === "git" && rightOpen) {
			setRightOpen(false);
		} else {
			setRightTab("git");
		}
	};

	const statsOpen = useChatUi((s) => s.statsOpen);
	const setStatsOpen = useChatUi((s) => s.setStatsOpen);
	const transcriptItems = live?.items ?? [];
	const stats = useMemo(
		() => computeSessionStats(transcriptItems, live),
		[transcriptItems, live],
	);

	const contextPct = useMemo(() => {
		const raw = live?.state?.contextUsage;
		if (!raw || typeof raw !== "object") return null;
		const rec = raw as Record<string, unknown>;
		if (typeof rec.percent === "number" && Number.isFinite(rec.percent)) {
			return Math.max(0, Math.round(rec.percent));
		}
		if (
			typeof rec.tokens === "number" &&
			typeof rec.contextWindow === "number" &&
			rec.contextWindow > 0
		) {
			return Math.max(0, Math.round((rec.tokens / rec.contextWindow) * 100));
		}
		return null;
	}, [live?.state?.contextUsage]);

	const [memoryInfo, setMemoryInfo] = useState<ProcessMemoryInfo | null>(null);
	const [perfData, setPerfData] = useState<PerfBreakdown | null>(null);
	const [perfOpen, setPerfOpen] = useState(false);
	const statsBtnRef = useRef<HTMLButtonElement>(null);
	const perfBtnRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		let cancelled = false;
		let timer: number | null = null;
		let inFlight = false;
		const intervalMs = perfOpen ? 4000 : 30000;

		const poll = async () => {
			if (cancelled || document.visibilityState === "hidden") return;
			if (inFlight) return;
			inFlight = true;

			try {
				const memPromise = getAppMemoryUsage();
				const perfPromise = perfOpen ? perfBreakdown() : null;
				const [mem, perf] = await Promise.all([memPromise, perfPromise]);
				if (!cancelled) {
					if (mem?.formatted) {
						setMemoryInfo((prev) =>
							prev && prev.formatted === mem.formatted && prev.processes === mem.processes
								? prev
								: mem,
						);
					}
					if (perf !== null) setPerfData(perf);
				}
			} catch {
				/* ignore */
			} finally {
				inFlight = false;
				if (!cancelled && (document.visibilityState as string) !== "hidden") {
					timer = window.setTimeout(() => {
						void poll();
					}, intervalMs);
				}
			}
		};

		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				if (timer !== null) {
					window.clearTimeout(timer);
					timer = null;
				}
				void poll();
			} else if (timer !== null) {
				window.clearTimeout(timer);
				timer = null;
			}
		};

		document.addEventListener("visibilitychange", onVisibilityChange);
		void poll();

		return () => {
			cancelled = true;
			if (timer !== null) window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [perfOpen]);

	const realMemoryStr = memoryInfo?.formatted ?? null;
	const memEstimate = useMemo(() => {
		const baseMb = 75;
		const itemMb = transcriptItems.length * 0.15;
		return `${Math.round(baseMb + itemMb)} MB`;
	}, [transcriptItems.length]);

	const gitInfo = selectedSessionId ? activeSession?.git : draftGit;
	const branch = gitInfo?.branch;
	const dirty = gitInfo?.dirty ?? 0;
	const showSessionTelemetry = Boolean(selectedSessionId) && (stats.hasData || streaming);

	return (
		<footer
			data-app-bottombar
			className={clsx(
				"relative h-6 shrink-0 items-center justify-between border-t border-[var(--border-divider)] bg-[var(--bg)] px-3.5 text-[11px] text-[var(--text-muted)] select-none tabular-nums",
				bottomBarVisible ? "flex" : "hidden",
			)}
		>
			{/* Left: DSH-style live session telemetry — only shown after a session starts */}
			<div className="flex min-w-0 items-center gap-2">
				{showSessionTelemetry ? (
					<button
						ref={statsBtnRef}
						type="button"
						onClick={() => setStatsOpen(!statsOpen)}
						title={t("bottomBar.statsTip")}
						className="group flex min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 py-0.5 -ml-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-active-fill)] hover:text-[var(--text)] cursor-pointer"
					>
						<Gauge
							size={11.5}
							className={clsx(
								"shrink-0 transition-colors",
								streaming
									? "text-indigo-400 animate-pulse"
									: "text-[var(--text-dim)] group-hover:text-indigo-400",
							)}
						/>
						{contextPct !== null && (
							<>
								<span className="whitespace-nowrap font-mono tabular-nums">
									{t("bottomBar.contextPercent", { pct: contextPct })}
								</span>
								<span className="text-[var(--text-dim)]">·</span>
							</>
						)}
						<span className="whitespace-nowrap font-mono tabular-nums">
							{t("bottomBar.roundsAndSteps", { rounds: stats.rounds, steps: stats.steps })}
						</span>
						{stats.tps != null && (
							<>
								<span className="text-[var(--text-dim)]">·</span>
								<span className="whitespace-nowrap font-mono tabular-nums">
									{stats.tps.toFixed(1)} tok/s
								</span>
							</>
						)}
						<span className="text-[var(--text-dim)]">·</span>
						<Coins
							size={11}
							className="shrink-0 text-[var(--text-dim)] transition-colors group-hover:text-amber-400"
						/>
						<span className="whitespace-nowrap font-mono tabular-nums">
							{stats.totalTokens == null ? "—" : formatTokens(stats.totalTokens)}
						</span>
						{stats.cacheHitRate != null && stats.cacheHitRate > 0 && (
							<>
								<span className="text-[var(--text-dim)]">·</span>
								<span className="whitespace-nowrap font-mono tabular-nums">
									{t("bottomBar.cacheHitRate", { rate: stats.cacheHitRate.toFixed(1) })}
								</span>
							</>
						)}
					</button>
				) : null}

				<SessionStatsPopover
					anchor={statsOpen ? statsBtnRef.current : null}
					stats={stats}
					open={statsOpen}
					onClose={() => setStatsOpen(false)}
					ignoreRefs={[statsBtnRef]}
				/>
			</div>

			{/* Right: Essential runtime footprint & Git branch */}
			<div className="flex shrink-0 items-center gap-2 text-[var(--text-muted)]">
				<button
					ref={perfBtnRef}
					type="button"
					onClick={() => setPerfOpen((v) => !v)}
					title={t("bottomBar.memoryTooltip", {
						processes: memoryInfo?.processes
							? t("bottomBar.processesCount", { count: memoryInfo.processes })
							: "",
					})}
					className={clsx(
						"flex items-center gap-1 whitespace-nowrap rounded-[6px] px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-active-fill)] hover:text-[var(--text)] cursor-pointer",
						perfOpen && "bg-[var(--bg-hover)] text-[var(--text)]",
					)}
				>
					<Activity size={11} className="shrink-0 text-emerald-500" />
					<span className="font-mono text-[10.5px] tabular-nums">
						{t("bottomBar.performance", { memory: realMemoryStr ?? memEstimate })}
					</span>
				</button>
				<PerfPopover
					anchor={perfOpen ? perfBtnRef.current : null}
					appMemory={realMemoryStr}
					processes={memoryInfo?.processes}
					breakdown={perfData}
					open={perfOpen}
					onClose={() => setPerfOpen(false)}
					ignoreRefs={[perfBtnRef]}
				/>

				{branch && (
					<>
						<span className="text-[var(--text-dim)]">·</span>
						<button
							type="button"
							onClick={handleToggleGit}
							aria-label={t("bottomBar.viewGitPanel")}
							title={t("bottomBar.viewGitPanel")}
							className={clsx(
								"flex items-center gap-1 whitespace-nowrap rounded-[6px] px-1.5 py-0.5 -mr-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-active-fill)] hover:text-[var(--text)] cursor-pointer",
								rightTab === "git" && rightOpen && "bg-[var(--bg-active-fill)] text-[var(--text)]",
							)}
						>
							<GitBranch
								size={11}
								className={clsx(
									"shrink-0 transition-colors",
									rightTab === "git" && rightOpen ? "text-indigo-400" : "text-[var(--text-dim)]",
								)}
							/>
							<span className="max-w-[140px] truncate font-mono text-[10.5px]">
								{branch}
							</span>
							{dirty > 0 && (
								<span className="font-mono text-[10px] tabular-nums text-amber-500">
									+{dirty}
								</span>
							)}
						</button>
					</>
				)}
			</div>
		</footer>
	);
}

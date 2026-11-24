import clsx from "clsx";
import {
	Activity,
	Coins,
	Gauge,
	GitBranch,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useChatUi } from "../features/chat/chatUi";
import { PerfPopover } from "../features/chat/PerfPopover";
import { SessionStatsPopover } from "../features/chat/SessionStatsPopover";
import { computeSessionStats, formatTokens } from "../features/chat/sessionStats";
import { usePendingSession } from "../features/sessions/pendingSession";
import type { GitBadge, PerfBreakdown } from "../lib/contracts";
import { formatMemoryBytes } from "../lib/format";
import { getAppMemoryUsage, gitBadge, perfBreakdown, type ProcessMemoryInfo } from "../lib/ipc";
import { useZoom } from "../lib/zoom";
import { useDisplayPrefs } from "../stores/displayPrefs";
import { useT } from "../stores/language";
import { useLive } from "../stores/live";
import { useSessions } from "../stores/sessions";
import { useUi } from "../stores/ui";
import { useBottomBarFit } from "./useBottomBarFit";

function BarPart({
	id, priority, collapsed, children,
}: {
	id: string;
	priority: number;
	collapsed: ReadonlySet<string>;
	children: ReactNode;
}) {
	const hidden = collapsed.has(id);
	return (
		<span
			data-bottom-bar-part={id}
			data-priority={priority}
			data-collapsed={hidden}
			aria-hidden={hidden || undefined}
			className={clsx(
				"inline-flex w-max shrink-0 items-center gap-1.5 whitespace-nowrap",
				hidden && "pointer-events-none absolute invisible",
			)}
		>
			{children}
		</span>
	);
}

export function BottomBar() {
	const { t } = useT();
	const selectedSessionId = useUi((s) => s.selectedSessionId);
	const bottomBarVisible = useDisplayPrefs((s) => s.bottomBar);
	const { ref: barRef, collapsed } = useBottomBarFit(bottomBarVisible);

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

	const [memoryInfo, setMemoryInfo] = useState<Pick<ProcessMemoryInfo, "formatted" | "processes"> | null>(null);
	const [perfData, setPerfData] = useState<PerfBreakdown | null>(null);
	const [perfOpen, setPerfOpen] = useState(false);
	const statsBtnRef = useRef<HTMLButtonElement>(null);
	const perfBtnRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (bottomBarVisible) return;
		setStatsOpen(false);
		setPerfOpen(false);
	}, [bottomBarVisible, setStatsOpen]);

	useEffect(() => {
		if (!bottomBarVisible) return;
		let cancelled = false;
		let timer: number | null = null;
		let inFlight = false;
		const intervalMs = perfOpen ? 4000 : 30000;

		const poll = async () => {
			if (cancelled || document.visibilityState === "hidden") return;
			if (inFlight) return;
			inFlight = true;

			try {
				if (perfOpen) {
					const perf = await perfBreakdown();
					if (!cancelled && perf) {
						setPerfData(perf);
						setMemoryInfo({ formatted: formatMemoryBytes(perf.app.bytes), processes: perf.app.processes });
					}
				} else {
					const mem = await getAppMemoryUsage();
					if (!cancelled && mem) {
						setMemoryInfo((prev) =>
							prev?.formatted === mem.formatted && prev.processes === mem.processes ? prev : mem,
						);
					}
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
	}, [bottomBarVisible, perfOpen]);

	const realMemoryStr = memoryInfo?.formatted ?? "—";

	const gitInfo = selectedSessionId ? activeSession?.git : draftGit;
	const branch = gitInfo?.branch;
	const dirty = gitInfo?.dirty ?? 0;
	const showSessionTelemetry = Boolean(selectedSessionId) && (stats.hasData || streaming);
	const telemetryLabel = [
		t("bottomBar.statsTip"),
		contextPct !== null ? t("bottomBar.contextPercent", { pct: contextPct }) : null,
		t("bottomBar.roundsAndSteps", { rounds: stats.rounds, steps: stats.steps }),
		stats.tps != null ? `${stats.tps.toFixed(1)} tok/s` : null,
		stats.totalTokens == null ? "—" : formatTokens(stats.totalTokens),
		stats.cacheHitRate != null && stats.cacheHitRate > 0
			? t("bottomBar.cacheHitRate", { rate: stats.cacheHitRate.toFixed(1) })
			: null,
	].filter((value) => value !== null).join(" · ");

	return (
		<footer
			ref={barRef}
			data-app-bottombar
			className={clsx(
				"relative z-10 h-6 min-w-0 shrink-0 items-center justify-between gap-2 overflow-hidden border-t border-[var(--border-divider)] bg-[var(--bg)] px-3.5 text-[11px] text-[var(--text-muted)] select-none tabular-nums",
				bottomBarVisible ? "flex" : "hidden",
			)}
		>
			{/* Left: DSH-style live session telemetry — only shown after a session starts */}
			<div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
				{showSessionTelemetry ? (
					<button
						ref={statsBtnRef}
						data-bottom-bar-stats
						type="button"
						onClick={() => setStatsOpen(!statsOpen)}
						title={telemetryLabel}
						aria-label={telemetryLabel}
						aria-expanded={statsOpen}
						className="group flex w-max shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 py-0.5 -ml-1.5 text-[var(--text-muted)] transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] hover:bg-[var(--bg-active-fill)] hover:text-[var(--text)] active:scale-[0.97] cursor-pointer"
					>
						<Gauge
							size={11.5}
							className={clsx(
								"shrink-0 transition-colors duration-150 ease-[var(--ease-out)]",
								streaming
									? "text-indigo-400 animate-pulse"
									: "text-[var(--text-dim)] group-hover:text-indigo-400",
							)}
						/>
						{contextPct !== null && (
							<BarPart id="context" priority={2} collapsed={collapsed}>
								<span className="whitespace-nowrap font-mono tabular-nums">
									{t("bottomBar.contextPercent", { pct: contextPct })}
								</span>
								<span className="text-[var(--text-dim)]">·</span>
							</BarPart>
						)}
						<BarPart id="rounds" priority={1} collapsed={collapsed}>
							<span className="font-mono tabular-nums">
								{t("bottomBar.roundsAndSteps", { rounds: stats.rounds, steps: stats.steps })}
							</span>
						</BarPart>
						{stats.tps != null && (
							<BarPart id="tps" priority={5} collapsed={collapsed}>
								<span className="text-[var(--text-dim)]">·</span>
								<span className="font-mono tabular-nums">{stats.tps.toFixed(1)} tok/s</span>
							</BarPart>
						)}
						<BarPart id="tokens" priority={4} collapsed={collapsed}>
							<span className="text-[var(--text-dim)]">·</span>
							<Coins
								size={11}
								className="shrink-0 text-[var(--text-dim)] transition-colors duration-150 ease-[var(--ease-out)] group-hover:text-amber-400"
							/>
							<span className="font-mono tabular-nums">
								{stats.totalTokens == null ? "—" : formatTokens(stats.totalTokens)}
							</span>
						</BarPart>
						{stats.cacheHitRate != null && stats.cacheHitRate > 0 && (
							<BarPart id="cache" priority={6} collapsed={collapsed}>
								<span className="text-[var(--text-dim)]">·</span>
								<span className="font-mono tabular-nums">
									{t("bottomBar.cacheHitRate", { rate: stats.cacheHitRate.toFixed(1) })}
								</span>
							</BarPart>
						)}
					</button>
				) : null}

				<SessionStatsPopover
					anchor={bottomBarVisible && showSessionTelemetry && statsOpen ? statsBtnRef.current : null}
					stats={stats}
					open={bottomBarVisible && showSessionTelemetry && statsOpen}
					onClose={() => setStatsOpen(false)}
					ignoreRefs={[statsBtnRef]}
				/>
			</div>

			{/* Right: Essential runtime footprint & Git branch */}
			<div data-bottom-bar-right className="flex min-w-0 shrink-0 items-center justify-end gap-2 text-[var(--text-muted)]">
				<button
					ref={perfBtnRef}
					type="button"
					onClick={() => setPerfOpen((v) => !v)}
					aria-label={t("bottomBar.performance", { memory: realMemoryStr })}
					aria-expanded={perfOpen}
					title={t("bottomBar.memoryTooltip", {
						processes: memoryInfo?.processes
							? t("bottomBar.processesCount", { count: memoryInfo.processes })
							: "",
					})}
					className={clsx(
						"flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] px-1.5 py-0.5 transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] hover:bg-[var(--bg-active-fill)] hover:text-[var(--text)] active:scale-[0.97] cursor-pointer",
						perfOpen && "bg-[var(--bg-hover)] text-[var(--text)]",
					)}
				>
					<Activity size={11} className="shrink-0 text-emerald-500" />
					<BarPart id="memory" priority={3} collapsed={collapsed}>
						<span className="font-mono text-[10.5px] tabular-nums">
							{t("bottomBar.performance", { memory: realMemoryStr })}
						</span>
					</BarPart>
				</button>
				{bottomBarVisible && perfOpen && <PerfPopover
					anchor={perfBtnRef.current}
					appMemory={realMemoryStr}
					processes={memoryInfo?.processes}
					breakdown={perfData}
					open
					onClose={() => setPerfOpen(false)}
					ignoreRefs={[perfBtnRef]}
				/>}

				{branch && (
					<>
						<span className="shrink-0 text-[var(--text-dim)]">·</span>
						<button
							type="button"
							onClick={handleToggleGit}
							aria-label={`${t("bottomBar.viewGitPanel")}: ${branch}${dirty > 0 ? ` +${dirty}` : ""}`}
							title={`${t("bottomBar.viewGitPanel")}: ${branch}${dirty > 0 ? ` +${dirty}` : ""}`}
							className={clsx(
								"flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] px-1.5 py-0.5 -mr-1.5 text-[var(--text-muted)] transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] hover:bg-[var(--bg-active-fill)] hover:text-[var(--text)] active:scale-[0.97] cursor-pointer",
								rightTab === "git" && rightOpen && "bg-[var(--bg-active-fill)] text-[var(--text)]",
							)}
						>
							<GitBranch
								size={11}
								className={clsx(
									"shrink-0 transition-colors duration-150 ease-[var(--ease-out)]",
									rightTab === "git" && rightOpen ? "text-indigo-400" : "text-[var(--text-dim)]",
								)}
							/>
							<BarPart id="branch" priority={0} collapsed={collapsed}>
								<span className="min-w-0 max-w-[140px] truncate font-mono text-[10.5px]">
									{branch}
								</span>
								{dirty > 0 && (
									<span className="shrink-0 font-mono text-[10px] tabular-nums text-amber-500">
										+{dirty}
									</span>
								)}
							</BarPart>
						</button>
					</>
				)}
			</div>
		</footer>
	);
}

import clsx from "clsx";
import { Activity, AppWindow, HardDrive, Info, X } from "lucide-react";
import { type RefObject, useMemo } from "react";
import type { PerfBreakdown } from "../../lib/contracts";
import { useLive } from "../../stores/live";
import { useUi } from "../../stores/ui";
import { type Anchor, FloatingLayer } from "../../components/FloatingLayer";
import { useT } from "../../stores/language";

export interface PerfPopoverProps {
	anchor?: Anchor | null;
	/** Formatted memory of the app itself and helpers (e.g. "412 MB"). */
	appMemory: string | null;
	/** Number of processes included in the app total. */
	processes?: number;
	open: boolean;
	onClose: () => void;
	/** Shared `perf_breakdown` payload polled by the bottom bar while open. */
	breakdown: PerfBreakdown | null;
	ignoreRefs?: RefObject<HTMLElement | null>[];
	className?: string;
}

function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null) return "—";
	const mb = bytes / (1024 * 1024);
	if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
	return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/** Stacked-bar segment colors: quiet neutrals, omp gets the agent accent. */
const SEG = {
	app: "bg-indigo-500/75 dark:bg-indigo-400/70",
	omp: "bg-emerald-500/70 dark:bg-emerald-400/60",
	other: "bg-neutral-400/60 dark:bg-neutral-500/50",
	free: "bg-neutral-300/70 dark:bg-neutral-700/50",
} as const;

export function PerfPopover({
	anchor,
	appMemory,
	processes = 1,
	open,
	onClose,
	breakdown,
	ignoreRefs,
	className,
}: PerfPopoverProps) {
	const { t } = useT();
	const liveSessions = useLive((s) => s.sessions);
	const liveOmpCount = useMemo(
		() => Object.values(liveSessions).filter((l) => l.alive).length,
		[liveSessions],
	);
	const bd = breakdown;

	// Disjoint physical-footprint segments. Do not turn an unknown probe into a
	// zero-width segment: that would make the total and the details disagree.
	const segments = useMemo(() => {
		if (!bd?.totalBytes || bd.app.bytes == null || bd.barOmpBytes == null ||
			bd.otherBytes == null || bd.freeBytes == null) return null;
		const parts = [
			{ key: "app" as const, bytes: bd.app.bytes },
			{ key: "omp" as const, bytes: bd.barOmpBytes },
			{ key: "other" as const, bytes: bd.otherBytes },
			{ key: "free" as const, bytes: bd.freeBytes },
		];
		const total = bd.totalBytes;
		return parts.map((p) => ({ ...p, pct: (p.bytes / total) * 100 }));
	}, [bd]);

	if (!open) return null;

	return (
		<FloatingLayer
			anchor={open ? (anchor ?? null) : null}
			placement="top-end"
			offset={4}
			layer="popover"
			ignoreRefs={ignoreRefs}
			onDismiss={onClose}
			className={clsx(
				"w-80 p-3.5 text-[var(--text)] select-none animate-in fade-in zoom-in-95 duration-100",
				className,
			)}
		>
			{/* Header */}
			<div className="mb-3 flex items-center justify-between gap-2 border-b border-[var(--line)] pb-2">
				<div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
					<Activity size={14} className="shrink-0 text-[var(--text-60)]" />
					<span>{t("chatView.perf.title")}</span>
					<span
						title={t("chatView.perf.description")}
						className="inline-flex shrink-0 cursor-help items-center text-[var(--text-40)] hover:text-[var(--text-60)] transition-colors"
					>
						<Info size={12} />
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<button
						type="button"
						onClick={() => {
							useUi.getState().openSettings("storage");
							onClose();
						}}
						className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--ghost-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--bg-hover)] active:scale-[0.98] transition-all"
					>
						<HardDrive size={11} className="shrink-0 text-[var(--text-60)]" />
						<span className="whitespace-nowrap">{t("chatView.perf.manageStorage")}</span>
					</button>
					<button
						type="button"
						onClick={onClose}
						className="rounded-md p-1 text-[var(--text-40)] hover:bg-[var(--ghost-hover)] hover:text-[var(--text)] active:scale-95 transition-all"
					>
						<X size={12} />
					</button>
				</div>
			</div>

			{/* 内存分布: stacked bar + legend */}
			<div className="mb-2.5">
				<div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-medium tracking-wide text-[var(--text-40)]">
					<span>{t("chatView.perf.memoryDistribution")}</span>
					{bd?.usedBytes != null && bd?.totalBytes != null && (
						<span className="font-mono font-normal tabular-nums text-[var(--text-40)]">
							{t("chatView.perf.usedOfTotal", {
								used: formatBytes(bd.usedBytes),
								total: formatBytes(bd.totalBytes),
							})}
						</span>
					)}
				</div>
				{segments ? (
					<>
						<div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--ghost-hover)]">
							{segments.map((s) =>
								s.pct > 0 ? (
									<div
										key={s.key}
										className={clsx("h-full", SEG[s.key])}
										style={{ width: `${s.pct}%` }}
									/>
								) : null,
							)}
						</div>
						<div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
							{([
								["app", t("chatView.perf.app"), bd?.app.bytes],
								["omp", t("chatView.perf.ompAgents"), bd?.barOmpBytes],
								["other", t("chatView.perf.otherApps"), bd?.otherBytes],
								["free", t("chatView.perf.free"), bd?.freeBytes],
							] as const).map(([key, label, bytes]) => (
								<div key={key} className="flex items-center justify-between gap-2">
									<span className="flex min-w-0 items-center gap-1.5 text-[var(--text-60)]">
										<span className={clsx("h-1.5 w-1.5 shrink-0 rounded-[2px]", SEG[key])} />
										{label}
									</span>
									<span className="shrink-0 font-mono tabular-nums text-[var(--text)]">
										{formatBytes(bytes)}
									</span>
								</div>
							))}
						</div>
					</>
				) : (
					<div className="py-1.5 text-center text-[11px] text-[var(--text-40)]">
						{bd ? t("chatView.perf.notSupported") : t("chatView.perf.collecting")}
					</div>
				)}
			</div>

			{/* Detail rows: 本程序 + OMP split */}
			<div className="mt-3 space-y-1 border-t border-[var(--line)] pt-2.5 text-xs">
				<div
					className="flex items-center justify-between"
					title={t("chatView.perf.appProcessTreeTitle", { count: bd?.app.processes ?? processes })}
				>
					<div className="flex min-w-0 items-center gap-1.5">
						<AppWindow size={12} className="shrink-0 text-[var(--text-60)]" />
						<span className="truncate text-[var(--text-60)]">{t("chatView.perf.appUi")}</span>
						<span className="shrink-0 font-mono text-[10px] text-[var(--text-40)]">
							{t("chatView.perf.processCount", { count: bd?.app.processes ?? processes })}
						</span>
					</div>
					<span className="shrink-0 font-mono tabular-nums text-[var(--text)]">
						{bd?.app.bytes != null ? formatBytes(bd.app.bytes) : (appMemory ?? "—")}
					</span>
				</div>
				<div
					className="flex items-center justify-between"
					title={t("chatView.perf.ompSpawnedTitle")}
				>
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="w-3 shrink-0 text-center text-[var(--text-40)]">└</span>
						<span className="truncate text-[var(--text-60)]">{t("chatView.perf.ompSpawned")}</span>
						<span className="shrink-0 font-mono text-[10px] text-[var(--text-40)]">
							{bd?.ompSpawned.bytes != null ? t("chatView.perf.processCount", { count: bd.ompSpawned.processes }) : "—"}
						</span>
					</div>
					<span className="shrink-0 font-mono tabular-nums text-[var(--text)]">
						{formatBytes(bd?.ompSpawned.bytes)}
					</span>
				</div>
				<div
					className="flex items-center justify-between"
					title={t("chatView.perf.ompExternalTitle")}
				>
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="w-3 shrink-0 text-center text-[var(--text-40)]">└</span>
						<span className="truncate text-[var(--text-60)]">{t("chatView.perf.ompExternal")}</span>
						<span className="shrink-0 font-mono text-[10px] text-[var(--text-40)]">
							{bd?.ompExternal.bytes != null ? t("chatView.perf.processCount", { count: bd.ompExternal.processes }) : "—"}
						</span>
					</div>
					<span className="shrink-0 font-mono tabular-nums text-[var(--text)]">
						{formatBytes(bd?.ompExternal.bytes)}
					</span>
				</div>
			</div>

			{/* Instance labels and process IDs are development diagnostics only; show only when multiple instances run. */}
			{import.meta.env.DEV && bd && bd.instances.length > 1 && (
			<div className="mt-3 border-t border-[var(--line)] pt-2.5">
				<div className="mb-1.5 flex items-center justify-between text-[10px] font-medium tracking-wide text-[var(--text-40)]">
					<span>{t("chatView.perf.activeWindows")}</span>
					<span className="font-normal">
						{t("chatView.perf.instancesSummary", { total: bd.instances.length, live: liveOmpCount })}
					</span>
				</div>
				<div className="space-y-1 text-[11px]">
					{bd.instances.map((i) => (
						<div
							key={i.pid}
							title={i.cwd ?? `pid ${i.pid}`}
							className="flex items-center justify-between gap-2"
						>
							<div className="flex min-w-0 items-center gap-1.5">
								<AppWindow
									size={11}
									className={clsx(
										"shrink-0",
										i.isThis ? "text-[var(--status-success)]" : "text-[var(--text-40)]",
									)}
								/>
								<span className="truncate text-[var(--text-60)]">
									{i.label}
									{i.isThis ? t("chatView.perf.thisWindow") : ""}
								</span>
							</div>
							{i.label.trim() !== `pid ${i.pid}` && (
								<span className="shrink-0 font-mono text-[10px] text-[var(--text-40)]">
									pid {i.pid}
								</span>
							)}
						</div>
					))}
				</div>
			</div>
			)}
		</FloatingLayer>
	);
}

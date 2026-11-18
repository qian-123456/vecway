/** [B] Per-request model stats: one dim TUI-style line under the last row of
 * every assistant message, its click-open explanation card (field meanings +
 * 等第一个字 / 生成 split), and the whole-turn summary rows of the 「已处理」 area.
 * Values come from omp's own per-request metrics via `requestStats.ts`. */

import clsx from "clsx";
import { useMemo, useRef, useState } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import { useDisplayPrefs } from "../../stores/displayPrefs";
import { useT, tNow } from "../../stores/language";
import {
	REQUEST_STAT_FIELDS,
	aggregateRequestStats,
	formatRequestStat,
	formatFailedRequest,
	formatStatTokens,
	type RequestStat,
} from "./requestStats";
import { formatDurationCompact } from "./turnGrouping";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 「今天 12:47:23」/「10月17日 12:47:23」/「2025年3月4日 12:47:23」. */
function statDateTime(epochMs: number): string {
	const d = new Date(epochMs);
	const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
	const now = new Date();
	if (
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate()
	) {
		return tNow("chatView.stats.today", { time: clock });
	}
	const month = d.getMonth() + 1;
	const day = d.getDate();
	const prefix =
		d.getFullYear() === now.getFullYear()
			? tNow("chatView.stats.dateMonthDay", { month, day })
			: tNow("chatView.stats.dateYearMonthDay", { year: d.getFullYear(), month, day });
	return `${prefix} ${clock}`;
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One explained value: label + number, with the Chinese meaning underneath. */
function FieldRow({
	glyph = "",
	label,
	value,
	description,
}: {
	glyph?: string;
	label: string;
	value: string;
	description: string;
}) {
	return (
		<div className="flex flex-col">
			<div className="flex items-baseline justify-between gap-3">
				<span className="min-w-0 text-[12px] text-[var(--text-60)]">
					{glyph && <span className="me-1 text-[var(--text-40)]">{glyph}</span>}
					{label}
				</span>
				<span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-40)]">
					{value}
				</span>
			</div>
			<span className="text-[11px] leading-4 text-[var(--text-30)]">{description}</span>
		</div>
	);
}

/** ttft vs. the rest of the request: where the wall time of one call went. */
function TimeSplit({ stat }: { stat: RequestStat }) {
	const { t } = useT();
	const duration = stat.durationMs;
	const known = duration != null && duration > 0;
	const ttft = stat.ttftMs;
	if (!known || ttft == null) return <div className="h-1 w-full rounded-full bg-[var(--line)]" />;
	const wait = Math.max(0, Math.min(duration, ttft));
	const gen = Math.max(0, duration - wait);
	return (
		<div>
			<div className="flex h-1 w-full overflow-hidden rounded-full bg-[var(--line)]">
				<span
					className="bg-[var(--text-30)]"
					style={{ width: `${(wait / duration) * 100}%` }}
				/>
				<span className="flex-1 bg-[var(--text-60)]" />
			</div>
			<div className="mt-1 flex justify-between text-[11px] text-[var(--text-30)]">
				<span>{t("chatView.stats.firstTokenWait", { time: ttft == null ? "—" : seconds(ttft) })}</span>
				<span>{t("chatView.stats.generationTime", { time: seconds(gen) })}</span>
			</div>
		</div>
	);
}

/** Card body for a failed request: what happened, no meaningless zero fields. */
function FailedRequestCard({ stat }: { stat: RequestStat }) {
	const { t } = useT();
	const when = stat.startedAt ?? stat.completedAt;
	return (
		<div className="flex w-[290px] select-text flex-col gap-1.5 p-3">
			<div className="text-[12px] text-[var(--text-60)]">
				{t("chatView.stats.modelRequestFailed")}
				{when != null && (
					<span className="ms-1.5 font-mono text-[11px] tabular-nums text-[var(--text-40)]">
						{statDateTime(when)}
					</span>
				)}
			</div>
			<div className="text-[11px] leading-relaxed text-[var(--text-40)]">
				{t("chatView.stats.requestFailedExplanation")}
			</div>
			{stat.durationMs != null && (
				<FieldRow
					label={t("chatView.stats.waitDuration")}
					value={seconds(stat.durationMs)}
					description={t("chatView.stats.waitDurationDesc")}
				/>
			)}
			<div className="break-words rounded-md bg-rose-500/10 px-2 py-1 font-mono text-[11px] leading-relaxed text-rose-400">
				{stat.error}
			</div>
		</div>
	);
}

/** The explanation card body for one model request. */
function RequestCard({ stat }: { stat: RequestStat }) {
	const { t } = useT();
	const fields = useDisplayPrefs((s) => s.requestStatFields);
	// `t` in deps: formatRequestStat localizes via tNow, so re-run on locale switch.
	const parts = useMemo(() => formatRequestStat(stat, fields), [stat, fields, t]);
	const when = stat.startedAt ?? stat.completedAt;
	return (
		<div className="flex w-[290px] flex-col gap-1.5 p-3">
			<div className="text-[12px] text-[var(--text-60)]">
				{t("chatView.stats.modelRequest")}
				{when != null && (
					<span className="ms-1.5 font-mono text-[11px] tabular-nums text-[var(--text-40)]">
						{statDateTime(when)}
					</span>
				)}
			</div>
			{parts.map((p) => {
				const meta = REQUEST_STAT_FIELDS[p.field];
				return (
					<FieldRow
						key={p.field}
						glyph={meta.glyph}
						label={meta.label}
						value={p.text}
						description={meta.description}
					/>
				);
			})}
			{/* 总耗时 doubles as the bar's denominator, so always explain it. */}
			{!fields.duration && (
				<FieldRow
					glyph={REQUEST_STAT_FIELDS.duration.glyph}
					label={t("chatView.stats.totalDuration")}
					value={stat.durationMs == null ? "—" : seconds(stat.durationMs)}
					description={t("chatView.stats.totalDurationDesc")}
				/>
			)}
			<TimeSplit stat={stat} />
		</div>
	);
}

/**
 * One request's stats line: `12:47:23 ↘1.3K ↗774 💾51K ⏱2.2s ⚡71.4/s`.
 * Renders nothing when the setting is off or no field is enabled.
 * Hover and keyboard focus highlight the clickable row; the highlight stays while open.
 */
export function RequestStatsLine({
	stat,
	className,
	omitTime,
}: {
	stat: RequestStat;
	/** Extra row classes (indent, spacing) supplied by the owning list. */
	className?: string;
	/** Drop the clock field when a neighbouring row already shows the time
	 * (the answer footer); the explanation card still lists it. */
	omitTime?: boolean;
}) {
	const { t } = useT();
	const enabled = useDisplayPrefs((s) => s.requestStats);
	const fields = useDisplayPrefs((s) => s.requestStatFields);
	const parts = useMemo(
		() =>
			enabled
				? formatRequestStat(stat, omitTime ? { ...fields, time: false } : fields)
				: [],
		[enabled, stat, fields, omitTime, t],
	);
	const triggerRef = useRef<HTMLDivElement>(null);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const toggleCard = (event: { currentTarget: HTMLElement }) => {
		setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect());
	};
	const failedText = formatFailedRequest(stat);
	if (!failedText && parts.length === 0) return null;

	return (
		<>
			<div
				ref={triggerRef}
				className={clsx(
					"-mx-1 flex w-fit max-w-full cursor-pointer flex-wrap items-baseline gap-x-2 rounded-md px-1 font-mono text-[11px] leading-5 tabular-nums transition-colors hover:bg-[var(--ghost-hover)] focus-visible:bg-[var(--ghost-hover)] aria-expanded:bg-[var(--ghost-hover)]",
					className,
				)}
				onClick={toggleCard}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						toggleCard(e);
					}
				}}
				role="button"
				tabIndex={0}
				aria-label={t("chatView.stats.ariaViewStats")}
				aria-expanded={anchor !== null}
			>
				{failedText ? (
					<>
						{!omitTime && failedText.time && (
							<span className="text-[var(--text-30)]">{failedText.time}</span>
						)}
						<span className="rounded-full bg-rose-500/10 px-1.5 text-rose-400">{failedText.label}</span>
						{failedText.wait && <span className="text-[var(--text-40)]">{failedText.wait}</span>}
						<span className="select-text break-words text-rose-400">{failedText.reason}</span>
					</>
				) : (
					parts.map((p) => (
						<span
							key={p.field}
							className={
								p.field === "time" ? "text-[var(--text-30)]" : "text-[var(--text-40)]"
							}
						>
							{p.glyph}
							{p.text}
						</span>
					))
				)}
			</div>
			{anchor && (
				<FloatingLayer
					anchor={anchor}
					placement="top-start"
					offset={6}
					layer="hovercard"
					onDismiss={() => setAnchor(null)}
					ignoreRefs={[triggerRef]}
				>
					{stat.error ? <FailedRequestCard stat={stat} /> : <RequestCard stat={stat} />}
				</FloatingLayer>
			)}
		</>
	);
}

/**
 * Whole-turn summary shown as the first rows of the expanded 「已处理」 area:
 * duration, request count, total input/output, average speed (and cost when
 * enabled), one label/value pair per row. Plain inline content, no popup.
 */
export function TurnSummaryRows({
	stats,
	durationMs,
}: {
	stats: RequestStat[];
	durationMs?: number;
}) {
	const { t } = useT();
	const withCost = useDisplayPrefs((s) => s.requestStatFields.cost);
	const totals = useMemo(() => aggregateRequestStats(stats), [stats]);
	const rows: { label: string; value: string }[] = [];
	if (durationMs) rows.push({ label: t("chatView.stats.summaryTotalTime"), value: formatDurationCompact(durationMs) });
	if (totals.count > 0) {
		rows.push({
			label: t("chatView.stats.summaryRequestCount"),
			value: totals.failed > 0 ? t("chatView.stats.requestsWithFailed", { count: totals.count, failed: totals.failed }) : t("chatView.stats.requestsCount", { count: totals.count }),
		});
		rows.push({
			label: t("chatView.stats.summaryTotalInput"),
			value: totals.input == null ? "—" : `${REQUEST_STAT_FIELDS.input.glyph}${formatStatTokens(totals.input)}`,
		});
		rows.push({
			label: t("chatView.stats.summaryTotalOutput"),
			value: totals.output == null ? "—" : `${REQUEST_STAT_FIELDS.output.glyph}${formatStatTokens(totals.output)}`,
		});
		rows.push({
			label: t("chatView.stats.summaryCacheHit"),
			value: totals.cacheRead == null ? "—" : `${REQUEST_STAT_FIELDS.cache.glyph}${formatStatTokens(totals.cacheRead)}`,
		});
		rows.push({
			label: t("chatView.stats.summaryAvgSpeed"),
			value:
				totals.avgTps == null
					? "—"
					: `${REQUEST_STAT_FIELDS.tps.glyph}${totals.avgTps.toFixed(1)}/s`,
		});
		if (withCost) {
			rows.push({
				label: t("chatView.stats.summaryTotalCost"),
				value: totals.cost == null ? "—" : `$${totals.cost.toFixed(totals.cost < 1 ? 3 : 2)}`,
			});
		}
	}
	if (rows.length === 0) return null;
	return (
		<dl className="mb-1 grid w-fit grid-cols-[repeat(3,max-content)] gap-x-5 gap-y-0.5 text-[11px] leading-4">
			{rows.map((r) => (
				<div key={r.label} className="flex items-baseline gap-1.5 whitespace-nowrap">
					<dt className="text-[var(--text-40)]">{r.label}</dt>
					<dd className="m-0 font-mono tabular-nums text-[var(--text-60)]">{r.value}</dd>
				</div>
			))}
		</dl>
	);
}
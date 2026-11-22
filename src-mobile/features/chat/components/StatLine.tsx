import { memo, useMemo, useRef } from "react";
import { AnchoredPopover, type AnchorBox } from "../../../ui";
import {
	FIELDS,
	FIELD_GLYPHS,
	FIELD_IDS,
	MISSING,
	aggregateTurnStats,
	fieldText,
	formatDesktopStatParts,
	formatDurationCompact,
	formatFailedRequest,
	formatStatClock,
	formatStatDateTime,
	formatStatSeconds,
	formatStatTokens,
	isToday,
	ttftSplit,
	type RequestStat,
} from "../lib/requestStats";

/** Desktop-parity quiet 11px monospace TUI stats line; tap opens the detail card. */
export const StatLine = memo(function StatLine({
	stat,
	onOpen,
	omitTime = false,
	className = "",
}: {
	stat: RequestStat;
	onOpen: (stat: RequestStat, anchorEl?: HTMLElement | null) => void;
	omitTime?: boolean;
	className?: string;
}) {
	const failed = formatFailedRequest(stat);
	const parts = useMemo(() => (failed ? [] : formatDesktopStatParts(stat, { omitTime })), [failed, stat, omitTime]);
	if (!failed && parts.length === 0) return null;
	const ariaSummary = failed
		? [omitTime ? null : failed.time, failed.label, failed.wait, failed.reason].filter(Boolean).join(" ")
		: parts.map((p) => `${p.glyph}${p.text}`).join(" ");

	return (
		<button
			type="button"
			aria-label={`请求详情：${ariaSummary}`}
			onClick={(e) => onOpen(stat, e.currentTarget)}
			className={`-mx-1 inline-flex w-fit max-w-full flex-wrap items-baseline gap-x-2 rounded-md px-1 py-0.5 text-left font-m-mono text-[11px] leading-5 tabular-nums transition-colors active:bg-m-surface-hover ${className}`}
		>
			{failed ? (
				<>
					{!omitTime && failed.time && <span className="text-m-text-faint">{failed.time}</span>}
					<span className="rounded-full bg-m-danger-bg px-1.5 text-m-danger">{failed.label}</span>
					{failed.wait && <span className="text-m-text-quiet">{failed.wait}</span>}
					<span className="break-words text-m-danger">{failed.reason}</span>
				</>
			) : (
				parts.map((p) => (
					<span key={p.field} className={p.field === "time" ? "text-m-text-faint" : "text-m-text-quiet"}>
						{p.glyph}
						{p.text}
					</span>
				))
			)}
		</button>
	);
});

function statDateTime(epochMs: number): string {
	const clock = formatStatClock(epochMs);
	if (isToday(epochMs)) return `今天 ${clock}`;
	const d = new Date(epochMs);
	const now = new Date();
	if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
	return formatStatDateTime(epochMs);
}

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
				<span className="min-w-0 text-[12px] text-m-text-2">
					{glyph && <span className="mr-1 text-m-text-quiet">{glyph}</span>}
					{label}
				</span>
				<span className="shrink-0 font-m-mono text-[11px] tabular-nums text-m-text-quiet">{value}</span>
			</div>
			<span className="text-[11px] leading-4 text-m-text-faint">{description}</span>
		</div>
	);
}

function TimeSplit({ stat }: { stat: RequestStat }) {
	const split = ttftSplit(stat);
	if (!split) return <div className="mt-0.5 h-1 w-full rounded-full bg-m-border" />;
	return (
		<div className="mt-0.5">
			<div aria-hidden className="flex h-1 w-full overflow-hidden rounded-full bg-m-border">
				<span className="bg-m-text-faint" style={{ width: `${split.waitPercent.toFixed(1)}%` }} />
				<span className="flex-1 bg-m-text-2" />
			</div>
			<div className="mt-1 flex justify-between text-[11px] text-m-text-faint">
				<span>等第一个字 {formatStatSeconds(split.ttftMs)}</span>
				<span>生成 {formatStatSeconds(split.generationMs)}</span>
			</div>
		</div>
	);
}

function FailedRequestCard({ stat }: { stat: RequestStat }) {
	const when = stat.startedAt ?? stat.completedAt;
	return (
		<div className="m-selectable flex w-[290px] max-w-full flex-col gap-1.5 p-3">
			<div className="text-[12px] text-m-text-2">
				模型请求失败
				{when != null && (
					<span className="ml-1.5 font-m-mono text-[11px] tabular-nums text-m-text-quiet">
						{statDateTime(when)}
					</span>
				)}
			</div>
			<div className="text-[11px] leading-relaxed text-m-text-quiet">
				这次请求没有成功返回，系统已记录真实等待时长和失败原因。
			</div>
			{stat.durationMs != null && (
				<FieldRow
					label="等待时长"
					value={formatStatSeconds(stat.durationMs)}
					description={FIELDS.duration.description}
				/>
			)}
			<div className="break-words rounded-md bg-m-danger-bg px-2 py-1 font-m-mono text-[11px] leading-relaxed text-m-danger">
				{stat.error}
			</div>
		</div>
	);
}

function RequestCard({ stat }: { stat: RequestStat }) {
	const when = stat.startedAt ?? stat.completedAt;
	const shownFields = FIELD_IDS.filter((f) => {
		if (f === "duration") return true;
		return fieldText(stat, f) !== null;
	});
	return (
		<div className="flex w-[290px] max-w-full flex-col gap-1.5 p-3">
			<div className="text-[12px] text-m-text-2">
				模型请求
				{when != null && (
					<span className="ml-1.5 font-m-mono text-[11px] tabular-nums text-m-text-quiet">
						{statDateTime(when)}
					</span>
				)}
			</div>
			{shownFields.map((f) => {
				const meta = FIELDS[f];
				return (
					<FieldRow
						key={f}
						glyph={FIELD_GLYPHS[f]}
						label={meta.label}
						value={fieldText(stat, f) ?? MISSING}
						description={meta.description}
					/>
				);
			})}
			<TimeSplit stat={stat} />
		</div>
	);
}

/** Detail popover for one request; keeps the last stat while animating closed. */
export function StatCard({
	stat,
	onClose,
	anchorEl,
	anchorRect,
}: {
	stat: RequestStat | null;
	onClose: () => void;
	anchorEl?: HTMLElement | null;
	anchorRect?: AnchorBox | null;
}) {
	const last = useRef<RequestStat | null>(null);
	if (stat) last.current = stat;
	const shown = stat ?? last.current;
	return (
		<AnchoredPopover
			open={stat !== null}
			onClose={onClose}
			anchorEl={anchorEl}
			anchorRect={anchorRect}
			placement="top-start"
			maxWidth={310}
			minWidth={260}
			className="m-liquid-surface"
		>
			{shown && (shown.error ? <FailedRequestCard stat={shown} /> : <RequestCard stat={shown} />)}
		</AnchoredPopover>
	);
}

/** Whole-turn 3-column borderless summary shown at the top of expanded ProcessFold. */
export function TurnSummaryRows({
	stats,
	durationMs,
}: {
	stats: readonly RequestStat[];
	durationMs?: number;
}) {
	const totals = useMemo(() => aggregateTurnStats(stats), [stats]);
	const rows: { label: string; value: string }[] = [];
	if (durationMs && durationMs > 0) {
		rows.push({ label: "总耗时", value: formatDurationCompact(durationMs) });
	}
	if (totals.count > 0) {
		rows.push({
			label: "请求次数",
			value: totals.failed > 0 ? `${totals.count}次（${totals.failed}失败）` : `${totals.count}次`,
		});
		rows.push({
			label: "总输入",
			value: totals.input == null ? MISSING : `${FIELD_GLYPHS.input}${formatStatTokens(totals.input)}`,
		});
		rows.push({
			label: "总输出",
			value: totals.output == null ? MISSING : `${FIELD_GLYPHS.output}${formatStatTokens(totals.output)}`,
		});
		rows.push({
			label: "缓存命中",
			value: totals.cacheRead == null ? MISSING : `${FIELD_GLYPHS.cache}${formatStatTokens(totals.cacheRead)}`,
		});
		rows.push({
			label: "平均速度",
			value: totals.avgTps == null ? MISSING : `${FIELD_GLYPHS.tps}${totals.avgTps.toFixed(1)}/s`,
		});
	}
	if (rows.length === 0) return null;
	return (
		<dl className="mb-1.5 grid w-fit max-w-full grid-cols-[repeat(3,minmax(0,max-content))] gap-x-4 gap-y-0.5 text-[11px] leading-4">
			{rows.map((r) => (
				<div key={r.label} className="flex items-baseline gap-1.5 whitespace-nowrap">
					<dt className="text-m-text-quiet">{r.label}</dt>
					<dd className="m-0 font-m-mono tabular-nums text-m-text-2">{r.value}</dd>
				</div>
			))}
		</dl>
	);
}

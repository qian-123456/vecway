import {
	ArrowDownToLine,
	ArrowUpFromLine,
	Clock,
	Database,
	Gauge,
	Hourglass,
	ReceiptText,
	Timer,
	type LucideIcon,
} from "lucide-react";
import { memo, useRef } from "react";
import { AnchoredPopover, type AnchorBox } from "../../../ui";
import {
	FIELDS,
	FIELD_IDS,
	MISSING,
	fieldText,
	formatStatClock,
	formatStatDateTime,
	formatStatSeconds,
	isToday,
	statSummary,
	ttftSplit,
	type StatField,
} from "../lib/requestStats";
import type { RequestStat } from "../lib/requestStats";

/** Quiet 13px stats text (time · tokens · duration); tap opens the detail card. Renders nothing without data. */
export const StatLine = memo(function StatLine({
	stat,
	onOpen,
}: {
	stat: RequestStat;
	onOpen: (stat: RequestStat, anchorEl?: HTMLElement | null) => void;
}) {
	const text = statSummary(stat);
	if (!text) return null;
	return (
		<button
			type="button"
			aria-label={`请求详情：${text}`}
			onClick={(e) => onOpen(stat, e.currentTarget)}
			className="inline-flex min-h-11 min-w-11 items-center rounded-m-pill px-2 text-left text-m-xs text-m-text-3 active:bg-m-surface-hover"
		>
			{text}
		</button>
	);
});

const FIELD_ICON: Record<StatField, LucideIcon> = {
	time: Clock,
	input: ArrowDownToLine,
	output: ArrowUpFromLine,
	cache: Database,
	ttft: Timer,
	tps: Gauge,
	duration: Hourglass,
	cost: ReceiptText,
};

function whenText(stat: RequestStat): string {
	// Same anchor as the desktop card: the request's start time.
	const at = stat.startedAt ?? stat.completedAt;
	if (at == null) return "时间未知";
	return isToday(at) ? `今天 ${formatStatClock(at)}` : formatStatDateTime(at);
}

function TtftBar({ stat }: { stat: RequestStat }) {
	const split = ttftSplit(stat);
	if (!split) return null;
	return (
		<div className="px-5 pt-4 pb-2">
			<div aria-hidden className="flex h-2 overflow-hidden rounded-m-pill bg-m-surface-2">
				<i className="block bg-m-warn" style={{ width: `${split.waitPercent.toFixed(1)}%` }} />
				<i className="block flex-1 bg-m-accent" />
			</div>
			<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-m-xs text-m-text-2">
				<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
					<i aria-hidden className="size-2 rounded-m-pill bg-m-warn" />
					等第一个字 {formatStatSeconds(split.ttftMs)}
				</span>
				<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
					<i aria-hidden className="size-2 rounded-m-pill bg-m-accent" />
					生成 {formatStatSeconds(split.generationMs)}
				</span>
			</div>
		</div>
	);
}

/** Detail sheet for one request; keeps the last stat while the sheet animates closed. */
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
			placement="top-end"
			title="这次请求"
			subtitle={shown ? whenText(shown) : undefined}
			maxWidth={340}
			minWidth={260}
		>
			{shown && (
				<div className="px-3 pt-2.5 pb-3">
					<div className="overflow-hidden rounded-m-md bg-m-surface">
						{FIELD_IDS.map((f) => {
							const meta = FIELDS[f];
							const Icon = FIELD_ICON[f];
							return (
								<div key={f} className="flex min-h-11 items-center gap-2.5 px-3 py-2">
									<Icon size={17} strokeWidth={1.75} aria-hidden className="shrink-0 text-m-text-2" />
									<div className="min-w-0 flex-1">
										<div className="text-m-sm">{meta.label}</div>
										<div className="text-[11px] text-m-text-3">{meta.description}</div>
									</div>
									<span className="shrink-0 whitespace-nowrap font-m-mono text-m-xs text-m-text-2">
										{fieldText(shown, f) ?? MISSING}
									</span>
								</div>
							);
						})}
					</div>
					<TtftBar stat={shown} />
				</div>
			)}
		</AnchoredPopover>
	);
}

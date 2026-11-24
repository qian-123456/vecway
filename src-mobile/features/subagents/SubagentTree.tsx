import { Check, ChevronDown, ChevronRight, Clock, Loader2, X } from "lucide-react";
import { useState } from "react";
import { shortModel } from "../chat/lib/models";
import { Chip } from "../../ui";
import type { ChipTone } from "../../ui";
import { elapsedMs, formatElapsed, rowLabel, statusText } from "./model";
import type { Bucket, FlatRow } from "./model";

export const BUCKET_TONE: Record<Bucket, ChipTone> = {
	running: "accent",
	queued: "neutral",
	done: "success",
	failed: "danger",
};

/** Status dot colour; the running dot also pulses. */
export const BUCKET_DOT: Record<Bucket, string> = {
	running: "bg-m-accent m-pulse",
	queued: "bg-m-text-3",
	done: "bg-m-success",
	failed: "bg-m-danger",
};

/** Width of one tree level. Equals the dot column so a child's connector sits under its parent's dot. */
const COL = 14;
/** Keep deeply nested dispatches readable on a phone; the full level remains in the row label. */
const MAX_VISIBLE_DEPTH = 3;
/** Vertical centre of the first text line (row padding 14px + half of the 22px line). */
const DOT_Y = 25;

const line = "absolute w-px bg-m-border-strong";

/** Guides and the elbow of one row, drawn in the indentation columns. */
function Connectors({ flat, compact = false }: { flat: FlatRow; compact?: boolean }) {
	const { guides, isLast } = flat;
	const depth = Math.min(flat.depth, MAX_VISIBLE_DEPTH);
	const guideOffset = flat.depth - depth;
	if (depth === 0) return null;
	if (compact) {
		return (
			<span className="flex shrink-0 self-stretch" aria-hidden>
				{Array.from({ length: depth }, (_, i) => (
					<span key={i} className="relative shrink-0" style={{ width: 14 }}>
						<span className="absolute top-1.5 bottom-1.5 left-1.5 w-px bg-m-border/80" />
					</span>
				))}
			</span>
		);
	}
	return (
		<span className="flex shrink-0 self-stretch" aria-hidden>
			{Array.from({ length: depth }, (_, i) => {
				const col = i + 1;
				const own = col === depth;
				return (
					<span key={col} className="relative shrink-0" style={{ width: COL }}>
						{own ? (
							<>
								<span className={`${line} left-1/2 top-0`} style={{ height: isLast ? DOT_Y : "100%" }} />
								<span className="absolute left-1/2 h-px bg-m-border-strong" style={{ top: DOT_Y, width: COL / 2 + 4 }} />
							</>
						) : (
							guides[guideOffset + col - 1] && <span className={`${line} bottom-0 left-1/2 top-0`} />
						)}
					</span>
				);
			})}
		</span>
	);
}

function CompactStatusIcon({ bucket }: { bucket: Bucket }) {
	if (bucket === "running") return <Loader2 size={13} className="shrink-0 animate-spin text-m-accent" aria-hidden />;
	if (bucket === "done") return <Check size={13} strokeWidth={2.5} className="shrink-0 text-m-success" aria-hidden />;
	if (bucket === "failed") return <X size={13} strokeWidth={2.5} className="shrink-0 text-m-danger" aria-hidden />;
	return <Clock size={13} className="shrink-0 text-m-text-3" aria-hidden />;
}

const COMPACT_BADGE: Record<Bucket, string> = {
	running: "bg-m-accent-soft text-m-accent-soft-text",
	queued: "bg-m-surface-2 text-m-text-3",
	done: "bg-m-success-bg text-m-success",
	failed: "bg-m-danger-bg text-m-danger",
};

function TreeRow({ flat, hasChildren, collapsed, now, compact, onOpen, onToggle }: {
	flat: FlatRow;
	hasChildren: boolean;
	collapsed: boolean;
	now: number;
	compact: boolean;
	onOpen: (id: string) => void;
	onToggle: (id: string) => void;
}) {
	const { row, bucket } = flat.node;
	const label = rowLabel(row);
	const elapsed = formatElapsed(elapsedMs(row, now));
	const modelShort = row.model ? shortModel(row.model) || row.model : "";
	const meta = [label.role, compact ? modelShort : row.model].filter(Boolean).join(" · ");

	if (compact) {
		const toolsLabel = row.toolCallCount ? `${row.toolCallCount} 次工具` : null;
		return (
			<li className={`flex ${flat.dim ? "opacity-55" : ""}`}>
				<Connectors flat={flat} compact />
				<button
					type="button"
					onClick={() => onOpen(row.id)}
					aria-label={`${label.primary}，${statusText(row.status)}${flat.depth > 0 ? `，第 ${flat.depth + 1} 层` : ""}`}
					className="m-press flex min-h-12 min-w-0 flex-1 items-start gap-2.5 rounded-m-md px-2.5 py-2 text-left transition-colors active:bg-m-surface-hover"
				>
					<span className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-m-surface">
						<CompactStatusIcon bucket={bucket} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="flex items-center gap-1.5">
							<span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-snug text-m-text">
								{label.primary}
							</span>
							{elapsed && (
								<span className="shrink-0 text-[11px] whitespace-nowrap tabular-nums text-m-text-3">
									{elapsed}
								</span>
							)}
						</span>
						{label.description && (
							<span className="mt-0.5 line-clamp-1 text-[11.5px] leading-snug text-m-text-2">
								{label.description}
							</span>
						)}
						<span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] leading-none">
							<span className={`rounded-m-pill px-1.5 py-0.5 font-medium whitespace-nowrap ${COMPACT_BADGE[bucket]}`}>
								{statusText(row.status)}
							</span>
							{label.role && (
								<span className="rounded bg-m-surface px-1.5 py-0.5 whitespace-nowrap text-m-text-2">
									{label.role}
								</span>
							)}
							{modelShort && (
								<span className="truncate font-m-mono text-m-text-3">{modelShort}</span>
							)}
							{toolsLabel && (
								<span className="whitespace-nowrap tabular-nums text-m-text-3">· {toolsLabel}</span>
							)}
						</span>
					</span>
					<ChevronRight size={14} strokeWidth={1.75} className="mt-1.5 shrink-0 text-m-text-3" aria-hidden />
				</button>
			</li>
		);
	}

	return (
		<li className={`m-list-row flex pl-4 ${flat.dim ? "opacity-55" : ""}`}>
			<Connectors flat={flat} />
			<button
				type="button"
				onClick={() => onOpen(row.id)}
				aria-label={`${label.primary}，${statusText(row.status)}${flat.depth > 0 ? `，第 ${flat.depth + 1} 层` : ""}`}
				className="flex min-w-0 flex-1 text-left active:bg-m-surface-hover"
			>
				<span className="relative flex shrink-0 justify-center self-stretch" style={{ width: COL }} aria-hidden>
					<span className={`absolute size-2 rounded-m-pill ${BUCKET_DOT[bucket]}`} style={{ top: DOT_Y - 4 }} />
					{hasChildren && !collapsed && <span className={`${line} bottom-0 left-1/2`} style={{ top: DOT_Y + 8 }} />}
				</span>
				<span className="m-list-sep ml-2 flex min-h-14 min-w-0 flex-1 items-start gap-2 py-3.5 pr-1">
					<span className="min-w-0 flex-1">
						<span className="block text-m-md font-medium [overflow-wrap:anywhere] text-m-text">{label.primary}</span>
						{label.description && (
							<span className="mt-0.5 line-clamp-2 text-m-sm break-words text-m-text-2">{label.description}</span>
						)}
						{meta && <span className="mt-1 block text-m-xs [overflow-wrap:anywhere] text-m-text-3">{meta}</span>}
						<span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
							<Chip tone={BUCKET_TONE[bucket]}>{statusText(row.status)}</Chip>
							{elapsed && <span className="text-m-xs whitespace-nowrap text-m-text-3 tabular-nums">{elapsed}</span>}
							{flat.depth >= MAX_VISIBLE_DEPTH && (
								<span className="text-m-xs whitespace-nowrap text-m-text-3">第 {flat.depth + 1} 层</span>
							)}
						</span>
					</span>
					{!hasChildren && <ChevronRight size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-m-text-3" aria-hidden />}
				</span>
			</button>
			{hasChildren && (
				<button
					type="button"
					aria-label={`${collapsed ? "展开" : "收起"}${label.primary}的子代理`}
					aria-expanded={!collapsed}
					onClick={() => onToggle(row.id)}
					className="flex min-h-11 min-w-11 shrink-0 self-start items-center justify-center rounded-m-pill text-m-text-3 active:bg-m-surface-hover"
				>
					{collapsed ? <ChevronRight size={18} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={18} strokeWidth={1.75} aria-hidden />}
				</button>
			)}
		</li>
	);
}

/**
 * Nested dispatch tree in one grouped card: each level indents one dot column, thin connector
 * lines join a child to its parent's dot. Rows open the agent's detail page.
 */
export function SubagentTree({
	rows,
	now,
	onOpen,
	compact = false,
	className = "bg-m-card",
}: {
	rows: readonly FlatRow[];
	now: number;
	onOpen: (id: string) => void;
	compact?: boolean;
	/** Card fill; `bg-m-card` on elevated canvases, `bg-m-surface` on the page canvas. */
	className?: string;
}) {
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const toggle = (id: string) => setCollapsed((previous) => {
		const next = new Set(previous);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return next;
	});
	let hiddenBelow: number | null = null;
	const visibleRows = rows.filter((flat) => {
		if (hiddenBelow !== null && flat.depth > hiddenBelow) return false;
		hiddenBelow = collapsed.has(flat.node.id) ? flat.depth : null;
		return true;
	});
	return (
		<ul className={`m-list m-0 list-none overflow-hidden rounded-m-lg p-0 ${className}`}>
			{visibleRows.map((f) => (
				<TreeRow
					key={f.node.id}
					flat={f}
					hasChildren={f.node.children.length > 0}
					collapsed={collapsed.has(f.node.id)}
					now={now}
					compact={compact}
					onOpen={onOpen}
					onToggle={toggle}
				/>
			))}
		</ul>
	);
}

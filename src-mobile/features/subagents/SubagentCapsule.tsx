import { Check, ChevronRight, Clock, Loader2, Users, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { nav, paths } from "../../core/nav";
import { AnchoredPopover } from "../../ui";
import { buildTree, countRows, flattenTree } from "./model";
import type { Counts } from "./model";
import { useCapsuleVisible } from "./settings";
import { SubagentTree } from "./SubagentTree";
import { useWatchSubagents } from "./store";
import { useNow } from "./useNow";

const PARTS: readonly { key: keyof Counts; label: string }[] = [
	{ key: "running", label: "运行" },
	{ key: "queued", label: "排队" },
	{ key: "done", label: "完成" },
	{ key: "failed", label: "失败" },
];

/** "2 运行 · 5 完成": only the non-zero states, in a fixed order. */
export function capsuleText(c: Counts): string {
	return PARTS.filter((p) => c[p.key] > 0)
		.map((p) => `${c[p.key]} ${p.label}`)
		.join(" · ");
}

/** Dot colour of the capsule: the most urgent state wins. */
function dotClass(c: Counts): string {
	if (c.running > 0) return "bg-m-accent m-pulse";
	if (c.failed > 0) return "bg-m-danger";
	if (c.queued > 0) return "bg-m-text-3";
	return "bg-m-success";
}

/**
 * Small inline pill 「● 2 运行 · 5 完成」 (docs/MOBILE_DESIGN.md §4.5). The thread places it in a
 * sticky row of its own; it never positions itself. Hidden when the session has no subagents or
 * the desktop `capsuleVisible` setting is off. Tap opens the compact popover; tap an agent
 * there for its full-screen detail page.
 */
export function SubagentCapsule({ sessionId }: { sessionId: string }) {
	const visible = useCapsuleVisible();
	const { rows } = useWatchSubagents(sessionId);
	const [sheetOpen, setSheetOpen] = useState(false);
	const capsuleRef = useRef<HTMLButtonElement>(null);

	const c = countRows(rows);
	const now = useNow(c.running + c.queued > 0);
	const flat = useMemo(() => flattenTree(buildTree(rows)), [rows]);

	if (!visible || rows.length === 0) return null;

	const text = capsuleText(c);
	const finished = c.done + c.failed;
	const open = (path: string) => {
		setSheetOpen(false);
		nav.push(path);
	};

	return (
		<>
			<button
				ref={capsuleRef}
				type="button"
				aria-label={`子代理：${text}`}
				aria-haspopup="dialog"
				aria-expanded={sheetOpen}
				onClick={() => setSheetOpen(true)}
				className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-m-pill bg-m-surface px-3 text-m-xs font-medium whitespace-nowrap text-m-text-2 active:bg-m-surface-2"
			>
				<span aria-hidden className={`size-2 shrink-0 rounded-m-pill ${dotClass(c)}`} />
				<span className="truncate">{text}</span>
			</button>

			<AnchoredPopover
				open={sheetOpen}
				onClose={() => setSheetOpen(false)}
				anchorEl={capsuleRef.current}
				placement="bottom-end"
				ariaLabel="子代理"
				maxWidth={356}
				minWidth={304}
				className="!p-0"
			>
				<div className="flex flex-col">
					{/* Desktop-inspired header with status badges & completion bar */}
					<div className="border-b border-m-border/65 px-3.5 pt-3 pb-2.5">
						<div className="flex items-center justify-between gap-2">
							<div className="flex items-baseline gap-1.5">
								<span className="text-[14px] font-semibold text-m-text">子代理</span>
								<span className="text-[11.5px] tabular-nums text-m-text-3">
									{finished}/{rows.length}
								</span>
							</div>
							<div className="flex flex-wrap items-center justify-end gap-1">
								{c.running > 0 && (
									<span className="inline-flex items-center gap-1 rounded-m-pill bg-m-accent-soft px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-m-accent-soft-text">
										<Loader2 size={10} className="animate-spin" aria-hidden />
										{c.running} 运行
									</span>
								)}
								{c.queued > 0 && (
									<span className="inline-flex items-center gap-1 rounded-m-pill bg-m-surface-2 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-m-text-2">
										<Clock size={10} aria-hidden />
										{c.queued} 排队
									</span>
								)}
								{c.done > 0 && (
									<span className="inline-flex items-center gap-1 rounded-m-pill bg-m-success-bg px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-m-success">
										<Check size={10} strokeWidth={2.5} aria-hidden />
										{c.done} 完成
									</span>
								)}
								{c.failed > 0 && (
									<span className="inline-flex items-center gap-1 rounded-m-pill bg-m-danger-bg px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-m-danger">
										<X size={10} strokeWidth={2.5} aria-hidden />
										{c.failed} 失败
									</span>
								)}
							</div>
						</div>
						<div className="mt-2 h-1 overflow-hidden rounded-m-pill bg-m-surface-2">
							<div
								className={`h-full rounded-m-pill transition-[width] duration-300 ease-m ${c.failed > 0 && c.running === 0 ? "bg-m-danger" : c.running > 0 ? "bg-m-accent" : "bg-m-success"}`}
								style={{ width: `${rows.length > 0 ? Math.round((finished / rows.length) * 100) : 0}%` }}
							/>
						</div>
					</div>

					<div className="max-h-[48dvh] overflow-y-auto overscroll-contain px-2 py-1.5">
						<SubagentTree
							key={sessionId}
							compact
							rows={flat}
							now={now}
							className="rounded-none bg-transparent"
							onOpen={(id) => open(paths.subagent(sessionId, id))}
						/>
					</div>

					<div className="border-t border-m-border/65 p-1.5">
						<button
							type="button"
							onClick={() => open(paths.subagents(sessionId))}
							className="m-press flex min-h-10 w-full items-center justify-between gap-2 rounded-m-md px-2.5 py-2 text-left text-[12.5px] font-medium text-m-text-2 active:bg-m-surface-hover"
						>
							<span className="flex items-center gap-2">
								<Users size={15} strokeWidth={1.85} className="text-m-text-3" aria-hidden />
								<span>查看全部子代理（{rows.length}）</span>
							</span>
							<ChevronRight size={15} strokeWidth={1.75} className="text-m-text-3" aria-hidden />
						</button>
					</div>
				</div>
			</AnchoredPopover>
		</>
	);
}

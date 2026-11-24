import { ArchiveRestore, Loader2 } from "lucide-react";
import { AnchoredPopover } from "../../../ui";
import type { ChatController, ComposerState } from "../chatStore";
import { contextTone, formatContextPercent, formatTokens, resolveContextPercent } from "../lib/context";
import { isDraftId } from "../lib/drafts";

const TONE_STROKE = {
	neutral: "stroke-m-accent",
	warn: "stroke-m-warn",
	danger: "stroke-m-danger",
} as const;

const TONE_DOT = {
	neutral: "bg-m-accent",
	warn: "bg-m-warn",
	danger: "bg-m-danger",
} as const;

const TONE_BAR = {
	neutral: "bg-m-accent",
	warn: "bg-m-warn",
	danger: "bg-m-danger",
} as const;

function UsageDonut({
	pct,
	tone,
}: {
	pct: number;
	tone: "neutral" | "warn" | "danger";
}) {
	const size = 96;
	const stroke = 10;
	const r = (size - stroke) / 2;
	const c = 2 * Math.PI * r;
	const fraction = Math.min(1, Math.max(0, pct / 100));
	const pctLabel = formatContextPercent(pct) ?? "0%";
	return (
		<div className="relative shrink-0" style={{ width: size, height: size }}>
			<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					strokeWidth={stroke}
					className="stroke-m-surface-2"
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					strokeWidth={stroke}
					strokeDasharray={`${fraction * c} ${c}`}
					strokeLinecap="round"
					className={`transition-[stroke-dasharray] duration-300 ease-m motion-reduce:transition-none ${TONE_STROKE[tone]}`}
				/>
			</svg>
			<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
				<span className="text-[17px] font-semibold leading-[20px] tabular-nums text-m-text">{pctLabel}</span>
				<span className="mt-0.5 whitespace-nowrap text-[11px] leading-[13px] text-m-text-3">已用</span>
			</div>
		</div>
	);
}

function LegendRow({
	name,
	tokens,
	pct,
	dotClass,
}: {
	name: string;
	tokens: number;
	pct: number;
	dotClass: string;
}) {
	return (
		<div className="flex w-full items-center gap-2 rounded-m-sm px-1 py-1 text-[12.5px] leading-[16px]">
			<span className={`size-2.5 shrink-0 rounded-[2px] ${dotClass}`} aria-hidden="true" />
			<span className="min-w-0 flex-1 whitespace-nowrap text-m-text">{name}</span>
			<span className="shrink-0 tabular-nums text-m-text-3">{formatTokens(tokens)}</span>
			<span className="w-[44px] shrink-0 text-right tabular-nums text-m-text">{pct.toFixed(1)}%</span>
		</div>
	);
}

/** Desktop-aligned context usage popover anchored to the composer context ring. */
export function ContextSheet({
	open,
	onClose,
	anchorEl,
	cstate,
	compacting,
	controller,
	sessionId,
	onCompact,
}: {
	open: boolean;
	onClose: () => void;
	anchorEl?: HTMLElement | null;
	cstate: ComposerState | null;
	compacting: boolean;
	controller?: ChatController;
	sessionId?: string;
	onCompact?: () => Promise<void> | void;
}) {
	const pct = cstate ? resolveContextPercent(cstate) : null;
	const tone = contextTone(pct);
	const rawTokens = typeof cstate?.contextTokens === "number" && Number.isFinite(cstate.contextTokens) ? cstate.contextTokens : null;
	const rawWindow =
		typeof cstate?.contextWindow === "number" && Number.isFinite(cstate.contextWindow) && cstate.contextWindow > 0
			? cstate.contextWindow
			: null;
	const knownFull = rawTokens !== null && rawWindow !== null;
	const freeTokens = knownFull ? Math.max(0, rawWindow - rawTokens) : 0;
	const usedPct = knownFull ? (rawTokens / rawWindow) * 100 : (pct ?? 0);
	const freePct = knownFull ? Math.max(0, 100 - usedPct) : 0;

	const targetId = controller?.id ?? sessionId ?? "";
	const draft = isDraftId(targetId);
	const handleCompact = () => {
		if (controller) return controller.compact();
		return onCompact?.();
	};
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="top-end"
			ariaLabel="上下文用量"
			maxWidth={360}
			minWidth={300}
			className="!p-0"
		>
			<div className="flex flex-col py-2.5 text-m-text">
				{/* Header: usage numbers + compact capsule button (aligned with desktop ContextRing) */}
				<div className="flex min-h-8 items-center gap-2 px-3.5 py-0.5">
					<span className="whitespace-nowrap text-[12px] leading-[15px] text-m-text-3">上下文窗口</span>
					{rawTokens !== null && (
						<span className="whitespace-nowrap text-[12px] leading-[15px] tabular-nums text-m-text-2">
							{formatTokens(rawTokens)} / {rawWindow !== null ? formatTokens(rawWindow) : "未知"}
						</span>
					)}
					<button
						type="button"
						disabled={compacting || draft}
						onClick={() => void handleCompact()}
						className="m-press ml-auto flex items-center gap-1 whitespace-nowrap rounded-m-pill border border-m-border px-2.5 py-1 text-[12px] font-medium leading-[15px] text-m-text-2 transition-colors active:bg-m-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
					>
						{compacting ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <ArchiveRestore size={12} aria-hidden />}
						<span>{compacting ? "正在压缩上下文" : "压缩上下文"}</span>
					</button>
				</div>

				{/* Body: Donut + Legend when window & tokens are known; thin progress bar fallback otherwise */}
				{knownFull ? (
					<div className="mt-2 flex items-center gap-4 px-3.5 pb-1">
						<UsageDonut pct={usedPct} tone={tone} />
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<LegendRow name="已使用" tokens={rawTokens} pct={usedPct} dotClass={TONE_DOT[tone]} />
							<LegendRow name="剩余空间" tokens={freeTokens} pct={freePct} dotClass="bg-m-surface-2" />
						</div>
					</div>
				) : (
					<div className="mt-2 px-3.5 pb-1">
						<div className="relative h-1.5 w-full overflow-hidden rounded-m-pill bg-m-surface-2">
							<div
								style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
								className={`h-full rounded-m-pill transition-[width] duration-300 ease-m ${TONE_BAR[tone]}`}
							/>
						</div>
						<div className="mt-2.5 space-y-1 text-[12px] leading-[15px] text-m-text-3">
							<div className="flex justify-between">
								<span>已用</span>
								<span className="font-m-mono tabular-nums text-m-text">
									{rawTokens !== null ? formatTokens(rawTokens) : (formatContextPercent(pct) ?? "暂无用量")}
								</span>
							</div>
							<div className="flex justify-between">
								<span>上下文窗口</span>
								<span className="font-m-mono tabular-nums text-m-text">
									{rawWindow !== null ? formatTokens(rawWindow) : "未知"}
								</span>
							</div>
						</div>
					</div>
				)}

				<p className="mt-2 border-t border-m-border/55 px-3.5 pt-2 text-[11.5px] leading-relaxed text-m-text-3">
					{compacting
						? "压缩可能需要几分钟，可以先关闭这里，完成后会提示。"
						: draft
							? "新会话还没有内容，发送第一条消息后才能压缩。"
							: "上下文越满，模型越容易忘记早先的内容。压缩会把较早的对话总结成摘要，腾出空间。"}
				</p>
			</div>
		</AnchoredPopover>
	);
}

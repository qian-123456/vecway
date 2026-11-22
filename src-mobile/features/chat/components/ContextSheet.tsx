import { AnchoredPopover, Button } from "../../../ui";
import type { ChatController, ComposerState } from "../chatStore";
import { contextTone, formatContextDetail, formatContextPercent, resolveContextPercent } from "../lib/context";
import { isDraftId } from "../lib/drafts";

const TONE_BAR = { neutral: "bg-m-accent", warn: "bg-m-warn", danger: "bg-m-danger" } as const;

/** Compact popover anchored to the composer context ring: usage bar and 压缩上下文. */
export function ContextSheet({
	open,
	onClose,
	anchorEl,
	cstate,
	compacting,
	controller,
}: {
	open: boolean;
	onClose: () => void;
	anchorEl?: HTMLElement | null;
	cstate: ComposerState | null;
	compacting: boolean;
	controller: ChatController;
}) {
	const pct = cstate ? resolveContextPercent(cstate) : null;
	const detail = cstate ? formatContextDetail(cstate) : null;
	const draft = isDraftId(controller.id);
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="top-end"
			title="上下文用量"
			maxWidth={300}
			minWidth={240}
		>
			<div className="flex flex-col gap-3 p-3.5">
				<div className="rounded-m-md bg-m-surface p-3">
					<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
						<span className="text-m-lg font-semibold whitespace-nowrap text-m-text">
							{formatContextPercent(pct) ?? "未知"}
						</span>
						<span className="text-m-xs break-words text-m-text-3">
							{detail ?? "会话还没有运行，暂无用量"}
						</span>
					</div>
					<div className="mt-2.5 h-1.5 overflow-hidden rounded-m-pill bg-m-surface-2">
						<div
							className={`h-full rounded-m-pill transition-[width] duration-(--m-dur) ease-m ${TONE_BAR[contextTone(pct)]}`}
							style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
						/>
					</div>
				</div>
				<p className="text-m-xs leading-relaxed text-m-text-2">
					上下文越满，模型越容易忘记早先的内容。压缩会把较早的对话总结成摘要，腾出空间。
				</p>
				<Button variant="accent" size="sm" block busy={compacting} disabled={draft} onClick={() => void controller.compact()}>
					{compacting ? "正在压缩上下文" : "压缩上下文"}
				</Button>
				{compacting && <p className="text-m-xs text-m-text-3">压缩可能需要几分钟，可以先关闭这里，完成后会提示。</p>}
				{draft && <p className="text-m-xs text-m-text-3">新会话还没有内容，发送第一条消息后才能压缩。</p>}
			</div>
		</AnchoredPopover>
	);
}

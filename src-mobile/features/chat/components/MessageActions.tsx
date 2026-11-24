import { ChevronLeft, ChevronRight, Copy, GitBranch, Pencil, Quote, RotateCcw } from "lucide-react";
import { copyText } from "../../../core/lib/format";
import { AnchoredPopover, MenuRow, toast, type AnchorBox } from "../../../ui";
import type { MessageTarget } from "../ChatContext";
import type { ChatController } from "../chatStore";

const ICON = { size: 22, strokeWidth: 1.75 } as const;

/** Long-press / 「更多操作」 sheet of one message (ChatGPT-style flat menu). */
export function MessageActionsSheet({
	target,
	onClose,
	controller,
	anchorEl,
	anchorRect,
}: {
	target: MessageTarget | null;
	onClose: () => void;
	controller: ChatController;
	anchorEl?: HTMLElement | null;
	anchorRect?: AnchorBox | null;
}) {
	const t = target;
	// Version group of this entry, computed while the sheet is open.
	const versions = t?.entryId ? controller.versionsFor(t.entryId) : null;
	const done = (fn: () => void) => () => {
		onClose();
		fn();
	};
	return (
		<AnchoredPopover
			open={t !== null}
			onClose={onClose}
			anchorEl={anchorEl}
			anchorRect={anchorRect}
			placement="bottom-center"
			title="消息操作"
			maxWidth={320}
			minWidth={220}
		>
			{t && (
				<div className="pb-2">
					{t.text.trim() ? (
						<MenuRow
							icon={<Copy {...ICON} />}
							label="复制文字"
							hint={t.hasImages ? "仅复制文本内容；图片请点击缩略图预览或保存" : undefined}
							onClick={done(() => {
								void copyText(t.text).then((ok) => toast(ok ? "已复制文字" : "复制失败", { kind: ok ? "success" : "error" }));
							})}
						/>
					) : t.hasImages ? (
						<MenuRow
							icon={<Copy {...ICON} />}
							label="复制文字（无文本）"
							hint="此消息仅含图片附件，请点击图片缩略图查看"
							disabled
							onClick={() => {}}
						/>
					) : null}
					<MenuRow icon={<Quote {...ICON} />} label="引用回复" hint="保留草稿，插入引用" onClick={done(() => controller.stageAnnotation(t.text))} />
					{t.role === "user" && (
						<MenuRow
							icon={<Pencil {...ICON} />}
							label="编辑并重发"
							hint="从这里重来，原对话保留为另一版本"
							onClick={done(() => {
								if (t.entryId) void controller.editResendFromTree(t.entryId, t.text);
								else controller.editResend(t.text);
							})}
						/>
					)}
					{t.role === "assistant" && t.canRetry && (
						<MenuRow icon={<RotateCcw {...ICON} />} label="重新生成" hint="重试上一次回合" onClick={done(() => controller.retry())} />
					)}
					{versions && versions.total > 1 && (
						<>
							<MenuRow
								icon={<ChevronLeft {...ICON} />}
								label={`切换到上一版本（${versions.index + 1}/${versions.total}）`}
								hint="同一会话内切换，原对话都保留"
								onClick={done(() => {
									const prev = versions.ids[(versions.index - 1 + versions.total) % versions.total];
									void controller.switchTreeVersion(prev);
								})}
							/>
							<MenuRow
								icon={<ChevronRight {...ICON} />}
								label="切换到下一版本"
								hint="同一会话内切换，原对话都保留"
								onClick={done(() => {
									const next = versions.ids[(versions.index + 1) % versions.total];
									void controller.switchTreeVersion(next);
								})}
							/>
						</>
					)}
					{t.role === "assistant" && t.entryId && (
						<MenuRow
							icon={<GitBranch {...ICON} />}
							label="从这里分支"
							hint="复制到这条回复为止的对话，开新会话继续"
							onClick={done(() => controller.forkFrom(t.entryId as string, t.text.slice(0, 40)))}
						/>
					)}
				</div>
			)}
		</AnchoredPopover>
	);
}

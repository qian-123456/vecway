import { Bot } from "lucide-react";
import { AnchoredPopover } from "../../../ui";

/** Desktop-managed until the mobile API exposes the real configuration. */
export function SubagentsSheet({ open, onClose, anchorEl }: { open: boolean; onClose: () => void; anchorEl?: HTMLElement | null }) {
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="bottom-end"
			title="子代理管理"
			subtitle="子代理定义由电脑端统一管理。"
			maxWidth={340}
			minWidth={240}
		>
			<div className="space-y-2.5 px-4 py-3 text-m-sm text-m-text">
				<div className="flex items-start gap-2.5">
					<Bot size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-m-text-2" aria-hidden />
					<div>
						<div className="font-medium">由电脑管理</div>
						<p className="mt-0.5 text-m-xs leading-relaxed text-m-text-2">
							手机端尚无子代理定义读取接口，无法展示当前配置。请在电脑端的子代理设置中查看和编辑。
						</p>
					</div>
				</div>
				<p className="text-m-xs leading-relaxed text-m-text-3">
					会话中的子代理面板展示任务运行记录，不是子代理定义列表。
				</p>
			</div>
		</AnchoredPopover>
	);
}

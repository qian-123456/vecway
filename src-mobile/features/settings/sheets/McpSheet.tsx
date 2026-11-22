import { Server } from "lucide-react";
import { AnchoredPopover } from "../../../ui";

/** Desktop-managed until the mobile API exposes the real configuration. */
export function McpSheet({ open, onClose, anchorEl }: { open: boolean; onClose: () => void; anchorEl?: HTMLElement | null }) {
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="bottom-end"
			title="MCP 服务器"
			subtitle="外部工具和数据连接由电脑端统一管理。"
			maxWidth={340}
			minWidth={240}
		>
			<div className="flex items-start gap-2.5 px-4 py-3 text-m-sm text-m-text">
				<Server size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-m-text-2" aria-hidden />
				<div>
					<div className="font-medium">由电脑管理</div>
					<p className="mt-0.5 text-m-xs leading-relaxed text-m-text-2">
						手机端尚无 MCP 配置读取接口，无法展示当前服务器。请在电脑端的 MCP 设置中查看、添加或修改服务器。
					</p>
				</div>
			</div>
		</AnchoredPopover>
	);
}

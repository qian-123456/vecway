import { Globe } from "lucide-react";
import { AnchoredPopover } from "../../../ui";

export function WebSheet({ open, onClose, anchorEl }: { open: boolean; onClose: () => void; anchorEl?: HTMLElement | null }) {
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="bottom-end"
			title="联网搜索"
			maxWidth={340}
			minWidth={240}
		>
			<div className="space-y-2.5 px-4 py-3 text-m-sm text-m-text">
				<div className="flex items-start gap-2.5">
					<Globe size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-m-text-2" aria-hidden />
					<p className="text-m-xs leading-relaxed text-m-text-2">
						智能体用 web_search 搜索网页、用 fetch 读取网页内容，支持 SearXNG、Perplexity、Tavily 等服务商。
					</p>
				</div>
				<p className="text-m-xs leading-relaxed text-m-text-3">
					搜索服务商、接口地址和密钥只能在电脑上的「设置 ▸ 联网搜索」里修改，改完后手机上的会话直接使用。
				</p>
			</div>
		</AnchoredPopover>
	);
}

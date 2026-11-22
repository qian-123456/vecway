import { ShieldCheck } from "lucide-react";
import { AnchoredPopover } from "../../../ui";

export function PrivacySheet({ open, onClose, anchorEl }: { open: boolean; onClose: () => void; anchorEl?: HTMLElement | null }) {
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="bottom-end"
			title="隐私设置"
			maxWidth={340}
			minWidth={240}
		>
			<div className="space-y-2.5 px-4 py-3 text-m-sm text-m-text">
				<div className="flex items-start gap-2.5">
					<ShieldCheck size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-m-text-2" aria-hidden />
					<div>
						<div className="font-medium">隐私库</div>
						<p className="mt-0.5 text-m-xs leading-relaxed text-m-text-2">
							登记过的密钥、密码等内容，在发给模型前会换成占位符。
						</p>
					</div>
				</div>
				<p className="text-m-xs leading-relaxed text-m-text-3">
					隐私库的内容是敏感信息，只能在电脑上的「设置 ▸ 隐私」里查看、添加和删除。
				</p>
			</div>
		</AnchoredPopover>
	);
}

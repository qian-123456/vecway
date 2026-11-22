import { FileText } from "lucide-react";
import { AnchoredPopover } from "../../../ui";

/** Desktop-managed until the mobile API exposes the real configuration. */
export function RulesFilesSheet({ open, onClose, anchorEl }: { open: boolean; onClose: () => void; anchorEl?: HTMLElement | null }) {
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="bottom-end"
			title="规则文件"
			subtitle="全局和项目规则文件由电脑端管理。"
			maxWidth={340}
			minWidth={240}
		>
			<div className="flex items-start gap-2.5 px-4 py-3 text-m-sm text-m-text">
				<FileText size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-m-text-2" aria-hidden />
				<div>
					<div className="font-medium">由电脑管理</div>
					<p className="mt-0.5 text-m-xs leading-relaxed text-m-text-2">
						手机端尚无规则配置读取接口，无法确认当前生效的文件和内容。请在电脑端的规则文件设置中查看和编辑。
					</p>
				</div>
			</div>
		</AnchoredPopover>
	);
}

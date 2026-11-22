import { Inbox } from "lucide-react";
import { nav, paths } from "../../../core/nav";
import { AnchoredPopover, MenuRow } from "../../../ui";

export function InboxSheet({ open, onClose, anchorEl }: { open: boolean; onClose: () => void; anchorEl?: HTMLElement | null }) {
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="bottom-end"
			title="收件箱"
			subtitle="整理规则在电脑上设置"
			maxWidth={320}
			minWidth={220}
		>
			<div className="py-1.5">
				<MenuRow
					icon={<Inbox size={20} strokeWidth={1.75} />}
					label="打开收件箱"
					hint="查看审批、提问、完成的回答和出错的会话"
					onClick={() => {
						onClose();
						nav.push(paths.inbox());
					}}
				/>
			</div>
		</AnchoredPopover>
	);
}

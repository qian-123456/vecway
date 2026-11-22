import { AnchoredPopover, AppMark } from "../../../ui";

export function AboutSheet({ open, onClose, appVersion, anchorEl }: { open: boolean; onClose: () => void; appVersion?: string | null; anchorEl?: HTMLElement | null }) {
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="bottom-end"
			title="版本与更新"
			maxWidth={320}
			minWidth={240}
		>
			<div className="space-y-3 px-4 py-3">
				<div className="flex items-center gap-3">
					<AppMark size={36} />
					<div className="min-w-0">
						<div className="text-m-md font-medium text-m-text">Vecway</div>
						<div className="text-m-xs text-m-text-3">连接到电脑端 OMP 桌面工作台</div>
					</div>
				</div>
				<div className="flex items-center justify-between rounded-m-md bg-m-surface px-3 py-2 text-m-xs">
					<span className="text-m-text-2">电脑端版本</span>
					<span className="m-selectable font-m-mono text-m-text">{appVersion || "未知"}</span>
				</div>
				<p className="text-m-xs leading-relaxed text-m-text-3">
					版本升级在电脑上进行，手机端只展示当前版本。电脑端更新后，刷新本页面即可用上新版本。
				</p>
			</div>
		</AnchoredPopover>
	);
}

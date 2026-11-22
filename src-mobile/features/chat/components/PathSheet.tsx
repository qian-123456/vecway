import { Copy, FolderInput, FolderOpen } from "lucide-react";
import { nav, paths } from "../../../core/nav";
import { AnchoredPopover, MenuRow, toast } from "../../../ui";

/** Sheet behind the folder of the status row: full path, copy, browse, switch project. */
export function PathSheet({
	open,
	onClose,
	cwd,
	sessionId,
	onSwitchProject,
	anchorEl,
}: {
	open: boolean;
	onClose: () => void;
	cwd?: string | null;
	sessionId: string;
	onSwitchProject?: () => void;
	anchorEl?: HTMLElement | null;
}) {
	const copyPath = async () => {
		if (!cwd) return;
		try {
			await navigator.clipboard.writeText(cwd);
			toast("路径已复制", { kind: "success" });
		} catch {
			toast("复制失败", { kind: "error" });
		}
	};

	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement="bottom-start"
			title="当前工作目录"
			maxWidth={340}
			minWidth={260}
		>
			<div className="px-3.5 pt-3 pb-1">
				<div className="m-selectable rounded-m-md bg-m-surface px-3.5 py-2.5 font-m-mono text-m-xs break-all text-m-text">
					{cwd || "未设置工作目录"}
				</div>
			</div>
			<div className="py-1.5">
				<MenuRow icon={<Copy size={20} strokeWidth={1.75} />} label="复制路径" disabled={!cwd} onClick={() => void copyPath()} />
				<MenuRow
					icon={<FolderOpen size={20} strokeWidth={1.75} />}
					label="浏览文件"
					onClick={() => {
						onClose();
						nav.push(paths.files(sessionId));
					}}
				/>
				{onSwitchProject && (
					<MenuRow
						icon={<FolderInput size={20} strokeWidth={1.75} />}
						label="切换项目目录"
						hint="让这个会话改在另一个目录里工作"
						onClick={() => {
							onClose();
							onSwitchProject();
						}}
					/>
				)}
			</div>
		</AnchoredPopover>
	);
}

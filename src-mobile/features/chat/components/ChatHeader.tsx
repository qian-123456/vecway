import { Menu, MoreHorizontal, SquarePen } from "lucide-react";
import { IconButton, TopBar } from "../../../ui";
import { shortModel, thinkLabel } from "../lib/models";

/**
 * Shared home/chat top chrome:
 * - Left & right: liquid glass style buttons
 * - Center: Session Name (primary) + File Path (secondary, smaller/dimmer below)
 */
export function ChatHeader({
	title,
	subtitle,
	onTitleClick,
	ariaLabel,
	onMenu,
	onNew,
	onTools,
	model,
	thinking,
	onModel,
}: {
	title?: string;
	subtitle?: string | null;
	onTitleClick?: () => void;
	ariaLabel?: string;
	onMenu: () => void;
	onNew: () => void;
	onTools?: () => void;
	model?: string | null;
	thinking?: string | null;
	onModel?: () => void;
}) {
	const displayTitle = title ?? (model ? shortModel(model) : "新对话");
	const displaySubtitle = subtitle ?? (title ? null : thinkLabel(thinking));

	return (
		<TopBar
			left={<IconButton variant="glass" size="sm" icon={<Menu size={20} strokeWidth={1.85} />} label="菜单" onClick={onMenu} />}
			center={
				<button
					type="button"
					aria-label={ariaLabel ?? (displaySubtitle ? `${displayTitle}，${displaySubtitle}` : displayTitle)}
					onClick={onTitleClick ?? onModel}
					disabled={!onTitleClick && !onModel}
					className="flex min-w-0 max-w-full flex-col items-center justify-center rounded-m-md px-2.5 py-1 text-center transition-opacity duration-(--m-dur-fast) active:opacity-70 disabled:cursor-default"
				>
					<span className="min-w-0 max-w-full truncate text-m-sm font-semibold tracking-[-0.01em] whitespace-nowrap text-m-text">
						{displayTitle}
					</span>
					{displaySubtitle ? (
						<span className="min-w-0 max-w-full truncate text-[11px] leading-tight whitespace-nowrap text-m-text-3">
							{displaySubtitle}
						</span>
					) : null}
				</button>
			}
			right={
				<>
					<IconButton variant="glass" size="sm" icon={<SquarePen size={18} strokeWidth={1.85} />} label="新建对话" onClick={onNew} />
					{onTools && <IconButton variant="glass" size="sm" icon={<MoreHorizontal size={20} strokeWidth={1.85} />} label="工具菜单" onClick={onTools} />}
				</>
			}
		/>
	);
}

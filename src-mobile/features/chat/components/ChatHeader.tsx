import { ChevronDown, Menu, MoreHorizontal, SquarePen } from "lucide-react";
import { IconButton, TopBar } from "../../../ui";
import { shortModel, thinkLabel } from "../lib/models";

/**
 * Shared home/chat top chrome:
 * - Left & right: calm flat 44px touch buttons
 * - Center: tappable 44px-tall title + optional subtitle with subtle disclosure affordance
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
	onNew?: () => void;
	onTools?: () => void;
	model?: string | null;
	thinking?: string | null;
	onModel?: () => void;
}) {
	const displayTitle = title ?? (model ? shortModel(model) : "新对话");
	const displaySubtitle = subtitle ?? (title ? null : thinkLabel(thinking));
	const clickable = Boolean(onTitleClick || onModel);

	return (
		<TopBar
			left={<IconButton variant="plain" size="md" icon={<Menu size={21} strokeWidth={1.85} />} label="菜单" onClick={onMenu} />}
			center={
				<button
					type="button"
					aria-label={ariaLabel ?? (displaySubtitle ? `${displayTitle}，${displaySubtitle}` : displayTitle)}
					onClick={onTitleClick ?? onModel}
					disabled={!clickable}
					className="flex min-h-11 min-w-0 max-w-full flex-col items-center justify-center rounded-m-md px-2.5 py-1 text-center transition-colors duration-(--m-dur-fast) active:bg-m-surface-hover disabled:cursor-default disabled:active:bg-transparent"
				>
					<span className="flex max-w-full items-center gap-1">
						<span className="min-w-0 truncate text-m-sm font-semibold tracking-[-0.01em] whitespace-nowrap text-m-text">
							{displayTitle}
						</span>
						{clickable && <ChevronDown size={13} strokeWidth={2} className="shrink-0 text-m-text-3" aria-hidden />}
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
					{onNew && <IconButton variant="plain" size="md" icon={<SquarePen size={19} strokeWidth={1.85} />} label="新建对话" onClick={onNew} />}
					{onTools && <IconButton variant="plain" size="md" icon={<MoreHorizontal size={21} strokeWidth={1.85} />} label="工具菜单" onClick={onTools} />}
				</>
			}
		/>
	);
}

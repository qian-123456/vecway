import { ChevronDown, Menu, PanelRight, SquarePen } from "lucide-react";
import type { Ref } from "react";
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
	titleButtonRef,
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
	titleButtonRef?: Ref<HTMLButtonElement>;
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
					ref={titleButtonRef}
					type="button"
					aria-label={ariaLabel ?? (displaySubtitle ? `${displayTitle}，${displaySubtitle}` : displayTitle)}
					onClick={onTitleClick ?? onModel}
					disabled={!clickable}
					className="m-press flex min-h-11 min-w-0 max-w-full flex-col items-start justify-center rounded-m-md px-2 py-1 text-left active:bg-m-surface-hover disabled:cursor-default disabled:active:bg-transparent"
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
					{onTools && <IconButton variant="plain" size="md" icon={<PanelRight size={20} strokeWidth={1.85} />} label="工作区" onClick={onTools} />}
				</>
			}
		/>
	);
}

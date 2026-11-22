import { ChevronDown, Menu, PanelRight, SquarePen } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { TopBar } from "../../../ui";
import { shortModel, thinkLabel } from "../lib/models";

function OrbButton({
	icon,
	label,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full"
		>
			<span className="m-liquid-orb flex h-9 w-9 items-center justify-center rounded-full text-m-text">
				{icon}
			</span>
		</button>
	);
}

/**
 * Shared home/chat top chrome:
 * - Left & right: iOS 26 Liquid Glass circular 44px touch-target orb buttons
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
			className="border-b border-m-topbar-border/60 ps-(--m-safe-left) pe-(--m-safe-right) backdrop-blur-xl"
			left={<OrbButton icon={<Menu size={19} strokeWidth={1.85} />} label="菜单" onClick={onMenu} />}
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
						<span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.015em] whitespace-nowrap text-m-text">
							{displayTitle}
						</span>
						{clickable && <ChevronDown size={13} strokeWidth={2} className="shrink-0 text-m-text-quiet" aria-hidden />}
					</span>
					{displaySubtitle ? (
						<span className="min-w-0 max-w-full truncate text-[11px] leading-tight whitespace-nowrap text-m-text-quiet">
							{displaySubtitle}
						</span>
					) : null}
				</button>
			}
			right={
				<>
					{onNew && <OrbButton icon={<SquarePen size={17} strokeWidth={1.85} />} label="新建对话" onClick={onNew} />}
					{onTools && <OrbButton icon={<PanelRight size={18} strokeWidth={1.85} />} label="工作区" onClick={onTools} />}
				</>
			}
		/>
	);
}

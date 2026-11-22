import type { ReactNode } from "react";

/** Large square-ish tile of the actions sheet's top row (ChatGPT attachments sheet). */
export function ActionTile({
	icon,
	label,
	onClick,
	disabled,
}: {
	icon: ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="m-press flex h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-m-lg bg-m-card px-1 text-m-xs whitespace-nowrap text-m-text shadow-m-card active:bg-m-surface-2 disabled:opacity-40"
		>
			<span className="text-m-text-2">{icon}</span>
			{label}
		</button>
	);
}

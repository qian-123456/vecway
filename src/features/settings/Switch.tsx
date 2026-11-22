/** [D] Apple HIG toggle switch — h-5 w-9, white knob, theme-adaptive --accent on-track, spring transition. */

export function Switch({
	checked,
	onChange,
	disabled = false,
	title,
	ariaLabel,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	title?: string;
	ariaLabel?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			title={title}
			disabled={disabled}
			onClick={(e) => {
				// Contained in clickable rows; never double-toggle the row.
				e.stopPropagation();
				onChange(!checked);
			}}
			className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full shadow-[inset_0_0.5px_1.5px_rgba(0,0,0,0.22)] transition-[background-color] duration-200 ease-[var(--ease-out)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)] ${
				checked ? "bg-[var(--accent)]" : "bg-[var(--switch-off,#39393D)]"
			} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
		>
			<span
				className={`apple-switch-knob inline-block h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3),0_0_1px_rgba(0,0,0,0.2)] ${
					checked ? "[transform:translateX(18px)]" : "[transform:translateX(2px)]"
				}`}
			/>
		</button>
	);
}

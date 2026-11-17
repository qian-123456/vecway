import clsx from "clsx";
import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FloatingLayer } from "./FloatingLayer";

export interface InfoTipProps {
	/** Tooltip body text shown on hover, focus, or click. */
	text: string;
	/** Accessible button label (defaults to `text`). */
	label?: string;
	className?: string;
}

/**
 * Compact info-circle icon that reveals a non-truncating explanation card in a
 * `FloatingLayer` (above modals/popovers per docs/LAYERS.md).
 */
export function InfoTip({ text, label, className }: InfoTipProps) {
	const btnRef = useRef<HTMLButtonElement>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [hovered, setHovered] = useState(false);
	const [pinned, setPinned] = useState(false);
	const [focused, setFocused] = useState(false);

	const clearTimer = () => {
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};

	useEffect(() => clearTimer, []);

	const open = hovered || pinned || focused;

	const scheduleClose = () => {
		clearTimer();
		closeTimerRef.current = setTimeout(() => setHovered(false), 120);
	};

	return (
		<>
			<button
				ref={btnRef}
				type="button"
				aria-label={label ?? text}
				aria-expanded={open}
				onMouseEnter={() => {
					clearTimer();
					setHovered(true);
				}}
				onMouseLeave={scheduleClose}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				onClick={() => setPinned((prev) => !prev)}
				className={clsx(
					"inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-[var(--bg-hover)] hover:text-neutral-200 focus:text-neutral-200 focus:outline-none",
					pinned && "bg-[var(--bg-hover)] text-neutral-200",
					className,
				)}
			>
				<Info className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
			{open && (
				<FloatingLayer
					anchor={btnRef.current}
					placement="top-start"
					offset={6}
					layer="popover"
					onDismiss={() => {
						setPinned(false);
						setHovered(false);
						setFocused(false);
					}}
					ignoreRefs={[btnRef]}
					onMouseEnter={clearTimer}
					onMouseLeave={scheduleClose}
					role="tooltip"
					className="max-w-[290px] whitespace-normal break-words rounded-lg border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2.5 py-2 text-[11px] leading-relaxed text-neutral-200 shadow-lg"
				>
					{text}
				</FloatingLayer>
			)}
		</>
	);
}

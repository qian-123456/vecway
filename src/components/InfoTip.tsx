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

const WARM_WINDOW_MS = 400;
const OPEN_DELAY_MS = 240;
let activeCount = 0;
let lastClosedAt = 0;

/**
 * Compact info-circle icon that reveals a non-truncating explanation card in a
 * `FloatingLayer` (above modals/popovers per docs/LAYERS.md).
 */
export function InfoTip({ text, label, className }: InfoTipProps) {
	const btnRef = useRef<HTMLButtonElement>(null);
	const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [hovered, setHovered] = useState(false);
	const [pinned, setPinned] = useState(false);
	const [focused, setFocused] = useState(false);
	const [isInstant, setIsInstant] = useState(false);

	const clearTimers = () => {
		if (openTimerRef.current !== null) {
			clearTimeout(openTimerRef.current);
			openTimerRef.current = null;
		}
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};

	useEffect(() => clearTimers, []);

	const open = hovered || pinned || focused;

	useEffect(() => {
		if (!open) return;
		activeCount += 1;
		return () => {
			activeCount = Math.max(0, activeCount - 1);
			lastClosedAt = Date.now();
		};
	}, [open]);

	const scheduleClose = () => {
		clearTimers();
		closeTimerRef.current = setTimeout(() => setHovered(false), 120);
	};

	const handleMouseEnter = () => {
		clearTimers();
		if (open) {
			setHovered(true);
			return;
		}
		const warm = activeCount > 0 || Date.now() - lastClosedAt < WARM_WINDOW_MS;
		if (warm) {
			setIsInstant(true);
			setHovered(true);
			return;
		}
		openTimerRef.current = setTimeout(() => {
			openTimerRef.current = null;
			setIsInstant(false);
			setHovered(true);
		}, OPEN_DELAY_MS);
	};

	return (
		<>
			<button
				ref={btnRef}
				type="button"
				aria-label={label ?? text}
				aria-expanded={open}
				onMouseEnter={handleMouseEnter}
				onMouseLeave={scheduleClose}
				onFocus={() => {
					clearTimers();
					if (!open) setIsInstant(false);
					setFocused(true);
				}}
				onBlur={() => setFocused(false)}
				onClick={() => {
					clearTimers();
					if (!open) setIsInstant(false);
					setPinned((prev) => !prev);
				}}
				className={clsx(
					"inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--text-40)] transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus:text-[var(--text)] focus:outline-none active:scale-[0.95]",
					pinned && "bg-[var(--bg-hover)] text-[var(--text)]",
					className,
				)}
			>
				<Info className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
			{(open || btnRef.current) && (
				<FloatingLayer
					open={open}
					anchor={btnRef.current}
					placement="top-start"
					offset={6}
					layer="popover"
					surfaceMotion="tooltip"
					instant={isInstant}
					onDismiss={() => {
						clearTimers();
						setPinned(false);
						setHovered(false);
						setFocused(false);
					}}
					ignoreRefs={[btnRef]}
					onMouseEnter={clearTimers}
					onMouseLeave={scheduleClose}
					role="tooltip"
					className="max-w-[290px] whitespace-pre-line break-words rounded-lg hairline vibrancy-popover px-2.5 py-2 text-[11px] leading-relaxed text-[var(--text)] shadow-apple-modal"
				>
					{text}
				</FloatingLayer>
			)}
		</>
	);
}

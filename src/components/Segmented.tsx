import clsx from "clsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface SegmentedOption<T extends string> {
	value: T;
	label: ReactNode;
	/** Tooltip; also explains why a disabled option is unavailable. */
	title?: string;
	disabled?: boolean;
}

interface SegmentedProps<T extends string> {
	options: SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	/** Disables every option (e.g. while a save is in flight). */
	disabled?: boolean;
	/** `sm` = compact 11px (settings rows), `md` = 12px (page toolbars). */
	size?: "sm" | "md";
	"aria-label"?: string;
	/** Fully rounded track and thumb. */
	pill?: boolean;
}

/** Generic pill segmented control (macOS style). */
export function Segmented<T extends string>({
	options,
	value,
	onChange,
	disabled,
	size = "md",
	"aria-label": ariaLabel,
	pill = false,
}: SegmentedProps<T>) {
	const groupRef = useRef<HTMLDivElement>(null);
	const btnRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
	const [thumb, setThumb] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
	const [ready, setReady] = useState(false);

	const measure = useCallback(() => {
		const btn = btnRefs.current.get(value);
		if (!btn || btn.offsetWidth === 0) {
			setThumb((prev) => (prev.left === 0 && prev.width === 0 ? prev : { left: 0, width: 0 }));
			return;
		}
		const left = btn.offsetLeft;
		const width = btn.offsetWidth;
		setThumb((prev) => (prev.left === left && prev.width === width ? prev : { left, width }));
	}, [value]);

	useLayoutEffect(() => {
		measure();
	}, [measure, options, size, pill]);

	useEffect(() => {
		if (thumb.width === 0 || ready) return;
		const raf = requestAnimationFrame(() => setReady(true));
		return () => cancelAnimationFrame(raf);
	}, [thumb.width, ready]);

	useEffect(() => {
		const group = groupRef.current;
		if (!group || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measure);
		ro.observe(group);
		return () => ro.disconnect();
	}, [measure]);

	const showSlidingThumb = thumb.width > 0;

	return (
		<div
			ref={groupRef}
			role="radiogroup"
			aria-label={ariaLabel}
			className={clsx(
				"relative isolate inline-flex items-center gap-0.5 bg-[var(--well-bg)] p-0.5 hairline",
				pill ? "rounded-full" : "rounded-lg",
			)}
		>
			{showSlidingThumb && (
				<span
					aria-hidden="true"
					data-ready={ready ? "true" : "false"}
					className={clsx(
						"apple-seg-thumb pointer-events-none absolute top-0.5 bottom-0.5 left-0 bg-[var(--seg-thumb-bg)] shadow-[var(--seg-thumb-shadow)]",
						pill ? "rounded-full" : "rounded-md",
					)}
					style={{ width: thumb.width, transform: `translate3d(${thumb.left}px, 0, 0)` }}
				/>
			)}
			{options.map((o) => {
				const active = value === o.value;
				return (
					<button
						key={o.value}
						ref={(el) => {
							if (el) btnRefs.current.set(o.value, el);
							else btnRefs.current.delete(o.value);
						}}
						type="button"
						role="radio"
						aria-checked={active}
						disabled={disabled || o.disabled}
						title={o.title}
						onClick={() => onChange(o.value)}
						className={clsx(
							"press-scale relative z-10 whitespace-nowrap px-2.5 py-1 transition-[background-color,color,opacity] duration-150 ease-[var(--ease-out)] disabled:cursor-not-allowed disabled:opacity-50",
							pill ? "rounded-full" : "rounded-md",
							size === "sm" ? "text-[11px]" : "text-xs font-medium",
							active
								? showSlidingThumb
									? "text-[var(--text)]"
									: "bg-[var(--seg-thumb-bg)] text-[var(--text)] shadow-[var(--seg-thumb-shadow)]"
								: "text-[var(--text-muted)] hover:text-[var(--text)]",
						)}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}

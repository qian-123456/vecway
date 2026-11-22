import clsx from "clsx";
import { Search, X } from "lucide-react";
import {
	forwardRef,
	useEffect,
	useRef,
	useState,
	type FocusEvent,
	type KeyboardEvent,
	type RefObject,
} from "react";
import { claimEscape } from "../lib/escapeClaim";
import { isComposing } from "../lib/hooks";
import { useT } from "../stores/language";
export interface SearchInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	/** Accessible name of the input; defaults to `placeholder`. */
	ariaLabel?: string;
	/** Optional tooltip for the input (useful when a compact placeholder is shortened). */
	title?: string;
	autoFocus?: boolean;
	/** Classes for the wrapper (width, flex sizing). */
	className?: string;
	/** Classes for the `<input>`; default matches the common hairline well input. */
	inputClassName?: string;
	/** Called when the clear button or Escape clears a non-empty value (after `onChange("")`). */
	onClear?: () => void;
	/** Show the trailing clear/dismiss button even when `value` is empty. */
	showClearWhenEmpty?: boolean;
	onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
	/** Search icon size in px. Default 14. */
	iconSize?: number;
	/** Keyboard shortcut hint displayed GitHub-style inside empty unfocused inputs (e.g. "/"). */
	shortcutHint?: string;
	onFocus?: (e: FocusEvent<HTMLInputElement>) => void;
	onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
}

const DEFAULT_INPUT_BASE_CLASS =
	"w-full rounded-lg hairline bg-[var(--bg-panel)] py-1.5 pl-8 text-xs text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

/** Inline GitHub-style keycap hint (`按 [/] 搜索` / `Type [/] to search`) rendered inside an empty unfocused field. */
export function SearchShortcutHint({
	shortcut = "/",
	className,
	textClassName = "text-xs",
}: {
	shortcut?: string;
	className?: string;
	textClassName?: string;
}) {
	const { t } = useT();
	return (
		<span
			aria-hidden="true"
			className={clsx(
				"pointer-events-none flex select-none items-center overflow-hidden whitespace-nowrap text-[var(--text-dim)]",
				textClassName,
				className,
			)}
		>
			<span className="truncate">
				{t("components.searchShortcutPrefix")}
				<kbd className="mx-1 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-[4px] border border-[var(--hairline-strong,var(--border-divider))] bg-[var(--well-bg,var(--bg))] px-1 font-mono text-[10.5px] font-medium leading-none text-[var(--text-60)]">
					{shortcut}
				</kbd>
				{t("components.searchShortcutSuffix")}
			</span>
		</span>
	);
}
/**
 * Search field: leading magnifier, trailing clear button while non-empty, and
 * Escape clears a non-empty value (claiming the key so enclosing dialogs stay open).
 * Empty + Escape is left alone so it still closes the surrounding popover/dialog.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
	{
		value,
		onChange,
		placeholder,
		ariaLabel,
		title,
		autoFocus,
		className,
		inputClassName,
		onClear,
		showClearWhenEmpty,
		onKeyDown,
		iconSize = 14,
		shortcutHint,
		onFocus,
		onBlur,
	},
	ref,
) {
	const { t } = useT();
	const [focused, setFocused] = useState(Boolean(autoFocus));
	const showShortcutHint = Boolean(shortcutHint) && !focused && !value;
	const showClearButton = Boolean(value || showClearWhenEmpty);
	const resolvedInputClass = inputClassName ?? clsx(DEFAULT_INPUT_BASE_CLASS, showClearButton ? "pr-7" : "pr-2.5");
	const hintInsetClass = resolvedInputClass.includes("pl-6")
		? "inset-y-0 left-6 right-5"
		: showClearButton
			? "inset-y-0 left-8 right-7"
			: "inset-y-0 left-8 right-2.5";
	const clear = () => {
		onChange("");
		onClear?.();
	};
	return (
		<div className={clsx("relative", className)}>
			<Search
				size={iconSize}
				className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400"
			/>
			<input
				ref={ref}
				type="text"
				value={value}
				autoFocus={autoFocus}
				placeholder={placeholder}
				aria-label={ariaLabel ?? placeholder}
				title={title}
				data-slash-search={shortcutHint === "/" ? "" : undefined}
				onChange={(e) => onChange(e.target.value)}
				onFocus={(e) => {
					setFocused(true);
					onFocus?.(e);
				}}
				onBlur={(e) => {
					setFocused(false);
					onBlur?.(e);
				}}
				onKeyDown={(e) => {
					onKeyDown?.(e);
					if (e.defaultPrevented) return;
					if (e.key === "Escape" && value && !isComposing(e)) {
						claimEscape(e);
						e.stopPropagation();
						clear();
					}
				}}
				className={clsx(resolvedInputClass, "text-ellipsis", showShortcutHint && "placeholder:text-transparent")}
			/>
			{showShortcutHint && <SearchShortcutHint shortcut={shortcutHint} className={clsx("absolute", hintInsetClass)} />}
			{showClearButton && (
				<button
					type="button"
					onMouseDown={(e) => e.preventDefault()}
					onClick={clear}
					aria-label={t("components.clearSearch")}
					title={t("components.clearSearch")}
					className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 transition-[color,transform] duration-150 ease-[var(--ease-out)] hover:text-neutral-300 active:scale-[0.97]"
				>
					<X className="h-3 w-3" />
				</button>
			)}
		</div>
	);
});

/**
 * Observes a container's width and reports whether it is narrower than `threshold`.
 * When width is `0` (e.g. jsdom or before first layout), returns `false` so callers
 * default to the expanded layout.
 */
export function useNarrowContainer(ref: RefObject<HTMLElement | null>, threshold = 560): boolean {
	const [narrow, setNarrow] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		const update = (width: number) => {
			setNarrow(width > 0 && width < threshold);
		};

		update(el.clientWidth);

		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver((entries) => {
			const entry = entries[0];
			const width = entry?.contentRect?.width ?? el.clientWidth;
			update(width);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref, threshold]);

	return narrow;
}

export interface CollapsibleSearchInputProps extends SearchInputProps {
	/** When true, collapses into a circular icon button while empty and inactive. */
	collapsed: boolean;
	/** Wrapper className used when expanded in narrow mode. Defaults to `w-full basis-full`. */
	expandedClassName?: string;
}

/**
 * Search field that collapses into a compact circular icon button in narrow toolbars
 * while empty and unfocused, expanding in-place on click and collapsing on blur or Escape.
 */
export function CollapsibleSearchInput({
	collapsed,
	expandedClassName = "w-full basis-full",
	className,
	value,
	onChange,
	placeholder,
	ariaLabel,
	iconSize = 14,
	onKeyDown,
	onBlur,
	onClear,
	...rest
}: CollapsibleSearchInputProps) {
	const { t } = useT();
	const [expanded, setExpanded] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const prevValueRef = useRef(value);

	const showButton = collapsed && !expanded && value === "";

	useEffect(() => {
		if (!collapsed) setExpanded(false);
	}, [collapsed]);

	useEffect(() => {
		if (collapsed && expanded) {
			inputRef.current?.focus();
		}
	}, [collapsed, expanded]);

	useEffect(() => {
		const hadValue = prevValueRef.current !== "";
		prevValueRef.current = value;
		if (collapsed && expanded && hadValue && value === "" && document.activeElement !== inputRef.current) {
			setExpanded(false);
		}
	}, [collapsed, expanded, value]);

	if (showButton) {
		const label = ariaLabel ?? placeholder ?? t("common.search");
		return (
			<button
				type="button"
				onClick={() => setExpanded(true)}
				aria-label={label}
				title={label}
				className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full hairline bg-[var(--well-bg)] text-neutral-400 transition-[background-color,color,border-color,transform] duration-150 ease-[var(--ease-out)] hover:bg-[var(--bg-hover)] hover:text-neutral-200 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
			>
				<Search size={iconSize} />
			</button>
		);
	}

	return (
		<SearchInput
			{...rest}
			ref={inputRef}
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			ariaLabel={ariaLabel}
			iconSize={iconSize}
			autoFocus={collapsed && expanded}
			className={collapsed ? expandedClassName : className}
			showClearWhenEmpty={collapsed}
			onClear={() => {
				onClear?.();
				if (collapsed) {
					if (value === "") {
						setExpanded(false);
					} else {
						inputRef.current?.focus();
					}
				}
			}}
			onKeyDown={(e) => {
				onKeyDown?.(e);
				if (e.defaultPrevented) return;
				if (collapsed && e.key === "Escape" && !value && !isComposing(e)) {
					claimEscape(e);
					e.stopPropagation();
					setExpanded(false);
				}
			}}
			onBlur={(e) => {
				onBlur?.(e);
				if (collapsed && value.trim() === "") {
					setExpanded(false);
				}
			}}
		/>
	);
}

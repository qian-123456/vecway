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
	autoFocus?: boolean;
	/** Classes for the wrapper (width, flex sizing). */
	className?: string;
	/** Classes for the `<input>`; default matches the common hairline well input. */
	inputClassName?: string;
	/** Called when the clear button or Escape clears a non-empty value (after `onChange("")`). */
	onClear?: () => void;
	onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
	/** Search icon size in px. Default 14. */
	iconSize?: number;
	/** Keyboard shortcut hint displayed GitHub-style inside empty unfocused inputs (e.g. "/"). */
	shortcutHint?: string;
	onFocus?: (e: FocusEvent<HTMLInputElement>) => void;
	onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
}

const DEFAULT_INPUT_CLASS =
	"w-full rounded-lg hairline bg-[var(--bg-panel)] py-1.5 pl-8 pr-7 text-xs text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

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
		autoFocus,
		className,
		inputClassName,
		onClear,
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
	const resolvedInputClass = inputClassName ?? DEFAULT_INPUT_CLASS;
	const hintInsetClass = resolvedInputClass.includes("pl-6") ? "inset-y-0 left-6 right-5" : "inset-y-0 left-8 right-7";
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
				className={clsx(resolvedInputClass, showShortcutHint && "placeholder:text-transparent")}
			/>
			{showShortcutHint && <SearchShortcutHint shortcut={shortcutHint} className={clsx("absolute", hintInsetClass)} />}
			{value && (
				<button
					type="button"
					onClick={clear}
					aria-label={t("components.clearSearch")}
					title={t("components.clearSearch")}
					className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 transition-colors hover:text-neutral-300"
				>
					<X className="h-3 w-3" />
				</button>
			)}
		</div>
	);
});

import clsx from "clsx";
import { Check, ChevronDown, Pencil, Undo2 } from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from "react";
import { claimEscape } from "../lib/escapeClaim";
import { isComposing } from "../lib/hooks";
import { useT } from "../stores/language";
import { FloatingLayer } from "./FloatingLayer";

export interface PopoverSelectOption {
	value: string;
	label: string;
	description?: string;
	badge?: string;
	disabled?: boolean;
}

export interface PopoverSelectProps {
	value: string;
	onChange: (value: string) => void;
	options: PopoverSelectOption[];
	placeholder?: string;
	disabled?: boolean;
	size?: "sm" | "md";
	align?: "start" | "end";
	"aria-label"?: string;
	id?: string;
	className?: string;
	containerClassName?: string;
	menuClassName?: string;
	allowCustom?: boolean;
	customOptionLabel?: string;
	customPlaceholder?: string;
	customActionLabel?: string;
	customInputType?: "text" | "number";
	customMono?: boolean;
	customInputAriaLabel?: string;
	validateCustom?: (value: string) => string | null;
}

type MenuItem =
	| { kind: "option"; option: PopoverSelectOption }
	| { kind: "custom"; label: string };

/**
 * Accessible themed dropdown menu anchored with FloatingLayer, supporting rich
 * option descriptions/badges, keyboard navigation, and unified inline custom value mode.
 */
export function PopoverSelect({
	value,
	onChange,
	options,
	placeholder,
	disabled = false,
	size = "md",
	align = "start",
	"aria-label": ariaLabel,
	id,
	className,
	containerClassName,
	menuClassName,
	allowCustom = false,
	customOptionLabel,
	customPlaceholder,
	customActionLabel,
	customInputType = "text",
	customMono = false,
	customInputAriaLabel,
	validateCustom,
}: PopoverSelectProps) {
	const { t } = useT();
	const baseId = useId();
	const listboxId = `${baseId}-listbox`;

	const triggerRef = useRef<HTMLButtonElement>(null);
	const customInputRef = useRef<HTMLInputElement>(null);
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [menuWidth, setMenuWidth] = useState(0);
	const [editingCustom, setEditingCustom] = useState(false);
	const [customDraft, setCustomDraft] = useState("");
	const [customError, setCustomError] = useState<string | null>(null);

	// Track whether dismissal was initiated by Escape so outside clicks keep natural focus transfer.
	const openRef = useRef(false);
	openRef.current = open;
	const dismissSourceRef = useRef<"escape" | "pointer" | null>(null);
	const focusTriggerOnExitCustomRef = useRef(false);

	useEffect(() => {
		const onDocMouseDown = () => {
			if (openRef.current) dismissSourceRef.current = "pointer";
		};
		const onDocKeyDown = (e: globalThis.KeyboardEvent) => {
			if (!openRef.current) return;
			if (e.key === "Escape" && !isComposing({ nativeEvent: e, key: e.key })) {
				dismissSourceRef.current = "escape";
			}
		};
		document.addEventListener("mousedown", onDocMouseDown, true);
		document.addEventListener("keydown", onDocKeyDown, true);
		return () => {
			document.removeEventListener("mousedown", onDocMouseDown, true);
			document.removeEventListener("keydown", onDocKeyDown, true);
		};
	}, []);

	const selectedOptionIndex = useMemo(() => options.findIndex((o) => o.value === value), [options, value]);
	const selectedOption = selectedOptionIndex >= 0 ? options[selectedOptionIndex] : undefined;
	const isCustomActive = allowCustom && value !== "" && !selectedOption;

	const customOptionText = customOptionLabel ?? t("settingsCore.popoverSelect.customOption");
	const customBadgeText = t("settingsCore.popoverSelect.customBadge");
	const customPlaceholderText = customPlaceholder ?? t("settingsCore.popoverSelect.customPlaceholder");
	const editCustomLabel = customActionLabel ?? t("settingsCore.popoverSelect.editCustomAria");
	const placeholderText = placeholder ?? t("settingsCore.popoverSelect.placeholder");

	const menuItems = useMemo<MenuItem[]>(() => {
		const items: MenuItem[] = options.map((option) => ({ kind: "option", option }));
		if (allowCustom) {
			items.push({ kind: "custom", label: customOptionText });
		}
		return items;
	}, [options, allowCustom, customOptionText]);

	const isItemDisabled = useCallback(
		(idx: number) => {
			const item = menuItems[idx];
			return !item || (item.kind === "option" && Boolean(item.option.disabled));
		},
		[menuItems],
	);

	const findFirstEnabled = useCallback(() => {
		for (let i = 0; i < menuItems.length; i += 1) {
			if (!isItemDisabled(i)) return i;
		}
		return -1;
	}, [menuItems.length, isItemDisabled]);

	const findLastEnabled = useCallback(() => {
		for (let i = menuItems.length - 1; i >= 0; i -= 1) {
			if (!isItemDisabled(i)) return i;
		}
		return -1;
	}, [menuItems.length, isItemDisabled]);

	const findNextEnabled = useCallback(
		(start: number, delta: 1 | -1) => {
			const len = menuItems.length;
			if (len === 0) return -1;
			for (let step = 1; step <= len; step += 1) {
				const idx = (start + delta * step + len) % len;
				if (!isItemDisabled(idx)) return idx;
			}
			return -1;
		},
		[menuItems.length, isItemDisabled],
	);

	useLayoutEffect(() => {
		if (!open) return;
		const w = triggerRef.current?.getBoundingClientRect().width ?? 0;
		setMenuWidth(w);
	}, [open]);

	useEffect(() => {
		if (!open || activeIndex < 0) return;
		itemRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
	}, [open, activeIndex]);

	useEffect(() => {
		if (editingCustom) {
			customInputRef.current?.focus();
			customInputRef.current?.select();
		} else if (focusTriggerOnExitCustomRef.current) {
			focusTriggerOnExitCustomRef.current = false;
			triggerRef.current?.focus();
		}
	}, [editingCustom]);

	const openMenu = useCallback(
		(preferLast = false) => {
			if (disabled || menuItems.length === 0) return;
			let initial = -1;
			if (selectedOptionIndex >= 0 && !isItemDisabled(selectedOptionIndex)) {
				initial = selectedOptionIndex;
			} else if (isCustomActive && allowCustom) {
				initial = options.length;
			} else {
				initial = preferLast ? findLastEnabled() : findFirstEnabled();
			}
			setActiveIndex(initial);
			setOpen(true);
		},
		[
			disabled,
			menuItems.length,
			selectedOptionIndex,
			isItemDisabled,
			isCustomActive,
			allowCustom,
			options.length,
			findLastEnabled,
			findFirstEnabled,
		],
	);

	const handleDismiss = useCallback(() => {
		const source = dismissSourceRef.current;
		dismissSourceRef.current = null;
		setOpen(false);
		if (source === "escape") {
			triggerRef.current?.focus();
		}
	}, []);

	const enterCustomMode = useCallback(() => {
		setOpen(false);
		setCustomDraft(isCustomActive ? value : "");
		setCustomError(null);
		setEditingCustom(true);
	}, [isCustomActive, value]);

	const exitCustomMode = useCallback(() => {
		setCustomError(null);
		focusTriggerOnExitCustomRef.current = true;
		setEditingCustom(false);
	}, []);

	const commitCustom = useCallback(() => {
		const trimmed = customDraft.trim();
		const err = validateCustom?.(trimmed) ?? null;
		if (err) {
			setCustomError(err);
			return;
		}
		if (!trimmed) {
			return;
		}
		setCustomError(null);
		focusTriggerOnExitCustomRef.current = true;
		setEditingCustom(false);
		if (trimmed !== value) {
			onChange(trimmed);
		}
	}, [customDraft, validateCustom, value, onChange]);

	const selectItem = useCallback(
		(idx: number) => {
			const item = menuItems[idx];
			if (!item || isItemDisabled(idx)) return;
			if (item.kind === "custom") {
				enterCustomMode();
				return;
			}
			setOpen(false);
			triggerRef.current?.focus();
			if (item.option.value !== value) {
				onChange(item.option.value);
			}
		},
		[menuItems, isItemDisabled, enterCustomMode, value, onChange],
	);

	const handleTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
		if (isComposing(e) || disabled) return;
		if (!open) {
			if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				openMenu(false);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				openMenu(true);
			} else if (e.key === "Home") {
				e.preventDefault();
				if (menuItems.length > 0) {
					setActiveIndex(findFirstEnabled());
					setOpen(true);
				}
			} else if (e.key === "End") {
				e.preventDefault();
				if (menuItems.length > 0) {
					setActiveIndex(findLastEnabled());
					setOpen(true);
				}
			}
			return;
		}

		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIndex((prev) => (prev < 0 ? findFirstEnabled() : findNextEnabled(prev, 1)));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIndex((prev) => (prev < 0 ? findLastEnabled() : findNextEnabled(prev, -1)));
		} else if (e.key === "Home") {
			e.preventDefault();
			setActiveIndex(findFirstEnabled());
		} else if (e.key === "End") {
			e.preventDefault();
			setActiveIndex(findLastEnabled());
		} else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			if (activeIndex >= 0) {
				selectItem(activeIndex);
			}
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			claimEscape(e);
			setOpen(false);
			triggerRef.current?.focus();
		} else if (e.key === "Tab") {
			setOpen(false);
		}
	};

	if (editingCustom) {
		return (
			<div className={clsx("flex items-start gap-1.5", containerClassName)}>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div
						className={clsx(
							"flex min-w-0 items-center rounded-lg hairline bg-[var(--well-bg)] transition-[box-shadow,border-color] duration-150 ease-[var(--ease-out)]",
							"focus-within:ring-1 focus-within:ring-[color-mix(in_srgb,var(--accent)_50%,transparent)]",
							customError && "ring-1 ring-[var(--status-error)]/60",
						)}
					>
						<input
							ref={customInputRef}
							type={customInputType}
							value={customDraft}
							disabled={disabled}
							aria-label={customInputAriaLabel ?? ariaLabel}
							aria-invalid={customError ? true : undefined}
							placeholder={customPlaceholderText}
							onChange={(e) => {
								setCustomDraft(e.target.value);
								if (customError) setCustomError(null);
							}}
							onKeyDown={(e) => {
								if (isComposing(e)) return;
								if (e.key === "Enter") {
									e.preventDefault();
									commitCustom();
								} else if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									claimEscape(e);
									exitCustomMode();
								}
							}}
							className={clsx(
								"min-w-0 flex-1 bg-transparent text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none",
								size === "sm" ? "pl-2.5 pr-1 py-1" : "pl-3 pr-1.5 py-1.5",
								customMono && "font-mono",
							)}
						/>
						<button
							type="button"
							disabled={disabled || (!validateCustom && !customDraft.trim())}
							aria-label={t("settingsCore.popoverSelect.confirmCustomAria")}
							title={t("settingsCore.popoverSelect.confirmCustomAria")}
							onClick={commitCustom}
							className={clsx(
								"mr-1 inline-flex shrink-0 items-center justify-center rounded-md p-1 transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97] cursor-pointer",
								"bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_26%,transparent)]",
								"disabled:pointer-events-none disabled:opacity-40",
							)}
						>
							<Check className="size-3.5" />
						</button>
					</div>
					{customError && <div className="text-[11px] text-[var(--status-error)]">{customError}</div>}
				</div>
				<button
					type="button"
					disabled={disabled}
					onClick={exitCustomMode}
					className={clsx(
						"inline-flex shrink-0 items-center gap-1 rounded-lg hairline bg-[var(--well-bg)] hover:bg-[var(--bg-hover)] text-xs text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap cursor-pointer transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]",
						"disabled:pointer-events-none disabled:opacity-40",
						size === "sm" ? "px-2 py-1" : "px-2.5 py-1.5",
					)}
				>
					<Undo2 className="size-3 shrink-0" />
					<span>{t("settingsCore.popoverSelect.backToPresets")}</span>
				</button>
			</div>
		);
	}

	const activeOptionId = open && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined;

	return (
		<div className={clsx("relative flex items-center gap-1.5", containerClassName)}>
			<button
				ref={triggerRef}
				id={id}
				type="button"
				role="combobox"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listboxId : undefined}
				aria-activedescendant={activeOptionId}
				aria-label={ariaLabel}
				disabled={disabled}
				onClick={() => {
					if (open) setOpen(false);
					else openMenu(false);
				}}
				onKeyDown={handleTriggerKeyDown}
				className={clsx(
					"inline-flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg hairline bg-[var(--well-bg)] hover:bg-[var(--bg-hover)] text-xs text-[var(--text)] whitespace-nowrap cursor-pointer transition-[background-color,color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.985]",
					size === "sm" ? "px-2.5 py-1" : "px-3 py-1.5",
					"focus:ring-1 focus:ring-[color-mix(in_srgb,var(--accent)_50%,transparent)] focus:outline-none",
					"disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
			>
				{selectedOption ? (
					<span className="truncate">{selectedOption.label}</span>
				) : isCustomActive ? (
					<span className="inline-flex min-w-0 items-center gap-1.5">
						<span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)] whitespace-nowrap">
							{customBadgeText}
						</span>
						<span className="truncate font-mono">{value}</span>
					</span>
				) : (
					<span className="truncate text-[var(--text-muted)]">{placeholderText}</span>
				)}
				<ChevronDown
					className={clsx("size-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150 ease-[var(--ease-out)]", open && "rotate-180")}
				/>
			</button>

			{isCustomActive && (
				<button
					type="button"
					disabled={disabled}
					aria-label={editCustomLabel}
					title={editCustomLabel}
					onClick={enterCustomMode}
					className={clsx(
						"inline-flex shrink-0 items-center justify-center rounded-lg hairline bg-[var(--well-bg)] hover:bg-[var(--bg-hover)] text-xs text-[var(--text-muted)] hover:text-[var(--text)] whitespace-nowrap cursor-pointer transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]",
						"disabled:cursor-not-allowed disabled:opacity-40",
						size === "sm" ? "px-1.5 py-1" : "px-2 py-1.5",
					)}
				>
					<Pencil className="size-3.5" />
				</button>
			)}

			<FloatingLayer
				anchor={open ? triggerRef.current : null}
				layer="popover"
				placement={align === "end" ? "bottom-end" : "bottom-start"}
				offset={4}
				ignoreRefs={[triggerRef]}
				onDismiss={handleDismiss}
				className={clsx(
					"rounded-xl hairline vibrancy-popover shadow-apple-modal max-w-[min(22rem,calc(100vw-16px))]",
					menuClassName,
				)}
				style={menuWidth > 0 ? { minWidth: menuWidth } : undefined}
			>
				<div
					id={listboxId}
					role="listbox"
					aria-label={ariaLabel}
					className="max-h-72 overflow-y-auto p-1"
				>
					{menuItems.map((item, idx) => {
						const itemId = `${listboxId}-opt-${idx}`;
						const isDisabled = isItemDisabled(idx);
						const isActive = idx === activeIndex;
						const isSelected =
							item.kind === "option" ? item.option.value === value : isCustomActive;

						return (
							<button
								key={item.kind === "option" ? item.option.value : "__popover_select_custom__"}
								ref={(el) => {
									itemRefs.current[idx] = el;
								}}
								id={itemId}
								type="button"
								role="option"
								aria-selected={isSelected}
								aria-disabled={isDisabled || undefined}
								tabIndex={-1}
								onMouseDown={(e) => e.preventDefault()}
								onMouseEnter={() => {
									if (!isDisabled) setActiveIndex(idx);
								}}
								onClick={() => selectItem(idx)}
								className={clsx(
									"flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.985]",
									isDisabled ? "cursor-not-allowed opacity-45" : "cursor-pointer",
									isActive && !isDisabled && "bg-[var(--bg-hover)]",
									isSelected && !isActive && "bg-[color-mix(in_srgb,var(--accent)_12%,var(--bg-selected))]",
								)}
							>
								<span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
									{isSelected && <Check className="size-3.5 text-[var(--accent)]" />}
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex flex-wrap items-center gap-1.5">
										<span
											className={clsx(
												"text-xs leading-snug text-[var(--text)]",
												isSelected && "font-medium",
											)}
										>
											{item.kind === "option" ? item.option.label : item.label}
										</span>
										{item.kind === "option" && item.option.badge && (
											<span className="rounded bg-[var(--well-bg)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)] whitespace-nowrap">
												{item.option.badge}
											</span>
										)}
									</span>
									{item.kind === "option" && item.option.description && (
										<span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-muted)] whitespace-normal break-words">
											{item.option.description}
										</span>
									)}
								</span>
							</button>
						);
					})}
				</div>
			</FloatingLayer>
		</div>
	);
}

import { ChevronsUpDown, Search, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { AnchoredPopover } from "./AnchoredPopover";
import { BottomSheet } from "./BottomSheet";
import { IconButton } from "./IconButton";
import { ChoiceRow, ListGroup, MenuRow } from "./ListRow";

export interface SelectOption<T extends string = string> {
	value: T;
	label: string;
	hint?: string;
	icon?: ReactNode;
	disabled?: boolean;
	disabledReason?: string;
	searchText?: string;
}

/**
 * iOS Settings-style selection row: label on left, current value + up/down chevrons on right.
 * Short sets (<= 6) open an anchored pull-down menu; longer sets open a searchable full-height
 * grouped checklist sheet. Never truncates the selected label.
 */
export function SelectRow<T extends string>({
	title,
	subtitle,
	icon,
	value,
	options,
	onChange,
	label,
	disabled = false,
	busy = false,
	presentation,
	searchable,
	placeholder = "请选择",
	error,
	className = "",
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	icon?: ReactNode;
	value: T | null | undefined;
	options: ReadonlyArray<SelectOption<T>>;
	onChange: (next: T) => void;
	label?: string;
	disabled?: boolean;
	busy?: boolean;
	presentation?: "menu" | "list";
	searchable?: boolean;
	placeholder?: string;
	error?: ReactNode;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const rowRef = useRef<HTMLButtonElement>(null);
	const valueRef = useRef<HTMLSpanElement>(null);

	const mode = presentation ?? (options.length <= 6 ? "menu" : "list");
	const allowSearch = searchable ?? mode === "list";
	const current = options.find((o) => o.value === value) ?? null;
	const ariaName = label ?? (typeof title === "string" ? title : "选择");
	const isDisabled = disabled || busy || options.length === 0;

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle || !allowSearch) return options;
		return options.filter((o) => {
			const hay = `${o.label} ${o.hint ?? ""} ${o.value} ${o.searchText ?? ""}`.toLowerCase();
			return hay.includes(needle);
		});
	}, [options, query, allowSearch]);

	const handleSelect = (next: T) => {
		setOpen(false);
		setQuery("");
		if (next !== value) onChange(next);
	};

	const close = () => {
		setOpen(false);
		setQuery("");
	};

	return (
		<>
			<div className={`m-list-row ${className}`}>
				<button
					ref={rowRef}
					type="button"
					aria-label={`${ariaName}，当前：${current?.label ?? placeholder}`}
					aria-haspopup={mode === "menu" ? "menu" : "dialog"}
					aria-expanded={open}
					disabled={isDisabled}
					onClick={() => setOpen((v) => !v)}
					className="flex w-full items-center gap-4 pl-4 text-left transition-colors duration-(--m-dur-fast) ease-m active:bg-m-surface-hover disabled:opacity-45"
				>
					{icon != null && <span className="flex w-6 shrink-0 items-center justify-center text-m-text-2">{icon}</span>}
					<span className="m-list-sep flex min-h-14 min-w-0 flex-1 items-center justify-between gap-3 py-3 pr-4">
						<span className="min-w-0 flex-1">
							<span className="block text-m-md break-words text-m-text">{title}</span>
							{subtitle != null && <span className="mt-0.5 block text-m-xs break-words text-m-text-3">{subtitle}</span>}
						</span>
						<span
							ref={valueRef}
							className={`inline-flex max-w-[52%] shrink-0 items-center gap-1 text-right text-m-sm break-words ${
								open ? "text-m-accent" : current ? "text-m-text-3" : "text-m-text-quiet"
							}`}
						>
							<span className="min-w-0 break-words">{current?.label ?? placeholder}</span>
							<ChevronsUpDown size={15} strokeWidth={1.85} className="shrink-0 opacity-75" aria-hidden />
						</span>
					</span>
				</button>
				{error != null && error !== false && <div className="px-4 pb-3">{error}</div>}
			</div>

			{mode === "menu" ? (
				<AnchoredPopover
					open={open}
					onClose={close}
					anchorEl={valueRef.current ?? rowRef.current}
					placement="bottom-end"
					ariaLabel={ariaName}
					minWidth={220}
					maxWidth={308}
					className="m-liquid-surface rounded-2xl!"
				>
					<div role="menu" aria-label={ariaName} className="py-1">
						{options.map((opt) => {
							const selected = opt.value === value;
							const hintText = opt.disabled && opt.disabledReason ? opt.disabledReason : opt.hint;
							return (
								<MenuRow
									key={opt.value}
									role="menuitemradio"
									ariaChecked={selected}
									icon={opt.icon}
									label={opt.label}
									hint={hintText}
									selected={selected}
									disabled={opt.disabled}
									onClick={() => handleSelect(opt.value)}
								/>
							);
						})}
					</div>
				</AnchoredPopover>
			) : (
				<BottomSheet open={open} onClose={close} title={ariaName} fullHeight>
					<div className="space-y-3 pb-6">
						{allowSearch && (
							<div className="px-4 pt-1">
								<label className="flex min-h-11 items-center gap-2 rounded-m-md bg-m-surface px-3.5">
									<Search size={17} strokeWidth={1.75} className="shrink-0 text-m-text-3" aria-hidden />
									<input
										type="search"
										value={query}
										onChange={(e) => setQuery(e.target.value)}
										placeholder="搜索"
										aria-label={`搜索${ariaName}`}
										className="min-h-10 min-w-0 flex-1 bg-transparent text-m-md text-m-text outline-none placeholder:text-m-text-3 [&::-webkit-search-cancel-button]:hidden"
									/>
									{query !== "" && (
										<IconButton icon={<X size={16} />} label="清空搜索" variant="plain" size="sm" onClick={() => setQuery("")} />
									)}
								</label>
							</div>
						)}
						{filtered.length === 0 ? (
							<p className="px-6 py-8 text-center text-m-sm text-m-text-3">没有匹配的选项</p>
						) : (
							<ListGroup>
								<div role="radiogroup" aria-label={ariaName}>
									{filtered.map((opt) => (
										<ChoiceRow
											key={opt.value}
											checked={opt.value === value}
											icon={opt.icon}
											title={opt.label}
											subtitle={opt.disabled && opt.disabledReason ? opt.disabledReason : opt.hint}
											disabled={opt.disabled}
											onPick={() => handleSelect(opt.value)}
										/>
									))}
								</div>
							</ListGroup>
						)}
					</div>
				</BottomSheet>
			)}
		</>
	);
}

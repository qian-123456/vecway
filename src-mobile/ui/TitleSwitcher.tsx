import { Check, ChevronDown, Plus } from "lucide-react";
import { useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import { AnchoredPopover } from "./AnchoredPopover";
import { Button } from "./Button";

export interface TitleSwitcherItem {
	id: string;
	label: string;
	subtitle?: string;
	hint?: string;
	icon?: ReactNode;
	badge?: string;
	dotTone?: "accent" | "success" | "warn" | "danger" | "muted";
	live?: boolean;
	selected?: boolean;
	rightText?: string;
	removable?: boolean;
}

export interface TitleSwitcherCreate {
	label: string;
	hint?: string;
	disabled?: boolean;
	onClick: () => void;
}

const DOT_CLS = {
	accent: "bg-m-accent",
	success: "bg-m-success",
	warn: "bg-m-warn",
	danger: "bg-m-danger",
	muted: "bg-m-text-3",
} as const;

const SWIPE_OPEN_PX = 72;
const TITLE_STEP_PX = 36;

function SwitcherItemRow({
	item,
	selected,
	onSelect,
	onRemove,
	removeLabel,
	swiped,
	onSwipeOpen,
	onSwipeClose,
}: {
	item: TitleSwitcherItem;
	selected: boolean;
	onSelect: () => void;
	onRemove?: () => void;
	removeLabel: string;
	swiped: boolean;
	onSwipeOpen: () => void;
	onSwipeClose: () => void;
}) {
	const touchRef = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(null);
	const canSwipe = Boolean(onRemove && item.removable === true);
	const secondaryText = item.subtitle ?? item.hint;

	const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
		if (!canSwipe || e.touches.length !== 1) return;
		const t = e.touches[0];
		touchRef.current = { x: t.clientX, y: t.clientY, axis: null };
	};
	const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
		const s = touchRef.current;
		if (!s || !canSwipe || e.touches.length !== 1) return;
		const t = e.touches[0];
		const dx = t.clientX - s.x;
		const dy = t.clientY - s.y;
		if (!s.axis) {
			if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
			s.axis = Math.abs(dx) > Math.abs(dy) * 1.4 ? "x" : "y";
		}
		if (s.axis !== "x") return;
		if (dx < -28) onSwipeOpen();
		else if (dx > 24 && swiped) onSwipeClose();
	};
	const onTouchEnd = () => {
		touchRef.current = null;
	};

	const rowContent = (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={selected}
			onClick={() => {
				if (swiped) {
					onSwipeClose();
					return;
				}
				onSelect();
			}}
			className={`flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-(--m-dur-fast) ease-m active:bg-m-surface-hover ${
				selected ? "text-m-accent" : "text-m-text"
			}`}
		>
			{item.icon ? (
				<span className={`flex w-5 shrink-0 items-center justify-center ${selected ? "text-m-accent" : "text-m-text-2"}`}>{item.icon}</span>
			) : item.badge ? (
				<span className="flex w-4 shrink-0 items-center justify-center">
					<span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: item.badge }} />
				</span>
			) : item.dotTone ? (
				<span className="flex w-4 shrink-0 items-center justify-center">
					<span
						aria-hidden
						className={`h-2 w-2 rounded-full ${DOT_CLS[item.dotTone]} ${item.live ? "m-pulse" : ""}`}
					/>
				</span>
			) : null}
			<span className="min-w-0 flex-1">
				<span className={`block text-m-sm break-words ${selected ? "font-semibold" : "font-medium"}`}>{item.label}</span>
				{secondaryText && <span className="mt-0.5 block text-m-xs break-words text-m-text-3">{secondaryText}</span>}
			</span>
			{item.rightText && (
				<span className="shrink-0 text-m-xs tabular-nums whitespace-nowrap text-m-text-3">{item.rightText}</span>
			)}
			{selected && <Check size={17} className="shrink-0 text-m-accent" aria-hidden />}
		</button>
	);

	if (!canSwipe) {
		return <div className="relative border-t border-m-border first:border-t-0">{rowContent}</div>;
	}

	return (
		<div
			className="relative overflow-hidden border-t border-m-border first:border-t-0"
			onTouchStart={onTouchStart}
			onTouchMove={onTouchMove}
			onTouchEnd={onTouchEnd}
			onTouchCancel={onTouchEnd}
		>
			<button
				type="button"
				aria-label={`${removeLabel} ${item.label}`}
				onClick={() => {
					onSwipeClose();
					onRemove?.();
				}}
				className="absolute inset-y-0 right-0 flex items-center justify-center bg-m-danger px-4 text-m-xs font-semibold whitespace-nowrap text-white active:opacity-85"
				style={{ width: `${SWIPE_OPEN_PX}px` }}
			>
				{removeLabel}
			</button>
			<div
				className="relative bg-m-bg-elev transition-transform duration-(--m-dur-fast) ease-m"
				style={{ transform: swiped ? `translateX(-${SWIPE_OPEN_PX}px)` : "translateX(0)" }}
			>
				{rowContent}
			</div>
		</div>
	);
}

/**
 * Shared iOS pull-down title switcher used by Sidechat, Terminal, Files path, Subagents, and Ideas.
 * Optional `onStep` lets users swipe horizontally on the centered title button itself to step prev/next.
 */
export function TitleSwitcher({
	label,
	subtitle,
	ariaLabel,
	popoverTitle,
	open: controlledOpen,
	onOpenChange,
	items,
	activeId,
	onSelect,
	create,
	onRemove,
	removeLabel = "删除",
	onStep,
	loading = false,
	error = null,
	onRetry,
	disabled = false,
	emptyText = "暂无可切换项",
	className = "",
}: {
	label: string;
	subtitle?: string;
	ariaLabel?: string;
	popoverTitle?: string;
	open?: boolean;
	onOpenChange?: (next: boolean) => void;
	items: readonly TitleSwitcherItem[];
	activeId?: string;
	onSelect: (id: string) => void;
	create?: TitleSwitcherCreate;
	onRemove?: (id: string) => void;
	removeLabel?: string;
	onStep?: (dir: -1 | 1) => void;
	loading?: boolean;
	error?: string | null;
	onRetry?: () => void;
	disabled?: boolean;
	emptyText?: string;
	className?: string;
}) {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const isOpen = controlledOpen ?? uncontrolledOpen;
	const setOpen = (next: boolean) => {
		if (controlledOpen === undefined) setUncontrolledOpen(next);
		onOpenChange?.(next);
	};

	const btnRef = useRef<HTMLButtonElement>(null);
	const swipeRef = useRef<{ x: number; y: number; done: boolean } | null>(null);
	const [swipedId, setSwipedId] = useState<string | null>(null);

	const onTouchStart = (e: ReactTouchEvent<HTMLButtonElement>) => {
		if (!onStep || e.touches.length !== 1) return;
		const t = e.touches[0];
		swipeRef.current = { x: t.clientX, y: t.clientY, done: false };
	};
	const onTouchMove = (e: ReactTouchEvent<HTMLButtonElement>) => {
		const s = swipeRef.current;
		if (!s || s.done || !onStep || e.touches.length !== 1) return;
		const t = e.touches[0];
		const dx = t.clientX - s.x;
		const dy = Math.abs(t.clientY - s.y);
		if (Math.abs(dx) >= TITLE_STEP_PX && Math.abs(dx) > dy * 1.5) {
			s.done = true;
			onStep(dx < 0 ? 1 : -1);
		}
	};
	const onTouchEnd = () => {
		swipeRef.current = null;
	};

	const close = () => {
		setSwipedId(null);
		setOpen(false);
	};

	const resolvedAria = ariaLabel ?? `切换${label}`;

	return (
		<>
			<button
				ref={btnRef}
				type="button"
				disabled={disabled}
				aria-label={resolvedAria}
				aria-haspopup="menu"
				aria-expanded={isOpen}
				onClick={() => {
					setSwipedId(null);
					setOpen(!isOpen);
				}}
				onTouchStart={onTouchStart}
				onTouchMove={onTouchMove}
				onTouchEnd={onTouchEnd}
				onTouchCancel={onTouchEnd}
				className={`m-press mx-auto inline-flex min-h-11 max-w-full flex-col items-center justify-center rounded-[10px] px-2 py-0.5 text-center active:bg-m-surface-hover disabled:opacity-50 ${className}`}
			>
				<span className="flex max-w-full items-center justify-center gap-1">
					<span className="min-w-0 truncate text-[15px] font-semibold leading-tight text-m-text">{label}</span>
					<ChevronDown
						size={14}
						strokeWidth={2}
						aria-hidden
						className={`shrink-0 text-m-text-3 transition-transform duration-(--m-dur-fast) ${isOpen ? "rotate-180" : ""}`}
					/>
				</span>
				{subtitle && <span className="mt-0.5 max-w-full truncate text-[11px] leading-tight text-m-text-3">{subtitle}</span>}
			</button>

			<AnchoredPopover
				open={isOpen}
				onClose={close}
				anchorEl={btnRef.current}
				placement="bottom-center"
				title={popoverTitle}
				ariaLabel={popoverTitle ?? resolvedAria}
				minWidth={260}
				maxWidth={312}
				className="m-liquid-surface rounded-2xl!"
			>
				<div role="menu" aria-label={popoverTitle ?? resolvedAria} className="py-1">
					{create && (
						<>
							<button
								type="button"
								role="menuitem"
								disabled={create.disabled}
								onClick={() => {
									close();
									create.onClick();
								}}
								className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left text-m-accent transition-colors duration-(--m-dur-fast) ease-m active:bg-m-surface-hover disabled:opacity-45"
							>
								<Plus size={18} strokeWidth={2} className="shrink-0" aria-hidden />
								<span className="min-w-0 flex-1">
									<span className="block text-m-sm font-medium">{create.label}</span>
									{create.hint && <span className="mt-0.5 block text-m-xs text-m-text-3">{create.hint}</span>}
								</span>
							</button>
							<div className="my-0.5 h-px bg-m-border-strong" />
						</>
					)}

					{loading && items.length === 0 ? (
						<div className="px-4 py-5 text-center text-m-xs text-m-text-3">加载中…</div>
					) : error && items.length === 0 ? (
						<div className="space-y-2 px-4 py-4 text-center">
							<p className="text-m-xs break-words text-m-danger">{error}</p>
							{onRetry && (
								<Button size="sm" variant="tonal" onClick={onRetry}>
									重试
								</Button>
							)}
						</div>
					) : items.length === 0 ? (
						<div className="px-4 py-5 text-center text-m-xs text-m-text-3">{emptyText}</div>
					) : (
						items.map((item) => (
							<SwitcherItemRow
								key={item.id}
								item={item}
								selected={activeId !== undefined ? item.id === activeId : Boolean(item.selected)}
								swiped={swipedId === item.id}
								onSwipeOpen={() => setSwipedId(item.id)}
								onSwipeClose={() => setSwipedId((cur) => (cur === item.id ? null : cur))}
								onSelect={() => {
									close();
									onSelect(item.id);
								}}
								removeLabel={removeLabel}
								onRemove={
									onRemove
										? () => {
												close();
												onRemove(item.id);
											}
										: undefined
								}
							/>
						))
					)}
				</div>
			</AnchoredPopover>
		</>
	);
}

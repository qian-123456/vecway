/**
 * Shared Settings primitives: section header, grouped cards/rows, save
 * feedback and the buffered CommitInput. Every settings section renders
 * through these so layout and save semantics stay consistent.
 */
import clsx from "clsx";
import { useT } from "../../stores/language";
import { AlertTriangle, Check, Loader2, type LucideIcon } from "lucide-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useRef,
	useState,
	type ButtonHTMLAttributes,
	type ComponentType,
	type ReactNode,
} from "react";
import { errMsg } from "../../lib/dialogs";
import { isComposing } from "../../lib/hooks";
import { InfoTip } from "../../components/InfoTip";
import { Switch } from "./Switch";
export { Switch } from "./Switch";

// ── Header / card / row ──────────────────────────────────────────────

export function SectionHeader({
	title,
	description,
	actions,
	aside,
	infoTip,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	/** Small muted text after the title (counts, scope). */
	aside?: ReactNode;
	/** Optional info-circle tooltip rendered next to the heading. */
	infoTip?: string;
}) {
	return (
		<div>
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<h2 className="text-[18px] font-semibold leading-7 tracking-[-0.022em] text-[var(--text)]">{title}</h2>
					{infoTip && <InfoTip text={infoTip} />}
					{aside && <span className="whitespace-nowrap text-xs text-[var(--text-dim)]">{aside}</span>}
				</div>
				{actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
			</div>
			{description && (
				<p className="mt-1 text-[13px] leading-5 text-[var(--text-muted)]">{description}</p>
			)}
		</div>
	);
}

/** Settings section: heading outside a grouped card; direct children (rows) are separated by hairlines. */
export function SettingsCard({
	title,
	description,
	aside,
	footer,
	infoTip,
	fieldId,
	jump,
	clip,
	children,
}: {
	title?: ReactNode;
	/** One-line muted lead under the heading. */
	description?: ReactNode;
	/** Muted text after the heading (e.g. the omp TUI group name). */
	aside?: ReactNode;
	footer?: ReactNode;
	/** Optional info-circle tooltip rendered next to the card heading. */
	infoTip?: string;
	/** Renders `data-field-id` on the card (deep links to a whole card). */
	fieldId?: string;
	/** Chip label in the page's `SectionJumpBar`; omit for cards that should not appear there. */
	jump?: string;
	/** Clip children to the rounded corners (rows that paint their own hover background). */
	clip?: boolean;
	children: ReactNode;
}) {
	const hasHeading = title !== undefined && title !== null && title !== false && title !== "";
	return (
		<section className="scroll-mt-4 space-y-2" data-field-id={fieldId} data-jump={jump}>
			{(hasHeading || description) && (
				<div className="px-1">
					{hasHeading && (
						<div className="flex items-center gap-1.5">
							<h3 className="text-[13px] font-semibold tracking-[-0.01em] text-[var(--text)]">{title}</h3>
							{infoTip && <InfoTip text={infoTip} />}
							{aside && <span className="text-[11px] text-[var(--text-dim)]">{aside}</span>}
						</div>
					)}
					{description && (
						<p className="mt-0.5 text-xs leading-4 text-[var(--text-muted)]">{description}</p>
					)}
				</div>
			)}
			<div
				className={clsx(
					"divide-y divide-[var(--border-divider)] rounded-xl hairline bg-[var(--bg-panel)] shadow-apple-card",
					clip && "overflow-hidden",
				)}
			>
				{children}
			</div>
			{footer && <div className="px-1 text-[11px] leading-4 text-[var(--text-dim)]">{footer}</div>}
		</section>
	);
}

export interface SettingRowProps {
	label: ReactNode;
	description?: ReactNode;
	/** Secondary muted line under the description (units, defaults, caveats). */
	hint?: ReactNode;
	/** Optional info-circle tooltip rendered next to the row label (stops click propagation for ToggleRow). */
	infoTip?: string;
	/** Right-side control; with `stacked` it renders below the text instead. */
	control?: ReactNode;
	/** Renders `data-field-id` for search highlight / openSettings focusKey. */
	fieldId?: string;
	status?: SaveState;
	statusError?: string | null;
	/** Red label for destructive rows. */
	danger?: boolean;
	/** Put the control under the label (wide controls: pickers, long inputs). */
	stacked?: boolean;
	icon?: ComponentType<{ className?: string }>;
	/** Makes the whole row clickable (e.g. toggles). */
	onActivate?: () => void;
	/** Extra content under the row (conditional inputs, results). */
	children?: ReactNode;
}

export function SettingRow({
	label,
	description,
	hint,
	infoTip,
	control,
	fieldId,
	status = "idle",
	statusError,
	danger,
	stacked,
	icon: Icon,
	onActivate,
	children,
}: SettingRowProps) {
	const clickable = onActivate !== undefined;
	return (
		<div
			data-field-id={fieldId}
			role={clickable ? "button" : undefined}
			tabIndex={clickable ? 0 : undefined}
			onClick={onActivate}
			onKeyDown={
				clickable
					? (e) => {
							if (e.target !== e.currentTarget) return;
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onActivate();
							}
						}
					: undefined
			}
			className={clsx(
				"px-4 py-3 transition-[background-color] duration-150 ease-[var(--ease-out)] first:rounded-t-xl last:rounded-b-xl",
				clickable &&
					"group cursor-pointer hover:bg-[var(--bg-hover)] active:bg-[var(--bg-active-fill)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--accent)_35%,transparent)]",
			)}
		>
			<div className={clsx("flex", stacked ? "flex-col gap-2" : "flex-wrap items-center justify-between gap-x-4 gap-y-2")}>
				<div className={clsx("min-w-0", !stacked && "min-w-[160px] flex-1")}>
					<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
						{Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />}
						<span
							className={clsx(
								"text-[13px] font-medium leading-5",
								danger ? "text-[var(--status-error)]" : "text-[var(--text)]",
							)}
						>
							{label}
						</span>
						{infoTip && (
							<span className="inline-flex items-center" onClick={(e) => e.stopPropagation()}>
								<InfoTip text={infoTip} />
							</span>
						)}
						<SaveIndicator status={status} error={statusError} />
					</div>
					{description && (
						<div className="mt-0.5 text-xs leading-[18px] text-[var(--text-muted)]">{description}</div>
					)}
					{hint && <div className="mt-0.5 text-[11px] leading-4 text-[var(--text-dim)]">{hint}</div>}
				</div>
				{control && (
					<div className={clsx("flex max-w-full flex-wrap items-center gap-2", !stacked && "shrink-0 justify-end")}>{control}</div>
				)}
			</div>
			{children && <div className="mt-2">{children}</div>}
		</div>
	);
}

/** Switch row bound to an async save; the whole row toggles and shows save state. */
export function ToggleRow({
	checked,
	onChange,
	disabled,
	...row
}: Omit<SettingRowProps, "control" | "onActivate" | "status" | "statusError"> & {
	checked: boolean;
	onChange: (next: boolean) => Promise<void> | void;
	disabled?: boolean;
}) {
	const save = useSaveStatus();
	const flip = (next: boolean) => {
		if (!disabled) void save.run(() => onChange(next));
	};
	return (
		<SettingRow
			{...row}
			status={save.status}
			statusError={save.error}
			onActivate={() => flip(!checked)}
			control={<Switch checked={checked} onChange={flip} disabled={disabled} />}
		/>
	);
}

// ── Save feedback ────────────────────────────────────────────────────

export type SaveState = "idle" | "saving" | "saved" | "error";

const SAVED_VISIBLE_MS = 1800;

/**
 * Tracks one control's autosave. `run(fn)` shows saving → saved (auto-hides)
 * or error; the returned promise resolves `true` on success.
 */
export interface SaveStatus {
	status: SaveState;
	error: string | null;
	run: (fn: () => Promise<unknown> | unknown) => Promise<boolean>;
}

export function useSaveStatus(): SaveStatus {
	const [status, setStatus] = useState<SaveState>("idle");
	const [error, setError] = useState<string | null>(null);
	const seq = useRef(0);
	const timer = useRef<number | undefined>(undefined);
	useEffect(
		() => () => {
			window.clearTimeout(timer.current);
		},
		[],
	);
	const run = useCallback(async (fn: () => Promise<unknown> | unknown) => {
		const id = ++seq.current;
		window.clearTimeout(timer.current);
		setStatus("saving");
		setError(null);
		try {
			await fn();
			if (id !== seq.current) return true;
			setStatus("saved");
			timer.current = window.setTimeout(() => {
				if (id === seq.current) setStatus("idle");
			}, SAVED_VISIBLE_MS);
			return true;
		} catch (err) {
			if (id === seq.current) {
				setStatus("error");
				setError(errMsg(err));
			}
			return false;
		}
	}, []);
	return { status, error, run };
}

export function SaveIndicator({
	status,
	error,
	compact = false,
}: {
	status: SaveState;
	error?: string | null;
	compact?: boolean;
}) {
	const { t } = useT();
	if (status === "idle") return null;
	if (status === "saving") {
		const label = t("settingsCore.ui.saving");
		return (
			<span
				title={label}
				aria-label={label}
				className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)] whitespace-nowrap"
			>
				<Loader2 className="h-3 w-3 animate-spin shrink-0" />
				{!compact && <span>{label}</span>}
			</span>
		);
	}
	if (status === "saved") {
		const label = t("settingsCore.ui.saved");
		return (
			<span
				title={label}
				aria-label={label}
				className="inline-flex items-center gap-0.5 text-[10px] text-[var(--status-success)] whitespace-nowrap"
			>
				<Check className="h-3 w-3 shrink-0" />
				{!compact && <span>{label}</span>}
			</span>
		);
	}
	const failLabel = error ?? t("settingsCore.ui.saveFailed");
	return (
		<span
			title={failLabel}
			aria-label={failLabel}
			className="inline-flex items-center gap-0.5 text-[10px] text-[var(--status-error)] whitespace-nowrap"
		>
			<AlertTriangle className="h-3 w-3 shrink-0" />
			{!compact && <span>{t("settingsCore.ui.saveFailed")}</span>}
		</span>
	);
}

// ── Buffered input ───────────────────────────────────────────────────

export const INPUT_CLASS =
	"rounded-lg hairline bg-[var(--well-bg)] px-3 py-1.5 text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] transition-[border-color,background-color,box-shadow] duration-150 ease-[var(--ease-out)] focus:ring-1 focus:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)] focus:outline-none";

export interface CommitInputProps {
	/** Committed value from the store; the draft resyncs when it changes. */
	value: string;
	/** Persist the (normalized, validated) draft. Throw to signal failure. */
	onCommit: (next: string) => Promise<unknown> | unknown;
	/** Map the raw draft before validation/commit (default: trim). */
	normalize?: (draft: string) => string;
	/** Return an error message to block the commit and show it inline. */
	validate?: (next: string) => string | null;
	type?: "text" | "number";
	min?: number;
	max?: number;
	placeholder?: string;
	mono?: boolean;
	/** Width/layout classes (default `w-full`). */
	className?: string;
	"aria-label"?: string;
}

/**
 * Text/number input that buffers keystrokes and commits on Enter, on blur and
 * on unmount (section switch / close) when dirty. Escape reverts the draft.
 */
export function CommitInput({
	value,
	onCommit,
	normalize = (d) => d.trim(),
	validate,
	type = "text",
	min,
	max,
	placeholder,
	mono,
	className = "w-full",
	"aria-label": ariaLabel,
}: CommitInputProps) {
	const [draft, setDraft] = useState(value);
	const [invalid, setInvalid] = useState<string | null>(null);
	const save = useSaveStatus();
	const latest = useRef({ draft, value, onCommit, normalize, validate });
	latest.current = { draft, value, onCommit, normalize, validate };

	// Resync from the store whenever the committed value changes.
	useEffect(() => {
		setDraft(value);
		setInvalid(null);
	}, [value]);

	const commit = () => {
		const next = normalize(draft);
		if (next === value) {
			setDraft(value);
			setInvalid(null);
			return;
		}
		const err = validate?.(next) ?? null;
		setInvalid(err);
		if (err) return;
		setDraft(next);
		void save.run(() => onCommit(next));
	};

	// Flush a dirty, valid draft when the input unmounts.
	useEffect(
		() => () => {
			const l = latest.current;
			const next = l.normalize(l.draft);
			if (next === l.value || l.validate?.(next)) return;
			void Promise.resolve()
				.then(() => l.onCommit(next))
				.catch(() => {});
		},
		[],
	);

	const { t } = useT();
	const dirty = draft !== value;
	const showInlineStatus = !invalid && save.status !== "idle";
	const errorMessage = invalid ?? (save.status === "error" ? (save.error ?? t("settingsCore.ui.saveFailed")) : null);
	const isFluidWidth = className.includes("w-full") || className.includes("flex-1");

	return (
		<div className={clsx("flex flex-col gap-1", isFluidWidth ? className : "items-end")}>
			<div className={clsx("relative flex items-center", !isFluidWidth && className)}>
				<input
					type={type}
					min={min}
					max={max}
					value={draft}
					aria-label={ariaLabel}
					aria-invalid={invalid || save.status === "error" ? true : undefined}
					placeholder={placeholder}
					onChange={(e) => {
						setDraft(e.target.value);
						if (invalid) setInvalid(null);
					}}
					onBlur={commit}
					onKeyDown={(e) => {
						if (isComposing(e)) return;
						if (e.key === "Enter") {
							e.preventDefault();
							commit();
						} else if (e.key === "Escape") {
							e.stopPropagation();
							setDraft(value);
							setInvalid(null);
							e.currentTarget.blur();
						}
					}}
					className={clsx(
						INPUT_CLASS,
						"w-full",
						showInlineStatus && "pr-7",
						(mono || type === "number") && "font-mono tabular-nums",
						type === "number" && "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
						(invalid || save.status === "error") && "ring-1 ring-[var(--status-error)]/60",
						dirty && !invalid && save.status !== "error" && "ring-1 ring-[color-mix(in_srgb,var(--accent)_45%,transparent)]",
					)}
				/>
				{showInlineStatus && (
					<div
						className={clsx(
							"absolute right-2 top-1/2 -translate-y-1/2 leading-none",
							save.status !== "error" && "pointer-events-none",
						)}
					>
						<SaveIndicator compact status={save.status} error={save.error} />
					</div>
				)}
			</div>
			{errorMessage && (
				<div
					className={clsx(
						"text-[11px] leading-snug text-[var(--status-error)]",
						!isFluidWidth && "max-w-64 text-right",
					)}
				>
					{errorMessage}
				</div>
			)}
		</div>
	);
}

/** Clamp an hours field to [1, 720]; garbage falls back to the 24h default. */
export function normalizeHours(raw: string): string {
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n)) return "24";
	return String(Math.min(720, Math.max(1, n)));
}
/** Shared button chrome; `Button` and the legacy class constants compose from these. */
const BUTTON_BASE =
	"inline-flex items-center justify-center gap-1.5 rounded-lg transition-[background-color,color,border-color,box-shadow,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_45%,transparent)] disabled:opacity-50 disabled:pointer-events-none";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
	primary:
		"bg-[var(--accent)] font-medium text-[var(--accent-fg)] shadow-sm hover:bg-[var(--accent-hover)]",
	secondary:
		"hairline bg-[var(--bg-active-fill)] font-medium text-[var(--text)] hover:bg-[var(--bg-hover)]",
	danger:
		"border border-[color-mix(in_srgb,var(--status-error)_45%,transparent)] bg-transparent font-medium text-[var(--status-error)] hover:bg-[color-mix(in_srgb,var(--status-error)_12%,transparent)]",
	ghost:
		"font-medium text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
};

const BUTTON_SIZE: Record<"sm" | "md", string> = {
	sm: "px-2 py-1 text-[11px]",
	md: "px-3 py-1.5 text-xs",
};

/** Secondary action button used in settings rows (same look as `<Button variant="secondary">`). */
export const SETTINGS_BUTTON_CLASS = `${BUTTON_BASE} ${BUTTON_VARIANT.secondary} ${BUTTON_SIZE.md}`;

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: ButtonVariant;
	size?: "sm" | "md";
	icon?: LucideIcon;
	/** Shows a spinner in place of the icon and disables the button. */
	loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ variant = "secondary", size = "md", icon: Icon, loading, disabled, className, type = "button", children, ...rest },
	ref,
) {
	const iconCls = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
	return (
		<button
			ref={ref}
			type={type}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			className={clsx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], "whitespace-nowrap", className)}
			{...rest}
		>
			{loading ? <Loader2 className={clsx(iconCls, "animate-spin")} /> : Icon && <Icon className={iconCls} />}
			{children}
		</button>
	);
});

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
	icon: LucideIcon;
	/** Required: becomes aria-label and the hover tooltip. */
	label: string;
	variant?: "ghost" | "danger";
	size?: "sm" | "md";
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
	{ icon: Icon, label, variant = "ghost", size = "md", className, type = "button", title, ...rest },
	ref,
) {
	return (
		<button
			ref={ref}
			type={type}
			aria-label={label}
			title={title ?? label}
			className={clsx(
				BUTTON_BASE,
				"shrink-0",
				size === "sm" ? "h-6 w-6" : "h-7 w-7",
				variant === "danger"
					? "text-[var(--status-error)] hover:bg-[color-mix(in_srgb,var(--status-error)_12%,transparent)]"
					: "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
				className,
			)}
			{...rest}
		>
			<Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
		</button>
	);
});

// ── Chip / Notice / EmptyState ───────────────────────────────────────

export type ChipTone = "neutral" | "accent" | "success" | "warning" | "danger";

const CHIP_TONE: Record<ChipTone, string> = {
	neutral: "bg-[var(--bg-active-fill)] text-[var(--text-muted)]",
	accent: "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]",
	success: "bg-[color-mix(in_srgb,var(--status-success)_16%,transparent)] text-[var(--status-success)]",
	warning: "bg-[color-mix(in_srgb,var(--status-warning)_16%,transparent)] text-[var(--status-warning)]",
	danger: "bg-[color-mix(in_srgb,var(--status-error)_16%,transparent)] text-[var(--status-error)]",
};

export function Chip({
	tone = "neutral",
	icon: Icon,
	title,
	children,
}: {
	tone?: ChipTone;
	icon?: ComponentType<{ className?: string }>;
	title?: string;
	children: ReactNode;
}) {
	return (
		<span
			title={title}
			className={clsx(
				"inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
				CHIP_TONE[tone],
			)}
		>
			{Icon && <Icon className="h-3 w-3" />}
			{children}
		</span>
	);
}

/** Trigger button for ModelSelect pickers in settings rows. */
export const MODEL_PICKER_BUTTON_CLASS =
	"flex h-8 min-w-[140px] max-w-full sm:max-w-[260px] items-center justify-between gap-2 rounded-lg hairline bg-[var(--bg-active-fill)] px-3 text-left text-xs text-[var(--text)] transition-[background-color,color,box-shadow,transform] duration-150 ease-[var(--ease-out)] hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color-mix(in_srgb,var(--accent)_50%,transparent)] active:scale-[0.97] disabled:opacity-50";

import clsx from "clsx";
import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../lib/hooks";
import { Z_LAYER } from "./FloatingLayer";
import { useT } from "../stores/language";

let rootInertCount = 0;

/**
 * Ref-counted `#root` inertness lock while at least one blocking modal is open.
 * Both `Modal` and `FloatingLayer` portal to `document.body`, so nested floating
 * menus/selects opened from inside a modal stay interactive while `#root` is inert.
 */
export function acquireRootInert(): () => void {
	if (typeof document === "undefined") return () => {};
	if (rootInertCount === 0) {
		document.getElementById("root")?.setAttribute("inert", "");
	}
	rootInertCount += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		rootInertCount = Math.max(0, rootInertCount - 1);
		if (rootInertCount === 0) {
			document.getElementById("root")?.removeAttribute("inert");
		}
	};
}

const FOCUSABLE_SELECTOR =
	'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const FLOATING_LAYER_SELECTOR = '[data-floating-layer], [data-layer]:not([data-layer="modal"])';

function isFocusableElement(el: HTMLElement, root: HTMLElement): boolean {
	if ((el as HTMLButtonElement).disabled) return false;
	if (el instanceof HTMLInputElement && el.type === "hidden") return false;
	if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return false;
	for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
		if (cur.hidden || cur.hasAttribute("inert")) return false;
		const style = getComputedStyle(cur);
		if (style.display === "none" || style.visibility === "hidden") return false;
		if (cur === root) break;
	}
	return true;
}

export type ModalSize = "sm" | "md" | "lg" | "xl" | "none";

/** Panel width per size; `none` leaves width entirely to `className`. */
const SIZE_CLASS: Record<ModalSize, string> = {
	sm: "w-full max-w-sm",
	md: "w-full max-w-md",
	lg: "w-full max-w-lg",
	xl: "w-full max-w-2xl",
	none: "",
};

export interface ModalProps {
	/** Called on backdrop click, Escape and the header close button. */
	onClose: () => void;
	/** Renders the standard header (title + close button). Omit for a headerless panel. */
	title?: ReactNode;
	/** Leading icon in the standard header. */
	icon?: ReactNode;
	/** Extra controls rendered in the header before the close button. */
	headerActions?: ReactNode;
	/** Panel width preset. Default `md`; use `none` to size the panel via `className`. */
	size?: ModalSize;
	/** Extra classes for the dialog panel (appended after the defaults). */
	className?: string;
	/** Accessible name when there is no `title` (or the title is not text). */
	ariaLabel?: string;
	/** Backdrop click closes the modal. Default true. */
	closeOnBackdrop?: boolean;
	/** Escape closes the modal. Default true. */
	closeOnEscape?: boolean;
	/** Blur the background behind the dialog. Default true. */
	backdropBlur?: boolean;
	/** Extra classes for the backdrop overlay. */
	backdropClassName?: string;
	children: ReactNode;
}

/**
 * Centered blocking dialog: portal to `document.body` on the modal tier
 * (docs/LAYERS.md), `role="dialog"` + `aria-modal`, backdrop click and Escape
 * (claimed via `useEscapeKey`) close it, and focus returns to the opener on close.
 * Children render below the standard header and should own their own padding/scroll.
 */
export function Modal({
	onClose,
	title,
	icon,
	headerActions,
	size = "md",
	className,
	ariaLabel,
	closeOnBackdrop = true,
	closeOnEscape = true,
	backdropBlur = true,
	backdropClassName,
	children,
}: ModalProps) {
	const { t } = useT();
	const titleId = useId();
	const backdropRef = useRef<HTMLDivElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const backdropPressedRef = useRef(false);
	// Captured during the first render, before any child `autoFocus` moves focus.
	const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement));
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEscapeKey(onClose, closeOnEscape);

	useEffect(() => {
		const releaseInert = acquireRootInert();
		const panel = panelRef.current;
		if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
		return () => {
			// Release #root inertness before returning focus so openers inside #root can receive focus.
			releaseInert();
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
		};
	}, [opener]);

	const handleTabKey = useCallback((e: KeyboardEvent) => {
		if (e.key !== "Tab" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
		const backdrop = backdropRef.current;
		const panel = panelRef.current;
		if (!backdrop || !panel) return;
		const modals = document.body.querySelectorAll('[data-layer="modal"]');
		if (modals[modals.length - 1] !== backdrop) return;
		const active = document.activeElement as HTMLElement | null;
		if (active?.closest?.(FLOATING_LAYER_SELECTOR)) return;

		const controls = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) =>
			isFocusableElement(el, panel),
		);
		if (controls.length === 0) {
			e.preventDefault();
			panel.focus({ preventScroll: true });
			return;
		}
		const first = controls[0];
		const last = controls[controls.length - 1];
		if (e.shiftKey) {
			if (
				active === first ||
				!active ||
				!panel.contains(active) ||
				active === panel ||
				(!controls.includes(active) &&
					!(first.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING))
			) {
				e.preventDefault();
				last.focus({ preventScroll: true });
			}
		} else if (
			active === last ||
			!active ||
			!panel.contains(active) ||
			active === panel ||
			(!controls.includes(active) &&
				!(active.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING))
		) {
			e.preventDefault();
			first.focus({ preventScroll: true });
		}
	}, []);

	useEffect(() => {
		window.addEventListener("keydown", handleTabKey);
		return () => window.removeEventListener("keydown", handleTabKey);
	}, [handleTabKey]);

	const hasTitle = title !== undefined && title !== null && title !== false;

	return createPortal(
		<div
			ref={backdropRef}
			data-layer="modal"
			style={{ zIndex: Z_LAYER.modal }}
			className={clsx(
				"fixed inset-0 flex items-center justify-center p-4",
				backdropBlur && "backdrop-blur-md",
				backdropClassName ?? "bg-[var(--overlay)]",
			)}
			onMouseDown={(e) => {
				backdropPressedRef.current = e.target === e.currentTarget;
			}}
			onClick={(e) => {
				const pressed = backdropPressedRef.current;
				backdropPressedRef.current = false;
				if (closeOnBackdrop && pressed && e.target === e.currentTarget) onCloseRef.current();
			}}
			onKeyDown={(e) => {
				if (e.key === "Tab") {
					handleTabKey(e.nativeEvent);
					// Prevent React event bubbling from reaching any underlying modal's Tab trap (e.g. SettingsOverlay).
					e.stopPropagation();
				}
			}}
		>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={hasTitle ? titleId : undefined}
				aria-label={hasTitle ? undefined : ariaLabel}
				tabIndex={-1}
				className={clsx(
					"flex max-h-[85vh] flex-col rounded-2xl bg-[var(--bg-panel)] shadow-apple-modal hairline outline-none",
					SIZE_CLASS[size],
					className,
				)}
			>
				{hasTitle && (
					<div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border-divider)] px-4 py-3">
						<div
							id={titleId}
							className="flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-[-0.018em] text-neutral-100"
						>
							{icon}
							<span className="min-w-0 break-words">{title}</span>
						</div>
						<div className="flex shrink-0 items-center gap-1">
							{headerActions}
							<button
								type="button"
								onClick={onClose}
								title={t("components.closeEsc")}
								aria-label={t("common.close")}
								className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-[var(--bg-hover)] hover:text-neutral-200"
							>
								<X className="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
				)}
				{children}
			</div>
		</div>,
		document.body,
	);
}

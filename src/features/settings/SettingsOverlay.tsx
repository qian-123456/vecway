import { useEffect, useRef } from "react";
import { Settings as SettingsIcon, X } from "lucide-react";
import { isEscapeClaimed } from "../../lib/escapeClaim";
import { isComposing } from "../../lib/hooks";
import { prefersReducedMotion, usePresence } from "../../lib/motion";
import { hideAllScrollPills } from "../../lib/scrollPills";
import { useUi } from "../../stores/ui";
import { useT } from "../../stores/language";
import { nestedModalOpen, useSettingsEscape } from "./nestedModal";
import { SettingsPage } from "./SettingsPage";

/**
 * Settings floating modal overlay.
 * Renders centered over the workbench, preserving the underlying view.
 */
const SETTINGS_EXIT_MS = 165;

/**
 * Settings floating modal overlay.
 * Renders centered over the workbench, preserving the underlying view.
 */
export function SettingsOverlay({ open }: { open?: boolean } = {}) {
	const storeOpen = useUi((s) => s.centerView === "settings");
	const isSettingsOpen = open ?? storeOpen;
	const settingsInstant = useUi((s) => s.settingsInstant);
	const openInstantRef = useRef(settingsInstant);
	if (isSettingsOpen) {
		openInstantRef.current = settingsInstant;
	}
	const effectiveInstant = isSettingsOpen ? settingsInstant : openInstantRef.current;
	const { present, exiting } = usePresence(isSettingsOpen, SETTINGS_EXIT_MS, effectiveInstant);
	if (!present || (!isSettingsOpen && (effectiveInstant || prefersReducedMotion()))) return null;
	return <SettingsOverlayInner open={isSettingsOpen} exiting={exiting} instant={effectiveInstant} />;
}

function SettingsEscapeGuard({ onClose }: { onClose: () => void }) {
	useSettingsEscape(onClose);
	return null;
}

function SettingsOverlayInner({
	open,
	exiting,
	instant,
}: {
	open: boolean;
	exiting: boolean;
	instant: boolean;
}) {
	const { t } = useT();
	const closeSettings = useUi((s) => s.closeSettings);
	const dialogRef = useRef<HTMLDivElement>(null);

	// Focus management: focus dialog or first control when opened, restore on close/exit
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement;
		const target =
			dialogRef.current?.querySelector<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
			) ?? dialogRef.current;
		target?.focus();
		return () => {
			hideAllScrollPills();
			if (previous instanceof HTMLElement && previous.isConnected) {
				previous.focus();
			}
		};
	}, [open]);

	return (
		<div
			data-instant={instant ? "true" : undefined}
			data-exiting={exiting ? "true" : undefined}
			aria-hidden={exiting || undefined}
			inert={exiting}
			className={`apple-modal-backdrop fixed inset-0 z-(--z-modal) flex items-center justify-center bg-[var(--overlay)] backdrop-blur-md p-3 md:p-6${exiting ? " pointer-events-none" : ""}`}
			onMouseDown={(e) => {
				if (exiting) return;
				if (e.target === e.currentTarget) closeSettings();
			}}
		>
			{open && <SettingsEscapeGuard onClose={closeSettings} />}
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal={exiting ? undefined : "true"}
				aria-labelledby="settings-dialog-title"
				tabIndex={-1}
				data-instant={instant ? "true" : undefined}
				data-exiting={exiting ? "true" : undefined}
				className="apple-modal-panel apple-modal-surface flex h-[80vh] max-h-[820px] w-[920px] max-w-[calc(100vw-1.5rem)] md:max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl text-neutral-200 shadow-apple-modal hairline outline-none"
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					if (exiting) return;
					if (isComposing(e)) return;
					// Escape key closes settings
					if (e.key === "Escape") {
						// A nested dialog (portaled, so its keydown bubbles here) owns this Esc.
						if (isEscapeClaimed(e.nativeEvent) || nestedModalOpen()) return;
						e.stopPropagation();
						closeSettings();
						return;
					}

					// Focus trap across accessible controls inside dialog
					if (e.key === "Tab") {
						const controls = Array.from(
							e.currentTarget.querySelectorAll<HTMLElement>(
								'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
							),
						).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

						if (controls.length > 0) {
							const first = controls[0];
							const last = controls[controls.length - 1];
							if (
								e.shiftKey &&
								(document.activeElement === first ||
									!controls.includes(document.activeElement as HTMLElement))
							) {
								e.preventDefault();
								last?.focus();
							} else if (
								!e.shiftKey &&
								(document.activeElement === last ||
									!controls.includes(document.activeElement as HTMLElement))
							) {
								e.preventDefault();
								first?.focus();
							}
						}
					}

					// Suppress global app hotkeys (Cmd+Shift+K, Cmd+B, Cmd+J, Cmd+N, etc.) while inside settings
					if (e.metaKey || e.ctrlKey) {
						e.stopPropagation();
					}
				}}
			>
				{/* Top bar */}
				<div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-divider)] px-4">
					<div className="flex items-center gap-2 text-xs font-semibold text-neutral-200 tracking-[-0.01em]">
						<SettingsIcon className="h-4 w-4 text-amber-400" />
						<span id="settings-dialog-title">{t("settings.title")}</span>
					</div>
					<button
						type="button"
						onClick={closeSettings}
						className="press-scale flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-[var(--bg-hover)] hover:text-neutral-100"
						title={`${t("common.close")} (Esc)`}
						aria-label={t("common.close")}
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{/* Body */}
				<div className="min-h-0 flex-1 overflow-hidden">
					<SettingsPage onClose={closeSettings} />
				</div>
			</div>
		</div>
	);
}

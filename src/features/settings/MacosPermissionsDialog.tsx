import {
	AlertCircle,
	AppWindow,
	CheckCircle2,
	ExternalLink,
	FolderOpen,
	HelpCircle,
	RefreshCw,
	ShieldCheck,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../../components/Modal";
import { errMsg } from "../../lib/dialogs";
import {
	macosOpenPermissionPane,
	macosPermissionsStatus,
	macosRevealCurrentApp,
	type MacosPermissionEntry,
	type MacosPermissionId,
	type MacosPermissionState,
	type MacosPermissionsStatus,
} from "../../lib/ipc";
import { useT } from "../../stores/language";
import { Button, Chip } from "./ui";

const PERMISSION_ORDER: readonly MacosPermissionId[] = [
	"accessibility",
	"screenRecording",
	"fullDiskAccess",
	"localNetwork",
	"developerTools",
];

const FALLBACK_ENTRIES: readonly MacosPermissionEntry[] = [
	{ id: "accessibility", state: "unknown", canPrompt: true },
	{ id: "screenRecording", state: "unknown", canPrompt: true },
	{ id: "fullDiskAccess", state: "unknown", canPrompt: false },
	{ id: "localNetwork", state: "unknown", canPrompt: false },
	{ id: "developerTools", state: "unknown", canPrompt: false },
];

export interface MacosPermissionsDialogProps {
	onClose: () => void;
	initialStatus?: MacosPermissionsStatus | null;
	onStatusChange?: (status: MacosPermissionsStatus) => void;
}

function statusBadgeProps(
	state: MacosPermissionState,
	t: (key: string) => string,
): { tone: "success" | "warning" | "neutral"; icon: typeof CheckCircle2; label: string } {
	switch (state) {
		case "granted":
			return {
				tone: "success",
				icon: CheckCircle2,
				label: t("settingsSections.general.permissionsDialog.statusGranted"),
			};
		case "denied":
			return {
				tone: "warning",
				icon: AlertCircle,
				label: t("settingsSections.general.permissionsDialog.statusDenied"),
			};
		case "unknown":
			return {
				tone: "neutral",
				icon: HelpCircle,
				label: t("settingsSections.general.permissionsDialog.statusManual"),
			};
	}
}

export function MacosPermissionsDialog({
	onClose,
	initialStatus = null,
	onStatusChange,
}: MacosPermissionsDialogProps) {
	const { t } = useT();
	const [status, setStatus] = useState<MacosPermissionsStatus | null>(initialStatus);
	const [checking, setChecking] = useState(false);
	const [revealing, setRevealing] = useState(false);
	const [openingId, setOpeningId] = useState<MacosPermissionId | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reqSeq = useRef(0);
	const mountedRef = useRef(true);
	const onStatusChangeRef = useRef(onStatusChange);
	onStatusChangeRef.current = onStatusChange;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const refresh = useCallback(async () => {
		const seq = ++reqSeq.current;
		setChecking(true);
		try {
			const next = await macosPermissionsStatus();
			if (!mountedRef.current || seq !== reqSeq.current) return;
			setStatus(next);
			setError(null);
			onStatusChangeRef.current?.(next);
		} catch (err) {
			if (!mountedRef.current || seq !== reqSeq.current) return;
			setError(t("settingsSections.general.permissionsDialog.loadFailed", { error: errMsg(err) }));
		} finally {
			if (mountedRef.current && seq === reqSeq.current) setChecking(false);
		}
	}, [t]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		const onFocus = () => {
			void refresh();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	const handleReveal = async () => {
		if (revealing) return;
		setRevealing(true);
		setError(null);
		try {
			await macosRevealCurrentApp();
		} catch (err) {
			if (mountedRef.current) {
				setError(t("settingsSections.general.permissionsDialog.revealFailed", { error: errMsg(err) }));
			}
		} finally {
			if (mountedRef.current) setRevealing(false);
		}
	};

	const handleOpenPane = async (id: MacosPermissionId, prompt = false) => {
		setOpeningId(id);
		setError(null);
		try {
			if (prompt) {
				await macosOpenPermissionPane(id, true);
			} else {
				await macosOpenPermissionPane(id);
			}
		} catch (err) {
			if (mountedRef.current) {
				setError(t("settingsSections.general.permissionsDialog.openFailed", { error: errMsg(err) }));
			}
		} finally {
			if (mountedRef.current) setOpeningId(null);
		}
	};

	const appName = status?.appName || "Vecway";
	const appPath = status?.appPath ?? null;
	const entryMap = new Map((status?.permissions ?? FALLBACK_ENTRIES).map((e) => [e.id, e]));
	const entries = PERMISSION_ORDER.map(
		(id) => entryMap.get(id) ?? FALLBACK_ENTRIES.find((e) => e.id === id)!,
	);

	return (
		<Modal
			size="lg"
			onClose={onClose}
			ariaLabel={t("settingsSections.general.permissionsDialog.title")}
			className="max-w-xl"
		>
			{/* Header */}
			<div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border-divider)] px-5 py-4">
				<div className="flex min-w-0 items-start gap-3">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]">
						<ShieldCheck className="h-5 w-5" />
					</div>
					<div className="min-w-0">
						<h2 className="text-sm font-semibold leading-5 tracking-[-0.015em] text-[var(--text)]">
							{t("settingsSections.general.permissionsDialog.title")}
						</h2>
						<p className="mt-0.5 text-xs leading-4 text-[var(--text-60)]">
							{t("settingsSections.general.permissionsDialog.subtitle", { appName })}
						</p>
					</div>
				</div>
				<button
					type="button"
					onClick={onClose}
					title={t("components.closeEsc")}
					aria-label={t("common.close")}
					className="shrink-0 rounded-md p-1 text-[var(--text-40)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			{/* Scrollable body */}
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
				{/* App locator strip */}
				<div className="rounded-xl hairline bg-[var(--well-bg)] px-3.5 py-2.5">
					<div className="flex items-center justify-between gap-3">
						<div className="flex min-w-0 items-center gap-2">
							<AppWindow className="h-4 w-4 shrink-0 text-[var(--accent)]" />
							<span className="truncate text-xs font-semibold text-[var(--text)]">{appName}</span>
						</div>
						<Button
							size="sm"
							variant="secondary"
							icon={FolderOpen}
							loading={revealing}
							onClick={() => void handleReveal()}
						>
							{t("settingsSections.general.permissionsDialog.revealInFinder")}
						</Button>
					</div>
					<div className="mt-1.5 select-text break-all font-mono text-[11px] leading-4 text-[var(--text-60)]">
						{appPath ?? t("settingsSections.general.permissionsDialog.pathFallback")}
					</div>
					<p className="mt-1.5 text-[11px] leading-4 text-[var(--text-40)]">
						{t("settingsSections.general.permissionsDialog.revealTip")}
					</p>
				</div>

				{error && (
					<div
						role="alert"
						className="rounded-lg border border-[color-mix(in_srgb,var(--status-error)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)] px-3 py-2 text-xs text-[var(--status-error)]"
					>
						{error}
					</div>
				)}

				{/* 5 permission rows */}
				<div className="divide-y divide-[var(--border-divider)]">
					{entries.map((entry) => {
						const badge = statusBadgeProps(entry.state, t);
						const showRequest = entry.canPrompt && entry.state === "denied";
						const isBusy = openingId === entry.id;
						const title = t(`settingsSections.general.permissionsDialog.items.${entry.id}.title`);
						const desc = t(`settingsSections.general.permissionsDialog.items.${entry.id}.desc`);

						return (
							<div
								key={entry.id}
								data-permission-id={entry.id}
								className="flex items-center justify-between gap-4 py-3 first:pt-1 last:pb-1"
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-[13px] font-medium leading-5 text-[var(--text)]">
											{title}
										</span>
										<Chip tone={badge.tone} icon={badge.icon}>
											{badge.label}
										</Chip>
									</div>
									<p className="mt-0.5 text-xs leading-[18px] text-[var(--text-60)]">{desc}</p>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									{showRequest && (
										<Button
											size="sm"
											variant="secondary"
											loading={isBusy}
											onClick={() => void handleOpenPane(entry.id, true)}
										>
											{t("settingsSections.general.permissionsDialog.requestAccess")}
										</Button>
									)}
									<Button
										size="sm"
										variant="secondary"
										icon={ExternalLink}
										loading={isBusy}
										aria-label={`${t("settingsSections.general.permissionsDialog.openSettings")} - ${title}`}
										onClick={() => void handleOpenPane(entry.id)}
									>
										{t("settingsSections.general.permissionsDialog.openSettings")}
									</Button>
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/* Footer */}
			<div className="flex shrink-0 items-center justify-between border-t border-[var(--border-divider)] px-5 py-3">
				<Button
					size="sm"
					variant="secondary"
					icon={RefreshCw}
					loading={checking}
					onClick={() => void refresh()}
				>
					{t("settingsSections.general.permissionsDialog.recheck")}
				</Button>
				<Button size="sm" variant="primary" onClick={onClose}>
					{t("settingsSections.general.permissionsDialog.done")}
				</Button>
			</div>
		</Modal>
	);
}

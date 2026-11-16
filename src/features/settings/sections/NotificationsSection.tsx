/** Settings ▸ 通知 (`notifications`): when to notify, how, and quiet hours. */
import clsx from "clsx";
import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errMsg } from "../../../lib/dialogs";
import { claimEscape } from "../../../lib/escapeClaim";
import { isComposing } from "../../../lib/hooks";
import { notifyTest } from "../../../lib/ipc";
import { tNow, useT } from "../../../stores/language";
import { saveAppSettings, useAppSettings } from "../useAppSettings";
import { Notice } from "../../../components/Notice";
import {
	Button,
	INPUT_CLASS,
	SectionHeader,
	SettingRow,
	SettingsCard,
	ToggleRow,
	useSaveStatus,
} from "../ui";
type TestResult = { ok: true; at: string } | { ok: false; error: string } | null;

export function NotificationsSection() {
	const { t, locale } = useT();
	const { settings, save } = useAppSettings();
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<TestResult>(null);

	const handleNotifyTest = async () => {
		setTesting(true);
		setTestResult(null);
		try {
			await notifyTest();
			setTestResult({ ok: true, at: new Date().toLocaleTimeString(locale, { hour12: false }) });
		} catch (err) {
			setTestResult({ ok: false, error: errMsg(err) });
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="space-y-6">
			<SectionHeader title={t("notifications.title")} description={t("notifications.desc")} />

			<SettingsCard title={t("notifications.whenTitle")}>
				<ToggleRow
					fieldId="notifyTurnEnd"
					label={t("notifications.notifyTurnEnd")}
					description={t("notifications.notifyTurnEndDesc")}
					checked={settings?.notifyTurnEnd ?? true}
					onChange={(v) => save({ notifyTurnEnd: v })}
				/>
				<ToggleRow
					fieldId="notifyApproval"
					label={t("notifications.notifyApproval")}
					description={t("notifications.notifyApprovalDesc")}
					checked={settings?.notifyApproval ?? true}
					onChange={(v) => save({ notifyApproval: v })}
				/>
				<ToggleRow
					fieldId="notifyExit"
					label={t("notifications.notifyExit")}
					description={t("notifications.notifyExitDesc")}
					checked={settings?.notifyExit ?? true}
					onChange={(v) => save({ notifyExit: v })}
				/>
			</SettingsCard>

			<SettingsCard title={t("notifications.howTitle")}>
				<ToggleRow
					fieldId="notifySound"
					label={t("notifications.notifySound")}
					description={t("notifications.notifySoundDesc")}
					checked={settings?.notifySound ?? true}
					onChange={(v) => save({ notifySound: v })}
				/>
				<ToggleRow
					fieldId="dockBadgeEnabled"
					label={t("notifications.dockBadgeEnabled")}
					description={t("notifications.dockBadgeEnabledDesc")}
					checked={settings?.dockBadgeEnabled ?? true}
					onChange={(v) => save({ dockBadgeEnabled: v })}
				/>
				<SettingRow
					fieldId="notifyTest"
					label={t("notifications.notifyTest")}
					description={t("notifications.notifyTestDesc")}
					control={
						<Button icon={Bell} loading={testing} onClick={handleNotifyTest}>
							{testing ? t("notifications.testSending") : t("notifications.testSend")}
						</Button>
					}
				>
					{testResult?.ok && (
						<Notice tone="success" title={t("notifications.testSentTitle", { time: testResult.at })}>
							{t("notifications.testSentHelp")}
						</Notice>
					)}
					{testResult && !testResult.ok && <Notice tone="danger" title={t("notifications.testFailedTitle", { error: testResult.error })} />}
				</SettingRow>
			</SettingsCard>

			<SettingsCard title={t("notifications.quietTitle")}>
				<QuietHoursRow />
			</SettingsCard>
		</div>
	);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const QUIET_PRESETS = [
	{ from: "22:00", to: "08:00" },
	{ from: "23:00", to: "07:00" },
	{ from: "00:00", to: "08:00" },
] as const;

/** Format 4-digit ("2200" -> "22:00"), 3-digit ("800" -> "08:00"), or single-hour ("8:00" -> "08:00") shorthand when valid. */
function formatTimeShorthand(raw: string): string {
	const s = raw.trim();
	if (!s) return "";
	if (/^\d{4}$/.test(s)) {
		const candidate = `${s.slice(0, 2)}:${s.slice(2)}`;
		return HHMM.test(candidate) ? candidate : s;
	}
	if (/^\d{3}$/.test(s)) {
		const candidate = `0${s[0]}:${s.slice(1)}`;
		return HHMM.test(candidate) ? candidate : s;
	}
	const singleHour = s.match(/^(\d):([0-5]\d)$/);
	if (singleHour) {
		const candidate = `0${singleHour[1]}:${singleHour[2]}`;
		return HHMM.test(candidate) ? candidate : s;
	}
	return s;
}

/** Validation message for a quiet-hours pair, or null when it can be saved. */
function quietHoursError(from: string, to: string, tr: (key: string) => string = tNow): string | null {
	if (!from && !to) return null;
	if (!from || !to) return tr("notifications.quietBothRequired");
	if (!HHMM.test(from) || !HHMM.test(to)) return tr("notifications.quietInvalidFormat");
	if (from === to) return tr("notifications.quietSameTime");
	return null;
}

/** Human summary of a saved quiet-hours window. */
function quietHoursSummary(from: string, to: string, tr: (key: string, params?: Record<string, string | number>) => string = tNow): string {
	if (!from || !to) return tr("notifications.quietDisabled");
	return from < to
		? tr("notifications.quietDaily", { from, to })
		: tr("notifications.quietOvernight", { from, to });
}

/** Patch to persist, or null when invalid or unchanged. */
function quietHoursPatch(f: string, t: string, savedFrom: string, savedTo: string) {
	if (quietHoursError(f, t)) return null;
	if (f === savedFrom && t === savedTo) return null;
	return { notifyQuietFrom: f || null, notifyQuietTo: t || null };
}

/** Quiet hours: both ends must be set together; commits on blur and on unmount. */
function QuietHoursRow() {
	const { t } = useT();
	const { settings, save } = useAppSettings();
	const status = useSaveStatus();
	const savedFrom = settings?.notifyQuietFrom ?? "";
	const savedTo = settings?.notifyQuietTo ?? "";
	const [from, setFrom] = useState(savedFrom);
	const [to, setTo] = useState(savedTo);
	const [touched, setTouched] = useState(false);

	useEffect(() => {
		setFrom(savedFrom);
		setTo(savedTo);
		setTouched(false);
	}, [savedFrom, savedTo]);

	const latest = useRef({ from, to, savedFrom, savedTo });
	latest.current = { from, to, savedFrom, savedTo };
	const escapingRef = useRef(false);
	useEffect(
		() => () => {
			const l = latest.current;
			const patch = quietHoursPatch(
				formatTimeShorthand(l.from),
				formatTimeShorthand(l.to),
				l.savedFrom,
				l.savedTo,
			);
			if (patch) void saveAppSettings(patch).catch(() => {});
		},
		[],
	);

	const commit = (f: string, tStr: string) => {
		const nf = formatTimeShorthand(f);
		const nt = formatTimeShorthand(tStr);
		if (nf !== f) setFrom(nf);
		if (nt !== tStr) setTo(nt);
		setTouched(true);
		const patch = quietHoursPatch(nf, nt, savedFrom, savedTo);
		if (patch) void status.run(() => save(patch));
	};

	const revert = (target: HTMLInputElement) => {
		escapingRef.current = true;
		setFrom(savedFrom);
		setTo(savedTo);
		setTouched(false);
		target.blur();
	};

	const handleBlur = () => {
		if (escapingRef.current) {
			escapingRef.current = false;
			return;
		}
		commit(from, to);
	};

	const error = touched ? quietHoursError(from, to, t) : null;
	const enabled = Boolean(savedFrom && savedTo);
	const timeClass = `${INPUT_CLASS} w-28 px-2.5 font-mono tabular-nums`;

	return (
		<SettingRow
			fieldId="notifyQuiet"
			stacked
			label={t("notifications.quietHours")}
			description={t("notifications.quietHoursDesc")}
			status={status.status}
			statusError={status.error}
			control={
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<input
							type="text"
							inputMode="numeric"
							maxLength={5}
							placeholder="22:00"
							aria-label={t("notifications.quietFromAria")}
							value={from}
							onChange={(e) => setFrom(e.target.value)}
							onBlur={handleBlur}
							onKeyDown={(e) => {
								if (isComposing(e)) return;
								if (e.key === "Enter") {
									e.preventDefault();
									commit(from, to);
								} else if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									claimEscape(e);
									revert(e.currentTarget);
								}
							}}
							className={timeClass}
						/>
						<span className="text-xs text-[var(--text-dim)]">{t("notifications.quietTo")}</span>
						<input
							type="text"
							inputMode="numeric"
							maxLength={5}
							placeholder="08:00"
							aria-label={t("notifications.quietToAria")}
							value={to}
							onChange={(e) => setTo(e.target.value)}
							onBlur={handleBlur}
							onKeyDown={(e) => {
								if (isComposing(e)) return;
								if (e.key === "Enter") {
									e.preventDefault();
									commit(from, to);
								} else if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									claimEscape(e);
									revert(e.currentTarget);
								}
							}}
							className={timeClass}
						/>
						{(enabled || from || to) && (
							<Button
								size="sm"
								variant="secondary"
								onClick={() => {
									setFrom("");
									setTo("");
									commit("", "");
								}}
							>
								{t("notifications.quietTurnOff")}
							</Button>
						)}
					</div>
					<div role="group" aria-label={t("notifications.quietPresetsAria")} className="flex flex-wrap items-center gap-1.5">
						{QUIET_PRESETS.map((preset) => {
							const active = from === preset.from && to === preset.to && savedFrom === preset.from && savedTo === preset.to;
							return (
								<button
									key={`${preset.from}-${preset.to}`}
									type="button"
									aria-pressed={active}
									onClick={() => {
										setFrom(preset.from);
										setTo(preset.to);
										commit(preset.from, preset.to);
									}}
									className={clsx(
										"rounded-full hairline px-2.5 py-0.5 font-mono text-[11px] whitespace-nowrap cursor-pointer transition-colors",
										active
											? "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)] ring-1 ring-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
											: "bg-[var(--well-bg)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
									)}
								>
									{preset.from}–{preset.to}
								</button>
							);
						})}
					</div>
					{error ? (
						<div className="text-[11px] text-[var(--status-error)]">{error}</div>
					) : (
						<div className={`text-[11px] ${enabled ? "text-[var(--accent)]" : "text-[var(--text-dim)]"}`}>
							{quietHoursSummary(savedFrom, savedTo, t)}
						</div>
					)}
				</div>
			}
		/>
	);
}

/**
 * Settings ▸ 通用 (`general`): new-session defaults, automation, UI switches,
 * Git delivery, plus the omp 系统 section (sleep prevention).
 */
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SUPPORTED_LOCALES, type Locale } from "../../../lib/i18n";
import { useT } from "../../../stores/language";
import { InfoTip } from "../../../components/InfoTip";
import { Segmented } from "../../../components/Segmented";
import { macosPermissionsStatus, ompConfigSet, type MacosPermissionsStatus } from "../../../lib/ipc";
import { toModelKey } from "../../../lib/models";
import { formatShortModel } from "../../chat/turnGrouping";
import { asRecord, roleValue, splitRoleValue } from "../modelRoles";
import { useOmpConfigStore } from "../ompConfigStore";
import { useSettingsNav } from "../settingsNav";
import { openSettingsTarget } from "../settingsTargets";
import { useAppSettings, useCatalogModels } from "../useAppSettings";
import { OmpSections } from "../OmpSettingsList";
import {
	Button,
	Chip,
	SectionHeader,
	SettingRow,
	SettingsCard,
	ToggleRow,
	useSaveStatus,
} from "../ui";
import { SectionJumpBar } from "../SectionJumpBar";
import { MacosPermissionsDialog } from "../MacosPermissionsDialog";

type ApprovalMode = "always-ask" | "write" | "yolo";
const AUTOMATION_OVERLAP_POLICIES = ["skip", "coalesce", "queue", "parallel"] as const;


export function GeneralSection() {
	const { locale, setLocale, t } = useT();
	const { settings, save } = useAppSettings();
	const { models } = useCatalogModels();
	const { navigate } = useSettingsNav();
	const approvalSave = useSaveStatus();
	const overlapSave = useSaveStatus();
	const ompEntries = useOmpConfigStore((s) => s.entries);
	const ompLoaded = useOmpConfigStore((s) => s.loaded);
	const loadOmp = useOmpConfigStore((s) => s.load);

	const [permStatus, setPermStatus] = useState<MacosPermissionsStatus | null>(null);
	const [permissionsOpen, setPermissionsOpen] = useState(false);

	useEffect(() => {
		let alive = true;
		const load = () => {
			macosPermissionsStatus()
				.then((s) => {
					if (alive) setPermStatus(s);
				})
				.catch(() => {
					// Ignore when Tauri IPC is unavailable (e.g. non-Tauri unit tests)
				});
		};
		load();
		window.addEventListener("focus", load);
		return () => {
			alive = false;
			window.removeEventListener("focus", load);
		};
	}, []);

	const deniedCount = permStatus?.permissions.filter((p) => p.state === "denied").length ?? 0;
	// Cache last known default role in localStorage so frame 1 renders accurately
	const [cachedRole, setCachedRole] = useState<string | null>(() => {
		try {
			return localStorage.getItem("ompws:cached-default-role");
		} catch {
			return null;
		}
	});

	useEffect(() => {
		void loadOmp();
	}, [loadOmp]);

	// ── Global default model (OMP modelRoles.default) ──
	const currentRoles = asRecord(ompEntries.find((e) => e.key === "modelRoles")?.value);
	const liveRole = roleValue(currentRoles, "default");
	const defaultRole = (ompLoaded ? liveRole : (cachedRole ?? liveRole)) ?? null;

	useEffect(() => {
		if (ompLoaded && liveRole) {
			try {
				localStorage.setItem("ompws:cached-default-role", liveRole);
				setCachedRole(liveRole);
			} catch {
				/* ignore */
			}
		}
	}, [ompLoaded, liveRole]);

	const defaultSelector = defaultRole ? splitRoleValue(defaultRole).selector : "";
	const matchedModel = models.find((m) => toModelKey(m.provider, m.id) === defaultSelector);
	const fallbackShortName = defaultSelector ? formatShortModel(defaultSelector) : "";
	// ModelSelect appends " · <level>" itself when currentValue carries a suffix.
	const modelLabel = defaultRole
		? (matchedModel?.id ?? (fallbackShortName || defaultRole))
		: (ompLoaded ? t("settingsSections.general.defaultModelOmpBuiltin") : t("settingsSections.general.loading"));

	const approvalOptions: { value: ApprovalMode; label: string; desc: string }[] = useMemo(
		() => [
			{
				value: "always-ask",
				label: t("settingsSections.general.approvalAlwaysAskLabel"),
				desc: t("settingsSections.general.approvalAlwaysAskDesc"),
			},
			{
				value: "write",
				label: t("settingsSections.general.approvalWriteLabel"),
				desc: t("settingsSections.general.approvalWriteDesc"),
			},
			{
				value: "yolo",
				label: t("settingsSections.general.approvalYoloLabel"),
				desc: t("settingsSections.general.approvalYoloDesc"),
			},
		],
		[t],
	);

	const approval = (settings?.defaultApprovalMode ?? "write") as ApprovalMode;
	const currentApprovalOption = approvalOptions.find((o) => o.value === approval) ?? approvalOptions[1];
	const overlapPolicy = settings?.automationOverlapPolicy ?? "skip";
	return (
		<div className="space-y-6">
			<SectionHeader title={t("settingsSections.general.title")} description={t("settingsSections.general.description")} />
			<SectionJumpBar />

			<SettingsCard jump={t("settingsSections.general.jumpNewSession")} title={t("settingsSections.general.titleNewSession")}>
				<SettingRow
					fieldId="newSessionModel"
					label={t("settingsSections.general.defaultModelLabel")}
					description={t("settingsSections.general.defaultModelDesc")}
					control={
						<div className="flex min-w-0 items-center gap-2">
							<span className="min-w-0 truncate text-xs text-[var(--text-muted)]" title={defaultRole ?? undefined}>
								{modelLabel}
							</span>
							<Button size="sm" variant="ghost" onClick={() => openSettingsTarget("models")}>
								{t("settingsSections.general.goToModelRoles")}
								<ChevronRight className="h-3 w-3" />
							</Button>
						</div>
					}
				/>

				<SettingRow
					fieldId="defaultApprovalMode"
					label={t("settingsSections.general.approvalModeLabel")}
					description={currentApprovalOption.desc}
					status={approvalSave.status}
					statusError={approvalSave.error}
					control={
						<Segmented
							value={approval}
							onChange={(v) =>
								void approvalSave.run(async () => {
									await save({ defaultApprovalMode: v });
									try {
										await ompConfigSet("tools.approvalMode", v);
										await loadOmp(true);
									} catch {
										// Ignore if omp tool schema differs
									}
								})
							}
							options={approvalOptions.map((o) => ({
								value: o.value,
								title: o.desc,
								label:
									o.value === "yolo" ? (
										<span className="inline-flex items-center gap-1 text-[var(--status-warning)]">
											<AlertTriangle className="h-3 w-3" />
											{o.label}
										</span>
									) : (
										o.label
									),
							}))}
						/>
					}
				/>

				<SettingRow
					fieldId="agentsMdShortcut"
					label={t("settingsSections.general.agentsMdLabel")}
					description={t("settingsSections.general.agentsMdDesc")}
					control={
						<Button size="sm" variant="ghost" onClick={() => navigate("agents-md")}>
							{t("settingsSections.general.goToRulesFiles")}
							<ChevronRight className="h-3 w-3" />
						</Button>
					}
				/>
			</SettingsCard>

			<SettingsCard jump={t("settingsSections.general.titleAutomation")} title={t("settingsSections.general.titleAutomation")}>
				<SettingRow
					fieldId="automationOverlapPolicy"
					label={
						<span className="inline-flex items-center gap-1.5">
							<span>{t("settingsSections.general.overlapPolicyLabel")}</span>
							<InfoTip text={t("settingsSections.general.overlapPolicyHint")} />
						</span>
					}
					stacked
					description={t(`settingsSections.general.overlap.${overlapPolicy}.description`)}
					status={overlapSave.status}
					statusError={overlapSave.error}
					control={
						<Segmented
							aria-label={t("settingsSections.general.overlapPolicyLabel")}
							value={overlapPolicy}
							disabled={!settings || overlapSave.status === "saving"}
							onChange={(value) => void overlapSave.run(() => save({ automationOverlapPolicy: value }))}
							options={AUTOMATION_OVERLAP_POLICIES.map((value) => ({
								value,
								label: t(`settingsSections.general.overlap.${value}.label`),
								title: t(`settingsSections.general.overlap.${value}.description`),
							}))}
						/>
					}
				/>
				<SettingRow
					label={t("settingsSections.automations.moreShortcutLabel")}
					description={t("settingsSections.automations.moreShortcutDesc")}
					control={
						<Button size="sm" variant="ghost" onClick={() => navigate("automations")}>
							{t("settingsSections.automations.openSectionBtn")}
							<ChevronRight className="h-3 w-3" />
						</Button>
					}
				/>
			</SettingsCard>

			<SettingsCard jump={t("settingsSections.general.jumpUi")} title={t("settingsSections.general.titleUi")}>
				<SettingRow
					fieldId="language"
					label={t("settings.language")}
					description={t("settings.languageDesc")}
					control={
						<Segmented
							aria-label={t("settings.language")}
							value={locale}
							onChange={(val) => setLocale(val as Locale)}
							options={SUPPORTED_LOCALES.map((l) => ({ value: l.value, label: l.nativeLabel }))}
						/>
					}
				/>
				<ToggleRow
					fieldId="capsuleVisible"
					label={t("settingsSections.general.capsuleLabel")}
					description={t("settingsSections.general.capsuleDesc")}
					checked={settings?.capsuleVisible ?? true}
					onChange={(v) => save({ capsuleVisible: v })}
				/>
				<ToggleRow
					fieldId="windowWorktreeTitle"
					label={t("settingsSections.general.windowWorktreeTitleLabel")}
					description={t("settingsSections.general.windowWorktreeTitleDesc")}
					checked={settings?.windowWorktreeTitle ?? true}
					onChange={(v) => save({ windowWorktreeTitle: v })}
				/>
				<ToggleRow
					fieldId="smartContextRouting"
					label={t("settingsSections.general.smartContextRoutingLabel")}
					description={t("settingsSections.general.smartContextRoutingDesc")}
					checked={settings?.smartContextRouting ?? true}
					onChange={(v) => save({ smartContextRouting: v })}
				/>
			</SettingsCard>

			<SettingsCard jump={t("settingsSections.general.jumpGit")} title={t("settingsSections.general.titleGit")}>
				<SettingRow
					fieldId="gitDeliveryMode"
					label={t("settingsSections.general.gitDeliveryModeLabel")}
					description={t("settingsSections.general.gitDeliveryModeDesc")}
					hint={t("settingsSections.general.gitDeliveryModeHint")}
					control={
						<Segmented
							value={(settings?.gitDeliveryMode as "pr" | "direct") ?? "pr"}
							onChange={(v) => void save({ gitDeliveryMode: v })}
							options={[
								{
									value: "pr",
									label: t("settingsSections.general.gitDeliveryPrLabel"),
									title: t("settingsSections.general.gitDeliveryPrTitle"),
								},
								{
									value: "direct",
									label: t("settingsSections.general.gitDeliveryDirectLabel"),
									title: t("settingsSections.general.gitDeliveryDirectTitle"),
								},
							]}
						/>
					}
				/>
			</SettingsCard>
			{permStatus?.supported && (
				<SettingsCard
					jump={t("settingsSections.general.macosPermissionsJump")}
					title={t("settingsSections.general.macosPermissionsTitle")}
				>
					<SettingRow
						fieldId="macosPermissions"
						label={t("settingsSections.general.macosPermissionsLabel")}
						description={t("settingsSections.general.macosPermissionsDesc")}
						control={
							<div className="flex items-center gap-2">
								<Chip tone={deniedCount > 0 ? "warning" : "success"}>
									{deniedCount > 0
										? t("settingsSections.general.macosPermissionsSummaryAttention", { count: deniedCount })
										: t("settingsSections.general.macosPermissionsSummaryReady")}
								</Chip>
								<Button size="sm" variant="secondary" onClick={() => setPermissionsOpen(true)}>
									{t("settingsSections.general.macosPermissionsManage")}
								</Button>
							</div>
						}
					/>
				</SettingsCard>
			)}


			<SettingsCard jump={t("settingsSections.general.troubleshootingTitle")} title={t("settingsSections.general.troubleshootingTitle")}>
				<ToggleRow
					fieldId="diagnosticsEnabled"
					label={
						<span className="inline-flex items-center gap-1.5">
							<span className="whitespace-nowrap">{t("settingsSections.general.diagnosticsLabel")}</span>
							<span onClick={(e) => e.stopPropagation()} className="inline-flex items-center">
								<InfoTip text={t("settingsSections.general.diagnosticsDesc")} />
							</span>
						</span>
					}
					checked={settings?.diagnosticsEnabled ?? true}
					disabled={!settings}
					onChange={(v) => save({ diagnosticsEnabled: v })}
				/>
			</SettingsCard>

			<OmpSections page="general" />
			{permissionsOpen && (
				<MacosPermissionsDialog
					initialStatus={permStatus}
					onStatusChange={setPermStatus}
					onClose={() => setPermissionsOpen(false)}
				/>
			)}
		</div>
	);
}

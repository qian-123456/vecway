/** Settings ▸ 模型与供应商 (`providers`): API keys / provider catalog and subscription quota tabs. */
import { ArrowLeft, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { Segmented } from "../../../components/Segmented";
import { ProviderPanel } from "../../providers/ProviderPanel";
import { useProviders } from "../../providers/store";
import { OmpSections } from "../OmpSettingsList";
import { SectionJumpBar } from "../SectionJumpBar";
import { ompSectionFor } from "../ompPlacement";
import { useSettingsNav } from "../settingsNav";
import { openSettingsTarget } from "../settingsTargets";
import { Button, SectionHeader } from "../ui";
import { useT } from "../../../stores/language";
import { QuotaDashboardCard } from "./QuotaDashboardCard";
import { RawFilesDialog } from "./RawFilesDialog";
import { CalendarHeatmap } from "../../home/CalendarHeatmap";
import { useServiceModelConfiguration } from "../../../stores/modelKinds";
import { useUi } from "../../../stores/ui";

type Tab = "config" | "other-models" | "quota";

/** Tab that hosts a deep-link target (omp key placed on the quota slot, or the quota dashboard itself). */
function tabForFocus(focusKey: string | null): Tab | null {
	if (!focusKey) return null;
	if (focusKey === "quotaDashboard") return "quota";
	if (focusKey === "otherModels") return "other-models";
	if (focusKey.startsWith("provider:")) return "config";
	if (focusKey === "providerList") return "config";
	const slot = ompSectionFor(focusKey).slot;
	if (slot === "quota") return "quota";
	if (slot === "keys") return "config";
	return null;
}

export function ProvidersSection() {
	const { t } = useT();
	const { focusKey, focusRequest } = useSettingsNav();
	const [tab, setTab] = useState<Tab>(() => tabForFocus(focusKey) ?? "config");
	const [rawOpen, setRawOpen] = useState(false);
	const configurationOrigin = useServiceModelConfiguration((s) => s.origin);
	const totalProviders = useProviders((s) => s.rows.length);

	// biome-ignore lint/correctness/useExhaustiveDependencies: focusRequest re-fires the jump for a repeated key
	useEffect(() => {
		const wanted = tabForFocus(focusKey);
		if (wanted) setTab(wanted);
	}, [focusKey, focusRequest]);

	return (
		<div className="space-y-3">
			{tab === "other-models" && <div data-field-id="otherModels" className="h-0" />}
			<SectionHeader
				title={t("settingsSections.providers.title")}
				aside={tab === "config" && totalProviders > 0 ? t("providers.totalCount", { total: totalProviders }) : undefined}
				description={(
					<>
						{t("settingsSections.providers.description")}
						{tab === "config" && (
							<>
								<span aria-hidden="true" className="mx-1.5 text-[var(--text-dim)]">·</span>
								<button
									type="button"
									onClick={() => openSettingsTarget("modelContext")}
									className="inline-flex items-center gap-0.5 align-baseline whitespace-nowrap font-medium text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:underline"
								>
									{t("providers.contextWindowInlineAction")}
								</button>
							</>
						)}
					</>
				)}
				actions={(
					<>
						{tab === "other-models" && configurationOrigin ? (
							<Button icon={ArrowLeft} onClick={() => {
								useServiceModelConfiguration.getState().requestReturn();
								useUi.getState().openSettings("omp-roles", { focusKey: `modelRole:${configurationOrigin.role}` });
							}}>{t("providers.returnToModelRoles")}</Button>
						) : null}
						<Button icon={FileText} onClick={() => setRawOpen(true)}>{t("settingsSections.providers.editRawConfig")}</Button>
					</>
				)}
			/>
			<SectionJumpBar />
			<div>
				<Segmented
					options={[
						{ value: "config", label: t("providers.tabChatProviders") },
						{ value: "other-models", label: t("providers.tabOtherModels"), title: t("providers.pickerTabOtherTitle") },
						{ value: "quota", label: t("settingsSections.providers.tabQuota") },
					]}
					value={tab}
					onChange={setTab}
					size="md"
				/>
			</div>
			{tab === "config" ? (
				<div className="space-y-4">
					<div data-field-id="providerList" data-jump={t("settingsSections.providers.jumpProviders")} className="scroll-mt-4">
						<ProviderPanel category="chat" />
					</div>
					<OmpSections page="providers" slot="keys" />
				</div>
			) : tab === "other-models" ? (
				<div data-jump={t("providers.tabOtherModels")} className="scroll-mt-4">
					<ProviderPanel category="other" />
				</div>
			) : (
				<div className="space-y-4">
					<div data-jump={t("home.activityTitle")} className="scroll-mt-4">
						<CalendarHeatmap />
					</div>
					<div data-jump={t("settingsSections.providers.jumpQuota")} className="scroll-mt-4">
						<QuotaDashboardCard />
					</div>
					<OmpSections page="providers" slot="quota" />
				</div>
			)}
			{rawOpen ? <RawFilesDialog onClose={() => setRawOpen(false)} /> : null}
		</div>
	);
}

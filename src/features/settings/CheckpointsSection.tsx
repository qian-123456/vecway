/**
 * Settings ▸ 会话 ▸ 对话检查点: the desktop's per-turn git snapshots
 * (`settings.turnCheckpoints`; null = never asked → treated as off here).
 */
import { useT } from "../../stores/language";
import { InfoTip } from "../../components/InfoTip";
import { useAppSettings } from "./useAppSettings";
import { useSettingsNav } from "./settingsNav";
import { Button, SettingRow, SettingsCard, ToggleRow } from "./ui";

export function CheckpointsSection() {
	const { t } = useT();
	const { settings, save } = useAppSettings();
	const { navigate } = useSettingsNav();
	return (
		<SettingsCard
			title={
				<span className="inline-flex items-center gap-1.5">
					<span>{t("settingsCore.checkpoints.title")}</span>
					<InfoTip
						text={`${t("settingsCore.checkpoints.description")} ${t("settingsCore.checkpoints.footer")}`}
					/>
				</span>
			}
		>
			<ToggleRow
				fieldId="turnCheckpoints"
				label={t("settingsCore.checkpoints.autoSaveLabel")}
				description={t("settingsCore.checkpoints.autoSaveDesc")}
				checked={settings?.turnCheckpoints === true}
				onChange={(v) => save({ turnCheckpoints: v })}
			/>
			<SettingRow
				label={t("settingsCore.checkpoints.ompCheckpointsLabel")}
				description={t("settingsCore.checkpoints.ompCheckpointsDesc")}
				control={<Button onClick={() => navigate("tools")}>{t("settingsCore.checkpoints.goToTools")}</Button>}
			/>
		</SettingsCard>
	);
}

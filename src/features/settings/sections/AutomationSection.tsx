/**
 * Settings ▸ 自动化 (`automations`): global automation defaults, overlap policy,
 * result reporting default, default model, and user-editable test/adjust prompt templates.
 */
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { ModelSelect } from "../../../components/ModelSelect";
import { parseSelection } from "../../../components/modelSelectLogic";
import { Segmented } from "../../../components/Segmented";
import type { ScheduleResultMode, Settings } from "../../../lib/contracts";
import { useT } from "../../../stores/language";
import {
	type AutomationPromptKey,
	DEFAULT_AUTOMATION_PROMPTS,
	getAutomationPromptTemplate,
} from "../../schedules/automationPrompts";
import { SectionJumpBar } from "../SectionJumpBar";
import {
	Button,
	MODEL_PICKER_BUTTON_CLASS,
	SectionHeader,
	SettingRow,
	SettingsCard,
	ToggleRow,
	useSaveStatus,
} from "../ui";
import { useAppSettings, useCatalogModels } from "../useAppSettings";

const AUTOMATION_OVERLAP_POLICIES = ["skip", "coalesce", "queue", "parallel"] as const;
const RESULT_MODES: readonly ScheduleResultMode[] = ["structured", "llm_summary"];

const PROMPT_FIELDS: Array<{
	key: AutomationPromptKey;
	settingsKey: keyof Settings;
	labelKey: string;
	descKey: string;
}> = [
	{
		key: "mockTest",
		settingsKey: "automationPromptMockTest",
		labelKey: "settingsSections.automations.promptMockLabel",
		descKey: "settingsSections.automations.promptMockDesc",
	},
	{
		key: "realOnceTest",
		settingsKey: "automationPromptRealOnceTest",
		labelKey: "settingsSections.automations.promptRealOnceLabel",
		descKey: "settingsSections.automations.promptRealOnceDesc",
	},
	{
		key: "realLoopTest",
		settingsKey: "automationPromptRealLoopTest",
		labelKey: "settingsSections.automations.promptRealLoopLabel",
		descKey: "settingsSections.automations.promptRealLoopDesc",
	},
	{
		key: "adjust",
		settingsKey: "automationPromptAdjust",
		labelKey: "settingsSections.automations.promptAdjustLabel",
		descKey: "settingsSections.automations.promptAdjustDesc",
	},
];

export function AutomationSection() {
	const { t, locale } = useT();
	const { settings, save } = useAppSettings();
	const { models, catalogKeys } = useCatalogModels();

	const overlapSave = useSaveStatus();
	const resultModeSave = useSaveStatus();
	const modelSave = useSaveStatus();
	const promptSave = useSaveStatus();

	const overlapPolicy = settings?.automationOverlapPolicy ?? "skip";
	const defaultResultMode: ScheduleResultMode =
		settings?.automationDefaultResultMode ?? "structured";
	const currentModel = settings?.automationDefaultModel ?? "";
	const currentThinking = settings?.automationDefaultThinking ?? "";
	const combinedModelValue = currentModel
		? currentThinking
			? `${currentModel}:${currentThinking}`
			: currentModel
		: "";
	const selector = parseSelection(combinedModelValue).selector;
	const pickerValue = catalogKeys.has(selector) ? combinedModelValue : "";

	const [draftPrompts, setDraftPrompts] = useState<Record<AutomationPromptKey, string>>(() => ({
		mockTest: getAutomationPromptTemplate("mockTest", settings, locale),
		realOnceTest: getAutomationPromptTemplate("realOnceTest", settings, locale),
		realLoopTest: getAutomationPromptTemplate("realLoopTest", settings, locale),
		adjust: getAutomationPromptTemplate("adjust", settings, locale),
	}));

	useEffect(() => {
		setDraftPrompts({
			mockTest: getAutomationPromptTemplate("mockTest", settings, locale),
			realOnceTest: getAutomationPromptTemplate("realOnceTest", settings, locale),
			realLoopTest: getAutomationPromptTemplate("realLoopTest", settings, locale),
			adjust: getAutomationPromptTemplate("adjust", settings, locale),
		});
	}, [
		settings?.automationPromptMockTest,
		settings?.automationPromptRealOnceTest,
		settings?.automationPromptRealLoopTest,
		settings?.automationPromptAdjust,
		locale,
	]);

	const commitPrompt = async (
		key: AutomationPromptKey,
		settingsKey: keyof Settings,
		value: string,
	) => {
		const trimmed = value.trim();
		const defaultText = DEFAULT_AUTOMATION_PROMPTS[locale][key].trim();
		const nextVal = !trimmed || trimmed === defaultText ? null : value;
		await promptSave.run(() => save({ [settingsKey]: nextVal } as Partial<Settings>));
	};

	const resetPrompt = async (key: AutomationPromptKey, settingsKey: keyof Settings) => {
		const defaultText = DEFAULT_AUTOMATION_PROMPTS[locale][key];
		setDraftPrompts((prev) => ({ ...prev, [key]: defaultText }));
		await promptSave.run(() => save({ [settingsKey]: null } as Partial<Settings>));
	};

	return (
		<div className="space-y-5">
			<SectionHeader
				title={t("settingsSections.automations.title")}
				description={t("settingsSections.automations.desc")}
			/>
			<SectionJumpBar />

			<SettingsCard
				jump={t("settingsSections.automations.jumpRuntime")}
				title={t("settingsSections.automations.cardRuntime")}
			>
				<ToggleRow
					label={t("schedules.bgRunLabel")}
					description={t("schedules.bgRunTooltip")}
					checked={settings?.automationBackgroundEnabled ?? true}
					onChange={(v) => void save({ automationBackgroundEnabled: v })}
				/>
				<SettingRow
					fieldId="automationOverlapPolicy"
					label={t("settingsSections.general.overlapPolicyLabel")}
					stacked
					description={t(`settingsSections.general.overlap.${overlapPolicy}.description`)}
					hint={t("settingsSections.general.overlapPolicyHint")}
					status={overlapSave.status}
					statusError={overlapSave.error}
					control={
						<Segmented
							aria-label={t("settingsSections.general.overlapPolicyLabel")}
							value={overlapPolicy}
							disabled={!settings || overlapSave.status === "saving"}
							onChange={(value) =>
								void overlapSave.run(() => save({ automationOverlapPolicy: value }))
							}
							options={AUTOMATION_OVERLAP_POLICIES.map((value) => ({
								value,
								label: t(`settingsSections.general.overlap.${value}.label`),
								title: t(`settingsSections.general.overlap.${value}.description`),
							}))}
						/>
					}
				/>
			</SettingsCard>

			<SettingsCard
				jump={t("settingsSections.automations.jumpDefaults")}
				title={t("settingsSections.automations.cardDefaults")}
			>
				<SettingRow
					fieldId="automationDefaultResultMode"
					label={t("settingsSections.automations.defaultResultModeLabel")}
					stacked
					description={t("settingsSections.automations.defaultResultModeDesc")}
					status={resultModeSave.status}
					statusError={resultModeSave.error}
					control={
						<Segmented
							aria-label={t("settingsSections.automations.defaultResultModeLabel")}
							value={defaultResultMode}
							disabled={!settings || resultModeSave.status === "saving"}
							onChange={(value) =>
								void resultModeSave.run(() =>
									save({ automationDefaultResultMode: value as ScheduleResultMode }),
								)
							}
							options={RESULT_MODES.map((value) => ({
								value,
								label:
									value === "llm_summary"
										? t("schedules.resultModeLlmSummary")
										: t("schedules.resultModeStructured"),
							}))}
						/>
					}
				/>
				<SettingRow
					fieldId="automationDefaultModel"
					label={t("settingsSections.automations.defaultModelLabel")}
					description={t("settingsSections.automations.defaultModelDesc")}
					status={modelSave.status}
					statusError={modelSave.error}
					control={
						<div className="flex items-center gap-2">
							<ModelSelect
								catalogManaged
								direction="up"
								widthClass="w-[360px]"
								label={
									currentModel
										? currentThinking
											? `${currentModel.split("/").pop() ?? currentModel} · ${currentThinking}`
											: (currentModel.split("/").pop() ?? currentModel)
										: t("schedules.defaultModel")
								}
								buttonClass={MODEL_PICKER_BUTTON_CLASS}
								models={models}
								currentValue={pickerValue}
								thinking
								allowCustom
								onSelect={(next) => {
									const parsed = parseSelection(next);
									void modelSave.run(() =>
										save({
											automationDefaultModel: parsed.selector.trim() || null,
											automationDefaultThinking: parsed.level?.trim() || null,
										}),
									);
								}}
							/>
							{currentModel && (
								<Button
									size="sm"
									variant="ghost"
									onClick={() =>
										void modelSave.run(() =>
											save({
												automationDefaultModel: null,
												automationDefaultThinking: null,
											}),
										)
									}
								>
									{t("settingsSections.automations.resetDefaultBtn")}
								</Button>
							)}
						</div>
					}
				/>
			</SettingsCard>

			<SettingsCard
				fieldId="automationTestPrompts"
				jump={t("settingsSections.automations.jumpPrompts")}
				title={t("settingsSections.automations.cardPrompts")}
				description={t("settingsSections.automations.cardPromptsDesc")}
			>
				{PROMPT_FIELDS.map(({ key, settingsKey, labelKey, descKey }) => {
					const hasCustom = Boolean(
						typeof settings?.[settingsKey] === "string" &&
							(settings[settingsKey] as string).trim(),
					);
					return (
						<SettingRow
							key={key}
							label={t(labelKey)}
							description={t(descKey)}
							stacked
							status={promptSave.status}
							statusError={promptSave.error}
							control={
								<div className="w-full space-y-1.5">
									<textarea
										rows={3}
										value={draftPrompts[key]}
										onChange={(e) =>
											setDraftPrompts((prev) => ({
												...prev,
												[key]: e.target.value,
											}))
										}
										onBlur={(e) =>
											void commitPrompt(key, settingsKey, e.target.value)
										}
										className="w-full rounded-lg border border-[var(--border-divider)] bg-[var(--bg)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
									/>
									<div className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-40)]">
										<span>{t("settingsSections.automations.placeholderHint")}</span>
										{hasCustom && (
											<button
												type="button"
												onClick={() => void resetPrompt(key, settingsKey)}
												className="inline-flex items-center gap-1 rounded-md border border-[var(--border-divider)] bg-[var(--bg-panel)] px-2 py-0.5 text-[11px] text-[var(--text-60)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
											>
												<RotateCcw size={10} />
												<span>{t("settingsSections.automations.resetDefaultBtn")}</span>
											</button>
										)}
									</div>
								</div>
							}
						/>
					);
				})}
			</SettingsCard>
		</div>
	);
}

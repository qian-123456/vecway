/**
 * Dedicated mobile Automation Settings sheet (Wave 5E) managing all 9 global
 * automation settings via `POST /left/settings/automation`:
 * 1. Runtime: background daemon toggle (LaunchAgent sync) + overlap policy
 * 2. Defaults: default script result mode + default automation model & thinking
 * 3. Prompt templates: mock test, real single run, real iterative debug, ask AI to adjust
 */
import { ChevronRight, Cpu, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../../core/api";
import { BottomSheet, Button, inputCls, ListGroup, SelectRow, Spinner, Switch, toast } from "../../../ui";
import { ModelPicker, type PickerModel } from "../../../ui/ModelPicker";
import { invalidateAutomationPromptSettingsCache } from "../../chat/automation/AutomationDraftCard";
import { THINK_DESC } from "../../chat/lib/models";
import {
	DEFAULT_AUTOMATION_PROMPTS,
	modelString,
	parseModel,
	RESULT_MODE_HINT,
	RESULT_MODE_LABEL,
	type AutomationPromptKey,
	type AutomationSettingsSnapshot,
	type ScheduleResultMode,
} from "../../more/schedule";
import { SettingsSheet } from "../rows";
import {
	AUTOMATION_OVERLAP_POLICIES,
	isAutomationOverlapPolicy,
	type AutomationOverlapPolicy,
} from "../settingsMap";

const THINKING_OPTIONS: Array<{ value: string; label: string; hint?: string }> = [
	{ value: "", label: "跟随默认", hint: THINK_DESC.auto },
	{ value: "off", label: "off", hint: THINK_DESC.off },
	{ value: "minimal", label: "minimal", hint: THINK_DESC.minimal },
	{ value: "low", label: "low", hint: THINK_DESC.low },
	{ value: "medium", label: "medium", hint: THINK_DESC.medium },
	{ value: "high", label: "high", hint: THINK_DESC.high },
	{ value: "xhigh", label: "xhigh", hint: THINK_DESC.xhigh },
	{ value: "max", label: "max", hint: THINK_DESC.max },
];

const PROMPT_FIELDS: Array<{
	key: AutomationPromptKey;
	field: keyof AutomationSettingsSnapshot;
	label: string;
	hint: string;
}> = [
	{
		key: "mockTest",
		field: "automationPromptMockTest",
		label: "模拟测试模板",
		hint: "在模拟环境下用安全数据验证流程并按需修复（支持 {{name}}）",
	},
	{
		key: "realOnceTest",
		field: "automationPromptRealOnceTest",
		label: "真实单次试跑模板",
		hint: "在真实环境下执行一轮，遇错即停并说明原因（支持 {{name}}）",
	},
	{
		key: "realLoopTest",
		field: "automationPromptRealLoopTest",
		label: "真实循环调通模板",
		hint: "在真实环境下边测边修直到稳定（支持 {{name}}）",
	},
	{
		key: "adjust",
		field: "automationPromptAdjust",
		label: "「让 AI 调整」模板",
		hint: "点击草案卡「让 AI 调整」时预填的开头句（支持 {{name}}）",
	},
];

const RESULT_MODE_OPTIONS: Array<{ value: ScheduleResultMode; label: string; hint: string }> = (
	["structured", "llm_summary"] as const
).map((v) => ({
	value: v,
	label: RESULT_MODE_LABEL[v],
	hint: RESULT_MODE_HINT[v],
}));

export function AutomationSettingsSheet({
	open,
	onClose,
	snapshot,
	onUpdate,
}: {
	open: boolean;
	onClose: () => void;
	snapshot: Partial<AutomationSettingsSnapshot> | null;
	onUpdate: (next: AutomationSettingsSnapshot) => void;
}) {
	const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({});
	const [error, setError] = useState<string | null>(null);
	const [modelOpen, setModelOpen] = useState(false);
	const [models, setModels] = useState<PickerModel[] | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);

	const inflightRef = useRef(false);
	const pendingPatchRef = useRef<Partial<AutomationSettingsSnapshot> | null>(null);
	const pendingOkMsgsRef = useRef<string[]>([]);
	const pendingWaitersRef = useRef<Array<(v: AutomationSettingsSnapshot | null) => void>>([]);
	const pendingKeysRef = useRef<Set<string>>(new Set());

	const [draftPrompts, setDraftPrompts] = useState<Record<AutomationPromptKey, string>>({
		mockTest: DEFAULT_AUTOMATION_PROMPTS.mockTest,
		realOnceTest: DEFAULT_AUTOMATION_PROMPTS.realOnceTest,
		realLoopTest: DEFAULT_AUTOMATION_PROMPTS.realLoopTest,
		adjust: DEFAULT_AUTOMATION_PROMPTS.adjust,
	});
	const draftPromptsRef = useRef(draftPrompts);
	draftPromptsRef.current = draftPrompts;
	const focusedPromptRef = useRef<AutomationPromptKey | null>(null);
	const dirtyPromptsRef = useRef<Set<AutomationPromptKey>>(new Set());
	const sentPromptDraftRef = useRef<Partial<Record<AutomationPromptKey, string>>>({});

	useEffect(() => {
		setDraftPrompts((prev) => {
			let changed = false;
			const next = { ...prev };
			for (const { key, field } of PROMPT_FIELDS) {
				if (focusedPromptRef.current === key || dirtyPromptsRef.current.has(key)) continue;
				const raw = snapshot?.[field];
				const serverVal =
					typeof raw === "string" && raw.trim() ? raw : DEFAULT_AUTOMATION_PROMPTS[key];
				if (next[key] !== serverVal) {
					next[key] = serverVal;
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [
		snapshot?.automationPromptMockTest,
		snapshot?.automationPromptRealOnceTest,
		snapshot?.automationPromptRealLoopTest,
		snapshot?.automationPromptAdjust,
	]);

	const syncBusyState = (activeKeys: Iterable<string>) => {
		const next: Record<string, boolean> = {};
		for (const k of activeKeys) next[k] = true;
		for (const k of pendingKeysRef.current) next[k] = true;
		setBusyKeys(next);
	};

	const flushQueue = async (): Promise<void> => {
		if (inflightRef.current) return;
		inflightRef.current = true;
		try {
			while (pendingPatchRef.current) {
				const batch = pendingPatchRef.current;
				const waiters = pendingWaitersRef.current;
				const msgs = pendingOkMsgsRef.current;
				const activeKeys = new Set(pendingKeysRef.current);
				pendingPatchRef.current = null;
				pendingWaitersRef.current = [];
				pendingOkMsgsRef.current = [];
				pendingKeysRef.current = new Set();
				syncBusyState(activeKeys);
				setError(null);
				try {
					const updated = await api<AutomationSettingsSnapshot>("POST", "/left/settings/automation", batch);
					if (!updated || typeof updated !== "object") {
						throw new Error("电脑未返回有效的自动化设置");
					}
					if (
						batch.automationOverlapPolicy !== undefined &&
						!isAutomationOverlapPolicy(updated.automationOverlapPolicy)
					) {
						throw new Error("电脑未返回有效的自动化重合策略");
					}
					for (const { key, field } of PROMPT_FIELDS) {
						if (!(field in batch)) continue;
						const sentDraft = sentPromptDraftRef.current[key];
						if (
							focusedPromptRef.current !== key &&
							(sentDraft === undefined || draftPromptsRef.current[key] === sentDraft)
						) {
							dirtyPromptsRef.current.delete(key);
							delete sentPromptDraftRef.current[key];
						}
					}
					invalidateAutomationPromptSettingsCache();
					onUpdate(updated);
					const lastMsg = msgs[msgs.length - 1];
					if (lastMsg) toast(lastMsg, { kind: "success" });
					for (const resolve of waiters) resolve(updated);
				} catch (e) {
					const msg = errorMessage(e);
					setError(msg);
					toast(`保存失败：${msg}`, { kind: "error" });
					for (const resolve of waiters) resolve(null);
				}
			}
		} finally {
			inflightRef.current = false;
			syncBusyState([]);
		}
	};

	const patchSettings = (
		key: string,
		patch: Partial<AutomationSettingsSnapshot>,
		okMsg?: string,
	): Promise<AutomationSettingsSnapshot | null> => {
		pendingPatchRef.current = { ...(pendingPatchRef.current ?? {}), ...patch };
		pendingKeysRef.current.add(key);
		if (okMsg) pendingOkMsgsRef.current.push(okMsg);
		setBusyKeys((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
		return new Promise((resolve) => {
			pendingWaitersRef.current.push(resolve);
			void flushQueue();
		});
	};

	const openModelPicker = () => {
		setModelOpen(true);
		if (models) return;
		setModelsError(null);
		api<{ models: PickerModel[] }>("GET", "/left/roles")
			.then((r) => setModels(r.models ?? []))
			.catch((e) => setModelsError(errorMessage(e, "模型列表加载失败")));
	};

	const commitPrompt = async (key: AutomationPromptKey, field: keyof AutomationSettingsSnapshot, raw: string) => {
		const trimmed = raw.trim();
		const def = DEFAULT_AUTOMATION_PROMPTS[key].trim();
		const nextVal = !trimmed || trimmed === def ? null : raw;
		const currentStored = (snapshot?.[field] as string | null | undefined) ?? null;
		if (nextVal === currentStored) {
			dirtyPromptsRef.current.delete(key);
			delete sentPromptDraftRef.current[key];
			return;
		}
		sentPromptDraftRef.current[key] = raw;
		await patchSettings(key, { [field]: nextVal } as Partial<AutomationSettingsSnapshot>, "提示词模板已保存");
	};

	const resetPrompt = async (key: AutomationPromptKey, field: keyof AutomationSettingsSnapshot) => {
		const previous =
			(typeof snapshot?.[field] === "string" && (snapshot[field] as string).trim()) || draftPrompts[key];
		const def = DEFAULT_AUTOMATION_PROMPTS[key];
		dirtyPromptsRef.current.add(key);
		sentPromptDraftRef.current[key] = def;
		setDraftPrompts((prev) => ({ ...prev, [key]: def }));
		const updated = await patchSettings(key, { [field]: null } as Partial<AutomationSettingsSnapshot>);
		if (updated && previous.trim() && previous.trim() !== def.trim()) {
			toast("已恢复默认提示词模板", {
				ms: 6000,
				action: {
					label: "撤销",
					onClick: async () => {
						dirtyPromptsRef.current.add(key);
						sentPromptDraftRef.current[key] = previous;
						setDraftPrompts((prev) => ({ ...prev, [key]: previous }));
						await patchSettings(key, { [field]: previous } as Partial<AutomationSettingsSnapshot>);
					},
				},
			});
		}
	};
	const bgEnabled = snapshot?.automationBackgroundEnabled ?? true;
	const overlapPolicy: AutomationOverlapPolicy | null = isAutomationOverlapPolicy(
		snapshot?.automationOverlapPolicy,
	)
		? snapshot.automationOverlapPolicy
		: null;
	const resultMode: ScheduleResultMode =
		snapshot?.automationDefaultResultMode === "llm_summary" ? "llm_summary" : "structured";
	const defaultModel = snapshot?.automationDefaultModel ?? null;
	const defaultThinking = snapshot?.automationDefaultThinking ?? null;
	const selectedModel = models ? parseModel(defaultModel, models) : null;

	const overlapOptions = AUTOMATION_OVERLAP_POLICIES.map((o) => ({
		value: o.value,
		label: o.label,
		hint: o.effect,
	}));

	return (
		<>
			<SettingsSheet open={open} onClose={onClose} title="自动化设置">
				{error && (
					<div role="alert" className="m-selectable mx-4 mb-3 rounded-xl bg-m-danger-bg px-3 py-2 text-m-xs break-words text-m-danger">
						保存失败：{error}
					</div>
				)}

				<ListGroup
					title="运行控制"
					note="对所有自动化的后续触发立即生效，不中断当前运行；已接收的排队任务会保留并依次执行。"
				>
					<div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
						<span className="min-w-0 flex-1">
							<span className="block text-m-md text-m-text">后台常驻运行</span>
							<span className="block text-m-xs text-m-text-3">
								关闭应用窗口后仍由电脑后台按计划触发自动化任务（同步系统启动项）
							</span>
						</span>
						<Switch
							label="后台常驻运行"
							checked={bgEnabled}
							disabled={Boolean(busyKeys.bg)}
							onChange={(checked) =>
								void patchSettings(
									"bg",
									{ automationBackgroundEnabled: checked },
									checked ? "已开启后台常驻运行" : "已关闭后台常驻运行",
								)
							}
						/>
					</div>
					<SelectRow
						title="运行重合策略"
						subtitle={AUTOMATION_OVERLAP_POLICIES.find((p) => p.value === overlapPolicy)?.effect}
						presentation="menu"
						value={overlapPolicy}
						disabled={Boolean(busyKeys.overlap) || overlapPolicy == null}
						options={overlapOptions}
						onChange={(value) =>
							void patchSettings(
								"overlap",
								{ automationOverlapPolicy: value },
								"重合策略已更新，对所有自动化的后续触发生效",
							)
						}
						error={
							overlapPolicy == null ? (
								<div role="alert" className="m-selectable text-m-sm text-m-danger">
									无法读取自动化重合策略，请返回设置后下拉刷新。
								</div>
							) : undefined
						}
					/>
				</ListGroup>

				<ListGroup title="默认项" note="新建自动化未单独指定时沿用以下默认配置。">
					<SelectRow
						title="默认结果汇报模式"
						subtitle={RESULT_MODE_HINT[resultMode]}
						presentation="menu"
						value={resultMode}
						disabled={Boolean(busyKeys.resultMode)}
						options={RESULT_MODE_OPTIONS}
						onChange={(value) =>
							void patchSettings("resultMode", { automationDefaultResultMode: value }, "默认汇报模式已更新")
						}
					/>
					<button
						type="button"
						onClick={openModelPicker}
						className="m-list-row flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-m-surface-hover"
					>
						<Cpu size={20} strokeWidth={1.75} className="shrink-0 text-m-text-2" />
						<span className="min-w-0 flex-1">
							<span className="block text-m-md text-m-text">默认自动化模型</span>
							<span className="block font-m-mono text-m-xs break-words text-m-text-3">
								{defaultModel
									? `${defaultModel}${defaultThinking ? ` · ${defaultThinking}` : ""}`
									: "跟随全局默认模型"}
							</span>
						</span>
						<ChevronRight size={18} className="shrink-0 text-m-text-3" />
					</button>
					<SelectRow
						title="默认思考力度"
						subtitle={defaultThinking ? (THINK_DESC[defaultThinking] ?? defaultThinking) : "跟随默认"}
						presentation="menu"
						value={defaultThinking ?? ""}
						disabled={Boolean(busyKeys.thinking)}
						options={THINKING_OPTIONS}
						onChange={(value) =>
							void patchSettings(
								"thinking",
								{ automationDefaultThinking: value || null },
								value ? "默认思考力度已更新" : "默认思考力度已恢复跟随默认",
							)
						}
					/>
					{defaultModel && (
						<div className="flex justify-end px-4 pb-2.5">
							<Button
								size="sm"
								variant="ghost"
								busy={Boolean(busyKeys.model)}
								onClick={() =>
									void patchSettings(
										"model",
										{ automationDefaultModel: null, automationDefaultThinking: null },
										"已恢复跟随全局默认模型",
									)
								}
							>
								恢复跟随全局默认
							</Button>
						</div>
					)}
				</ListGroup>

				<ListGroup
					title="测试与调整提示词模板"
					note="失焦自动保存；预填到对话输入框时绝不自动发送，可随时恢复默认。"
				>
					<div className="flex flex-col gap-4 px-4 py-3">
						{PROMPT_FIELDS.map(({ key, field, label, hint }) => {
							const hasCustom = Boolean(
								typeof snapshot?.[field] === "string" && (snapshot[field] as string).trim(),
							);
							return (
								<div key={key} className="flex flex-col gap-1.5">
									<div className="flex items-center justify-between gap-2">
										<label className="text-m-sm font-medium text-m-text">{label}</label>
										{hasCustom && (
											<button
												type="button"
												onClick={() => void resetPrompt(key, field)}
												className="inline-flex items-center gap-1 rounded-full bg-m-bg px-2.5 py-1 text-[11px] text-m-text-2 active:opacity-70"
											>
												<RotateCcw size={11} />
												<span>恢复默认</span>
											</button>
										)}
									</div>
									<textarea
										rows={3}
										value={draftPrompts[key]}
										onFocus={() => {
											focusedPromptRef.current = key;
										}}
										onChange={(e) => {
											dirtyPromptsRef.current.add(key);
											setDraftPrompts((prev) => ({ ...prev, [key]: e.target.value }));
										}}
										onBlur={(e) => {
											if (focusedPromptRef.current === key) focusedPromptRef.current = null;
											void commitPrompt(key, field, e.target.value);
										}}
										className={`${inputCls} min-h-20 resize-y leading-relaxed`}
									/>
									<span className="text-m-xs text-m-text-3">{hint}</span>
								</div>
							);
						})}
					</div>
				</ListGroup>
			</SettingsSheet>

			<BottomSheet
				open={modelOpen}
				onClose={() => setModelOpen(false)}
				title="选择默认自动化模型"
				fullHeight
				footer={
					<div className="flex gap-2">
						<Button
							block
							className="flex-1"
							onClick={() => {
								setModelOpen(false);
								void patchSettings(
									"model",
									{ automationDefaultModel: null, automationDefaultThinking: null },
									"已恢复跟随全局默认模型",
								);
							}}
						>
							跟随全局默认
						</Button>
						<Button variant="primary" block className="flex-1" onClick={() => setModelOpen(false)}>
							完成
						</Button>
					</div>
				}
			>
				{models ? (
					<ModelPicker
						className="h-full px-4 pb-4"
						models={models}
						value={selectedModel}
						onChange={(next) => {
							if (!next) return;
							setModelOpen(false);
							void patchSettings(
								"model",
								{
									automationDefaultModel: modelString({ provider: next.provider, id: next.id }),
									automationDefaultThinking: defaultThinking,
								},
								"默认自动化模型已更新",
							);
						}}
					/>
				) : modelsError ? (
					<div role="alert" className="px-4 py-6 text-center text-m-sm text-m-danger">
						{modelsError}
					</div>
				) : (
					<div className="flex items-center justify-center py-12">
						<Spinner />
					</div>
				)}
			</BottomSheet>
		</>
	);
}

/**
 * Mobile automation draft review & confirmation card inside the right workspace drawer.
 * Supports probe script testing (cached across remounts), mock/real/adjust prompt templates,
 * per-section & text-selection quick quote annotations back to main chat composer,
 * one-click save, hand-off to manual editor, and dismiss.
 */
import {
	CalendarClock,
	Check,
	ChevronDown,
	Cpu,
	FlaskConical,
	FolderGit2,
	MessageSquareQuote,
	Pencil,
	Play,
	SlidersHorizontal,
	Terminal,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, errorMessage } from "../../../core/api";
import { nav, paths } from "../../../core/nav";
import { useMobileSchedules } from "../../../core/stores/schedules";
import { Button, Chip, toast } from "../../../ui";
import {
	AGENT_TRIGGER_LABEL,
	cadenceText,
	renderAutomationPrompt,
	resolveAgentTrigger,
	scheduleDraftFromSchedule,
	type AutomationPromptKey,
	type AutomationSettingsSnapshot,
	type ProbeTestResult,
	type ScheduleDraft,
} from "../../more/schedule";
import { useRightDrawer } from "../../panels/rightDrawerStore";
import {
	getCachedProbeResult,
	mergeAutomationDraftOntoSchedule,
	setCachedProbeResult,
	stashManualScheduleDraft,
	type AutomationDraftStatus,
} from "./automationStatus";

let cachedSettingsSnapshot: Partial<AutomationSettingsSnapshot> | null = null;
const savedScheduleIdByDraft = new Map<string, string>();

function deterministicScheduleIdFromDraft(draftId: string): string {
	const cleaned = draftId.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
	if (cleaned.startsWith("draft-") && cleaned.length > 6) return cleaned.slice(0, 64);
	const suffix = cleaned ? cleaned.slice(0, 58) : "auto";
	return `draft-${suffix}`;
}

async function loadPromptSettings(): Promise<Partial<AutomationSettingsSnapshot> | null> {
	if (cachedSettingsSnapshot) return cachedSettingsSnapshot;
	try {
		const res = await api<Partial<AutomationSettingsSnapshot>>("GET", "/left/settings");
		if (res) cachedSettingsSnapshot = res;
		return cachedSettingsSnapshot;
	} catch {
		return null;
	}
}

export function invalidateAutomationPromptSettingsCache(): void {
	cachedSettingsSnapshot = null;
}

export function AutomationDraftCard({
	sessionId,
	item,
	highlighted,
	onResolve,
}: {
	sessionId: string;
	item: AutomationDraftStatus;
	highlighted?: boolean;
	onResolve: (draftId: string, resolution: "saved" | "dismissed") => Promise<void>;
}) {
	const { draftId, status, draft, summary } = item;
	const trigger = resolveAgentTrigger(draft);
	const schedules = useMobileSchedules((s) => s.schedules);
	const schedulesLoaded = useMobileSchedules((s) => s.loaded);
	const existing = draft.id ? schedules.find((s) => s.id === draft.id) ?? null : null;

	useEffect(() => {
		if (draft.id && !schedulesLoaded) {
			void useMobileSchedules.getState().loadSchedules().catch(() => {});
		}
	}, [draft.id, schedulesLoaded]);
	const [testing, setTesting] = useState(false);
	const [probeResult, setProbeResult] = useState<ProbeTestResult | null>(() =>
		getCachedProbeResult(sessionId, draftId),
	);
	const [probeError, setProbeError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [dismissing, setDismissing] = useState(false);
	const [showScript, setShowScript] = useState(false);
	const [showPrompt, setShowPrompt] = useState(false);
	const [showTestActions, setShowTestActions] = useState(false);

	useEffect(() => {
		setProbeResult(getCachedProbeResult(sessionId, draftId));
	}, [sessionId, draftId]);

	const handleRunProbe = async () => {
		if (!draft.probeCommand?.trim() || testing) return;
		setTesting(true);
		setProbeError(null);
		try {
			const res = await useMobileSchedules.getState().testProbe({
				cwd: draft.cwd,
				probeCommand: draft.probeCommand,
				agentTrigger: trigger,
				scheduleId: draft.id,
			});
			setCachedProbeResult(sessionId, draftId, res);
			setProbeResult(res);
		} catch (e) {
			setProbeError(errorMessage(e));
		} finally {
			setTesting(false);
		}
	};

	const quoteSectionToMain = (label: string, content: string) => {
		const trimmed = content.trim();
		if (!trimmed) return;
		useRightDrawer.getState().sendToMainChat(sessionId, {
			quote: trimmed,
			sourceLabel: `自动化草案「${draft.name}」· ${label}`,
		});
		toast("已引用到主对话输入框", { kind: "success" });
	};

	const quoteSelectionOrFallback = (fallbackLabel: string, fallbackText: string) => {
		const sel = typeof window !== "undefined" ? window.getSelection()?.toString().trim() ?? "" : "";
		if (sel) {
			quoteSectionToMain("选中片段", sel);
		} else {
			quoteSectionToMain(fallbackLabel, fallbackText);
		}
	};

	const applyTemplateAction = async (key: AutomationPromptKey) => {
		const settings = await loadPromptSettings();
		const text = renderAutomationPrompt(key, draft.name, settings);
		useRightDrawer.getState().sendToMainChat(sessionId, {
			quote: "",
			comment: text,
			sourceLabel: `自动化「${draft.name}」`,
		});
		toast("已填入主对话输入框，请确认后发送");
	};

	const handleSave = async () => {
		if (saving) return;
		setSaving(true);
		const key = `${sessionId}:${draftId}`;
		let isUpdate = Boolean(existing);
		try {
			if (!savedScheduleIdByDraft.has(key)) {
				let resolvedExisting = existing;
				if (draft.id) {
					const freshList = await useMobileSchedules.getState().loadSchedules();
					resolvedExisting = freshList.find((s) => s.id === draft.id) ?? null;
				}
				isUpdate = Boolean(resolvedExisting);
				if (resolvedExisting) {
					const merged = mergeAutomationDraftOntoSchedule(resolvedExisting, item);
					const payload = scheduleDraftFromSchedule(merged);
					await useMobileSchedules
						.getState()
						.updateSchedule(resolvedExisting.id, payload, resolvedExisting.updatedAt);
					savedScheduleIdByDraft.set(key, resolvedExisting.id);
				} else {
					const settings = await api<Partial<AutomationSettingsSnapshot>>("GET", "/left/settings").catch(() => null);
					const hasField = (k: keyof ScheduleDraft): boolean =>
						item.presentFields ? item.presentFields.has(k) : draft[k] !== undefined;
					const deterministicId = draft.id?.trim() || deterministicScheduleIdFromDraft(draftId);
					const payload: Record<string, unknown> = {
						...draft,
						id: deterministicId,
						enabled: hasField("enabled") && typeof draft.enabled === "boolean" ? draft.enabled : true,
					};
					if (settings) {
						if (
							!hasField("resultMode") &&
							(settings.automationDefaultResultMode === "llm_summary" ||
								settings.automationDefaultResultMode === "structured")
						) {
							payload.resultMode = settings.automationDefaultResultMode;
						}
						if (
							!hasField("model") &&
							typeof settings.automationDefaultModel === "string" &&
							settings.automationDefaultModel.trim()
						) {
							payload.model = settings.automationDefaultModel.trim();
						}
						if (
							!hasField("thinking") &&
							typeof settings.automationDefaultThinking === "string" &&
							settings.automationDefaultThinking.trim()
						) {
							payload.thinking = settings.automationDefaultThinking.trim();
						}
					}
					try {
						const created = await useMobileSchedules.getState().createSchedule(payload);
						savedScheduleIdByDraft.set(key, created?.id ?? deterministicId);
					} catch (createErr) {
						if (createErr instanceof ApiError && createErr.status === 409 && !draft.id?.trim()) {
							const refreshed = await useMobileSchedules.getState().loadSchedules().catch(() => null);
							if (refreshed?.some((s) => s.id === deterministicId)) {
								savedScheduleIdByDraft.set(key, deterministicId);
							} else {
								throw createErr;
							}
						} else {
							throw createErr;
						}
					}
				}
			}
			try {
				await onResolve(draftId, "saved");
			} catch {
				toast("自动化已保存，但更新草案状态失败，点击重试即可同步状态", { kind: "error" });
				return;
			}
			toast(isUpdate ? "已更新自动化任务" : "已保存并启用自动化任务", { kind: "success" });
		} catch (e) {
			toast(`保存失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setSaving(false);
		}
	};

	const handleManualEdit = async () => {
		if (dismissing) return;
		setDismissing(true);
		let resolvedExisting = existing;
		try {
			if (draft.id) {
				try {
					const freshList = await useMobileSchedules.getState().loadSchedules();
					resolvedExisting = freshList.find((s) => s.id === draft.id) ?? null;
				} catch (e) {
					toast(`刷新自动化列表失败：${errorMessage(e)}`, { kind: "error" });
					return;
				}
			}
			try {
				await onResolve(draftId, "dismissed");
			} catch {
				/* proceed to editor even if resolve RPC fails */
			}
			const targetKey = resolvedExisting ? resolvedExisting.id : "new";
			stashManualScheduleDraft(targetKey, {
				draft: item.draft,
				...(item.presentFields ? { presentFields: [...item.presentFields] } : {}),
				...(item.cadencePresentFields ? { cadencePresentFields: [...item.cadencePresentFields] } : {}),
			});
			useRightDrawer.getState().closeDrawer();
			nav.push(resolvedExisting ? `${paths.schedule(resolvedExisting.id)}?tab=config` : paths.scheduleNew());
		} finally {
			setDismissing(false);
		}
	};

	const handleDismiss = async () => {
		if (dismissing) return;
		setDismissing(true);
		try {
			await onResolve(draftId, "dismissed");
			toast("已忽略该草案");
		} catch (e) {
			toast(`操作失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setDismissing(false);
		}
	};

	const isPending = status === "pending";
	const summaryText = summary?.trim() || draft.prompt.trim() || draft.probeDescription?.trim() || "按计划自动运行";

	return (
		<article
			data-draft-id={draftId}
			className={`rounded-2xl border bg-m-surface p-4 transition-colors duration-(--m-dur-fast) ${
				highlighted ? "border-m-accent ring-2 ring-m-accent/30" : "border-m-border"
			}`}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<h3 className="text-m-md font-semibold break-words text-m-text">{draft.name}</h3>
					<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
						<Chip tone={status === "saved" ? "success" : status === "dismissed" ? "neutral" : "accent"}>
							{status === "saved" ? "已保存" : status === "dismissed" ? "已忽略" : existing ? "待更新" : "待确认"}
						</Chip>
						<Chip icon={<CalendarClock size={12} />}>{cadenceText(draft.cadence)}</Chip>
						<Chip>{AGENT_TRIGGER_LABEL[trigger]}</Chip>
						{draft.runMode === "worktree" && <Chip icon={<FolderGit2 size={12} />}>独立工作树</Chip>}
						{draft.model && <Chip icon={<Cpu size={12} />}>{draft.model}</Chip>}
					</div>
				</div>
			</div>

			{/* Human-readable summary with quick quote */}
			<div className="mt-3 rounded-xl bg-m-bg p-3">
				<div className="flex items-center justify-between gap-2">
					<span className="text-m-xs font-medium text-m-text-3">方案摘要</span>
					<button
						type="button"
						onClick={() => quoteSelectionOrFallback("方案摘要", summaryText)}
						className="inline-flex min-h-8 items-center gap-1 rounded-full bg-m-surface px-2.5 text-[11px] font-medium whitespace-nowrap text-m-text-2 active:opacity-70"
					>
						<MessageSquareQuote size={12} />
						<span>引用并调整</span>
					</button>
				</div>
				<p className="m-selectable mt-1.5 text-m-sm leading-relaxed whitespace-pre-wrap break-words text-m-text">
					{summaryText}
				</p>
				<div className="mt-1.5 text-m-xs break-all text-m-text-3">目录：{draft.cwd}</div>
			</div>

			{/* Collapsible probe script + one-click test */}
			{draft.probeCommand && (
				<div className="mt-2.5 rounded-xl border border-m-border bg-m-bg/60">
					<div className="flex items-center justify-between gap-2 px-3 py-2">
						<button
							type="button"
							onClick={() => setShowScript((v) => !v)}
							aria-expanded={showScript}
							className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-m-xs font-medium text-m-text-2"
						>
							<Terminal size={13} className="shrink-0 text-m-accent" />
							<span className="truncate">本地检测脚本</span>
							<ChevronDown
								size={13}
								className={`shrink-0 transition-transform duration-(--m-dur-fast) ${showScript ? "rotate-180" : ""}`}
							/>
						</button>
						<div className="flex shrink-0 items-center gap-1.5">
							<button
								type="button"
								onClick={() => quoteSectionToMain("检测脚本", draft.probeCommand ?? "")}
								className="inline-flex min-h-8 items-center gap-1 rounded-full bg-m-surface px-2 text-[11px] whitespace-nowrap text-m-text-2 active:opacity-70"
							>
								<MessageSquareQuote size={11} />
								<span>引用</span>
							</button>
							<Button size="sm" variant="tonal" busy={testing} icon={<Play size={12} />} onClick={() => void handleRunProbe()}>
								试跑脚本
							</Button>
						</div>
					</div>
					{showScript && (
						<div className="border-t border-m-border px-3 py-2.5">
							{draft.probeDescription && (
								<p className="mb-1.5 text-m-xs break-words text-m-text-3">{draft.probeDescription}</p>
							)}
							<pre className="m-selectable overflow-x-auto rounded-lg bg-m-bg p-2 font-m-mono text-[11px] whitespace-pre-wrap break-all text-m-text">
								{draft.probeCommand}
							</pre>
							<p className="mt-1.5 text-[11px] text-m-text-3">试跑将在电脑宿主机目录直接执行（30 秒超时）。</p>
						</div>
					)}
					{probeError && (
						<div role="alert" className="m-selectable border-t border-m-border px-3 py-2 text-m-xs break-words text-m-danger">
							试跑失败：{probeError}
						</div>
					)}
					{probeResult && (
						<div className="border-t border-m-border px-3 py-2 text-m-xs">
							<div className="flex flex-wrap items-center gap-1.5">
								<Chip
									tone={
										probeResult.outcome === "error" || probeResult.timedOut
											? "danger"
											: probeResult.outcome === "signal"
												? "accent"
												: "success"
									}
								>
									{probeResult.timedOut
										? "执行超时"
										: probeResult.outcome === "error"
											? "脚本报错"
											: probeResult.outcome === "signal"
												? "有信号（将唤醒智能体）"
												: probeResult.outcome === "ok"
													? "脚本完成"
													: "静默无信号"}
								</Chip>
								<span className="text-m-text-3">{probeResult.durationMs}ms</span>
								{probeResult.exitCode != null && <span className="text-m-text-3">退出码 {probeResult.exitCode}</span>}
							</div>
							{probeResult.output ? (
								<pre
									className={`m-selectable mt-1.5 max-h-32 overflow-auto rounded p-2 font-m-mono text-[11px] whitespace-pre-wrap break-all ${
										probeResult.outcome === "error" || probeResult.timedOut
											? "bg-m-danger-bg text-m-danger"
											: "bg-m-bg text-m-text"
									}`}
								>
									{probeResult.output}
								</pre>
							) : (
								<p className="mt-1 text-m-text-3">（无输出）</p>
							)}
						</div>
					)}
				</div>
			)}

			{/* Collapsible raw prompt */}
			{draft.prompt && (
				<div className="mt-2 rounded-xl border border-m-border bg-m-bg/60">
					<div className="flex items-center justify-between gap-2 px-3 py-2">
						<button
							type="button"
							onClick={() => setShowPrompt((v) => !v)}
							aria-expanded={showPrompt}
							className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-m-xs font-medium text-m-text-2"
						>
							<SlidersHorizontal size={13} className="shrink-0" />
							<span className="truncate">执行提示词</span>
							<ChevronDown
								size={13}
								className={`shrink-0 transition-transform duration-(--m-dur-fast) ${showPrompt ? "rotate-180" : ""}`}
							/>
						</button>
						<button
							type="button"
							onClick={() => quoteSectionToMain("执行提示词", draft.prompt)}
							className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full bg-m-surface px-2 text-[11px] whitespace-nowrap text-m-text-2 active:opacity-70"
						>
							<MessageSquareQuote size={11} />
							<span>引用</span>
						</button>
					</div>
					{showPrompt && (
						<pre className="m-selectable border-t border-m-border px-3 py-2.5 font-m-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-m-text-2">
							{draft.prompt}
						</pre>
					)}
				</div>
			)}

			{/* Test & adjust prompt shortcuts */}
			<div className="mt-3">
				<button
					type="button"
					onClick={() => setShowTestActions((v) => !v)}
					aria-expanded={showTestActions}
					className="inline-flex items-center gap-1 text-m-xs font-medium text-m-text-2 active:opacity-70"
				>
					<FlaskConical size={13} />
					<span>测试或让 AI 调整</span>
					<ChevronDown
						size={13}
						className={`transition-transform duration-(--m-dur-fast) ${showTestActions ? "rotate-180" : ""}`}
					/>
				</button>
				{showTestActions && (
					<div className="mt-2 flex flex-wrap gap-1.5">
						<Button size="sm" variant="tonal" onClick={() => void applyTemplateAction("mockTest")}>
							模拟测试
						</Button>
						<Button size="sm" variant="tonal" onClick={() => void applyTemplateAction("realOnceTest")}>
							真跑一次
						</Button>
						<Button size="sm" variant="tonal" onClick={() => void applyTemplateAction("realLoopTest")}>
							迭代真跑
						</Button>
						<Button size="sm" variant="tonal" onClick={() => void applyTemplateAction("adjust")}>
							让 AI 调整
						</Button>
					</div>
				)}
			</div>

			{/* Primary confirmation controls */}
			{isPending && (
				<div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-m-border pt-3">
					<Button
						variant="primary"
						size="sm"
						busy={saving}
						disabled={dismissing}
						icon={<Check size={14} />}
						onClick={() => void handleSave()}
					>
						{existing ? "确认更新" : "确认保存"}
					</Button>
					<Button
						variant="tonal"
						size="sm"
						disabled={saving || dismissing}
						icon={<Pencil size={13} />}
						onClick={() => void handleManualEdit()}
					>
						转手动精调
					</Button>
					<Button
						variant="ghost"
						size="sm"
						busy={dismissing}
						disabled={saving}
						icon={<X size={13} />}
						onClick={() => void handleDismiss()}
					>
						忽略
					</Button>
				</div>
			)}
		</article>
	);
}

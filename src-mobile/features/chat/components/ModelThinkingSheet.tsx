import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../../core/api";
import { BottomSheet, Button, EmptyState, IconButton, Segmented, Spinner, toast } from "../../../ui";
import {
	currentModelOpt,
	filterModels,
	groupModelsInOrder,
	isCurrentModel,
	isModelContextTooSmall,
	loadRecentModels,
	modelKey,
	modelLabel,
	recordRecentModel,
	removeRecentModel,
	resolveRecentModels,
	resolveThinkingLevels,
	splitProviderGroups,
	THINK_DESC,
	thinkLabel,
	type ModelFacts,
	type ModelOpt,
} from "../lib/models";
import { useModelFacts, type ModelSource } from "./useModelFacts";

/** Search results beyond this are not rendered; the user narrows the query instead. */
const SEARCH_CAP = 80;
const TAB_RECENT = "__recent__";
const providerTab = (provider: string) => `p:${provider}`;

/**
 * Mobile two-pane model + thinking sheet:
 * - Sticky header: compact thinking segmented control + full-width search bar
 * - Search mode: flat cross-provider results across full width
 * - Browse mode: left rail (常用 + configured providers + collapsible unconfigured toggle) + right model list
 */
export function ModelThinkingSheet({
	open,
	onClose,
	source,
	currentLevel,
	contextTokens,
	onFacts,
}: {
	open: boolean;
	onClose: () => void;
	source: ModelSource;
	currentLevel?: string | null;
	contextTokens?: number | null;
	onFacts: (f: ModelFacts & { model?: string }) => void;
}) {
	const { data, loading, error, configuredProviders, providerLabels, providerOrder, reload, patch } = useModelFacts(open, source);
	const [q, setQ] = useState("");
	const [activeTab, setActiveTab] = useState<string | null>(null);
	const [showUnconfigured, setShowUnconfigured] = useState(false);
	const [recentKeys, setRecentKeys] = useState<string[]>(() => loadRecentModels());
	const [busy, setBusy] = useState(false);
	const initializedTab = useRef(false);

	const models = data?.models ?? [];
	const current = data?.current ?? null;
	const curOpt = data ? currentModelOpt(data.models, data.current) : null;

	const allGroups = useMemo(() => groupModelsInOrder(models), [models]);
	const { configured: configuredGroups, unconfigured: unconfiguredGroups } = useMemo(
		() => splitProviderGroups(allGroups, configuredProviders, providerOrder),
		[allGroups, configuredProviders, providerOrder],
	);
	const recentModels = useMemo(() => resolveRecentModels(models, recentKeys), [models, recentKeys]);

	useEffect(() => {
		if (open) {
			setQ("");
			setRecentKeys(loadRecentModels());
			setShowUnconfigured(false);
		} else {
			initializedTab.current = false;
		}
	}, [open]);

	// Initialize selected rail tab once per open so model/thinking updates keep navigation stable.
	useEffect(() => {
		if (!open || !data || initializedTab.current) return;
		initializedTab.current = true;
		const cur = currentModelOpt(data.models, data.current);
		const recents = resolveRecentModels(data.models, loadRecentModels());
		if (cur) {
			setActiveTab(providerTab(cur.provider));
			if (unconfiguredGroups.some((g) => g.provider === cur.provider)) {
				setShowUnconfigured(true);
			}
		} else if (recents.length > 0) {
			setActiveTab(TAB_RECENT);
		} else {
			const first = configuredGroups[0] ?? unconfiguredGroups[0];
			setActiveTab(first ? providerTab(first.provider) : null);
		}
	}, [open, data, configuredGroups, unconfiguredGroups]);

	const searching = q.trim() !== "";
	const results = useMemo(() => (searching ? filterModels(models, q, providerLabels) : []), [models, q, searching, providerLabels]);

	const effectiveTab = useMemo(() => {
		if (activeTab === TAB_RECENT && recentModels.length > 0) return TAB_RECENT;
		if (activeTab?.startsWith("p:")) {
			const name = activeTab.slice(2);
			if (allGroups.some((g) => g.provider === name)) return activeTab;
		}
		if (curOpt) return providerTab(curOpt.provider);
		if (recentModels.length > 0) return TAB_RECENT;
		const first = configuredGroups[0] ?? unconfiguredGroups[0];
		return first ? providerTab(first.provider) : null;
	}, [activeTab, recentModels.length, allGroups, curOpt, configuredGroups, unconfiguredGroups]);

	const activeProviderGroup = useMemo(() => {
		if (!effectiveTab?.startsWith("p:")) return null;
		const name = effectiveTab.slice(2);
		return allGroups.find((g) => g.provider === name) ?? null;
	}, [effectiveTab, allGroups]);

	const level = data?.thinkingLevel ?? currentLevel ?? null;
	const levels = data ? resolveThinkingLevels(curOpt, data.liveThinking, level) : [];
	const curLevel = level || "auto";

	const providerDisplay = (id: string) => providerLabels[id] || id;

	const pickModel = async (m: ModelOpt) => {
		if (busy) return;
		setBusy(true);
		try {
			const r = await source.setModel(m);
			setRecentKeys(recordRecentModel(modelKey(m)));
			patch({ ...r, current: r.current ?? { provider: m.provider, id: m.id } });
			onFacts({ ...r, model: modelKey(m) });
		} catch (e) {
			toast(`切换模型失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setBusy(false);
		}
	};

	const pickThinking = async (l: string) => {
		if (busy) return;
		setBusy(true);
		try {
			const r = await source.setThinking(l);
			patch({ ...r, current: r.current ?? current });
			onFacts(r);
		} catch (e) {
			toast(`切换思考强度失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setBusy(false);
		}
	};

	const renderModelRow = (m: ModelOpt, { showProvider, removable }: { showProvider: boolean; removable: boolean }) => {
		const on = isCurrentModel(m, current);
		const label = modelLabel(m);
		const tooSmall = isModelContextTooSmall(m, contextTokens);
		const sub = showProvider
			? label !== m.id
				? `${providerDisplay(m.provider)} · ${m.id}`
				: providerDisplay(m.provider)
			: label !== m.id
				? m.id
				: null;
		return (
			<div
				key={`${removable ? "recent:" : ""}${modelKey(m)}`}
				className={`flex items-center border-b border-m-border/50 last:border-b-0 ${on ? "bg-m-accent-soft/55" : ""}`}
			>
				<button
					type="button"
					onClick={() => void pickModel(m)}
					disabled={busy}
					aria-current={on ? "true" : undefined}
					className="flex min-h-12 min-w-0 flex-1 items-center justify-between gap-2.5 px-3.5 py-2.5 text-left active:bg-m-surface-hover disabled:opacity-45"
				>
					<div className="min-w-0 flex-1">
						<div className={`text-m-sm leading-snug break-words [overflow-wrap:anywhere] ${on ? "font-semibold text-m-text" : "font-medium text-m-text"}`}>
							{label}
						</div>
						{sub && (
							<div className="mt-0.5 font-m-mono text-[11px] leading-tight break-words [overflow-wrap:anywhere] text-m-text-3">
								{sub}
							</div>
						)}
						{tooSmall && (
							<div className="mt-0.5 text-[11.5px] leading-tight text-m-warn">
								上下文窗口小于当前对话
							</div>
						)}
					</div>
					{on && <Check size={18} className="shrink-0 text-m-accent" aria-label="当前模型" />}
				</button>
				{removable && (
					<button
						type="button"
						aria-label={`从常用移除 ${label}`}
						onClick={() => setRecentKeys(removeRecentModel(modelKey(m)))}
						disabled={busy}
						className="mr-1 flex h-10 w-9 shrink-0 items-center justify-center rounded-m-sm text-m-text-3 active:bg-m-surface-hover active:text-m-text disabled:opacity-40"
					>
						<X size={15} />
					</button>
				)}
			</div>
		);
	};

	const renderRailButton = ({
		tabId,
		label,
		count,
		muted = false,
		nowrap = false,
	}: {
		tabId: string;
		label: string;
		count: number;
		muted?: boolean;
		nowrap?: boolean;
	}) => {
		const active = effectiveTab === tabId;
		return (
			<button
				key={tabId}
				type="button"
				role="tab"
				aria-selected={active}
				onClick={() => setActiveTab(tabId)}
				className={`relative flex min-h-11 w-full items-center justify-between gap-1.5 px-2.5 py-2 text-left transition-colors duration-(--m-dur-fast) ${
					active
						? "bg-m-bg-elev font-medium text-m-text"
						: `${muted ? "text-m-text-3" : "text-m-text-2"} active:bg-m-surface-hover`
				}`}
			>
				{active && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-m-accent" />}
				<span className={`min-w-0 flex-1 text-[12.5px] leading-[16px] ${nowrap ? "whitespace-nowrap" : "line-clamp-2 break-words"}`}>
					{label}
				</span>
				<span className="shrink-0 text-[11px] tabular-nums text-m-text-3">{count}</span>
			</button>
		);
	};

	let body;
	if (loading && !data) {
		body = (
			<div className="flex items-center justify-center gap-2 py-16 text-m-sm text-m-text-3">
				<Spinner /> 正在加载模型
			</div>
		);
	} else if (error && !data) {
		body = (
			<EmptyState
				title="模型列表加载失败"
				hint={<span className="m-selectable break-words">{error}</span>}
				action={
					<Button variant="tonal" onClick={reload}>
						重试
					</Button>
				}
			/>
		);
	} else if (!models.length) {
		body = <EmptyState title="没有可用模型" hint="请先在电脑端或设置中配置模型供应商" />;
	} else {
		const rightList = effectiveTab === TAB_RECENT ? recentModels : (activeProviderGroup?.models ?? []);
		const rightTitle =
			effectiveTab === TAB_RECENT
				? `常用 · ${recentModels.length}`
				: activeProviderGroup
					? `${providerDisplay(activeProviderGroup.provider)} · ${activeProviderGroup.models.length}`
					: "";

		body = (
			<div className="flex h-full min-h-0 flex-col">
				<div className="shrink-0 border-b border-m-border bg-m-bg-elev pb-3">
					{levels.length > 1 && (
						<div className="px-4 pb-2.5">
							<div className="mb-1 flex items-center justify-between gap-2 px-0.5">
								<span className="shrink-0 whitespace-nowrap text-m-xs text-m-text-3">思考强度</span>
								{THINK_DESC[curLevel] && (
									<span className="min-w-0 truncate text-right text-m-xs text-m-text-3">{THINK_DESC[curLevel]}</span>
								)}
							</div>
							<Segmented
								label="思考强度"
								value={curLevel}
								options={levels.map((l) => ({ value: l, label: thinkLabel(l) }))}
								onChange={(l) => void pickThinking(l)}
								disabled={busy}
								className="m-noscrollbar overflow-x-auto"
							/>
						</div>
					)}

					<div className="px-4">
						<label className="flex min-h-11 items-center gap-2.5 rounded-[10px] border border-m-border bg-m-surface py-0.5 pr-1 pl-3.5">
							<Search size={17} className="shrink-0 text-m-text-3" aria-hidden />
							<input
								type="search"
								value={q}
								onChange={(e) => setQ(e.target.value)}
								placeholder="搜索模型或供应商"
								aria-label="搜索模型"
								className="min-h-10 min-w-0 flex-1 bg-transparent text-m-md text-m-text outline-none placeholder:text-m-text-3 [&::-webkit-search-cancel-button]:appearance-none"
							/>
							{q !== "" && (
								<span className="shrink-0" onPointerDown={(event) => event.preventDefault()}>
									<IconButton icon={<X size={18} />} label="清除模型搜索" variant="plain" onClick={() => setQ("")} />
								</span>
							)}
						</label>
					</div>
				</div>

				{searching ? (
					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8">
						{results.length === 0 ? (
							<div className="py-12 text-center text-m-sm text-m-text-3">没有匹配的模型</div>
						) : (
							<>
								<div className="px-4 pt-2.5 pb-1 text-m-xs font-medium text-m-text-3">
									{results.length} 个结果
								</div>
								<div>
									{results.slice(0, SEARCH_CAP).map((m) => renderModelRow(m, { showProvider: true, removable: false }))}
								</div>
								{results.length > SEARCH_CAP && (
									<div className="px-4 pt-2.5 text-m-xs text-m-text-3">
										只列出前 {SEARCH_CAP} 个，输入更多关键词缩小范围
									</div>
								)}
							</>
						)}
					</div>
				) : (
					<div className="flex min-h-0 flex-1 overflow-hidden">
						<nav
							role="tablist"
							aria-label="模型供应商"
							className="m-noscrollbar flex w-[112px] shrink-0 flex-col overflow-y-auto overscroll-contain border-r border-m-border bg-m-surface/40 py-1 pb-8"
						>
							{recentModels.length > 0 &&
								renderRailButton({
									tabId: TAB_RECENT,
									label: "常用",
									count: recentModels.length,
									nowrap: true,
								})}
							{configuredGroups.map((g) =>
								renderRailButton({ tabId: providerTab(g.provider), label: providerDisplay(g.provider), count: g.models.length }),
							)}
							{unconfiguredGroups.length > 0 && (
								<>
									<button
										type="button"
										aria-expanded={showUnconfigured}
										onClick={() => setShowUnconfigured((v) => !v)}
										className="mt-1 flex min-h-11 w-full items-center justify-between gap-1 border-t border-m-border/70 px-2.5 py-2 text-left text-[12px] text-m-text-3 active:bg-m-surface-hover"
									>
										<span className="whitespace-nowrap">更多 ({unconfiguredGroups.length})</span>
										<ChevronDown
											size={14}
											className={`shrink-0 transition-transform duration-(--m-dur-fast) ${showUnconfigured ? "rotate-180" : ""}`}
											aria-hidden
										/>
									</button>
									{showUnconfigured && (
										<>
											<div className="px-2.5 pt-1.5 pb-0.5 text-[10.5px] whitespace-nowrap text-m-text-3/80">
												未配置
											</div>
											{unconfiguredGroups.map((g) =>
												renderRailButton({
													tabId: providerTab(g.provider),
													label: providerDisplay(g.provider),
													count: g.models.length,
													muted: true,
												}),
											)}
										</>
									)}
								</>
							)}
						</nav>

						<div role="tabpanel" className="min-w-0 flex-1 overflow-y-auto overscroll-contain bg-m-bg-elev pb-8">
							{rightTitle && (
								<div className="sticky top-0 z-(--z-base) border-b border-m-border/50 bg-m-bg-elev/95 px-3.5 py-2 text-m-xs font-medium text-m-text-3 backdrop-blur-xs">
									{rightTitle}
								</div>
							)}
							<div>
								{rightList.map((m) =>
									renderModelRow(m, {
										showProvider: effectiveTab === TAB_RECENT,
										removable: effectiveTab === TAB_RECENT,
									}),
								)}
							</div>
						</div>
					</div>
				)}
			</div>
		);
	}

	return (
		<BottomSheet
			open={open}
			onClose={onClose}
			title="模型"
			subtitle={curOpt ? modelLabel(curOpt) : current ? `${current.provider ? `${current.provider}/` : ""}${current.id}` : undefined}
			fullHeight
			headerRight={
				<Button variant="accent" size="sm" onClick={onClose} className="whitespace-nowrap">
					完成
				</Button>
			}
		>
			{body}
		</BottomSheet>
	);
}

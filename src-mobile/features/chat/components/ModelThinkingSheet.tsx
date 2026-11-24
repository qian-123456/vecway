import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../../../core/api";
import { BottomSheet, Button, EmptyState, IconButton, Spinner, toast } from "../../../ui";
import {
	currentModelOpt,
	filterModels,
	groupModelsInOrder,
	isCurrentModel,
	isModelContextTooSmall,
	loadRecentModels,
	modelKey,
	recordRecentModel,
	removeRecentModel,
	resolveRecentModels,
	splitProviderGroups,
	type ModelFacts,
	type ModelOpt,
} from "../lib/models";
import { useModelFacts, type ModelSource } from "./useModelFacts";

/** Search results beyond this are not rendered; the user narrows the query instead. */
const SEARCH_CAP = 80;
const TAB_RECENT = "__recent__";
const providerTab = (provider: string) => `p:${provider}`;

export interface CompactModelPaneProps {
	models: readonly ModelOpt[];
	current: ModelFacts["current"];
	configuredProviders?: Set<string> | null;
	providerLabels?: Record<string, string>;
	providerOrder?: readonly string[];
	contextTokens?: number | null;
	busy?: boolean;
	active?: boolean;
	query: string;
	onPick: (m: ModelOpt) => void;
	/** Optional rows prepended above model groups (e.g. preset roles in PlanApprovalControls). */
	extraTopSection?: ReactNode;
}

/**
 * Compact two-pane model browser:
 * - Left rail: 常用 + configured providers + collapsible 更多(N)
 * - Right pane: single-line model ID rows (provider caption only in 常用/search)
 * - No thinking-level controls and no duplicate 2-line display names
 */
export function CompactModelPane({
	models,
	current,
	configuredProviders = null,
	providerLabels = {},
	providerOrder = [],
	contextTokens,
	busy = false,
	active = true,
	query,
	onPick,
	extraTopSection,
}: CompactModelPaneProps) {
	const [activeTab, setActiveTab] = useState<string | null>(null);
	const [showUnconfigured, setShowUnconfigured] = useState(false);
	const [recentKeys, setRecentKeys] = useState<string[]>(() => loadRecentModels());
	const initializedTab = useRef(false);
	const scrolledOnOpen = useRef(false);
	const railContainerRef = useRef<HTMLElement | null>(null);
	const listContainerRef = useRef<HTMLDivElement | null>(null);
	const activeRailRef = useRef<HTMLButtonElement | null>(null);
	const activeModelRef = useRef<HTMLDivElement | null>(null);

	const modelList = useMemo(() => [...models], [models]);
	const curOpt = useMemo(() => currentModelOpt(modelList, current), [modelList, current]);
	const allGroups = useMemo(() => groupModelsInOrder(modelList), [modelList]);
	const { configured: configuredGroups, unconfigured: unconfiguredGroups } = useMemo(
		() => splitProviderGroups(allGroups, configuredProviders, [...providerOrder]),
		[allGroups, configuredProviders, providerOrder],
	);
	const recentModels = useMemo(() => resolveRecentModels(modelList, recentKeys), [modelList, recentKeys]);

	useEffect(() => {
		if (active) {
			setRecentKeys(loadRecentModels());
			setShowUnconfigured(false);
		} else {
			initializedTab.current = false;
			scrolledOnOpen.current = false;
			setActiveTab(null);
		}
	}, [active, current?.provider, current?.id]);

	useEffect(() => {
		if (!active || modelList.length === 0 || initializedTab.current) return;
		initializedTab.current = true;
		const cur = currentModelOpt(modelList, current);
		const recents = resolveRecentModels(modelList, loadRecentModels());
		if (cur) {
			setActiveTab((prev) => prev ?? providerTab(cur.provider));
			if (unconfiguredGroups.some((g) => g.provider === cur.provider)) {
				setShowUnconfigured(true);
			}
		} else if (recents.length > 0) {
			setActiveTab((prev) => prev ?? TAB_RECENT);
		} else {
			const first = configuredGroups[0] ?? unconfiguredGroups[0];
			setActiveTab((prev) => prev ?? (first ? providerTab(first.provider) : null));
		}
	}, [active, modelList, current, configuredGroups, unconfiguredGroups]);

	const searching = query.trim() !== "";
	const results = useMemo(() => (searching ? filterModels(modelList, query, providerLabels) : []), [modelList, query, searching, providerLabels]);

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

	useEffect(() => {
		if (!active || !effectiveTab || searching || scrolledOnOpen.current) return;
		scrolledOnOpen.current = true;
		const centerIn = (container: HTMLElement | null, child: HTMLElement | null) => {
			if (!container || !child) return;
			const cRect = container.getBoundingClientRect();
			const elRect = child.getBoundingClientRect();
			if (cRect.height <= 0 || elRect.height <= 0) return;
			const nextTop = container.scrollTop + (elRect.top - cRect.top) - (cRect.height - elRect.height) / 2;
			container.scrollTop = Math.max(0, nextTop);
		};
		const raf = requestAnimationFrame(() => {
			centerIn(railContainerRef.current, activeRailRef.current);
			centerIn(listContainerRef.current, activeModelRef.current);
		});
		return () => cancelAnimationFrame(raf);
	}, [active, effectiveTab, searching]);

	const providerDisplay = (id: string) => providerLabels[id] || id;

	const renderModelRow = (m: ModelOpt, { showProvider, removable }: { showProvider: boolean; removable: boolean }) => {
		const on = curOpt ? m.provider === curOpt.provider && m.id === curOpt.id : isCurrentModel(m, current);
		const tooSmall = isModelContextTooSmall(m, contextTokens);
		const providerLine = showProvider ? providerDisplay(m.provider) : null;
		return (
			<div
				key={`${removable ? "recent:" : ""}${modelKey(m)}`}
				ref={on ? activeModelRef : undefined}
				className={`flex items-center border-b border-m-border/45 last:border-b-0 ${on ? "bg-m-accent-soft/45" : ""}`}
			>
				<button
					type="button"
					onClick={() => onPick(m)}
					disabled={busy}
					aria-current={on ? "true" : undefined}
					className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 px-3.5 py-2 text-left active:bg-m-surface-hover disabled:opacity-45"
				>
					<div className="min-w-0 flex-1">
						<div className={`font-m-mono text-[13px] leading-snug break-words [overflow-wrap:anywhere] ${on ? "font-semibold text-m-accent" : "font-medium text-m-text"}`}>
							{m.id}
						</div>
						{providerLine && (
							<div className="mt-0.5 text-[11px] leading-tight text-m-text-3">
								{providerLine}
							</div>
						)}
						{tooSmall && (
							<div className="mt-0.5 text-[11.5px] leading-tight text-m-warn">
								上下文窗口小于当前对话
							</div>
						)}
					</div>
					{on && <Check size={16} strokeWidth={2.2} className="shrink-0 text-m-accent" aria-label="当前模型" />}
				</button>
				{removable && (
					<button
						type="button"
						aria-label={`从常用移除 ${m.id}`}
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
		const isTabActive = effectiveTab === tabId;
		return (
			<button
				key={tabId}
				ref={isTabActive ? activeRailRef : undefined}
				type="button"
				role="tab"
				aria-selected={isTabActive}
				onClick={() => setActiveTab(tabId)}
				className={`relative flex min-h-10.5 w-full items-center justify-between gap-1.5 px-2.5 py-1.5 text-left transition-colors duration-(--m-dur-fast) ${
					isTabActive
						? "bg-m-bg-elev font-medium text-m-text"
						: `${muted ? "text-m-text-3" : "text-m-text-2"} active:bg-m-surface-hover`
				}`}
			>
				{isTabActive && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-m-accent" />}
				<span className={`min-w-0 flex-1 text-[12.5px] leading-[16px] ${nowrap ? "whitespace-nowrap" : "line-clamp-2 break-words"}`}>
					{label}
				</span>
				<span className="shrink-0 text-[11px] tabular-nums text-m-text-3">{count}</span>
			</button>
		);
	};

	if (searching) {
		return (
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
				{extraTopSection}
				{results.length === 0 ? (
					<div className="py-10 text-center text-m-sm text-m-text-3">没有匹配的模型</div>
				) : (
					<>
						<div className="px-4 pt-2 pb-1 text-m-xs font-medium text-m-text-3">
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
		);
	}

	const rightList = effectiveTab === TAB_RECENT ? recentModels : (activeProviderGroup?.models ?? []);
	const rightTitle =
		effectiveTab === TAB_RECENT
			? `常用 · ${recentModels.length}`
			: activeProviderGroup
				? `${providerDisplay(activeProviderGroup.provider)} · ${activeProviderGroup.models.length}`
				: "";

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			{extraTopSection}
			<div className="flex min-h-0 flex-1 overflow-hidden">
				<nav
					ref={railContainerRef}
					role="tablist"
					aria-label="模型供应商"
					className="m-noscrollbar flex w-[112px] shrink-0 flex-col overflow-y-auto overscroll-contain border-r border-m-border bg-m-surface/40 py-1 pb-6"
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
								className="mt-1 flex min-h-10.5 w-full items-center justify-between gap-1 border-t border-m-border/70 px-2.5 py-2 text-left text-[12px] text-m-text-3 active:bg-m-surface-hover"
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

				<div ref={listContainerRef} role="tabpanel" className="min-w-0 flex-1 overflow-y-auto overscroll-contain bg-m-bg-elev pb-6">
					{rightTitle && (
						<div className="sticky top-0 z-(--z-base) border-b border-m-border/50 bg-m-bg-elev/95 px-3.5 py-1.5 text-[11.5px] font-medium text-m-text-3 backdrop-blur-xs">
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
		</div>
	);
}

/**
 * Compact model-only picker sheet:
 * - Compact search bar + close button (no bloated title/subtitle header, no 完成 button)
 * - Single-line model ID rows; tapping picks the model and closes immediately
 */
export function ModelThinkingSheet({
	open,
	onClose,
	source,
	contextTokens,
	onFacts,
}: {
	open: boolean;
	onClose: () => void;
	source: ModelSource;
	/** Retained on props for backward compatibility with callers; thinking now lives in ThinkingLevelPopover. */
	currentLevel?: string | null;
	contextTokens?: number | null;
	onFacts: (f: ModelFacts & { model?: string }) => void;
}) {
	const { data, loading, error, configuredProviders, providerLabels, providerOrder, reload, patch } = useModelFacts(open, source);
	const [q, setQ] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (open) setQ("");
	}, [open]);

	const models = data?.models ?? [];
	const current = data?.current ?? null;

	const pickModel = async (m: ModelOpt) => {
		if (busy) return;
		setBusy(true);
		try {
			const r = await source.setModel(m);
			recordRecentModel(modelKey(m));
			patch({ ...r, current: r.current ?? { provider: m.provider, id: m.id } });
			onFacts({ ...r, model: modelKey(m) });
			onClose();
		} catch (e) {
			toast(`切换模型失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setBusy(false);
		}
	};

	let body: ReactNode;
	if (loading && !data) {
		body = (
			<div className="flex flex-1 items-center justify-center gap-2 py-14 text-m-sm text-m-text-3">
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
		body = (
			<CompactModelPane
				models={models}
				current={current}
				configuredProviders={configuredProviders}
				providerLabels={providerLabels}
				providerOrder={providerOrder}
				contextTokens={contextTokens}
				busy={busy}
				active={open}
				query={q}
				onPick={(m) => void pickModel(m)}
			/>
		);
	}

	return (
		<BottomSheet open={open} onClose={onClose} ariaLabel="模型">
			<div className="flex h-[62dvh] max-h-[540px] flex-col">
				<div className="flex shrink-0 items-center gap-2 border-b border-m-border bg-m-bg-elev px-3.5 pt-0.5 pb-2.5">
					<label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-m-border bg-m-surface py-0.5 pr-1 pl-3">
						<Search size={16} className="shrink-0 text-m-text-3" aria-hidden />
						<input
							type="search"
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder="搜索模型或供应商"
							aria-label="搜索模型"
							className="min-h-9 min-w-0 flex-1 bg-transparent text-m-md text-m-text outline-none placeholder:text-m-text-3 [&::-webkit-search-cancel-button]:appearance-none"
						/>
						{q !== "" && (
							<span className="shrink-0" onPointerDown={(event) => event.preventDefault()}>
								<IconButton icon={<X size={16} />} label="清除模型搜索" variant="plain" size="sm" onClick={() => setQ("")} />
							</span>
						)}
					</label>
					<IconButton icon={<X size={18} />} label="关闭" variant="plain" size="sm" onClick={onClose} />
				</div>
				{body}
			</div>
		</BottomSheet>
	);
}

import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ThinkingLevelPopover } from "../features/chat/components/ThinkingLevelPopover";
import { desktopThinkingLabel, resolveThinkingLevels, thinkLabel } from "../features/chat/lib/models";

/** Minimal catalog model shape (mirrors the backend `Model` contract). */
export interface PickerModel {
	provider: string;
	id: string;
	name?: string;
	thinking?: string[];
	contextWindow?: number | null;
	reasoning?: boolean | null;
}

export interface PickerValue {
	provider: string;
	modelId: string;
}

export interface ProviderGroup {
	provider: string;
	models: PickerModel[];
}

/** Group models by provider, keeping first-seen provider order. */
export function groupModels(models: PickerModel[]): ProviderGroup[] {
	const order: string[] = [];
	const by = new Map<string, PickerModel[]>();
	for (const m of models) {
		let list = by.get(m.provider);
		if (!list) {
			list = [];
			by.set(m.provider, list);
			order.push(m.provider);
		}
		list.push(m);
	}
	return order.map((provider) => ({ provider, models: by.get(provider) ?? [] }));
}

/** Search flattens across providers: every term must match provider, id or name. */
export function filterModels(models: PickerModel[], query: string): PickerModel[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return models;
	return models.filter((m) => {
		const hay = `${m.provider} ${m.id} ${m.name ?? ""}`.toLowerCase();
		return terms.every((t) => hay.includes(t));
	});
}

export const THINKING_AUTO = "auto";
export const THINKING_OFF = "off";

/**
 * Thinking choices for a model, taken from its catalog capabilities.
 * Empty when the catalog lists no levels. `null` value = auto (omit suffix).
 */
export function thinkingOptions(model: PickerModel | undefined): { value: string | null; label: string }[] {
	const levels = (model?.thinking ?? []).filter((l) => l !== THINKING_AUTO && l !== THINKING_OFF);
	if (!levels.length) return [];
	return [
		{ value: null, label: "自动" },
		...levels.map((l) => ({ value: l, label: thinkLabel(l) })),
		{ value: THINKING_OFF, label: "关闭" },
	];
}

/** Search results beyond this are not rendered; the user narrows the query instead. */
const SEARCH_CAP = 80;

/**
 * Inline model picker (docs/MOBILE_DESIGN.md §4.6): providers drill into their models with a back
 * row, search flattens across providers, the selected model shows a check. Optional thinking chips
 * for the selected model below.
 */
export function ModelPicker({
	value,
	onChange,
	models,
	thinking,
	className = "",
}: {
	value: PickerValue | null;
	onChange: (model: PickerModel) => void;
	models: PickerModel[];
	/** When given, a thinking-level chip row for the selected model is shown. */
	thinking?: { value: string | null; onChange: (level: string | null) => void };
	className?: string;
}) {
	const groups = useMemo(() => groupModels(models), [models]);
	const [query, setQuery] = useState("");
	// null = provider list. Start inside the selected model's provider, or the only provider.
	const [pane, setPane] = useState<string | null>(() => value?.provider ?? (groups.length === 1 ? groups[0].provider : null));
	const searching = query.trim().length > 0;
	const paneModels = pane != null ? (groups.find((g) => g.provider === pane)?.models ?? null) : null;
	const shown = useMemo(() => (searching ? filterModels(models, query) : (paneModels ?? [])), [searching, models, query, paneModels]);
	const selected = value ? models.find((m) => m.provider === value.provider && m.id === value.modelId) : undefined;
	const options = thinking ? thinkingOptions(selected) : [];
	const levels = useMemo(() => {
		if (!thinking || options.length === 0) return [];
		const modelOpt = selected
			? {
					...selected,
					contextWindow: selected.contextWindow ?? undefined,
					reasoning: selected.reasoning ?? undefined,
				}
			: undefined;
		return resolveThinkingLevels(modelOpt, selected?.thinking, thinking.value ?? THINKING_AUTO);
	}, [thinking, options.length, selected]);
	const [thinkOpen, setThinkOpen] = useState(false);
	const thinkBtnRef = useRef<HTMLButtonElement>(null);
	const listing = searching || paneModels != null;

	return (
		<div className={`flex min-h-0 flex-col gap-3 ${className}`}>
			<div role="status" className="px-1 text-m-xs text-m-text-3">OMP 未提供完整性证明；列表可能不完整，模型可用性尚未验证。</div>
			{thinking && options.length > 0 && (
				<div className="flex shrink-0 items-center justify-between gap-3 rounded-m-lg bg-m-surface px-4 py-2.5">
					<span className="text-m-sm font-medium text-m-text">思考强度</span>
					<button
						ref={thinkBtnRef}
						type="button"
						aria-label={`思考强度：${desktopThinkingLabel(thinking.value ?? THINKING_AUTO)}`}
						onClick={() => setThinkOpen((v) => !v)}
						className="m-press inline-flex min-h-9 items-center gap-1 rounded-m-sm px-2 text-m-sm text-m-accent active:bg-m-surface-hover"
					>
						<span>{desktopThinkingLabel(thinking.value ?? THINKING_AUTO)}</span>
						<ChevronDown size={14} strokeWidth={2} aria-hidden />
					</button>
					<ThinkingLevelPopover
						open={thinkOpen}
						onClose={() => setThinkOpen(false)}
						anchorEl={thinkBtnRef.current}
						placement="bottom-end"
						levels={levels}
						value={thinking.value ?? THINKING_AUTO}
						onChange={(level) => {
							thinking.onChange(level === THINKING_AUTO ? null : level);
						}}
					/>
				</div>
			)}
			<label className="flex min-h-12 shrink-0 items-center gap-3 rounded-m-pill bg-m-surface px-4">
				<Search size={18} className="shrink-0 text-m-text-3" aria-hidden />
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="搜索模型或供应商"
					aria-label="搜索模型"
					className="min-w-0 flex-1 bg-transparent text-m-md text-m-text outline-none placeholder:text-m-text-3"
				/>
			</label>
			{!searching && paneModels != null && groups.length > 1 && (
				<button
					type="button"
					onClick={() => setPane(null)}
					className="-my-1 flex min-h-11 shrink-0 items-center gap-1 self-start rounded-m-pill pr-3 text-m-md text-m-accent active:bg-m-surface-hover"
				>
					<ChevronLeft size={22} />
					<span className="whitespace-nowrap">全部供应商</span>
					<span className="break-all text-m-text-3">· {pane}</span>
				</button>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto rounded-m-lg bg-m-card shadow-m-card">
				{listing ? (
					<div role="listbox" aria-label="模型">
						{shown.length === 0 && <div className="px-4 py-6 text-center text-m-sm text-m-text-3">没有匹配的模型</div>}
						{shown.slice(0, searching ? SEARCH_CAP : undefined).map((m, i) => {
							const active = !!value && value.provider === m.provider && value.modelId === m.id;
							return (
								<button
									key={`${m.provider}/${m.id}`}
									type="button"
									role="option"
									aria-selected={active}
									onClick={() => onChange(m)}
									className={`flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-m-surface-hover ${
										i > 0 ? "shadow-[inset_0_1px_0_var(--m-border)]" : ""
									}`}
								>
									<span className="min-w-0 flex-1">
										<span className="block font-m-mono text-[13.5px] break-all text-m-text">{m.id}</span>
										{searching && (
											<span className="mt-0.5 block text-[11px] break-all text-m-text-3">
												{m.provider}
											</span>
										)}
									</span>
									{active && <Check size={18} className="shrink-0 text-m-accent" aria-hidden />}
								</button>
							);
						})}
						{searching && shown.length > SEARCH_CAP && (
							<div className="px-4 py-3 text-m-xs text-m-text-3">只列出前 {SEARCH_CAP} 个，输入更多关键词缩小范围</div>
						)}
					</div>
				) : (
					<div aria-label="供应商">
						{groups.map((g, i) => (
							<button
								key={g.provider}
								type="button"
								onClick={() => setPane(g.provider)}
								className={`flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-m-surface-hover ${
									i > 0 ? "shadow-[inset_0_1px_0_var(--m-border)]" : ""
								}`}
							>
								<span className="min-w-0 flex-1">
									<span className="block text-m-md break-all text-m-text">{g.provider}</span>
									{value?.provider === g.provider && selected && (
										<span className="mt-0.5 block text-m-xs break-words text-m-text-3">正在使用 {selected.name || selected.id}</span>
									)}
								</span>
								<span className="shrink-0 text-m-sm tabular-nums text-m-text-3">{g.models.length}</span>
								<ChevronRight size={18} className="shrink-0 text-m-text-3" aria-hidden />
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

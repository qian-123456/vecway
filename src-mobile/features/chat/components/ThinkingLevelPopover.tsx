import { Check, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../../../core/api";
import { AnchoredPopover, type PopoverPlacement } from "../../../ui/AnchoredPopover";
import { Button } from "../../../ui/Button";
import { EffortSlider } from "../../../ui/EffortSlider";
import { Spinner } from "../../../ui/Spinner";
import { toast } from "../../../ui/Toast";
import { currentModelOpt, resolveThinkingLevels, THINK_DESC, type ModelFacts } from "../lib/models";
import { useModelFacts, type ModelSource } from "./useModelFacts";

const STATUS_NAMES: Record<string, string> = {
	auto: "Auto",
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Xhigh",
	max: "Max",
};

export function thinkingStatusName(level: string | null | undefined): string {
	const key = level?.trim() || "auto";
	return STATUS_NAMES[key] ?? key;
}

/**
 * Compact Apple-style thinking-level popover matching desktop `ThinkingLevelPicker` + `EffortSlider`:
 * - Centered `statusName(shown) ›` button toggling the full level list
 * - Single centered description line + interactive 3D EffortSlider (no bottom tick labels, no footer hint)
 */
export function ThinkingLevelPopover({
	open,
	onClose,
	anchorEl,
	placement = "top-start",
	levels,
	value,
	disabled = false,
	loading = false,
	error = null,
	onRetry,
	onChange,
}: {
	open: boolean;
	onClose: () => void;
	anchorEl: HTMLElement | null;
	placement?: PopoverPlacement;
	levels: readonly string[];
	value: string;
	disabled?: boolean;
	loading?: boolean;
	error?: string | null;
	onRetry?: () => void;
	onChange: (level: string) => void | Promise<void>;
}) {
	const [listOpen, setListOpen] = useState(false);
	const [previewIdx, setPreviewIdx] = useState<number | null>(null);

	useEffect(() => {
		if (!open) {
			setListOpen(false);
			setPreviewIdx(null);
		}
	}, [open]);

	const hasLevels = levels.length > 0;
	const safeLevels = hasLevels ? levels : ["auto"];
	const current = value || safeLevels[0] || "auto";
	const committedIdx = Math.max(0, safeLevels.indexOf(current));
	const shownIdx = previewIdx !== null && previewIdx >= 0 && previewIdx < safeLevels.length ? previewIdx : committedIdx;
	const shown = safeLevels[shownIdx] ?? current;
	const desc = THINK_DESC[shown] ?? "";

	const handlePick = async (lvl: string) => {
		if (disabled) return;
		setPreviewIdx(null);
		setListOpen(false);
		await onChange(lvl);
	};

	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			placement={placement}
			minWidth={308}
			maxWidth={356}
			className="!p-0"
		>
			{loading && !error ? (
				<div className="flex items-center justify-center gap-2 px-5 py-7 text-m-sm text-m-text-3">
					<Spinner size={18} />
					<span>加载思考档位</span>
				</div>
			) : error ? (
				<div className="space-y-2.5 p-4 text-center">
					<p className="m-selectable text-m-xs break-words text-m-danger">{error}</p>
					{onRetry && (
						<Button variant="tonal" size="sm" onClick={onRetry}>
							重试
						</Button>
					)}
				</div>
			) : !hasLevels ? (
				<div className="space-y-1.5 p-4 text-center" role="status">
					<div className="text-m-sm font-medium text-m-text-2">不支持思考</div>
					<p className="text-m-xs text-m-text-3">当前模型不支持思考，没有可调的思考等级</p>
				</div>
			) : (
				<div className="flex flex-col p-4" role="dialog" aria-label="思考强度">
					<button
						type="button"
						disabled={disabled}
						aria-expanded={listOpen}
						onClick={() => {
							setPreviewIdx(null);
							setListOpen((v) => !v);
						}}
						className="m-press mx-auto flex min-h-10 items-center justify-center gap-1 rounded-m-sm px-3 text-[15px] font-semibold tracking-tight text-m-accent active:bg-m-surface-hover disabled:opacity-45"
					>
						<span className="whitespace-nowrap">{thinkingStatusName(shown)}</span>
						<ChevronRight
							size={15}
							strokeWidth={2}
							className={`shrink-0 transition-transform duration-(--m-dur-fast) ${listOpen ? "rotate-90" : ""}`}
							aria-hidden
						/>
					</button>

					{listOpen ? (
						<div className="mt-2 flex max-h-[45dvh] flex-col gap-1 overflow-y-auto overscroll-contain" role="listbox" aria-label="全部思考档位">
							{safeLevels.map((lvl) => {
								const active = lvl === current;
								return (
									<button
										key={lvl}
										type="button"
										role="option"
										aria-selected={active}
										disabled={disabled}
										onClick={() => void handlePick(lvl)}
										className={`m-press flex min-h-12 w-full items-center justify-between gap-3 rounded-m-md px-3 py-2.5 text-left transition-colors ${
											active ? "bg-m-accent-soft/55 text-m-text" : "text-m-text active:bg-m-surface-hover"
										}`}
									>
										<div className="min-w-0 flex-1">
											<div className={`text-[14.5px] leading-tight ${active ? "font-semibold text-m-accent" : "font-medium text-m-text"}`}>
												{thinkingStatusName(lvl)}
											</div>
											{THINK_DESC[lvl] && (
												<div className="mt-0.5 text-[12px] leading-snug text-m-text-3">{THINK_DESC[lvl]}</div>
											)}
										</div>
										{active && <Check size={17} strokeWidth={2.2} className="shrink-0 text-m-accent" aria-hidden />}
									</button>
								);
							})}
						</div>
					) : (
						<div className="mt-1 flex w-full flex-col items-center">
							{desc && (
								<div className="px-2 pb-2 text-center text-[13px] leading-snug text-m-text-3">
									{desc}
								</div>
							)}
							<div className="w-full px-1 py-1">
								<EffortSlider
									count={safeLevels.length}
									value={shownIdx}
									label="思考强度"
									valueText={thinkingStatusName(shown)}
									onPreview={setPreviewIdx}
									onCommit={(idx) => {
										const lvl = safeLevels[idx];
										if (lvl) void handlePick(lvl);
									}}
									onCancel={() => setPreviewIdx(null)}
								/>
							</div>
						</div>
					)}
				</div>
			)}
		</AnchoredPopover>
	);
}

/**
 * Source-backed wrapper for ChatPage, HomePage, and SidechatPage thinking triggers.
 */
export function ThinkingSourcePopover({
	open,
	onClose,
	anchorEl,
	source,
	currentLevel,
	onFacts,
}: {
	open: boolean;
	onClose: () => void;
	anchorEl: HTMLElement | null;
	source: ModelSource;
	currentLevel?: string | null;
	onFacts: (f: ModelFacts) => void;
}) {
	const { data, loading, error, reload, patch } = useModelFacts(open, source);
	const [busy, setBusy] = useState(false);

	const curOpt = data ? currentModelOpt(data.models, data.current) : null;
	const activeLevel = data?.thinkingLevel ?? currentLevel ?? null;
	const levels = data
		? resolveThinkingLevels(curOpt, data.liveThinking, curOpt?.thinking?.length || data.liveThinking?.length ? activeLevel : null)
		: [];
	const handleChange = async (lvl: string) => {
		if (busy) return;
		setBusy(true);
		try {
			const res = await source.setThinking(lvl);
			patch({ ...res, current: res.current ?? data?.current ?? null });
			onFacts(res);
		} catch (e) {
			toast(`切换思考强度失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<ThinkingLevelPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			levels={levels}
			value={activeLevel || "auto"}
			disabled={busy}
			loading={loading && !data}
			error={error && !data ? error : null}
			onRetry={reload}
			onChange={handleChange}
		/>
	);
}

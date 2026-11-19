/** Shared Model + Thinking-level toolbar controls for Composer and PromptComposer. */
import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useRef } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import { ModelMenuContent } from "../../components/ModelSelect";
import { ThinkingLevelPicker, ThinkingLevelStrip } from "../../components/ThinkingLevelPicker";
import type { ModelOption } from "../../lib/models";
import { useT } from "../../stores/language";
import { mergedSuffix, TIER_BADGE, TIER_MERGED, TIER_TIGHT, type ThinkingKind } from "./composerToolbar";

export function ComposerModelControls({
	pickerId,
	compact,
	toolbarTier,
	models,
	modelLabel,
	currentValue,
	currentThinking,
	thinkingKind,
	thinkingLevels,
	reasoning,
	planPreview = false,
	planChoiceUnknown = false,
	contextTokens,
	modelOpen,
	onModelOpenChange,
	thinkingOpen,
	onThinkingOpenChange,
	onEnsureModels,
	onSelectModel,
	onSelectThinking,
}: {
	pickerId: string;
	compact?: boolean;
	toolbarTier: number;
	models: ModelOption[] | null;
	modelLabel: string;
	currentValue: string;
	currentThinking: string;
	thinkingKind: ThinkingKind;
	thinkingLevels: string[];
	reasoning?: boolean | null;
	planPreview?: boolean;
	planChoiceUnknown?: boolean;
	contextTokens?: number | null;
	modelOpen: boolean;
	onModelOpenChange: (open: boolean) => void;
	thinkingOpen: boolean;
	onThinkingOpenChange: (open: boolean) => void;
	onEnsureModels?: () => void;
	onSelectModel: (key: string) => void | Promise<void>;
	onSelectThinking: (level: string) => void | Promise<void>;
}) {
	const { t } = useT();
	const modelMenuRef = useRef<HTMLDivElement>(null);

	return (
		<>
			<div className="relative min-w-0" ref={modelMenuRef}>
				<button
					type="button"
					data-model-picker={pickerId}
					onClick={() => {
						const next = !modelOpen;
						onModelOpenChange(next);
						if (next && (!models || models.length === 0)) onEnsureModels?.();
					}}
					title={
						planPreview
							? t("composer.planModelTitle")
							: toolbarTier >= TIER_MERGED && thinkingKind !== "unsupported"
								? t("composer.modelThinkingTooltip", {
										model: modelLabel,
										level: currentThinking,
									})
								: modelLabel
					}
					className={clsx(
						"flex min-w-0 max-w-full items-center gap-1 rounded-md py-1 text-[12px] text-[var(--text-60,var(--text-muted))] transition-colors hover:bg-[var(--ghost-hover,var(--bg-hover))] hover:text-[var(--text)]",
						toolbarTier >= TIER_TIGHT ? "px-1.5" : "px-2",
					)}
				>
					<span className={clsx("min-w-0 truncate", !compact && "max-w-44")}>
						{modelLabel}
					</span>
					{toolbarTier >= TIER_MERGED && !planChoiceUnknown && (
						<span className="shrink-0 whitespace-pre">
							{mergedSuffix(thinkingKind, currentThinking, toolbarTier === TIER_BADGE)}
						</span>
					)}
					<ChevronDown
						size={10}
						className="shrink-0 text-[var(--text-30,var(--text-dim))]"
					/>
				</button>

				{modelOpen && (
					<FloatingLayer
						anchor={modelMenuRef.current}
						placement="top-start"
						offset={6}
						layer="popover"
						ignoreRefs={[modelMenuRef]}
						onDismiss={() => onModelOpenChange(false)}
						className="w-[min(440px,calc(100vw-24px))] rounded-xl border-[var(--line,var(--border-divider))] !bg-[var(--bg-panel)] py-1"
					>
						<ModelMenuContent
							catalogManaged
							models={models}
							currentValue={planChoiceUnknown ? "" : currentValue}
							contextTokens={contextTokens}
							onSelect={async (key) => {
								await onSelectModel(key);
								onModelOpenChange(false);
							}}
						/>
						{toolbarTier >= TIER_MERGED && !planChoiceUnknown && (
							<ThinkingLevelStrip
								levels={thinkingLevels}
								reasoning={reasoning}
								value={currentThinking}
								onSelect={(level) => {
									void onSelectThinking(level);
								}}
							/>
						)}
					</FloatingLayer>
				)}
			</div>

			{/* Thinking chip: levels from the catalog, or a grey 未配置/不支持 chip; never hidden */}
			{toolbarTier < TIER_MERGED && !planChoiceUnknown && (
				<ThinkingLevelPicker
					levels={thinkingLevels}
					reasoning={reasoning}
					value={currentThinking}
					open={thinkingOpen}
					onOpenChange={onThinkingOpenChange}
					onSelect={(level) => void onSelectThinking(level)}
					tight={toolbarTier >= TIER_TIGHT}
				/>
			)}
		</>
	);
}

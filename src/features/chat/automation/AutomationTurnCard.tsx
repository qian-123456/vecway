/**
 * [B] Compact inline reference card rendered inside an assistant turn whenever
 * that turn called `vecway_automation` (`action: "propose"`). Keeps the chat
 * stream light and scrollable while linking directly to the full draft cards
 * in the right-hand "自动化草案" panel.
 */
import clsx from "clsx";
import { ArrowUpRight, Check, Clock, X } from "lucide-react";
import { useMemo } from "react";
import type { ScheduleCadence, ToolResultInfo } from "../../../lib/contracts";
import { useT } from "../../../stores/language";
import { useLive } from "../../../stores/live";
import { useUi } from "../../../stores/ui";
import { formatCadence } from "../../schedules/humanCadence";
import type { TurnStep } from "../turnGrouping";
import { openAutomationDraftsPanel } from "./automationDraftFocus";
import type { AutomationDraftStatus } from "./automationStatus";

export interface TurnProposedDraftRef {
	key: string;
	draftId: string | null;
	scheduleId: string | null;
	name: string;
	cadence: ScheduleCadence | null;
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
	if (!raw) return null;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	if (typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	return null;
}

function extractDraftIdFromResult(result: ToolResultInfo | undefined): string | null {
	if (!result) return null;
	if (result.details && typeof result.details === "object" && !Array.isArray(result.details)) {
		const rawId = (result.details as Record<string, unknown>).draftId;
		if (typeof rawId === "string" && rawId.trim()) return rawId.trim();
	}
	const text = result.text ?? "";
	const match = text.match(/Staged Automation Draft Card \(([^)]+)\)/);
	return match?.[1]?.trim() || null;
}

function asOptionalCadence(raw: unknown): ScheduleCadence | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const c = raw as Record<string, unknown>;
	if (c.kind === "interval" && typeof c.minutes === "number") {
		return { kind: "interval", minutes: Math.max(1, Math.floor(c.minutes)) };
	}
	if (c.kind === "daily" && typeof c.time === "string") {
		return {
			kind: "daily",
			time: c.time,
			weekdays: Array.isArray(c.weekdays) ? c.weekdays.filter((n): n is number => typeof n === "number") : undefined,
			every: typeof c.every === "number" ? c.every : undefined,
		};
	}
	if (c.kind === "monthly" && typeof c.day === "number" && typeof c.time === "string") {
		return {
			kind: "monthly",
			day: c.day,
			time: c.time,
			every: typeof c.every === "number" ? c.every : undefined,
		};
	}
	if (c.kind === "once" && typeof c.at === "string") {
		return { kind: "once", at: c.at };
	}
	return null;
}

/** Extract unique `vecway_automation` propose calls from a turn's intermediate steps. */
export function extractTurnProposedDrafts(
	steps: readonly TurnStep[],
	toolResultsByCallId?: Map<string, ToolResultInfo>,
): TurnProposedDraftRef[] {
	const list: TurnProposedDraftRef[] = [];
	const byKey = new Map<string, number>();

	for (const step of steps) {
		if (step.kind !== "tool" || step.call.name !== "vecway_automation") continue;
		const args = parseArgs(step.call.args);
		if (!args || args.action !== "propose") continue;
		const draft = parseArgs(args.draft);
		if (!draft) continue;

		const name =
			typeof draft.name === "string" && draft.name.trim()
				? draft.name.trim()
				: "未命名自动化";
		const scheduleId =
			typeof draft.id === "string" && draft.id.trim() ? draft.id.trim() : null;
		const result = step.result ?? toolResultsByCallId?.get(step.call.id);
		const draftId = extractDraftIdFromResult(result);
		const dedupKey = scheduleId ? `id:${scheduleId}` : `name:${name}`;
		const entry: TurnProposedDraftRef = {
			key: draftId ?? dedupKey,
			draftId,
			scheduleId,
			name,
			cadence: asOptionalCadence(draft.cadence),
		};

		const existingIdx = byKey.get(dedupKey);
		if (existingIdx !== undefined) {
			list[existingIdx] = entry;
		} else {
			byKey.set(dedupKey, list.length);
			list.push(entry);
		}
	}

	return list;
}

function matchLiveDraft(
	ref: TurnProposedDraftRef,
	liveDrafts: readonly AutomationDraftStatus[],
): AutomationDraftStatus | undefined {
	if (ref.draftId) {
		const exact = liveDrafts.find((d) => d.draftId === ref.draftId);
		if (exact) return exact;
	}
	if (ref.scheduleId) {
		const bySchedule = liveDrafts.find((d) => d.draft.id === ref.scheduleId);
		if (bySchedule) return bySchedule;
	}
	return liveDrafts.find((d) => d.draft.name.trim() === ref.name.trim());
}

export function AutomationTurnCard({
	sessionId,
	steps,
	toolResultsByCallId,
}: {
	sessionId: string;
	steps: readonly TurnStep[];
	toolResultsByCallId?: Map<string, ToolResultInfo>;
}) {
	const { t, locale } = useT();
	const proposed = useMemo(
		() => extractTurnProposedDrafts(steps, toolResultsByCallId),
		[steps, toolResultsByCallId],
	);
	const liveDrafts = useLive(
		(s) => s.sessions[sessionId]?.automationState?.drafts,
	);
	const panelAlreadyOpen = useUi(
		(s) => s.rightOpen && s.rightTab === "automation" && s.selectedSessionId === sessionId,
	);

	if (proposed.length === 0) return null;

	const resolvedItems = proposed.map((ref) => ({
		ref,
		live: liveDrafts ? matchLiveDraft(ref, liveDrafts) : undefined,
	}));
	const pendingCount = resolvedItems.filter(
		(item) => (item.live?.status ?? "pending") === "pending",
	).length;
	const savedCount = resolvedItems.filter(
		(item) => item.live?.status === "saved",
	).length;
	const hasOpenableDraft =
		!liveDrafts ||
		liveDrafts.some((d) => d.status === "pending" || d.status === "saved");

	const firstOpenable =
		resolvedItems.find(
			(i) => (i.live?.status ?? "pending") !== "dismissed",
		) ?? resolvedItems[0];

	return (
		<div
			data-automation-turn-card=""
			className="my-2 rounded-xl border border-[var(--border-divider)] bg-[var(--bg-panel)] px-3 py-2.5 text-xs select-text"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
					<span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-semibold text-[var(--text)]">
						<Clock size={12} className="shrink-0 text-amber-400" />
						<span>
							{proposed.length === 1
								? t("schedules.draftTurnCardTitleSingle")
								: t("schedules.draftTurnCardTitleMulti", { count: proposed.length })}
						</span>
					</span>
					{pendingCount > 0 && (
						<span className="inline-flex shrink-0 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
							{t("schedules.draftTrayPendingCount", { count: pendingCount })}
						</span>
					)}
					{savedCount > 0 && (
						<span className="inline-flex shrink-0 whitespace-nowrap rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
							{t("schedules.draftTraySavedCount", { count: savedCount })}
						</span>
					)}
				</div>
				{hasOpenableDraft && (
					<button
						type="button"
						onClick={() =>
							openAutomationDraftsPanel(sessionId, {
								draftId: firstOpenable?.live?.draftId ?? firstOpenable?.ref.draftId,
								name: firstOpenable?.ref.name,
							})
						}
						className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-400 transition-colors hover:bg-amber-500/20 select-none"
					>
						<span>
							{panelAlreadyOpen
								? t("schedules.draftTurnFocusPanel")
								: t("schedules.draftTurnOpenPanel")}
						</span>
						<ArrowUpRight size={11} className="shrink-0" />
					</button>
				)}
			</div>

			<div className="mt-2 space-y-1">
				{resolvedItems.map(({ ref, live }) => {
					const status = live?.status ?? "pending";
					const cadence = live?.draft.cadence ?? ref.cadence;
					const clickable = status !== "dismissed" && hasOpenableDraft;
					return (
						<button
							key={ref.key}
							type="button"
							disabled={!clickable}
							onClick={() => {
								if (!clickable) return;
								openAutomationDraftsPanel(sessionId, {
									draftId: live?.draftId ?? ref.draftId,
									name: ref.name,
								});
							}}
							className={clsx(
								"flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1 text-left transition-colors",
								clickable
									? "cursor-pointer hover:border-[var(--border-divider)] hover:bg-[var(--bg-hover)]"
									: "cursor-default opacity-60",
							)}
						>
							<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
								<span className="break-words text-[12px] font-medium text-[var(--text)]">
									{live?.draft.name ?? ref.name}
								</span>
								{cadence && (
									<span className="shrink-0 whitespace-nowrap text-[10.5px] text-[var(--text-40)]">
										{formatCadence(cadence, locale)}
									</span>
								)}
							</div>
							<span
								className={clsx(
									"inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium",
									status === "saved"
										? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
										: status === "dismissed"
											? "border-[var(--border-divider)] bg-[var(--bg)] text-[var(--text-40)]"
											: "border-amber-500/35 bg-amber-500/10 text-amber-400",
								)}
							>
								{status === "saved" && <Check size={9} className="shrink-0" />}
								{status === "dismissed" && <X size={9} className="shrink-0" />}
								<span>
									{status === "saved"
										? t("schedules.draftStatusSaved")
										: status === "dismissed"
											? t("schedules.draftStatusDismissed")
											: t("schedules.draftStatusPending")}
								</span>
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

/**
 * Compact in-stream card rendered in TurnView whenever a turn called
 * `vecway_automation` (`action: "propose"`). Tapping opens the right workspace
 * drawer on the "automation" tab and scrolls/highlights the target draft.
 */
import { CalendarClock, CheckCircle2, ChevronRight, Sparkles, XCircle } from "lucide-react";
import type { ToolItem } from "../../../core/types";
import { cadenceText } from "../../more/schedule";
import { useRightDrawer } from "../../panels/rightDrawerStore";
import type { AutomationDraftStatus, AutomationSessionState } from "./automationStatus";

export interface ExtractedProposeCall {
	toolId: string;
	draftId?: string;
	scheduleId?: string;
	name: string;
	running: boolean;
}

/** Extract unique `vecway_automation` propose calls from a turn's tool items. */
export function extractAutomationProposeCalls(tools: readonly ToolItem[]): ExtractedProposeCall[] {
	const out: ExtractedProposeCall[] = [];
	const seenKeys = new Set<string>();
	for (const tool of tools) {
		if (tool.name !== "vecway_automation") continue;
		const args = tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>) : null;
		const action = tool.details?.action ?? (typeof args?.action === "string" ? args.action : undefined);
		const draftId = tool.details?.draftId;
		if (action !== "propose" && !draftId) continue;
		const draftArg =
			args?.draft && typeof args.draft === "object" ? (args.draft as Record<string, unknown>) : null;
		const scheduleId =
			tool.details?.scheduleId ?? (typeof draftArg?.id === "string" && draftArg.id ? draftArg.id : undefined);
		const name =
			typeof draftArg?.name === "string" && draftArg.name.trim()
				? draftArg.name.trim()
				: "自动化草案";
		const key = draftId ?? scheduleId ?? `${tool.id}:${name}`;
		if (seenKeys.has(key)) continue;
		seenKeys.add(key);
		out.push({
			toolId: tool.id,
			draftId,
			scheduleId,
			name,
			running: tool.status === "running",
		});
	}
	return out;
}

/** Match a propose call to an AutomationDraftStatus by draftId -> scheduleId -> name. */
export function matchAutomationDraft(
	call: ExtractedProposeCall,
	state: AutomationSessionState | null | undefined,
): AutomationDraftStatus | null {
	const drafts = state?.drafts ?? [];
	if (drafts.length === 0) return null;
	if (call.draftId) {
		return drafts.find((d) => d.draftId === call.draftId) ?? null;
	}
	if (call.scheduleId) {
		const hit = drafts.find((d) => d.draft.id === call.scheduleId);
		if (hit) return hit;
	}
	return drafts.find((d) => d.draft.name === call.name) ?? null;
}

export function AutomationTurnCard({
	sessionId,
	calls,
	automationState,
}: {
	sessionId: string;
	calls: readonly ExtractedProposeCall[];
	automationState: AutomationSessionState | null | undefined;
}) {
	if (calls.length === 0) return null;

	return (
		<div className="my-2 flex flex-col gap-2" data-testid="automation-turn-cards">
			{calls.map((call) => {
				const matched = matchAutomationDraft(call, automationState);
				const status = matched?.status ?? (call.running ? "running" : "pending");
				const title = matched?.draft.name ?? call.name;
				const cadence = matched ? cadenceText(matched.draft.cadence) : "";
				const targetDraftId = matched?.draftId ?? call.draftId ?? "";

				const statusBadge =
					status === "saved"
						? { text: "已保存", cls: "bg-emerald-500/15 text-emerald-500", icon: <CheckCircle2 size={13} /> }
						: status === "dismissed"
							? { text: "已忽略", cls: "bg-m-surface text-m-text-3", icon: <XCircle size={13} /> }
							: status === "running"
								? { text: "生成中", cls: "bg-m-accent-soft text-m-accent-soft-text", icon: <Sparkles size={13} /> }
								: { text: "待确认", cls: "bg-amber-500/15 text-amber-500", icon: <CalendarClock size={13} /> };

				return (
					<button
						key={call.toolId}
						type="button"
						onClick={() => {
							if (targetDraftId) {
								useRightDrawer.getState().openAutomationDraft(sessionId, targetDraftId);
							} else {
								useRightDrawer.getState().openDrawer(sessionId, "automation");
							}
						}}
						className="flex w-full items-center gap-3 rounded-2xl border border-m-border bg-m-surface px-3.5 py-3 text-left transition-colors duration-(--m-dur-fast) active:bg-m-surface-hover"
					>
						<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-m-accent-soft text-m-accent">
							<CalendarClock size={18} strokeWidth={1.8} />
						</span>
						<span className="min-w-0 flex-1">
							<span className="flex flex-wrap items-center gap-1.5">
								<span className="text-m-sm font-semibold break-words text-m-text">{title}</span>
								<span
									className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${statusBadge.cls}`}
								>
									{statusBadge.icon}
									<span>{statusBadge.text}</span>
								</span>
							</span>
							<span className="mt-0.5 block text-m-xs break-words text-m-text-3">
								{matched?.summary || cadence || "点击在右侧抽屉查看、试跑并确认保存"}
							</span>
						</span>
						<ChevronRight size={16} className="shrink-0 text-m-text-3" aria-hidden />
					</button>
				);
			})}
		</div>
	);
}

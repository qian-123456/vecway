/**
 * [B] Right-panel "自动化草案" tab: dedicated review & test workspace for
 * automation drafts proposed in the active conversation. Keeps the center chat
 * stream 100% unobstructed while allowing full scrolling, text selection &
 * annotation back into the main composer, script testing, and confirmation.
 */
import { Clock, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../../stores/language";
import { useLive } from "../../../stores/live";
import { useUi } from "../../../stores/ui";
import { SelectionToolbar } from "../SelectionToolbar";
import { AutomationDraftCard } from "./AutomationDraftCard";
import {
	clearLatestDraftFocus,
	subscribeDraftFocus,
} from "./automationDraftFocus";

export function AutomationDraftsPanel() {
	const { t } = useT();
	const sessionId = useUi((s) => s.selectedSessionId);
	const automationState = useLive((s) =>
		sessionId ? s.sessions[sessionId]?.automationState : undefined,
	);
	const streaming = useLive((s) =>
		sessionId ? s.sessions[sessionId]?.streaming === true : false,
	);

	const visibleDrafts = useMemo(
		() =>
			(automationState?.drafts ?? []).filter(
				(d) => d.status === "pending" || d.status === "saved",
			),
		[automationState?.drafts],
	);

	const pendingCount = useMemo(
		() => visibleDrafts.filter((d) => d.status === "pending").length,
		[visibleDrafts],
	);
	const savedCount = useMemo(
		() => visibleDrafts.filter((d) => d.status === "saved").length,
		[visibleDrafts],
	);

	const scrollRef = useRef<HTMLDivElement>(null);
	const cardRefs = useRef(new Map<string, HTMLDivElement>());
	const [highlightedId, setHighlightedId] = useState<string | null>(null);

	useEffect(() => {
		if (!sessionId) return;
		let clearTimer: ReturnType<typeof setTimeout> | null = null;
		const unsub = subscribeDraftFocus((req) => {
			if (req.sessionId !== sessionId) return;
			const target = visibleDrafts.find(
				(d) =>
					(req.draftId && d.draftId === req.draftId) ||
					(req.name && d.draft.name.trim() === req.name.trim()),
			);
			if (!target) return;
			clearLatestDraftFocus(req.nonce);
			const el = cardRefs.current.get(target.draftId);
			if (el) {
				el.scrollIntoView({ block: "nearest", behavior: "smooth" });
			}
			setHighlightedId(target.draftId);
			if (clearTimer) clearTimeout(clearTimer);
			clearTimer = setTimeout(() => {
				setHighlightedId((cur) => (cur === target.draftId ? null : cur));
			}, 1800);
		});
		return () => {
			unsub();
			if (clearTimer) clearTimeout(clearTimer);
		};
	}, [sessionId, visibleDrafts]);

	if (!sessionId || visibleDrafts.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center px-6 text-center">
				<div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--border-divider)] bg-[var(--bg-panel)] text-amber-400">
					<Clock size={18} />
				</div>
				<p className="mt-3 text-[13px] font-medium text-[var(--text)]">
					{t("schedules.draftPanelEmpty")}
				</p>
				<p className="mt-1.5 max-w-[260px] text-[12px] leading-relaxed text-[var(--text-40)]">
					{t("schedules.draftPanelEmptyHint")}
				</p>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Compact sticky header summarizing current draft statuses */}
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-divider)] px-3.5 py-2">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-semibold text-[var(--text)]">
						<Clock size={13} className="shrink-0 text-amber-400" />
						<span>{t("schedules.draftCardTitle")}</span>
					</span>
					{pendingCount > 0 && (
						<span className="inline-flex shrink-0 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-400">
							{t("schedules.draftTrayPendingCount", { count: pendingCount })}
						</span>
					)}
					{savedCount > 0 && (
						<span className="inline-flex shrink-0 whitespace-nowrap rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-400">
							{t("schedules.draftTraySavedCount", { count: savedCount })}
						</span>
					)}
				</div>
				{streaming && (
					<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10.5px] font-medium text-sky-400">
						<Loader2 size={10} className="shrink-0 animate-spin" />
						<span>{t("schedules.draftTrayRunningHint")}</span>
					</span>
				)}
			</div>

			{/* Full-height scrollable cards list with native text selection & annotation into main composer */}
			<div
				ref={scrollRef}
				data-automation-drafts-scroll=""
				className="relative min-h-0 flex-1 space-y-2.5 overflow-y-auto overflow-x-clip px-3 py-3 select-text"
			>
				{visibleDrafts.map((draftStatus) => (
					<div
						key={draftStatus.draftId}
						ref={(el) => {
							if (el) cardRefs.current.set(draftStatus.draftId, el);
							else cardRefs.current.delete(draftStatus.draftId);
						}}
					>
						<AutomationDraftCard
							sessionId={sessionId}
							status={draftStatus}
							embedded
							highlighted={highlightedId === draftStatus.draftId}
						/>
					</div>
				))}
				<SelectionToolbar sessionId={sessionId} containerRef={scrollRef} compact />
			</div>
		</div>
	);
}

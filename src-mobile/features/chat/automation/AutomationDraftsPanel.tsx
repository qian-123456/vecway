/**
 * Right workspace drawer "automation" panel listing pending and resolved automation drafts
 * for the active chat session. Scrolls smoothly (respecting reduced-motion) to any draft
 * opened from an in-stream AutomationTurnCard.
 */
import { CalendarClock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../../../ui";
import { scrollBehavior } from "../../../ui/motion";
import { useRightDrawer } from "../../panels/rightDrawerStore";
import { AutomationDraftCard } from "./AutomationDraftCard";
import type { AutomationSessionState } from "./automationStatus";

export function AutomationDraftsPanel({
	sessionId,
	automationState,
	onResolve,
}: {
	sessionId: string;
	automationState: AutomationSessionState | null;
	onResolve: (draftId: string, resolution: "saved" | "dismissed") => Promise<void>;
}) {
	const focused = useRightDrawer((s) => s.focusedAutomationDraft);
	const listRef = useRef<HTMLDivElement>(null);
	const [highlightId, setHighlightId] = useState<string | null>(null);

	const drafts = automationState?.drafts ?? [];
	const pending = drafts.filter((d) => d.status === "pending");
	const history = drafts.filter((d) => d.status !== "pending");

	useEffect(() => {
		if (!focused || focused.sessionId !== sessionId || !focused.draftId) return;
		const el = listRef.current?.querySelector<HTMLElement>(
			`[data-draft-id="${CSS.escape(focused.draftId)}"]`,
		);
		if (el && typeof el.scrollIntoView === "function") {
			el.scrollIntoView({ behavior: scrollBehavior(), block: "nearest" });
		}
		setHighlightId(focused.draftId);
		const timer = window.setTimeout(() => setHighlightId(null), 1600);
		return () => window.clearTimeout(timer);
	}, [focused, sessionId]);

	if (drafts.length === 0) {
		return (
			<EmptyState
				className="min-h-[45vh]"
				icon={<CalendarClock size={24} strokeWidth={1.75} />}
				title="暂无自动化草案"
				hint="在对话中描述想定期执行的任务，AI 生成草案后会出现在这里"
			/>
		);
	}

	return (
		<div ref={listRef} className="flex flex-col gap-3 px-4 py-3 pb-8">
			{pending.length > 0 && (
				<section className="flex flex-col gap-2.5">
					<h4 className="px-1 text-m-xs font-medium text-m-text-3">
						待确认草案（{pending.length}）
					</h4>
					{pending.map((item) => (
						<AutomationDraftCard
							key={item.draftId}
							sessionId={sessionId}
							item={item}
							highlighted={highlightId === item.draftId}
							onResolve={onResolve}
						/>
					))}
				</section>
			)}
			{history.length > 0 && (
				<section className="flex flex-col gap-2.5">
					<h4 className="px-1 text-m-xs font-medium text-m-text-3">
						已处理草案（{history.length}）
					</h4>
					{history.map((item) => (
						<AutomationDraftCard
							key={item.draftId}
							sessionId={sessionId}
							item={item}
							highlighted={highlightId === item.draftId}
							onResolve={onResolve}
						/>
					))}
				</section>
			)}
		</div>
	);
}

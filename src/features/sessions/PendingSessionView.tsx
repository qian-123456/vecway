/** Full composer for a desktop-local draft; no transcript/RPC is needed to render it. */
import { HomeRecentSessions, StartGlow, StartHero } from "../../components/StartHero";
import { useT } from "../../stores/language";
import { Composer } from "../chat/Composer";
import { usePendingSession } from "./pendingSession";

export function PendingSessionView() {
	const { t } = useT();
	const id = usePendingSession((s) => (s.selectedId && s.drafts[s.selectedId] ? s.selectedId : null));
	const startError = usePendingSession((s) => (id ? (s.drafts[id]?.startError ?? null) : null));
	if (!id) return null;
	return (
		<div className="relative @container flex h-full flex-col overflow-y-auto">
			<div className="min-h-[24px] flex-[0.95]" aria-hidden="true" />
			<StartGlow />
			<StartHero sessionId={id} />
			<div className="mx-auto w-full max-w-[780px] px-6">
				<div className="start-rise">
					<Composer key={id} sessionId={id} />
				</div>
				{startError && (
					<div role="alert" className="mt-2 px-6 text-[12px] text-red-500 select-text">
						{t("sessions.createSessionFailed", { error: startError })}
					</div>
				)}
				<HomeRecentSessions sessionId={id} />
			</div>
			<div className="min-h-[24px] flex-[1.05]" aria-hidden="true" />
		</div>
	);
}

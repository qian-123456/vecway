import { Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PopoverSelect } from "../../components/PopoverSelect";
import { errMsg } from "../../lib/dialogs";
import { ensureLive, isResumeCancelled } from "../../lib/ensureLive";
import { rpcSend } from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { useT } from "../../stores/language";
import { useLive } from "../../stores/live";
import { useProviders } from "../providers/store";
import { setDraftFastMode } from "../sessions/draftSession";
import { isLocalDraftId, usePendingSession } from "../sessions/pendingSession";
import { fastModeChannel, offlineFastModeChannel } from "./fastMode";

export { fastModeChannel, offlineFastModeChannel, type FastModeChannel } from "./fastMode";

/** Top-left fast-mode selector inside the thinking-level card for supported first-party GPT models. */
export function ComposerFastMode({ sessionId, modelKey }: { sessionId: string; modelKey: string }) {
	const { t } = useT();
	const isDraft = isLocalDraftId(sessionId);
	const state = useLive((s) => (isDraft ? undefined : s.sessions[sessionId]?.state));
	const draftFastMode = usePendingSession((s) => (isDraft ? s.drafts[sessionId]?.fastMode ?? null : null));
	const providerRows = useProviders((s) => s.rows);
	const providersLoaded = useProviders((s) => s.loaded);
	const providersError = useProviders((s) => s.error);
	const [pending, setPending] = useState(false);
	const inFlight = useRef(false);

	const maybeFirstPartyOpenAI = modelKey.startsWith("openai/") || modelKey.startsWith("openai-codex/");
	useEffect(() => {
		if (!state?.model && maybeFirstPartyOpenAI && !providersLoaded) {
			void useProviders.getState().load();
		}
	}, [state?.model, maybeFirstPartyOpenAI, providersLoaded]);

	const liveChannel = fastModeChannel(state, modelKey);
	const channel =
		liveChannel ??
		(state?.model ? null : offlineFastModeChannel(modelKey, providersLoaded && !providersError ? providerRows : null));
	if (!channel) return null;

	const enabled = isDraft ? draftFastMode === true : state?.fastModeEnabled === true;
	const active = isDraft ? draftFastMode === true : state?.fastModeActive === true;
	// OMP's boolean state also covers Ultrafast. Highlight acceleration without
	// claiming a specific tier when another entry point may have selected it.
	const title = active ? t("components.fastModeOn")
		: enabled ? t("components.fastModeUnavailable") : t("components.fastMode");
	const select = async (next: string) => {
		if (isDraft) {
			setDraftFastMode(sessionId, next === "fast");
			return;
		}
		if (inFlight.current) return;
		inFlight.current = true;
		setPending(true);
		try {
			let live = useLive.getState().sessions[sessionId];
			let confirmed: unknown = live?.state;
			if (!live?.alive) {
				await ensureLive(sessionId);
				const response = await rpcSend(sessionId, { type: "get_state" }) as { data?: unknown };
				confirmed = response.data;
				live = useLive.getState().sessions[sessionId];
			}
			if (!live?.alive || fastModeChannel(confirmed, modelKey) !== channel) {
				toast.error(t("components.fastModeUnavailable"));
				return;
			}
			await rpcSend(sessionId, { type: "set_fast_mode", enabled: next === "fast" });
		} catch (error) {
			if (!isResumeCancelled(error)) toast.error(t("components.fastModeFailed", { error: errMsg(error) }));
		} finally {
			inFlight.current = false;
			setPending(false);
		}
	};

	return (
		<PopoverSelect
			aria-label={title}
			value={active ? "fast" : enabled ? "" : "default"}
			onChange={(next) => void select(next)}
			disabled={pending}
			menuClassName="w-[220px]"
			className={active ? "bg-[var(--bg-active-fill)] text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text)]"}
			iconTrigger={{ title, icon: <Zap size={15} fill={active ? "currentColor" : "none"} aria-hidden /> }}
			options={[
				{ value: "default", label: t("components.fastModeDefault"), description: t("components.fastModeDefaultDesc") },
				{
					value: "fast",
					label: t("components.fastModeFast"),
					description: channel === "codex" ? t("components.fastModeCodexCost") : t("components.fastModeApiCost"),
				},
			]}
		/>
	);
}

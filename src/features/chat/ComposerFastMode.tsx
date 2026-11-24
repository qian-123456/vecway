import clsx from "clsx";
import { Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

interface FastModeControlState {
	active: boolean;
	pending: boolean;
	title: string;
	toggle: () => Promise<void>;
}

function useFastModeControl(sessionId: string, modelKey: string): FastModeControlState | null {
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
	const costHint = channel === "codex" ? t("components.fastModeCodexCost") : t("components.fastModeApiCost");
	const title = active
		? `${t("components.fastModeOn")} · ${costHint}`
		: enabled
			? t("components.fastModeUnavailable")
			: `${t("components.fastMode")} · ${costHint}`;

	const toggle = async () => {
		const nextEnabled = !active;
		if (isDraft) {
			setDraftFastMode(sessionId, nextEnabled);
			if (nextEnabled) toast.info(t("components.fastModeEnabledNotice", { cost: costHint }), 2600);
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
				const response = (await rpcSend(sessionId, { type: "get_state" })) as { data?: unknown };
				confirmed = response.data;
				live = useLive.getState().sessions[sessionId];
			}
			if (!live?.alive || fastModeChannel(confirmed, modelKey) !== channel) {
				toast.error(t("components.fastModeUnavailable"));
				return;
			}
			await rpcSend(sessionId, { type: "set_fast_mode", enabled: nextEnabled });
			if (nextEnabled) toast.info(t("components.fastModeEnabledNotice", { cost: costHint }), 2600);
		} catch (error) {
			if (!isResumeCancelled(error)) toast.error(t("components.fastModeFailed", { error: errMsg(error) }));
		} finally {
			inFlight.current = false;
			setPending(false);
		}
	};

	return { active, pending, title, toggle };
}

/** Top-left one-click fast-mode toggle inside the thinking-level card for supported first-party GPT models. */
export function ComposerFastMode({ sessionId, modelKey }: { sessionId: string; modelKey: string }) {
	const ctrl = useFastModeControl(sessionId, modelKey);
	if (!ctrl) return null;

	return (
		<button
			type="button"
			aria-pressed={ctrl.active}
			aria-label={ctrl.title}
			title={ctrl.title}
			disabled={ctrl.pending}
			onClick={() => void ctrl.toggle()}
			className={clsx(
				"inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,opacity,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.95] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color-mix(in_srgb,var(--accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-50",
				ctrl.active
					? "text-amber-500 dark:text-amber-400 hover:opacity-80"
					: "text-[var(--text-muted)] hover:text-[var(--text)]",
			)}
		>
			<Zap size={15} fill={ctrl.active ? "currentColor" : "none"} aria-hidden />
		</button>
	);
}

/** Compact colored lightning indicator placed between the model and thinking pickers when fast mode is active. */
export function ComposerFastModeIndicator({ sessionId, modelKey }: { sessionId: string; modelKey: string }) {
	const ctrl = useFastModeControl(sessionId, modelKey);
	if (!ctrl || !ctrl.active) return null;

	return (
		<button
			type="button"
			aria-pressed
			aria-label={ctrl.title}
			title={ctrl.title}
			disabled={ctrl.pending}
			onClick={() => void ctrl.toggle()}
			className="-mx-1 inline-flex h-5 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-amber-500 dark:text-amber-400 transition-[opacity,transform] duration-150 ease-[var(--ease-out)] hover:opacity-80 active:scale-[0.95] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color-mix(in_srgb,var(--accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
		>
			<Zap size={12} fill="currentColor" aria-hidden />
		</button>
	);
}

import { Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../../components/Modal";
import { ModelSelect } from "../../components/ModelSelect";
import { errMsg } from "../../lib/dialogs";
import { rejectResume, resumeSession, RESUME_MISSING_MODEL_MODAL } from "../../lib/ensureLive";
import { type ModelOption, toModelKey } from "../../lib/models";
import { useT } from "../../stores/language";
import { useModelCatalog, useModelOptions } from "../../stores/modelCatalog";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { openSettingsTarget } from "../settings/settingsTargets";

function extractMissingProvider(sessionModel: string | null | undefined, diagnostic: string): string | null {
	if (sessionModel) {
		const slash = sessionModel.indexOf("/");
		if (slash > 0) return sessionModel.slice(0, slash).trim() || null;
	}
	const match = diagnostic.match(/([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.:-]+/);
	return match?.[1] ?? null;
}

function pickRecommendedModel(
	models: readonly ModelOption[] | null,
	preferredProvider: string | null,
): string {
	if (!models || models.length === 0) return "";
	const score = (m: ModelOption): number => {
		let s = 0;
		if (preferredProvider && m.provider === preferredProvider) s += 4;
		if (m.reasoning === true || (m.thinking && m.thinking.length > 0)) s += 2;
		if (typeof m.contextWindow === "number" && m.contextWindow > 0) s += 1;
		return s;
	};
	const ranked = models
		.map((m, idx) => ({ m, idx, s: score(m), ctx: m.contextWindow ?? 0 }))
		.sort((a, b) => b.s - a.s || b.ctx - a.ctx || a.idx - b.idx);
	const best = ranked[0]?.m;
	return best ? toModelKey(best.provider, best.id) : "";
}

export function ResumeMissingModelDialog() {
	const modal = useUi((s) => s.modal);
	if (modal?.name !== RESUME_MISSING_MODEL_MODAL) return null;
	const sessionId = typeof modal.props.sessionId === "string" ? modal.props.sessionId : "";
	const diagnostic = typeof modal.props.diagnostic === "string" ? modal.props.diagnostic : "";
	return <ResumeMissingModelForm key={sessionId} sessionId={sessionId} diagnostic={diagnostic} />;
}

function ResumeMissingModelForm({ sessionId, diagnostic }: { sessionId: string; diagnostic: string }) {
	const { t } = useT();
	const dialogRef = useRef<HTMLDivElement>(null);
	const selectorWrapRef = useRef<HTMLDivElement>(null);
	const models = useModelOptions();
	const loading = useModelCatalog((s) => s.loading);
	const sessionModel = useSessions((s) => s.sessions[sessionId]?.model);
	const preferredProvider = useMemo(
		() => extractMissingProvider(sessionModel, diagnostic),
		[sessionModel, diagnostic],
	);
	const recommendedKey = useMemo(
		() => pickRecommendedModel(models, preferredProvider),
		[models, preferredProvider],
	);
	const [selected, setSelected] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const selectedOption = models?.find((m) => toModelKey(m.provider, m.id) === selected);

	useEffect(() => {
		if (!recommendedKey) return;
		setSelected((prev) => {
			if (prev && models?.some((m) => toModelKey(m.provider, m.id) === prev)) return prev;
			return recommendedKey;
		});
	}, [models, recommendedKey]);

	useEffect(() => {
		void useModelCatalog.getState().refresh();
		(
			selectorWrapRef.current?.querySelector<HTMLElement>("button") ??
			dialogRef.current?.querySelector<HTMLElement>("button")
		)?.focus();
		return () => rejectResume(sessionId, undefined, RESUME_MISSING_MODEL_MODAL);
	}, [sessionId]);
	const cancel = () => {
		if (busy) return;
		rejectResume(sessionId);
	};
	const confirm = async () => {
		if (busy || !selectedOption) return;
		setBusy(true);
		setError(null);
		try {
			await resumeSession(sessionId, undefined, selected);
		} catch (err) {
			setError(errMsg(err));
			setBusy(false);
		}
	};

	return (
		<Modal
			onClose={cancel}
			ariaLabel={t("sessions.resumeSession")}
			size="none"
			className="w-[500px] max-w-[calc(100vw-2rem)]"
			closeOnBackdrop={!busy}
			closeOnEscape={!busy}
		>
			<div
				ref={dialogRef}
				className="flex min-h-0 flex-1 flex-col p-5 text-neutral-300"
				onKeyDown={(e) => {
					if (e.key !== "Escape") e.stopPropagation();
					if (e.key !== "Tab") return;
					const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(
						'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
					)).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
					const first = controls[0];
					const last = controls[controls.length - 1];
					if (e.shiftKey && document.activeElement === first) {
						e.preventDefault();
						last?.focus();
					} else if (!e.shiftKey && document.activeElement === last) {
						e.preventDefault();
						first?.focus();
					}
				}}
			>
				<div className="mb-3 flex shrink-0 items-center">
					<span className="flex-1 text-[15px] font-semibold tracking-tight text-[var(--text)]">
						{t("sessions.resumeSession")}
					</span>
					<button type="button" title={t("sessions.closeEsc")} aria-label={t("sessions.closeDialogAria")}
						disabled={busy} onClick={cancel}
						className="press-scale shrink-0 rounded-lg p-1 text-neutral-400 hover:bg-[var(--bg-hover)] hover:text-neutral-100 transition-colors disabled:opacity-40">
						<X size={15} />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto pr-1">
					<p className="mb-3 text-[12px] text-neutral-300">{t("sessions.sessionModelUnavailableNotice")}</p>
					{diagnostic && (
						<details className="mb-3 rounded-lg hairline bg-[var(--bg)]/60 px-2.5 py-1.5 text-xs text-neutral-400">
							<summary className="cursor-pointer select-none font-medium text-neutral-300">
								{t("sessions.viewDetails")}
							</summary>
							<p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-400">
								{diagnostic}
							</p>
						</details>
					)}
					<p className="mb-1 shrink-0 whitespace-nowrap text-xs text-neutral-400">{t("sessions.resumeModelLabel")}</p>
					<div ref={selectorWrapRef}>
						<ModelSelect catalogManaged models={models} currentValue={selected} onSelect={setSelected}
							label={selectedOption?.id ?? t("sessions.selectResumeModel")} disabled={busy}
							buttonClass="press-scale flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--border-divider)] bg-[var(--bg-active-fill)] px-3 py-2 text-left text-xs text-neutral-200 transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40 [&>span]:whitespace-normal [&>span]:overflow-visible [&>span]:text-clip [&>span]:break-all"
							align="start" closeOnSelect />
					</div>
					{!loading && !models?.length && <p role="status" className="mt-2 text-xs text-neutral-400">{t("sessions.noResumeModels")}</p>}
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<button type="button" disabled={busy || loading} onClick={() => void useModelCatalog.getState().refresh()}
							className="shrink-0 whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg-active-fill)] px-3 py-1.5 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40">{t("sessions.refreshResumeModels")}</button>
						{!loading && !models?.length && (
							<button
								type="button"
								disabled={busy}
								onClick={() => {
									cancel();
									openSettingsTarget("providers");
								}}
								className="shrink-0 whitespace-nowrap rounded-full border border-[var(--border-divider)] bg-[var(--bg-active-fill)] px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
							>
								{t("sessions.openProviderSettings")}
							</button>
						)}
					</div>
					{error && <div role="alert" className="mt-2 whitespace-pre-wrap break-words text-xs text-rose-400">{error}</div>}
				</div>
				<div className="mt-2 flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-divider)] pt-3">
					<button type="button" disabled={busy} onClick={cancel}
						className="press-scale shrink-0 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--bg-active-fill)] px-3 py-1.5 text-xs text-neutral-400 hover:bg-[var(--bg-hover)] hover:text-neutral-200 transition-colors disabled:opacity-40">{t("common.cancel")}</button>
					<button type="button" disabled={busy || !selectedOption} onClick={() => void confirm()}
						className="press-scale flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-40 transition-colors">
						{busy && <Loader2 size={12} className="shrink-0 animate-spin" />}
						{busy ? t("sessions.resuming") : t("sessions.continueAction")}
					</button>
				</div>
			</div>
		</Modal>
	);
}

import {
	ChevronDown,
	ChevronRight,
	FileText,
	Loader2,
	RefreshCw,
	Send,
	Stethoscope,
	X,
} from "lucide-react";
import { isComposing } from "../../lib/hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../../components/Modal";
import { InfoTip } from "../../components/InfoTip";
import { Notice } from "../../components/Notice";
import { errMsg } from "../../lib/dialogs";
import {
	diagnoseBuildPrompt,
	dispatchPrompt,
	rpcStart,
	} from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { NativeSelect } from "../../components/NativeSelect";
import { useT } from "../../stores/language";

/**
 * [D] Diagnose dialog. Always mounted; opened via
 * `ui.openModal("diagnose", { sessionId })`.
 */
export function DiagnoseDialog() {
	const { t } = useT();
	const modal = useUi((s) => s.modal);
	const closeModal = useUi((s) => s.closeModal);
	const selectSession = useUi((s) => s.selectSession);
	const sessions = useSessions((s) => s.sessions);

	const isVisible = modal?.name === "diagnose";
	const targetSessionId =
		typeof modal?.props?.sessionId === "string" ? modal.props.sessionId : "";

	const [prompt, setPrompt] = useState<string>("");
	const [loadingPrompt, setLoadingPrompt] = useState(false);
	const [showPromptPreview, setShowPromptPreview] = useState(true);
	const [targetType, setTargetType] = useState<"existing" | "new">("new");
	const [selectedExistingId, setSelectedExistingId] = useState<string>("");
	const [newSessionModel, setNewSessionModel] = useState<string>("");
	const [dispatching, setDispatching] = useState(false);
	const [promptError, setPromptError] = useState<string | null>(null);
	const [dispatchError, setDispatchError] = useState<string | null>(null);
	const sending = useRef(false);
	const promptRequest = useRef(0);
	const visit = useRef(0);
	const createdSessionRef = useRef<{
		sessionId: string;
		cwd: string;
		model: string;
		mode: string | undefined;
	} | null>(null);

	const targetSession = targetSessionId ? sessions[targetSessionId] : undefined;

	const fetchPrompt = useCallback(() => {
		if (!targetSessionId) return;
		const request = ++promptRequest.current;
		setPromptError(null);
		setLoadingPrompt(true);
		diagnoseBuildPrompt(targetSessionId)
			.then((p) => {
				if (request === promptRequest.current) setPrompt(p);
			})
			.catch((err) => {
				if (request !== promptRequest.current) return;
				const msg = errMsg(err);
				setPromptError(t("diagnose.errorGeneratingPrompt", { error: msg }));
			})
			.finally(() => {
				if (request === promptRequest.current) setLoadingPrompt(false);
			});
	}, [targetSessionId, t]);

	useEffect(() => {
		visit.current++;
		if (isVisible && targetSessionId) {
			createdSessionRef.current = null;
			setPrompt("");
			setPromptError(null);
			setDispatchError(null);
			setDispatching(sending.current);
			setTargetType("new");
			setNewSessionModel("");
			// Read once per opening, not on catalog refresh; exclude busy sessions.
			const candidateIds = Object.values(useSessions.getState().sessions)
				.filter((s) => s.id !== targetSessionId && s.status !== "working")
				.map((s) => s.id);
			setSelectedExistingId(candidateIds[0] || "");
			fetchPrompt();
		}
		return () => { promptRequest.current++; };
	}, [isVisible, targetSessionId, fetchPrompt]);
	useEffect(() => {
		createdSessionRef.current = null;
	}, [targetSession?.cwd, targetSession?.mode]);


	const candidateSessions = Object.values(sessions).filter(
		(s) => s.id !== targetSessionId && s.status !== "working",
	);
	// Keep "existing" selected once the user chose it so unavailability is shown explicitly
	// instead of silently substituting another session or switching to "new".
	const effectiveTargetType: "existing" | "new" =
		targetType === "existing" ? "existing" : "new";
	const selectedExistingSession = selectedExistingId ? sessions[selectedExistingId] : undefined;
	const isSelectedExistingValid = Boolean(
		selectedExistingId && candidateSessions.some((s) => s.id === selectedExistingId),
	);
	const existingTargetError =
		effectiveTargetType === "existing" && !isSelectedExistingValid
			? selectedExistingSession?.status === "working"
				? t("diagnose.selectedSessionBusy")
				: t("diagnose.selectedSessionUnavailable")
			: null;
	const canSubmit =
		Boolean(prompt) &&
		!loadingPrompt &&
		!dispatching &&
		(effectiveTargetType !== "existing" || isSelectedExistingValid);

	if (!isVisible) return null;

	const handleExecuteDiagnose = async () => {
		if (!canSubmit || sending.current) return;
		sending.current = true;
		const currentVisit = visit.current;
		setDispatching(true);
		setDispatchError(null);
		try {
			let diagnoserId = "";
			if (effectiveTargetType === "new") {
				const cwd = targetSession?.cwd || ".";
				const model = newSessionModel.trim() || undefined;
				const mode = targetSession?.mode;
				const existingCreated = createdSessionRef.current;
				if (
					existingCreated &&
					existingCreated.cwd === cwd &&
					existingCreated.model === (model ?? "") &&
					existingCreated.mode === mode
				) {
					diagnoserId = existingCreated.sessionId;
				} else {
					// The diagnoser lives in the diagnosed session's space.
					const info = await rpcStart({
						cwd,
						model,
						mode,
					});
					if (currentVisit !== visit.current) return;
					diagnoserId = info.sessionId;
					createdSessionRef.current = {
						sessionId: diagnoserId,
						cwd,
						model: model ?? "",
						mode,
					};
				}
			} else {
				if (!isSelectedExistingValid) {
					throw new Error(t("diagnose.selectDiagnoserSession"));
				}
				diagnoserId = selectedExistingId;
			}

			await dispatchPrompt(diagnoserId, prompt);

			if (currentVisit !== visit.current) return;
			createdSessionRef.current = null;
			toast.success(t("diagnose.diagnosisStarted"));
			closeModal();
			selectSession(diagnoserId);
		} catch (err) {
			if (currentVisit !== visit.current) return;
			setDispatchError(errMsg(err));
		} finally {
			sending.current = false;
			setDispatching(false);
		}
	};
	return (
		<Modal
			onClose={closeModal}
			size="none"
			ariaLabel={t("diagnose.title")}
			className="w-full max-w-xl max-h-[min(90vh,720px)] p-6 text-[var(--text)]"
		>
			<div
				className="flex min-h-0 flex-1 flex-col"
				onKeyDown={(e) => {
					if (isComposing(e)) return;
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.preventDefault();
						if (canSubmit) {
							void handleExecuteDiagnose();
						}
						return;
					}
					if (e.key === "Tab") {
						const controls = Array.from(
							e.currentTarget.querySelectorAll<HTMLElement>(
								'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
							),
						).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
						if (controls.length === 0) return;
						const first = controls[0];
						const last = controls[controls.length - 1];
						if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) {
							e.preventDefault();
							last?.focus();
						} else if (!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) {
							e.preventDefault();
							first?.focus();
						}
					}
				}}
			>
				<div className="mb-4 flex items-center justify-between border-b border-[var(--border-divider)] pb-3 shrink-0">
					<div className="flex items-center gap-2.5">
						<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
							<Stethoscope className="h-4 w-4" />
						</div>
						<div className="flex items-center gap-1.5">
							<h2 id="diagnose-dialog-title" className="text-sm font-semibold text-[var(--text)]">
								{t("diagnose.title")}
							</h2>
							<InfoTip text={t("diagnose.subtitle")} />
						</div>
					</div>
					<button
						type="button"
						title={t("diagnose.closeEsc")}
						aria-label={t("diagnose.closeDialog")}
						onClick={closeModal}
						className="rounded-lg p-1 text-neutral-400 hover:bg-[var(--bg-hover)] hover:text-neutral-200 transition-colors"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4">

				{promptError && (
					<div className="mb-4">
						<Notice
							tone="danger"
							action={
								<button
									type="button"
									onClick={fetchPrompt}
									disabled={loadingPrompt}
									className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-[var(--bg-hover)] px-2 py-1 text-xs text-neutral-200 hover:bg-[var(--bg-active-fill)] disabled:opacity-40"
								>
									<RefreshCw className={`h-3 w-3 ${loadingPrompt ? "animate-spin" : ""}`} />
									<span>{t("diagnose.retryGeneratePrompt")}</span>
								</button>
							}
						>
							<span className="select-text break-words">{promptError}</span>
						</Notice>
					</div>
				)}

				{dispatchError && (
					<div className="mb-4">
						<Notice
							tone="danger"
							action={
								<button
									type="button"
									onClick={() => void handleExecuteDiagnose()}
									disabled={!canSubmit}
									className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-[var(--bg-hover)] px-2 py-1 text-xs text-neutral-200 hover:bg-[var(--bg-active-fill)] disabled:opacity-40"
								>
									<RefreshCw className={`h-3 w-3 ${dispatching ? "animate-spin" : ""}`} />
									<span>{t("diagnose.retrySend")}</span>
								</button>
							}
						>
							<span className="select-text break-words">{dispatchError}</span>
						</Notice>
					</div>
				)}

				{/* Target Session Info Card */}
				<div className="rounded-xl border border-[var(--border-divider)] bg-[var(--well-bg)] p-3 text-xs">
					<div className="flex items-center justify-between">
						<span className="font-semibold text-neutral-300">
							{t("diagnose.diagnosedSession", { title: targetSession?.title || targetSessionId })}
						</span>
						<span className="rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-medium text-rose-300">
							{targetSession?.status ?? t("diagnose.defaultAbnormal")}
						</span>
					</div>
					{targetSession?.cwd && (
						<div className="mt-1 break-all text-[11px] text-neutral-500" title={targetSession.cwd}>
							{t("diagnose.workingDirectory", { cwd: targetSession.cwd })}
						</div>
					)}
				</div>

				{/* Prompt Preview Accordion */}
				<div className="rounded-xl border border-[var(--border-divider)] bg-[var(--well-bg)]/60">
					<div className="flex items-center justify-between gap-2 p-3">
						<div className="flex min-w-0 items-center gap-1.5">
							<button
								type="button"
								onClick={() => setShowPromptPreview(!showPromptPreview)}
								aria-expanded={showPromptPreview}
								className="flex min-w-0 items-center gap-1.5 text-left text-xs font-medium text-neutral-400 hover:text-neutral-200"
							>
								<FileText className="h-3.5 w-3.5 shrink-0" />
								<span>{t("diagnose.promptTitle", { count: prompt ? t("diagnose.charCount", { count: prompt.length }) : t("diagnose.promptPreparing") })}</span>
							</button>
							<InfoTip text={t("diagnose.promptHint")} />
						</div>
						<button
							type="button"
							onClick={() => setShowPromptPreview(!showPromptPreview)}
							tabIndex={-1}
							aria-hidden="true"
							className="flex flex-1 justify-end text-neutral-400 hover:text-neutral-200"
						>
							{showPromptPreview ? (
								<ChevronDown className="h-4 w-4" />
							) : (
								<ChevronRight className="h-4 w-4" />
							)}
						</button>
					</div>

					{showPromptPreview && (
						<div className="border-t border-[var(--border-divider)] p-3">
							{loadingPrompt ? (
								<div className="space-y-3 py-1">
									<div className="flex items-center gap-2 text-xs text-amber-400">
										<RefreshCw className="h-3.5 w-3.5 animate-spin" />
										<span>{t("diagnose.scanningTailErrors")}</span>
									</div>
									<div className="space-y-2 pt-1">
										<div className="h-3.5 w-3/4 animate-pulse rounded bg-neutral-800" />
										<div className="h-3.5 w-5/6 animate-pulse rounded bg-neutral-800" />
										<div className="h-3.5 w-2/3 animate-pulse rounded bg-neutral-800" />
									</div>
								</div>
							) : (
								<div className="space-y-2">
									<textarea
										value={prompt}
										onChange={(e) => setPrompt(e.target.value)}
										rows={8}
										placeholder={t("diagnose.promptPlaceholder")}
										className="w-full resize-y rounded-lg border border-neutral-700 bg-neutral-950 p-2.5 text-[11px] font-mono text-neutral-200 placeholder-neutral-500 focus:border-amber-500 focus:outline-none"
									/>
									<div className="flex items-center justify-end text-[11px] text-neutral-500">
										<button
											type="button"
											onClick={fetchPrompt}
											disabled={loadingPrompt}
											className="inline-flex items-center gap-1 text-neutral-400 hover:text-amber-400 disabled:opacity-40"
											title={t("diagnose.regenerateTitle")}
										>
											<RefreshCw className={`h-3 w-3 ${loadingPrompt ? "animate-spin" : ""}`} />
											<span>{t("diagnose.regenerate")}</span>
										</button>
									</div>
								</div>
							)}
						</div>
					)}
				</div>

				{/* Diagnoser Target Selection */}
				<div className="space-y-3">
					<div className="text-xs font-semibold text-neutral-300">
						{t("diagnose.whichAgentLabel")}
					</div>

					{(candidateSessions.length > 0 || effectiveTargetType === "existing") && (
						<div className="flex rounded-lg border border-[var(--border-divider)] bg-[var(--well-bg)] p-1 text-xs font-medium">
							<button
								type="button"
								onClick={() => {
									createdSessionRef.current = null;
									setDispatchError(null);
									setTargetType("new");
								}}
								className={`flex-1 rounded-md py-1.5 transition-colors ${
									effectiveTargetType === "new"
										? "bg-neutral-800 text-neutral-100"
										: "text-neutral-400 hover:text-neutral-200"
								}`}
							>
								{t("diagnose.tabNew")}
							</button>
							<button
								type="button"
								onClick={() => {
									createdSessionRef.current = null;
									setDispatchError(null);
									setTargetType("existing");
									if (!candidateSessions.some((s) => s.id === selectedExistingId)) {
										setSelectedExistingId(candidateSessions[0]?.id ?? "");
									}
								}}
								className={`flex-1 rounded-md py-1.5 transition-colors ${
									effectiveTargetType === "existing"
										? "bg-neutral-800 text-neutral-100"
										: "text-neutral-400 hover:text-neutral-200"
								}`}
							>
								{t("diagnose.tabExisting")}
							</button>
						</div>
					)}

					{effectiveTargetType === "existing" ? (
						<div>
							<label className="mb-1 block text-xs text-neutral-400">
								{t("diagnose.selectSessionLabel")}
							</label>
							<NativeSelect
								value={isSelectedExistingValid ? selectedExistingId : ""}
								onChange={(e) => {
									createdSessionRef.current = null;
									setDispatchError(null);
									setSelectedExistingId(e.target.value);
								}}
							>
								{!isSelectedExistingValid && (
									<option value="" disabled>
										{t("diagnose.selectSessionPlaceholder")}
									</option>
								)}
								{candidateSessions.map((s) => {
									const modelLabel = s.model ? ` [${s.model}]` : "";
									const statusLabel =
										s.status === "idle"
											? t("diagnose.statusIdle")
											: s.status === "error"
												? t("diagnose.statusError")
												: s.status === "suspended"
													? t("diagnose.statusSuspended")
													: s.status;
									return (
										<option key={s.id} value={s.id}>
											{s.title || s.id}{modelLabel} · {statusLabel}
										</option>
									);
								})}
							</NativeSelect>
							{existingTargetError && (
								<div className="mt-1.5 text-xs text-rose-400" role="alert">
									{existingTargetError}
								</div>
							)}
						</div>
					) : (
						<div className="space-y-2">
							<div>
								<label className="mb-1 block text-xs text-neutral-400">
									{t("diagnose.modelLabel")}
								</label>
								<input
									type="text"
									value={newSessionModel}
									onChange={(e) => {
										createdSessionRef.current = null;
										setDispatchError(null);
										setNewSessionModel(e.target.value);
									}}
									placeholder={t("diagnose.modelPlaceholder")}
									className="w-full rounded-lg hairline bg-[var(--well-bg)] px-3 py-2 text-xs text-neutral-100 placeholder-neutral-500 focus:ring-1 focus:ring-amber-500 focus:outline-none transition-all"
								/>
							</div>
							<div className="text-[11px] text-neutral-500">
								{t("diagnose.newSessionHint", { cwd: targetSession?.cwd ?? t("diagnose.currentDirectory") })}
							</div>
						</div>
					)}
				</div>

				</div>

				{/* Actions */}
				<div className="mt-4 flex items-center justify-end gap-2 border-t border-[var(--border-divider)] pt-3 shrink-0">
					<button
						type="button"
						onClick={closeModal}
						className="rounded-lg px-4 py-1.5 text-xs text-neutral-400 hover:bg-[var(--bg-hover)] hover:text-neutral-200 transition-colors"
					>
						{t("diagnose.cancel")}
					</button>
					<button
						type="button"
						disabled={!canSubmit}
						onClick={handleExecuteDiagnose}
						className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-amber-400 disabled:opacity-40 transition-colors"
					>
						{dispatching ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Send className="h-3.5 w-3.5" />
						)}
						<span>{dispatching ? t("diagnose.startingDiagnosis") : t("diagnose.startDiagnosis")}</span>
					</button>
				</div>
			</div>
		</Modal>
	);
}

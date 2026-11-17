/** [B] Inline pending-UI dialog cards (approval select/confirm/input/editor). */

import { Circle, CircleDot, Loader2, Square, SquareCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PendingUiRequest } from "../../lib/contracts";
import { errMsg } from "../../lib/dialogs";
import { isComposing } from "../../lib/hooks";
import { allowedToolsList, rpcUiRespond } from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { useLive } from "../../stores/live";
import { claimEscape } from "../../lib/escapeClaim";
import { isEditableTarget, resolveApprovalChoices } from "./approvalOptions";
import { useT } from "../../stores/language";

const asObj = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

export function PendingUiCard({
	sessionId,
	req,
}: {
	sessionId: string;
	req: PendingUiRequest;
}) {
	const request = asObj(req.request);
	return (
		<PendingUiDialog
			key={`${sessionId}:${String(request.id ?? "")}:${req.receivedAt}`}
			sessionId={sessionId}
			req={req}
		/>
	);
}

function PendingUiDialog({
	sessionId,
	req,
}: {
	sessionId: string;
	req: PendingUiRequest;
}) {
	const { t } = useT();
	const request = asObj(req.request);
	const id = typeof request.id === "string" ? request.id : "";
	const method = typeof request.method === "string" ? request.method : "";
	const title = typeof request.title === "string" ? request.title : "";
	const message =
		typeof request.message === "string" ? request.message : "";
	const options = Array.isArray(request.options)
		? (request.options as string[])
		: [];
	const optionDetails = Array.isArray(request.optionDetails)
		? (request.optionDetails as { description?: string }[])
		: [];
	const selectionMarker =
		request.selectionMarker === "radio" || request.selectionMarker === "checkbox"
			? request.selectionMarker
			: undefined;
	const initialIndex = typeof request.initialIndex === "number" ? request.initialIndex : 0;
	const checkedIndices = Array.isArray(request.checkedIndices) ? request.checkedIndices : [];
	const markableCount =
		typeof request.markableCount === "number" ? request.markableCount : options.length;
	const dismissUi = useLive((s) => s.dismissUi);
	const [text, setText] = useState(
		typeof request.prefill === "string"
			? request.prefill
			: typeof request.value === "string"
				? request.value
				: typeof request.default === "string"
					? request.default
					: typeof request.defaultValue === "string"
						? request.defaultValue
						: "",
	);
	const [busy, setBusy] = useState(false);
	const [hasPermanent, setHasPermanent] = useState(false);
	const [validationError, setValidationError] = useState<string | null>(null);
	const prevActiveElement = useRef<HTMLElement | null>(null);
	const primaryApprovalBtnRef = useRef<HTMLButtonElement | null>(null);
	const initialOptionRef = useRef<HTMLButtonElement | null>(null);

	const choices = method === "select" ? resolveApprovalChoices(options) : {};
	// A select card is only an approval card when omp's exact Approve/Deny
	// labels are present; otherwise it renders as a plain option list.
	const isApproval =
		/allow|approve|权限|允许/i.test(title) &&
		(method === "confirm" ||
			(method === "select" && !selectionMarker && !!choices.once && !!choices.deny));

	useEffect(() => {
		prevActiveElement.current = document.activeElement as HTMLElement | null;
		// Never steal focus from something the user is typing into (composer).
		if (
			(isApproval || method === "confirm") &&
			!isEditableTarget(document.activeElement)
		) {
			primaryApprovalBtnRef.current?.focus();
		}
		if (method === "select" && !isApproval && !isEditableTarget(document.activeElement)) {
			initialOptionRef.current?.focus();
		}
		return () => {
			if (
				prevActiveElement.current &&
				typeof prevActiveElement.current.focus === "function"
			) {
				prevActiveElement.current.focus();
			}
		};
	}, [isApproval, method]);

	// Modern form validation belongs to OMP; only honor an explicit host hint here.
	const isRequired = request.required === true;

	const handleApprovalApprove = () => {
		if (busy) return;
		if (method === "select") {
			if (choices.once) {
				void respond({ value: choices.once, confirmed: true });
			}
		} else {
			void respond({ confirmed: true });
		}
	};

	const handleApprovalReject = () => {
		if (busy) return;
		if (method === "select") {
			if (choices.deny) {
				void respond({
					value: choices.deny,
					confirmed: false,
					cancelled: true,
				});
			}
		} else {
			void respond({ confirmed: false });
		}
	};

	const submitText = () => {
		if (busy) return;
		if (isRequired && !text.trim()) {
			setValidationError(t("chatView.pendingUi.inputCannotBeEmpty"));
			return;
		}
		void respond({ value: text });
	};

	const onCardKeyDown = (e: React.KeyboardEvent) => {
		if (isComposing(e)) return;
		if (e.key === "Escape" && !isApproval) {
			claimEscape(e);
			if (!busy) void respond(method === "confirm" ? { confirmed: false } : { cancelled: true });
			return;
		}
		if (!isApproval || isEditableTarget(e.target)) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.key === "y" || e.key === "Y") {
			e.preventDefault();
			handleApprovalApprove();
		} else if (e.key === "n" || e.key === "N") {
			e.preventDefault();
			handleApprovalReject();
		}
	};

	useEffect(() => {
		let mounted = true;
		allowedToolsList()
			.then((list) => {
				if (mounted && Array.isArray(list) && list.length > 0) {
					setHasPermanent(true);
				}
			})
			.catch(() => {
				if (mounted) setHasPermanent(false);
			});
		return () => {
			mounted = false;
		};
	}, []);
	const respond = async (response: Record<string, unknown>) => {
		setBusy(true);
		try {
			const payload: Record<string, unknown> = { id, ...response };
			await rpcUiRespond(sessionId, payload);
			dismissUi(sessionId, id);
		} catch (err) {
			toast.error(t("chatView.pendingUi.respondFailed", { error: errMsg(err) }));
		} finally {
			setBusy(false);
		}
	};

	const btn =
		"inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs disabled:opacity-50 transition-colors font-medium";
	// Primary = neutral solid (text-coloured bg, bg-coloured text); secondary =
	// ghost with a --line hairline. Codex quiet-panel palette, no hues.
	const btnPrimary = `${btn} bg-[var(--text)] text-[var(--bg)] hover:opacity-90`;
	const btnGhost = `${btn} border border-[var(--line)] text-[var(--text-60)] hover:bg-[var(--ghost-hover)] hover:text-[var(--text)]`;
	return (
		<div
			onKeyDown={onCardKeyDown}
			className="my-2 rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-3 text-[var(--text)]"
		>
			{title && (
				<div className="whitespace-pre-wrap text-[13px] font-medium text-[var(--text)]">
					{title}
				</div>
			)}
			{message && (
				<div className="mt-1 whitespace-pre-wrap text-[12px] text-[var(--text-40)]">
					{message}
				</div>
			)}

			{isApproval && (
				<div className="mt-2.5 flex flex-wrap items-center gap-2">
					<button
						ref={primaryApprovalBtnRef}
						type="button"
						disabled={busy}
						onClick={handleApprovalApprove}
						className={btnPrimary}
						title={t("chatView.pendingUi.allowOnceTitle")}
					>
						{busy && <Loader2 size={12} className="animate-spin" />}
						{t("chatView.pendingUi.allowOnce")}
					</button>
					{(method !== "select" || choices.session) && (
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								if (method === "select") {
									void respond({ value: choices.session, confirmed: true });
								} else {
									void respond({ confirmed: true, always: true });
								}
							}}
							className={btnGhost}
							title={choices.session ?? t("chatView.pendingUi.allowSessionTitle")}
						>
							{busy && <Loader2 size={12} className="animate-spin" />}
							{t("chatView.pendingUi.allowSession")}
						</button>
					)}
					{(method === "select" ? choices.always : hasPermanent) && (
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								if (method === "select") {
									void respond({ value: choices.always, confirmed: true });
								} else {
									void respond({
										confirmed: true,
										always: true,
										persist: true,
									});
								}
							}}
							className={btnGhost}
							title={choices.always ?? t("chatView.pendingUi.allowAlwaysTitle")}
						>
							{busy && <Loader2 size={12} className="animate-spin" />}
							{t("chatView.pendingUi.allowAlways")}
						</button>
					)}
					<button
						type="button"
						disabled={busy}
						onClick={handleApprovalReject}
						className={btnGhost}
						title={t("chatView.pendingUi.rejectTitle")}
					>
						{t("chatView.pendingUi.reject")}
					</button>
				</div>
			)}

			{!isApproval && method === "select" && (
				<div className="mt-2 flex flex-col gap-1">
					<div
						role={selectionMarker === "radio" ? "radiogroup" : selectionMarker ? "group" : undefined}
						aria-label={title || undefined}
						className="flex flex-col gap-1"
					>
						{options.map((opt, i) => {
							const marker = i < markableCount ? selectionMarker : undefined;
							const checked = marker === "checkbox" ? checkedIndices.includes(i) : i === initialIndex;
							const MarkerIcon = marker === "checkbox"
								? checked ? SquareCheck : Square
								: checked ? CircleDot : Circle;
							return (
								<button
									key={`${i}:${opt}`}
									ref={i === initialIndex ? initialOptionRef : undefined}
									type="button"
									role={marker}
									aria-checked={marker ? checked : undefined}
									disabled={busy}
									onClick={() => respond({ value: opt })}
									className={`${btn} w-full text-left text-[var(--text-60)] hover:bg-[var(--ghost-hover)] hover:text-[var(--text)]`}
								>
									{marker && <MarkerIcon size={14} aria-hidden="true" className="shrink-0" />}
									<span className="whitespace-pre-wrap">{opt}</span>
									{optionDetails[i]?.description && (
										<span className="ml-2 whitespace-pre-wrap text-[var(--text-40)]">
											{optionDetails[i].description}
										</span>
									)}
								</button>
							);
						})}
					</div>
					<button
						type="button"
						disabled={busy}
						onClick={() => respond({ cancelled: true })}
						className={`${btnGhost} self-start`}
					>
						{t("chatView.pendingUi.cancel")}
					</button>
				</div>
			)}

			{!isApproval && method === "confirm" && (
				<div className="mt-2 flex flex-col gap-2">
					<div className="flex gap-2">
						<button
							ref={!isApproval ? primaryApprovalBtnRef : undefined}
							type="button"
							disabled={busy}
							onClick={() => respond({ confirmed: true })}
							className={btnPrimary}
						>
							{busy && <Loader2 size={12} className="animate-spin" />}
							{t("chatView.pendingUi.confirm")}
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => respond({ confirmed: false })}
							className={btnGhost}
						>
							{t("chatView.pendingUi.cancel")}
						</button>
					</div>
				</div>
			)}

			{(method === "input" || method === "editor") && (
				<div className="mt-2 flex flex-col gap-1.5">
					<textarea
						autoFocus
						value={text}
						onChange={(e) => {
							setText(e.target.value);
							if (validationError) setValidationError(null);
						}}
						onKeyDown={(e) => {
							if (isComposing(e)) return;
							if (
								(method === "input" && e.key === "Enter" && !e.shiftKey) ||
								((e.metaKey || e.ctrlKey) && e.key === "Enter")
							) {
								e.preventDefault();
								submitText();
							}
						}}
						placeholder={
							typeof request.placeholder === "string" && request.placeholder
								? request.placeholder
								: method === "editor"
									? t("chatView.pendingUi.placeholderEditor")
									: isRequired
										? t("chatView.pendingUi.placeholderRequired")
										: t("chatView.pendingUi.placeholderOptional")
						}
						rows={method === "editor" ? 8 : 2}
						className="w-full rounded-md border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[12px] text-[var(--text)] outline-none focus:border-[var(--text-30)]"
					/>
					{validationError && (
						<div className="text-[11px] text-[var(--status-error)]">
							{validationError}
						</div>
					)}
					<div className="flex gap-2">
						<button
							type="button"
							disabled={busy}
							onClick={submitText}
							className={btnPrimary}
						>
							{busy && <Loader2 size={12} className="animate-spin" />}
							{t("chatView.pendingUi.submit")}
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => respond({ cancelled: true })}
							className={btnGhost}
						>
							{t("chatView.pendingUi.cancel")}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

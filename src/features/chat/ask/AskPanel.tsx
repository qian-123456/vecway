/** [B] Codex-style panel for the agent's `ask` tool, docked in place of the
 * composer. omp drives ask over plain select/editor UI requests; the routing
 * hook matches those to the ask tool-call arguments and replays the user's
 * answer as the RPC response sequence (see askDriver.ts). */

import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { PendingUiRequest } from "../../../lib/contracts";
import { errMsg } from "../../../lib/dialogs";
import { isComposing } from "../../../lib/hooks";
import { rpcUiRespond } from "../../../lib/ipc";
import { toast } from "../../../lib/toast";
import { tNow, useT } from "../../../stores/language";
import { useLive } from "../../../stores/live";
import {
	type AskAnswer,
	type AskDriverState,
	type AskMatch,
	type AskQuestion,
	type AskResolution,
	type AskSpec,
	findOpenAsks,
	initialToggledForQuestion,
	isAnswerSubmittable,
	matchRequest,
	parseAskArgs,
	resolveRequest,
	serializeFormData,
	unansweredQuestions,
} from "./askDriver";
import { claimEscape } from "../../../lib/escapeClaim";

/** Driver progress keyed `${sessionId}:${toolCallId}:${qIndex}`; module-level
 * so it survives SessionView remounts (session switch). */
const driverStates = new Map<string, AskDriverState>();
/** Stored answers for direct `method: "form"` submissions, keyed `${sessionId}:${toolCallId}`. */
const formSubmissions = new Map<string, readonly (AskAnswer | undefined)[]>();
/** Last non-final question index sent to omp per ask, keyed `${sessionId}:${toolCallId}`. */
const activeQuestionIndices = new Map<string, number>();
/** Request ids already answered by the driver, keyed `sessionId:id` (ids may be
 * reused across sessions; guards double responses). */
const respondedIds = new Set<string>();
export const respondedKey = (sessionId: string, id: string): string => `${sessionId}:${id}`;

/** Forget driver progress and answered ids of removed sessions (keys are `sessionId:...`). */
export function pruneAskState(sessionIds: readonly string[]): void {
	const prefixes = sessionIds.map((sid) => `${sid}:`);
	const hit = (k: string) => prefixes.some((p) => k.startsWith(p));
	for (const k of [...driverStates.keys()]) if (hit(k)) driverStates.delete(k);
	for (const k of [...formSubmissions.keys()]) if (hit(k)) formSubmissions.delete(k);
	for (const k of [...activeQuestionIndices.keys()]) if (hit(k)) activeQuestionIndices.delete(k);
	for (const k of [...respondedIds]) if (hit(k)) respondedIds.delete(k);
}

export interface AskRoute {
	req: PendingUiRequest;
	spec: AskSpec;
	match: AskMatch;
	resolution: AskResolution;
}

function matchSpecRequest(
	sessionId: string,
	req: PendingUiRequest,
	spec: AskSpec,
): AskRoute | null {
	const formKey = `${sessionId}:${spec.toolCallId}`;
	const match = matchRequest(spec, req.request, activeQuestionIndices.get(formKey));
	if (!match) return null;
	if (match.method === "form") {
		const submitted = formSubmissions.get(formKey);
		const resolution: AskResolution = submitted
			? { kind: "autoForm", data: serializeFormData(spec, submitted) }
			: { kind: "present" };
		return { req, spec, match, resolution };
	}
	const key = `${sessionId}:${spec.toolCallId}:${match.qIndex}`;
	const resolution = resolveRequest(
		spec.questions[match.qIndex],
		match,
		driverStates.get(key),
	);
	return resolution.kind !== "fallback" ? { req, spec, match, resolution } : null;
}

export function useAskRouting(sessionId: string, pendingUi: PendingUiRequest[]) {
	const tools = useLive((s) => s.sessions[sessionId]?.tools);
	const items = useLive((s) => s.sessions[sessionId]?.items);
	const dismissUi = useLive((s) => s.dismissUi);
	const [version, bump] = useReducer((x: number) => x + 1, 0);
	const [awaiting, setAwaiting] = useState(false);

	const route = useMemo<AskRoute | null>(() => {
		void version;
		if (!pendingUi.length) return null;
		const specs = findOpenAsks(Object.values(tools ?? {}), items ?? []);
		for (const req of pendingUi) {
			for (const spec of specs) {
				const found = matchSpecRequest(sessionId, req, spec);
				if (found) return found;
			}
			// Direct `method: "form"` RPC request without a matched open ask tool call.
			const raw =
				typeof req.request === "object" && req.request !== null
					? (req.request as Record<string, unknown>)
					: null;
			if (raw?.method === "form" && typeof raw.id === "string" && typeof raw.html === "string") {
				const adHoc = parseAskArgs(`form:${raw.id}`, { html: raw.html });
				if (adHoc) {
					const found = matchSpecRequest(sessionId, req, adHoc);
					if (found) return found;
				}
			}
		}
		return null;
	}, [pendingUi, tools, items, sessionId, version]);

	// Replay the stored answer one response at a time; omp re-sends the next
	// request, which re-runs this effect.
	useEffect(() => {
		if (!route) return;
		const { match, spec, resolution } = route;
		if (resolution.kind !== "auto" && resolution.kind !== "autoForm") return;
		const id = match.requestId;
		const rkey = respondedKey(sessionId, id);
		if (respondedIds.has(rkey)) return;
		respondedIds.add(rkey);
		const formKey = `${sessionId}:${spec.toolCallId}`;

		if (resolution.kind === "autoForm") {
			setAwaiting(true);
			rpcUiRespond(sessionId, { id, data: resolution.data })
				.then(() => {
					formSubmissions.delete(formKey);
					activeQuestionIndices.delete(formKey);
					setAwaiting(false);
					dismissUi(sessionId, id);
				})
				.catch((err) => {
					formSubmissions.delete(formKey);
					activeQuestionIndices.delete(formKey);
					respondedIds.delete(rkey);
					toast.error(tNow("ask.submitFailed", { error: errMsg(err) }));
					setAwaiting(false);
					bump();
				});
			return;
		}

		const key = `${sessionId}:${spec.toolCallId}:${match.qIndex}`;
		const state = driverStates.get(key);
		const q = spec.questions[match.qIndex];
		const isHtmlMultiOtherInput =
			match.isHtml === true &&
			q.multi &&
			(match.method === "input" || match.method === "editor");
		const final =
			q.kind === "text" ||
			((match.method === "editor" || match.method === "input") && !isHtmlMultiOtherInput) ||
			(match.method === "select" &&
				resolution.value !== match.otherOption &&
				(!q.multi || resolution.value === match.doneOption));
		const isLastQuestion = match.qIndex === spec.questions.length - 1;
		setAwaiting(true);
		rpcUiRespond(sessionId, { id, value: resolution.value })
			.then(() => {
				if (final) {
					driverStates.delete(key);
					activeQuestionIndices.delete(formKey);
					if (isLastQuestion) setAwaiting(false);
				} else if (state) {
					driverStates.set(key, {
						...state,
						toggled: resolution.toggled,
						...(resolution.otherSent ? { otherSent: true } : {}),
					});
					activeQuestionIndices.set(formKey, match.qIndex);
				}
				dismissUi(sessionId, id);
			})
			.catch((err) => {
				driverStates.delete(key);
				activeQuestionIndices.delete(formKey);
				respondedIds.delete(rkey);
				toast.error(tNow("ask.submitFailed", { error: errMsg(err) }));
				setAwaiting(false);
				bump();
			});
	}, [route, sessionId, dismissUi]);

	// Bridge the gap between our response and omp's next request.
	useEffect(() => {
		if (!awaiting) return;
		if (route?.resolution.kind === "present") {
			setAwaiting(false);
			return;
		}
		const timer = setTimeout(() => setAwaiting(false), 4000);
		return () => clearTimeout(timer);
	}, [awaiting, route]);

	/** Store every drafted answer; replay starts on the pending request and
	 * continues as omp sends each following question. */
	const submit = useCallback(
		(answers: readonly (AskAnswer | undefined)[]) => {
			if (!route) return;
			if (route.match.method === "form") {
				formSubmissions.set(`${sessionId}:${route.spec.toolCallId}`, answers);
			} else {
				answers.forEach((answer, i) => {
					if (answer) {
						driverStates.set(`${sessionId}:${route.spec.toolCallId}:${i}`, {
							answer,
							toggled: initialToggledForQuestion(route.spec, route.spec.questions[i]),
						});
					}
				});
			}
			bump();
		},
		[route, sessionId],
	);

	const cancel = useCallback(async () => {
		if (!route) return;
		const id = route.match.requestId;
		respondedIds.add(respondedKey(sessionId, id));
		try {
			await rpcUiRespond(sessionId, { id, cancelled: true });
			dismissUi(sessionId, id);
		} catch (err) {
			respondedIds.delete(respondedKey(sessionId, id));
			toast.error(tNow("ask.cancelFailed", { error: errMsg(err) }));
		}
	}, [route, sessionId, dismissUi]);

	return { route, awaiting, submit, cancel };
}

interface Draft extends AskAnswer {
	cursor: number;
}

const validRecommended = (q: AskQuestion): number | undefined =>
	q.recommended !== undefined && q.recommended >= 0 && q.recommended < q.options.length
		? q.recommended
		: undefined;

function initialDraft(q: AskQuestion): Draft {
	if (q.kind === "text") {
		return { cursor: 0, selected: [], custom: "", text: q.value ?? "" };
	}
	if (q.multi) {
		const preChecked = q.options.filter((o) => o.checked).map((o) => o.label);
		const firstChecked = q.options.findIndex((o) => o.checked);
		return {
			cursor: firstChecked >= 0 ? firstChecked : 0,
			selected: preChecked,
			custom: "",
			notes: {},
		};
	}
	const rec = validRecommended(q);
	return {
		cursor: rec ?? 0,
		selected: rec !== undefined ? [q.options[rec].label] : [],
		custom: "",
		notes: {},
	};
}

function cleanNotes(
	selected: readonly string[],
	notes: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!notes) return undefined;
	const out: Record<string, string> = {};
	let hasAny = false;
	for (const label of selected) {
		const v = notes[label]?.trim();
		if (v) {
			out[label] = v;
			hasAny = true;
		}
	}
	return hasAny ? out : undefined;
}

/** Single-select: typed Other text replaces the option pick; per-option notes stay with chosen options. */
function answerOf(q: AskQuestion, d: Draft): AskAnswer {
	if (q.kind === "text") {
		return { selected: [], custom: "", text: d.text ?? "" };
	}
	if (q.multi) {
		const notes = cleanNotes(d.selected, d.notes);
		return notes
			? { selected: d.selected, custom: d.custom, notes }
			: { selected: d.selected, custom: d.custom };
	}
	const selected = d.custom.trim() ? [] : d.selected;
	const notes = cleanNotes(selected, d.notes);
	return notes
		? { selected, custom: d.custom, notes }
		: { selected, custom: d.custom };
}

const TEXT_INPUT_TYPES: Record<string, "text" | "number" | "email" | "url" | "date"> = {
	text: "text",
	number: "number",
	email: "email",
	url: "url",
	date: "date",
};

/** All questions of one ask; navigation is local, only 提交 talks to omp. */
export function AskPanel({
	spec,
	startIndex,
	busy,
	onSubmit,
	onCancel,
}: {
	spec: AskSpec;
	/** First question omp still waits for (earlier ones are already answered). */
	startIndex: number;
	busy: boolean;
	onSubmit: (answers: readonly (AskAnswer | undefined)[]) => void;
	onCancel: () => void;
}) {
	const { t, locale } = useT();
	const total = spec.questions.length;
	const [current, setCurrent] = useState(startIndex);
	// Drafts exist once a question is visited, so an unvisited multi-select
	// still counts as unanswered.
	const [drafts, setDrafts] = useState<(Draft | undefined)[]>(() => {
		const d: (Draft | undefined)[] = [];
		d[startIndex] = initialDraft(spec.questions[startIndex]);
		return d;
	});
	const [focusNoteLabel, setFocusNoteLabel] = useState<string | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const otherInputRef = useRef<HTMLInputElement>(null);
	const textInputRef = useRef<HTMLInputElement>(null);
	const textAreaRef = useRef<HTMLTextAreaElement>(null);
	const noteInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

	const question = spec.questions[current];
	const isText = question.kind === "text";
	const { options, multi } = question;
	const showOther = !isText && question.hasOther !== false;
	const draft = drafts[current] ?? initialDraft(question);
	const otherIdx = options.length;
	const rowCount = showOther ? options.length + 1 : options.length;
	const rec = validRecommended(question);
	const answers = spec.questions.map((q, i) => {
		const d = drafts[i];
		return d ? answerOf(q, d) : undefined;
	});
	const missing = unansweredQuestions(spec, answers, startIndex);
	const isLast = current === total - 1;

	useEffect(() => {
		if (isText) {
			if (question.multiline) textAreaRef.current?.focus();
			else textInputRef.current?.focus();
		} else {
			panelRef.current?.focus();
		}
	}, [current, isText, question.multiline]);

	useEffect(() => {
		if (!focusNoteLabel) return;
		noteInputRefs.current[focusNoteLabel]?.focus();
		setFocusNoteLabel(null);
	}, [focusNoteLabel]);

	const update = (patch: Partial<Draft>) =>
		setDrafts((ds) => {
			const next = [...ds];
			next[current] = { ...(ds[current] ?? initialDraft(question)), ...patch };
			return next;
		});

	const goTo = (i: number) => {
		if (i < startIndex || i >= total) return;
		setDrafts((ds) => {
			if (ds[i]) return ds;
			const next = [...ds];
			next[i] = initialDraft(spec.questions[i]);
			return next;
		});
		setCurrent(i);
	};

	const submitAll = () => {
		if (busy) return;
		if (missing.length) goTo(missing[0]);
		else onSubmit(answers);
	};

	const activate = (i: number) => {
		if (showOther && i === otherIdx) {
			update({ cursor: i });
			otherInputRef.current?.focus();
			return;
		}
		if (i < 0 || i >= options.length) return;
		const label = options[i].label;
		if (multi) {
			setDrafts((ds) => {
				const next = [...ds];
				const cur = ds[current] ?? initialDraft(question);
				const s = cur.selected;
				next[current] = {
					...cur,
					cursor: i,
					selected: s.includes(label) ? s.filter((l) => l !== label) : [...s, label],
				};
				return next;
			});
			return;
		}
		// Selecting a radio option never auto-advances; user confirms with 下一步 / 提交.
		update({ cursor: i, selected: [label], custom: "" });
	};

	const selectOptionForNote = (label: string, i: number) => {
		setDrafts((ds) => {
			const next = [...ds];
			const cur = ds[current] ?? initialDraft(question);
			const selected = multi
				? cur.selected.includes(label)
					? cur.selected
					: [...cur.selected, label]
				: [label];
			next[current] = {
				...cur,
				cursor: i,
				selected,
				...(multi ? {} : { custom: "" }),
			};
			return next;
		});
	};

	const updateOptionNote = (label: string, i: number, value: string) => {
		setDrafts((ds) => {
			const next = [...ds];
			const cur = ds[current] ?? initialDraft(question);
			const selected = multi
				? cur.selected.includes(label)
					? cur.selected
					: [...cur.selected, label]
				: [label];
			next[current] = {
				...cur,
				cursor: i,
				selected,
				...(multi ? {} : { custom: "" }),
				notes: { ...(cur.notes ?? {}), [label]: value },
			};
			return next;
		});
	};

	const openOptionNote = (label: string, i: number) => {
		selectOptionForNote(label, i);
		setFocusNoteLabel(label);
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (isComposing(e) || busy) return;
		const target = e.target as HTMLElement | null;
		const inTextarea = target?.tagName === "TEXTAREA";
		const inTextEntry =
			target?.tagName === "INPUT" || inTextarea || target?.isContentEditable === true;
		const plain = !e.metaKey && !e.ctrlKey && !e.altKey;

		if (e.key === "Escape") {
			claimEscape(e);
			if (inTextEntry) panelRef.current?.focus();
			else onCancel();
			return;
		}
		if (e.key === "Enter") {
			if (inTextarea) {
				if (e.metaKey || e.ctrlKey) {
					e.preventDefault();
					if (isLast) submitAll();
					else goTo(current + 1);
				}
				return;
			}
			if (!e.shiftKey) {
				e.preventDefault();
				if (isLast) submitAll();
				else goTo(current + 1);
				return;
			}
		}
		if (inTextEntry) return;
		if (!isText && rowCount > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			e.preventDefault();
			const next = (draft.cursor + (e.key === "ArrowDown" ? 1 : -1) + rowCount) % rowCount;
			update({ cursor: next });
			if (showOther && next === otherIdx) otherInputRef.current?.focus();
			else panelRef.current?.focus();
			return;
		}
		if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && plain) {
			e.preventDefault();
			goTo(current + (e.key === "ArrowRight" ? 1 : -1));
			return;
		}
		if (e.key === " " && !isText && draft.cursor < options.length) {
			e.preventDefault();
			activate(draft.cursor);
			return;
		}
		if (/^[1-9]$/.test(e.key) && plain && !isText) {
			const i = Number(e.key) - 1;
			if (i < rowCount) {
				e.preventDefault();
				activate(i);
			}
			return;
		}
		// Typing while focused on choice panel jumps into the free-text Other row if available.
		if (e.key.length === 1 && plain && showOther) {
			update({ cursor: otherIdx });
			otherInputRef.current?.focus();
		}
	};

	const ghostBtn =
		"inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-[var(--line)] px-2.5 py-1 text-xs font-medium text-[var(--text-60)] transition-colors hover:bg-[var(--ghost-hover)] hover:text-[var(--text)] disabled:opacity-50";
	const primaryBtn =
		"inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-[var(--text)] px-2.5 py-1 text-xs font-medium text-[var(--bg)] transition-colors hover:opacity-90 disabled:opacity-50";
	const enterAction = isLast ? t("ask.hintSubmit") : t("ask.hintNext");
	const hintLine = isText
		? question.multiline
			? `${t("ask.hintMultiline", { action: enterAction })}${total > 1 ? t("ask.hintSwitch") : ""}${t("ask.hintEsc")}`
			: `${t("ask.hintText")}${total > 1 ? t("ask.hintSwitch") : ""}${t("ask.hintEnter", { action: enterAction })}${t("ask.hintEsc")}`
		: `${multi ? t("ask.hintMulti") : t("ask.hintSingle")}${total > 1 ? t("ask.hintSwitch") : ""}${t("ask.hintEnter", { action: enterAction })}${t("ask.hintEsc")}`;

	return (
		<div
			ref={panelRef}
			tabIndex={-1}
			onKeyDown={onKeyDown}
			className="my-2 rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-3 text-[var(--text)] outline-none"
		>
			<div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-40)]">
				{question.header && question.header !== question.question && (
					<span className="whitespace-nowrap rounded border border-[var(--line)] px-1.5 py-px text-[var(--text-60)]">
						{question.header}
					</span>
				)}
				{total > 1 && (
					<span className="whitespace-nowrap">
						{t("ask.questionProgress", { current: current + 1, total })}
					</span>
				)}
				{!isText && multi && <span className="whitespace-nowrap">{t("ask.multiSelect")}</span>}
				{question.required && (
					<span className="whitespace-nowrap rounded border border-[var(--line)] px-1.5 py-px text-[var(--text-60)]">
						{t("ask.required")}
					</span>
				)}
				{total > 1 && (
					<span className="ml-auto flex items-center gap-1">
						{spec.questions.map((q, i) => {
							const a = answers[i];
							const done = i < startIndex || (a !== undefined && isAnswerSubmittable(q, a));
							return (
								<button
									key={`${q.id}-${i}`}
									type="button"
									disabled={busy || i < startIndex}
									aria-label={t("ask.questionAria", { index: i + 1 })}
									title={t("ask.questionAria", { index: i + 1 })}
									onClick={() => goTo(i)}
									className={`h-1.5 rounded-full transition-all ${i === current ? "w-4 bg-[var(--text)]" : `w-1.5 ${done ? "bg-[var(--text-60)]" : "bg-[var(--line)]"}`}`}
								/>
							);
						})}
					</span>
				)}
			</div>
			<div className="mt-1.5 whitespace-pre-wrap text-[13px] font-medium">
				{question.question}
			</div>
			{question.context && (
				<div className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-60)]">
					{question.context}
				</div>
			)}
			{isText ? (
				question.multiline ? (
					<textarea
						ref={textAreaRef}
						rows={3}
						value={draft.text ?? ""}
						disabled={busy}
						placeholder={question.placeholder ?? t("ask.textPlaceholder")}
						onChange={(e) => update({ text: e.target.value })}
						className="mt-2 w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2 text-[13px] text-[var(--text)] outline-none transition-colors focus:border-[var(--text-40)] placeholder:text-[var(--text-40)]"
					/>
				) : (
					<input
						ref={textInputRef}
						type={TEXT_INPUT_TYPES[question.inputType ?? "text"] ?? "text"}
						value={draft.text ?? ""}
						disabled={busy}
						placeholder={question.placeholder ?? t("ask.textPlaceholder")}
						onChange={(e) => update({ text: e.target.value })}
						className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none transition-colors focus:border-[var(--text-40)] placeholder:text-[var(--text-40)]"
					/>
				)
			) : (
				<div className="mt-2 flex flex-col gap-1">
					{options.map((o, i) => {
						const on = draft.selected.includes(o.label) && (multi || !draft.custom.trim());
						const noteVal = draft.notes?.[o.label] ?? "";
						const showNoteInput = on || noteVal.length > 0;
						return (
							<div
								key={`${o.label}-${i}`}
								onMouseEnter={() => update({ cursor: i })}
								className={`rounded-lg border transition-colors ${
									on
										? "border-[var(--text-40)] bg-[var(--ghost-hover)]"
										: draft.cursor === i
											? "border-transparent bg-[var(--ghost-hover)]"
											: "border-transparent"
								}`}
							>
								<div className="flex items-start gap-2 px-2 py-1.5">
									<button
										type="button"
										disabled={busy}
										aria-pressed={on}
										onClick={() => activate(i)}
										className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:opacity-50"
									>
										<span
											className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-md border text-[11px] font-medium tabular-nums transition-colors ${
												on
													? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]"
													: "border-[var(--line)] bg-[var(--bg)] text-[var(--text-60)]"
											}`}
										>
											{i + 1}
										</span>
										{multi && (
											<span
												className={`mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${on ? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]" : "border-[var(--text-40)]"}`}
											>
												{on && <Check size={10} strokeWidth={3} />}
											</span>
										)}
										<span className="min-w-0 flex-1 pt-0.5">
											<span className={`text-[13px] ${on && !multi ? "font-medium" : ""}`}>
												{o.label}
											</span>
											{i === rec && (
												<span className="ml-1.5 whitespace-nowrap rounded border border-[var(--line)] px-1 py-px text-[10px] text-[var(--text-60)]">
													{t("ask.recommended")}
												</span>
											)}
											{o.description && (
												<span className="block whitespace-pre-wrap text-[12px] text-[var(--text-40)]">
													{o.description}
												</span>
											)}
										</span>
									</button>
									{!showNoteInput && (
										<button
											type="button"
											disabled={busy}
											onClick={() => openOptionNote(o.label, i)}
											className="mt-0.5 shrink-0 whitespace-nowrap rounded border border-[var(--line)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] text-[var(--text-60)] transition-colors hover:border-[var(--text-40)] hover:text-[var(--text)] disabled:opacity-50"
										>
											{t("ask.addNote")}
										</button>
									)}
									{!multi && on && (
										<Check size={13} className="mt-1.5 shrink-0 text-[var(--text-60)]" />
									)}
								</div>
								{showNoteInput && (
									<div className="px-2 pb-2 pl-9">
										<input
											ref={(el) => {
												noteInputRefs.current[o.label] = el;
											}}
											type="text"
											value={noteVal}
											disabled={busy}
											aria-label={t("ask.optionNoteAria", { option: o.label })}
											placeholder={t("ask.optionNotePlaceholder")}
											onFocus={() => selectOptionForNote(o.label, i)}
											onChange={(e) => updateOptionNote(o.label, i, e.target.value)}
											className="w-full rounded-md border border-[var(--line)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--text)] outline-none transition-colors focus:border-[var(--text-40)] placeholder:text-[var(--text-40)]"
										/>
									</div>
								)}
							</div>
						);
					})}
					{showOther && (
						<div
							className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors ${
								draft.custom.trim()
									? "border-[var(--text-40)] bg-[var(--ghost-hover)]"
									: draft.cursor === otherIdx
										? "border-transparent bg-[var(--ghost-hover)]"
										: "border-transparent"
							}`}
							onMouseEnter={() => update({ cursor: otherIdx })}
						>
							<span
								className={`flex h-5 w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-md border text-[11px] font-medium tabular-nums transition-colors ${
									draft.custom.trim()
										? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]"
										: "border-[var(--line)] bg-[var(--bg)] text-[var(--text-60)]"
								}`}
							>
								{otherIdx + 1}
							</span>
							<input
								ref={otherInputRef}
								value={draft.custom}
								disabled={busy}
								onFocus={() => update({ cursor: otherIdx })}
								onChange={(e) => update({ custom: e.target.value })}
								placeholder={multi ? t("ask.notesOptional") : t("ask.otherLabel")}
								className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-40)]"
							/>
						</div>
					)}
				</div>
			)}
			<div className="mt-2.5 flex items-center gap-2">
				<span className="min-w-0 flex-1 text-[11px] text-[var(--text-40)]">
					{isLast && missing.length > 0
						? t("ask.unanswered", {
								questions: missing
									.map((i) => t("ask.questionAria", { index: i + 1 }))
									.join(locale === "zh-CN" ? "、" : ", "),
							})
						: hintLine}
				</span>
				<button type="button" disabled={busy} onClick={onCancel} className={ghostBtn}>
					{t("ask.skip")}
				</button>
				{total > 1 && (
					<button
						type="button"
						disabled={busy || current <= startIndex}
						onClick={() => goTo(current - 1)}
						className={ghostBtn}
					>
						{t("ask.prevQuestion")}
					</button>
				)}
				{isLast ? (
					<button
						type="button"
						disabled={busy || missing.length > 0}
						onClick={submitAll}
						className={primaryBtn}
					>
						{busy && <Loader2 size={12} className="animate-spin" />}
						{t("ask.submit")}
					</button>
				) : (
					<button type="button" disabled={busy} onClick={() => goTo(current + 1)} className={primaryBtn}>
						{t("ask.nextQuestion")}
					</button>
				)}
			</div>
		</div>
	);
}

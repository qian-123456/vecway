/** [B] Pure logic mapping omp's generic UI requests onto the `ask` tool.
 *
 * In `--mode rpc` omp drives each ask question through plain `select` /
 * `editor` extension_ui_requests. This module recognises those requests,
 * strips omp's decorations and computes the next RPC response that moves omp
 * towards the answer the user picked in the AskPanel. */

import type { TranscriptItem } from "../../../lib/contracts";

export const OTHER_OPTION = "Other (type your own)";
const RECOMMENDED_SUFFIX = " (Recommended)";
const DONE_SUFFIX = " Done selecting";

export interface AskOption {
	label: string;
	value?: string;
	description?: string;
	checked?: boolean;
}

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	context?: string;
	kind?: "choice" | "text";
	options: AskOption[];
	multi: boolean;
	recommended?: number;
	value?: string;
	placeholder?: string;
	inputType?: string;
	multiline?: boolean;
	required?: boolean;
	hasOther?: boolean;
}

export interface AskSpec {
	toolCallId: string;
	questions: AskQuestion[];
	source?: "legacy" | "html";
	hiddenFields?: [string, string][];
}

export interface AskAnswer {
	/** Chosen option labels (undecorated). */
	selected: string[];
	/** Free text typed into the "其他" row; empty = none. */
	custom: string;
	/** Per-option extra text keyed by option label. */
	notes?: Record<string, string>;
	/** Text value for kind === "text" questions. */
	text?: string;
}

/** Per-question driver progress. */
export interface AskDriverState {
	answer: AskAnswer;
	/** Labels toggled on in omp's multi-select loop so far. */
	toggled: string[];
	/** Whether Other was already submitted in an HTML multi-select loop. */
	otherSent?: boolean;
}

export interface AskMatch {
	requestId: string;
	method: "select" | "input" | "editor" | "form";
	qIndex: number;
	total: number;
	/** `(k selected)` prefix count (multi-select loop). */
	selectedCount: number;
	/** Undecorated label -> raw option string omp expects back. */
	optionByLabel: Record<string, string>;
	otherOption: string | null;
	doneOption: string | null;
	/** Checked option indices from omp's checkbox select request, when provided. */
	checkedIndices?: number[];
	/** Raw option strings in order (for checkedIndices mapping). */
	rawOptions?: string[];
	/** Whether this match belongs to an HTML form spec. */
	isHtml?: boolean;
}

export type AskResolution =
	| { kind: "auto"; value: string; toggled: string[]; otherSent?: boolean }
	| { kind: "autoForm"; data: Record<string, string | number | string[]> }
	| { kind: "present" }
	| { kind: "fallback" };

const asObj = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const normSpace = (s: string): string => s.replace(/\s+/g, " ").trim();

const IGNORED_INPUT_TYPES: Record<string, true> = {
	hidden: true,
	submit: true,
	reset: true,
	button: true,
	image: true,
};
const TEXT_BLOCK_TAGS: Record<string, true> = {
	p: true,
	h1: true,
	h2: true,
	h3: true,
	h4: true,
	h5: true,
	h6: true,
	blockquote: true,
};
const CONTEXT_BLOCK_TAGS: Record<string, true> = {
	...TEXT_BLOCK_TAGS,
	ul: true,
	ol: true,
	pre: true,
	table: true,
};

function isElementDisabled(el: Element): boolean {
	if (el.hasAttribute("disabled")) return true;
	let cur = el.parentElement;
	while (cur) {
		if (cur.tagName.toLowerCase() === "fieldset" && cur.hasAttribute("disabled")) {
			const firstLegend = Array.from(cur.children).find(
				(c) => c.tagName.toLowerCase() === "legend",
			);
			if (!firstLegend || !firstLegend.contains(el)) return true;
		}
		cur = cur.parentElement;
	}
	return false;
}

function extractLabelText(label: Element): string {
	const clone = label.cloneNode(true) as Element;
	for (const ctrl of Array.from(clone.querySelectorAll("input, select, textarea, button"))) {
		ctrl.remove();
	}
	return normSpace(clone.textContent ?? "");
}

function extractContextBlockText(el: Element): string {
	const tag = el.tagName.toLowerCase();
	if (tag === "pre") {
		return (el.textContent ?? "").replace(/^\n+|\n+$/g, "").trimEnd();
	}
	if (tag === "ul" || tag === "ol") {
		const ordered = tag === "ol";
		const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === "li");
		return items
			.map((li, i) => `${ordered ? `${i + 1}.` : "-"} ${normSpace(li.textContent ?? "")}`)
			.filter((line) => line.length > 2)
			.join("\n");
	}
	if (tag === "table") {
		const rows = Array.from(el.querySelectorAll("tr"));
		return rows
			.map((tr) =>
				Array.from(tr.querySelectorAll("th, td"))
					.map((cell) => normSpace(cell.textContent ?? ""))
					.join(" | "),
			)
			.filter(Boolean)
			.join("\n");
	}
	return normSpace(el.textContent ?? "");
}

function hasActiveNamedControl(el: Element): boolean {
	for (const node of Array.from(el.querySelectorAll("input[name], select[name], textarea[name]"))) {
		if (node.tagName.toLowerCase() === "input") {
			const t = (node.getAttribute("type") ?? "text").toLowerCase();
			if (IGNORED_INPUT_TYPES[t]) continue;
		}
		return true;
	}
	return false;
}

interface ContextPart {
	text: string;
	isTextBlock: boolean;
}

function parseHtmlAskForm(toolCallId: string, html: string): AskSpec | null {
	if (typeof DOMParser === "undefined") return null;
	const doc = new DOMParser().parseFromString(html, "text/html");
	const root = doc.querySelector("form") ?? doc.body;
	if (!root) return null;

	const labelsByFor = new Map<string, Element>();
	for (const label of Array.from(root.querySelectorAll("label[for]"))) {
		const targetId = label.getAttribute("for");
		if (targetId && !labelsByFor.has(targetId)) labelsByFor.set(targetId, label);
	}

	const labelForControl = (el: Element): string => {
		const enclosing = el.closest("label");
		if (enclosing && root.contains(enclosing)) {
			const text = extractLabelText(enclosing);
			if (text) return text;
		}
		const id = el.getAttribute("id");
		if (id) {
			const refLabel = labelsByFor.get(id);
			if (refLabel) {
				const text = extractLabelText(refLabel);
				if (text) return text;
			}
		}
		return normSpace(el.getAttribute("aria-label") ?? "");
	};

	const hiddenFields: [string, string][] = [];
	const questions: AskQuestion[] = [];
	const choiceGroups = new Map<string, AskQuestion>();
	const choiceGroupTypes = new Map<AskQuestion, "radio" | "checkbox">();
	const fallbackNameQuestions = new Set<AskQuestion>();
	let formPending: ContextPart[] = [];

	const consumeContext = (
		legend: string | undefined,
		ownLabel: string,
		localPending: ContextPart[],
		fallbackName: string,
	): { question: string; context?: string; usedFallbackName: boolean } => {
		const combined = [...formPending, ...localPending];
		formPending = [];
		localPending.length = 0;

		let question = ownLabel || legend || "";
		let usedFallbackName = false;
		if (!question) {
			const last = combined[combined.length - 1];
			if (last && last.isTextBlock) {
				question = normSpace(last.text);
				combined.pop();
			}
		}
		if (!question) {
			question = fallbackName;
			usedFallbackName = true;
		}

		const qNorm = normSpace(question);
		const contextParts = combined
			.map((p) => p.text.trim())
			.filter((text) => text.length > 0 && normSpace(text) !== qNorm);
		return {
			question,
			context: contextParts.length ? contextParts.join("\n\n") : undefined,
			usedFallbackName,
		};
	};

	const walkChildren = (
		parent: Element,
		legend: string | undefined,
		localPending: ContextPart[],
	) => {
		for (const child of Array.from(parent.children)) {
			const tag = child.tagName.toLowerCase();
			if (tag === "legend" || tag === "button") continue;

			if (tag === "fieldset") {
				if (isElementDisabled(child)) continue;
				const directLegend = Array.from(child.children).find(
					(c) => c.tagName.toLowerCase() === "legend",
				);
				const nextLegend = directLegend ? normSpace(directLegend.textContent ?? "") : undefined;
				const fsPending: ContextPart[] = [];
				walkChildren(child, nextLegend || legend, fsPending);
				if (fsPending.length) formPending.push(...fsPending);
				continue;
			}

			if (tag === "input") {
				const name = child.getAttribute("name")?.trim();
				if (!name) continue;
				const type = (child.getAttribute("type") ?? "text").toLowerCase();
				if (type === "hidden") {
					hiddenFields.push([name, child.getAttribute("value") ?? ""]);
					continue;
				}
				if (IGNORED_INPUT_TYPES[type] || isElementDisabled(child)) continue;

				if (type === "radio" || type === "checkbox") {
					const groupKey = `${type}:${name}`;
					const optValue = child.getAttribute("value") ?? "on";
					const optLabel = labelForControl(child) || optValue;
					const checked = child.hasAttribute("checked");
					let group = choiceGroups.get(groupKey);
					if (!group) {
						const { question, context, usedFallbackName } = consumeContext(
							legend,
							"",
							localPending,
							name,
						);
						group = {
							id: name,
							question,
							header: legend || undefined,
							context,
							kind: "choice",
							options: [],
							multi: type === "checkbox",
							required: child.hasAttribute("required") || undefined,
						};
						choiceGroups.set(groupKey, group);
						choiceGroupTypes.set(group, type);
						if (usedFallbackName) fallbackNameQuestions.add(group);
						questions.push(group);
					}
					if (child.hasAttribute("required")) group.required = true;
					group.options.push({
						label: optLabel,
						value: optValue,
						...(checked ? { checked: true } : {}),
					});
					continue;
				}

				// Text-like input (text, number, date, email, url, etc.)
				const ownLabel = labelForControl(child);
				const placeholder = child.getAttribute("placeholder") || undefined;
				const { question, context } = consumeContext(
					legend,
					ownLabel,
					localPending,
					placeholder || name,
				);
				questions.push({
					id: name,
					question,
					header: legend || undefined,
					context,
					kind: "text",
					options: [],
					multi: false,
					value: child.getAttribute("value") ?? "",
					placeholder,
					inputType: type,
					multiline: false,
					required: child.hasAttribute("required") || undefined,
					hasOther: false,
				});
				continue;
			}

			if (tag === "textarea") {
				const name = child.getAttribute("name")?.trim();
				if (!name || isElementDisabled(child)) continue;
				const ownLabel = labelForControl(child);
				const placeholder = child.getAttribute("placeholder") || undefined;
				const { question, context } = consumeContext(
					legend,
					ownLabel,
					localPending,
					placeholder || name,
				);
				questions.push({
					id: name,
					question,
					header: legend || undefined,
					context,
					kind: "text",
					options: [],
					multi: false,
					value: child.textContent ?? "",
					placeholder,
					inputType: "textarea",
					multiline: true,
					required: child.hasAttribute("required") || undefined,
					hasOther: false,
				});
				continue;
			}

			if (tag === "select") {
				const name = child.getAttribute("name")?.trim();
				if (!name || isElementDisabled(child)) continue;
				const multi = child.hasAttribute("multiple");
				const options: AskOption[] = [];
				for (const opt of Array.from(child.querySelectorAll("option"))) {
					if (opt.hasAttribute("disabled")) continue;
					const label = normSpace(opt.textContent ?? "") || opt.getAttribute("value") || "";
					if (!label) continue;
					const value = opt.getAttribute("value") ?? label;
					const checked = opt.hasAttribute("selected");
					options.push({ label, value, ...(checked ? { checked: true } : {}) });
				}
				if (options.length === 0) continue;
				const ownLabel = labelForControl(child);
				const { question, context } = consumeContext(legend, ownLabel, localPending, name);
				const recIdx = !multi ? options.findIndex((o) => o.checked) : -1;
				questions.push({
					id: name,
					question,
					header: legend || undefined,
					context,
					kind: "choice",
					options,
					multi,
					recommended: recIdx >= 0 ? recIdx : undefined,
					required: child.hasAttribute("required") || undefined,
					hasOther: false,
				});
				continue;
			}

			if (tag === "label") {
				// Recurse into <label> if it wraps controls; standalone <label for="..."> is handled by labelForControl.
				if (hasActiveNamedControl(child) || child.querySelector('input[type="hidden"][name]')) {
					walkChildren(child, legend, localPending);
				}
				continue;
			}

			if (hasActiveNamedControl(child)) {
				walkChildren(child, legend, localPending);
				continue;
			}

			// Collect hidden inputs inside non-control containers too.
			for (const hidden of Array.from(child.querySelectorAll('input[type="hidden"][name]'))) {
				const hName = hidden.getAttribute("name")?.trim();
				if (hName) hiddenFields.push([hName, hidden.getAttribute("value") ?? ""]);
			}

			if (CONTEXT_BLOCK_TAGS[tag]) {
				const text = extractContextBlockText(child);
				if (text) localPending.push({ text, isTextBlock: Boolean(TEXT_BLOCK_TAGS[tag]) });
			} else if (child.children.length > 0) {
				walkChildren(child, legend, localPending);
			} else {
				const text = normSpace(child.textContent ?? "");
				if (text) localPending.push({ text, isTextBlock: true });
			}
		}
	};

	walkChildren(root, undefined, formPending);

	// Finalize radio/checkbox choice groups.
	for (const q of questions) {
		const groupType = choiceGroupTypes.get(q);
		if (!groupType) continue;
		if (fallbackNameQuestions.has(q) && q.options.length === 1) {
			q.question = q.options[0].label;
		}
		if (!q.multi) {
			const recIdx = q.options.findIndex((o) => o.checked);
			if (recIdx >= 0) q.recommended = recIdx;
		}
		const hasExplicitOther = q.options.some((o) =>
			/^(other|其他)(\s|\(|$)/i.test(o.label.trim()),
		);
		q.hasOther = q.options.length >= 2 && !hasExplicitOther;
	}

	const validQuestions = questions.filter((q) => q.kind === "text" || q.options.length > 0);
	if (validQuestions.length === 0) return null;
	return {
		toolCallId,
		questions: validQuestions,
		source: "html",
		...(hiddenFields.length ? { hiddenFields } : {}),
	};
}

export function parseAskArgs(toolCallId: string, args: unknown): AskSpec | null {
	if (typeof args === "string") {
		return parseHtmlAskForm(toolCallId, args);
	}
	const obj = asObj(args);
	if (typeof obj.html === "string") {
		return parseHtmlAskForm(toolCallId, obj.html);
	}
	const raw = obj.questions;
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const questions: AskQuestion[] = [];
	for (const [i, q0] of raw.entries()) {
		const q = asObj(q0);
		if (typeof q.question !== "string" || !Array.isArray(q.options)) return null;
		const options: AskOption[] = [];
		for (const o0 of q.options) {
			const o = asObj(o0);
			if (typeof o.label !== "string") return null;
			options.push({
				label: o.label,
				description:
					typeof o.description === "string" ? o.description : undefined,
			});
		}
		questions.push({
			id: typeof q.id === "string" ? q.id : String(i),
			question: q.question,
			header: typeof q.header === "string" ? q.header : undefined,
			options,
			multi: q.multi === true,
			recommended:
				typeof q.recommended === "number" ? q.recommended : undefined,
		});
	}
	return { toolCallId, questions, source: "legacy" };
}

/** Ask tool calls still awaiting a result, latest first. */
export function findOpenAsks(
	liveTools: { toolCallId: string; toolName: string; args: unknown; status: string }[],
	items: TranscriptItem[],
): AskSpec[] {
	const out: AskSpec[] = [];
	const seen = new Set<string>();
	const push = (id: string, args: unknown) => {
		if (seen.has(id)) return;
		seen.add(id);
		const spec = parseAskArgs(id, args);
		if (spec) out.push(spec);
	};
	for (const t of [...liveTools].reverse()) {
		if (t.toolName === "ask" && t.status === "running") push(t.toolCallId, t.args);
	}
	const answered = new Set(
		items.flatMap((it) => (it.toolResult ? [it.toolResult.toolCallId] : [])),
	);
	for (const it of [...items].reverse()) {
		for (const c of it.toolCalls) {
			if (c.name === "ask" && !answered.has(c.id)) push(c.id, c.args);
		}
	}
	return out;
}

export function parseTitle(title: string): {
	text: string;
	selectedCount: number;
	index: number | null;
	total: number | null;
} {
	let text = title;
	let selectedCount = 0;
	const pre = /^\((\d+) selected\) /.exec(text);
	if (pre) {
		selectedCount = Number(pre[1]);
		text = text.slice(pre[0].length);
	}
	let index: number | null = null;
	let total: number | null = null;
	const suf = / \((\d+)\/(\d+)\)$/.exec(text);
	if (suf) {
		index = Number(suf[1]);
		total = Number(suf[2]);
		text = text.slice(0, suf.index);
	}
	return { text, selectedCount, index, total };
}

export const stripOption = (opt: string): string =>
	opt.endsWith(RECOMMENDED_SUFFIX) ? opt.slice(0, -RECOMMENDED_SUFFIX.length) : opt;

interface HtmlTitleInfo {
	selectedCount: number;
	cleanLastLine: string;
	cleanParagraphs: string[];
	cleanFull: string;
}

function parseHtmlTitle(title: string): HtmlTitleInfo {
	let selectedCount = 0;
	const rawParagraphs = title
		.split(/\n\n+/)
		.map((p) => p.trim())
		.filter(Boolean);
	const paragraphs = rawParagraphs.length ? [...rawParagraphs] : [title.trim()];

	const lastIdx = paragraphs.length - 1;
	const lastPre = /^\((\d+) selected\) /.exec(paragraphs[lastIdx]);
	if (lastPre) {
		selectedCount = Number(lastPre[1]);
		paragraphs[lastIdx] = paragraphs[lastIdx].slice(lastPre[0].length);
	} else {
		const firstPre = /^\((\d+) selected\) /.exec(paragraphs[0]);
		if (firstPre) {
			selectedCount = Number(firstPre[1]);
			paragraphs[0] = paragraphs[0].slice(firstPre[0].length);
		}
	}

	const cleanParagraphs = paragraphs.map(normSpace).filter(Boolean);
	const cleanLastLine = cleanParagraphs[cleanParagraphs.length - 1] ?? "";
	const cleanFull = cleanParagraphs.join("\n\n");
	return { selectedCount, cleanLastLine, cleanParagraphs, cleanFull };
}

function titleMatchesHtmlQuestion(q: AskQuestion, info: HtmlTitleInfo, allowSubstring: boolean): boolean {
	const qText = normSpace(q.question);
	const headerText = q.header ? normSpace(q.header) : "";
	const idText = normSpace(q.id);
	const ctxParagraphs = q.context
		? q.context
				.split(/\n\n+/)
				.map(normSpace)
				.filter(Boolean)
		: [];
	const lastCtx = ctxParagraphs[ctxParagraphs.length - 1] ?? "";

	const lineMatches = (candidate: string): boolean =>
		Boolean(candidate) &&
		(info.cleanLastLine === candidate || info.cleanLastLine.startsWith(`${candidate} (`));

	if (lineMatches(qText)) return true;
	if (headerText && lineMatches(headerText)) return true;
	if (lastCtx && lineMatches(lastCtx)) {
		if (!headerText && !qText) return true;
		if (
			info.cleanParagraphs.includes(qText) ||
			(headerText && info.cleanParagraphs.includes(headerText)) ||
			info.cleanFull.includes(qText)
		) {
			return true;
		}
	}
	if (lineMatches(idText)) return true;
	if (allowSubstring) {
		if (qText && (info.cleanFull.endsWith(qText) || info.cleanFull.includes(qText))) return true;
		if (headerText && (info.cleanFull.endsWith(headerText) || info.cleanFull.includes(headerText)))
			return true;
	}
	return false;
}

function matchHtmlSelectQuestion(
	q: AskQuestion,
	qIndex: number,
	total: number,
	r: Record<string, unknown>,
	info: HtmlTitleInfo,
): AskMatch | null {
	if (q.kind === "text") return null;
	if (r.selectionMarker === "radio" && q.multi) return null;
	if (r.selectionMarker === "checkbox" && !q.multi) return null;
	if (!Array.isArray(r.options) || !r.options.every((o) => typeof o === "string")) return null;

	const rawOptions = r.options as string[];
	const optionByLabel: Record<string, string> = {};
	let otherOption: string | null = null;
	let doneOption: string | null = null;
	for (const o of rawOptions) {
		if (o === OTHER_OPTION) otherOption = o;
		else if (q.multi && o.endsWith(DONE_SUFFIX)) doneOption = o;
		else optionByLabel[stripOption(o)] = o;
	}
	const labels = q.options.map((o) => o.label);
	if (
		Object.keys(optionByLabel).length !== labels.length ||
		!labels.every((l) => l in optionByLabel)
	) {
		return null;
	}
	if (!titleMatchesHtmlQuestion(q, info, true)) return null;
	if (info.selectedCount > 0 && !q.multi) return null;

	const checkedIndices =
		Array.isArray(r.checkedIndices) && r.checkedIndices.every((n) => typeof n === "number")
			? (r.checkedIndices as number[])
			: undefined;

	return {
		requestId: r.id as string,
		method: "select",
		qIndex,
		total,
		selectedCount: info.selectedCount,
		optionByLabel,
		otherOption,
		doneOption,
		checkedIndices,
		rawOptions,
		isHtml: true,
	};
}

function matchHtmlRequest(
	spec: AskSpec,
	r: Record<string, unknown>,
	activeQIndex?: number,
): AskMatch | null {
	const method = r.method;
	if (typeof r.id !== "string") return null;
	const total = spec.questions.length;

	if (method === "form" && typeof r.html === "string") {
		return {
			requestId: r.id,
			method: "form",
			qIndex: 0,
			total,
			selectedCount: 0,
			optionByLabel: {},
			otherOption: null,
			doneOption: null,
			isHtml: true,
		};
	}

	if (typeof r.title !== "string") return null;
	const info = parseHtmlTitle(r.title);

	const candidateIndices: number[] = [];
	if (activeQIndex !== undefined && activeQIndex >= 0 && activeQIndex < total) {
		candidateIndices.push(activeQIndex);
	}
	for (let i = 0; i < total; i++) {
		if (i !== activeQIndex) candidateIndices.push(i);
	}

	if (method === "select") {
		for (const i of candidateIndices) {
			const m = matchHtmlSelectQuestion(spec.questions[i], i, total, r, info);
			if (m) return m;
		}
		return null;
	}

	if (method === "input" || method === "editor") {
		// If we have an active choice/text question whose title matches (e.g. Other follow-up), prefer it.
		if (activeQIndex !== undefined && activeQIndex >= 0 && activeQIndex < total) {
			const activeQ = spec.questions[activeQIndex];
			if (titleMatchesHtmlQuestion(activeQ, info, true)) {
				return {
					requestId: r.id,
					method,
					qIndex: activeQIndex,
					total,
					selectedCount: 0,
					optionByLabel: {},
					otherOption: null,
					doneOption: null,
					isHtml: true,
				};
			}
		}
		// Otherwise prefer text questions first, then choice questions (Other follow-up).
		for (const i of candidateIndices) {
			const q = spec.questions[i];
			if (q.kind === "text" && titleMatchesHtmlQuestion(q, info, false)) {
				return {
					requestId: r.id,
					method,
					qIndex: i,
					total,
					selectedCount: 0,
					optionByLabel: {},
					otherOption: null,
					doneOption: null,
					isHtml: true,
				};
			}
		}
		for (const i of candidateIndices) {
			const q = spec.questions[i];
			if (q.kind !== "text" && titleMatchesHtmlQuestion(q, info, false)) {
				return {
					requestId: r.id,
					method,
					qIndex: i,
					total,
					selectedCount: 0,
					optionByLabel: {},
					otherOption: null,
					doneOption: null,
					isHtml: true,
				};
			}
		}
		return null;
	}

	return null;
}

/** Recognise a raw extension_ui_request as a step of `spec`; null = not ours. */
export function matchRequest(
	spec: AskSpec,
	request: unknown,
	activeQIndex?: number,
): AskMatch | null {
	const r = asObj(request);
	if (spec.source === "html" || r.method === "form") {
		return matchHtmlRequest(spec, r, activeQIndex);
	}
	const method = r.method;
	if (method !== "select" && method !== "editor") return null;
	if (typeof r.id !== "string" || typeof r.title !== "string") return null;
	const t = parseTitle(r.title);
	const n = spec.questions.length;
	let qIndex: number;
	if (t.index !== null && t.total !== null) {
		// Keep the suffix only if it really is omp's progress marker.
		if (t.total !== n || t.index < 1 || t.index > n) {
			return n === 1 && spec.questions[0].question === r.title.replace(/^\(\d+ selected\) /, "")
				? matchAt(spec, r, 0, 1, t.selectedCount)
				: null;
		}
		qIndex = t.index - 1;
	} else {
		if (n !== 1) return null;
		qIndex = 0;
	}
	const q = spec.questions[qIndex];
	if (q.question !== t.text) return null;
	if (t.selectedCount > 0 && !q.multi) return null;
	return matchAt(spec, r, qIndex, n, t.selectedCount);
}

function matchAt(
	spec: AskSpec,
	r: Record<string, unknown>,
	qIndex: number,
	total: number,
	selectedCount: number,
): AskMatch | null {
	const q = spec.questions[qIndex];
	const base = {
		requestId: r.id as string,
		qIndex,
		total,
		selectedCount,
	};
	if (r.method === "editor") {
		return {
			...base,
			method: "editor",
			optionByLabel: {},
			otherOption: null,
			doneOption: null,
		};
	}
	if (!Array.isArray(r.options) || !r.options.every((o) => typeof o === "string"))
		return null;
	const optionByLabel: Record<string, string> = {};
	let otherOption: string | null = null;
	let doneOption: string | null = null;
	for (const o of r.options as string[]) {
		if (o === OTHER_OPTION) otherOption = o;
		else if (q.multi && o.endsWith(DONE_SUFFIX)) doneOption = o;
		else optionByLabel[stripOption(o)] = o;
	}
	const labels = q.options.map((o) => o.label);
	if (
		Object.keys(optionByLabel).length !== labels.length ||
		!labels.every((l) => l in optionByLabel)
	)
		return null;
	return { ...base, method: "select", optionByLabel, otherOption, doneOption };
}

function combinedMultiExtra(answer: AskAnswer): string {
	const parts: string[] = [];
	if (answer.notes) {
		for (const label of answer.selected) {
			const note = answer.notes[label]?.trim();
			if (note) parts.push(`${label}: ${note}`);
		}
	}
	const custom = answer.custom.trim();
	if (custom) parts.push(custom);
	return parts.join("; ");
}

/** Text sent to the editor/input that follows "Other". Multi-select questions
 * with no Done entry carry the chosen labels here so the agent still sees them. */
export function editorText(q: AskQuestion, answer: AskAnswer): string {
	const custom = answer.custom.trim();
	if (!q.multi) {
		if (custom) return custom;
		const sel = answer.selected[0];
		const note = sel ? answer.notes?.[sel]?.trim() : undefined;
		if (sel && note) return `${sel} — ${note}`;
		return "";
	}
	// omp's legacy result keeps only customInput once Other is used, so the
	// editor text must carry the checked labels too.
	const sel = `Selected: ${answer.selected.length ? answer.selected.join(", ") : "none"}`;
	const extra = combinedMultiExtra(answer);
	return extra ? `${sel}; note: ${extra}` : sel;
}

/** Initial pre-checked labels omp starts with in an HTML checkbox loop. */
export function initialToggledForQuestion(spec: AskSpec, q: AskQuestion): string[] {
	if (spec.source !== "html" || !q.multi) return [];
	return q.options.filter((o) => o.checked).map((o) => o.label);
}

/** Multi-select may be submitted empty unless marked required; text fields
 * require non-empty text only when `required` is set. */
export function isAnswerSubmittable(q: AskQuestion, answer: AskAnswer): boolean {
	if (q.kind === "text") {
		return !q.required || (answer.text ?? "").trim() !== "";
	}
	if (q.multi) {
		if (!q.required) return true;
		return (
			answer.selected.length > 0 ||
			(q.hasOther !== false && answer.custom.trim() !== "")
		);
	}
	return (
		(q.hasOther !== false && answer.custom.trim() !== "") ||
		answer.selected.length === 1
	);
}

/** Indices in `from..N-1` whose draft cannot be submitted yet. */
export function unansweredQuestions(
	spec: AskSpec,
	answers: readonly (AskAnswer | undefined)[],
	from: number,
): number[] {
	const out: number[] = [];
	for (let i = from; i < spec.questions.length; i++) {
		const a = answers[i];
		if (!a || !isAnswerSubmittable(spec.questions[i], a)) out.push(i);
	}
	return out;
}

/** Serialize all answers into OMP's `method: "form"` `{ data }` payload. */
export function serializeFormData(
	spec: AskSpec,
	answers: readonly (AskAnswer | undefined)[],
): Record<string, string | number | string[]> {
	const data: Record<string, string | number | string[]> = {};
	for (const [name, value] of spec.hiddenFields ?? []) {
		data[name] = value;
	}
	for (let i = 0; i < spec.questions.length; i++) {
		const q = spec.questions[i];
		const a = answers[i];
		if (!a) continue;
		if (q.kind === "text") {
			const raw = a.text ?? "";
			if ((q.inputType === "number" || q.inputType === "range") && raw.trim() !== "") {
				const num = Number(raw);
				data[q.id] = Number.isFinite(num) ? num : raw;
			} else {
				data[q.id] = raw;
			}
			continue;
		}
		const isArray = q.multi && q.options.length > 1;
		const allowOther = q.hasOther !== false;
		if (isArray) {
			const vals = a.selected.map(
				(label) => q.options.find((o) => o.label === label)?.value ?? label,
			);
			const extra = combinedMultiExtra(a);
			if (extra && allowOther) vals.push(extra);
			data[q.id] = vals;
		} else {
			const custom = a.custom.trim();
			if (custom && allowOther) {
				data[q.id] = custom;
			} else if (a.selected.length > 0) {
				const label = a.selected[0];
				const opt = q.options.find((o) => o.label === label);
				const note = a.notes?.[label]?.trim();
				if (note && allowOther) {
					data[q.id] = `${label} — ${note}`;
				} else {
					data[q.id] = opt?.value ?? label;
				}
			}
		}
	}
	return data;
}

/** Decide what to do with a matched request given stored driver state. */
export function resolveRequest(
	q: AskQuestion,
	m: AskMatch,
	state: AskDriverState | undefined,
): AskResolution {
	if (!state) {
		if (m.method === "form") return { kind: "present" };
		if (q.kind === "text" && (m.method === "input" || m.method === "editor")) {
			return { kind: "present" };
		}
		const initCount = m.isHtml && q.multi ? q.options.filter((o) => o.checked).length : 0;
		return m.method === "select" && m.selectedCount === initCount
			? { kind: "present" }
			: { kind: "fallback" };
	}
	const { answer, toggled } = state;
	const otherSent = state.otherSent === true;
	if (q.kind === "text") {
		return m.method === "input" || m.method === "editor"
			? { kind: "auto", value: answer.text ?? "", toggled }
			: { kind: "fallback" };
	}
	if (m.method === "input" || m.method === "editor") {
		const text =
			m.isHtml && q.multi
				? combinedMultiExtra(answer) || editorText(q, answer)
				: editorText(q, answer);
		return text
			? { kind: "auto", value: text, toggled, ...(m.isHtml && q.multi ? { otherSent: true } : {}) }
			: { kind: "fallback" };
	}
	if (m.method !== "select") return { kind: "fallback" };
	const custom = answer.custom.trim();
	if (!q.multi) {
		if (custom) {
			return m.otherOption
				? { kind: "auto", value: m.otherOption, toggled }
				: { kind: "fallback" };
		}
		const sel = answer.selected[0] ?? "";
		const note = sel ? answer.notes?.[sel]?.trim() : "";
		if (sel && note && m.otherOption) {
			return { kind: "auto", value: m.otherOption, toggled };
		}
		const raw = m.optionByLabel[sel];
		return raw ? { kind: "auto", value: raw, toggled } : { kind: "fallback" };
	}
	// Multi-select loop: our toggle bookkeeping must agree with omp's count.
	const countMatches =
		m.selectedCount === toggled.length ||
		(otherSent && m.selectedCount === toggled.length + 1);
	if (!countMatches) return { kind: "fallback" };
	const want = new Set(answer.selected);
	const flip =
		answer.selected.find((l) => !toggled.includes(l)) ??
		toggled.find((l) => !want.has(l));
	if (flip !== undefined) {
		const raw = m.optionByLabel[flip];
		if (!raw) return { kind: "fallback" };
		const next = toggled.includes(flip)
			? toggled.filter((l) => l !== flip)
			: [...toggled, flip];
		return { kind: "auto", value: raw, toggled: next, ...(otherSent ? { otherSent: true } : {}) };
	}
	const extra = combinedMultiExtra(answer);
	if (extra && !otherSent && m.otherOption) {
		return { kind: "auto", value: m.otherOption, toggled };
	}
	if (m.doneOption && (toggled.length > 0 || otherSent || m.isHtml)) {
		return { kind: "auto", value: m.doneOption, toggled, ...(otherSent ? { otherSent: true } : {}) };
	}
	return m.otherOption && !otherSent
		? { kind: "auto", value: m.otherOption, toggled }
		: { kind: "fallback" };
}

/** Compact Q→A pairs from an ask tool result's `details`. */
export function askResultSummary(
	details: unknown,
): { question: string; answer: string }[] | null {
	const d = asObj(details);
	if (Array.isArray(d.answers)) {
		const notes = Array.isArray(d.notes) ? d.notes.map(asObj) : [];
		const out: { question: string; answer: string }[] = [];
		for (const entry of d.answers) {
			const answer = asObj(entry);
			if (typeof answer.question !== "string" || typeof answer.answer !== "string") return null;
			const parts = [answer.answer];
			for (const note of notes) {
				if (typeof answer.name !== "string" || note.name !== answer.name ||
					typeof note.text !== "string" || !note.text.trim()) continue;
				parts.push(typeof note.option === "string" && note.option
					? `${note.option}: ${note.text}`
					: note.text);
			}
			out.push({ question: answer.question, answer: parts.filter(Boolean).join(" — ") });
		}
		return out.length ? out : null;
	}
	const list = Array.isArray(d.results) ? d.results : [d];
	const out: { question: string; answer: string }[] = [];
	for (const r0 of list) {
		const r = asObj(r0);
		if (typeof r.question !== "string") return null;
		const sel = Array.isArray(r.selectedOptions)
			? r.selectedOptions.filter((s): s is string => typeof s === "string")
			: [];
		const parts = [...sel];
		if (typeof r.customInput === "string" && r.customInput.trim())
			parts.push(r.customInput.trim());
		out.push({ question: r.question, answer: parts.join("、") });
	}
	return out.length ? out : null;
}

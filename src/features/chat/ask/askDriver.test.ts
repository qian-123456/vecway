// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	type AskDriverState,
	type AskSpec,
	askResultSummary,
	findOpenAsks,
	initialToggledForQuestion,
	matchRequest,
	OTHER_OPTION,
	parseAskArgs,
	resolveRequest,
	serializeFormData,
	unansweredQuestions,
	type AskAnswer,
} from "./askDriver";

const spec = (questions: unknown[]): AskSpec => {
	const s = parseAskArgs("call-1", { questions });
	if (!s) throw new Error("bad spec");
	return s;
};

const colour = {
	id: "c",
	question: "Pick a colour",
	options: [{ label: "Red" }, { label: "Blue", description: "calm" }],
	recommended: 1,
};
const langs = {
	id: "l",
	question: "Languages?",
	multi: true,
	options: [{ label: "TS" }, { label: "Rust" }, { label: "Go" }],
};
const DONE = "✓ Done selecting";

const select = (id: string, title: string, options: string[]) => ({
	type: "extension_ui_request",
	id,
	method: "select",
	title,
	options,
});

/** Drive a request through matchRequest + resolveRequest. */
function step(s: AskSpec, req: unknown, state?: AskDriverState) {
	const m = matchRequest(s, req);
	if (!m) return null;
	return resolveRequest(s.questions[m.qIndex], m, state);
}

describe("ask driver", () => {
	it("single-select answers with the decorated raw option", () => {
		const s = spec([colour]);
		const req = select("r1", "Pick a colour", ["Red", "Blue (Recommended)", OTHER_OPTION]);
		expect(step(s, req)).toEqual({ kind: "present" });
		const state = { answer: { selected: ["Blue"], custom: "" }, toggled: [] };
		expect(step(s, req, state)).toMatchObject({ kind: "auto", value: "Blue (Recommended)" });
	});

	it("Other goes through select then editor with the custom text", () => {
		const s = spec([colour]);
		const state = { answer: { selected: [], custom: " green " }, toggled: [] };
		const sel = select("r1", "Pick a colour", ["Red", "Blue (Recommended)", OTHER_OPTION]);
		expect(step(s, sel, state)).toMatchObject({ kind: "auto", value: OTHER_OPTION });
		const ed = { id: "r2", method: "editor", title: "Pick a colour" };
		expect(step(s, ed, state)).toMatchObject({ kind: "auto", value: "green" });
		// Editor without driver state (e.g. after reload) is not presentable.
		expect(step(s, ed)).toEqual({ kind: "fallback" });
	});

	it("multi-select toggles each label across re-sent selects, then Done", () => {
		const s = spec([langs]);
		let state: AskDriverState = {
			answer: { selected: ["TS", "Go"], custom: "" },
			toggled: [],
		};
		const values: string[] = [];
		let k = 0;
		for (let i = 0; i < 5; i++) {
			const title = k ? `(${k} selected) Languages?` : "Languages?";
			const opts = ["TS", "Rust", "Go", ...(k ? [DONE] : []), OTHER_OPTION];
			const r = step(s, select(`r${i}`, title, opts), state);
			if (r?.kind !== "auto") throw new Error(`unexpected ${r?.kind}`);
			values.push(r.value);
			if (r.value === DONE) break;
			state = { ...state, toggled: r.toggled };
			k = r.toggled.length;
		}
		expect(values).toEqual(["TS", "Go", DONE]);
	});

	it("multi-select falls back when omp's count disagrees with our toggles", () => {
		const s = spec([langs]);
		const req = select("r", "(2 selected) Languages?", ["TS", "Rust", "Go", DONE, OTHER_OPTION]);
		expect(step(s, req)).toEqual({ kind: "fallback" });
		const state = { answer: { selected: ["TS"], custom: "" }, toggled: [] };
		expect(step(s, req, state)).toEqual({ kind: "fallback" });
	});

	it("multi-question: indexes by (i/N) and ends multi loops via Other", () => {
		const s = spec([colour, langs]);
		const q1 = select("a", "Pick a colour (1/2)", ["Red", "Blue (Recommended)", OTHER_OPTION]);
		expect(matchRequest(s, q1)?.qIndex).toBe(0);
		const q2 = select("b", "(1 selected) Languages? (2/2)", ["TS", "Rust", "Go", OTHER_OPTION]);
		const m = matchRequest(s, q2);
		expect(m).toMatchObject({ qIndex: 1, total: 2, selectedCount: 1, doneOption: null });
		const state = { answer: { selected: ["Rust"], custom: "" }, toggled: ["Rust"] };
		expect(step(s, q2, state)).toMatchObject({ kind: "auto", value: OTHER_OPTION });
		const ed = { id: "c", method: "editor", title: "Languages? (2/2)" };
		expect(step(s, ed, state)).toMatchObject({ kind: "auto", value: "Selected: Rust" });
	});

	it("does not match unrelated or mismatched requests", () => {
		const s = spec([colour, langs]);
		expect(matchRequest(s, select("x", "Allow bash?", ["Allow", "Deny"]))).toBeNull();
		// Missing (i/N) suffix with N>1.
		expect(matchRequest(s, select("x", "Pick a colour", ["Red", "Blue", OTHER_OPTION]))).toBeNull();
		// Option set differs.
		expect(
			matchRequest(s, select("x", "Pick a colour (1/2)", ["Red", "Green", OTHER_OPTION])),
		).toBeNull();
		expect(matchRequest(s, { id: "x", method: "confirm", title: "Pick a colour (1/2)" })).toBeNull();
	});

	it("finds only unanswered ask calls, live first", () => {
		const args = { questions: [colour] };
		const items = [
			{ toolCalls: [{ id: "old", name: "ask", args, intent: null }], toolResult: null },
			{ toolCalls: [], toolResult: { toolCallId: "old" } },
			{ toolCalls: [{ id: "open", name: "ask", args, intent: null }], toolResult: null },
		] as never;
		const live = [{ toolCallId: "live", toolName: "ask", args, status: "running" }];
		expect(findOpenAsks(live, items).map((a) => a.toolCallId)).toEqual(["live", "open"]);
	});

	it("summarises single and multi-question results", () => {
		expect(
			askResultSummary({ question: "Q", selectedOptions: ["A", "B"], customInput: "c" }),
		).toEqual([{ question: "Q", answer: "A、B、c" }]);
		expect(askResultSummary({ results: [{ question: "Q1", selectedOptions: ["x"] }] })).toEqual([
			{ question: "Q1", answer: "x" },
		]);
		expect(askResultSummary({ foo: 1 })).toBeNull();
	});

	it("parses modern HTML forms into open ask specs", () => {
		const args = { html: '<form><label>Colour<input name="colour"></label></form>' };
		const parsed = parseAskArgs("modern", args);
		expect(parsed).toMatchObject({
			toolCallId: "modern",
			source: "html",
			questions: [{ id: "colour", question: "Colour", kind: "text", inputType: "text", multiline: false }],
		});
		expect(
			findOpenAsks([{ toolCallId: "modern", toolName: "ask", args, status: "running" }], []).map(
				(a) => a.toolCallId,
			),
		).toEqual(["modern"]);
	});

	it("summarises current form answers in order, preserving empty and multiline answers", () => {
		expect(askResultSummary({
			answers: [
				{ name: "db", question: "Database?", answer: "SQLite" },
				{ name: "notes", question: "Notes?", answer: "First line\nSecond line" },
				{ name: "optional", question: "Anything else?", answer: "" },
			],
		})).toEqual([
			{ question: "Database?", answer: "SQLite" },
			{ question: "Notes?", answer: "First line\nSecond line" },
			{ question: "Anything else?", answer: "" },
		]);
		expect(askResultSummary({ answers: [] })).toBeNull();
		expect(askResultSummary({ answers: [{ name: "bad", answer: "No question" }] })).toBeNull();
	});

	it("includes current option notes only with the field they belong to", () => {
		expect(askResultSummary({
			answers: [
				{ name: "stack", question: "Stack?", answer: "Rust, TypeScript" },
				{ name: "extra", question: "Extra?", answer: "" },
			],
			notes: [
				{ name: "stack", question: "Stack?", option: "Rust", value: "rs", text: "Backend only" },
				{ name: "stack", question: "Stack?", option: "TypeScript", value: "ts", text: "UI [Image #1]" },
				{ name: "extra", question: "Extra?", option: "Other", value: "other", text: "Keep this note" },
			],
		})).toEqual([
			{ question: "Stack?", answer: "Rust, TypeScript — Rust: Backend only — TypeScript: UI [Image #1]" },
			{ question: "Extra?", answer: "Other: Keep this note" },
		]);
	});

	it("replays a whole multi-question answer in order against omp's protocol", () => {
		const s = spec([colour, langs, { ...colour, id: "c2", question: "Second colour" }]);
		const answers: AskAnswer[] = [
			{ selected: ["Blue"], custom: "" },
			{ selected: ["Go", "TS"], custom: "only backend" },
			{ selected: [], custom: "teal" },
		];
		const { sent, results } = simulateOmp(s, answers);
		expect(sent).toEqual([
			"Blue (Recommended)",
			"Go",
			"TS",
			OTHER_OPTION,
			"Selected: Go, TS; note: only backend",
			OTHER_OPTION,
			"teal",
		]);
		expect(results).toEqual([
			{ selected: ["Blue"] },
			{ custom: "Selected: Go, TS; note: only backend" },
			{ custom: "teal" },
		]);
	});

	it("single-question multi ends with Done, or Other when submitted empty", () => {
		const s = spec([langs]);
		expect(simulateOmp(s, [{ selected: ["Rust"], custom: "" }]).results).toEqual([
			{ selected: ["Rust"] },
		]);
		expect(simulateOmp(s, [{ selected: [], custom: "" }]).results).toEqual([
			{ custom: "Selected: none" },
		]);
	});

	it("reports unanswered questions from the pending one onward", () => {
		const s = spec([colour, langs, colour]);
		const a: (AskAnswer | undefined)[] = [];
		a[1] = { selected: [], custom: "" };
		expect(unansweredQuestions(s, a, 0)).toEqual([0, 2]);
		expect(unansweredQuestions(s, a, 1)).toEqual([2]);
		a[2] = { selected: [], custom: "x" };
		expect(unansweredQuestions(s, a, 1)).toEqual([]);
	});

	it("parses complex HTML forms with fieldsets, context, radios, checkboxes, select, text and hidden fields", () => {
		const html = `
			<form>
				<input type="hidden" name="csrf" value="tok-1">
				<p>Global migration summary.</p>
				<fieldset>
					<legend>Database engine</legend>
					<p>Local sessions need fast embedded reads.</p>
					<ul><li>Zero external daemon</li><li>Single file backup</li></ul>
					<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
					<label><input type="radio" name="db" value="duckdb"> DuckDB</label>
					<label><input type="radio" name="db" value="disabled" disabled> Disabled</label>
				</fieldset>
				<fieldset>
					<legend>Optional features</legend>
					<pre>const enabled = true;</pre>
					<label><input type="checkbox" name="feat" value="auth" checked> Auth</label>
					<label><input type="checkbox" name="feat" value="sync"> Sync</label>
				</fieldset>
				<fieldset>
					<legend>Deployment</legend>
					<label>Region
						<select name="region">
							<option value="us">US East</option>
							<option value="eu" selected>EU West</option>
						</select>
					</label>
					<label for="port">Port</label>
					<input id="port" type="number" name="port" value="8080" placeholder="3000" required>
					<label>Notes <textarea name="notes" placeholder="Anything else">prefilled</textarea></label>
				</fieldset>
			</form>
		`;
		const parsed = parseAskArgs("html-1", { html });
		expect(parsed).not.toBeNull();
		expect(parsed?.source).toBe("html");
		expect(parsed?.hiddenFields).toEqual([["csrf", "tok-1"]]);
		expect(parsed?.questions).toHaveLength(5);

		const [db, feat, region, port, notes] = parsed!.questions;
		expect(db).toMatchObject({
			id: "db",
			kind: "choice",
			header: "Database engine",
			question: "Database engine",
			context: "Global migration summary.\n\nLocal sessions need fast embedded reads.\n\n- Zero external daemon\n- Single file backup",
			multi: false,
			recommended: 0,
			hasOther: true,
			options: [
				{ label: "SQLite", value: "sqlite", checked: true },
				{ label: "DuckDB", value: "duckdb" },
			],
		});
		expect(feat).toMatchObject({
			id: "feat",
			kind: "choice",
			question: "Optional features",
			context: "const enabled = true;",
			multi: true,
			hasOther: true,
			options: [
				{ label: "Auth", value: "auth", checked: true },
				{ label: "Sync", value: "sync" },
			],
		});
		expect(region).toMatchObject({
			id: "region",
			kind: "choice",
			header: "Deployment",
			question: "Region",
			multi: false,
			recommended: 1,
			hasOther: false,
			options: [
				{ label: "US East", value: "us" },
				{ label: "EU West", value: "eu", checked: true },
			],
		});
		expect(port).toMatchObject({
			id: "port",
			kind: "text",
			header: "Deployment",
			question: "Port",
			inputType: "number",
			value: "8080",
			placeholder: "3000",
			required: true,
			multiline: false,
		});
		expect(notes).toMatchObject({
			id: "notes",
			kind: "text",
			header: "Deployment",
			question: "Notes",
			inputType: "textarea",
			value: "prefilled",
			placeholder: "Anything else",
			multiline: true,
		});

		// Bare HTML string is also supported; empty forms return null.
		expect(parseAskArgs("bare", html)?.questions).toHaveLength(5);
		expect(parseAskArgs("empty", { html: "<form><p>No fields</p></form>" })).toBeNull();
	});

	it("sets hasOther false when a radio/checkbox group already includes an explicit Other option", () => {
		const parsed = parseAskArgs("explicit-other", {
			html: `<form><fieldset><legend>Mode</legend>
				<label><input type="radio" name="m" value="a"> Fast</label>
				<label><input type="radio" name="m" value="other"> Other</label>
			</fieldset></form>`,
		});
		expect(parsed?.questions[0].hasOther).toBe(false);
	});

	it("replays HTML field-by-field requests including per-option notes on radio, checkbox and text", () => {
		const html = `
			<form>
				<fieldset>
					<legend>Database</legend>
					<p>Choose embedded storage.</p>
					<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
					<label><input type="radio" name="db" value="duckdb"> DuckDB</label>
				</fieldset>
				<fieldset>
					<legend>Features</legend>
					<label><input type="checkbox" name="feat" value="auth" checked> Auth</label>
					<label><input type="checkbox" name="feat" value="sync"> Sync</label>
				</fieldset>
				<label>Notes <textarea name="notes"></textarea></label>
			</form>
		`;
		const parsed = parseAskArgs("html-replay", { html })!;
		const [dbQ, featQ, notesQ] = parsed.questions;

		// 1. Radio with per-option note goes via Other -> input with "Label — note"
		const dbSelect = {
			id: "r1",
			method: "select",
			selectionMarker: "radio",
			title: "Database\n\nChoose embedded storage.",
			options: ["SQLite", "DuckDB", OTHER_OPTION],
		};
		expect(step(parsed, dbSelect)).toEqual({ kind: "present" });
		const dbState: AskDriverState = {
			answer: { selected: ["SQLite"], custom: "", notes: { SQLite: "WAL mode" } },
			toggled: [],
		};
		expect(step(parsed, dbSelect, dbState)).toMatchObject({ kind: "auto", value: OTHER_OPTION });
		const dbInput = { id: "r2", method: "input", title: "Database\n\nChoose embedded storage." };
		expect(step(parsed, dbInput, dbState)).toMatchObject({ kind: "auto", value: "SQLite — WAL mode" });

		// 2. Checkbox with pre-checked Auth + newly checked Sync + note on Sync -> Other -> input -> loop back -> Done
		const featInitialReq = {
			id: "r3",
			method: "select",
			selectionMarker: "checkbox",
			title: "(1 selected) Features",
			options: ["Auth", "Sync", OTHER_OPTION, DONE],
			checkedIndices: [0],
		};
		expect(step(parsed, featInitialReq)).toEqual({ kind: "present" });
		let featState: AskDriverState = {
			answer: { selected: ["Auth", "Sync"], custom: "plus offline", notes: { Sync: "via iCloud" } },
			toggled: initialToggledForQuestion(parsed, featQ),
		};
		expect(featState.toggled).toEqual(["Auth"]);

		const step1 = step(parsed, featInitialReq, featState);
		expect(step1).toMatchObject({ kind: "auto", value: "Sync", toggled: ["Auth", "Sync"] });
		if (step1?.kind !== "auto") throw new Error("expected auto step");
		featState = { ...featState, toggled: step1.toggled };
		const featStep2Req = {
			id: "r4",
			method: "select",
			selectionMarker: "checkbox",
			title: "(2 selected) Features",
			options: ["Auth", "Sync", OTHER_OPTION, DONE],
			checkedIndices: [0, 1],
		};
		const step2 = step(parsed, featStep2Req, featState);
		expect(step2).toMatchObject({ kind: "auto", value: OTHER_OPTION });

		const featInputReq = { id: "r5", method: "input", title: "Features" };
		const step3 = step(parsed, featInputReq, featState);
		expect(step3).toMatchObject({
			kind: "auto",
			value: "Sync: via iCloud; plus offline",
			otherSent: true,
		});
		featState = { ...featState, otherSent: true };

		// OMP loops back to select with Other counted as selected (3 selected)
		const featLoopBackReq = {
			id: "r6",
			method: "select",
			selectionMarker: "checkbox",
			title: "(3 selected) Features",
			options: ["Auth", "Sync", OTHER_OPTION, DONE],
			checkedIndices: [0, 1, 2],
		};
		const step4 = step(parsed, featLoopBackReq, featState);
		expect(step4).toMatchObject({ kind: "auto", value: DONE });

		// 3. Text question presents when no state, and auto-answers (including empty string) when state exists
		const notesReq = { id: "r7", method: "editor", title: "Notes" };
		expect(step(parsed, notesReq)).toEqual({ kind: "present" });
		expect(step(parsed, notesReq, { answer: { selected: [], custom: "", text: "" }, toggled: [] })).toMatchObject({
			kind: "auto",
			value: "",
		});
		expect(
			step(parsed, notesReq, { answer: { selected: [], custom: "", text: "Ship it" }, toggled: [] }),
		).toMatchObject({ kind: "auto", value: "Ship it" });
		expect(dbQ.hasOther).toBe(true);
		expect(notesQ.multiline).toBe(true);
	});

	it("matches direct method:form requests and serializes form data with notes and types", () => {
		const html = `
			<form>
				<input type="hidden" name="ver" value="2">
				<fieldset>
					<legend>DB</legend>
					<label><input type="radio" name="db" value="sqlite"> SQLite</label>
					<label><input type="radio" name="db" value="pg"> Postgres</label>
				</fieldset>
				<fieldset>
					<legend>Tags</legend>
					<label><input type="checkbox" name="tags" value="a"> Alpha</label>
					<label><input type="checkbox" name="tags" value="b"> Beta</label>
				</fieldset>
				<label>Port <input type="number" name="port"></label>
			</form>
		`;
		const parsed = parseAskArgs("form-call", { html })!;
		const req = { id: "f1", method: "form", html };
		const m = matchRequest(parsed, req);
		expect(m).toMatchObject({ requestId: "f1", method: "form", qIndex: 0, total: 3 });
		expect(resolveRequest(parsed.questions[0], m!, undefined)).toEqual({ kind: "present" });

		expect(
			serializeFormData(parsed, [
				{ selected: ["SQLite"], custom: "", notes: { SQLite: "embedded" } },
				{ selected: ["Alpha", "Beta"], custom: "", notes: { Beta: "experimental" } },
				{ selected: [], custom: "", text: "5432" },
			]),
		).toEqual({
			ver: "2",
			db: "SQLite — embedded",
			tags: ["a", "b", "Beta: experimental"],
			port: 5432,
		});
	});
});

/** Minimal model of omp's RPC ask flow driven by the driver's responses. */
function simulateOmp(s: AskSpec, answers: AskAnswer[]) {
	const n = s.questions.length;
	const states = new Map<number, AskDriverState>(
		answers.map((answer, i) => [i, { answer, toggled: [] }]),
	);
	const sent: string[] = [];
	const results: { selected?: string[]; custom?: string }[] = [];
	let seq = 0;
	const ask = (req: Record<string, unknown>): string => {
		const m = matchRequest(s, { id: `r${seq++}`, ...req });
		if (!m) throw new Error(`unmatched ${JSON.stringify(req)}`);
		const st = states.get(m.qIndex);
		const r = resolveRequest(s.questions[m.qIndex], m, st);
		if (r.kind !== "auto") throw new Error(`driver stalled on ${JSON.stringify(req)}`);
		if (st) states.set(m.qIndex, { ...st, toggled: r.toggled });
		sent.push(r.value);
		return r.value;
	};
	s.questions.forEach((q, i) => {
		const suffix = n > 1 ? ` (${i + 1}/${n})` : "";
		const labels = q.options.map((o, j) => (j === q.recommended ? `${o.label} (Recommended)` : o.label));
		const other = () => {
			results.push({ custom: ask({ method: "editor", title: q.question + suffix }) });
		};
		if (!q.multi) {
			const v = ask({ method: "select", title: q.question + suffix, options: [...labels, OTHER_OPTION] });
			if (v === OTHER_OPTION) other();
			else results.push({ selected: [v.replace(" (Recommended)", "")] });
			return;
		}
		const chosen: string[] = [];
		for (let guard = 0; guard < 20; guard++) {
			const k = chosen.length;
			const title = `${k ? `(${k} selected) ` : ""}${q.question}${suffix}`;
			const done = k > 0 && n === 1 ? ["✓ Done selecting"] : [];
			const v = ask({ method: "select", title, options: [...labels, ...done, OTHER_OPTION] });
			if (v === OTHER_OPTION) return other();
			if (done.includes(v)) return results.push({ selected: chosen });
			const l = v.replace(" (Recommended)", "");
			const at = chosen.indexOf(l);
			if (at >= 0) chosen.splice(at, 1);
			else chosen.push(l);
		}
		throw new Error("multi loop did not finish");
	});
	return { sent, results };
}

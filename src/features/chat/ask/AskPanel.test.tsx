// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingUiRequest } from "../../../lib/contracts";
import { emptySessionLive, useLive } from "../../../stores/live";
import { OTHER_OPTION, parseAskArgs, type AskAnswer } from "./askDriver";

const rpcUiRespond = vi.fn();
vi.mock("../../../lib/ipc", () => ({
	rpcUiRespond: (...a: unknown[]) => rpcUiRespond(...a),
}));
vi.mock("../../../lib/toast", () => ({ toast: { error: vi.fn() } }));

import { AskPanel, pruneAskState, useAskRouting } from "./AskPanel";

const SID = "ask-recovery";
const req = {
	sessionId: SID,
	receivedAt: "",
	request: {
		type: "extension_ui_request",
		id: "r1",
		method: "select",
		title: "Pick a colour",
		options: ["Red", "Blue", "Other (type your own)"],
	},
};

beforeEach(() => {
	pruneAskState([SID, "html-sid", "form-sid"]);
	rpcUiRespond.mockReset();
	useLive.setState({
		sessions: {
			[SID]: {
				...emptySessionLive(),
				tools: {
					t1: {
						toolCallId: "t1",
						toolName: "ask",
						status: "running",
						intent: null,
						text: "",
						details: null,
						args: {
							questions: [
								{ id: "c", question: "Pick a colour", options: [{ label: "Red" }, { label: "Blue" }] },
							],
						},
					},
				},
			},
		},
	});
});

afterEach(cleanup);

describe("useAskRouting", () => {
	it("recovers after a failed submit so the next submit is sent again", async () => {
		rpcUiRespond.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
		const { result } = renderHook(() => useAskRouting(SID, [req]));
		expect(result.current.route?.resolution.kind).toBe("present");

		act(() => result.current.submit([{ selected: ["Red"], custom: "" }]));
		await waitFor(() => expect(rpcUiRespond).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(result.current.route?.resolution.kind).toBe("present"));

		act(() => result.current.submit([{ selected: ["Red"], custom: "" }]));
		await waitFor(() => expect(rpcUiRespond).toHaveBeenCalledTimes(2));
	});

	it("releases the composer as soon as the final answer is accepted", async () => {
		pruneAskState([SID]);
		rpcUiRespond.mockResolvedValue(undefined);
		const { result } = renderHook(() => useAskRouting(SID, [req]));
		act(() => result.current.submit([{ selected: ["Red"], custom: "" }]));
		await waitFor(() => expect(rpcUiRespond).toHaveBeenCalledTimes(1));
		// Well under the 4s fallback timer.
		await waitFor(() => expect(result.current.awaiting).toBe(false), { timeout: 1000 });
	});

	it("routes HTML form tool calls and replays option notes via Other -> input", async () => {
		const sid = "html-sid";
		const html = `
			<form>
				<fieldset>
					<legend>Storage</legend>
					<p>Choose persistence backend.</p>
					<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
					<label><input type="radio" name="db" value="pg"> Postgres</label>
				</fieldset>
			</form>
		`;
		useLive.setState({
			sessions: {
				[sid]: {
					...emptySessionLive(),
					tools: {
						tHtml: {
							toolCallId: "tHtml",
							toolName: "ask",
							status: "running",
							intent: null,
							text: "",
							details: null,
							args: { html },
						},
					},
				},
			},
		});
		rpcUiRespond.mockResolvedValue(undefined);
		const selectReq = {
			sessionId: sid,
			receivedAt: "",
			request: {
				type: "extension_ui_request",
				id: "hr1",
				method: "select",
				selectionMarker: "radio",
				title: "Storage\n\nChoose persistence backend.",
				options: ["SQLite", "Postgres", OTHER_OPTION],
			},
		};
		const { result, rerender } = renderHook(
			({ pending }: { pending: PendingUiRequest[] }) => useAskRouting(sid, pending),
			{ initialProps: { pending: [selectReq] as PendingUiRequest[] } },
		);
		expect(result.current.route?.resolution.kind).toBe("present");

		act(() =>
			result.current.submit([
				{ selected: ["SQLite"], custom: "", notes: { SQLite: "WAL mode" } },
			]),
		);
		await waitFor(() =>
			expect(rpcUiRespond).toHaveBeenCalledWith(sid, { id: "hr1", value: OTHER_OPTION }),
		);

		const inputReq = {
			sessionId: sid,
			receivedAt: "",
			request: {
				type: "extension_ui_request",
				id: "hr2",
				method: "input",
				title: "Storage\n\nChoose persistence backend.",
			},
		};
		rerender({ pending: [inputReq] });
		await waitFor(() =>
			expect(rpcUiRespond).toHaveBeenCalledWith(sid, { id: "hr2", value: "SQLite — WAL mode" }),
		);
	});

	it("replays HTML multi-select with per-option notes through Other -> input -> Done without looping", async () => {
		const sid = "html-sid";
		const html = `
			<form>
				<fieldset>
					<legend>Features</legend>
					<label><input type="checkbox" name="feat" value="auth" checked> Auth</label>
					<label><input type="checkbox" name="feat" value="sync"> Sync</label>
				</fieldset>
			</form>
		`;
		useLive.setState({
			sessions: {
				[sid]: {
					...emptySessionLive(),
					tools: {
						tMulti: {
							toolCallId: "tMulti",
							toolName: "ask",
							status: "running",
							intent: null,
							text: "",
							details: null,
							args: { html },
						},
					},
				},
			},
		});
		rpcUiRespond.mockResolvedValue(undefined);
		const done = "✓ Done selecting";
		const mkSelect = (id: string, title: string, checkedIndices: number[]) => ({
			sessionId: sid,
			receivedAt: "",
			request: {
				type: "extension_ui_request",
				id,
				method: "select",
				selectionMarker: "checkbox",
				title,
				options: ["Auth", "Sync", OTHER_OPTION, done],
				checkedIndices,
			},
		});
		const { result, rerender } = renderHook(
			({ pending }: { pending: PendingUiRequest[] }) => useAskRouting(sid, pending),
			{ initialProps: { pending: [mkSelect("m1", "(1 selected) Features", [0])] as PendingUiRequest[] } },
		);
		expect(result.current.route?.resolution.kind).toBe("present");

		act(() =>
			result.current.submit([
				{ selected: ["Auth", "Sync"], custom: "", notes: { Sync: "via iCloud" } },
			]),
		);
		await waitFor(() => expect(rpcUiRespond).toHaveBeenCalledWith(sid, { id: "m1", value: "Sync" }));

		rerender({ pending: [mkSelect("m2", "(2 selected) Features", [0, 1])] });
		await waitFor(() =>
			expect(rpcUiRespond).toHaveBeenCalledWith(sid, { id: "m2", value: OTHER_OPTION }),
		);

		rerender({
			pending: [
				{
					sessionId: sid,
					receivedAt: "",
					request: { type: "extension_ui_request", id: "m3", method: "input", title: "Features" },
				},
			],
		});
		await waitFor(() =>
			expect(rpcUiRespond).toHaveBeenCalledWith(sid, { id: "m3", value: "Sync: via iCloud" }),
		);

		rerender({ pending: [mkSelect("m4", "(3 selected) Features", [0, 1, 2])] });
		await waitFor(() => expect(rpcUiRespond).toHaveBeenCalledWith(sid, { id: "m4", value: done }));
	});

	it("handles direct method:form RPC requests and submits { id, data } in one shot", async () => {
		const sid = "form-sid";
		const html = `
			<form>
				<input type="hidden" name="v" value="1">
				<fieldset>
					<legend>Mode</legend>
					<label><input type="radio" name="mode" value="fast"> Fast</label>
					<label><input type="radio" name="mode" value="safe"> Safe</label>
				</fieldset>
			</form>
		`;
		useLive.setState({ sessions: { [sid]: emptySessionLive() } });
		rpcUiRespond.mockResolvedValue(undefined);
		const formReq = {
			sessionId: sid,
			receivedAt: "",
			request: {
				type: "extension_ui_request",
				id: "f-direct",
				method: "form",
				html,
			},
		};
		const { result } = renderHook(() => useAskRouting(sid, [formReq]));
		expect(result.current.route?.resolution.kind).toBe("present");
		expect(result.current.route?.spec.questions[0].question).toBe("Mode");

		act(() => result.current.submit([{ selected: ["Safe"], custom: "" }]));
		await waitFor(() =>
			expect(rpcUiRespond).toHaveBeenCalledWith(sid, {
				id: "f-direct",
				data: { v: "1", mode: "safe" },
			}),
		);
	});
});

describe("AskPanel", () => {
	const multiFormHtml = `
		<form>
			<fieldset>
				<legend>Database</legend>
				<p>Pick local storage engine.</p>
				<label><input type="radio" name="db" value="sqlite"> SQLite</label>
				<label><input type="radio" name="db" value="duckdb"> DuckDB</label>
			</fieldset>
			<fieldset>
				<legend>Features</legend>
				<label><input type="checkbox" name="feat" value="auth"> Auth</label>
				<label><input type="checkbox" name="feat" value="sync"> Sync</label>
			</fieldset>
			<label>Extra details <textarea name="details" required placeholder="Explain requirements"></textarea></label>
		</form>
	`;

	it("does not auto-advance on click, supports explicit 上一步/下一步/提交 and per-option notes", () => {
		const spec = parseAskArgs("ui-1", { html: multiFormHtml })!;
		const submitted: (readonly (AskAnswer | undefined)[])[] = [];
		render(
			<AskPanel
				spec={spec}
				startIndex={0}
				busy={false}
				onSubmit={(a) => submitted.push(a)}
				onCancel={vi.fn()}
			/>,
		);

		// Context is visible above options and numbered badges 1, 2 are shown.
		expect(screen.getByText("Pick local storage engine.")).toBeTruthy();
		expect(screen.getByText("1")).toBeTruthy();
		expect(screen.getByText("2")).toBeTruthy();

		// Clicking an option selects it and stays on Question 1 (no auto-advance).
		fireEvent.click(screen.getByText("SQLite"));
		expect(screen.getByText("Database")).toBeTruthy();
		expect(screen.queryByText("Features")).toBeNull();

		// Typing into the selected option's inline note input preserves both option and note.
		const noteInput = screen.getByLabelText("SQLite 补充说明") as HTMLInputElement;
		fireEvent.change(noteInput, { target: { value: "use WAL mode" } });
		// Typing digits inside the note input must NOT trigger keyboard 1-9 shortcuts.
		fireEvent.keyDown(noteInput, { key: "2" });
		expect(screen.getByText("Database")).toBeTruthy();
		expect(screen.queryByLabelText("DuckDB 补充说明")).toBeNull();
		expect((screen.getByLabelText("SQLite 补充说明") as HTMLInputElement).value).toBe(
			"use WAL mode",
		);
		// Explicit 下一步 advances to Question 2.
		fireEvent.click(screen.getByRole("button", { name: "下一步" }));
		expect(screen.getByText("Features")).toBeTruthy();

		// Keyboard shortcut "1" and "2" toggle checkboxes without advancing.
		const panel = screen.getByText("Features").closest("[tabindex]")!;
		fireEvent.keyDown(panel, { key: "1" });
		fireEvent.keyDown(panel, { key: "2" });
		expect(screen.getByText("Features")).toBeTruthy();
		const syncNote = screen.getByLabelText("Sync 补充说明");
		fireEvent.change(syncNote, { target: { value: "background only" } });

		// Explicit 上一步 goes back and preserves Question 1 selection and note.
		fireEvent.click(screen.getByRole("button", { name: "上一步" }));
		expect((screen.getByLabelText("SQLite 补充说明") as HTMLInputElement).value).toBe(
			"use WAL mode",
		);

		// Advance to Question 3 (required textarea).
		fireEvent.click(screen.getByRole("button", { name: "下一步" }));
		fireEvent.click(screen.getByRole("button", { name: "下一步" }));
		const submitBtn = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(true);

		const textarea = screen.getByPlaceholderText("Explain requirements");
		// Plain Enter inside textarea does NOT submit.
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(submitted).toHaveLength(0);

		fireEvent.change(textarea, { target: { value: "Ship on Friday" } });
		expect(submitBtn.disabled).toBe(false);
		fireEvent.click(submitBtn);

		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toEqual([
			{ selected: ["SQLite"], custom: "", notes: { SQLite: "use WAL mode" } },
			{ selected: ["Auth", "Sync"], custom: "", notes: { Sync: "background only" } },
			{ selected: [], custom: "", text: "Ship on Friday" },
		]);
	});

	it("clicking add-note on an unselected option selects it, Escape blurs then collapses without cancelling, and skip cancels explicitly", () => {
		const spec = parseAskArgs("ui-2", {
			html: `<form><fieldset><legend>Env</legend>
				<label><input type="radio" name="env" value="dev"> Dev</label>
				<label><input type="radio" name="env" value="prod"> Prod</label>
			</fieldset></form>`,
		})!;
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		render(
			<AskPanel
				spec={spec}
				startIndex={0}
				busy={false}
				hasComposerDraft
				onSubmit={onSubmit}
				onCancel={onCancel}
			/>,
		);

		expect(screen.getByText("输入框中的草稿已保留，回答问题后可继续发送")).toBeTruthy();

		// Click the second option's "备注" button -> selects Prod and focuses its inline note input.
		const addNoteButtons = screen.getAllByRole("button", { name: "备注" });
		fireEvent.click(addNoteButtons[1]);
		const prodNote = screen.getByLabelText("Prod 补充说明");
		expect(document.activeElement).toBe(prodNote);
		fireEvent.change(prodNote, { target: { value: "canary first" } });

		// First Escape inside note input blurs back to panel without cancelling.
		fireEvent.keyDown(prodNote, { key: "Escape" });
		expect(onCancel).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();

		// Second Escape when panel has focus collapses the panel without cancelling.
		const panel = screen.getByText("Env").closest("[tabindex]") as HTMLElement;
		panel.focus();
		fireEvent.keyDown(panel, { key: "Escape" });
		expect(onCancel).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "展开继续回答" })).toBeTruthy();

		// Expanding restores state cleanly.
		fireEvent.click(screen.getByRole("button", { name: "展开继续回答" }));
		expect((screen.getByLabelText("Prod 补充说明") as HTMLInputElement).value).toBe("canary first");

		// Submit preserves Prod + note.
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(onSubmit).toHaveBeenCalledWith([
			{ selected: ["Prod"], custom: "", notes: { Prod: "canary first" } },
		]);

		// Cancelling requires clicking the explicit skip button.
		fireEvent.click(screen.getByRole("button", { name: "跳过此问题" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingUiRequest } from "../../lib/contracts";

const h = vi.hoisted(() => ({
	respond: vi.fn(),
	allowedTools: vi.fn(),
	dismiss: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({
	rpcUiRespond: h.respond,
	allowedToolsList: h.allowedTools,
}));
vi.mock("../../lib/hooks", () => ({
	isComposing: (event: { nativeEvent?: { isComposing?: boolean } }) => event.nativeEvent?.isComposing === true,
}));
vi.mock("../../lib/dialogs", () => ({ errMsg: (error: unknown) => String(error) }));
vi.mock("../../lib/toast", () => ({ toast: { error: h.toastError } }));
vi.mock("../../stores/live", () => ({
	useLive: (select: (state: { dismissUi: typeof h.dismiss }) => unknown) => select({ dismissUi: h.dismiss }),
}));

import { tNow } from "../../stores/language";
import { PendingUiCard } from "./PendingUiCard";

const request = (fields: Record<string, unknown>, receivedAt = "2026-11-17T00:00:00Z"): PendingUiRequest => ({
	sessionId: "session",
	receivedAt,
	request: { type: "extension_ui_request", id: "request-1", ...fields },
});
const submit = () => screen.getByRole("button", { name: tNow("chatView.pendingUi.submit") });
const textbox = () => screen.getByRole("textbox") as HTMLTextAreaElement;

beforeEach(() => {
	vi.clearAllMocks();
	h.respond.mockResolvedValue(undefined);
	h.allowedTools.mockResolvedValue([]);
});
afterEach(cleanup);

describe("modern ask RPC fallback", () => {
	it("shows multiline context, radio preselection and aligned details without changing raw answers", async () => {
		const title = "Migration context\nKeep existing data.\n\nWhich database?";
		const req = request({
			method: "select", title,
			options: ["SQLite", "Postgres", "Other (type your own)"],
			selectionMarker: "radio", initialIndex: 1,
			optionDetails: [{}, { description: "Managed service\nRequires credentials" }, {}],
		});
		render(<PendingUiCard sessionId="session" req={req} />);
		const heading = screen.getByText(/Migration context/);
		expect(heading.textContent).toBe(title);
		expect(heading.className).toContain("whitespace-pre-wrap");
		const radio = screen.getByRole("radio", { name: /Postgres/ });
		expect(radio.getAttribute("aria-checked")).toBe("true");
		expect(document.activeElement).toBe(radio);
		expect(screen.getByRole("radio", { name: "SQLite" }).getAttribute("aria-checked")).toBe("false");
		expect(screen.getByText(/Managed service/).textContent).toBe("Managed service\nRequires credentials");
		fireEvent.click(radio);
		await waitFor(() => expect(h.respond).toHaveBeenCalledWith("session", { id: "request-1", value: "Postgres" }));
		expect(h.dismiss).toHaveBeenCalledWith("session", "request-1");
	});

	it("sends one exact checkbox toggle per frame and leaves Done as an unmarked action", async () => {
		const options = ["TypeScript", "Rust", "Other (type your own)", "✓ Done selecting"];
		const frame = (id: string, checkedIndices: number[]) => request({
			id, method: "select", title: `Project context\n\n(${checkedIndices.length} selected) Languages?`,
			options, selectionMarker: "checkbox", checkedIndices, markableCount: 3, initialIndex: 0,
		});
		const view = render(<PendingUiCard sessionId="session" req={frame("check-1", [0])} />);
		expect(screen.getAllByRole("checkbox")).toHaveLength(3);
		expect(screen.getByRole("checkbox", { name: "TypeScript" }).getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("button", { name: "✓ Done selecting" }).hasAttribute("aria-checked")).toBe(false);
		fireEvent.click(screen.getByRole("checkbox", { name: "TypeScript" }));
		await waitFor(() => expect(h.respond).toHaveBeenCalledTimes(1));
		expect(h.respond).toHaveBeenLastCalledWith("session", { id: "check-1", value: "TypeScript" });
		// No client-owned bulk selection or optimistic toggle: the next RPC frame is authoritative.
		expect(screen.getByRole("checkbox", { name: "TypeScript" }).getAttribute("aria-checked")).toBe("true");
		view.rerender(<PendingUiCard sessionId="session" req={frame("check-2", [])} />);
		expect(screen.getByRole("checkbox", { name: "TypeScript" }).getAttribute("aria-checked")).toBe("false");
		fireEvent.click(screen.getByRole("checkbox", { name: "Rust" }));
		await waitFor(() => expect(h.respond).toHaveBeenLastCalledWith("session", { id: "check-2", value: "Rust" }));
		view.rerender(<PendingUiCard sessionId="session" req={frame("check-3", [1])} />);
		expect(screen.getByRole("checkbox", { name: "Rust" }).getAttribute("aria-checked")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "✓ Done selecting" }));
		await waitFor(() => expect(h.respond).toHaveBeenLastCalledWith("session", { id: "check-3", value: "✓ Done selecting" }));
	});

	it("keeps Other raw and accepts its following custom-input request", async () => {
		const view = render(<PendingUiCard sessionId="session" req={request({
			method: "select", title: "Choose one", selectionMarker: "radio",
			options: ["SQLite", "Other (type your own)"],
		})} />);
		fireEvent.click(screen.getByRole("radio", { name: "Other (type your own)" }));
		await waitFor(() => expect(h.respond).toHaveBeenCalledWith("session", { id: "request-1", value: "Other (type your own)" }));
		view.rerender(<PendingUiCard sessionId="session" req={request({ id: "other-input", method: "input", title: "Choose one" })} />);
		fireEvent.change(textbox(), { target: { value: "  Custom database  " } });
		fireEvent.keyDown(textbox(), { key: "Enter" });
		await waitFor(() => expect(h.respond).toHaveBeenLastCalledWith("session", { id: "other-input", value: "  Custom database  " }));
	});

	it("does not mistake permission-related form questions for approval", async () => {
		render(<PendingUiCard sessionId="session" req={request({
			method: "select", title: "Approve this proposal?", selectionMarker: "radio", options: ["Approve", "Deny"],
		})} />);
		expect(screen.queryByRole("button", { name: tNow("chatView.pendingUi.allowOnce") })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: tNow("chatView.pendingUi.cancel") }));
		await waitFor(() => expect(h.respond).toHaveBeenCalledWith("session", { id: "request-1", cancelled: true }));
	});

	it.each(["input", "editor"])("accepts a custom %s answer without inferring required from context", async (method) => {
		render(<PendingUiCard sessionId="session" req={request({ method, title: "Allow remote access?\n\nRequired follow-up?" })} />);
		expect(screen.queryByRole("button", { name: tNow("chatView.pendingUi.allowOnce") })).toBeNull();
		fireEvent.change(textbox(), { target: { value: "My answer\nWith detail" } });
		fireEvent.keyDown(textbox(), { key: "Enter", ctrlKey: method === "editor" });
		await waitFor(() => expect(h.respond).toHaveBeenCalledWith("session", { id: "request-1", value: "My answer\nWith detail" }));
	});

	it.each([
		["prefill", "First line\nSecond line"],
		["value", "Current value"],
		["default", "Default answer"],
		["defaultValue", "Historical default"],
	])("presents and submits the %s value", async (field, value) => {
		render(<PendingUiCard sessionId="session" req={request({ method: "editor", title: "Details", [field]: value })} />);
		expect(textbox().value).toBe(value);
		fireEvent.click(submit());
		await waitFor(() => expect(h.respond).toHaveBeenCalledWith("session", { id: "request-1", value }));
	});

	it("lets the user clear a prefilled answer and leaves form validation to OMP", async () => {
		render(<PendingUiCard sessionId="session" req={request({ method: "editor", title: "Notes (Required)", prefill: "Existing", default: "Not a fallback" })} />);
		fireEvent.change(textbox(), { target: { value: "" } });
		fireEvent.click(submit());
		await waitFor(() => expect(h.respond).toHaveBeenCalledWith("session", { id: "request-1", value: "" }));
	});

	it.each(["input", "editor"])("cancels %s without confirmation or an answer", async (method) => {
		render(<PendingUiCard sessionId="session" req={request({ method, title: "Allow additional details?", prefill: "Do not submit" })} />);
		fireEvent.keyDown(textbox(), { key: "Escape" });
		await waitFor(() => expect(h.respond).toHaveBeenCalledTimes(1));
		expect(h.respond).toHaveBeenCalledWith("session", { id: "request-1", cancelled: true });
	});

	it("cancels a select using Escape", async () => {
		render(<PendingUiCard sessionId="session" req={request({ method: "select", title: "Choose", options: ["One"] })} />);
		fireEvent.keyDown(screen.getByRole("button", { name: "One" }), { key: "Escape" });
		await waitFor(() => expect(h.respond).toHaveBeenCalledWith("session", { id: "request-1", cancelled: true }));
	});

	it("resets text and busy state for a sequential request before the previous send settles", async () => {
		// Executor form is required by this project's ES2021 library (no Promise.withResolvers).
		let release!: () => void;
		h.respond.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
		const view = render(<PendingUiCard sessionId="session" req={request({ method: "input", title: "First" })} />);
		fireEvent.change(textbox(), { target: { value: "Previous answer" } });
		fireEvent.click(submit());
		view.rerender(<PendingUiCard sessionId="session" req={request({ id: "next", method: "editor", title: "Second", prefill: "Next default" })} />);
		expect(textbox().value).toBe("Next default");
		expect((submit() as HTMLButtonElement).disabled).toBe(false);
		release();
		await waitFor(() => expect(h.dismiss).toHaveBeenCalledWith("session", "request-1"));
		expect(textbox().value).toBe("Next default");
	});

	it("preserves a same-request draft but resets when switching sessions", () => {
		const fields = { method: "input", title: "Details", value: "Initial" };
		const view = render(<PendingUiCard sessionId="session" req={request(fields)} />);
		fireEvent.change(textbox(), { target: { value: "Unsaved draft" } });
		view.rerender(<PendingUiCard sessionId="session" req={request(fields)} />);
		expect(textbox().value).toBe("Unsaved draft");
		view.rerender(<PendingUiCard sessionId="another-session" req={{ ...request(fields), sessionId: "another-session" }} />);
		expect(textbox().value).toBe("Initial");
	});

	it.each(["input", "editor"])("cancels %s with the visible cancel action", async (method) => {
		render(<PendingUiCard sessionId="session" req={request({ method, title: "Allow extra notes?", prefill: "Not an answer" })} />);
		fireEvent.click(screen.getByRole("button", { name: tNow("chatView.pendingUi.cancel") }));
		await waitFor(() => expect(h.respond).toHaveBeenCalledWith("session", { id: "request-1", cancelled: true }));
	});

	it("resets a recovered request even when a new process reuses its request id", () => {
		const view = render(<PendingUiCard sessionId="session" req={request({ method: "input", title: "First" })} />);
		fireEvent.change(textbox(), { target: { value: "Stale draft" } });
		view.rerender(<PendingUiCard sessionId="session" req={request({ method: "input", title: "Recovered", value: "Recovered value" }, "2026-11-17T00:01:00Z")} />);
		expect(textbox().value).toBe("Recovered value");
	});

	it("shows supplied text literally instead of rendering arbitrary HTML", () => {
		const title = '<script>alert("not HTML")</script>\n\nQuestion?';
		const view = render(<PendingUiCard sessionId="session" req={request({ method: "input", title, placeholder: "Custom answer" })} />);
		expect(screen.getByText(/not HTML/).textContent).toBe(title);
		expect(view.container.querySelector("script")).toBeNull();
		expect(textbox().placeholder).toBe("Custom answer");
	});
});

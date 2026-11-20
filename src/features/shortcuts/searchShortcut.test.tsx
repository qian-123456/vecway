// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useTypeToFocus } from "../chat/useTypeToFocus";
import { focusAndSelect, focusDeferred, useSlashSearch } from "./searchShortcut";

afterEach(cleanup);

function PageHost({ enabled = true }: { enabled?: boolean }) {
	const inputRef = useRef<HTMLInputElement>(null);
	useSlashSearch(() => focusAndSelect(inputRef.current), { tier: "page", enabled });
	return (
		<div>
			<button type="button">page-btn</button>
			<input ref={inputRef} aria-label="page-search" defaultValue="abc" />
		</div>
	);
}

function CollapsiblePanelHost() {
	const panelRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	useSlashSearch(
		() => {
			setOpen(true);
			focusDeferred(inputRef);
		},
		{ tier: "panel", scopeRef: panelRef },
	);
	return (
		<div ref={panelRef} tabIndex={-1} data-slash-panel="" data-testid="right-panel">
			<span>panel-text</span>
			{open && <input ref={inputRef} aria-label="panel-search" />}
		</div>
	);
}

function ChatHarness() {
	const taRef = useRef<HTMLTextAreaElement>(null);
	useTypeToFocus(taRef, false, true);
	return (
		<div data-session-view="">
			<div data-testid="chat-stream" tabIndex={-1}>
				messages
			</div>
			<textarea ref={taRef} aria-label="chat-composer" />
		</div>
	);
}

describe("useSlashSearch", () => {
	it("focuses and selects page search on bare '/', ignoring Shift+/, Cmd+/, IME and inputs", () => {
		render(
			<div>
				<PageHost />
				<textarea aria-label="editor" />
				<div className="xterm" tabIndex={0} data-testid="term">
					term
				</div>
				<div data-shortcut-recording="" />
			</div>,
		);
		const search = screen.getByLabelText("page-search") as HTMLInputElement;
		const btn = screen.getByRole("button", { name: "page-btn" });
		btn.focus();

		// Modifiers and Shift+/ ('?') must not trigger search.
		fireEvent.keyDown(btn, { key: "/", shiftKey: true });
		expect(document.activeElement).toBe(btn);
		fireEvent.keyDown(btn, { key: "/", metaKey: true });
		expect(document.activeElement).toBe(btn);
		fireEvent.keyDown(btn, { key: "/", isComposing: true });
		expect(document.activeElement).toBe(btn);

		// Active shortcut recording blocks '/'.
		fireEvent.keyDown(btn, { key: "/" });
		expect(document.activeElement).toBe(btn);
		document.querySelector("[data-shortcut-recording]")?.remove();

		// Inside editable inputs or terminal, '/' must not hijack.
		const editor = screen.getByLabelText("editor");
		editor.focus();
		fireEvent.keyDown(editor, { key: "/" });
		expect(document.activeElement).toBe(editor);

		const term = screen.getByTestId("term");
		term.focus();
		fireEvent.keyDown(term, { key: "/" });
		expect(document.activeElement).toBe(term);

		// On a neutral button, bare '/' focuses and selects the page search input.
		btn.focus();
		const notPrevented = fireEvent.keyDown(btn, { key: "/" });
		expect(notPrevented).toBe(false);
		expect(document.activeElement).toBe(search);
		expect(search.selectionStart).toBe(0);
		expect(search.selectionEnd).toBe(3);
	});

	it("gives topmost modal precedence and blocks underlying search when a non-search modal is open", () => {
		function ModalHost({ withSearch }: { withSearch: boolean }) {
			const modalRef = useRef<HTMLDivElement>(null);
			const inputRef = useRef<HTMLInputElement>(null);
			useSlashSearch(
				() => focusAndSelect(inputRef.current),
				{ tier: "modal", enabled: withSearch, scopeRef: modalRef },
			);
			return (
				<div data-layer="modal" style={{ zIndex: 400 }}>
					<div ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1}>
						<button type="button">modal-btn</button>
						{withSearch && <input ref={inputRef} aria-label="modal-search" />}
					</div>
				</div>
			);
		}

		const view = render(
			<div>
				<PageHost />
				<ModalHost withSearch />
			</div>,
		);
		fireEvent.keyDown(screen.getByRole("button", { name: "modal-btn" }), { key: "/" });
		expect(document.activeElement).toBe(screen.getByLabelText("modal-search"));

		// A modal without search above must block the underlying page search.
		view.rerender(
			<div>
				<PageHost />
				<ModalHost withSearch={false} />
			</div>,
		);
		const modalBtn = screen.getByRole("button", { name: "modal-btn" });
		modalBtn.focus();
		fireEvent.keyDown(modalBtn, { key: "/" });
		expect(document.activeElement).toBe(modalBtn);
	});

	it("supports popover search while blocking unrelated floating popovers from leaking to page", () => {
		function PopoverHost() {
			const ref = useRef<HTMLDivElement>(null);
			const inputRef = useRef<HTMLInputElement>(null);
			useSlashSearch(() => focusAndSelect(inputRef.current), { tier: "popover", scopeRef: ref });
			return (
				<div data-layer="popover" style={{ zIndex: 200 }}>
					<div ref={ref} tabIndex={-1}>
						<button type="button">pop-btn</button>
						<input ref={inputRef} aria-label="pop-search" />
					</div>
				</div>
			);
		}

		const view = render(
			<div>
				<PageHost />
				<PopoverHost />
			</div>,
		);
		const popBtn = screen.getByRole("button", { name: "pop-btn" });
		popBtn.focus();
		fireEvent.keyDown(popBtn, { key: "/" });
		expect(document.activeElement).toBe(screen.getByLabelText("pop-search"));

		// An unrelated popover (like ModelSelect) blocks page search underneath.
		view.rerender(
			<div>
				<PageHost />
				<div data-layer="popover" style={{ zIndex: 200 }}>
					<button type="button">other-pop-btn</button>
				</div>
			</div>,
		);
		const otherBtn = screen.getByRole("button", { name: "other-pop-btn" });
		otherBtn.focus();
		fireEvent.keyDown(otherBtn, { key: "/" });
		expect(document.activeElement).toBe(otherBtn);
	});

	it("triggers right-panel search only when panel holds focus, preserving chat type-to-focus '/' outside it", async () => {
		render(
			<div>
				<ChatHarness />
				<CollapsiblePanelHost />
			</div>,
		);

		// While focused in the chat stream, '/' routes to the chat composer, not the right panel.
		const stream = screen.getByTestId("chat-stream");
		fireEvent.pointerDown(stream);
		stream.focus();
		fireEvent.keyDown(stream, { key: "/" });
		expect(document.activeElement).toBe(screen.getByLabelText("chat-composer"));
		expect(screen.queryByLabelText("panel-search")).toBeNull();

		// Once the user focuses inside the right panel, '/' expands and focuses the panel search without waking composer.
		const panel = screen.getByTestId("right-panel");
		fireEvent.pointerDown(panel);
		panel.focus();
		fireEvent.keyDown(panel, { key: "/" });
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByLabelText("panel-search"));
		});
	});
});

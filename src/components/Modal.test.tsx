// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireRootInert, Modal } from "./Modal";

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
});

function Host({ onClose }: { onClose?: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				opener
			</button>
			{open && (
				<Modal
					title="标题"
					onClose={() => {
						onClose?.();
						setOpen(false);
					}}
				>
					<input aria-label="field" />
				</Modal>
			)}
		</>
	);
}

describe("Modal", () => {
	it("renders an aria-modal dialog labelled by its title", () => {
		render(
			<Modal title="设置密钥" onClose={() => {}}>
				<p>body</p>
			</Modal>,
		);
		const dialog = screen.getByRole("dialog", { name: "设置密钥" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(dialog.parentElement?.getAttribute("data-layer")).toBe("modal");
		expect(dialog.parentElement?.parentElement).toBe(document.body);
	});

	it("closes on full backdrop click but not on panel click or drag-out", () => {
		const onClose = vi.fn();
		render(
			<Modal title="t" onClose={onClose}>
				<p>body</p>
			</Modal>,
		);
		const dialog = screen.getByRole("dialog");
		const backdrop = dialog.parentElement as HTMLElement;

		// Clicking inside the dialog panel does not close
		fireEvent.mouseDown(dialog);
		fireEvent.click(dialog);
		expect(onClose).not.toHaveBeenCalled();

		// Dragging from inside the dialog and releasing on the backdrop does not close
		fireEvent.mouseDown(dialog);
		fireEvent.click(backdrop);
		expect(onClose).not.toHaveBeenCalled();

		// Full press-and-release on the backdrop closes
		fireEvent.mouseDown(backdrop);
		fireEvent.click(backdrop);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("ignores backdrop clicks when closeOnBackdrop is false", () => {
		const onClose = vi.fn();
		render(
			<Modal title="t" closeOnBackdrop={false} onClose={onClose}>
				<p>body</p>
			</Modal>,
		);
		const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
		fireEvent.mouseDown(backdrop);
		fireEvent.click(backdrop);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("closes on Escape and via the header close button", () => {
		const onClose = vi.fn();
		render(
			<Modal title="t" onClose={onClose}>
				<p>body</p>
			</Modal>,
		);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByLabelText("关闭"));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("renders no header without a title and uses ariaLabel", () => {
		render(
			<Modal ariaLabel="图片" onClose={() => {}}>
				<p>body</p>
			</Modal>,
		);
		expect(screen.getByRole("dialog", { name: "图片" })).toBeTruthy();
		expect(screen.queryByLabelText("关闭")).toBeNull();
	});

	it("restores focus to the opener when closed", () => {
		render(<Host />);
		const opener = screen.getByText("opener");
		opener.focus();
		fireEvent.click(opener);
		expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it("marks #root inert while open and restores it on unmount (ref-counted)", () => {
		const root = document.createElement("div");
		root.id = "root";
		document.body.appendChild(root);

		const { unmount } = render(
			<Modal title="m1" onClose={() => {}}>
				<button type="button">ok</button>
			</Modal>,
		);
		expect(root.hasAttribute("inert")).toBe(true);

		// A second acquire keeps #root inert across first release and guards double-release
		const releaseExtra = acquireRootInert();
		unmount();
		expect(root.hasAttribute("inert")).toBe(true);
		releaseExtra();
		expect(root.hasAttribute("inert")).toBe(false);
		releaseExtra();
		expect(root.hasAttribute("inert")).toBe(false);
	});

	it("traps Tab and Shift+Tab within focusable elements and yields to floating layers", () => {
		render(
			<Modal ariaLabel="trap" onClose={() => {}}>
				<button type="button">first</button>
				<button type="button" disabled>
					disabled
				</button>
				<button type="button" style={{ display: "none" }}>
					hidden
				</button>
				<input aria-label="middle" />
				<button type="button">last</button>
			</Modal>,
		);

		const first = screen.getByRole("button", { name: "first" });
		const last = screen.getByRole("button", { name: "last" });

		// Wrap forward from last -> first
		last.focus();
		fireEvent.keyDown(last, { key: "Tab" });
		expect(document.activeElement).toBe(first);

		// Wrap backward from first -> last
		fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(last);

		// Does not hijack Tab when focus is inside a portaled floating layer
		const floating = document.createElement("div");
		floating.setAttribute("data-floating-layer", "");
		const floatBtn = document.createElement("button");
		floatBtn.textContent = "menu-item";
		floating.appendChild(floatBtn);
		document.body.appendChild(floating);
		floatBtn.focus();
		fireEvent.keyDown(window, { key: "Tab" });
		expect(document.activeElement).toBe(floatBtn);
	});

	it("only traps Tab for the topmost modal", () => {
		render(
			<>
				<Modal ariaLabel="bottom" onClose={() => {}}>
					<button type="button">bottom-btn</button>
				</Modal>
				<Modal ariaLabel="top" onClose={() => {}}>
					<button type="button">top-first</button>
					<button type="button">top-last</button>
				</Modal>
			</>,
		);

		const topFirst = screen.getByRole("button", { name: "top-first" });
		const topLast = screen.getByRole("button", { name: "top-last" });
		topLast.focus();
		fireEvent.keyDown(topLast, { key: "Tab" });
		expect(document.activeElement).toBe(topFirst);
	});

	it("supports disabling backdrop blur and custom backdrop classes", () => {
		render(
			<Modal ariaLabel="无模糊" onClose={() => {}} backdropBlur={false} backdropClassName="bg-transparent">
				<p>content</p>
			</Modal>,
		);
		const dialog = screen.getByRole("dialog", { name: "无模糊" });
		const backdrop = dialog.parentElement!;
		expect(backdrop.className).not.toContain("backdrop-blur-md");
		expect(backdrop.className).toContain("bg-transparent");
	});
});

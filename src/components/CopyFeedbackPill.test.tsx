// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computeCopyPillPosition,
	type CopyPillRect,
	notifyCopied,
	resetCopyFeedbackAnchors,
	useCopyFeedback,
} from "../lib/copyFeedback";
import { CopyFeedbackPill } from "./CopyFeedbackPill";

const VIEWPORT = { left: 8, top: 8, right: 1000, bottom: 700 };

function rect(left: number, top: number, width: number, height: number): CopyPillRect {
	return { left, top, right: left + width, bottom: top + height, width, height };
}

describe("computeCopyPillPosition", () => {
	const pill = { width: 64, height: 24 };

	it("places the pill directly above the selection when clear", () => {
		const anchor = rect(200, 300, 120, 20);
		expect(computeCopyPillPosition(anchor, pill, VIEWPORT)).toEqual({
			left: 228,
			top: 268,
		});
	});

	it("moves the pill below the selection when an annotation bubble sits above", () => {
		const anchor = rect(200, 300, 120, 20);
		const annotationBubble = rect(160, 255, 200, 36);
		expect(computeCopyPillPosition(anchor, pill, VIEWPORT, [annotationBubble])).toEqual({
			left: 228,
			top: 328,
		});
	});

	it("places the pill beside the obstacle when neither above nor below fits", () => {
		const anchor = rect(200, 660, 120, 20);
		const annotationBubble = rect(160, 615, 200, 36);
		const pos = computeCopyPillPosition(anchor, pill, VIEWPORT, [annotationBubble]);
		expect(pos).toEqual({
			left: 366,
			top: 621,
		});
	});

	it("falls back to bottom-center when no anchor is available", () => {
		expect(computeCopyPillPosition(null, pill, VIEWPORT)).toEqual({
			left: 472,
			top: 660,
		});
	});
});

describe("CopyFeedbackPill", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		useCopyFeedback.getState().clear();
		resetCopyFeedbackAnchors();
	});

	it("renders only the concise copied label with no extra fields", () => {
		const { container } = render(<CopyFeedbackPill />);
		expect(container.firstChild).toBeNull();

		act(() => {
			notifyCopied({ anchor: rect(200, 300, 80, 20) });
		});

		const status = screen.getByRole("status");
		expect(status.textContent).toBe("已复制");
	});

	it("supports custom labels without extra metadata", () => {
		render(<CopyFeedbackPill />);

		act(() => {
			notifyCopied({ label: "已复制回复", anchor: rect(200, 300, 80, 20) });
		});

		expect(screen.getByRole("status").textContent).toBe("已复制回复");
	});

	it("auto-dismisses after 1400ms and resets timer on consecutive copies", () => {
		vi.useFakeTimers();
		render(<CopyFeedbackPill />);

		act(() => {
			notifyCopied({ label: "已复制" });
		});
		expect(screen.getByRole("status")).toBeTruthy();

		act(() => {
			vi.advanceTimersByTime(900);
		});
		expect(screen.getByRole("status")).toBeTruthy();

		act(() => {
			notifyCopied({ label: "已复制回复" });
		});
		expect(screen.getByRole("status").textContent).toBe("已复制回复");

		act(() => {
			vi.advanceTimersByTime(900);
		});
		expect(screen.getByRole("status")).toBeTruthy();

		act(() => {
			vi.advanceTimersByTime(550);
		});
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("anchors near the selection on native copy events, avoids annotation bubbles, and ignores empty copies", () => {
		render(
			<div>
				<div
					data-layer="menu"
					data-testid="annotation-bubble"
					style={{ position: "fixed", left: 160, top: 255, width: 200, height: 36 }}
				>
					批注
				</div>
				<textarea defaultValue="alpha beta gamma" />
				<CopyFeedbackPill />
			</div>,
		);

		const bubble = screen.getByTestId("annotation-bubble");
		vi.spyOn(bubble, "getBoundingClientRect").mockReturnValue(new DOMRect(160, 255, 200, 36));

		const emptyEvent = new Event("copy", { bubbles: true, cancelable: true });
		act(() => {
			document.dispatchEvent(emptyEvent);
		});
		expect(screen.queryByRole("status")).toBeNull();

		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		vi.spyOn(textarea, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 300, 120, 20));
		textarea.focus();
		textarea.setSelectionRange(6, 10);

		const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
		act(() => {
			textarea.dispatchEvent(copyEvent);
		});

		const status = screen.getByRole("status") as HTMLElement;
		expect(status.textContent).toBe("已复制");
		expect(Number.parseFloat(status.style.top)).toBeGreaterThanOrEqual(328);

		// Clearing the selection dismisses the selection-triggered pill immediately.
		textarea.setSelectionRange(0, 0);
		act(() => {
			document.dispatchEvent(new Event("selectionchange"));
		});
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("keeps button-triggered pills visible across selectionchange when no selection was copied", () => {
		render(<CopyFeedbackPill />);

		act(() => {
			notifyCopied({ label: "已复制", anchor: rect(200, 300, 80, 20) });
		});
		expect(screen.getByRole("status")).toBeTruthy();

		act(() => {
			document.dispatchEvent(new Event("selectionchange"));
		});
		expect(screen.getByRole("status")).toBeTruthy();
	});
});

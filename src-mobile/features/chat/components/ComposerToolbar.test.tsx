// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installViewportTracking } from "../../../app/viewport";
import type { NativeBridge } from "../../../core/nativeBridge";
import { useKeyboardOpen } from "./ComposerToolbar";

function Probe() {
	const open = useKeyboardOpen();
	return (
		<div>
			<textarea aria-label="input" />
			<output data-testid="kb">{open ? "open" : "closed"}</output>
		</div>
	);
}

afterEach(() => {
	cleanup();
	delete window.__VECWAY_NATIVE__;
	vi.unstubAllGlobals();
	document.documentElement.removeAttribute("style");
	delete document.documentElement.dataset.kbOpen;
	delete document.documentElement.dataset.kbNative;
});

describe("useKeyboardOpen", () => {
	it("ignores bare textarea focus and tracks native onKeyboardChange events", () => {
		let emit: ((ev: { height: number; durationMs: number }) => void) | null = null;
		window.__VECWAY_NATIVE__ = {
			platform: "ios",
			appVersion: "1.0.0",
			httpRequest: vi.fn(),
			openSse: vi.fn(),
			getConnectionStatus: vi.fn(),
			openPairScanner: vi.fn(),
			updateEndpoints: vi.fn(),
			reprobeConnection: vi.fn(),
			switchChannel: vi.fn(),
			unpair: vi.fn(),
			onKeyboardChange: (cb: (ev: { height: number; durationMs: number }) => void) => {
				emit = cb;
				return () => {
					emit = null;
				};
			},
		} as unknown as NativeBridge;

		const dispose = installViewportTracking();
		render(<Probe />);

		fireEvent.focus(screen.getByLabelText("input"));
		expect(screen.getByTestId("kb").textContent).toBe("closed");
		expect(document.documentElement.dataset.kbOpen).toBe("0");

		act(() => emit?.({ height: 336, durationMs: 250 }));
		expect(screen.getByTestId("kb").textContent).toBe("open");
		expect(document.documentElement.dataset.kbOpen).toBe("1");
		expect(document.documentElement.style.getPropertyValue("--m-kb")).toBe("336px");
		expect(document.documentElement.style.getPropertyValue("--m-kb-dur")).toBe("250ms");
		expect(document.documentElement.style.getPropertyValue("--m-vh")).toBe("calc(100dvh - 336px)");
		expect(document.documentElement.style.getPropertyValue("--m-vv-top")).toBe("0px");

		act(() => emit?.({ height: 0, durationMs: 250 }));
		expect(screen.getByTestId("kb").textContent).toBe("closed");
		expect(document.documentElement.dataset.kbOpen).toBe("0");

		dispose();
	});

	it("falls back to visualViewport height delta on web browsers", () => {
		const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
		vi.stubGlobal("visualViewport", viewport);
		vi.stubGlobal("innerHeight", 844);
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(0);
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});

		const dispose = installViewportTracking();
		render(<Probe />);
		expect(screen.getByTestId("kb").textContent).toBe("closed");

		act(() => {
			viewport.height = 520;
			viewport.dispatchEvent(new Event("resize"));
		});
		expect(screen.getByTestId("kb").textContent).toBe("open");
		expect(document.documentElement.dataset.kbOpen).toBe("1");

		dispose();
	});
});

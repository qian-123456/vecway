// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConnection } from "../../core/stores/connection";
import { bytesToBase64, type NativeBridge, type NativeSseHandlers } from "../../core/nativeBridge";
import { TerminalPage } from "./TerminalPage";

// No WorkspacePanelBar in TerminalPage anymore.
vi.mock("@xterm/xterm", () => ({ Terminal: class {
	cols = 80; rows = 24; options = {};
	loadAddon() {} open() {} write() {} clear() {} reset() {} dispose() {}
	onData() { return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeEach(() => {
	delete window.__VECWAY_NATIVE__;
	useConnection.setState({ phase: "open", error: null });
});
afterEach(() => {
	cleanup();
	delete window.__VECWAY_NATIVE__;
	vi.unstubAllGlobals();
});

it("detaches a revoked terminal without stopping its computer process", async () => {
	const close = vi.fn();
	const events = vi.fn(function () { return { close, addEventListener: vi.fn() }; });
	const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ termId: "term-1" }), { status: 200, headers: { "content-type": "application/json" } }));
	vi.stubGlobal("fetch", fetcher);
	vi.stubGlobal("EventSource", events);
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	const view = render(<TerminalPage route={{ name: "terminal", path: "/s/a/terminal", params: { id: "a" }, query: {} }} />);
	await waitFor(() => expect(events).toHaveBeenCalledTimes(1));
	act(() => useConnection.getState().setPhase("unauthorized", "revoked"));
	expect(close).toHaveBeenCalled();
	expect(screen.getByText("配对已失效或被撤销，请重新配对。")).toBeDefined();
	view.unmount();
	expect(fetcher.mock.calls.some(([, init]) => init.method === "DELETE")).toBe(false);
});

it("uses native bridge.openSse for terminal streaming and closes cleanly on revocation", async () => {
	const utf8 = new TextEncoder();
	const close = vi.fn();
	let capturedUrl = "";
	let capturedHandlers: NativeSseHandlers | null = null;
	const openSse = vi.fn((url: string, handlers: NativeSseHandlers) => {
		capturedUrl = url;
		capturedHandlers = handlers;
		return close;
	});
	const httpRequest = vi.fn(async () => ({
		status: 200,
		headers: { "content-type": "application/json" },
		bodyBase64: bytesToBase64(utf8.encode(JSON.stringify({ termId: "term-native" }))),
	}));
	const browserEventSource = vi.fn();
	vi.stubGlobal("EventSource", browserEventSource);
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

	const bridge: NativeBridge = {
		platform: "ios",
		appVersion: "0.2.0",
		httpRequest,
		openSse,
		getConnectionStatus: vi.fn(async () => ({
			paired: true,
			activeChannel: "lan_tls" as const,
			activeUrl: "https://192.168.1.10:7790",
			certSha256: "AA:BB",
			candidates: {},
		})),
		openPairScanner: vi.fn(async () => ({ ok: true })),
		updateEndpoints: vi.fn(async () => ({
			paired: true,
			activeChannel: "lan_tls" as const,
			activeUrl: "https://192.168.1.10:7790",
			certSha256: "AA:BB",
			candidates: {},
		})),
		reprobeConnection: vi.fn(async () => ({
			paired: true,
			activeChannel: "lan_tls" as const,
			activeUrl: "https://192.168.1.10:7790",
			certSha256: "AA:BB",
			candidates: {},
		})),
		unpair: vi.fn(async () => {}),
	};
	window.__VECWAY_NATIVE__ = bridge;

	const view = render(<TerminalPage route={{ name: "terminal", path: "/s/a/terminal", params: { id: "a" }, query: {} }} />);
	await waitFor(() => expect(openSse).toHaveBeenCalledTimes(1));
	expect(capturedUrl).toBe("/api/terminal/term-native/stream");
	expect(browserEventSource).not.toHaveBeenCalled();

	act(() => capturedHandlers?.onOpen?.());
	expect(screen.getAllByText("等待终端响应…").length).toBeGreaterThan(0);
	act(() => capturedHandlers?.onEvent?.("data", bytesToBase64(utf8.encode("ok\n"))));
	expect(screen.getByText("已就绪")).toBeDefined();
	act(() => useConnection.getState().setPhase("unauthorized", "revoked"));
	expect(close).toHaveBeenCalledTimes(1);
	expect(screen.getByText("配对已失效或被撤销，请重新配对。")).toBeDefined();
	view.unmount();
});

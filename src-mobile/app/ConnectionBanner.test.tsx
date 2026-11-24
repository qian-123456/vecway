// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ConnectionBanner } from "./ConnectionBanner";
import {
	bytesToBase64,
	type NativeBridge,
	type NativeEndpointStatus,
	type NativeHttpResponse,
} from "../core/nativeBridge";
import { stopEvents } from "../core/sse";
import { useConnection } from "../core/stores/connection";

const utf8 = new TextEncoder();

function jsonResponse(body: unknown, status = 200): NativeHttpResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		bodyBase64: bytesToBase64(utf8.encode(JSON.stringify(body))),
	};
}

function makeNativeBridge(overrides: Partial<NativeBridge> = {}): NativeBridge {
	return {
		platform: "ios",
		appVersion: "0.2.0",
		httpRequest: vi.fn(async () => jsonResponse([])),
		openSse: vi.fn(() => vi.fn()),
		getConnectionStatus: vi.fn(
			async (): Promise<NativeEndpointStatus> => ({
				paired: false,
				activeChannel: null,
				activeUrl: null,
				certSha256: null,
				candidates: {},
			}),
		),
		openPairScanner: vi.fn(async () => ({
			ok: true,
			status: {
				paired: true,
				activeChannel: "lan_tls" as const,
				activeUrl: "https://192.168.1.10:7790",
				certSha256: "AA:BB",
				candidates: { lanTls: "https://192.168.1.10:7790" },
			},
		})),
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
		...overrides,
	};
}

beforeEach(() => {
	delete window.__VECWAY_NATIVE__;
	useConnection.setState({ phase: "open", error: null });
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			media: "(prefers-color-scheme: dark)",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	);
});

afterEach(() => {
	stopEvents();
	cleanup();
	delete window.__VECWAY_NATIVE__;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("ConnectionBanner", () => {
	it("invokes bridge.openPairScanner() directly in native mode and recovers on ok", async () => {
		const bridge = makeNativeBridge();
		window.__VECWAY_NATIVE__ = bridge;
		useConnection.setState({ phase: "unauthorized", error: "revoked" });

		render(<ConnectionBanner />);
		fireEvent.click(screen.getByRole("button", { name: "重新配对" }));

		await waitFor(() => expect(bridge.openPairScanner).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(useConnection.getState().phase).not.toBe("unauthorized"));
		expect(screen.queryByText(/点击「生成二维码」/)).toBeNull();
	});

	it("keeps the manual re-pair guide sheet on web", () => {
		useConnection.setState({ phase: "unauthorized", error: "revoked" });
		render(<ConnectionBanner />);
		fireEvent.click(screen.getByRole("button", { name: "重新配对" }));
		expect(screen.getByText(/点击「生成二维码」/)).toBeDefined();
	});

	it("shows stable offline title with expandable full error detail", () => {
		useConnection.setState({ phase: "closed", error: "TLS handshake failed on 192.168.1.10:7790: unexpected EOF" });
		render(<ConnectionBanner />);
		expect(screen.getByText("连接已断开")).toBeDefined();
		expect(screen.queryByText(/unexpected EOF/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "详情" }));
		expect(screen.getByText("TLS handshake failed on 192.168.1.10:7790: unexpected EOF")).toBeDefined();
	});
});

describe("App native onboarding & security states", () => {
	it("shows unpaired onboarding without firing API requests and enters workspace after scanner succeeds", async () => {
		const bridge = makeNativeBridge();
		window.__VECWAY_NATIVE__ = bridge;

		render(
			<App
				nativeStatus={{
					paired: false,
					activeChannel: null,
					activeUrl: null,
					certSha256: null,
					candidates: {},
				}}
			/>,
		);

		expect(screen.getByText("连接 Vecway 桌面端")).toBeDefined();
		expect(bridge.httpRequest).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "扫码配对" }));
		await waitFor(() => expect(bridge.openPairScanner).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByText("连接 Vecway 桌面端")).toBeNull());
	});

	it("hard-blocks on certificate pin mismatch with no ignore/continue option", () => {
		const bridge = makeNativeBridge();
		window.__VECWAY_NATIVE__ = bridge;

		render(
			<App
				nativeStatus={{
					paired: true,
					activeChannel: "lan_tls",
					activeUrl: "https://192.168.1.10:7790",
					certSha256: "AA:AA",
					candidates: { lanTls: "https://192.168.1.10:7790" },
					pinMismatch: {
						expectedSha256: "AA:AA:AA:AA",
						actualSha256: "BB:BB:BB:BB",
						host: "192.168.1.10",
						channel: "lan_tls",
					},
				}}
			/>,
		);

		expect(screen.getByText("证书指纹不匹配，已阻止连接")).toBeDefined();
		expect(screen.getByText("AA:AA:AA:AA")).toBeDefined();
		expect(screen.getByText("BB:BB:BB:BB")).toBeDefined();
		expect(screen.queryByText(/忽略|继续/)).toBeNull();
		expect(bridge.httpRequest).not.toHaveBeenCalled();
	});
});

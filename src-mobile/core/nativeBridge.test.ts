// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, postRaw, upload } from "./api";
import {
	base64ToBytes,
	blobToBase64,
	bytesToBase64,
	createEventSource,
	getNativeBridge,
	isNativeApp,
	nativeHaptic,
	notifyNativeConnectionStatus,
	subscribeNativeConnectionStatus,
	validateHttpsEndpoint,
	type NativeBridge,
	type NativeEndpointStatus,
	type NativeHttpRequest,
	type NativeHttpResponse,
	type NativeSseHandlers,
} from "./nativeBridge";
import { EventBus, SseClient, reconnectEvents, startEvents, stopEvents } from "./sse";
import { useConnection } from "./stores/connection";
import { mapNativePushStatus } from "../features/settings/push";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function jsonNativeResponse(body: unknown, status = 200, headers: Record<string, string> = {}): NativeHttpResponse {
	return {
		status,
		headers: { "content-type": "application/json", ...headers },
		bodyBase64: bytesToBase64(utf8Encoder.encode(JSON.stringify(body))),
	};
}

function createMockBridge(overrides: Partial<NativeBridge> = {}) {
	const sseStreams: Array<{ url: string; handlers: NativeSseHandlers; close: ReturnType<typeof vi.fn> }> = [];
	const statusCallbacks = new Set<(status: NativeEndpointStatus) => void>();

	const httpRequest = vi.fn(
		async (_req: NativeHttpRequest, _signal?: AbortSignal): Promise<NativeHttpResponse> =>
			jsonNativeResponse({ ok: true }),
	);
	const openSse = vi.fn((url: string, handlers: NativeSseHandlers) => {
		const close = vi.fn();
		sseStreams.push({ url, handlers, close });
		return close;
	});
	const getConnectionStatus = vi.fn(
		async (): Promise<NativeEndpointStatus> => ({
			paired: true,
			activeChannel: "lan_tls",
			activeUrl: "https://192.168.1.10:7790",
			certSha256: "AA:BB:CC:DD",
			candidates: { lanTls: "https://192.168.1.10:7790" },
		}),
	);
	const openPairScanner = vi.fn(async () => ({ ok: true }));
	const updateEndpoints = vi.fn(async (endpoints: Partial<NativeEndpointStatus["candidates"]>) => ({
		paired: true,
		activeChannel: "lan_tls" as const,
		activeUrl: endpoints.lanTls ?? "https://192.168.1.10:7790",
		certSha256: "AA:BB:CC:DD",
		candidates: { ...endpoints },
	}));
	const reprobeConnection = vi.fn(async () => getConnectionStatus());
	const unpair = vi.fn(async () => {});
	const onConnectionStatusChange = vi.fn((cb: (status: NativeEndpointStatus) => void) => {
		statusCallbacks.add(cb);
		return () => {
			statusCallbacks.delete(cb);
		};
	});

	const bridge: NativeBridge = {
		platform: "ios",
		appVersion: "0.2.0",
		httpRequest,
		openSse,
		getConnectionStatus,
		openPairScanner,
		updateEndpoints,
		reprobeConnection,
		unpair,
		onConnectionStatusChange,
		...overrides,
	};

	return {
		bridge,
		sseStreams,
		emitStatus: (status: NativeEndpointStatus) => {
			for (const cb of [...statusCallbacks]) cb(status);
		},
		spies: {
			httpRequest,
			openSse,
			getConnectionStatus,
			openPairScanner,
			updateEndpoints,
			reprobeConnection,
			unpair,
			onConnectionStatusChange,
		},
	};
}

beforeEach(() => {
	delete window.__VECWAY_NATIVE__;
	useConnection.setState({ phase: "idle", error: null });
});

afterEach(() => {
	stopEvents();
	delete window.__VECWAY_NATIVE__;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("nativeBridge helpers", () => {
	it("detects web vs native runtime cleanly", () => {
		expect(isNativeApp()).toBe(false);
		expect(getNativeBridge()).toBeNull();

		const { bridge } = createMockBridge();
		window.__VECWAY_NATIVE__ = bridge;
		expect(isNativeApp()).toBe(true);
		expect(getNativeBridge()).toBe(bridge);
	});

	it("round-trips UTF-8 and large (>128 KiB) binary payloads through chunked base64", async () => {
		const utf8 = utf8Encoder.encode("你好 Vecway 🚀 TLS 加密传输");
		expect(utf8Decoder.decode(base64ToBytes(bytesToBase64(utf8)))).toBe("你好 Vecway 🚀 TLS 加密传输");

		const large = new Uint8Array(150_000);
		for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
		const encoded = bytesToBase64(large);
		const decoded = base64ToBytes(encoded);
		expect(decoded.byteLength).toBe(large.byteLength);
		expect(decoded[0]).toBe(0);
		expect(decoded[65_537]).toBe(1);
		expect(decoded[large.length - 1]).toBe((large.length - 1) & 0xff);

		const blob = new Blob([large], { type: "application/octet-stream" });
		const fromBlob = await blobToBase64(blob);
		expect(fromBlob).toBe(encoded);

		expect(bytesToBase64(new Uint8Array(0))).toBe("");
		expect(base64ToBytes("").byteLength).toBe(0);
	});

	it("routes nativeHaptic calls to impact/notification/selection and stays no-op on web", () => {
		expect(() => nativeHaptic("success")).not.toThrow();

		const haptics = {
			impact: vi.fn(),
			notification: vi.fn(),
			selection: vi.fn(),
		};
		window.__VECWAY_NATIVE__ = createMockBridge({ haptics }).bridge;

		nativeHaptic("light");
		nativeHaptic("heavy");
		nativeHaptic("success");
		nativeHaptic("error");
		nativeHaptic("selection");

		expect(haptics.impact).toHaveBeenNthCalledWith(1, "light");
		expect(haptics.impact).toHaveBeenNthCalledWith(2, "heavy");
		expect(haptics.notification).toHaveBeenNthCalledWith(1, "success");
		expect(haptics.notification).toHaveBeenNthCalledWith(2, "error");
		expect(haptics.selection).toHaveBeenCalledTimes(1);
	});

	it("validates HTTPS endpoints strictly and hard-rejects plaintext http://", () => {
		expect(validateHttpsEndpoint("", "局域网 TLS 地址")).toBeNull();
		expect(validateHttpsEndpoint("https://192.168.1.10:7790", "局域网 TLS 地址")).toBeNull();
		expect(validateHttpsEndpoint("https://[2001:db8::1]:7789", "IPv6 TLS 地址")).toBeNull();
		expect(validateHttpsEndpoint("https://abc.trycloudflare.com", "Cloudflare 隧道地址")).toBeNull();

		expect(validateHttpsEndpoint("http://192.168.1.10:7788", "局域网 TLS 地址")).toContain("http://");
		expect(validateHttpsEndpoint("ws://192.168.1.10:7788", "局域网 TLS 地址")).toContain("https://");
		expect(validateHttpsEndpoint("not-a-url", "局域网 TLS 地址")).toContain("格式无效");
		expect(validateHttpsEndpoint("https://user:pass@192.168.1.10:7790", "局域网 TLS 地址")).toContain("用户名");
	});

	it("wires bridge.onConnectionStatusChange once across multiple subscribers and cleans up", () => {
		const { bridge, emitStatus, spies } = createMockBridge();
		window.__VECWAY_NATIVE__ = bridge;

		const a = vi.fn();
		const b = vi.fn();
		const unsubA = subscribeNativeConnectionStatus(a);
		const unsubB = subscribeNativeConnectionStatus(b);
		expect(spies.onConnectionStatusChange).toHaveBeenCalledTimes(1);

		const status: NativeEndpointStatus = {
			paired: true,
			activeChannel: "tunnel",
			activeUrl: "https://demo.trycloudflare.com",
			certSha256: null,
			candidates: { tunnel: "https://demo.trycloudflare.com" },
		};
		emitStatus(status);
		expect(a).toHaveBeenCalledWith(status);
		expect(b).toHaveBeenCalledWith(status);

		notifyNativeConnectionStatus({ ...status, paired: false });
		expect(a).toHaveBeenCalledTimes(2);
		expect(b).toHaveBeenCalledTimes(2);

		unsubA();
		unsubB();
		emitStatus(status);
		expect(a).toHaveBeenCalledTimes(2);
		expect(b).toHaveBeenCalledTimes(2);
	});
});

describe("native HTTP transport (api / upload / postRaw)", () => {
	it("delegates api() JSON calls to bridge.httpRequest with base64 round-trip and clears stale errors", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { bridge, spies } = createMockBridge();
		spies.httpRequest.mockResolvedValueOnce(jsonNativeResponse({ message: "你好世界", id: 42 }));
		window.__VECWAY_NATIVE__ = bridge;
		useConnection.setState({ phase: "open", error: "旧网络错误" });

		const res = await api<{ message: string; id: number }>("POST", "/sessions", { title: "测试会话" });

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(res).toEqual({ message: "你好世界", id: 42 });
		expect(useConnection.getState().error).toBeNull();
		expect(spies.httpRequest).toHaveBeenCalledTimes(1);
		const req = spies.httpRequest.mock.calls[0]![0];
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/sessions");
		expect(req.headers?.["content-type"]).toBe("application/json");
		expect(JSON.parse(utf8Decoder.decode(base64ToBytes(req.bodyBase64!)))).toEqual({ title: "测试会话" });
	});

	it("delegates upload() and postRaw() binary blobs to bridge.httpRequest", async () => {
		const { bridge, spies } = createMockBridge();
		spies.httpRequest
			.mockResolvedValueOnce(jsonNativeResponse({ path: "/tmp/pic.png", name: "pic.png", size: 4 }))
			.mockResolvedValueOnce(jsonNativeResponse({ text: "原生语音转写" }));
		window.__VECWAY_NATIVE__ = bridge;

		const file = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
		const uploaded = await upload("/sessions/s1/upload", file, { name: "pic.png" });
		expect(uploaded).toEqual({ path: "/tmp/pic.png", name: "pic.png", size: 4 });
		const uploadReq = spies.httpRequest.mock.calls[0]![0];
		expect(uploadReq.path).toBe("/api/sessions/s1/upload?name=pic.png");
		expect(uploadReq.headers?.["content-type"]).toBe("image/png");
		expect(Array.from(base64ToBytes(uploadReq.bodyBase64!))).toEqual([0x89, 0x50, 0x4e, 0x47]);

		const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
		const voice = await postRaw<{ text: string }>("/voice/transcribe", audio, "audio/webm");
		expect(voice).toEqual({ text: "原生语音转写" });
		expect(spies.httpRequest.mock.calls[1]![0].path).toBe("/api/voice/transcribe");
	});

	it("handles 204 empty responses cleanly without Fetch null-body errors", async () => {
		const { bridge, spies } = createMockBridge();
		spies.httpRequest.mockResolvedValueOnce({ status: 204, headers: {}, bodyBase64: "" });
		window.__VECWAY_NATIVE__ = bridge;

		const res = await api("POST", "/device/name", { name: "My iPhone" });
		expect(res).toBeNull();
	});

	it("preserves ApiError on non-2xx JSON responses", async () => {
		const { bridge, spies } = createMockBridge();
		spies.httpRequest.mockResolvedValueOnce(jsonNativeResponse({ error: "工作区不存在" }, 404));
		window.__VECWAY_NATIVE__ = bridge;

		await expect(api("GET", "/sessions/missing")).rejects.toMatchObject({
			name: "ApiError",
			status: 404,
			message: "工作区不存在",
		});
	});

	it("propagates caller AbortSignal cancellation untouched without setting connection error", async () => {
		const { bridge, spies } = createMockBridge();
		spies.httpRequest.mockImplementation(
			() => new Promise<NativeHttpResponse>(() => { /* stays pending until aborted */ }),
		);
		window.__VECWAY_NATIVE__ = bridge;

		const controller = new AbortController();
		const pending = api("GET", "/sessions", undefined, { signal: controller.signal });
		await Promise.resolve();
		controller.abort();

		let caught: unknown = null;
		try {
			await pending;
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(DOMException);
		expect((caught as DOMException).name).toBe("AbortError");
		expect(useConnection.getState().error).toBeNull();
	});

	it("rejects with ApiError(408) on timeout and records error in connection store", async () => {
		vi.useFakeTimers();
		const { bridge, spies } = createMockBridge();
		spies.httpRequest.mockImplementation(
			() => new Promise<NativeHttpResponse>(() => { /* never settles */ }),
		);
		window.__VECWAY_NATIVE__ = bridge;

		const pending = api("GET", "/sessions", undefined, { timeoutMs: 250 });
		const assertion = expect(pending).rejects.toEqual(new ApiError(408, "请求超时"));
		await vi.advanceTimersByTimeAsync(260);
		await assertion;
		expect(useConnection.getState().error).toBe("请求超时");
	});

	it("wraps bridge transport errors as ApiError(0) and marks 401 unauthorized", async () => {
		const { bridge, spies } = createMockBridge();
		spies.httpRequest
			.mockRejectedValueOnce(new Error("证书指纹校验失败"))
			.mockResolvedValueOnce({ status: 401, headers: {}, bodyBase64: "" });
		window.__VECWAY_NATIVE__ = bridge;

		await expect(api("GET", "/sessions")).rejects.toMatchObject({
			status: 0,
			message: "证书指纹校验失败",
		});
		expect(useConnection.getState().error).toBe("证书指纹校验失败");

		await expect(api("GET", "/sessions")).rejects.toMatchObject({
			status: 401,
			message: "unauthorized",
		});
		expect(useConnection.getState().phase).toBe("unauthorized");
		// Once unauthorized, stray setPhase/setError calls cannot override it.
		useConnection.getState().setPhase("open");
		expect(useConnection.getState().phase).toBe("unauthorized");
		// Explicit reset transitions cleanly back to idle.
		useConnection.getState().reset();
		expect(useConnection.getState()).toMatchObject({ phase: "idle", error: null });
	});
});

describe("native SSE bridge (createEventSource + SseClient)", () => {
	it("adapts bridge.openSse to EventSourceLike with multi-listener fanout and idempotent close", () => {
		const { bridge, sseStreams } = createMockBridge();
		window.__VECWAY_NATIVE__ = bridge;

		const es = createEventSource("/api/events");
		expect(es.readyState).toBe(0);
		expect(sseStreams).toHaveLength(1);
		expect(sseStreams[0]!.url).toBe("/api/events");

		const onOpen = vi.fn();
		const onError = vi.fn();
		const listenerA = vi.fn();
		const listenerB = vi.fn();
		es.onopen = onOpen;
		es.onerror = onError;
		es.addEventListener("rpc", listenerA);
		es.addEventListener("rpc", listenerB);

		sseStreams[0]!.handlers.onOpen?.();
		expect(es.readyState).toBe(1);
		expect(onOpen).toHaveBeenCalledTimes(1);

		sseStreams[0]!.handlers.onEvent("rpc", '{"x":1}');
		expect(listenerA).toHaveBeenCalledWith({ data: '{"x":1}' });
		expect(listenerB).toHaveBeenCalledWith({ data: '{"x":1}' });

		es.close();
		es.close();
		expect(es.readyState).toBe(2);
		expect(sseStreams[0]!.close).toHaveBeenCalledTimes(1);

		// Late events after close are ignored.
		sseStreams[0]!.handlers.onEvent("rpc", '{"x":2}');
		expect(listenerA).toHaveBeenCalledTimes(1);
	});

	it("opens, dispatches hello/rpc/resync, reconnects on error, stops on 401, and resumes after reset()", async () => {
		vi.useFakeTimers();
		const { bridge, sseStreams, spies } = createMockBridge();
		window.__VECWAY_NATIVE__ = bridge;

		const bus = new EventBus();
		const received: string[] = [];
		bus.on("hello", () => received.push("hello"));
		bus.on("rpc", (e) => received.push(`rpc:${e.sessionId}`));
		bus.on("resync", (e) => received.push(`resync:${e.reason ?? "none"}`));

		const client = new SseClient({
			create: (url) => createEventSource(url),
			probe: () => api("GET", "/sessions"),
			random: () => 0.5,
			bus,
		});

		client.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sseStreams).toHaveLength(1);
		sseStreams[0]!.handlers.onOpen?.();
		sseStreams[0]!.handlers.onEvent("hello", "{}");
		sseStreams[0]!.handlers.onEvent("rpc", JSON.stringify({ sessionId: "s1", frame: { type: "agent_start" } }));
		sseStreams[0]!.handlers.onEvent("resync", JSON.stringify({ reason: "server" }));
		expect(useConnection.getState().phase).toBe("open");
		expect(received).toEqual(["hello", "rpc:s1", "resync:server"]);

		// Error triggers backoff reconnect.
		sseStreams[0]!.handlers.onError("network dropped");
		expect(useConnection.getState().phase).toBe("closed");
		await vi.advanceTimersByTimeAsync(1001);
		expect(sseStreams).toHaveLength(2);

		// 401 probe marks unauthorized and permanently stops retries.
		spies.httpRequest.mockResolvedValueOnce({ status: 401, headers: {}, bodyBase64: "" });
		sseStreams[1]!.handlers.onError("revoked");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(useConnection.getState().phase).toBe("unauthorized");
		expect(sseStreams).toHaveLength(2);

		// Re-pairing calls reset() and resume() restarts stream cleanly.
		spies.httpRequest.mockResolvedValueOnce(jsonNativeResponse([]));
		useConnection.getState().reset();
		client.resume("online");
		await vi.advanceTimersByTimeAsync(0);
		expect(sseStreams).toHaveLength(3);
		sseStreams[2]!.handlers.onEvent("hello", "{}");
		expect(useConnection.getState().phase).toBe("open");
		client.stop();
	});

	it("supports startEvents -> stopEvents -> startEvents / reconnectEvents cleanly", async () => {
		vi.useFakeTimers();
		const { bridge, sseStreams } = createMockBridge();
		window.__VECWAY_NATIVE__ = bridge;

		startEvents();
		await vi.advanceTimersByTimeAsync(0);
		expect(sseStreams).toHaveLength(1);

		stopEvents();
		expect(sseStreams[0]!.close).toHaveBeenCalledTimes(1);

		reconnectEvents();
		await vi.advanceTimersByTimeAsync(0);
		expect(sseStreams).toHaveLength(2);
		stopEvents();
	});
});

describe("mapNativePushStatus", () => {
	it("maps unsupported, denied, and supported native push states cleanly", () => {
		expect(mapNativePushStatus(null, false)).toMatchObject({
			available: false,
			canToggle: false,
			canTest: false,
		});
		expect(
			mapNativePushStatus({ supported: false, permission: "default", registered: false, reason: "暂未配置 APNs" }, true),
		).toMatchObject({
			available: false,
			canToggle: false,
			canTest: false,
			reason: "暂未配置 APNs",
		});
		expect(
			mapNativePushStatus({ supported: true, permission: "denied", registered: false }, true),
		).toMatchObject({
			available: false,
			canToggle: false,
			canTest: false,
		});
		expect(
			mapNativePushStatus({ supported: true, permission: "granted", registered: true }, true),
		).toMatchObject({
			available: true,
			registered: true,
			canToggle: true,
			canTest: true,
			reason: null,
		});
		expect(
			mapNativePushStatus({ supported: true, permission: "granted", registered: true }, false).canTest,
		).toBe(false);
	});
});

/**
 * Runtime bridge between `src-mobile` and native iOS / Android light shells.
 * The native shell injects `window.__VECWAY_NATIVE__` at document start.
 * On web browsers, `getNativeBridge()` returns `null` with zero runtime overhead.
 */
import type { EventSourceLike } from "./sse";

export type NativePlatform = "ios" | "android";
export type NativeChannel = "lan_tls" | "ipv6_tls" | "tunnel";

export interface NativePinMismatch {
	expectedSha256: string;
	actualSha256: string;
	host: string;
	channel: NativeChannel;
}

export interface NativeEndpointStatus {
	paired: boolean;
	activeChannel: NativeChannel | null;
	preferredChannel?: NativeChannel | null;
	activeUrl: string | null;
	certSha256: string | null;
	candidates: { lanTls?: string; ipv6?: string; tunnel?: string };
	pinMismatch?: NativePinMismatch | null;
}

export interface NativeHttpRequest {
	id: string;
	method: string;
	path: string;
	headers?: Record<string, string>;
	bodyBase64?: string;
	timeoutMs?: number;
}

export interface NativeHttpResponse {
	status: number;
	headers: Record<string, string>;
	bodyBase64?: string;
	bodyText?: string;
}

export interface NativeKeyboardEvent {
	height: number;
	durationMs: number;
}

export interface NativeSseHandlers {
	onOpen?: () => void;
	onEvent: (type: string, data: string) => void;
	onError: (message?: string) => void;
}

export interface NativePushStatus {
	supported: boolean;
	permission: "default" | "granted" | "denied";
	registered: boolean;
	reason?: string;
}

export interface NativeBridge {
	readonly platform: NativePlatform;
	readonly appVersion: string;
	httpRequest(req: NativeHttpRequest, signal?: AbortSignal): Promise<NativeHttpResponse>;
	openSse(url: string, handlers: NativeSseHandlers): () => void;
	getConnectionStatus(): Promise<NativeEndpointStatus>;
	openPairScanner(options?: { mode?: "scan" | "domain" }): Promise<{ ok: boolean; error?: string; status?: NativeEndpointStatus }>;
	updateEndpoints(
		endpoints: Partial<NativeEndpointStatus["candidates"]> & { certSha256?: string },
	): Promise<NativeEndpointStatus>;
	switchChannel?(channel: NativeChannel | null): Promise<NativeEndpointStatus>;
	reprobeConnection(): Promise<NativeEndpointStatus>;
	unpair(): Promise<void>;
	onConnectionStatusChange?(cb: (status: NativeEndpointStatus) => void): () => void;
	onForegroundResync?(cb: () => void): () => void;
	onKeyboardChange?(cb: (ev: NativeKeyboardEvent) => void): () => void;
	audio?: {
		startRecording(): Promise<void>;
		stopAndTranscribe(): Promise<{ text: string }>;
		cancelRecording(): Promise<void>;
	};
	haptics?: {
		impact(style?: "light" | "medium" | "heavy"): void;
		notification(type: "success" | "warning" | "error"): void;
		selection(): void;
	};
	push?: {
		getStatus(): Promise<NativePushStatus>;
		enable(): Promise<void>;
		disable(): Promise<void>;
		sendTest?(): Promise<void>;
	};
}

declare global {
	interface Window {
		__VECWAY_NATIVE__?: NativeBridge;
	}
}

export type NativeHapticKind = "light" | "medium" | "heavy" | "success" | "warning" | "error" | "selection";

export const EMPTY_NATIVE_STATUS: NativeEndpointStatus = {
	paired: false,
	activeChannel: null,
	preferredChannel: null,
	activeUrl: null,
	certSha256: null,
	candidates: {},
	pinMismatch: null,
};

export const NATIVE_CHANNEL_LABEL: Record<NativeChannel, string> = {
	lan_tls: "局域网 TLS",
	ipv6_tls: "IPv6 TLS",
	tunnel: "Cloudflare / 公网域名",
};

export function getNativeBridge(): NativeBridge | null {
	if (typeof window === "undefined") return null;
	return window.__VECWAY_NATIVE__ ?? null;
}

export function isNativeApp(): boolean {
	return getNativeBridge() !== null;
}

export function nativeHaptic(kind: NativeHapticKind): void {
	const haptics = getNativeBridge()?.haptics;
	if (!haptics) return;
	try {
		if (kind === "light" || kind === "medium" || kind === "heavy") {
			haptics.impact(kind);
		} else if (kind === "success" || kind === "warning" || kind === "error") {
			haptics.notification(kind);
		} else {
			haptics.selection();
		}
	} catch {
		/* tactile feedback is strictly best-effort */
	}
}

/**
 * Unified EventSource factory:
 * - Web: standard `new EventSource(url)`.
 * - Native: adapts `bridge.openSse(url, handlers)` to `EventSourceLike`.
 */
export function createEventSource(url: string): EventSourceLike {
	const bridge = getNativeBridge();
	if (!bridge) return new EventSource(url) as unknown as EventSourceLike;

	const listeners = new Map<string, Set<(e: { data: string }) => void>>();
	let closed = false;
	let closeNative: (() => void) | null = null;

	const teardownNative = () => {
		const fn = closeNative;
		closeNative = null;
		if (!fn) return;
		try {
			fn();
		} catch {
			/* already closed */
		}
	};

	const es: EventSourceLike = {
		readyState: 0,
		onopen: null,
		onerror: null,
		addEventListener(type: string, fn: (e: { data: string }) => void) {
			let set = listeners.get(type);
			if (!set) {
				set = new Set();
				listeners.set(type, set);
			}
			set.add(fn);
		},
		close() {
			closed = true;
			es.readyState = 2;
			teardownNative();
		},
	};

	closeNative = bridge.openSse(url, {
		onOpen() {
			if (closed) return;
			es.readyState = 1;
			es.onopen?.();
		},
		onEvent(type, data) {
			if (closed) return;
			if (es.readyState === 0) es.readyState = 1;
			const set = listeners.get(type);
			if (!set) return;
			const event = { data };
			for (const fn of [...set]) fn(event);
		},
		onError(message) {
			if (closed) return;
			closed = true;
			es.readyState = 2;
			es.onerror?.(message !== undefined ? new Error(message) : new Event("error"));
		},
	});

	if (closed) teardownNative();
	return es;
}

/** 32 KiB chunks keep `String.fromCharCode.apply` well below JSC/V8 call-stack limits up to 20 MiB. */
const BASE64_CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	if (bytes.byteLength === 0) return "";
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_SIZE) {
		const slice = bytes.subarray(offset, Math.min(offset + BASE64_CHUNK_SIZE, bytes.byteLength));
		chunks.push(String.fromCharCode.apply(null, slice as unknown as number[]));
	}
	return btoa(chunks.join(""));
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	if (!base64) return new Uint8Array(new ArrayBuffer(0));
	const binary = atob(base64);
	const out = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

export async function blobToBase64(blob: Blob): Promise<string> {
	if (typeof blob.arrayBuffer === "function") {
		const buf = await blob.arrayBuffer();
		return bytesToBase64(new Uint8Array(buf));
	}
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (reader.result instanceof ArrayBuffer) {
				resolve(bytesToBase64(new Uint8Array(reader.result)));
			} else {
				reject(new Error("无法读取二进制数据"));
			}
		};
		reader.onerror = () => reject(reader.error ?? new Error("无法读取二进制数据"));
		reader.readAsArrayBuffer(blob);
	});
}

/** Auto-prefixes `https://` for bare hosts (`omp.example.com`), preserving explicit schemes so `http://` stays rejected. */
export function normalizeHttpsEndpointInput(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
}

/** Strict HTTPS-only validator for native endpoint URLs (hard-rejects plaintext http://). */
export function validateHttpsEndpoint(raw: string, label: string): string | null {
	const value = raw.trim();
	if (!value) return null;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return `${label}格式无效，请输入完整的 https:// 地址`;
	}
	if (parsed.protocol === "http:") {
		return `${label}禁止使用明文 http://，请填写 https:// 加密地址`;
	}
	if (parsed.protocol !== "https:") {
		return `${label}仅支持 https:// 加密地址`;
	}
	if (!parsed.hostname) {
		return `${label}缺少主机地址`;
	}
	if (parsed.username || parsed.password) {
		return `${label}不支持内嵌用户名或密码`;
	}
	return null;
}

const statusListeners = new Set<(status: NativeEndpointStatus) => void>();
let wiredBridge: NativeBridge | null = null;
let wiredUnsub: (() => void) | null = null;

function syncBridgeStatusSubscription(): void {
	const bridge = getNativeBridge();
	if (statusListeners.size === 0 || bridge !== wiredBridge) {
		wiredUnsub?.();
		wiredUnsub = null;
		wiredBridge = null;
	}
	if (statusListeners.size > 0 && bridge && wiredBridge !== bridge) {
		wiredBridge = bridge;
		wiredUnsub =
			bridge.onConnectionStatusChange?.((status) => {
				notifyNativeConnectionStatus(status);
			}) ?? null;
	}
}

/** Fan out updated native connection status to all subscribed views (e.g. App, ConnectionSheet). */
export function notifyNativeConnectionStatus(status: NativeEndpointStatus): void {
	for (const listener of [...statusListeners]) {
		try {
			listener(status);
		} catch (e) {
			console.error("[nativeBridge] connection status listener failed", e);
		}
	}
}

/** Subscribe to native connection status updates (wires `bridge.onConnectionStatusChange` at most once per bridge). */
export function subscribeNativeConnectionStatus(cb: (status: NativeEndpointStatus) => void): () => void {
	statusListeners.add(cb);
	syncBridgeStatusSubscription();
	return () => {
		statusListeners.delete(cb);
		syncBridgeStatusSubscription();
	};
}

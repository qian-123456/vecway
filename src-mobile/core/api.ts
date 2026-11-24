/**
 * HTTP transport of the phone app. Same-origin, cookie auth, `/api` prefix.
 * - 401 → connection store `unauthorized` (banner + no retries anywhere).
 * - Any other failure becomes an `ApiError{status,message}` with a user-facing message.
 * - Any 2xx clears a stale error banner.
 */
import { useConnection } from "./stores/connection";
import { acceptCatalogResponse, catalogGeneration, invalidateProviderCatalog } from "./modelCatalog";
import { base64ToBytes, blobToBase64, bytesToBase64, getNativeBridge, type NativeHttpResponse } from "./nativeBridge";

export class ApiError extends Error {
	readonly status: number;
	readonly data?: Record<string, unknown>;
	constructor(status: number, message: string, data?: Record<string, unknown>) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		if (data !== undefined) this.data = data;
	}
}

export interface ApiOptions {
	signal?: AbortSignal;
	/** Abort after this many ms (default 30 s). `0` disables the timeout. */
	timeoutMs?: number;
	headers?: Record<string, string>;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
/** For slow server work such as `/compact` (15 minutes). */
export const LONG_TIMEOUT_MS = 15 * 60_000;
export const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export const NETWORK_ERROR = "网络不可用，请检查与电脑的连接";
export const UNAUTHORIZED_ERROR = "配对已失效或被撤销，请在电脑上重新生成二维码配对。";

/** `/sessions` → `/api/sessions`; paths already starting with `/api/` are kept. */
export function apiUrl(path: string): string {
	if (path === "/api" || path.startsWith("/api/") || path.startsWith("/api?")) return path;
	return `/api${path.startsWith("/") ? "" : "/"}${path}`;
}

function markUnauthorized(): ApiError {
	useConnection.getState().setPhase("unauthorized", UNAUTHORIZED_ERROR);
	return new ApiError(401, "unauthorized");
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const utf8Encoder = new TextEncoder();
let nextNativeReqId = 0;

function createRequestId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `req-${Date.now()}-${++nextNativeReqId}`;
}

function createAbortError(): Error {
	if (typeof DOMException !== "undefined") {
		return new DOMException("The operation was aborted.", "AbortError");
	}
	const err = new Error("The operation was aborted.");
	err.name = "AbortError";
	return err;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	if (headers instanceof Headers) {
		headers.forEach((value, key) => {
			out[key] = value;
		});
	} else if (Array.isArray(headers)) {
		for (const [key, value] of headers) out[key] = value;
	} else {
		for (const [key, value] of Object.entries(headers)) {
			if (value !== undefined) out[key] = value;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

async function bodyToBase64(body: BodyInit | null | undefined): Promise<string | undefined> {
	if (body == null) return undefined;
	if (typeof body === "string") return bytesToBase64(utf8Encoder.encode(body));
	if (body instanceof Blob) return blobToBase64(body);
	if (body instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(body));
	if (ArrayBuffer.isView(body)) {
		return bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
	}
	throw new Error("不支持的请求体类型");
}

function nativeResponseToResponse(nativeRes: NativeHttpResponse): Response {
	if (nativeRes.status < 200 || nativeRes.status > 599) {
		throw new Error(NETWORK_ERROR);
	}
	const body = NULL_BODY_STATUSES.has(nativeRes.status)
		? null
		: nativeRes.bodyText !== undefined
			? nativeRes.bodyText
			: nativeRes.bodyBase64
				? base64ToBytes(nativeRes.bodyBase64)
				: null;
	return new Response(body, {
		status: nativeRes.status,
		headers: nativeRes.headers,
	});
}

async function send(url: string, init: RequestInit, opts: ApiOptions | undefined): Promise<Response> {
	const bridge = getNativeBridge();
	const ctl = new AbortController();
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timedOut = false;
	const timer = timeoutMs > 0 ? setTimeout(() => ((timedOut = true), ctl.abort()), timeoutMs) : 0;
	const outer = opts?.signal;
	const onAbort = () => ctl.abort();
	if (outer) {
		if (outer.aborted) ctl.abort();
		else outer.addEventListener("abort", onAbort, { once: true });
	}
	try {
		if (!bridge) {
			return await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal: ctl.signal });
		}
		if (ctl.signal.aborted) {
			throw outer?.aborted ? (outer.reason ?? createAbortError()) : createAbortError();
		}
		const bodyBase64 = await bodyToBase64(init.body);
		if (ctl.signal.aborted) {
			throw outer?.aborted ? (outer.reason ?? createAbortError()) : createAbortError();
		}
		const reqPromise = bridge.httpRequest(
			{
				id: createRequestId(),
				method: init.method ?? "GET",
				path: url,
				headers: normalizeHeaders(init.headers),
				bodyBase64,
				timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
			},
			ctl.signal,
		);
		reqPromise.catch(() => {});
		const nativeRes = await new Promise<NativeHttpResponse>((resolve, reject) => {
			const onSignalAbort = () => reject(outer?.aborted ? (outer.reason ?? createAbortError()) : createAbortError());
			if (ctl.signal.aborted) {
				onSignalAbort();
				return;
			}
			ctl.signal.addEventListener("abort", onSignalAbort, { once: true });
			reqPromise.then(
				(res) => {
					ctl.signal.removeEventListener("abort", onSignalAbort);
					resolve(res);
				},
				(err) => {
					ctl.signal.removeEventListener("abort", onSignalAbort);
					reject(err);
				},
			);
		});
		return nativeResponseToResponse(nativeRes);
	} catch (e) {
		if (outer?.aborted) throw e; // caller cancelled: let the AbortError through untouched
		const bridgeMsg = bridge && e instanceof Error && e.message ? e.message : NETWORK_ERROR;
		const err = new ApiError(timedOut ? 408 : 0, timedOut ? "请求超时" : bridgeMsg);
		useConnection.getState().setError(err.message);
		throw err;
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onAbort);
	}
}

async function readBody(res: Response): Promise<unknown> {
	if (res.status === 204) return null;
	const type = typeof res.headers?.get === "function" ? res.headers.get("content-type") || "" : "";
	try {
		if (type.includes("json")) return await res.json();
		if (typeof res.text === "function") {
			const text = await res.text();
			if (!type && text) {
				try {
					return JSON.parse(text);
				} catch {
					return text;
				}
			}
			return text;
		}
		if (typeof res.json === "function") return await res.json();
		return null;
	} catch {
		return null;
	}
}

function extractBodyError(data: unknown): string {
	if (!data || typeof data !== "object") return "";
	if ("error" in data) {
		const err = data.error;
		if (typeof err === "string" && err) return err;
		if (err && typeof err === "object" && "message" in err && typeof err.message === "string" && err.message) {
			return err.message;
		}
	}
	if ("message" in data && typeof data.message === "string" && data.message) return data.message;
	return "";
}

async function finish<T>(res: Response): Promise<T> {
	if (res.status === 401) throw markUnauthorized();
	const data = await readBody(res);
	if (!res.ok) {
		const fromBody = extractBodyError(data);
		const text = typeof data === "string" && data.length < 200 ? data.trim() : "";
		const objData =
			data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
		throw new ApiError(res.status, fromBody || text || res.statusText || `HTTP ${res.status}`, objData);
	}
	if (useConnection.getState().error) useConnection.getState().setError(null);
	return data as T;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, opts?: ApiOptions): Promise<T> {
	const requestGeneration = catalogGeneration();
	const headers: Record<string, string> = { ...opts?.headers };
	const init: RequestInit = { method, headers };
	if (body !== undefined) {
		headers["content-type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	const data = await finish<T>(await send(apiUrl(path), init, opts));
	if (method.toUpperCase() === "POST" && apiUrl(path).split("?")[0] === "/api/left/providers/save") {
		const id = (body as { id?: unknown } | undefined)?.id;
		if (typeof id === "string") invalidateProviderCatalog(id);
	}
	acceptCatalogResponse(data, requestGeneration);
	return data;
}

export interface UploadOptions extends ApiOptions {
	/** File name sent as `?name=`; defaults to the File's own name. */
	name?: string;
}

/** Raw-body upload (`POST /sessions/{id}/upload?name=` ≤ 20 MiB); resolves `{path,name,size}`. */
export async function upload<T = { path: string; name: string; size: number }>(
	path: string,
	file: Blob,
	opts: UploadOptions = {},
): Promise<T> {
	const name = opts.name || (file as File).name || "file";
	const sep = path.includes("?") ? "&" : "?";
	const url = `${apiUrl(path)}${sep}name=${encodeURIComponent(name)}`;
	return finish<T>(
		await send(
			url,
			{ method: "POST", headers: { "content-type": file.type || "application/octet-stream", ...opts.headers }, body: file },
			{ ...opts, timeoutMs: opts.timeoutMs ?? UPLOAD_TIMEOUT_MS },
		),
	);
}

/** Raw-body POST (e.g. `/voice/transcribe`); shares `api.ts` transport across web and native. */
export async function postRaw<T = unknown>(
	path: string,
	body: Blob,
	contentType: string,
	opts?: ApiOptions,
): Promise<T> {
	return finish<T>(
		await send(
			apiUrl(path),
			{
				method: "POST",
				headers: { "content-type": contentType || body.type || "application/octet-stream", ...opts?.headers },
				body,
			},
			opts,
		),
	);
}

/** True for a 401 (or the "unauthorized" sentinel) so callers can skip their own error UI. */
export const isUnauthorizedError = (e: unknown): boolean => e instanceof ApiError && e.status === 401;

/** User-facing text of any thrown value. */
export function errorMessage(e: unknown, fallback = "操作失败"): string {
	if (e instanceof ApiError) return e.status === 401 ? UNAUTHORIZED_ERROR : e.message || fallback;
	if (e instanceof Error) return e.message || fallback;
	return fallback;
}

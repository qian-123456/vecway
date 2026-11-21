package dev.vecway.mobile.web

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.vecway.mobile.audio.NativeVoiceRecorder
import dev.vecway.mobile.network.EndpointManager
import dev.vecway.mobile.network.EndpointUpdatePatch
import dev.vecway.mobile.network.NativeEndpointStatus
import dev.vecway.mobile.network.NativePinMismatch
import dev.vecway.mobile.network.PatchField
import dev.vecway.mobile.network.SSEBridge
import dev.vecway.mobile.network.SSEStreamListener
import dev.vecway.mobile.network.TransportException
import dev.vecway.mobile.push.NativePushManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

data class ScannerOutcome(
    val ok: Boolean,
    val error: String? = null,
    val status: NativeEndpointStatus? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("ok", ok)
        if (error != null) put("error", error)
        if (status != null) put("status", status.toJson())
    }
}

/** Pure JSON payload parsing helpers for the WebView bridge (unit-tested on JVM). */
object BridgePayloadParser {
    const val MAX_HTTP_BODY_BYTES = 25 * 1024 * 1024

    fun parseEndpointPatch(obj: JSONObject?): EndpointUpdatePatch {
        if (obj == null) return EndpointUpdatePatch()
        fun extract(key: String): PatchField {
            if (!obj.has(key)) return PatchField(present = false)
            if (obj.isNull(key)) return PatchField(present = true, value = null)
            return PatchField(present = true, value = obj.optString(key, ""))
        }
        return EndpointUpdatePatch(
            lanTls = extract("lanTls"),
            ipv6 = extract("ipv6"),
            tunnel = extract("tunnel"),
        )
    }

    fun decodeBodyBase64(bodyBase64: String?): ByteArray? {
        if (bodyBase64.isNullOrEmpty()) return null
        val decoded = try {
            Base64.getDecoder().decode(bodyBase64)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("请求体 Base64 编码无效")
        }
        if (decoded.size > MAX_HTTP_BODY_BYTES) {
            throw IllegalArgumentException("请求体超过大小限制")
        }
        return decoded
    }

    fun parseHeaders(obj: JSONObject?): Map<String, String>? {
        if (obj == null) return null
        val map = LinkedHashMap<String, String>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            if (!obj.isNull(k)) {
                map[k] = obj.optString(k, "")
            }
        }
        return map
    }

    fun escapeForJsEvaluation(json: String): String {
        return json
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
    }
}

/**
 * Android WebView bridge implementing the exact `window.__VECWAY_NATIVE__` protocol from
 * `src-mobile/core/nativeBridge.ts`.
 *
 * SECURITY:
 * - Never exposes `deviceToken` to JavaScript or WebStorage.
 * - Prefers `WebViewCompat.addWebMessageListener` (origin-locked in native Chromium to
 *   `https://appassets.androidplatform.net` + `isMainFrame == true`, invisible to sandboxed iframes).
 * - Falls back to `@JavascriptInterface` with main-thread origin validation only on legacy WebViews.
 */
class BridgeInterface(
    private val context: Context,
    private val endpointManager: EndpointManager,
    private val sseBridge: SSEBridge,
    private val voiceRecorder: NativeVoiceRecorder,
    private val pushManager: NativePushManager,
    private val openScannerHandler: suspend () -> ScannerOutcome,
    private val onThemeSchemeChanged: (String) -> Unit,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val activeHttpJobs = ConcurrentHashMap<String, Job>()

    @Volatile
    private var webView: WebView? = null

    /**
     * Attaches the bridge to `webView`.
     * Returns an inline fallback script string ONLY if `DOCUMENT_START_SCRIPT` is unavailable
     * on the device WebView; returns `null` when injected natively at document start.
     */
    fun attach(view: WebView, appVersion: String): String? {
        webView = view
        val useWebMessage = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        if (useWebMessage) {
            WebViewCompat.addWebMessageListener(
                view,
                WEB_MESSAGE_OBJECT_NAME,
                setOf(AppWebViewClient.APP_ORIGIN),
            ) { _, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame) return@addWebMessageListener
                if (sourceOrigin.toString().trimEnd('/') != AppWebViewClient.APP_ORIGIN) {
                    return@addWebMessageListener
                }
                val raw = message.data ?: return@addWebMessageListener
                handleRawMessage(raw)
            }
        } else {
            view.addJavascriptInterface(this, LEGACY_JS_INTERFACE_NAME)
        }

        val script = makeInjectionScript(appVersion = appVersion, useWebMessage = useWebMessage)
        return if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(
                view,
                script,
                setOf(AppWebViewClient.APP_ORIGIN),
            )
            null
        } else {
            script
        }
    }

    fun detach() {
        activeHttpJobs.values.forEach { it.cancel() }
        activeHttpJobs.clear()
        sseBridge.closeAll()
        webView = null
        scope.cancel()
    }

    /** Fallback entry point used ONLY when `WEB_MESSAGE_LISTENER` is unsupported on legacy WebViews. */
    @JavascriptInterface
    fun postMessage(rawJson: String?) {
        if (rawJson.isNullOrBlank()) return
        val view = webView ?: return
        view.post {
            val url = view.url.orEmpty()
            if (!url.startsWith(AppWebViewClient.APP_ORIGIN)) return@post
            handleRawMessage(rawJson)
        }
    }

    // MARK: - Native -> JS Push Notifications

    fun notifyConnectionStatus(status: NativeEndpointStatus) {
        dispatchToJs(
            JSONObject().apply {
                put("type", "connectionStatus")
                put("status", status.toJson())
            },
        )
    }

    fun notifyForegroundResync() {
        dispatchToJs(JSONObject().apply { put("type", "foregroundResync") })
    }

    fun applySafeAreaInsets(topDp: Float, bottomDp: Float) {
        val view = webView ?: return
        val topStr = String.format(java.util.Locale.US, "%.2fpx", topDp.coerceAtLeast(0f))
        val bottomStr = String.format(java.util.Locale.US, "%.2fpx", bottomDp.coerceAtLeast(0f))
        val js = """
            (function(){
              var r = document.documentElement;
              if (!r) return;
              r.style.setProperty('--m-safe-top', '$topStr');
              r.style.setProperty('--m-safe-bottom', '$bottomStr');
            })();
        """.trimIndent()
        view.post { view.evaluateJavascript(js, null) }
    }

    // MARK: - Message Dispatch

    private fun handleRawMessage(rawJson: String) {
        val payload = try {
            JSONObject(rawJson)
        } catch (_: Exception) {
            return
        }
        val action = payload.optString("action", "")
        if (action.isEmpty()) return
        val callId = payload.optString("callId", "").ifEmpty { null }

        when (action) {
            "httpRequest" -> {
                if (callId == null) return
                val reqObj = payload.optJSONObject("req")
                if (reqObj == null) {
                    replyError(callId, "无效的原生 HTTP 请求参数")
                    return
                }
                handleHttpRequest(callId, reqObj)
            }

            "httpCancel" -> {
                val reqId = payload.optString("reqId", "")
                if (reqId.isNotEmpty()) {
                    activeHttpJobs.remove(reqId)?.cancel()
                }
            }

            "sseOpen" -> {
                val streamId = payload.optString("streamId", "")
                val path = payload.optString("url", "")
                if (streamId.isNotEmpty() && path.isNotEmpty()) {
                    handleSseOpen(streamId, path)
                }
            }

            "sseClose" -> {
                val streamId = payload.optString("streamId", "")
                if (streamId.isNotEmpty()) {
                    sseBridge.close(streamId)
                }
            }

            "getConnectionStatus" -> {
                if (callId == null) return
                replyOk(callId, endpointManager.currentStatus().toJson())
            }

            "openPairScanner" -> {
                if (callId == null) return
                scope.launch {
                    val outcome = try {
                        openScannerHandler()
                    } catch (t: Throwable) {
                        ScannerOutcome(ok = false, error = t.message ?: "无法打开扫码器")
                    }
                    replyOk(callId, outcome.toJson())
                }
            }

            "updateEndpoints" -> {
                if (callId == null) return
                val patch = BridgePayloadParser.parseEndpointPatch(payload.optJSONObject("endpoints"))
                scope.launch {
                    try {
                        val status = endpointManager.updateEndpoints(patch)
                        replyOk(callId, status.toJson())
                    } catch (t: Throwable) {
                        replyError(callId, t.message ?: "更新连接地址失败")
                    }
                }
            }

            "reprobeConnection" -> {
                if (callId == null) return
                scope.launch {
                    val status = endpointManager.reprobeConnection()
                    replyOk(callId, status.toJson())
                }
            }

            "unpair" -> {
                if (callId == null) return
                scope.launch {
                    try {
                        endpointManager.unpair()
                        replyOk(callId, JSONObject.NULL)
                    } catch (t: Throwable) {
                        replyError(callId, t.message ?: "解除配对失败")
                    }
                }
            }

            "audioStart" -> {
                if (callId == null) return
                scope.launch {
                    try {
                        voiceRecorder.startRecording()
                        replyOk(callId, JSONObject.NULL)
                    } catch (t: Throwable) {
                        replyError(callId, t.message ?: "录音启动失败")
                    }
                }
            }

            "audioStopAndTranscribe" -> {
                if (callId == null) return
                scope.launch {
                    try {
                        val text = voiceRecorder.stopAndTranscribe()
                        replyOk(callId, JSONObject().apply { put("text", text) })
                    } catch (t: Throwable) {
                        replyError(callId, t.message ?: "语音转文字失败")
                    }
                }
            }

            "audioCancel" -> {
                if (callId == null) return
                voiceRecorder.cancelRecording()
                replyOk(callId, JSONObject.NULL)
            }

            "haptic" -> handleHaptic(payload)

            "pushGetStatus" -> {
                if (callId == null) return
                replyOk(callId, pushManager.getStatus().toJson())
            }

            "pushEnable" -> {
                if (callId == null) return
                try {
                    pushManager.enable()
                    replyOk(callId, JSONObject.NULL)
                } catch (t: Throwable) {
                    replyError(callId, t.message ?: "开启通知失败")
                }
            }

            "pushDisable" -> {
                if (callId == null) return
                pushManager.disable()
                replyOk(callId, JSONObject.NULL)
            }

            "syncSystemBars" -> {
                val scheme = payload.optString("scheme", "")
                if (scheme == "light" || scheme == "dark") {
                    onThemeSchemeChanged(scheme)
                }
            }

            else -> {
                if (callId != null) {
                    replyError(callId, "未知原生桥接操作：$action")
                }
            }
        }
    }

    private fun handleHttpRequest(callId: String, reqObj: JSONObject) {
        val reqId = reqObj.optString("id", "")
        val method = reqObj.optString("method", "")
        val path = reqObj.optString("path", "")
        if (reqId.isEmpty() || method.isEmpty() || path.isEmpty()) {
            replyError(callId, "无效的原生 HTTP 请求参数")
            return
        }
        val headers = BridgePayloadParser.parseHeaders(reqObj.optJSONObject("headers"))
        val timeoutMs = if (reqObj.has("timeoutMs") && !reqObj.isNull("timeoutMs")) {
            reqObj.optLong("timeoutMs", 30_000L).coerceAtLeast(1_000L)
        } else {
            30_000L
        }
        val bodyBytes = try {
            BridgePayloadParser.decodeBodyBase64(reqObj.optString("bodyBase64", "").ifEmpty { null })
        } catch (e: IllegalArgumentException) {
            replyError(callId, e.message ?: "请求体无效")
            return
        }

        activeHttpJobs.remove(reqId)?.cancel()
        val job = scope.launch {
            try {
                val response = endpointManager.performRequest(
                    method = method,
                    path = path,
                    headers = headers,
                    body = bodyBytes,
                    timeoutMs = timeoutMs,
                )
                val headersJson = JSONObject()
                response.headers.forEach { (k, v) -> headersJson.put(k, v) }
                val resJson = JSONObject().apply {
                    put("status", response.status)
                    put("headers", headersJson)
                    put("bodyBase64", Base64.getEncoder().encodeToString(response.body))
                }
                replyOk(callId, resJson)
            } catch (_: CancellationException) {
                replyError(callId, "Aborted", name = "AbortError")
            } catch (e: TransportException.Cancelled) {
                replyError(callId, "Aborted", name = "AbortError")
            } catch (t: Throwable) {
                replyError(callId, t.message ?: "请求失败")
            } finally {
                activeHttpJobs.remove(reqId)
            }
        }
        activeHttpJobs[reqId] = job
    }

    private fun handleSseOpen(streamId: String, path: String) {
        scope.launch {
            val status = endpointManager.currentStatus()
            status.pinMismatch?.let { mismatch ->
                dispatchSseError(streamId, TransportException.PinMismatch(mismatch).message ?: "证书指纹不匹配")
                return@launch
            }
            if (!status.paired) {
                dispatchSseError(streamId, "尚未配对电脑")
                return@launch
            }

            val route = try {
                endpointManager.resolveActiveRoute()
            } catch (e: TransportException.PinMismatch) {
                dispatchSseError(streamId, e.message ?: "证书指纹不匹配")
                return@launch
            } catch (t: Throwable) {
                dispatchSseError(streamId, t.message ?: "无法连接到电脑上的 Vecway 服务")
                return@launch
            }

            sseBridge.open(
                streamId = streamId,
                baseUrl = route.baseUrl,
                channel = route.channel,
                path = path,
                bearerToken = route.bearerToken,
                pinnedCertSha256 = route.pinnedCertSha256,
                listener = object : SSEStreamListener {
                    override fun onOpen(streamId: String) {
                        dispatchToJs(
                            JSONObject().apply {
                                put("type", "sse")
                                put("streamId", streamId)
                                put("kind", "open")
                            },
                        )
                    }

                    override fun onEvent(streamId: String, type: String, data: String) {
                        dispatchToJs(
                            JSONObject().apply {
                                put("type", "sse")
                                put("streamId", streamId)
                                put("kind", "event")
                                put("eventType", type)
                                put("data", data)
                            },
                        )
                    }

                    override fun onError(streamId: String, message: String) {
                        dispatchSseError(streamId, message)
                    }

                    override fun onUnauthorized(streamId: String) {
                        endpointManager.markUnauthorizedFromStream()
                    }

                    override fun onPinMismatch(streamId: String, mismatch: NativePinMismatch) {
                        endpointManager.markPinMismatchFromStream(mismatch)
                    }
                },
            )
        }
    }

    private fun handleHaptic(payload: JSONObject) {
        val vibrator = resolveVibrator() ?: return
        if (!vibrator.hasVibrator()) return
        val kind = payload.optString("kind", "")
        runCatching {
            val effect = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                when (kind) {
                    "impact" -> when (payload.optString("style", "light")) {
                        "heavy" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK)
                        "medium" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
                        else -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
                    }
                    "notification" -> when (payload.optString("notificationType", "success")) {
                        "error" -> VibrationEffect.createWaveform(longArrayOf(0, 28, 45, 28), intArrayOf(0, 180, 0, 220), -1)
                        "warning" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK)
                        else -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
                    }
                    "selection" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
                    else -> null
                }
            } else {
                when (kind) {
                    "impact" -> when (payload.optString("style", "light")) {
                        "heavy" -> VibrationEffect.createOneShot(24, 220)
                        "medium" -> VibrationEffect.createOneShot(16, 160)
                        else -> VibrationEffect.createOneShot(10, 100)
                    }
                    "notification" -> when (payload.optString("notificationType", "success")) {
                        "error" -> VibrationEffect.createWaveform(longArrayOf(0, 28, 45, 28), -1)
                        "warning" -> VibrationEffect.createOneShot(20, 180)
                        else -> VibrationEffect.createOneShot(14, 150)
                    }
                    "selection" -> VibrationEffect.createOneShot(8, 80)
                    else -> null
                }
            }
            if (effect != null) {
                vibrator.vibrate(effect)
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun resolveVibrator(): Vibrator? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    // MARK: - JS Dispatch Helpers

    private fun dispatchSseError(streamId: String, message: String) {
        dispatchToJs(
            JSONObject().apply {
                put("type", "sse")
                put("streamId", streamId)
                put("kind", "error")
                put("message", message)
            },
        )
    }

    private fun replyOk(callId: String, value: Any) {
        dispatchToJs(
            JSONObject().apply {
                put("type", "reply")
                put("callId", callId)
                put("ok", true)
                put("value", value)
            },
        )
    }

    private fun replyError(callId: String, message: String, name: String = "Error") {
        dispatchToJs(
            JSONObject().apply {
                put("type", "reply")
                put("callId", callId)
                put("ok", false)
                put(
                    "error",
                    JSONObject().apply {
                        put("name", name)
                        put("message", message)
                    },
                )
            },
        )
    }

    private fun dispatchToJs(payload: JSONObject) {
        val view = webView ?: return
        val escaped = BridgePayloadParser.escapeForJsEvaluation(payload.toString())
        val js = "window.__VECWAY_NATIVE_DISPATCH__ && window.__VECWAY_NATIVE_DISPATCH__($escaped);"
        view.post {
            view.evaluateJavascript(js, null)
        }
    }

    companion object {
        const val WEB_MESSAGE_OBJECT_NAME = "__vecwayAndroidBridge"
        const val LEGACY_JS_INTERFACE_NAME = "__vecwayAndroidLegacyBridge"

        fun makeInjectionScript(appVersion: String, useWebMessage: Boolean): String {
            val escapedVersion = appVersion
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
            val postBody = if (useWebMessage) {
                """
                var host = window.$WEB_MESSAGE_OBJECT_NAME;
                if (!host || typeof host.postMessage !== "function") {
                  throw new Error("Vecway native bridge unavailable");
                }
                host.postMessage(JSON.stringify(msg));
                """.trimIndent()
            } else {
                """
                var host = window.$LEGACY_JS_INTERFACE_NAME;
                if (!host || typeof host.postMessage !== "function") {
                  throw new Error("Vecway native bridge unavailable");
                }
                host.postMessage(JSON.stringify(msg));
                """.trimIndent()
            }

            return """
                (function () {
                  if (window.__VECWAY_NATIVE__) return;

                  var rpcSeq = 0;
                  var sseSeq = 0;
                  var pending = new Map();
                  var sseStreams = new Map();
                  var statusListeners = new Set();
                  var foregroundListeners = new Set();

                  function post(msg) {
                    $postBody
                  }

                  function makeAbortError() {
                    var err = new Error("Aborted");
                    err.name = "AbortError";
                    return err;
                  }

                  function callNative(action, payload, options) {
                    return new Promise(function (resolve, reject) {
                      var signal = options && options.signal;
                      if (signal && signal.aborted) {
                        reject(makeAbortError());
                        return;
                      }

                      var callId = "rpc_" + (++rpcSeq);
                      var onAbort = null;
                      function cleanup() {
                        if (signal && onAbort) {
                          signal.removeEventListener("abort", onAbort);
                        }
                      }

                      pending.set(callId, {
                        resolve: function (val) {
                          cleanup();
                          resolve(val);
                        },
                        reject: function (err) {
                          cleanup();
                          reject(err);
                        }
                      });

                      if (signal) {
                        onAbort = function () {
                          if (pending.delete(callId)) {
                            cleanup();
                            if (options && options.cancelReqId) {
                              try { post({ action: "httpCancel", reqId: options.cancelReqId }); } catch (_) {}
                            }
                            reject(makeAbortError());
                          }
                        };
                        signal.addEventListener("abort", onAbort, { once: true });
                      }

                      try {
                        var body = Object.assign({ action: action, callId: callId }, payload || {});
                        post(body);
                      } catch (err) {
                        pending.delete(callId);
                        cleanup();
                        reject(err);
                      }
                    });
                  }

                  Object.defineProperty(window, "__VECWAY_NATIVE_DISPATCH__", {
                    value: function (msg) {
                      if (!msg || typeof msg !== "object") return;
                      if (msg.type === "reply") {
                        var entry = pending.get(msg.callId);
                        if (!entry) return;
                        pending.delete(msg.callId);
                        if (msg.ok) {
                          entry.resolve(msg.value);
                        } else {
                          var info = msg.error || {};
                          var err = new Error(info.message || "Native bridge error");
                          if (info.name) err.name = info.name;
                          entry.reject(err);
                        }
                        return;
                      }
                      if (msg.type === "sse") {
                        var handlers = sseStreams.get(msg.streamId);
                        if (!handlers) return;
                        if (msg.kind === "open") {
                          if (typeof handlers.onOpen === "function") handlers.onOpen();
                        } else if (msg.kind === "event") {
                          if (typeof handlers.onEvent === "function") handlers.onEvent(msg.eventType || "message", msg.data || "");
                        } else if (msg.kind === "error") {
                          if (typeof handlers.onError === "function") handlers.onError(msg.message);
                        }
                        return;
                      }
                      if (msg.type === "connectionStatus") {
                        statusListeners.forEach(function (cb) {
                          try { cb(msg.status); } catch (_) {}
                        });
                        return;
                      }
                      if (msg.type === "foregroundResync") {
                        foregroundListeners.forEach(function (cb) {
                          try { cb(); } catch (_) {}
                        });
                      }
                    },
                    writable: false,
                    configurable: false,
                    enumerable: false
                  });

                  var bridge = Object.freeze({
                    platform: "android",
                    appVersion: "$escapedVersion",
                    httpRequest: function (req, signal) {
                      var reqId = (req && req.id) ? String(req.id) : ("req_" + (++rpcSeq));
                      var normalizedReq = Object.assign({}, req, { id: reqId });
                      return callNative("httpRequest", { req: normalizedReq }, { signal: signal, cancelReqId: reqId });
                    },
                    openSse: function (url, handlers) {
                      var streamId = "sse_" + (++sseSeq);
                      sseStreams.set(streamId, handlers || {});
                      var closed = false;
                      try {
                        post({ action: "sseOpen", streamId: streamId, url: String(url || "") });
                      } catch (err) {
                        sseStreams.delete(streamId);
                        if (handlers && typeof handlers.onError === "function") {
                          handlers.onError(err && err.message ? err.message : "SSE start failed");
                        }
                      }
                      return function close() {
                        if (closed) return;
                        closed = true;
                        sseStreams.delete(streamId);
                        try { post({ action: "sseClose", streamId: streamId }); } catch (_) {}
                      };
                    },
                    getConnectionStatus: function () {
                      return callNative("getConnectionStatus");
                    },
                    openPairScanner: function () {
                      return callNative("openPairScanner");
                    },
                    updateEndpoints: function (endpoints) {
                      return callNative("updateEndpoints", { endpoints: endpoints || {} });
                    },
                    reprobeConnection: function () {
                      return callNative("reprobeConnection");
                    },
                    unpair: function () {
                      return callNative("unpair");
                    },
                    onConnectionStatusChange: function (cb) {
                      if (typeof cb !== "function") return function () {};
                      statusListeners.add(cb);
                      return function () { statusListeners.delete(cb); };
                    },
                    onForegroundResync: function (cb) {
                      if (typeof cb !== "function") return function () {};
                      foregroundListeners.add(cb);
                      return function () { foregroundListeners.delete(cb); };
                    },
                    audio: Object.freeze({
                      startRecording: function () { return callNative("audioStart"); },
                      stopAndTranscribe: function () { return callNative("audioStopAndTranscribe"); },
                      cancelRecording: function () { return callNative("audioCancel"); }
                    }),
                    haptics: Object.freeze({
                      impact: function (style) {
                        try { post({ action: "haptic", kind: "impact", style: style || "light" }); } catch (_) {}
                      },
                      notification: function (type) {
                        try { post({ action: "haptic", kind: "notification", notificationType: type || "success" }); } catch (_) {}
                      },
                      selection: function () {
                        try { post({ action: "haptic", kind: "selection" }); } catch (_) {}
                      }
                    }),
                    push: Object.freeze({
                      getStatus: function () { return callNative("pushGetStatus"); },
                      enable: function () { return callNative("pushEnable"); },
                      disable: function () { return callNative("pushDisable"); }
                    })
                  });

                  Object.defineProperty(window, "__VECWAY_NATIVE__", {
                    value: bridge,
                    writable: false,
                    configurable: false,
                    enumerable: true
                  });

                  // Observe <html data-scheme> so Android status/nav bar icons track in-app theme switches.
                  function syncBars() {
                    try {
                      var root = document.documentElement;
                      var scheme = root && root.dataset && root.dataset.scheme;
                      if (scheme === "light" || scheme === "dark") {
                        post({ action: "syncSystemBars", scheme: scheme });
                      }
                    } catch (_) {}
                  }
                  if (typeof MutationObserver !== "undefined") {
                    var attachObserver = function () {
                      if (!document.documentElement) return;
                      syncBars();
                      new MutationObserver(syncBars).observe(document.documentElement, {
                        attributes: true,
                        attributeFilter: ["data-scheme"]
                      });
                    };
                    if (document.documentElement) {
                      attachObserver();
                    } else {
                      document.addEventListener("DOMContentLoaded", attachObserver, { once: true });
                    }
                  }
                })();
            """.trimIndent()
        }
    }
}

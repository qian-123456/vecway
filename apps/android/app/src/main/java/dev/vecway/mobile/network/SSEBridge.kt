package dev.vecway.mobile.network

import dev.vecway.mobile.security.NativeChannel
import okhttp3.Call
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Parsed Server-Sent Event frame. */
data class SSEEvent(
    val type: String,
    val data: String,
)

/**
 * Streaming WHATWG SSE frame parser handling arbitrary TCP chunk boundaries,
 * multibyte UTF-8 split protection, `\r\n`/`\n`/`\r` endings, comments, and multi-line `data:`.
 */
class SSELineParser {
    private val lineBuffer = ByteArrayOutputStream()
    private var pendingCR = false
    private var eventType: String? = null
    private val dataLines = mutableListOf<String>()
    private var hasData = false
    private var sawBOM = false

    fun append(chunk: ByteArray, length: Int = chunk.size): List<SSEEvent> {
        val events = mutableListOf<SSEEvent>()
        var start = 0
        if (!sawBOM) {
            sawBOM = true
            if (length >= 3 &&
                (chunk[0].toInt() and 0xFF) == 0xEF &&
                (chunk[1].toInt() and 0xFF) == 0xBB &&
                (chunk[2].toInt() and 0xFF) == 0xBF
            ) {
                start = 3
            }
        }

        for (i in start until length) {
            val b = chunk[i].toInt() and 0xFF
            if (pendingCR) {
                pendingCR = false
                if (b == 0x0A) continue
            }
            when (b) {
                0x0D -> {
                    pendingCR = true
                    processLineBuffer()?.let(events::add)
                }
                0x0A -> {
                    processLineBuffer()?.let(events::add)
                }
                else -> lineBuffer.write(b)
            }
        }
        return events
    }

    fun append(text: String): List<SSEEvent> = append(text.toByteArray(StandardCharsets.UTF_8))

    fun reset() {
        lineBuffer.reset()
        pendingCR = false
        eventType = null
        dataLines.clear()
        hasData = false
        sawBOM = false
    }

    private fun processLineBuffer(): SSEEvent? {
        val line = String(lineBuffer.toByteArray(), StandardCharsets.UTF_8)
        lineBuffer.reset()

        if (line.isEmpty()) {
            if (!hasData) {
                eventType = null
                return null
            }
            val dispatched = SSEEvent(
                type = eventType ?: "message",
                data = dataLines.joinToString("\n"),
            )
            eventType = null
            dataLines.clear()
            hasData = false
            return dispatched
        }

        if (line.startsWith(":")) return null

        val colonIdx = line.indexOf(':')
        val field: String
        val value: String
        if (colonIdx >= 0) {
            field = line.substring(0, colonIdx)
            val raw = line.substring(colonIdx + 1)
            value = if (raw.startsWith(" ")) raw.substring(1) else raw
        } else {
            field = line
            value = ""
        }

        when (field) {
            "event" -> eventType = value
            "data" -> {
                dataLines.add(value)
                hasData = true
            }
            "id", "retry" -> Unit
        }
        return null
    }
}

interface SSEStreamListener {
    fun onOpen(streamId: String)
    fun onEvent(streamId: String, type: String, data: String)
    fun onError(streamId: String, message: String)
    fun onUnauthorized(streamId: String)
    fun onPinMismatch(streamId: String, mismatch: NativePinMismatch)
}

/**
 * Manages concurrent native SSE streams (`/api/events` and `/api/terminal/{id}/stream`)
 * over OkHttp with the exact same leaf DER SHA-256 pinning rules as `PinnedTransport`.
 */
class SSEBridge(
    private val transport: HttpTransport,
    private val userAgent: String = "Vecway-Android/0.2.0",
) {
    private class ActiveStream(
        val cancelled: AtomicBoolean = AtomicBoolean(false),
        val callRef: AtomicReference<Call?> = AtomicReference(null),
    ) {
        fun cancel() {
            cancelled.set(true)
            callRef.getAndSet(null)?.cancel()
        }
    }

    private val executor: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "vecway-sse").apply { isDaemon = true }
    }
    private val streams = ConcurrentHashMap<String, ActiveStream>()

    fun open(
        streamId: String,
        baseUrl: String,
        channel: NativeChannel,
        path: String,
        bearerToken: String,
        pinnedCertSha256: String?,
        listener: SSEStreamListener,
    ) {
        close(streamId)
        val active = ActiveStream()
        streams[streamId] = active

        executor.execute {
            val mismatchSink = AtomicReference<NativePinMismatch?>(null)
            try {
                val fullUrl = PinnedTransport.resolveRequestUrl(baseUrl, path)
                val client = transport.buildClient(
                    baseUrl = baseUrl,
                    channel = channel,
                    pinnedCertSha256 = pinnedCertSha256,
                    connectTimeoutMs = 10_000L,
                    readTimeoutMs = 0L, // Infinite read timeout for SSE streams.
                    mismatchSink = mismatchSink,
                )
                val headers = HeaderSanitizer.sanitize(
                    headers = mapOf(
                        "Accept" to "text/event-stream",
                        "Cache-Control" to "no-cache",
                    ),
                    bearerToken = bearerToken,
                    userAgent = userAgent,
                )
                val reqBuilder = Request.Builder().url(fullUrl).get()
                headers.forEach { (k, v) -> reqBuilder.header(k, v) }

                val call = client.newCall(reqBuilder.build())
                active.callRef.set(call)
                if (active.cancelled.get()) {
                    call.cancel()
                    return@execute
                }

                call.execute().use { response ->
                    if (active.cancelled.get()) return@execute
                    if (response.code == 401) {
                        listener.onUnauthorized(streamId)
                        listener.onError(streamId, "配对已失效或被撤销")
                        return@execute
                    }
                    if (response.code !in 200..299) {
                        listener.onError(streamId, "SSE 连接失败（HTTP ${response.code}）")
                        return@execute
                    }
                    listener.onOpen(streamId)
                    val bodyStream = response.body?.byteStream()
                    if (bodyStream == null) {
                        listener.onError(streamId, "SSE 响应体为空")
                        return@execute
                    }
                    val parser = SSELineParser()
                    val buf = ByteArray(8192)
                    while (!active.cancelled.get()) {
                        val read = bodyStream.read(buf)
                        if (read < 0) break
                        if (read == 0) continue
                        val events = parser.append(buf, read)
                        for (ev in events) {
                            if (active.cancelled.get()) break
                            listener.onEvent(streamId, ev.type, ev.data)
                        }
                    }
                    if (!active.cancelled.get()) {
                        listener.onError(streamId, "实时连接已断开")
                    }
                }
            } catch (t: Throwable) {
                if (active.cancelled.get()) return@execute
                val mismatch = mismatchSink.get() ?: (t as? TransportException.PinMismatch)?.mismatch
                if (mismatch != null) {
                    listener.onPinMismatch(streamId, mismatch)
                    listener.onError(streamId, TransportException.PinMismatch(mismatch).message ?: "证书指纹不匹配")
                } else {
                    listener.onError(streamId, t.message ?: "实时连接中断")
                }
            } finally {
                streams.remove(streamId, active)
            }
        }
    }

    fun close(streamId: String) {
        streams.remove(streamId)?.cancel()
    }

    fun closeAll() {
        val ids = streams.keys.toList()
        ids.forEach(::close)
    }
}

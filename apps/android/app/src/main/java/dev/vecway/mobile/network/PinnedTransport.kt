package dev.vecway.mobile.network

import dev.vecway.mobile.security.CertificateFingerprint
import dev.vecway.mobile.security.NativeChannel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Structured TLS certificate pin mismatch payload shared with the WebView bridge & hard-block UI. */
data class NativePinMismatch(
    val expectedSha256: String,
    val actualSha256: String,
    val host: String,
    val channel: NativeChannel,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("expectedSha256", expectedSha256)
        put("actualSha256", actualSha256)
        put("host", host)
        put("channel", channel.wireValue)
    }
}

sealed class TransportException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    class PlaintextForbidden(val url: String) :
        TransportException("安全拦截：禁止通过明文 HTTP 发送请求或凭据")

    class InvalidUrl(val raw: String) :
        TransportException("无效的请求地址：$raw")

    class MissingCertificatePin(val channel: NativeChannel) :
        TransportException("安全拦截：${channel.displayName} 缺少已锁定的证书指纹")

    class InvalidCertificatePin :
        TransportException("本地锁定的证书指纹格式无效，请重新扫码配对")

    class PinMismatch(val mismatch: NativePinMismatch) :
        TransportException("安全警告：服务器证书指纹不匹配（${mismatch.host}）")

    class Unpaired :
        TransportException("尚未配对电脑，请先扫码配对")

    class Unreachable(reason: String, cause: Throwable? = null) :
        TransportException(reason.ifBlank { "无法连接到电脑上的 Vecway 服务" }, cause)

    class HttpError(val status: Int, reason: String) :
        TransportException(reason.ifBlank { "服务器返回错误（HTTP $status）" })

    class InvalidResponse :
        TransportException("服务器返回了无法解析的响应")

    class Cancelled :
        TransportException("请求已取消")
}

data class TransportResponse(
    val status: Int,
    val headers: Map<String, String>,
    val body: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is TransportResponse) return false
        return status == other.status && headers == other.headers && body.contentEquals(other.body)
    }

    override fun hashCode(): Int {
        var result = status
        result = 31 * result + headers.hashCode()
        result = 31 * result + body.contentHashCode()
        return result
    }
}

data class PairedDeviceInfo(
    val id: String? = null,
    val name: String? = null,
)

data class PairExchangeResponse(
    val token: String,
    val device: PairedDeviceInfo? = null,
)

/**
 * Pure header sanitization and native credential / User-Agent injection.
 * Strips browser CSRF headers (`Origin`, `Referer`, `Cookie`, `Sec-Fetch-*`) and caller `Authorization`/`User-Agent`.
 */
object HeaderSanitizer {
    private val STRIPPED_EXACT = setOf(
        "origin",
        "referer",
        "cookie",
        "authorization",
        "host",
        "user-agent",
    )

    fun sanitize(
        headers: Map<String, String>?,
        bearerToken: String?,
        userAgent: String,
    ): Map<String, String> {
        val result = LinkedHashMap<String, String>()
        headers?.forEach { (key, value) ->
            val lower = key.lowercase()
            if (lower in STRIPPED_EXACT || lower.startsWith("sec-fetch-")) return@forEach
            result[key] = value
        }
        result["User-Agent"] = userAgent
        if (!bearerToken.isNullOrEmpty()) {
            result["Authorization"] = "Bearer $bearerToken"
        }
        return result
    }
}

interface HttpTransport {
    suspend fun request(
        baseUrl: String,
        channel: NativeChannel,
        method: String,
        path: String,
        headers: Map<String, String>?,
        body: ByteArray?,
        bearerToken: String?,
        pinnedCertSha256: String?,
        timeoutMs: Long,
    ): TransportResponse

    suspend fun exchangePairingCode(
        baseUrl: String,
        channel: NativeChannel,
        code: String,
        pinnedCertSha256: String?,
        deviceName: String?,
        timeoutMs: Long,
    ): PairExchangeResponse

    fun buildClient(
        baseUrl: String,
        channel: NativeChannel,
        pinnedCertSha256: String?,
        connectTimeoutMs: Long,
        readTimeoutMs: Long,
        mismatchSink: AtomicReference<NativePinMismatch?>,
    ): OkHttpClient
}

/**
 * Dual-mode HTTPS transport built on OkHttp:
 * - `lan_tls` / `ipv6_tls`: strict leaf-certificate DER SHA-256 pinning (zero trust-all, hard-blocks on mismatch).
 * - `tunnel`: stock system CA trust store & standard hostname verification (never uses pinned TrustManager).
 * - Hard-rejects all `http://` plaintext endpoints before opening any socket.
 */
class PinnedTransport(
    private val userAgent: String = "Vecway-Android/0.2.0",
) : HttpTransport {

    /** Shared stock client for Cloudflare Tunnel (system roots only, no custom TrustManager). */
    private val systemBaseClient: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .build()

    override fun buildClient(
        baseUrl: String,
        channel: NativeChannel,
        pinnedCertSha256: String?,
        connectTimeoutMs: Long,
        readTimeoutMs: Long,
        mismatchSink: AtomicReference<NativePinMismatch?>,
    ): OkHttpClient {
        val uri = requireHttpsUri(baseUrl)
        val host = uri.host ?: throw TransportException.InvalidUrl(baseUrl)

        if (!channel.requiresCertificatePin) {
            return systemBaseClient.newBuilder()
                .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
                .readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS)
                .writeTimeout(readTimeoutMs.coerceAtLeast(30_000L), TimeUnit.MILLISECONDS)
                .build()
        }

        val expectedFp = pinnedCertSha256?.trim()?.takeIf { it.isNotEmpty() }
            ?: throw TransportException.MissingCertificatePin(channel)
        val expectedDigest = CertificateFingerprint.parse(expectedFp)
            ?: throw TransportException.InvalidCertificatePin()

        val trustManager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit

            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val leaf = chain?.firstOrNull()
                    ?: throw CertificateException("Empty peer certificate chain")
                val actualDigest = CertificateFingerprint.sha256(leaf.encoded)
                if (!CertificateFingerprint.constantTimeEquals(actualDigest, expectedDigest)) {
                    val actualFp = CertificateFingerprint.format(actualDigest)
                    mismatchSink.compareAndSet(
                        null,
                        NativePinMismatch(
                            expectedSha256 = expectedFp,
                            actualSha256 = actualFp,
                            host = host,
                            channel = channel,
                        ),
                    )
                    throw CertificateException("Certificate SHA-256 pin mismatch")
                }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }

        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
        }

        // Defense-in-depth HostnameVerifier: re-verifies the negotiated peer leaf cert matches the pinned SHA-256.
        // LAN IPv4 addresses are intentionally excluded from SANs so switching Wi-Fi IPs does not rotate the cert.
        val pinnedHostnameVerifier = HostnameVerifier { _, session ->
            val leaf = session.peerCertificates?.firstOrNull() as? X509Certificate ?: return@HostnameVerifier false
            val actualDigest = CertificateFingerprint.sha256(leaf.encoded)
            val ok = CertificateFingerprint.constantTimeEquals(actualDigest, expectedDigest)
            if (!ok) {
                mismatchSink.compareAndSet(
                    null,
                    NativePinMismatch(
                        expectedSha256 = expectedFp,
                        actualSha256 = CertificateFingerprint.format(actualDigest),
                        host = host,
                        channel = channel,
                    ),
                )
            }
            ok
        }

        return systemBaseClient.newBuilder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .hostnameVerifier(pinnedHostnameVerifier)
            .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS)
            .writeTimeout(readTimeoutMs.coerceAtLeast(30_000L), TimeUnit.MILLISECONDS)
            .build()
    }

    override suspend fun request(
        baseUrl: String,
        channel: NativeChannel,
        method: String,
        path: String,
        headers: Map<String, String>?,
        body: ByteArray?,
        bearerToken: String?,
        pinnedCertSha256: String?,
        timeoutMs: Long,
    ): TransportResponse = withContext(Dispatchers.IO) {
        val fullUrl = resolveRequestUrl(baseUrl, path)
        val mismatchSink = AtomicReference<NativePinMismatch?>(null)
        val effectiveTimeout = if (timeoutMs <= 0L) 0L else timeoutMs
        val connectTimeout = if (effectiveTimeout > 0L) effectiveTimeout.coerceAtMost(10_000L) else 10_000L
        val client = buildClient(
            baseUrl = baseUrl,
            channel = channel,
            pinnedCertSha256 = pinnedCertSha256,
            connectTimeoutMs = connectTimeout,
            readTimeoutMs = effectiveTimeout,
            mismatchSink = mismatchSink,
        )

        val sanitized = HeaderSanitizer.sanitize(headers, bearerToken, userAgent)
        val upperMethod = method.uppercase()
        val contentType = sanitized.entries.firstOrNull { it.key.equals("content-type", ignoreCase = true) }?.value
        val requestBody = when {
            body != null -> body.toRequestBody(contentType?.toMediaTypeOrNull())
            upperMethod == "POST" || upperMethod == "PUT" || upperMethod == "PATCH" ->
                ByteArray(0).toRequestBody(contentType?.toMediaTypeOrNull())
            else -> null
        }

        val reqBuilder = Request.Builder().url(fullUrl).method(upperMethod, requestBody)
        sanitized.forEach { (k, v) -> reqBuilder.header(k, v) }

        val call = client.newCall(reqBuilder.build())
        try {
            val response = call.await()
            response.use { res ->
                val resHeaders = LinkedHashMap<String, String>()
                for (name in res.headers.names()) {
                    resHeaders[name.lowercase()] = res.headers.values(name).joinToString(", ")
                }
                val bytes = res.body?.bytes() ?: ByteArray(0)
                TransportResponse(status = res.code, headers = resHeaders, body = bytes)
            }
        } catch (t: Throwable) {
            mismatchSink.get()?.let { throw TransportException.PinMismatch(it) }
            if (t is TransportException) throw t
            if (call.isCanceled()) throw TransportException.Cancelled()
            throw TransportException.Unreachable(t.message ?: "网络连接失败", t)
        }
    }

    override suspend fun exchangePairingCode(
        baseUrl: String,
        channel: NativeChannel,
        code: String,
        pinnedCertSha256: String?,
        deviceName: String?,
        timeoutMs: Long,
    ): PairExchangeResponse {
        val payload = JSONObject().apply {
            put("code", code)
            if (!deviceName.isNullOrBlank()) put("deviceName", deviceName)
        }
        val response = request(
            baseUrl = baseUrl,
            channel = channel,
            method = "POST",
            path = "/pair?json=1&returnToken=true",
            headers = mapOf("Content-Type" to "application/json", "Accept" to "application/json"),
            body = payload.toString().toByteArray(Charsets.UTF_8),
            bearerToken = null,
            pinnedCertSha256 = pinnedCertSha256,
            timeoutMs = timeoutMs,
        )
        if (response.status !in 200..299) {
            val message = extractErrorMessage(response.body) ?: "配对失败（HTTP ${response.status}）"
            throw TransportException.HttpError(response.status, message)
        }
        val json = try {
            JSONObject(String(response.body, Charsets.UTF_8))
        } catch (_: Exception) {
            throw TransportException.InvalidResponse()
        }
        val token = json.optString("token", "")
        if (token.isBlank()) throw TransportException.InvalidResponse()
        val devObj = json.optJSONObject("device")
        val device = if (devObj != null) {
            PairedDeviceInfo(
                id = devObj.optString("id", "").ifBlank { null },
                name = devObj.optString("name", "").ifBlank { null },
            )
        } else {
            null
        }
        return PairExchangeResponse(token = token, device = device)
    }

    companion object {
        fun requireHttpsUri(rawUrl: String): URI {
            val trimmed = rawUrl.trim()
            val uri = try {
                URI(trimmed)
            } catch (_: Exception) {
                throw TransportException.InvalidUrl(rawUrl)
            }
            val scheme = uri.scheme?.lowercase()
            if (scheme == "http") throw TransportException.PlaintextForbidden(rawUrl)
            if (scheme != "https" || uri.host.isNullOrBlank()) throw TransportException.InvalidUrl(rawUrl)
            return uri
        }

        fun resolveRequestUrl(baseUrl: String, path: String): String {
            requireHttpsUri(baseUrl)
            val normalizedBase = baseUrl.trim().trimEnd('/')
            val trimmedPath = path.trim()
            if (trimmedPath.startsWith("http://", ignoreCase = true)) {
                throw TransportException.PlaintextForbidden(trimmedPath)
            }
            if (trimmedPath.startsWith("https://", ignoreCase = true)) {
                throw TransportException.InvalidUrl(trimmedPath)
            }
            val normalizedPath = if (trimmedPath.startsWith("/")) trimmedPath else "/$trimmedPath"
            return "$normalizedBase$normalizedPath"
        }

        private fun extractErrorMessage(body: ByteArray): String? {
            if (body.isEmpty()) return null
            val text = String(body, Charsets.UTF_8).trim()
            if (text.isEmpty()) return null
            return try {
                val obj = JSONObject(text)
                obj.optString("error", "").ifBlank { obj.optString("message", "").ifBlank { null } }
            } catch (_: Exception) {
                text.take(240)
            }
        }
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            if (cont.isActive) {
                cont.resume(response)
            } else {
                response.close()
            }
        }
    })
}

package dev.vecway.mobile.web

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import dev.vecway.mobile.network.EndpointManager
import kotlinx.coroutines.runBlocking
import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets

/**
 * Pure static-asset path sanitizer preventing path traversal outside `assets/web/`.
 * Extracted as an object so JVM unit tests can exercise security boundaries directly.
 */
object AssetPathGuard {
    fun normalizeAssetRelativePath(rawPath: String): String? {
        val trimmed = rawPath.trimStart('/')
        val effective = if (trimmed.isEmpty()) "index.html" else trimmed
        val segments = effective.split('/')
        val resolved = ArrayDeque<String>()
        for (segment in segments) {
            if (segment.isEmpty() || segment == ".") continue
            if (segment == "..") return null
            if (segment.contains('\\') || segment.contains('\u0000')) return null
            resolved.addLast(segment)
        }
        if (resolved.isEmpty()) return "index.html"
        return resolved.joinToString("/")
    }

    fun mimeTypeForPath(path: String): String {
        val ext = path.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "html", "htm" -> "text/html"
            "js", "mjs" -> "application/javascript"
            "css" -> "text/css"
            "json", "webmanifest" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "ico" -> "image/x-icon"
            "woff2" -> "font/woff2"
            "woff" -> "font/woff"
            "ttf" -> "font/ttf"
            "wasm" -> "application/wasm"
            "txt", "md" -> "text/plain"
            else -> "application/octet-stream"
        }
    }

    fun isTextMime(mime: String): Boolean {
        return mime.startsWith("text/") ||
            mime == "application/javascript" ||
            mime == "application/json" ||
            mime == "image/svg+xml"
    }
}

/**
 * Hosts the bundled `src-mobile` static assets at `https://appassets.androidplatform.net/`
 * via `WebViewAssetLoader`, transparently proxies authenticated `GET`/`HEAD` requests under `/api/`
 * (such as `<img>` media) over `EndpointManager` + `PinnedTransport`, opens external links
 * in the system browser, and strictly rejects any SSL error.
 */
class AppWebViewClient(
    private val context: Context,
    private val endpointManager: EndpointManager,
    private val fallbackInlineBridgeScript: String?,
    private val onDeepLink: (Uri) -> Unit,
    private val onMainPageFinished: () -> Unit,
) : WebViewClientCompat() {

    private val assetLoader: WebViewAssetLoader = WebViewAssetLoader.Builder()
        .setDomain(APP_HOST)
        .addPathHandler("/") { path -> serveBundledAsset(path) }
        .build()

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? {
        val uri = request.url ?: return null
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()

        if (scheme == "https" && host == APP_HOST) {
            val rawPath = uri.path.orEmpty()
            if (rawPath == "/api" || rawPath.startsWith("/api/")) {
                return handleApiProxy(request, uri)
            }
            return assetLoader.shouldInterceptRequest(uri)
        }

        // SECURITY: Block any plaintext HTTP subresource requests at the WebView boundary too.
        if (scheme == "http") {
            return plainErrorResponse(403, "Forbidden", "Plaintext HTTP blocked")
        }
        return null
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url ?: return true
        val scheme = uri.scheme?.lowercase().orEmpty()
        val host = uri.host?.lowercase().orEmpty()

        // Allow bundled SPA origin.
        if (scheme == "https" && host == APP_HOST) {
            return false
        }

        // Intercept `vecway://pair?...` deep links triggered inside WebView.
        if (scheme == "vecway") {
            if (host == "pair") {
                onDeepLink(uri)
            }
            return true
        }

        // Allow harmless sandboxed iframe / inline schemes.
        if (scheme == "about" || scheme == "data" || scheme == "blob") {
            return false
        }

        // SECURITY: External http/https/mailto/tel links open in system apps, never inside app WebView.
        if (scheme == "http" || scheme == "https" || scheme == "mailto" || scheme == "tel") {
            runCatching {
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            }
            return true
        }

        return true
    }

    override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        if (url != null && url.startsWith(APP_ORIGIN)) {
            onMainPageFinished()
        }
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        // SECURITY REDLINE: NEVER call handler.proceed() — always abort invalid TLS handshakes.
        handler.cancel()
    }

    private fun serveBundledAsset(rawPath: String): WebResourceResponse {
        val safeRelative = AssetPathGuard.normalizeAssetRelativePath(rawPath)
            ?: return plainErrorResponse(403, "Forbidden", "Forbidden")

        val assetPath = "web/$safeRelative"
        val bytes = try {
            context.assets.open(assetPath).use { it.readBytes() }
        } catch (_: Exception) {
            if (safeRelative == "index.html") {
                return missingBundleResponse()
            }
            return plainErrorResponse(404, "Not Found", "Not Found")
        }

        val mime = AssetPathGuard.mimeTypeForPath(safeRelative)
        val encoding = if (AssetPathGuard.isTextMime(mime)) "utf-8" else null
        val cacheControl = if (safeRelative.startsWith("assets/")) {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }

        val payloadBytes = if (safeRelative == "index.html" && !fallbackInlineBridgeScript.isNullOrEmpty()) {
            injectInlineBridgeIntoHtml(bytes, fallbackInlineBridgeScript)
        } else {
            bytes
        }

        return WebResourceResponse(
            mime,
            encoding,
            200,
            "OK",
            mapOf(
                "Cache-Control" to cacheControl,
                "X-Content-Type-Options" to "nosniff",
            ),
            ByteArrayInputStream(payloadBytes),
        )
    }

    private fun handleApiProxy(request: WebResourceRequest, uri: Uri): WebResourceResponse {
        val method = request.method?.uppercase() ?: "GET"
        if (method != "GET" && method != "HEAD") {
            return jsonErrorResponse(
                405,
                "Method Not Allowed",
                """{"error":"Use native bridge httpRequest for write requests"}""",
            )
        }

        val status = endpointManager.currentStatus()
        if (status.pinMismatch != null) {
            return jsonErrorResponse(
                403,
                "Forbidden",
                """{"error":"证书指纹不匹配，已阻止请求"}""",
            )
        }
        if (!status.paired) {
            return jsonErrorResponse(
                401,
                "Unauthorized",
                """{"error":"尚未配对电脑"}""",
            )
        }

        val encodedPath = uri.encodedPath ?: return jsonErrorResponse(
            400,
            "Bad Request",
            """{"error":"无效的 API 路径"}""",
        )
        val encodedQuery = uri.encodedQuery
        val apiPath = if (!encodedQuery.isNullOrEmpty()) "$encodedPath?$encodedQuery" else encodedPath

        val forwardHeaders = LinkedHashMap<String, String>()
        request.requestHeaders?.forEach { (k, v) ->
            if (k.equals("Accept", ignoreCase = true) || k.equals("If-None-Match", ignoreCase = true)) {
                forwardHeaders[k] = v
            }
        }

        return try {
            val res = runBlocking {
                endpointManager.performRequest(
                    method = method,
                    path = apiPath,
                    headers = forwardHeaders,
                    body = null,
                    timeoutMs = 30_000L,
                )
            }
            val cleanHeaders = LinkedHashMap<String, String>()
            var rawContentType: String? = null
            for ((k, v) in res.headers) {
                val lower = k.lowercase()
                if (lower == "set-cookie" ||
                    lower == "transfer-encoding" ||
                    lower == "content-encoding" ||
                    lower == "content-length"
                ) {
                    continue
                }
                if (lower == "content-type") {
                    rawContentType = v
                }
                cleanHeaders[k] = v
            }
            val (mime, charset) = parseContentType(rawContentType)
            WebResourceResponse(
                mime,
                charset,
                res.status,
                httpReasonPhrase(res.status),
                cleanHeaders,
                ByteArrayInputStream(res.body),
            )
        } catch (t: Throwable) {
            val escaped = (t.message ?: "网络请求失败")
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
            jsonErrorResponse(502, "Bad Gateway", """{"error":"$escaped"}""")
        }
    }

    private fun injectInlineBridgeIntoHtml(htmlBytes: ByteArray, bridgeScript: String): ByteArray {
        val html = String(htmlBytes, StandardCharsets.UTF_8)
        val tag = "<script>$bridgeScript</script>"
        val headIdx = html.indexOf("<head>", ignoreCase = true)
        val patched = if (headIdx >= 0) {
            val insertPos = headIdx + "<head>".length
            html.substring(0, insertPos) + tag + html.substring(insertPos)
        } else {
            tag + html
        }
        return patched.toByteArray(StandardCharsets.UTF_8)
    }

    private fun missingBundleResponse(): WebResourceResponse {
        val html = """
            <!doctype html>
            <html lang="zh-CN">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
              <title>Vecway</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 32px 24px; background: #0c0d10; color: #f5f5f7; }
                code { display: block; margin-top: 12px; padding: 12px; border-radius: 8px; background: #1c1e24; font-size: 13px; }
              </style>
            </head>
            <body>
              <h2>未找到前端构建产物</h2>
              <p>请先在仓库中运行以下脚本同步移动端前端资源后再构建 APK：</p>
              <code>apps/android/scripts/sync-web.sh</code>
            </body>
            </html>
        """.trimIndent()
        return WebResourceResponse(
            "text/html",
            "utf-8",
            500,
            "Internal Server Error",
            mapOf("Cache-Control" to "no-cache"),
            ByteArrayInputStream(html.toByteArray(StandardCharsets.UTF_8)),
        )
    }

    private fun plainErrorResponse(code: Int, reason: String, body: String): WebResourceResponse {
        return WebResourceResponse(
            "text/plain",
            "utf-8",
            code,
            reason,
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(body.toByteArray(StandardCharsets.UTF_8)),
        )
    }

    private fun jsonErrorResponse(code: Int, reason: String, json: String): WebResourceResponse {
        return WebResourceResponse(
            "application/json",
            "utf-8",
            code,
            reason,
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(json.toByteArray(StandardCharsets.UTF_8)),
        )
    }

    companion object {
        const val APP_HOST = "appassets.androidplatform.net"
        const val APP_ORIGIN = "https://$APP_HOST"
        const val START_URL = "$APP_ORIGIN/index.html"

        fun parseContentType(raw: String?): Pair<String, String?> {
            if (raw.isNullOrBlank()) return Pair("application/octet-stream", null)
            val parts = raw.split(';')
            val mime = parts.first().trim().ifEmpty { "application/octet-stream" }
            var charset: String? = null
            for (i in 1 until parts.size) {
                val p = parts[i].trim()
                if (p.startsWith("charset=", ignoreCase = true)) {
                    charset = p.substring("charset=".length).trim().trim('"').ifEmpty { null }
                    break
                }
            }
            return Pair(mime, charset)
        }

        private fun httpReasonPhrase(status: Int): String = when (status) {
            200 -> "OK"
            201 -> "Created"
            204 -> "No Content"
            304 -> "Not Modified"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            500 -> "Internal Server Error"
            502 -> "Bad Gateway"
            503 -> "Service Unavailable"
            else -> "Status $status"
        }
    }
}

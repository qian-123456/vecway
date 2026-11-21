package dev.vecway.mobile.security

import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

/** Transport channels supported by the native Android shell (matches `src-mobile/core/nativeBridge.ts`). */
enum class NativeChannel(val wireValue: String, val displayName: String) {
    LAN_TLS("lan_tls", "局域网 TLS"),
    IPV6_TLS("ipv6_tls", "IPv6 TLS"),
    TUNNEL("tunnel", "Cloudflare Tunnel");

    val requiresCertificatePin: Boolean
        get() = this == LAN_TLS || this == IPV6_TLS

    companion object {
        fun fromWire(value: String?): NativeChannel? = entries.firstOrNull { it.wireValue == value }
    }
}

/** Preferred channel hint embedded in desktop pairing QR payloads. */
enum class PairingTarget(val wireValue: String, val channel: NativeChannel) {
    LAN("lan", NativeChannel.LAN_TLS),
    IPV6("ipv6", NativeChannel.IPV6_TLS),
    TUNNEL("tunnel", NativeChannel.TUNNEL);

    companion object {
        fun fromWire(value: String?): PairingTarget? = entries.firstOrNull { it.wireValue == value }
    }
}

/** Candidate HTTPS endpoints persisted for a paired desktop. */
data class EndpointCandidates(
    val lanTls: String? = null,
    val ipv6: String? = null,
    val tunnel: String? = null,
) {
    val isEmpty: Boolean
        get() = lanTls == null && ipv6 == null && tunnel == null

    fun url(forChannel: NativeChannel): String? = when (forChannel) {
        NativeChannel.LAN_TLS -> lanTls
        NativeChannel.IPV6_TLS -> ipv6
        NativeChannel.TUNNEL -> tunnel
    }

    fun toJson(): JSONObject = JSONObject().apply {
        if (lanTls != null) put("lanTls", lanTls)
        if (ipv6 != null) put("ipv6", ipv6)
        if (tunnel != null) put("tunnel", tunnel)
    }

    companion object {
        fun fromJson(obj: JSONObject?): EndpointCandidates {
            if (obj == null) return EndpointCandidates()
            return EndpointCandidates(
                lanTls = obj.optString("lanTls", "").ifBlank { null },
                ipv6 = obj.optString("ipv6", "").ifBlank { null },
                tunnel = obj.optString("tunnel", "").ifBlank { null },
            )
        }
    }
}

/**
 * SHA-256 certificate fingerprint formatting & strict parsing.
 * Matches Rust `src-tauri/src/mobile/tls.rs`: 32 bytes uppercase colon-separated hex (`AA:BB:...:FF`, 95 chars).
 */
object CertificateFingerprint {
    private val HEX_CHARS = "0123456789ABCDEF".toCharArray()

    /** Parses a strict 95-char colon-separated uppercase SHA-256 fingerprint into 32 raw bytes. */
    fun parse(value: String?): ByteArray? {
        if (value == null || value.length != 95) return null
        val out = ByteArray(32)
        for (i in 0 until 32) {
            val idx = i * 3
            val hi = hexNibble(value[idx])
            val lo = hexNibble(value[idx + 1])
            if (hi < 0 || lo < 0) return null
            if (i < 31 && value[idx + 2] != ':') return null
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    /** Formats 32 raw SHA-256 bytes into uppercase colon-separated hex (`AA:BB:...:FF`). */
    fun format(digest: ByteArray): String {
        val out = CharArray(digest.size * 3 - 1)
        for (i in digest.indices) {
            val v = digest[i].toInt() and 0xFF
            val pos = i * 3
            out[pos] = HEX_CHARS[v ushr 4]
            out[pos + 1] = HEX_CHARS[v and 0x0F]
            if (i < digest.lastIndex) out[pos + 2] = ':'
        }
        return String(out)
    }

    /** Computes the SHA-256 digest of a leaf certificate's DER bytes. */
    fun sha256(der: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(der)

    /** Constant-time equality comparison for 32-byte digests. */
    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    /** Compact display summary (`AA:BB:CC:DD … 11:22:33:44`). */
    fun shortSummary(fingerprint: String): String {
        val parts = fingerprint.split(":")
        return if (parts.size >= 8) {
            "${parts.take(4).joinToString(":")} … ${parts.takeLast(4).joinToString(":")}"
        } else {
            fingerprint
        }
    }

    private fun hexNibble(ch: Char): Int = when (ch) {
        in '0'..'9' -> ch - '0'
        in 'A'..'F' -> ch - 'A' + 10
        else -> -1
    }
}

sealed class PairingPayloadException(message: String) : Exception(message) {
    class InvalidUrl : PairingPayloadException("无法识别的配对二维码内容")
    class MissingAppPayload : PairingPayloadException("该二维码不包含独立 App 的加密连接信息，请更新桌面端后重新生成")
    class InvalidBase64Payload : PairingPayloadException("配对二维码中的 App 参数编码无效")
    class InvalidJsonPayload : PairingPayloadException("配对二维码中的 App 参数格式无效")
    class UnsupportedVersion(version: Int) : PairingPayloadException("不支持的配对协议版本（v=$version），请更新 App")
    class InvalidCode : PairingPayloadException("配对码无效或缺失")
    class InsecureEndpoint(field: String, value: String) :
        PairingPayloadException("安全拦截：拒绝使用明文 HTTP 连接地址（$field=$value），仅允许 HTTPS/TLS")
    class InvalidEndpointUrl(field: String, value: String) :
        PairingPayloadException("无效的连接地址（$field=$value）")
    class InvalidFingerprint : PairingPayloadException("证书 SHA-256 指纹格式无效")
    class MissingFingerprintForPinnedEndpoint :
        PairingPayloadException("局域网或 IPv6 TLS 连接必须包含证书 SHA-256 指纹")
    class NoEndpoints : PairingPayloadException("配对信息中不包含可用的 HTTPS 连接地址")
}

/**
 * Validated pairing payload parsed from either a dual-use QR URL (`#app=...`)
 * or an app-direct deep link (`vecway://pair?...`).
 */
data class PairingPayload(
    val version: Int,
    val code: String,
    val preferredTarget: PairingTarget?,
    val endpoints: EndpointCandidates,
    val certSha256: String?,
    val certSha256Digest: ByteArray?,
) {
    /** Returns candidate channels in the exact order pairing should attempt them. */
    fun orderedPairingAttempts(): List<Pair<NativeChannel, String>> {
        val order = mutableListOf(NativeChannel.LAN_TLS, NativeChannel.IPV6_TLS, NativeChannel.TUNNEL)
        val preferred = preferredTarget?.channel
        if (preferred != null) {
            order.remove(preferred)
            order.add(0, preferred)
        }
        return order.mapNotNull { ch -> endpoints.url(ch)?.let { ch to it } }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PairingPayload) return false
        return version == other.version &&
            code == other.code &&
            preferredTarget == other.preferredTarget &&
            endpoints == other.endpoints &&
            certSha256 == other.certSha256 &&
            ((certSha256Digest == null && other.certSha256Digest == null) ||
                (certSha256Digest != null && other.certSha256Digest != null && certSha256Digest.contentEquals(other.certSha256Digest)))
    }

    override fun hashCode(): Int {
        var result = version
        result = 31 * result + code.hashCode()
        result = 31 * result + (preferredTarget?.hashCode() ?: 0)
        result = 31 * result + endpoints.hashCode()
        result = 31 * result + (certSha256?.hashCode() ?: 0)
        result = 31 * result + (certSha256Digest?.contentHashCode() ?: 0)
        return result
    }

    companion object {
        /**
         * Parses either:
         * 1. Dual-use QR URL: `<base>/pair?code=<code>#app=<base64url(json)>`
         *    (The outer plaintext `http://` prefix is completely ignored.)
         * 2. App-direct URL: `vecway://pair?v=1&code=<code>&t=...&lt=...&fp=...&v6=...&tn=...`
         */
        fun parse(rawInput: String): PairingPayload {
            val trimmed = rawInput.trim()
            if (trimmed.isEmpty()) throw PairingPayloadException.InvalidUrl()
            val uri = try {
                URI(trimmed)
            } catch (_: Exception) {
                throw PairingPayloadException.InvalidUrl()
            }
            return when (uri.scheme?.lowercase()) {
                "vecway" -> parseDirectAppUrl(uri)
                "http", "https" -> parseDualUseUrl(uri)
                else -> throw PairingPayloadException.InvalidUrl()
            }
        }

        /** Validates an endpoint base URL strictly requires `https://` and a valid host with no path/query/fragment/userinfo. */
        fun validateHttpsEndpoint(raw: String, field: String): String {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) throw PairingPayloadException.InvalidEndpointUrl(field, raw)
            val uri = try {
                URI(trimmed)
            } catch (_: Exception) {
                throw PairingPayloadException.InvalidEndpointUrl(field, raw)
            }
            val scheme = uri.scheme?.lowercase() ?: throw PairingPayloadException.InvalidEndpointUrl(field, raw)
            if (scheme != "https") throw PairingPayloadException.InsecureEndpoint(field, raw)
            val host = uri.host
            if (host.isNullOrEmpty()) throw PairingPayloadException.InvalidEndpointUrl(field, raw)
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) {
                throw PairingPayloadException.InvalidEndpointUrl(field, raw)
            }
            val path = uri.rawPath ?: ""
            if (path.isNotEmpty() && path != "/") {
                throw PairingPayloadException.InvalidEndpointUrl(field, raw)
            }
            val portPart = if (uri.port != -1) ":${uri.port}" else ""
            return "https://$host$portPart"
        }

        private fun parseDualUseUrl(uri: URI): PairingPayload {
            val query = parseQueryParams(uri.rawQuery)
            val code = validateCode(query["code"])
            val fragment = uri.rawFragment ?: throw PairingPayloadException.MissingAppPayload()
            val appParam = extractFragmentParam("app", fragment) ?: throw PairingPayloadException.MissingAppPayload()
            val decoded = decodeBase64Url(appParam) ?: throw PairingPayloadException.InvalidBase64Payload()
            val json = try {
                JSONObject(String(decoded, StandardCharsets.UTF_8))
            } catch (_: Exception) {
                throw PairingPayloadException.InvalidJsonPayload()
            }
            if (!json.has("v")) throw PairingPayloadException.InvalidJsonPayload()
            val version = json.optInt("v", -1)
            return buildValidatedPayload(
                version = version,
                code = code,
                rawTarget = json.optNullableString("t"),
                rawLanTls = json.optNullableString("lt"),
                rawIpv6 = json.optNullableString("v6"),
                rawTunnel = json.optNullableString("tn"),
                rawFingerprint = json.optNullableString("fp"),
            )
        }

        private fun parseDirectAppUrl(uri: URI): PairingPayload {
            if (uri.host?.lowercase() != "pair") throw PairingPayloadException.InvalidUrl()
            val query = parseQueryParams(uri.rawQuery)
            val version = query["v"]?.toIntOrNull() ?: throw PairingPayloadException.UnsupportedVersion(0)
            val code = validateCode(query["code"])
            return buildValidatedPayload(
                version = version,
                code = code,
                rawTarget = query["t"],
                rawLanTls = query["lt"],
                rawIpv6 = query["v6"],
                rawTunnel = query["tn"],
                rawFingerprint = query["fp"],
            )
        }

        private fun buildValidatedPayload(
            version: Int,
            code: String,
            rawTarget: String?,
            rawLanTls: String?,
            rawIpv6: String?,
            rawTunnel: String?,
            rawFingerprint: String?,
        ): PairingPayload {
            if (version != 1) throw PairingPayloadException.UnsupportedVersion(version)

            val lanTls = validateOptionalEndpoint(rawLanTls, "lt")
            val ipv6 = validateOptionalEndpoint(rawIpv6, "v6")
            val tunnel = validateOptionalEndpoint(rawTunnel, "tn")
            val endpoints = EndpointCandidates(lanTls = lanTls, ipv6 = ipv6, tunnel = tunnel)
            if (endpoints.isEmpty) throw PairingPayloadException.NoEndpoints()

            val trimmedFp = rawFingerprint?.trim()?.takeIf { it.isNotEmpty() }
            val certDigest = if (trimmedFp != null) {
                CertificateFingerprint.parse(trimmedFp) ?: throw PairingPayloadException.InvalidFingerprint()
            } else {
                null
            }
            if ((lanTls != null || ipv6 != null) && certDigest == null) {
                throw PairingPayloadException.MissingFingerprintForPinnedEndpoint()
            }

            return PairingPayload(
                version = version,
                code = code,
                preferredTarget = PairingTarget.fromWire(rawTarget?.trim()),
                endpoints = endpoints,
                certSha256 = trimmedFp,
                certSha256Digest = certDigest,
            )
        }

        private fun validateOptionalEndpoint(raw: String?, field: String): String? {
            val trimmed = raw?.trim() ?: return null
            if (trimmed.isEmpty()) return null
            return validateHttpsEndpoint(trimmed, field)
        }

        private fun validateCode(raw: String?): String {
            if (raw.isNullOrEmpty()) throw PairingPayloadException.InvalidCode()
            val valid = raw.all { ch ->
                ch in 'a'..'z' || ch in 'A'..'Z' || ch in '0'..'9' || ch == '-' || ch == '_'
            }
            if (!valid) throw PairingPayloadException.InvalidCode()
            return raw
        }

        private fun parseQueryParams(rawQuery: String?): Map<String, String> {
            if (rawQuery.isNullOrEmpty()) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (part in rawQuery.split("&")) {
                if (part.isEmpty()) continue
                val eq = part.indexOf('=')
                if (eq <= 0) continue
                val key = URLDecoder.decode(part.substring(0, eq), "UTF-8")
                val value = URLDecoder.decode(part.substring(eq + 1), "UTF-8")
                out[key] = value
            }
            return out
        }

        private fun extractFragmentParam(name: String, fragment: String): String? {
            val prefix = "$name="
            for (part in fragment.split("&")) {
                if (part.startsWith(prefix)) return part.substring(prefix.length)
            }
            return null
        }

        private fun decodeBase64Url(input: String): ByteArray? {
            val normalized = input.replace('-', '+').replace('_', '/')
            val rem = normalized.length % 4
            if (rem == 1) return null
            val padded = if (rem > 0) normalized + "=".repeat(4 - rem) else normalized
            return try {
                Base64.getDecoder().decode(padded)
            } catch (_: IllegalArgumentException) {
                null
            }
        }

        private fun JSONObject.optNullableString(key: String): String? {
            if (!has(key) || isNull(key)) return null
            return optString(key, "").takeIf { it.isNotEmpty() }
        }
    }
}

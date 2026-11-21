package dev.vecway.mobile.security

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.StandardCharsets
import java.util.Base64

class PairingPayloadTest {

    private val validFp = (0 until 32).joinToString(":") { i -> "%02X".format(i * 7 and 0xFF) }

    private fun encodeAppFragment(json: JSONObject): String {
        return Base64.getUrlEncoder().withoutPadding()
            .encodeToString(json.toString().toByteArray(StandardCharsets.UTF_8))
    }

    @Test
    fun parsesDualUseQrUrlIgnoringPlaintextOuterPrefix() {
        val appJson = JSONObject().apply {
            put("v", 1)
            put("t", "lan")
            put("lt", "https://192.168.1.42:7790")
            put("v6", "https://home.example.com:7789")
            put("tn", "https://abc.trycloudflare.com")
            put("fp", validFp)
        }
        val dualUrl = "http://192.168.1.42:7788/pair?code=PAIR-9988#app=${encodeAppFragment(appJson)}"

        val parsed = PairingPayload.parse(dualUrl)
        assertEquals(1, parsed.version)
        assertEquals("PAIR-9988", parsed.code)
        assertEquals(PairingTarget.LAN, parsed.preferredTarget)
        assertEquals("https://192.168.1.42:7790", parsed.endpoints.lanTls)
        assertEquals("https://home.example.com:7789", parsed.endpoints.ipv6)
        assertEquals("https://abc.trycloudflare.com", parsed.endpoints.tunnel)
        assertEquals(validFp, parsed.certSha256)
        assertNotNull(parsed.certSha256Digest)
        assertEquals(32, parsed.certSha256Digest!!.size)

        assertEquals(
            listOf(
                NativeChannel.LAN_TLS to "https://192.168.1.42:7790",
                NativeChannel.IPV6_TLS to "https://home.example.com:7789",
                NativeChannel.TUNNEL to "https://abc.trycloudflare.com",
            ),
            parsed.orderedPairingAttempts(),
        )
    }

    @Test
    fun parsesAppDirectDeepLinkAndHonorsPreferredTarget() {
        val deepLink = "vecway://pair?v=1&code=XYZ789&t=tunnel" +
            "&lt=https%3A%2F%2F10.0.0.5%3A7790" +
            "&tn=https%3A%2F%2Fdemo.trycloudflare.com" +
            "&fp=${validFp.replace(":", "%3A")}"

        val parsed = PairingPayload.parse(deepLink)
        assertEquals("XYZ789", parsed.code)
        assertEquals(PairingTarget.TUNNEL, parsed.preferredTarget)
        assertEquals(
            listOf(
                NativeChannel.TUNNEL to "https://demo.trycloudflare.com",
                NativeChannel.LAN_TLS to "https://10.0.0.5:7790",
            ),
            parsed.orderedPairingAttempts(),
        )
    }

    @Test
    fun rejectsPlaintextHttpEndpointsInAppPayload() {
        val appJson = JSONObject().apply {
            put("v", 1)
            put("lt", "http://192.168.1.42:7788")
            put("fp", validFp)
        }
        val dualUrl = "http://192.168.1.42:7788/pair?code=PAIR-1#app=${encodeAppFragment(appJson)}"

        try {
            PairingPayload.parse(dualUrl)
            throw AssertionError("Expected InsecureEndpoint")
        } catch (_: PairingPayloadException.InsecureEndpoint) {
            // Expected
        }
    }

    @Test
    fun rejectsPlaintextHttpInDirectDeepLink() {
        val deepLink = "vecway://pair?v=1&code=ABC&tn=http%3A%2F%2Fevil.example.com"
        try {
            PairingPayload.parse(deepLink)
            throw AssertionError("Expected InsecureEndpoint")
        } catch (_: PairingPayloadException.InsecureEndpoint) {
            // Expected
        }
    }

    @Test
    fun rejectsMissingFingerprintWhenPinnedChannelPresent() {
        val appJson = JSONObject().apply {
            put("v", 1)
            put("lt", "https://192.168.1.42:7790")
        }
        val url = "https://192.168.1.42:7790/pair?code=PAIR-2#app=${encodeAppFragment(appJson)}"
        try {
            PairingPayload.parse(url)
            throw AssertionError("Expected MissingFingerprintForPinnedEndpoint")
        } catch (_: PairingPayloadException.MissingFingerprintForPinnedEndpoint) {
            // Expected
        }
    }

    @Test
    fun allowsTunnelOnlyPayloadWithoutCertFingerprint() {
        val appJson = JSONObject().apply {
            put("v", 1)
            put("tn", "https://ok.trycloudflare.com")
        }
        val url = "https://ok.trycloudflare.com/pair?code=TUN-ONLY#app=${encodeAppFragment(appJson)}"
        val parsed = PairingPayload.parse(url)
        assertNull(parsed.certSha256)
        assertEquals("https://ok.trycloudflare.com", parsed.endpoints.tunnel)
    }

    @Test
    fun rejectsLowercaseOrMalformedCertFingerprint() {
        assertNull(CertificateFingerprint.parse(validFp.lowercase()))
        assertNull(CertificateFingerprint.parse(validFp.dropLast(1)))
        assertNull(CertificateFingerprint.parse(validFp.replace(':', '-')))

        val bytes = CertificateFingerprint.parse(validFp)
        assertNotNull(bytes)
        assertEquals(validFp, CertificateFingerprint.format(bytes!!))
        assertTrue(CertificateFingerprint.constantTimeEquals(bytes, bytes.copyOf()))

        val mutated = bytes.copyOf().also { it[31] = (it[31].toInt() xor 0x01).toByte() }
        assertFalse(CertificateFingerprint.constantTimeEquals(bytes, mutated))
        assertArrayEquals(bytes, CertificateFingerprint.parse(CertificateFingerprint.format(bytes)))
        assertTrue(CertificateFingerprint.shortSummary(validFp).contains("…"))
    }
}

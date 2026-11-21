package dev.vecway.mobile.web

import dev.vecway.mobile.network.NativeEndpointStatus
import dev.vecway.mobile.network.SSEEvent
import dev.vecway.mobile.network.SSELineParser
import dev.vecway.mobile.security.EndpointCandidates
import dev.vecway.mobile.security.NativeChannel
import dev.vecway.mobile.security.StoredCredentials
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.Base64

class WebSecurityAndParserTest {

    @Test
    fun sseParserHandlesByteByByteUtf8AndMixedLineEndings() {
        val parser = SSELineParser()
        val raw = ("\uFEFF: heartbeat\r\n" +
            "event: chunk\r\n" +
            "data: 第一行\r\n" +
            "data: 第二行 🚀\r\n" +
            "\r\n" +
            "data: default-msg\n\n").toByteArray(StandardCharsets.UTF_8)

        val collected = mutableListOf<SSEEvent>()
        // Feed 1 byte at a time to stress multibyte UTF-8 & CRLF splits.
        for (b in raw) {
            collected.addAll(parser.append(byteArrayOf(b), 1))
        }

        assertEquals(
            listOf(
                SSEEvent("chunk", "第一行\n第二行 🚀"),
                SSEEvent("message", "default-msg"),
            ),
            collected,
        )
    }

    @Test
    fun assetPathGuardBlocksTraversalAndNormalizesValidPaths() {
        assertEquals("index.html", AssetPathGuard.normalizeAssetRelativePath(""))
        assertEquals("index.html", AssetPathGuard.normalizeAssetRelativePath("/"))
        assertEquals("assets/app-123.js", AssetPathGuard.normalizeAssetRelativePath("/assets/app-123.js"))
        assertNull(AssetPathGuard.normalizeAssetRelativePath("../AndroidManifest.xml"))
        assertNull(AssetPathGuard.normalizeAssetRelativePath("assets/../../secret"))
        assertNull(AssetPathGuard.normalizeAssetRelativePath("assets\\..\\secret"))
        assertNull(AssetPathGuard.normalizeAssetRelativePath("index.html\u0000.png"))

        assertEquals("application/javascript", AssetPathGuard.mimeTypeForPath("assets/index-abc.js"))
        assertEquals("text/css", AssetPathGuard.mimeTypeForPath("assets/index.css"))
        assertEquals("font/woff2", AssetPathGuard.mimeTypeForPath("assets/katex.woff2"))
    }

    @Test
    fun bridgePayloadParserPreservesTriStateEndpointPatchAndEnforcesBodyLimit() {
        val json = JSONObject("""{"lanTls":"https://192.168.1.2:7790","tunnel":null,"certSha256":"AA:BB:CC"}""")
        val patch = BridgePayloadParser.parseEndpointPatch(json)
        assertTrue(patch.lanTls.present)
        assertEquals("https://192.168.1.2:7790", patch.lanTls.value)
        assertFalse(patch.ipv6.present)
        assertTrue(patch.tunnel.present)
        assertNull(patch.tunnel.value)
        assertTrue(patch.certSha256.present)
        assertEquals("AA:BB:CC", patch.certSha256.value)

        val encoded = Base64.getEncoder().encodeToString("hello".toByteArray())
        assertEquals("hello", String(BridgePayloadParser.decodeBodyBase64(encoded)!!))

        try {
            BridgePayloadParser.decodeBodyBase64("not-valid-base64!!!")
            fail("Expected IllegalArgumentException for invalid base64")
        } catch (_: IllegalArgumentException) {
            // Expected
        }

        val statusJson = NativeEndpointStatus(
            paired = false,
            candidates = EndpointCandidates(),
        ).toJson()
        assertTrue(statusJson.isNull("activeChannel"))
        assertTrue(statusJson.isNull("activeUrl"))
        assertTrue(statusJson.isNull("preferredChannel"))
        assertTrue(statusJson.isNull("certSha256"))
        assertTrue(statusJson.isNull("pinMismatch"))

        val preferredStatusJson = NativeEndpointStatus(
            paired = true,
            activeChannel = NativeChannel.TUNNEL,
            activeUrl = "https://omp.example.com",
            preferredChannel = NativeChannel.TUNNEL,
            candidates = EndpointCandidates(tunnel = "https://omp.example.com"),
        ).toJson()
        assertEquals("tunnel", preferredStatusJson.getString("preferredChannel"))
    }

    @Test
    fun storedCredentialsHandlesLegacyAndPreferredChannelSerialization() {
        val legacyJson = JSONObject(
            """
            {
              "deviceToken": "legacy-tok",
              "pinnedCertSha256": null,
              "endpoints": { "tunnel": "https://omp.example.com" }
            }
            """.trimIndent(),
        )
        val legacy = StoredCredentials.fromJson(legacyJson)!!
        assertEquals("legacy-tok", legacy.deviceToken)
        assertNull(legacy.pinnedCertSha256)
        assertNull(legacy.preferredChannel)
        assertEquals("https://omp.example.com", legacy.endpoints.tunnel)

        val withPref = legacy.copy(preferredChannel = NativeChannel.IPV6_TLS)
        val roundTripped = StoredCredentials.fromJson(withPref.toJson())!!
        assertEquals(NativeChannel.IPV6_TLS, roundTripped.preferredChannel)
    }

    @Test
    fun bridgePayloadParserSupportsSwitchChannelAndUtf8BodyTextFastPath() {
        assertEquals(NativeChannel.LAN_TLS, BridgePayloadParser.parseSwitchChannel(JSONObject("""{"channel":"lan_tls"}""")))
        assertEquals(NativeChannel.IPV6_TLS, BridgePayloadParser.parseSwitchChannel(JSONObject("""{"channel":"ipv6_tls"}""")))
        assertEquals(NativeChannel.TUNNEL, BridgePayloadParser.parseSwitchChannel(JSONObject("""{"channel":"tunnel"}""")))
        assertNull(BridgePayloadParser.parseSwitchChannel(JSONObject("""{"channel":null}""")))
        assertNull(BridgePayloadParser.parseSwitchChannel(JSONObject("""{"channel":"auto"}""")))
        assertNull(BridgePayloadParser.parseSwitchChannel(JSONObject("""{}""")))

        try {
            BridgePayloadParser.parseSwitchChannel(JSONObject("""{"channel":"bluetooth"}"""))
            fail("Expected IllegalArgumentException for unsupported channel")
        } catch (_: IllegalArgumentException) {
            // Expected
        }

        assertEquals(
            """{"msg":"你好"}""",
            BridgePayloadParser.decodeUtf8TextIfApplicable(
                mapOf("Content-Type" to "application/json; charset=utf-8"),
                """{"msg":"你好"}""".toByteArray(StandardCharsets.UTF_8),
            ),
        )
        assertEquals(
            "plain",
            BridgePayloadParser.decodeUtf8TextIfApplicable(
                mapOf("content-type" to "text/plain"),
                "plain".toByteArray(StandardCharsets.UTF_8),
            ),
        )
        assertEquals(
            "<svg/>",
            BridgePayloadParser.decodeUtf8TextIfApplicable(
                mapOf("Content-Type" to "image/svg+xml"),
                "<svg/>".toByteArray(StandardCharsets.UTF_8),
            ),
        )
        assertNull(
            BridgePayloadParser.decodeUtf8TextIfApplicable(
                mapOf("Content-Type" to "application/octet-stream"),
                byteArrayOf(1, 2, 3),
            ),
        )
        // Invalid UTF-8 bytes must return null so caller falls back to bodyBase64.
        assertNull(
            BridgePayloadParser.decodeUtf8TextIfApplicable(
                mapOf("Content-Type" to "application/json"),
                byteArrayOf(0xFF.toByte(), 0xFE.toByte()),
            ),
        )
    }

    @Test
    fun androidManifestAndNetworkSecurityConfigEnforceSecurityRedlines() {
        val mainDir = File("src/main")
        val manifest = File(mainDir, "AndroidManifest.xml").readText(StandardCharsets.UTF_8)
        assertTrue("allowBackup must be false", manifest.contains("""android:allowBackup="false""""))
        assertTrue(
            "usesCleartextTraffic must be false",
            manifest.contains("""android:usesCleartextTraffic="false""""),
        )
        assertTrue(
            "networkSecurityConfig must be referenced",
            manifest.contains("""android:networkSecurityConfig="@xml/network_security_config""""),
        )

        val netSec = File(mainDir, "res/xml/network_security_config.xml").readText(StandardCharsets.UTF_8)
        assertTrue(
            "cleartextTrafficPermitted must be false",
            netSec.contains("""cleartextTrafficPermitted="false""""),
        )
        assertFalse("Must NOT trust user-installed CAs", netSec.contains("""src="user""""))

        val backupRules = File(mainDir, "res/xml/backup_rules.xml").readText(StandardCharsets.UTF_8)
        assertTrue(backupRules.contains("""<exclude domain="sharedpref" path="." />"""))

        val extractionRules = File(mainDir, "res/xml/data_extraction_rules.xml").readText(StandardCharsets.UTF_8)
        assertTrue(extractionRules.contains("""<cloud-backup>"""))
        assertTrue(extractionRules.contains("""<device-transfer>"""))
    }
}

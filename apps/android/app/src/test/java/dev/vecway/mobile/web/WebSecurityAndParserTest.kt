package dev.vecway.mobile.web

import dev.vecway.mobile.network.NativeEndpointStatus
import dev.vecway.mobile.network.SSEEvent
import dev.vecway.mobile.network.SSELineParser
import dev.vecway.mobile.security.EndpointCandidates
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
        val json = JSONObject("""{"lanTls":"https://192.168.1.2:7790","tunnel":null}""")
        val patch = BridgePayloadParser.parseEndpointPatch(json)
        assertTrue(patch.lanTls.present)
        assertEquals("https://192.168.1.2:7790", patch.lanTls.value)
        assertFalse(patch.ipv6.present)
        assertTrue(patch.tunnel.present)
        assertNull(patch.tunnel.value)

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
        assertTrue(statusJson.isNull("certSha256"))
        assertTrue(statusJson.isNull("pinMismatch"))
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

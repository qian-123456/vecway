package dev.vecway.mobile.network

import dev.vecway.mobile.security.CertificateFingerprint
import dev.vecway.mobile.security.NativeChannel
import kotlinx.coroutines.runBlocking
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.math.BigInteger
import java.net.InetAddress
import java.net.ServerSocket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Date
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import kotlin.concurrent.thread

/**
 * End-to-end TLS security tests against real local `SSLServerSocket` instances with runtime-generated
 * self-signed X.509 certificates, verifying Section 8.3 security redlines on Android `PinnedTransport`
 * and `SSEBridge`.
 */
class LivePinnedTransportTest {

    private data class SelfSignedIdentity(
        val sslContext: SSLContext,
        val cert: X509Certificate,
        val sha256Fingerprint: String,
    )

    private fun generateSelfSignedIdentity(commonName: String): SelfSignedIdentity {
        val kpGen = KeyPairGenerator.getInstance("RSA").apply { initialize(2048, SecureRandom()) }
        val kp = kpGen.generateKeyPair()
        val now = System.currentTimeMillis()
        val builder = JcaX509v3CertificateBuilder(
            X500Name("CN=$commonName"),
            BigInteger.valueOf(now + SecureRandom().nextInt(100_000)),
            Date(now - 60_000L),
            Date(now + 86_400_000L),
            X500Name("CN=$commonName"),
            kp.public,
        )
        val signer = JcaContentSignerBuilder("SHA256WithRSA").build(kp.private)
        val cert = JcaX509CertificateConverter().getCertificate(builder.build(signer))

        val ks = KeyStore.getInstance("PKCS12").apply {
            load(null, null)
            setKeyEntry("server", kp.private, "changeit".toCharArray(), arrayOf(cert))
        }
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
            init(ks, "changeit".toCharArray())
        }
        val sslCtx = SSLContext.getInstance("TLS").apply {
            init(kmf.keyManagers, null, SecureRandom())
        }
        val fp = CertificateFingerprint.format(CertificateFingerprint.sha256(cert.encoded))
        return SelfSignedIdentity(sslCtx, cert, fp)
    }

    private class SingleShotTlsServer(
        identity: SelfSignedIdentity,
        private val responseBuilder: (requestLine: String, headers: Map<String, String>) -> ByteArray,
    ) : AutoCloseable {
        val serverSocket: SSLServerSocket = (identity.sslContext.serverSocketFactory
            .createServerSocket(0, 10, InetAddress.getByName("127.0.0.1")) as SSLServerSocket)
        val port: Int = serverSocket.localPort
        val baseUrl: String = "https://127.0.0.1:$port"
        val receivedHeaders = AtomicReference<Map<String, String>>(emptyMap())
        val worker: Thread

        init {
            worker = thread(isDaemon = true) {
                try {
                    while (!serverSocket.isClosed) {
                        val socket = serverSocket.accept()
                        try {
                            socket.use { s ->
                                val reader = BufferedReader(InputStreamReader(s.inputStream, Charsets.UTF_8))
                                val reqLine = reader.readLine() ?: return@use
                                val hdrs = LinkedHashMap<String, String>()
                                var line = reader.readLine()
                                while (!line.isNullOrEmpty()) {
                                    val idx = line.indexOf(':')
                                    if (idx > 0) {
                                        hdrs[line.substring(0, idx).trim().lowercase()] =
                                            line.substring(idx + 1).trim()
                                    }
                                    line = reader.readLine()
                                }
                                receivedHeaders.set(hdrs)
                                val out = responseBuilder(reqLine, hdrs)
                                s.outputStream.write(out)
                                s.outputStream.flush()
                            }
                        } catch (_: Throwable) {
                            // Handshake aborted (expected on pin mismatch test).
                        }
                    }
                } catch (_: Throwable) {
                    // Socket closed on teardown.
                }
            }
        }

        override fun close() {
            runCatching { serverSocket.close() }
            worker.join(1_000)
        }
    }

    @Test
    fun pinnedRequestSucceedsWithMatchingCertAndSanitizesCsrfHeaders() = runBlocking {
        val idA = generateSelfSignedIdentity("vecway-lan-a")
        val body = """{"ok":true}"""
        val httpRes = (
            "HTTP/1.1 200 OK\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: ${body.toByteArray().size}\r\n" +
                "Connection: close\r\n\r\n" +
                body
            ).toByteArray(Charsets.UTF_8)

        SingleShotTlsServer(idA) { _, _ -> httpRes }.use { server ->
            val transport = PinnedTransport(userAgent = "Vecway-Android-Test/1.0")
            val res = transport.request(
                baseUrl = server.baseUrl,
                channel = NativeChannel.LAN_TLS,
                method = "POST",
                path = "/api/sessions",
                headers = mapOf(
                    "Origin" to "https://evil.example",
                    "Referer" to "https://evil.example/x",
                    "Cookie" to "session=stolen",
                    "Sec-Fetch-Site" to "cross-site",
                    "Sec-Fetch-Mode" to "cors",
                    "Authorization" to "Bearer spoofed",
                    "X-Custom" to "keep-me",
                ),
                body = """{"hello":"world"}""".toByteArray(),
                bearerToken = "real-secret-token",
                pinnedCertSha256 = idA.sha256Fingerprint,
                timeoutMs = 5_000L,
            )

            assertEquals(200, res.status)
            assertEquals(body, String(res.body, Charsets.UTF_8))

            val hdrs = server.receivedHeaders.get()
            assertEquals("Bearer real-secret-token", hdrs["authorization"])
            assertEquals("Vecway-Android-Test/1.0", hdrs["user-agent"])
            assertEquals("keep-me", hdrs["x-custom"])
            assertNull("Origin must be stripped", hdrs["origin"])
            assertNull("Referer must be stripped", hdrs["referer"])
            assertNull("Cookie must be stripped", hdrs["cookie"])
            assertNull("Sec-Fetch-Site must be stripped", hdrs["sec-fetch-site"])
            assertNull("Sec-Fetch-Mode must be stripped", hdrs["sec-fetch-mode"])
        }
    }

    @Test
    fun hardBlocksOnSingleCharCertPinMismatch() = runBlocking {
        val idA = generateSelfSignedIdentity("vecway-lan-a")
        val idB = generateSelfSignedIdentity("vecway-lan-b")
        assertNotEquals(idA.sha256Fingerprint, idB.sha256Fingerprint)

        // Also test 1-nibble mutation of idA's fingerprint.
        val lastChar = idA.sha256Fingerprint.last()
        val flippedChar = if (lastChar == '0') '1' else '0'
        val oneCharOff = idA.sha256Fingerprint.dropLast(1) + flippedChar

        val okBytes = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK".toByteArray()
        SingleShotTlsServer(idA) { _, _ -> okBytes }.use { server ->
            val transport = PinnedTransport()
            for (wrongPin in listOf(idB.sha256Fingerprint, oneCharOff)) {
                try {
                    transport.request(
                        baseUrl = server.baseUrl,
                        channel = NativeChannel.LAN_TLS,
                        method = "GET",
                        path = "/api/left/device",
                        headers = null,
                        body = null,
                        bearerToken = "tok-123",
                        pinnedCertSha256 = wrongPin,
                        timeoutMs = 5_000L,
                    )
                    fail("Expected TransportException.PinMismatch for pin=$wrongPin")
                } catch (e: TransportException.PinMismatch) {
                    assertEquals(wrongPin, e.mismatch.expectedSha256)
                    assertEquals(idA.sha256Fingerprint, e.mismatch.actualSha256)
                    assertEquals("127.0.0.1", e.mismatch.host)
                    assertEquals(NativeChannel.LAN_TLS, e.mismatch.channel)
                }
            }
            // Verify the HTTP request never reached the server application layer!
            assertTrue(server.receivedHeaders.get().isEmpty())
        }
    }

    @Test
    fun hardRejectsPlaintextHttpBeforeOpeningAnySocket() = runBlocking {
        val hits = AtomicInteger(0)
        ServerSocket(0, 5, InetAddress.getByName("127.0.0.1")).use { plainServer ->
            val listener = thread(isDaemon = true) {
                try {
                    plainServer.accept().close()
                    hits.incrementAndGet()
                } catch (_: Throwable) {
                }
            }
            val transport = PinnedTransport()
            try {
                transport.request(
                    baseUrl = "http://127.0.0.1:${plainServer.localPort}",
                    channel = NativeChannel.LAN_TLS,
                    method = "GET",
                    path = "/api/sessions",
                    headers = null,
                    body = null,
                    bearerToken = "never-leak-me",
                    pinnedCertSha256 = null,
                    timeoutMs = 3_000L,
                )
                fail("Expected TransportException.PlaintextForbidden")
            } catch (_: TransportException.PlaintextForbidden) {
                // Expected
            }
            plainServer.close()
            listener.join(500)
            assertEquals("Zero TCP connections may hit plaintext server", 0, hits.get())
        }
    }

    @Test
    fun sseBridgeStreamsOverPinnedTlsAndHardBlocksOnMismatch() {
        val idA = generateSelfSignedIdentity("vecway-sse-a")
        val idB = generateSelfSignedIdentity("vecway-sse-b")
        val ssePayload = (
            "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/event-stream; charset=utf-8\r\n" +
                "Connection: close\r\n\r\n" +
                ": keepalive\n" +
                "event: delta\n" +
                "data: {\"text\":\"你好 Vecway\"}\n\n"
            ).toByteArray(Charsets.UTF_8)

        SingleShotTlsServer(idA) { _, _ -> ssePayload }.use { server ->
            val transport = PinnedTransport()
            val bridge = SSEBridge(transport)

            // 1. Matching fingerprint delivers open + event.
            val openLatch = CountDownLatch(1)
            val eventLatch = CountDownLatch(1)
            val receivedEvent = AtomicReference<Pair<String, String>?>(null)

            bridge.open(
                streamId = "s-ok",
                baseUrl = server.baseUrl,
                channel = NativeChannel.LAN_TLS,
                path = "/api/events",
                bearerToken = "sse-token",
                pinnedCertSha256 = idA.sha256Fingerprint,
                listener = object : SSEStreamListener {
                    override fun onOpen(streamId: String) = openLatch.countDown()
                    override fun onEvent(streamId: String, type: String, data: String) {
                        receivedEvent.set(type to data)
                        eventLatch.countDown()
                    }
                    override fun onError(streamId: String, message: String) = Unit
                    override fun onUnauthorized(streamId: String) = Unit
                    override fun onPinMismatch(streamId: String, mismatch: NativePinMismatch) = Unit
                },
            )

            assertTrue("SSE should open", openLatch.await(5, TimeUnit.SECONDS))
            assertTrue("SSE should deliver event", eventLatch.await(5, TimeUnit.SECONDS))
            assertEquals("delta" to """{"text":"你好 Vecway"}""", receivedEvent.get())
            bridge.close("s-ok")

            // 2. Wrong fingerprint triggers onPinMismatch immediately.
            val mismatchLatch = CountDownLatch(1)
            val mismatchRef = AtomicReference<NativePinMismatch?>(null)
            bridge.open(
                streamId = "s-bad",
                baseUrl = server.baseUrl,
                channel = NativeChannel.LAN_TLS,
                path = "/api/events",
                bearerToken = "sse-token",
                pinnedCertSha256 = idB.sha256Fingerprint,
                listener = object : SSEStreamListener {
                    override fun onOpen(streamId: String) = fail("Must not open on mismatch")
                    override fun onEvent(streamId: String, type: String, data: String) = fail("Must not emit events")
                    override fun onError(streamId: String, message: String) = Unit
                    override fun onUnauthorized(streamId: String) = Unit
                    override fun onPinMismatch(streamId: String, mismatch: NativePinMismatch) {
                        mismatchRef.set(mismatch)
                        mismatchLatch.countDown()
                    }
                },
            )
            assertTrue("SSE pin mismatch callback must fire", mismatchLatch.await(5, TimeUnit.SECONDS))
            assertEquals(idB.sha256Fingerprint, mismatchRef.get()?.expectedSha256)
            assertEquals(idA.sha256Fingerprint, mismatchRef.get()?.actualSha256)
            bridge.closeAll()
        }
    }

    @Test
    fun sseBridgeTriggersOnUnauthorizedImmediatelyOn401() {
        val idA = generateSelfSignedIdentity("vecway-sse-401")
        val res401 = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()
        SingleShotTlsServer(idA) { _, _ -> res401 }.use { server ->
            val bridge = SSEBridge(PinnedTransport())
            val unauthLatch = CountDownLatch(1)
            bridge.open(
                streamId = "s-401",
                baseUrl = server.baseUrl,
                channel = NativeChannel.LAN_TLS,
                path = "/api/events",
                bearerToken = "revoked-token",
                pinnedCertSha256 = idA.sha256Fingerprint,
                listener = object : SSEStreamListener {
                    override fun onOpen(streamId: String) = fail("Must not open on 401")
                    override fun onEvent(streamId: String, type: String, data: String) = Unit
                    override fun onError(streamId: String, message: String) = Unit
                    override fun onUnauthorized(streamId: String) = unauthLatch.countDown()
                    override fun onPinMismatch(streamId: String, mismatch: NativePinMismatch) = Unit
                },
            )
            assertTrue("401 revocation must trigger onUnauthorized", unauthLatch.await(5, TimeUnit.SECONDS))
            bridge.closeAll()
        }
    }
}

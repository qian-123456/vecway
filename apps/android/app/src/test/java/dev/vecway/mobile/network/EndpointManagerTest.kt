package dev.vecway.mobile.network

import dev.vecway.mobile.security.EndpointCandidates
import dev.vecway.mobile.security.InMemoryCredentialStore
import dev.vecway.mobile.security.NativeChannel
import dev.vecway.mobile.security.PairingPayloadException
import dev.vecway.mobile.security.StoredCredentials
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class EndpointManagerTest {

    private val fpExpected = (0 until 32).joinToString(":") { "%02X".format(it) }
    private val fpAttacker = (0 until 32).joinToString(":") { "%02X".format(255 - it) }

    private class FakeTransport(
        private val handler: (
            baseUrl: String,
            channel: NativeChannel,
            method: String,
            path: String,
            pinnedCertSha256: String?,
        ) -> TransportResponse,
    ) : HttpTransport {
        val visitedChannels = CopyOnWriteArrayList<NativeChannel>()

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
        ): TransportResponse {
            visitedChannels.add(channel)
            return handler(baseUrl, channel, method, path, pinnedCertSha256)
        }

        override suspend fun exchangePairingCode(
            baseUrl: String,
            channel: NativeChannel,
            code: String,
            pinnedCertSha256: String?,
            deviceName: String?,
            timeoutMs: Long,
        ): PairExchangeResponse {
            return PairExchangeResponse(token = "tok-$code", device = PairedDeviceInfo("d1", deviceName))
        }

        override fun buildClient(
            baseUrl: String,
            channel: NativeChannel,
            pinnedCertSha256: String?,
            connectTimeoutMs: Long,
            readTimeoutMs: Long,
            mismatchSink: AtomicReference<NativePinMismatch?>,
        ): OkHttpClient = OkHttpClient()
    }

    @Test
    fun lanPinMismatchHardBlocksWithoutFallingBackToIpv6OrTunnel() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "tok-1",
                pinnedCertSha256 = fpExpected,
                endpoints = EndpointCandidates(
                    lanTls = "https://192.168.1.9:7790",
                    ipv6 = "https://home.example.com:7789",
                    tunnel = "https://safe.trycloudflare.com",
                ),
            ),
        )
        val transport = FakeTransport { _, channel, _, _, _ ->
            if (channel == NativeChannel.LAN_TLS) {
                throw TransportException.PinMismatch(
                    NativePinMismatch(fpExpected, fpAttacker, "192.168.1.9", NativeChannel.LAN_TLS),
                )
            }
            TransportResponse(200, emptyMap(), """{"ok":true}""".toByteArray())
        }
        val manager = EndpointManager(store = store, transport = transport)
        val mismatchSignaled = AtomicBoolean(false)
        manager.onPinMismatchDetected = { mismatchSignaled.set(true) }

        val status = manager.reprobeConnection()
        assertTrue(status.paired)
        assertNull("Must NOT activate any channel on pin mismatch", status.activeChannel)
        assertNotNull("Must record pinMismatch", status.pinMismatch)
        assertEquals(fpAttacker, status.pinMismatch!!.actualSha256)
        assertTrue(mismatchSignaled.get())
        assertEquals(
            "Must NEVER fall back to ipv6/tunnel after LAN pin mismatch",
            listOf(NativeChannel.LAN_TLS),
            transport.visitedChannels,
        )

        // Subsequent requests must remain hard-blocked without touching transport.
        try {
            manager.performRequest("GET", "/api/sessions")
            fail("Expected PinMismatch hard block")
        } catch (_: TransportException.PinMismatch) {
            // Expected
        }
    }

    @Test
    fun ipv6PinMismatchHardBlocksEvenWhenTunnelIsReachable() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "tok-2",
                pinnedCertSha256 = fpExpected,
                endpoints = EndpointCandidates(
                    lanTls = "https://192.168.1.9:7790",
                    ipv6 = "https://home.example.com:7789",
                    tunnel = "https://ok.trycloudflare.com",
                ),
            ),
        )
        val transport = FakeTransport { _, channel, _, _, _ ->
            when (channel) {
                NativeChannel.LAN_TLS -> throw TransportException.Unreachable("off LAN")
                NativeChannel.IPV6_TLS -> throw TransportException.PinMismatch(
                    NativePinMismatch(fpExpected, fpAttacker, "home.example.com", NativeChannel.IPV6_TLS),
                )
                NativeChannel.TUNNEL -> TransportResponse(200, emptyMap(), """{"ok":true}""".toByteArray())
            }
        }
        val manager = EndpointManager(store = store, transport = transport)
        val status = manager.reprobeConnection()

        assertNull("Must hard-block instead of silently falling back to Tunnel", status.activeChannel)
        assertNotNull(status.pinMismatch)
        assertEquals(NativeChannel.IPV6_TLS, status.pinMismatch!!.channel)
    }

    @Test
    fun prefersIpv6OverTunnelWhenLanIsUnreachable() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "tok-3",
                pinnedCertSha256 = fpExpected,
                endpoints = EndpointCandidates(
                    lanTls = "https://192.168.1.9:7790",
                    ipv6 = "https://home.example.com:7789",
                    tunnel = "https://ok.trycloudflare.com",
                ),
            ),
        )
        val transport = FakeTransport { _, channel, _, _, _ ->
            when (channel) {
                NativeChannel.LAN_TLS -> throw TransportException.Unreachable("cellular")
                NativeChannel.IPV6_TLS, NativeChannel.TUNNEL ->
                    TransportResponse(200, emptyMap(), """{"ok":true}""".toByteArray())
            }
        }
        val manager = EndpointManager(store = store, transport = transport)
        val status = manager.reprobeConnection()

        assertEquals(NativeChannel.IPV6_TLS, status.activeChannel)
        assertEquals("https://home.example.com:7789", status.activeUrl)
    }

    @Test
    fun remoteSettingsSyncUpdatesCandidateUrlsWithoutMutatingCertPin() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "tok-4",
                pinnedCertSha256 = fpExpected,
                endpoints = EndpointCandidates(
                    lanTls = "https://192.168.1.10:7790",
                ),
            ),
        )
        val settingsBody = """
            {
              "mobile": {
                "lanTlsUrl": "https://192.168.1.55:7790",
                "tunnelUrl": "https://fresh.trycloudflare.com",
                "certSha256": "$fpAttacker"
              }
            }
        """.trimIndent()
        val transport = FakeTransport { _, _, _, path, _ ->
            if (path == "/api/left/settings") {
                TransportResponse(200, emptyMap(), settingsBody.toByteArray())
            } else {
                TransportResponse(200, emptyMap(), """{"ok":true}""".toByteArray())
            }
        }
        val manager = EndpointManager(store = store, transport = transport)
        manager.reprobeConnection()
        manager.syncCandidatesFromSettings()

        val saved = store.load()!!
        assertEquals("https://192.168.1.55:7790", saved.endpoints.lanTls)
        assertEquals("https://fresh.trycloudflare.com", saved.endpoints.tunnel)
        assertEquals(
            "SECURITY INVARIANT: pinnedCertSha256 MUST NEVER be mutated by remote settings",
            fpExpected,
            saved.pinnedCertSha256,
        )
    }

    @Test
    fun revocation401TriggersImmediateDisconnectAndUnpairClearsStore() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "revoked",
                pinnedCertSha256 = fpExpected,
                endpoints = EndpointCandidates(lanTls = "https://192.168.1.10:7790"),
            ),
        )
        val transport = FakeTransport { _, _, _, _, _ ->
            TransportResponse(401, emptyMap(), """{"error":"unauthorized"}""".toByteArray())
        }
        val manager = EndpointManager(store = store, transport = transport)
        val unauthFired = AtomicBoolean(false)
        val unpairFired = AtomicBoolean(false)
        manager.onUnauthorized = { unauthFired.set(true) }
        manager.onWillUnpair = { unpairFired.set(true) }

        val status = manager.reprobeConnection()
        assertTrue(unauthFired.get())
        assertNull(status.activeChannel)

        manager.unpair()
        assertTrue(unpairFired.get())
        assertNull(store.load())
        assertFalse(manager.currentStatus().paired)
    }

    @Test
    fun updateEndpointsRejectsPlaintextHttpAndPreservesPin() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "tok-5",
                pinnedCertSha256 = fpExpected,
                endpoints = EndpointCandidates(lanTls = "https://192.168.1.10:7790"),
            ),
        )
        val transport = FakeTransport { _, _, _, _, _ ->
            TransportResponse(200, emptyMap(), """{"ok":true}""".toByteArray())
        }
        val manager = EndpointManager(store = store, transport = transport)

        try {
            manager.updateEndpoints(
                EndpointUpdatePatch(lanTls = PatchField(present = true, value = "http://192.168.1.10:7788")),
            )
            fail("Expected InsecureEndpoint")
        } catch (_: PairingPayloadException.InsecureEndpoint) {
            // Expected
        }
        assertEquals("https://192.168.1.10:7790", store.load()!!.endpoints.lanTls)
        assertEquals(fpExpected, store.load()!!.pinnedCertSha256)
    }

    @Test
    fun switchChannelPersistsPreferenceAndFiresActiveChannelChangedOnlyOnActualChange() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "tok-switch",
                pinnedCertSha256 = fpExpected,
                endpoints = EndpointCandidates(
                    lanTls = "https://192.168.1.10:7790",
                    ipv6 = "https://home.example.com:7789",
                    tunnel = "https://demo.trycloudflare.com",
                ),
            ),
        )
        val transport = FakeTransport { _, _, _, _, _ ->
            TransportResponse(200, emptyMap(), """{"ok":true}""".toByteArray())
        }
        val manager = EndpointManager(store = store, transport = transport)
        val channelChangeCount = AtomicInteger(0)
        manager.onActiveChannelChanged = { channelChangeCount.incrementAndGet() }

        // Initial auto reprobe picks LAN_TLS -> fires onActiveChannelChanged once.
        val initial = manager.reprobeConnection()
        assertEquals(NativeChannel.LAN_TLS, initial.activeChannel)
        assertNull(initial.preferredChannel)
        assertEquals(1, channelChangeCount.get())

        // Reprobing again when already on LAN_TLS must NOT fire onActiveChannelChanged.
        manager.reprobeConnection()
        assertEquals(1, channelChangeCount.get())

        // Switch explicitly to TUNNEL -> persists preference and fires callback.
        val switched = manager.switchChannel(NativeChannel.TUNNEL)
        assertEquals(NativeChannel.TUNNEL, switched.activeChannel)
        assertEquals("https://demo.trycloudflare.com", switched.activeUrl)
        assertEquals(NativeChannel.TUNNEL, switched.preferredChannel)
        assertEquals(NativeChannel.TUNNEL, store.load()!!.preferredChannel)
        assertEquals(2, channelChangeCount.get())

        // Subsequent reprobeConnection probes preferred channel (TUNNEL) first without touching LAN.
        transport.visitedChannels.clear()
        val reprobed = manager.reprobeConnection()
        assertEquals(NativeChannel.TUNNEL, reprobed.activeChannel)
        assertEquals(NativeChannel.TUNNEL, reprobed.preferredChannel)
        assertEquals(listOf(NativeChannel.TUNNEL), transport.visitedChannels.distinct())
        // Channel/URL stayed TUNNEL -> callback must NOT fire redundantly.
        assertEquals(2, channelChangeCount.get())

        // Switch back to Auto (null) -> clears preferredChannel and activates LAN_TLS.
        val autoStatus = manager.switchChannel(null)
        assertEquals(NativeChannel.LAN_TLS, autoStatus.activeChannel)
        assertNull(autoStatus.preferredChannel)
        assertNull(store.load()!!.preferredChannel)
        assertEquals(3, channelChangeCount.get())
    }

    @Test
    fun switchChannelThrowsUnreachableWithChineseGuidanceAndPreservesPreviousState() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "tok-unreach",
                pinnedCertSha256 = fpExpected,
                endpoints = EndpointCandidates(
                    lanTls = "https://192.168.1.10:7790",
                    tunnel = "https://demo.trycloudflare.com",
                ),
            ),
        )
        val transport = FakeTransport { _, channel, _, _, _ ->
            if (channel == NativeChannel.LAN_TLS) {
                throw TransportException.Unreachable("not on wifi")
            }
            TransportResponse(200, emptyMap(), """{"ok":true}""".toByteArray())
        }
        val manager = EndpointManager(store = store, transport = transport)

        val initial = manager.reprobeConnection()
        assertEquals(NativeChannel.TUNNEL, initial.activeChannel)

        try {
            manager.switchChannel(NativeChannel.LAN_TLS)
            fail("Expected TransportException.Unreachable for offline LAN")
        } catch (e: TransportException.Unreachable) {
            assertTrue(e.message!!.contains("局域网 TLS"))
        }
        assertEquals(NativeChannel.TUNNEL, manager.currentStatus().activeChannel)
        assertNull(store.load()!!.preferredChannel)

        try {
            manager.switchChannel(NativeChannel.IPV6_TLS)
            fail("Expected TransportException.Unreachable for unconfigured IPv6")
        } catch (e: TransportException.Unreachable) {
            assertTrue(e.message!!.contains("尚未配置"))
        }
    }

    @Test
    fun reprobeConnectionProbesPreferredFirstThenFallsBackWithoutDuplicateProbes() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "tok-pref-fallback",
                pinnedCertSha256 = fpExpected,
                endpoints = EndpointCandidates(
                    lanTls = "https://192.168.1.10:7790",
                    ipv6 = "https://home.example.com:7789",
                    tunnel = "https://demo.trycloudflare.com",
                ),
                preferredChannel = NativeChannel.TUNNEL,
            ),
        )
        val transport = FakeTransport { _, channel, _, path, _ ->
            if (channel == NativeChannel.TUNNEL && path == "/api/left/device") {
                throw TransportException.Unreachable("tunnel offline")
            }
            if (channel == NativeChannel.LAN_TLS && path == "/api/left/device") {
                throw TransportException.Unreachable("lan offline")
            }
            TransportResponse(200, emptyMap(), """{"ok":true}""".toByteArray())
        }
        val manager = EndpointManager(store = store, transport = transport)
        val status = manager.reprobeConnection()

        assertEquals(NativeChannel.IPV6_TLS, status.activeChannel)
        assertEquals(NativeChannel.TUNNEL, status.preferredChannel)
        // TUNNEL was probed once (preferred), then LAN_TLS, then IPV6_TLS (without re-probing TUNNEL).
        assertEquals(
            listOf(NativeChannel.TUNNEL, NativeChannel.LAN_TLS, NativeChannel.IPV6_TLS),
            transport.visitedChannels.take(3),
        )
        assertEquals(1, transport.visitedChannels.count { it == NativeChannel.TUNNEL })
    }

    @Test
    fun updateEndpointsAdoptsInitialCertSha256WhenUnpinnedAndRejectsOverwrite() = runBlocking {
        val store = InMemoryCredentialStore(
            StoredCredentials(
                deviceToken = "tok-domain",
                pinnedCertSha256 = null,
                endpoints = EndpointCandidates(tunnel = "https://omp.example.com"),
                preferredChannel = NativeChannel.TUNNEL,
            ),
        )
        val transport = FakeTransport { _, _, _, _, _ ->
            TransportResponse(200, emptyMap(), """{"ok":true}""".toByteArray())
        }
        val manager = EndpointManager(store = store, transport = transport)

        // Malformed fingerprint must fail cleanly without modifying store.
        try {
            manager.updateEndpoints(
                EndpointUpdatePatch(
                    lanTls = PatchField(present = true, value = "https://192.168.1.10:7790"),
                    certSha256 = PatchField(present = true, value = "bad-fp"),
                ),
            )
            fail("Expected InvalidFingerprint")
        } catch (_: PairingPayloadException.InvalidFingerprint) {
            // Expected
        }
        assertNull(store.load()!!.pinnedCertSha256)

        // Initial adoption when unpinned succeeds.
        val adopted = manager.updateEndpoints(
            EndpointUpdatePatch(
                lanTls = PatchField(present = true, value = "https://192.168.1.10:7790"),
                certSha256 = PatchField(present = true, value = fpExpected),
            ),
        )
        assertEquals(fpExpected, adopted.certSha256)
        assertEquals(fpExpected, store.load()!!.pinnedCertSha256)
        assertEquals("https://192.168.1.10:7790", adopted.candidates.lanTls)
        assertEquals(NativeChannel.TUNNEL, adopted.preferredChannel)

        // Attempting to overwrite an existing pin with a different value MUST be strictly rejected.
        try {
            manager.updateEndpoints(
                EndpointUpdatePatch(
                    lanTls = PatchField(present = true, value = "https://192.168.1.99:7790"),
                    certSha256 = PatchField(present = true, value = fpAttacker),
                ),
            )
            fail("Expected InvalidCertificatePin when attempting to overwrite existing pin")
        } catch (_: TransportException.InvalidCertificatePin) {
            // Expected
        }
        assertEquals(fpExpected, store.load()!!.pinnedCertSha256)
        assertEquals("https://192.168.1.10:7790", store.load()!!.endpoints.lanTls)

        // Clearing the endpoint targeted by preferredChannel resets preferredChannel to null.
        val clearedTunnel = manager.updateEndpoints(
            EndpointUpdatePatch(tunnel = PatchField(present = true, value = null)),
        )
        assertNull(clearedTunnel.preferredChannel)
        assertNull(store.load()!!.preferredChannel)
        assertEquals(NativeChannel.LAN_TLS, clearedTunnel.activeChannel)
    }
}

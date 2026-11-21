package dev.vecway.mobile.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import dev.vecway.mobile.security.CredentialStore
import dev.vecway.mobile.security.EndpointCandidates
import dev.vecway.mobile.security.NativeChannel
import dev.vecway.mobile.security.PairingPayload
import dev.vecway.mobile.security.StoredCredentials
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Connection status snapshot matching `src-mobile/core/nativeBridge.ts` `NativeEndpointStatus`. */
data class NativeEndpointStatus(
    val paired: Boolean,
    val activeChannel: NativeChannel? = null,
    val activeUrl: String? = null,
    val certSha256: String? = null,
    val candidates: EndpointCandidates = EndpointCandidates(),
    val pinMismatch: NativePinMismatch? = null,
) {
    /** Explicitly encodes `null` for nullable fields so JS receives strict `null` rather than `undefined`. */
    fun toJson(): JSONObject = JSONObject().apply {
        put("paired", paired)
        put("activeChannel", activeChannel?.wireValue ?: JSONObject.NULL)
        put("activeUrl", activeUrl ?: JSONObject.NULL)
        put("certSha256", certSha256 ?: JSONObject.NULL)
        put("candidates", candidates.toJson())
        put("pinMismatch", pinMismatch?.toJson() ?: JSONObject.NULL)
    }
}

/** Partial endpoint update patch: `present=false` keeps existing; `present=true, value=null/blank` clears. */
data class PatchField(val present: Boolean = false, val value: String? = null)

data class EndpointUpdatePatch(
    val lanTls: PatchField = PatchField(),
    val ipv6: PatchField = PatchField(),
    val tunnel: PatchField = PatchField(),
)

data class ActiveRoute(
    val channel: NativeChannel,
    val baseUrl: String,
    val bearerToken: String,
    val pinnedCertSha256: String?,
)

/**
 * Manages multi-channel selection (`lan_tls` -> `ipv6_tls` || `tunnel`), pairing,
 * dynamic candidate syncing (NEVER mutating `pinnedCertSha256`), network-change re-probing,
 * 401 revocation handling, and strict certificate pin-mismatch hard blocking.
 */
class EndpointManager(
    private val store: CredentialStore,
    val transport: HttpTransport = PinnedTransport(),
    private val lanProbeTimeoutMs: Long = 1_500L,
    private val remoteProbeTimeoutMs: Long = 5_000L,
    private val deviceNameProvider: () -> String = { "Android" },
) {
    private sealed class ProbeOutcome {
        data class Reachable(val channel: NativeChannel, val url: String) : ProbeOutcome()
        data class PinMismatch(val mismatch: NativePinMismatch) : ProbeOutcome()
        data object Unauthorized : ProbeOutcome()
        data object Unreachable : ProbeOutcome()
    }

    private val lock = Any()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var cachedCredentials: StoredCredentials? = runCatching { store.load() }.getOrNull()
    private var activeChannel: NativeChannel? = null
    private var activeUrl: String? = null
    private var pinMismatch: NativePinMismatch? = null
    private var isUnauthorized: Boolean = false
    private val listeners = ConcurrentHashMap<UUID, (NativeEndpointStatus) -> Unit>()

    @Volatile
    var onWillUnpair: (() -> Unit)? = null

    @Volatile
    var onUnauthorized: (() -> Unit)? = null

    @Volatile
    var onPinMismatchDetected: ((NativePinMismatch) -> Unit)? = null

    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    fun addStatusListener(listener: (NativeEndpointStatus) -> Unit): () -> Unit {
        val id = UUID.randomUUID()
        listeners[id] = listener
        return { listeners.remove(id) }
    }

    fun currentStatus(): NativeEndpointStatus = synchronized(lock) {
        snapshotLocked()
    }

    fun startNetworkMonitoring(context: Context) {
        if (networkCallback != null) return
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                triggerAutoReprobe()
            }

            override fun onLost(network: Network) {
                triggerAutoReprobe()
            }

            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                triggerAutoReprobe()
            }
        }
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching {
            cm.registerNetworkCallback(req, cb)
            connectivityManager = cm
            networkCallback = cb
        }
    }

    fun stopNetworkMonitoring() {
        val cm = connectivityManager
        val cb = networkCallback
        connectivityManager = null
        networkCallback = null
        if (cm != null && cb != null) {
            runCatching { cm.unregisterNetworkCallback(cb) }
        }
    }

    private fun triggerAutoReprobe() {
        val shouldProbe = synchronized(lock) {
            cachedCredentials != null && pinMismatch == null && !isUnauthorized
        }
        if (shouldProbe) {
            scope.launch { reprobeConnection() }
        }
    }

    /** Exchanges a scanned pairing payload over HTTPS/TLS, persists encrypted credentials, and activates the channel. */
    suspend fun pair(payload: PairingPayload): NativeEndpointStatus {
        val attempts = payload.orderedPairingAttempts()
        if (attempts.isEmpty()) throw TransportException.Unreachable("配对信息中无可用通道")

        var lastError: Throwable? = null
        for ((channel, url) in attempts) {
            val timeout = if (channel == NativeChannel.LAN_TLS) 5_000L else 8_000L
            try {
                val exchanged = transport.exchangePairingCode(
                    baseUrl = url,
                    channel = channel,
                    code = payload.code,
                    pinnedCertSha256 = payload.certSha256,
                    deviceName = deviceNameProvider(),
                    timeoutMs = timeout,
                )
                val creds = StoredCredentials(
                    deviceToken = exchanged.token,
                    pinnedCertSha256 = payload.certSha256,
                    endpoints = payload.endpoints,
                    deviceId = exchanged.device?.id,
                    deviceName = exchanged.device?.name,
                )
                store.save(creds)
                val status = synchronized(lock) {
                    cachedCredentials = creds
                    activeChannel = channel
                    activeUrl = url
                    pinMismatch = null
                    isUnauthorized = false
                    snapshotLocked()
                }
                emitStatus(status)
                scope.launch { syncCandidatesFromSettings() }
                return status
            } catch (e: TransportException.PinMismatch) {
                recordPinMismatch(e.mismatch)
                throw e
            } catch (e: TransportException.PlaintextForbidden) {
                throw e
            } catch (e: TransportException.HttpError) {
                // Server explicitly rejected pairing (403/400/410) — stop immediately.
                if (e.status in 400..499) throw e
                lastError = e
            } catch (t: Throwable) {
                lastError = t
            }
        }
        throw lastError ?: TransportException.Unreachable("无法连接到电脑端完成配对")
    }

    /** Probes channels (`lan_tls` first with short 1.5s timeout, then `ipv6_tls` || `tunnel` in parallel). */
    suspend fun reprobeConnection(): NativeEndpointStatus {
        val creds = synchronized(lock) { cachedCredentials }
            ?: return currentStatus()

        val lanUrl = creds.endpoints.lanTls
        if (lanUrl != null) {
            when (val res = probeChannel(NativeChannel.LAN_TLS, lanUrl, creds, lanProbeTimeoutMs)) {
                is ProbeOutcome.Reachable -> return activateChannel(res.channel, res.url)
                is ProbeOutcome.PinMismatch -> return recordPinMismatch(res.mismatch)
                is ProbeOutcome.Unauthorized -> return recordUnauthorized()
                is ProbeOutcome.Unreachable -> Unit
            }
        }

        val remote = coroutineScope {
            val ipv6Deferred = creds.endpoints.ipv6?.let { url ->
                async { probeChannel(NativeChannel.IPV6_TLS, url, creds, remoteProbeTimeoutMs) }
            }
            val tunnelDeferred = creds.endpoints.tunnel?.let { url ->
                async { probeChannel(NativeChannel.TUNNEL, url, creds, remoteProbeTimeoutMs) }
            }
            listOfNotNull(ipv6Deferred?.await(), tunnelDeferred?.await())
        }

        // Security rule: any PinMismatch hard-blocks immediately (never fall back to another channel).
        remote.filterIsInstance<ProbeOutcome.PinMismatch>().firstOrNull()?.let {
            return recordPinMismatch(it.mismatch)
        }
        if (remote.any { it is ProbeOutcome.Unauthorized }) {
            return recordUnauthorized()
        }
        // Prefer IPv6 TLS over Tunnel when both are reachable.
        val reachable = remote.filterIsInstance<ProbeOutcome.Reachable>()
        val chosen = reachable.firstOrNull { it.channel == NativeChannel.IPV6_TLS }
            ?: reachable.firstOrNull { it.channel == NativeChannel.TUNNEL }
        if (chosen != null) {
            return activateChannel(chosen.channel, chosen.url)
        }

        val status = synchronized(lock) {
            activeChannel = null
            activeUrl = null
            snapshotLocked()
        }
        emitStatus(status)
        return status
    }

    /** Resolves an active HTTPS route for API requests or SSE streams (probes on demand if idle). */
    suspend fun resolveActiveRoute(): ActiveRoute {
        val state = synchronized(lock) {
            val mismatch = pinMismatch
            if (mismatch != null) throw TransportException.PinMismatch(mismatch)
            val creds = cachedCredentials ?: throw TransportException.Unpaired()
            Triple(creds, activeChannel, activeUrl)
        }
        val (creds, ch, url) = state
        if (ch != null && url != null) {
            return ActiveRoute(
                channel = ch,
                baseUrl = url,
                bearerToken = creds.deviceToken,
                pinnedCertSha256 = creds.pinnedCertSha256,
            )
        }

        val probed = reprobeConnection()
        probed.pinMismatch?.let { throw TransportException.PinMismatch(it) }
        val activeCh = probed.activeChannel ?: throw TransportException.Unreachable("当前所有通道均不可达")
        val activeEndpoint = probed.activeUrl ?: throw TransportException.Unreachable("当前所有通道均不可达")
        val latestCreds = synchronized(lock) { cachedCredentials } ?: throw TransportException.Unpaired()
        return ActiveRoute(
            channel = activeCh,
            baseUrl = activeEndpoint,
            bearerToken = latestCreds.deviceToken,
            pinnedCertSha256 = latestCreds.pinnedCertSha256,
        )
    }

    /** Executes an authenticated HTTPS request through the active channel with automatic failover on network error. */
    suspend fun performRequest(
        method: String,
        path: String,
        headers: Map<String, String>? = null,
        body: ByteArray? = null,
        timeoutMs: Long = 30_000L,
    ): TransportResponse {
        val route = resolveActiveRoute()
        try {
            val res = transport.request(
                baseUrl = route.baseUrl,
                channel = route.channel,
                method = method,
                path = path,
                headers = headers,
                body = body,
                bearerToken = route.bearerToken,
                pinnedCertSha256 = route.pinnedCertSha256,
                timeoutMs = timeoutMs,
            )
            if (res.status == 401) {
                recordUnauthorized()
            }
            return res
        } catch (e: TransportException.PinMismatch) {
            recordPinMismatch(e.mismatch)
            throw e
        } catch (e: TransportException.Unreachable) {
            // Try failing over to another configured channel once on transport unreachability.
            val reprobed = reprobeConnection()
            reprobed.pinMismatch?.let { throw TransportException.PinMismatch(it) }
            val nextCh = reprobed.activeChannel
            val nextUrl = reprobed.activeUrl
            if (nextCh != null && nextUrl != null && (nextCh != route.channel || nextUrl != route.baseUrl)) {
                val latest = synchronized(lock) { cachedCredentials } ?: throw TransportException.Unpaired()
                val retryRes = try {
                    transport.request(
                        baseUrl = nextUrl,
                        channel = nextCh,
                        method = method,
                        path = path,
                        headers = headers,
                        body = body,
                        bearerToken = latest.deviceToken,
                        pinnedCertSha256 = latest.pinnedCertSha256,
                        timeoutMs = timeoutMs,
                    )
                } catch (pm: TransportException.PinMismatch) {
                    recordPinMismatch(pm.mismatch)
                    throw pm
                }
                if (retryRes.status == 401) {
                    recordUnauthorized()
                }
                return retryRes
            }
            throw e
        }
    }

    /** Updates manual candidate endpoints (strictly HTTPS-only; never touches `pinnedCertSha256`). */
    suspend fun updateEndpoints(patch: EndpointUpdatePatch): NativeEndpointStatus {
        val current = synchronized(lock) { cachedCredentials } ?: throw TransportException.Unpaired()
        val nextLan = if (patch.lanTls.present) {
            patch.lanTls.value?.trim()?.takeIf { it.isNotEmpty() }?.let {
                PairingPayload.validateHttpsEndpoint(it, "lanTls")
            }
        } else {
            current.endpoints.lanTls
        }
        val nextIpv6 = if (patch.ipv6.present) {
            patch.ipv6.value?.trim()?.takeIf { it.isNotEmpty() }?.let {
                PairingPayload.validateHttpsEndpoint(it, "ipv6")
            }
        } else {
            current.endpoints.ipv6
        }
        val nextTunnel = if (patch.tunnel.present) {
            patch.tunnel.value?.trim()?.takeIf { it.isNotEmpty() }?.let {
                PairingPayload.validateHttpsEndpoint(it, "tunnel")
            }
        } else {
            current.endpoints.tunnel
        }
        val nextCandidates = EndpointCandidates(lanTls = nextLan, ipv6 = nextIpv6, tunnel = nextTunnel)
        if (nextCandidates.isEmpty) {
            throw TransportException.InvalidUrl("至少需要保留一个有效的 HTTPS 连接地址")
        }
        if ((nextLan != null || nextIpv6 != null) && current.pinnedCertSha256.isNullOrBlank()) {
            throw TransportException.MissingCertificatePin(
                if (nextLan != null) NativeChannel.LAN_TLS else NativeChannel.IPV6_TLS,
            )
        }
        val updated = current.copy(endpoints = nextCandidates)
        store.save(updated)
        synchronized(lock) {
            cachedCredentials = updated
            activeChannel = null
            activeUrl = null
        }
        return reprobeConnection()
    }

    /** Clears all local credentials, stops streams, and resets to unpaired state. */
    fun unpair() {
        onWillUnpair?.invoke()
        store.clear()
        val status = synchronized(lock) {
            cachedCredentials = null
            activeChannel = null
            activeUrl = null
            pinMismatch = null
            isUnauthorized = false
            snapshotLocked()
        }
        emitStatus(status)
    }

    /** Records an external revocation signal (e.g. from SSE 401) and halts streams immediately. */
    fun markUnauthorizedFromStream() {
        recordUnauthorized()
    }

    /** Records an external certificate pin mismatch (e.g. from SSE handshake) and hard-blocks. */
    fun markPinMismatchFromStream(mismatch: NativePinMismatch) {
        recordPinMismatch(mismatch)
    }

    /**
     * Fetches `GET /api/left/settings` on an already-trusted active channel and updates candidate URLs.
     * SECURITY INVARIANT: Deliberately ignores `mobile.certSha256` — client MUST NEVER mutate its pinned fingerprint remotely.
     */
    suspend fun syncCandidatesFromSettings() {
        val creds = synchronized(lock) {
            if (pinMismatch != null || isUnauthorized) return
            cachedCredentials
        } ?: return
        val response = runCatching {
            performRequest("GET", "/api/left/settings", timeoutMs = 5_000L)
        }.getOrNull() ?: return
        if (response.status !in 200..299) return
        val mobile = runCatching {
            JSONObject(String(response.body, Charsets.UTF_8)).optJSONObject("mobile")
        }.getOrNull() ?: return

        val remoteLan = mobile.optString("lanTlsUrl", "").takeIf { it.isNotBlank() }?.let {
            runCatching { PairingPayload.validateHttpsEndpoint(it, "lanTlsUrl") }.getOrNull()
        }
        val remoteIpv6 = mobile.optString("ipv6Url", "").takeIf { it.isNotBlank() }?.let {
            runCatching { PairingPayload.validateHttpsEndpoint(it, "ipv6Url") }.getOrNull()
        }
        val remoteTunnel = mobile.optString("tunnelUrl", "").takeIf { it.isNotBlank() }?.let {
            runCatching { PairingPayload.validateHttpsEndpoint(it, "tunnelUrl") }.getOrNull()
        }

        val merged = EndpointCandidates(
            lanTls = remoteLan ?: creds.endpoints.lanTls,
            ipv6 = remoteIpv6 ?: creds.endpoints.ipv6,
            tunnel = remoteTunnel ?: creds.endpoints.tunnel,
        )
        if (merged == creds.endpoints) return

        val updated = creds.copy(endpoints = merged) // pinnedCertSha256 untouched!
        store.save(updated)
        val status = synchronized(lock) {
            if (cachedCredentials?.deviceToken == creds.deviceToken) {
                cachedCredentials = updated
            }
            snapshotLocked()
        }
        emitStatus(status)
    }

    private suspend fun probeChannel(
        channel: NativeChannel,
        url: String,
        creds: StoredCredentials,
        timeoutMs: Long,
    ): ProbeOutcome {
        return try {
            val res = transport.request(
                baseUrl = url,
                channel = channel,
                method = "GET",
                path = "/api/left/device",
                headers = mapOf("Accept" to "application/json"),
                body = null,
                bearerToken = creds.deviceToken,
                pinnedCertSha256 = creds.pinnedCertSha256,
                timeoutMs = timeoutMs,
            )
            when {
                res.status in 200..299 -> ProbeOutcome.Reachable(channel, url)
                res.status == 401 -> ProbeOutcome.Unauthorized
                else -> ProbeOutcome.Unreachable
            }
        } catch (e: TransportException.PinMismatch) {
            ProbeOutcome.PinMismatch(e.mismatch)
        } catch (_: Throwable) {
            ProbeOutcome.Unreachable
        }
    }

    private fun activateChannel(channel: NativeChannel, url: String): NativeEndpointStatus {
        val status = synchronized(lock) {
            activeChannel = channel
            activeUrl = url
            pinMismatch = null
            isUnauthorized = false
            snapshotLocked()
        }
        emitStatus(status)
        scope.launch { syncCandidatesFromSettings() }
        return status
    }

    private fun recordPinMismatch(mismatch: NativePinMismatch): NativeEndpointStatus {
        val status = synchronized(lock) {
            activeChannel = null
            activeUrl = null
            pinMismatch = mismatch
            snapshotLocked()
        }
        onPinMismatchDetected?.invoke(mismatch)
        emitStatus(status)
        return status
    }

    private fun recordUnauthorized(): NativeEndpointStatus {
        val status = synchronized(lock) {
            activeChannel = null
            activeUrl = null
            isUnauthorized = true
            snapshotLocked()
        }
        onUnauthorized?.invoke()
        emitStatus(status)
        return status
    }

    private fun snapshotLocked(): NativeEndpointStatus {
        val creds = cachedCredentials
        return NativeEndpointStatus(
            paired = creds != null,
            activeChannel = activeChannel,
            activeUrl = activeUrl,
            certSha256 = creds?.pinnedCertSha256,
            candidates = creds?.endpoints ?: EndpointCandidates(),
            pinMismatch = pinMismatch,
        )
    }

    private fun emitStatus(status: NativeEndpointStatus) {
        listeners.values.forEach { listener ->
            runCatching { listener(status) }
        }
    }
}

package dev.vecway.mobile

import android.app.Application
import android.content.Context
import android.os.Build
import dev.vecway.mobile.network.EndpointManager
import dev.vecway.mobile.network.PinnedTransport
import dev.vecway.mobile.network.SSEBridge
import dev.vecway.mobile.push.NativePushManager
import dev.vecway.mobile.security.KeystoreCredentialStore

/**
 * Application singleton owning encrypted credentials, TLS-pinned HTTP/SSE transports,
 * multi-channel endpoint management, and network-change monitoring.
 */
class VecwayApp : Application() {
    lateinit var credentialStore: KeystoreCredentialStore
        private set
    lateinit var transport: PinnedTransport
        private set
    lateinit var endpointManager: EndpointManager
        private set
    lateinit var sseBridge: SSEBridge
        private set
    lateinit var pushManager: NativePushManager
        private set

    override fun onCreate() {
        super.onCreate()
        val userAgent = "Vecway-Android/${BuildConfig.VERSION_NAME}"
        credentialStore = KeystoreCredentialStore(this)
        transport = PinnedTransport(userAgent = userAgent)
        sseBridge = SSEBridge(transport = transport, userAgent = userAgent)
        endpointManager = EndpointManager(
            store = credentialStore,
            transport = transport,
            deviceNameProvider = {
                val brand = Build.MANUFACTURER.orEmpty().trim()
                val model = Build.MODEL.orEmpty().trim()
                when {
                    brand.isEmpty() && model.isEmpty() -> "Android"
                    model.startsWith(brand, ignoreCase = true) -> model
                    else -> "$brand $model".trim()
                }
            },
        )
        pushManager = NativePushManager(this)

        // Immediately sever all active SSE streams on unpair, revocation (401), or TLS pin mismatch.
        endpointManager.onWillUnpair = { sseBridge.closeAll() }
        endpointManager.onUnauthorized = { sseBridge.closeAll() }
        endpointManager.onPinMismatchDetected = { sseBridge.closeAll() }
        endpointManager.startNetworkMonitoring(this)
    }

    companion object {
        fun from(context: Context): VecwayApp = context.applicationContext as VecwayApp
    }
}

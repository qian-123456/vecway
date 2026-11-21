package dev.vecway.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import dev.vecway.mobile.audio.NativeVoiceRecorder
import dev.vecway.mobile.network.NativeEndpointStatus
import dev.vecway.mobile.scanner.QRScannerActivity
import dev.vecway.mobile.security.CertificateFingerprint
import dev.vecway.mobile.security.PairingPayload
import dev.vecway.mobile.ui.PinMismatchOverlay
import dev.vecway.mobile.web.AppChromeClient
import dev.vecway.mobile.web.AppWebViewClient
import dev.vecway.mobile.web.BridgeInterface
import dev.vecway.mobile.web.ScannerOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * Full-bleed WebView host Activity for Vecway Android.
 *
 * Responsibilities:
 * - Hosts bundled `src-mobile` via `https://appassets.androidplatform.net/index.html`.
 * - Wires `BridgeInterface` (`window.__VECWAY_NATIVE__`), `NativeVoiceRecorder`, `QRScannerActivity`,
 *   camera/multi-select file chooser, and `PinMismatchOverlay` hard-blocking screen.
 * - Handles `vecway://pair?...` deep links with explicit SHA-256 fingerprint confirmation.
 * - Integrates Android system back gesture with SPA history (`webView.canGoBack()`).
 * - Triggers endpoint reprobe + `foregroundResync` upon returning from background.
 */
class MainActivity : AppCompatActivity() {

    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private lateinit var app: VecwayApp
    private lateinit var webView: WebView
    private lateinit var pinMismatchOverlay: PinMismatchOverlay
    private lateinit var voiceRecorder: NativeVoiceRecorder
    private lateinit var bridge: BridgeInterface

    private var statusUnsubscribe: (() -> Unit)? = null
    private var wasStopped = false
    private var latestSafeTopDp = 0f
    private var latestSafeBottomDp = 0f

    // Pending async bridges for ActivityResult launchers.
    private var pendingScannerResult: CompletableDeferred<ScannerOutcome>? = null
    private var pendingMicPermission: CompletableDeferred<Boolean>? = null
    private var pendingWebPermissionRequest: Pair<PermissionRequest, List<String>>? = null
    private var pendingFileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingFileChooserParams: WebChromeClient.FileChooserParams? = null
    private var pendingCameraCaptureUri: Uri? = null

    private val captureCameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val callback = pendingFileChooserCallback
        val params = pendingFileChooserParams
        pendingFileChooserParams = null
        if (callback == null || params == null) return@registerForActivityResult
        launchFileChooserInternal(callback, params, allowCameraIntent = granted)
    }

    private val scannerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val deferred = pendingScannerResult
        pendingScannerResult = null
        val status = app.endpointManager.currentStatus()
        val outcome = if (result.resultCode == RESULT_OK) {
            ScannerOutcome(ok = true, status = status)
        } else {
            val err = result.data?.getStringExtra(QRScannerActivity.EXTRA_ERROR)
            ScannerOutcome(ok = false, error = err, status = status)
        }
        deferred?.complete(outcome)
    }

    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val deferred = pendingMicPermission
        pendingMicPermission = null
        deferred?.complete(granted)
    }

    private val webMediaPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        val pending = pendingWebPermissionRequest
        pendingWebPermissionRequest = null
        if (pending == null) return@registerForActivityResult
        val (request, resources) = pending
        val grantedResources = resources.filter { res ->
            when (res) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> grants[Manifest.permission.RECORD_AUDIO] == true
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> grants[Manifest.permission.CAMERA] == true
                else -> false
            }
        }
        if (grantedResources.isNotEmpty()) {
            request.grant(grantedResources.toTypedArray())
        } else {
            request.deny()
        }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = pendingFileChooserCallback
        val cameraUri = pendingCameraCaptureUri
        pendingFileChooserCallback = null
        pendingCameraCaptureUri = null
        if (callback == null) return@registerForActivityResult

        if (result.resultCode != RESULT_OK) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }

        val data = result.data
        val uris = mutableListOf<Uri>()
        val clip = data?.clipData
        if (clip != null && clip.itemCount > 0) {
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i)?.uri?.let(uris::add)
            }
        } else if (data?.data != null) {
            uris.add(data.data!!)
        } else if (cameraUri != null) {
            uris.add(cameraUri)
        }

        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app = VecwayApp.from(this)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val nightMode = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        applySystemBarAppearance(isDark = nightMode)

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        // SECURITY: Credentials live strictly in Android Keystore, NEVER in WebView cookies.
        CookieManager.getInstance().setAcceptCookie(false)

        val root = FrameLayout(this)
        webView = WebView(this)
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        pinMismatchOverlay = PinMismatchOverlay(
            context = this,
            onRescan = { launchScannerManually() },
            onUnpair = { app.endpointManager.unpair() },
        )
        root.addView(
            pinMismatchOverlay,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        voiceRecorder = NativeVoiceRecorder(
            context = this,
            endpointManager = app.endpointManager,
            requestMicPermission = { requestMicrophonePermission() },
        )

        bridge = BridgeInterface(
            context = this,
            endpointManager = app.endpointManager,
            sseBridge = app.sseBridge,
            voiceRecorder = voiceRecorder,
            pushManager = app.pushManager,
            openScannerHandler = { launchScannerForBridge() },
            onThemeSchemeChanged = { scheme ->
                runOnUiThread { applySystemBarAppearance(isDark = scheme == "dark") }
            },
        )

        configureWebView()
        setupWindowInsets(root)
        setupBackNavigation()

        setContentView(root)

        statusUnsubscribe = app.endpointManager.addStatusListener { status ->
            runOnUiThread { applyStatusUpdate(status) }
        }
        app.endpointManager.onActiveChannelChanged = {
            app.sseBridge.closeAll()
            runOnUiThread {
                if (app.endpointManager.currentStatus().pinMismatch == null) {
                    bridge.notifyForegroundResync()
                }
            }
        }
        applyStatusUpdate(app.endpointManager.currentStatus())

        webView.loadUrl(AppWebViewClient.START_URL)

        if (app.endpointManager.currentStatus().paired) {
            uiScope.launch(Dispatchers.IO) {
                app.endpointManager.reprobeConnection()
            }
        }

        handleDeepLinkIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLinkIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        if (wasStopped) {
            wasStopped = false
            uiScope.launch {
                if (app.endpointManager.currentStatus().paired) {
                    withContext(Dispatchers.IO) {
                        app.endpointManager.reprobeConnection()
                    }
                    bridge.notifyForegroundResync()
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        wasStopped = true
    }

    override fun onDestroy() {
        super.onDestroy()
        statusUnsubscribe?.invoke()
        statusUnsubscribe = null
        app.endpointManager.onActiveChannelChanged = null
        pendingFileChooserCallback?.onReceiveValue(null)
        pendingFileChooserCallback = null
        pendingScannerResult?.complete(ScannerOutcome(ok = false, error = "页面已关闭"))
        pendingScannerResult = null
        pendingMicPermission?.complete(false)
        pendingMicPermission = null
        voiceRecorder.cancelRecording()
        bridge.detach()
        uiScope.cancel()
        webView.stopLoading()
        webView.destroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            setSupportMultipleWindows(false)
            builtInZoomControls = false
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        webView.overScrollMode = WebView.OVER_SCROLL_IF_CONTENT_SCROLLS

        val fallbackInlineScript = bridge.attach(webView, BuildConfig.VERSION_NAME)

        webView.webViewClient = AppWebViewClient(
            context = this,
            endpointManager = app.endpointManager,
            fallbackInlineBridgeScript = fallbackInlineScript,
            onDeepLink = { uri -> runOnUiThread { handlePairingDeepLinkUri(uri) } },
            onMainPageFinished = {
                bridge.applySafeAreaInsets(latestSafeTopDp, latestSafeBottomDp)
                bridge.notifyConnectionStatus(app.endpointManager.currentStatus())
            },
        )

        webView.webChromeClient = AppChromeClient(
            activity = this,
            onLaunchFileChooser = { callback, params -> launchFileChooser(callback, params) },
            onPermissionRequestForAppOrigin = { request, resources ->
                handleWebPermissionRequest(request, resources)
            },
        )
    }

    private fun setupWindowInsets(root: FrameLayout) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val sysBars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density.coerceAtLeast(1f)

            val bottomPadPx = if (ime.bottom > 0) ime.bottom else 0
            webView.setPadding(sysBars.left, 0, sysBars.right, bottomPadPx)

            latestSafeTopDp = sysBars.top / density
            latestSafeBottomDp = if (ime.bottom > 0) 0f else (sysBars.bottom / density)
            bridge.applySafeAreaInsets(latestSafeTopDp, latestSafeBottomDp)

            pinMismatchOverlay.setPadding(sysBars.left, sysBars.top, sysBars.right, sysBars.bottom)
            insets
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (pinMismatchOverlay.visibility == android.view.View.VISIBLE) {
                        moveTaskToBack(true)
                        return
                    }
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        moveTaskToBack(true)
                    }
                }
            },
        )
    }

    private fun applySystemBarAppearance(isDark: Boolean) {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = !isDark
        controller.isAppearanceLightNavigationBars = !isDark
    }

    private fun applyStatusUpdate(status: NativeEndpointStatus) {
        pinMismatchOverlay.render(status.pinMismatch)
        bridge.notifyConnectionStatus(status)
    }

    // MARK: - Scanner & Pairing

    private suspend fun launchScannerForBridge(): ScannerOutcome = withContext(Dispatchers.Main) {
        pendingScannerResult?.complete(ScannerOutcome(ok = false))
        val deferred = CompletableDeferred<ScannerOutcome>()
        pendingScannerResult = deferred
        scannerLauncher.launch(Intent(this@MainActivity, QRScannerActivity::class.java))
        deferred.await()
    }

    private fun launchScannerManually() {
        scannerLauncher.launch(Intent(this, QRScannerActivity::class.java))
    }

    private fun handleDeepLinkIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme?.equals("vecway", ignoreCase = true) == true &&
            uri.host?.equals("pair", ignoreCase = true) == true
        ) {
            handlePairingDeepLinkUri(uri)
        }
    }

    private fun handlePairingDeepLinkUri(uri: Uri) {
        val payload = try {
            PairingPayload.parse(uri.toString())
        } catch (t: Throwable) {
            AlertDialog.Builder(this)
                .setTitle("无效的配对链接")
                .setMessage(t.message ?: "无法解析该配对链接")
                .setPositiveButton("知道了", null)
                .show()
            return
        }

        val summary = buildString {
            append("是否配对此 Vecway 桌面端？\n\n")
            payload.endpoints.lanTls?.let { append("• 局域网 TLS：$it\n") }
            payload.endpoints.ipv6?.let { append("• IPv6 TLS：$it\n") }
            payload.endpoints.tunnel?.let { append("• Cloudflare Tunnel：$it\n") }
            payload.certSha256?.let { fp ->
                append("\n证书 SHA-256 指纹：\n")
                append(CertificateFingerprint.shortSummary(fp))
            }
        }

        AlertDialog.Builder(this)
            .setTitle("确认配对电脑")
            .setMessage(summary.trim())
            .setNegativeButton("取消", null)
            .setPositiveButton("确认配对") { _, _ ->
                uiScope.launch {
                    val result = withContext(Dispatchers.IO) {
                        runCatching { app.endpointManager.pair(payload) }
                    }
                    result.onFailure { err ->
                        if (!isFinishing && !isDestroyed) {
                            AlertDialog.Builder(this@MainActivity)
                                .setTitle("配对失败")
                                .setMessage(err.message ?: "无法连接到电脑端完成配对")
                                .setPositiveButton("知道了", null)
                                .show()
                        }
                    }
                }
            }
            .show()
    }

    // MARK: - Permissions & File Chooser

    private suspend fun requestMicrophonePermission(): Boolean = withContext(Dispatchers.Main) {
        val granted = ContextCompat.checkSelfPermission(
            this@MainActivity,
            Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) return@withContext true
        pendingMicPermission?.complete(false)
        val deferred = CompletableDeferred<Boolean>()
        pendingMicPermission = deferred
        micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        deferred.await()
    }

    private fun handleWebPermissionRequest(
        request: PermissionRequest,
        resources: List<String>,
    ) {
        val neededPermissions = mutableListOf<String>()
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in resources &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            neededPermissions.add(Manifest.permission.RECORD_AUDIO)
        }
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in resources &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
        ) {
            neededPermissions.add(Manifest.permission.CAMERA)
        }
        if (neededPermissions.isEmpty()) {
            request.grant(resources.toTypedArray())
            return
        }
        pendingWebPermissionRequest?.first?.deny()
        pendingWebPermissionRequest = Pair(request, resources)
        webMediaPermissionLauncher.launch(neededPermissions.toTypedArray())
    }

    private fun launchFileChooser(
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean {
        pendingFileChooserCallback?.onReceiveValue(null)
        pendingFileChooserCallback = callback
        pendingFileChooserParams = null
        pendingCameraCaptureUri = null

        val hasCameraPermission = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED

        // When AndroidManifest declares CAMERA (for QR scanning), Android throws SecurityException
        // on ACTION_IMAGE_CAPTURE unless CAMERA permission has been granted.
        if (params.isCaptureEnabled && !hasCameraPermission) {
            pendingFileChooserParams = params
            captureCameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            return true
        }

        return launchFileChooserInternal(callback, params, allowCameraIntent = hasCameraPermission)
    }

    private fun launchFileChooserInternal(
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
        allowCameraIntent: Boolean,
    ): Boolean {
        pendingFileChooserCallback = callback
        pendingCameraCaptureUri = null

        val acceptTypes = params.acceptTypes
            .filter { it.isNotBlank() }
            .ifEmpty { listOf("*/*") }
        val acceptsImages = acceptTypes.any { it == "*/*" || it.startsWith("image/", ignoreCase = true) }
        val allowMultiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE

        val contentIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (acceptTypes.size == 1) acceptTypes.first() else "*/*"
            if (acceptTypes.size > 1) {
                putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes.toTypedArray())
            }
            if (allowMultiple) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }

        val extraIntents = mutableListOf<Intent>()
        if (acceptsImages && allowCameraIntent) {
            createCameraCaptureIntent()?.let(extraIntents::add)
        }

        val targetIntent = if (params.isCaptureEnabled && extraIntents.isNotEmpty()) {
            extraIntents.first()
        } else {
            Intent.createChooser(contentIntent, "选择文件或拍照").apply {
                if (extraIntents.isNotEmpty()) {
                    putExtra(Intent.EXTRA_INITIAL_INTENTS, extraIntents.toTypedArray())
                }
            }
        }

        return try {
            fileChooserLauncher.launch(targetIntent)
            true
        } catch (_: Exception) {
            pendingFileChooserCallback?.onReceiveValue(null)
            pendingFileChooserCallback = null
            pendingCameraCaptureUri = null
            false
        }
    }

    private fun createCameraCaptureIntent(): Intent? {
        return try {
            val dir = File(cacheDir, "captures").apply { mkdirs() }
            val photoFile = File(dir, "capture-${UUID.randomUUID()}.jpg")
            val uri = FileProvider.getUriForFile(
                this,
                "${BuildConfig.APPLICATION_ID}.fileprovider",
                photoFile,
            )
            pendingCameraCaptureUri = uri
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
        } catch (_: Exception) {
            null
        }
    }
}

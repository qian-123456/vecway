package dev.vecway.mobile.scanner

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import dev.vecway.mobile.R
import dev.vecway.mobile.VecwayApp
import dev.vecway.mobile.security.CertificateFingerprint
import dev.vecway.mobile.security.PairingPayload
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Offline CameraX + ZXing QR code scanner for pairing with desktop Vecway.
 * Zero Google Play Services dependency; supports torch toggle and manual URL paste fallback.
 */
class QRScannerActivity : AppCompatActivity() {

    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val analysisPaused = AtomicBoolean(false)

    private lateinit var previewView: PreviewView
    private lateinit var permissionNotice: LinearLayout
    private lateinit var torchButton: Button

    private var camera: Camera? = null
    private var torchEnabled = false
    private var isPairingInFlight = false

    private val qrReader: MultiFormatReader = MultiFormatReader().apply {
        setHints(
            mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
            ),
        )
    }

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            permissionNotice.visibility = View.GONE
            startCamera()
        } else {
            permissionNotice.visibility = View.VISIBLE
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
        }

        previewView = PreviewView(this).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        root.addView(previewView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))

        val viewfinder = ViewfinderOverlay(this)
        root.addView(viewfinder, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(12))
        }
        val cancelBtn = makePillButton(getString(R.string.scanner_cancel)) {
            setResult(RESULT_CANCELED)
            finish()
        }
        topBar.addView(cancelBtn)

        val titleView = TextView(this).apply {
            text = getString(R.string.scanner_title)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        topBar.addView(titleView)

        torchButton = makePillButton(getString(R.string.scanner_torch)) {
            toggleTorch()
        }
        topBar.addView(torchButton)

        root.addView(
            topBar,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            ),
        )

        val bottomPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(16), dp(24), dp(28))
        }
        val hintText = TextView(this).apply {
            text = getString(R.string.scanner_hint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(Color.parseColor("#E5E7EB"))
            gravity = Gravity.CENTER
        }
        bottomPanel.addView(hintText)

        val pasteBtn = makePillButton(getString(R.string.scanner_paste)) {
            openManualPasteDialog()
        }.apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(14)
            }
        }
        bottomPanel.addView(pasteBtn)

        root.addView(
            bottomPanel,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            ),
        )

        permissionNotice = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            visibility = View.GONE
            setBackgroundColor(Color.parseColor("#E60C0D10"))
            setPadding(dp(28), dp(28), dp(28), dp(28))
            addView(
                TextView(this@QRScannerActivity).apply {
                    text = getString(R.string.scanner_permission_denied)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                    setTextColor(Color.WHITE)
                    gravity = Gravity.CENTER
                },
            )
            addView(
                makePillButton("前往系统设置") {
                    val intent = Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", packageName, null),
                    )
                    startActivity(intent)
                }.apply {
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(16) }
                },
            )
            addView(
                makePillButton(getString(R.string.scanner_paste)) {
                    openManualPasteDialog()
                }.apply {
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(10) }
                },
            )
        }
        root.addView(
            permissionNotice,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            topBar.setPadding(dp(16), bars.top + dp(12), dp(16), dp(12))
            bottomPanel.setPadding(dp(24), dp(16), dp(24), bars.bottom + dp(24))
            insets
        }

        setContentView(root)
        ensureCameraPermissionAndStart()
    }

    override fun onDestroy() {
        super.onDestroy()
        uiScope.cancel()
        analysisExecutor.shutdown()
    }

    private fun ensureCameraPermissionAndStart() {
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) {
            permissionNotice.visibility = View.GONE
            startCamera()
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener(
            {
                val provider = runCatching { future.get() }.getOrNull() ?: return@addListener
                val preview = Preview.Builder().build().apply {
                    surfaceProvider = previewView.surfaceProvider
                }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .apply {
                        setAnalyzer(analysisExecutor) { proxy ->
                            analyzeFrame(proxy)
                        }
                    }
                runCatching {
                    provider.unbindAll()
                    camera = provider.bindToLifecycle(
                        this,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis,
                    )
                }.onFailure {
                    Toast.makeText(this, "无法启动相机预览，可点击“手动输入”完成配对", Toast.LENGTH_LONG).show()
                }
            },
            ContextCompat.getMainExecutor(this),
        )
    }

    private fun toggleTorch() {
        val cam = camera ?: return
        if (!cam.cameraInfo.hasFlashUnit()) {
            Toast.makeText(this, "当前设备不支持补光灯", Toast.LENGTH_SHORT).show()
            return
        }
        torchEnabled = !torchEnabled
        cam.cameraControl.enableTorch(torchEnabled)
        torchButton.text = if (torchEnabled) "关灯" else getString(R.string.scanner_torch)
    }

    private fun analyzeFrame(image: ImageProxy) {
        try {
            if (analysisPaused.get() || isPairingInFlight) return
            val yPlane = image.planes.firstOrNull() ?: return
            val width = image.width
            val height = image.height
            val rowStride = yPlane.rowStride
            val buffer = yPlane.buffer
            val data = ByteArray(width * height)
            if (rowStride == width) {
                buffer.get(data, 0, data.size)
            } else {
                val rowBuf = ByteArray(rowStride)
                for (row in 0 until height) {
                    val remaining = buffer.remaining()
                    if (remaining < width) break
                    val toRead = minOf(rowStride, remaining)
                    buffer.get(rowBuf, 0, toRead)
                    System.arraycopy(rowBuf, 0, data, row * width, width)
                }
            }

            val source = PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false)
            val decoded = decodeQr(source)
            if (decoded != null && analysisPaused.compareAndSet(false, true)) {
                runOnUiThread { handleScannedText(decoded) }
            }
        } catch (_: Throwable) {
            // Ignore transient frame errors.
        } finally {
            image.close()
        }
    }

    private fun decodeQr(source: PlanarYUVLuminanceSource): String? {
        return try {
            qrReader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
        } catch (_: Exception) {
            try {
                qrReader.decodeWithState(BinaryBitmap(GlobalHistogramBinarizer(source))).text
            } catch (_: Exception) {
                null
            }
        } finally {
            qrReader.reset()
        }
    }

    private fun handleScannedText(raw: String) {
        val payload = try {
            PairingPayload.parse(raw)
        } catch (t: Throwable) {
            AlertDialog.Builder(this)
                .setTitle("无法识别配对二维码")
                .setMessage(t.message ?: "请扫描电脑端「设置 → 连接与设备」中的配对二维码")
                .setPositiveButton("继续扫描") { _, _ -> analysisPaused.set(false) }
                .setOnCancelListener { analysisPaused.set(false) }
                .show()
            return
        }
        showPairingConfirmation(payload)
    }

    private fun openManualPasteDialog() {
        analysisPaused.set(true)
        val input = EditText(this).apply {
            hint = "粘贴 vecway://pair?... 或配对链接"
            minLines = 3
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        AlertDialog.Builder(this)
            .setTitle("手动输入配对链接")
            .setView(input)
            .setNegativeButton("取消") { _, _ -> analysisPaused.set(false) }
            .setPositiveButton("解析并配对") { _, _ ->
                handleScannedText(input.text?.toString().orEmpty())
            }
            .setOnCancelListener { analysisPaused.set(false) }
            .show()
    }

    private fun showPairingConfirmation(payload: PairingPayload) {
        val lines = buildString {
            append("检测到 Vecway 桌面端配对信息：\n\n")
            payload.endpoints.lanTls?.let { append("• 局域网 TLS：$it\n") }
            payload.endpoints.ipv6?.let { append("• IPv6 TLS：$it\n") }
            payload.endpoints.tunnel?.let { append("• Cloudflare Tunnel：$it\n") }
            payload.certSha256?.let { fp ->
                append("\n证书 SHA-256 指纹：\n")
                append(CertificateFingerprint.shortSummary(fp))
                append("\n\n请确认与电脑端「设置 → 手机访问」展示的指纹一致。")
            }
        }

        AlertDialog.Builder(this)
            .setTitle("确认配对电脑")
            .setMessage(lines.trim())
            .setNegativeButton("重新扫描") { _, _ -> analysisPaused.set(false) }
            .setPositiveButton("确认配对") { _, _ -> executePairing(payload) }
            .setOnCancelListener { analysisPaused.set(false) }
            .show()
    }

    private fun executePairing(payload: PairingPayload) {
        if (isPairingInFlight) return
        isPairingInFlight = true
        val progressDialog = AlertDialog.Builder(this)
            .setTitle("正在建立加密连接")
            .setMessage("正在校验证书指纹并交换设备令牌…")
            .setCancelable(false)
            .create()
        progressDialog.show()

        uiScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { VecwayApp.from(this@QRScannerActivity).endpointManager.pair(payload) }
            }
            isPairingInFlight = false
            if (!isFinishing && !isDestroyed) {
                runCatching { progressDialog.dismiss() }
            }
            result.onSuccess {
                setResult(RESULT_OK)
                finish()
            }.onFailure { err ->
                if (!isFinishing && !isDestroyed) {
                    AlertDialog.Builder(this@QRScannerActivity)
                        .setTitle("配对失败")
                        .setMessage(err.message ?: "无法连接到电脑端完成配对")
                        .setNegativeButton("取消") { _, _ ->
                            setResult(
                                RESULT_CANCELED,
                                Intent().putExtra(EXTRA_ERROR, err.message ?: "配对失败"),
                            )
                            finish()
                        }
                        .setPositiveButton("重新扫描") { _, _ -> analysisPaused.set(false) }
                        .setOnCancelListener { analysisPaused.set(false) }
                        .show()
                }
            }
        }
    }

    private fun makePillButton(label: String, onClick: () -> Unit): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(Color.WHITE)
            setPadding(dp(14), dp(8), dp(14), dp(8))
            minHeight = 0
            minimumHeight = 0
            minWidth = 0
            minimumWidth = 0
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(999).toFloat()
                setColor(Color.parseColor("#99181A20"))
                setStroke(dp(1), Color.parseColor("#44FFFFFF"))
            }
            setOnClickListener { onClick() }
        }
    }

    private fun dp(value: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP,
        value.toFloat(),
        resources.displayMetrics,
    ).toInt()

    private class ViewfinderOverlay(context: android.content.Context) : View(context) {
        private val scrimPaint = Paint().apply {
            color = Color.parseColor("#88000000")
            style = Paint.Style.FILL
        }
        private val framePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#66FFFFFF")
            style = Paint.Style.STROKE
            strokeWidth = 2f * resources.displayMetrics.density
        }
        private val cornerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#60A5FA")
            style = Paint.Style.STROKE
            strokeWidth = 4f * resources.displayMetrics.density
            strokeCap = Paint.Cap.ROUND
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val w = width.toFloat()
            val h = height.toFloat()
            val size = minOf(w, h) * 0.66f
            val left = (w - size) / 2f
            val top = (h - size) / 2f
            val right = left + size
            val bottom = top + size
            val radius = 16f * resources.displayMetrics.density

            // Dim outside viewfinder rect.
            canvas.drawRect(0f, 0f, w, top, scrimPaint)
            canvas.drawRect(0f, bottom, w, h, scrimPaint)
            canvas.drawRect(0f, top, left, bottom, scrimPaint)
            canvas.drawRect(right, top, w, bottom, scrimPaint)

            val box = RectF(left, top, right, bottom)
            canvas.drawRoundRect(box, radius, radius, framePaint)

            val corner = 24f * resources.displayMetrics.density
            // Top-left
            canvas.drawLine(left, top + corner, left, top + radius / 2f, cornerPaint)
            canvas.drawLine(left + radius / 2f, top, left + corner, top, cornerPaint)
            // Top-right
            canvas.drawLine(right - corner, top, right - radius / 2f, top, cornerPaint)
            canvas.drawLine(right, top + radius / 2f, right, top + corner, cornerPaint)
            // Bottom-left
            canvas.drawLine(left, bottom - corner, left, bottom - radius / 2f, cornerPaint)
            canvas.drawLine(left + radius / 2f, bottom, left + corner, bottom, cornerPaint)
            // Bottom-right
            canvas.drawLine(right - corner, bottom, right - radius / 2f, bottom, cornerPaint)
            canvas.drawLine(right, bottom - radius / 2f, right, bottom - corner, cornerPaint)
        }
    }

    companion object {
        const val EXTRA_ERROR = "vecway.scanner.error"
    }
}

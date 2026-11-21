package dev.vecway.mobile.web

import android.app.Activity
import android.net.Uri
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.EditText
import androidx.appcompat.app.AlertDialog

/**
 * Handles Android WebView chrome interactions:
 * - File/image/camera chooser (`onShowFileChooser`) supporting both camera capture & multi-select gallery.
 * - Origin-gated audio/video permission requests (`https://appassets.androidplatform.net` ONLY).
 * - Native alert / confirm / prompt dialogs.
 */
class AppChromeClient(
    private val activity: Activity,
    private val onLaunchFileChooser: (
        callback: ValueCallback<Array<Uri>>,
        params: FileChooserParams,
    ) -> Boolean,
    private val onPermissionRequestForAppOrigin: (
        request: PermissionRequest,
        requestedResources: List<String>,
    ) -> Unit,
) : WebChromeClient() {

    override fun onShowFileChooser(
        webView: WebView?,
        filePathCallback: ValueCallback<Array<Uri>>?,
        fileChooserParams: FileChooserParams?,
    ): Boolean {
        if (filePathCallback == null || fileChooserParams == null) return false
        return onLaunchFileChooser(filePathCallback, fileChooserParams)
    }

    override fun onPermissionRequest(request: PermissionRequest?) {
        if (request == null) return
        val origin = request.origin?.toString()?.trimEnd('/')
        // SECURITY: Strictly gate WebView media permissions to the bundled app origin only.
        if (origin != AppWebViewClient.APP_ORIGIN) {
            request.deny()
            return
        }
        val allowed = request.resources.filter { res ->
            res == PermissionRequest.RESOURCE_AUDIO_CAPTURE ||
                res == PermissionRequest.RESOURCE_VIDEO_CAPTURE
        }
        if (allowed.isEmpty()) {
            request.deny()
            return
        }
        onPermissionRequestForAppOrigin(request, allowed)
    }

    override fun onJsAlert(
        view: WebView?,
        url: String?,
        message: String?,
        result: JsResult?,
    ): Boolean {
        if (activity.isFinishing || activity.isDestroyed || result == null) {
            result?.cancel()
            return true
        }
        AlertDialog.Builder(activity)
            .setMessage(message.orEmpty())
            .setPositiveButton("好") { _, _ -> result.confirm() }
            .setOnCancelListener { result.cancel() }
            .show()
        return true
    }

    override fun onJsConfirm(
        view: WebView?,
        url: String?,
        message: String?,
        result: JsResult?,
    ): Boolean {
        if (activity.isFinishing || activity.isDestroyed || result == null) {
            result?.cancel()
            return true
        }
        AlertDialog.Builder(activity)
            .setMessage(message.orEmpty())
            .setNegativeButton("取消") { _, _ -> result.cancel() }
            .setPositiveButton("确定") { _, _ -> result.confirm() }
            .setOnCancelListener { result.cancel() }
            .show()
        return true
    }

    override fun onJsPrompt(
        view: WebView?,
        url: String?,
        message: String?,
        defaultValue: String?,
        result: JsPromptResult?,
    ): Boolean {
        if (activity.isFinishing || activity.isDestroyed || result == null) {
            result?.cancel()
            return true
        }
        val input = EditText(activity).apply {
            setText(defaultValue.orEmpty())
            setSelection(text.length)
        }
        AlertDialog.Builder(activity)
            .setMessage(message.orEmpty())
            .setView(input)
            .setNegativeButton("取消") { _, _ -> result.cancel() }
            .setPositiveButton("确定") { _, _ -> result.confirm(input.text?.toString().orEmpty()) }
            .setOnCancelListener { result.cancel() }
            .show()
        return true
    }
}

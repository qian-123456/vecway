package dev.vecway.mobile.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import androidx.core.content.ContextCompat
import dev.vecway.mobile.network.EndpointManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID

sealed class VoiceRecorderException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    class PermissionDenied :
        VoiceRecorderException("未获得麦克风权限，请在系统设置中允许 Vecway 访问麦克风")

    class AlreadyRecording :
        VoiceRecorderException("正在录音中")

    class NotRecording :
        VoiceRecorderException("当前未在录音")

    class RecordingFailed(reason: String, cause: Throwable? = null) :
        VoiceRecorderException("录音启动失败：$reason", cause)

    class EmptyAudio :
        VoiceRecorderException("未采集到有效语音内容")

    class AudioTooLarge :
        VoiceRecorderException("录音文件过大（超过 25 MB 限制）")

    class TranscriptionFailed(reason: String) :
        VoiceRecorderException(reason)
}

/**
 * Native Android voice recorder capturing AAC (`.m4a`, 16 kHz mono) via `MediaRecorder`
 * and uploading raw audio bytes directly to `/api/voice/transcribe` over `EndpointManager` + `PinnedTransport`.
 */
class NativeVoiceRecorder(
    private val context: Context,
    private val endpointManager: EndpointManager,
    private val requestMicPermission: suspend () -> Boolean,
) {
    private val lock = Any()
    private var recorder: MediaRecorder? = null
    private var activeFile: File? = null

    suspend fun startRecording() {
        val already = synchronized(lock) { recorder != null }
        if (already) throw VoiceRecorderException.AlreadyRecording()

        val hasPermission = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasPermission && !requestMicPermission()) {
            throw VoiceRecorderException.PermissionDenied()
        }

        val tempFile = File(context.cacheDir, "vecway-voice-${UUID.randomUUID()}.m4a")
        withContext(Dispatchers.Main) {
            val newRecorder = createMediaRecorder()
            try {
                newRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
                newRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                newRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                newRecorder.setAudioSamplingRate(16_000)
                newRecorder.setAudioChannels(1)
                newRecorder.setAudioEncodingBitRate(64_000)
                newRecorder.setOutputFile(tempFile.absolutePath)
                newRecorder.prepare()
                newRecorder.start()
                synchronized(lock) {
                    recorder = newRecorder
                    activeFile = tempFile
                }
            } catch (t: Throwable) {
                runCatching { newRecorder.reset() }
                runCatching { newRecorder.release() }
                runCatching { tempFile.delete() }
                throw VoiceRecorderException.RecordingFailed(t.message ?: "无法启动音频采集器", t)
            }
        }
    }

    suspend fun stopAndTranscribe(): String {
        val pair = synchronized(lock) {
            val r = recorder
            val f = activeFile
            recorder = null
            activeFile = null
            if (r != null && f != null) Pair(r, f) else null
        } ?: throw VoiceRecorderException.NotRecording()

        val (activeRecorder, audioFile) = pair
        try {
            withContext(Dispatchers.Main) {
                try {
                    activeRecorder.stop()
                } catch (_: RuntimeException) {
                    // Stop throws RuntimeException if recording was too short (< ~100ms).
                } finally {
                    runCatching { activeRecorder.reset() }
                    runCatching { activeRecorder.release() }
                }
            }

            val bytes = withContext(Dispatchers.IO) {
                if (!audioFile.isFile) ByteArray(0) else audioFile.readBytes()
            }
            if (bytes.isEmpty()) throw VoiceRecorderException.EmptyAudio()
            if (bytes.size > MAX_AUDIO_BYTES) throw VoiceRecorderException.AudioTooLarge()

            val response = endpointManager.performRequest(
                method = "POST",
                path = "/api/voice/transcribe",
                headers = mapOf(
                    "Content-Type" to "audio/mp4",
                    "Accept" to "application/json",
                ),
                body = bytes,
                timeoutMs = TRANSCRIBE_TIMEOUT_MS,
            )

            if (response.status !in 200..299) {
                val msg = extractErrorMessage(response.body)
                    ?: "语音转文字失败（HTTP ${response.status}）"
                throw VoiceRecorderException.TranscriptionFailed(msg)
            }

            val text = try {
                val obj = JSONObject(String(response.body, Charsets.UTF_8))
                if (!obj.has("text")) throw VoiceRecorderException.TranscriptionFailed("无法解析语音识别结果")
                obj.optString("text", "")
            } catch (e: VoiceRecorderException) {
                throw e
            } catch (_: Exception) {
                throw VoiceRecorderException.TranscriptionFailed("无法解析语音识别结果")
            }
            return text
        } finally {
            runCatching { audioFile.delete() }
        }
    }

    fun cancelRecording() {
        val pair = synchronized(lock) {
            val r = recorder
            val f = activeFile
            recorder = null
            activeFile = null
            Pair(r, f)
        }
        pair.first?.let { r ->
            runCatching { r.stop() }
            runCatching { r.reset() }
            runCatching { r.release() }
        }
        pair.second?.let { f ->
            runCatching { f.delete() }
        }
    }

    @Suppress("DEPRECATION")
    private fun createMediaRecorder(): MediaRecorder {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            MediaRecorder()
        }
    }

    companion object {
        private const val MAX_AUDIO_BYTES = 25 * 1024 * 1024
        private const val TRANSCRIBE_TIMEOUT_MS = 65_000L

        private fun extractErrorMessage(body: ByteArray): String? {
            if (body.isEmpty()) return null
            val text = String(body, Charsets.UTF_8).trim()
            if (text.isEmpty()) return null
            return try {
                val obj = JSONObject(text)
                obj.optString("error", "").ifBlank { obj.optString("message", "").ifBlank { null } }
            } catch (_: Exception) {
                text.take(240)
            }
        }
    }
}

package dev.vecway.mobile.push

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/** Native push notification status matching `src-mobile/core/nativeBridge.ts` `NativePushStatus`. */
data class NativePushStatus(
    val supported: Boolean,
    val permission: String,
    val registered: Boolean,
    val reason: String? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("supported", supported)
        put("permission", permission)
        put("registered", registered)
        if (reason != null) put("reason", reason)
    }
}

/**
 * Extension slot for M5 Android native push notifications.
 * Truthfully reports `supported: false` until desktop `/api/push/register-native` lands.
 */
class NativePushManager(private val context: Context) {
    fun getStatus(): NativePushStatus {
        val enabled = runCatching {
            NotificationManagerCompat.from(context).areNotificationsEnabled()
        }.getOrDefault(false)
        val permission = if (enabled) "granted" else "denied"
        return NativePushStatus(
            supported = false,
            permission = permission,
            registered = false,
            reason = PENDING_SERVER_REASON,
        )
    }

    fun enable() {
        val enabled = runCatching {
            NotificationManagerCompat.from(context).areNotificationsEnabled()
        }.getOrDefault(false)
        if (!enabled) {
            throw IllegalStateException("未获得系统通知权限，请在系统设置中开启 Vecway 通知")
        }
    }

    fun disable() = Unit

    companion object {
        const val PENDING_SERVER_REASON = "桌面端原生推送服务将在下一阶段启用，当前已保留 Android 通知接入能力"
    }
}

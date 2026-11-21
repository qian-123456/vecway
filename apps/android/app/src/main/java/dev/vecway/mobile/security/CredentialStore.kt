package dev.vecway.mobile.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Sensitive credentials persisted strictly in Android Keystore-encrypted storage, NEVER in WebView storage. */
data class StoredCredentials(
    val deviceToken: String,
    val pinnedCertSha256: String?,
    val endpoints: EndpointCandidates,
    val deviceId: String? = null,
    val deviceName: String? = null,
    val preferredChannel: NativeChannel? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("deviceToken", deviceToken)
        if (pinnedCertSha256 != null) put("pinnedCertSha256", pinnedCertSha256)
        put("endpoints", endpoints.toJson())
        if (deviceId != null) put("deviceId", deviceId)
        if (deviceName != null) put("deviceName", deviceName)
        if (preferredChannel != null) put("preferredChannel", preferredChannel.wireValue)
    }

    companion object {
        fun fromJson(obj: JSONObject): StoredCredentials? {
            val token = obj.optString("deviceToken", "")
            if (token.isBlank()) return null
            val rawPinned = if (obj.has("pinnedCertSha256") && !obj.isNull("pinnedCertSha256")) {
                obj.optString("pinnedCertSha256", "").ifBlank { null }
            } else {
                null
            }
            val rawDeviceId = if (obj.has("deviceId") && !obj.isNull("deviceId")) {
                obj.optString("deviceId", "").ifBlank { null }
            } else {
                null
            }
            val rawDeviceName = if (obj.has("deviceName") && !obj.isNull("deviceName")) {
                obj.optString("deviceName", "").ifBlank { null }
            } else {
                null
            }
            val rawPreferred = if (obj.has("preferredChannel") && !obj.isNull("preferredChannel")) {
                obj.optString("preferredChannel", "").ifBlank { null }
            } else {
                null
            }
            return StoredCredentials(
                deviceToken = token,
                pinnedCertSha256 = rawPinned,
                endpoints = EndpointCandidates.fromJson(obj.optJSONObject("endpoints")),
                deviceId = rawDeviceId,
                deviceName = rawDeviceName,
                preferredChannel = NativeChannel.fromWire(rawPreferred),
            )
        }
    }
}

interface CredentialStore {
    fun load(): StoredCredentials?
    fun save(credentials: StoredCredentials)
    fun clear()
}

/** Pure in-memory store for JVM unit tests. */
class InMemoryCredentialStore(initial: StoredCredentials? = null) : CredentialStore {
    @Volatile
    private var current: StoredCredentials? = initial

    override fun load(): StoredCredentials? = current
    override fun save(credentials: StoredCredentials) {
        current = credentials
    }

    override fun clear() {
        current = null
    }
}

/**
 * Hardware-backed Android Keystore (AES-256-GCM) credential store backed by private SharedPreferences.
 * Backup & device transfer are blocked via `AndroidManifest.xml` (`allowBackup=false` + `dataExtractionRules`).
 */
class KeystoreCredentialStore(context: Context) : CredentialStore {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val lock = Any()

    override fun load(): StoredCredentials? = synchronized(lock) {
        val ivB64 = prefs.getString(KEY_IV, null) ?: return null
        val ctB64 = prefs.getString(KEY_CIPHERTEXT, null) ?: return null
        return try {
            val iv = Base64.getDecoder().decode(ivB64)
            val ct = Base64.getDecoder().decode(ctB64)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateMasterKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            val plaintext = String(cipher.doFinal(ct), StandardCharsets.UTF_8)
            StoredCredentials.fromJson(JSONObject(plaintext))
        } catch (_: Exception) {
            null
        }
    }

    override fun save(credentials: StoredCredentials) = synchronized(lock) {
        val plaintext = credentials.toJson().toString().toByteArray(StandardCharsets.UTF_8)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateMasterKey())
        val ct = cipher.doFinal(plaintext)
        val iv = cipher.iv
        prefs.edit()
            .putString(KEY_IV, Base64.getEncoder().encodeToString(iv))
            .putString(KEY_CIPHERTEXT, Base64.getEncoder().encodeToString(ct))
            .commit()
        Unit
    }

    override fun clear() = synchronized(lock) {
        prefs.edit().remove(KEY_IV).remove(KEY_CIPHERTEXT).commit()
        Unit
    }

    private fun getOrCreateMasterKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = ks.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "dev.vecway.mobile.credentials.aes256gcm"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
        private const val PREFS_NAME = "vecway_secure_credentials"
        private const val KEY_IV = "cred_iv"
        private const val KEY_CIPHERTEXT = "cred_ct"
    }
}

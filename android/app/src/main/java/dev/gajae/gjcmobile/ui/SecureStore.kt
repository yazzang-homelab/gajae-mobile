package dev.gajae.gjcmobile.ui

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dev.gajae.gjcmobile.core.B64Url
import dev.gajae.gjcmobile.core.DeviceIdentity
import dev.gajae.gjcmobile.core.PairedHost
import dev.gajae.gjcmobile.core.parseJson
import dev.gajae.gjcmobile.core.encode
import dev.gajae.gjcmobile.core.array
import kotlinx.serialization.json.JsonArray

/**
 * Device identity key and paired hosts, encrypted with an Android Keystore-backed master key
 * (the Android counterpart of the iOS Keychain store). Excluded from backup (allowBackup=false).
 */
class SecureStore(context: Context) {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "gjcm_secure",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun deviceIdentity(): DeviceIdentity {
        prefs.getString(KEY_DEVICE, null)?.let(B64Url::decode)?.takeIf { it.size == 32 }?.let { return DeviceIdentity(it) }
        val created = DeviceIdentity()
        prefs.edit().putString(KEY_DEVICE, B64Url.encode(created.privateKey)).apply()
        return created
    }

    fun hosts(): List<PairedHost> = prefs.getString(KEY_HOSTS, null)
        ?.let { runCatching { parseJson(it).array.orEmpty().mapNotNull(PairedHost::fromJson) }.getOrNull() }
        .orEmpty()

    fun saveHosts(hosts: List<PairedHost>) {
        prefs.edit().putString(KEY_HOSTS, JsonArray(hosts.map { it.toJson() }).encode()).apply()
    }

    private companion object {
        const val KEY_DEVICE = "deviceKey"
        const val KEY_HOSTS = "hosts"
    }
}

package io.github.nevaeh5379.androidhaejeokrisuai.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class StorageConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences("native_risu_storage", Context.MODE_PRIVATE)

    fun load(): StorageConfig? {
        val mode = prefs.getString("mode", null) ?: return null
        val authToken = decryptToken()
            ?: prefs.getString(LEGACY_PLAIN_AUTH_TOKEN, "").orEmpty().also { legacy ->
                if (legacy.isNotEmpty()) {
                    saveEncryptedToken(legacy)
                    prefs.edit { remove(LEGACY_PLAIN_AUTH_TOKEN) }
                }
            }
        return StorageConfig(
            mode = runCatching { StorageMode.valueOf(mode) }.getOrDefault(StorageMode.LOCAL_SQLITE),
            baseUrl = prefs.getString("baseUrl", "").orEmpty(),
            authToken = authToken,
        )
    }

    fun save(config: StorageConfig) {
        prefs.edit {
            putString("mode", config.mode.name)
            putString("baseUrl", config.baseUrl)
            remove(LEGACY_PLAIN_AUTH_TOKEN)
        }
        saveEncryptedToken(config.authToken)
    }

    fun clear() = prefs.edit { clear() }

    private fun saveEncryptedToken(token: String) {
        if (token.isEmpty()) {
            prefs.edit {
                remove(ENCRYPTED_AUTH_TOKEN)
                remove(AUTH_TOKEN_IV)
            }
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit {
            putString(ENCRYPTED_AUTH_TOKEN, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            putString(AUTH_TOKEN_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        }
    }

    private fun decryptToken(): String? {
        val encryptedText = prefs.getString(ENCRYPTED_AUTH_TOKEN, null) ?: return null
        val ivText = prefs.getString(AUTH_TOKEN_IV, null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(128, Base64.decode(ivText, Base64.NO_WRAP)),
            )
            val plaintext = cipher.doFinal(Base64.decode(encryptedText, Base64.NO_WRAP))
            plaintext.toString(Charsets.UTF_8)
        }.getOrNull()
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEY_ALIAS = "haejeok_risu_remote_auth"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val ENCRYPTED_AUTH_TOKEN = "authTokenEncrypted"
        const val AUTH_TOKEN_IV = "authTokenIv"
        const val LEGACY_PLAIN_AUTH_TOKEN = "authToken"
    }
}

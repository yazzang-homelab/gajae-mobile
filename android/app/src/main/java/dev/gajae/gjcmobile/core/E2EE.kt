package dev.gajae.gjcmobile.core

import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.subtle.X25519
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * gjcm-e2ee-v1, byte-for-byte with bridge/src/crypto.ts (verified by fixtures/e2ee-vector.json).
 *   ikm  = DH(Ec, Es) ‖ DH(Ec, H) ‖ DH(D, H)
 *   keys = HKDF-SHA256(ikm, salt = Nc ‖ Ns, info = LABEL ‖ D_pub ‖ H_pub ‖ Ec_pub ‖ Es_pub, 64)
 *   frame = 8-byte BE counter ‖ ciphertext ‖ 16-byte tag; nonce = 4 zero bytes ‖ counter; AAD "gjcm1"
 */
object E2EE {
    const val PROTOCOL_LABEL = "gjcm-e2ee-v1"
    private val PAIR_LABEL = "gjcm-pair-v1".toByteArray()

    data class Transcript(
        val deviceKey: ByteArray,
        val hostKey: ByteArray,
        val clientEph: ByteArray,
        val serverEph: ByteArray,
        val clientNonce: ByteArray,
        val serverNonce: ByteArray,
    )

    class SessionKeys(val c2s: ByteArray, val s2c: ByteArray)

    fun clientKeys(devicePrivate: ByteArray, clientEphPrivate: ByteArray, t: Transcript): SessionKeys {
        val ikm = X25519.computeSharedSecret(clientEphPrivate, t.serverEph) +
            X25519.computeSharedSecret(clientEphPrivate, t.hostKey) +
            X25519.computeSharedSecret(devicePrivate, t.hostKey)
        val info = PROTOCOL_LABEL.toByteArray() + t.deviceKey + t.hostKey + t.clientEph + t.serverEph
        val okm = Hkdf.computeHkdf("HMACSHA256", ikm, t.clientNonce + t.serverNonce, info, 64)
        return SessionKeys(okm.copyOfRange(0, 32), okm.copyOfRange(32, 64))
    }

    fun pairingProof(secret: ByteArray, deviceKey: ByteArray, clientEph: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret, "HmacSHA256"))
        mac.update(PAIR_LABEL)
        mac.update(deviceKey)
        mac.update(clientEph)
        return mac.doFinal()
    }

    fun publicKey(privateKey: ByteArray): ByteArray = X25519.publicFromPrivate(privateKey)

    fun generatePrivateKey(): ByteArray = X25519.generatePrivateKey()

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }
}

class E2EEException(message: String) : Exception(message)

/** Per-direction AES-256-GCM framing; counters start at 0 and must strictly increase. */
class FrameCipher(private val sendKey: ByteArray, private val recvKey: ByteArray) {
    private var sendCounter = 0L
    private var recvNext = 0L

    @Synchronized
    fun seal(plaintext: ByteArray): ByteArray {
        val header = ByteBuffer.allocate(COUNTER_BYTES).putLong(sendCounter).array()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sendKey, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce(header)))
        cipher.updateAAD(AAD)
        val sealed = header + cipher.doFinal(plaintext)
        sendCounter++
        return sealed
    }

    /** Rejects replays, reordering and tampering without advancing state. */
    @Synchronized
    fun open(frame: ByteArray): ByteArray {
        if (frame.size < COUNTER_BYTES + TAG_BYTES) throw E2EEException("frame too short")
        val header = frame.copyOfRange(0, COUNTER_BYTES)
        val counter = ByteBuffer.wrap(header).long
        if (counter < recvNext || counter < 0) throw E2EEException("replayed or reordered frame")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(recvKey, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce(header)))
        cipher.updateAAD(AAD)
        val plain = try {
            cipher.doFinal(frame, COUNTER_BYTES, frame.size - COUNTER_BYTES)
        } catch (e: AEADBadTagException) {
            throw E2EEException("authentication failed")
        }
        recvNext = counter + 1
        return plain
    }

    private fun nonce(header: ByteArray) = ByteArray(4) + header

    private companion object {
        const val TAG_BYTES = 16
        const val COUNTER_BYTES = 8
        val AAD = "gjcm1".toByteArray()
    }
}

object B64Url {
    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** Accepts padded or unpadded input, like Node's `base64url`. Returns null on malformed text. */
    fun decode(text: String): ByteArray? = try {
        Base64.getUrlDecoder().decode(text.trimEnd('='))
    } catch (e: IllegalArgumentException) {
        null
    }
}

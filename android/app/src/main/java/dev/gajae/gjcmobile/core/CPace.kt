package dev.gajae.gjcmobile.core

import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.subtle.X25519
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * CPACE-X25519-SHA512, pinned to draft-irtf-cfrg-cpace-21 (gjcm-code-v1, issue #128), byte-for-byte with
 * bridge/src/cpace.ts (verified by fixtures/cpace-vector.json).
 *
 * The phone is initiator A and the bridge is responder B; the typed device code is the password (PRS).
 *   A → B  sid, Ya          B → A  Yb
 *   A → B  Ta               B → A  Tb and box = AES-256-GCM(kSeal, offer)   (only after Ta checks)
 * X25519 is Tink's (it clamps the raw 32-byte scalar itself). The generator comes from Elligator2 over
 * GF(2^255-19), computed with BigInteger from public values and the code only.
 */
object CPace {
    val DSI = "CPace255".toByteArray(Charsets.US_ASCII)
    const val S_IN_BYTES = 128

    /** Channel identifier: roles are fixed (app = A, bridge = B), and the code already names the address. */
    val CODE_CI = "gjcm-code-v1".toByteArray(Charsets.US_ASCII)
    private val SEAL_INFO = "gjcm-code-v1 seal".toByteArray(Charsets.US_ASCII)
    private val SEAL_AAD = "gjcm-code-v1".toByteArray(Charsets.US_ASCII)
    private const val TAG_BYTES = 16
    private const val NONCE_BYTES = 12

    private val P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))
    private val A = BigInteger.valueOf(486662)
    /** Z = 2: the non-square RFC 9380 picks for curve25519. */
    private val Z = BigInteger.valueOf(2)
    private val TWO = BigInteger.valueOf(2)
    private val LEGENDRE_EXP = P.subtract(BigInteger.ONE).shiftRight(1)
    private val MASK_255 = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.ONE)

    private fun inv(x: BigInteger): BigInteger = x.modPow(P.subtract(TWO), P)

    /** LEB128 length prefix (draft A.1.1). */
    fun prependLen(data: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        var length = data.size
        do {
            var b = length and 0x7f
            length = length ushr 7
            if (length > 0) b = b or 0x80
            out.write(b)
        } while (length > 0)
        out.write(data)
        return out.toByteArray()
    }

    fun lvCat(vararg parts: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        for (part in parts) out.write(prependLen(part))
        return out.toByteArray()
    }

    fun generatorString(dsi: ByteArray, prs: ByteArray, ci: ByteArray, sid: ByteArray, sInBytes: Int = S_IN_BYTES): ByteArray {
        val zpad = maxOf(0, sInBytes - 1 - prependLen(prs).size - prependLen(dsi).size)
        return lvCat(dsi, prs, ByteArray(zpad), ci, sid)
    }

    fun decodeLittleEndian(bytes: ByteArray): BigInteger = BigInteger(1, bytes.reversedArray())

    /** 32-byte little-endian encoding of a value below 2^256. */
    fun encodeLittleEndian(x: BigInteger): ByteArray {
        val big = x.toByteArray() // big-endian two's complement, possibly with a leading zero
        val out = ByteArray(32)
        for (i in 0 until 32) {
            val idx = big.size - 1 - i
            if (idx >= 0) out[i] = big[idx]
        }
        return out
    }

    /** RFC 7748 decodeUCoordinate for X25519: bit 255 is ignored; the value is taken mod p by the field arithmetic. */
    fun decodeUCoordinate(bytes: ByteArray): BigInteger = decodeLittleEndian(bytes).and(MASK_255)

    /**
     * Elligator2 onto curve25519 (draft A.5): v = -A / (1 + Z r²), ε = legendre(v³ + A v² + v), x = ε v − (1 − ε) A/2.
     * 1 + 2r² is never zero and v³ + A v² + v is never zero, so ε is ±1 (the select below is arithmetic, not a branch).
     */
    fun elligator2(r: BigInteger): BigInteger {
        val u = r.mod(P)
        val v = A.negate().multiply(inv(BigInteger.ONE.add(Z.multiply(u).multiply(u)))).mod(P)
        val gv = v.multiply(v).multiply(v).add(A.multiply(v).multiply(v)).add(v).mod(P)
        val eps = gv.modPow(LEGENDRE_EXP, P) // 1 or p - 1
        val half = A.multiply(inv(TWO))
        return eps.multiply(v).subtract(BigInteger.ONE.subtract(eps).mod(P).multiply(half)).mod(P)
    }

    /** The u-coordinate [u] (32 bytes little-endian, bit 255 ignored) mapped onto the curve, 32 bytes little-endian. */
    fun elligator2(u: ByteArray): ByteArray = encodeLittleEndian(elligator2(decodeUCoordinate(u)))

    /** G.calculate_generator(H, PRS, sid, CI): the X25519 u-coordinate both sides start from. */
    fun calculateGenerator(prs: ByteArray, ci: ByteArray, sid: ByteArray): ByteArray {
        val hash = sha512(generatorString(DSI, prs, ci, sid)).copyOfRange(0, 32)
        return elligator2(hash)
    }

    /**
     * scalar_mult_vfy: X25519(scalar, u), or null when the key agreement fails or yields the neutral element
     * (an all-zero result: a low-order input). Callers abort on null. The point is canonicalised first (bit 255
     * dropped, reduced mod p) so the result does not depend on how the library treats non-canonical input.
     */
    fun x25519(scalar: ByteArray, u: ByteArray): ByteArray? {
        if (scalar.size != 32 || u.size != 32) return null
        val point = encodeLittleEndian(decodeUCoordinate(u).mod(P))
        val out = try {
            X25519.computeSharedSecret(scalar, point)
        } catch (e: Exception) {
            return null
        }
        if (out.size != 32 || out.all { it.toInt() == 0 }) return null
        return out
    }

    /** ISK for the initiator/responder setting: H(lv_cat(DSI‖"_ISK", sid, K) ‖ transcript_ir(Ya, ADa, Yb, ADb)). */
    fun deriveIsk(sid: ByteArray, k: ByteArray, ya: ByteArray, ada: ByteArray, yb: ByteArray, adb: ByteArray): ByteArray {
        val dsiIsk = DSI + "_ISK".toByteArray(Charsets.US_ASCII)
        return sha512(lvCat(dsiIsk, sid, k) + lvCat(ya, ada) + lvCat(yb, adb))
    }

    /** §10.4 key confirmation: mac_key = H("CPaceMac" ‖ sid ‖ ISK); tag = HMAC(mac_key, lv_cat(Y, AD)). */
    fun confirmationTag(sid: ByteArray, isk: ByteArray, y: ByteArray, ad: ByteArray): ByteArray {
        val macKey = sha512("CPaceMac".toByteArray(Charsets.US_ASCII) + sid + isk)
        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(macKey, "HmacSHA512"))
        return mac.doFinal(lvCat(y, ad))
    }

    fun sealKey(isk: ByteArray): ByteArray = Hkdf.computeHkdf("HMACSHA256", isk, ByteArray(0), SEAL_INFO, 32)

    /** Seals once per ISK, so the zero nonce never repeats under one key. */
    internal fun sealBox(isk: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sealKey(isk), "AES"), GCMParameterSpec(TAG_BYTES * 8, ByteArray(NONCE_BYTES)))
        cipher.updateAAD(SEAL_AAD)
        return cipher.doFinal(plaintext) // ciphertext ‖ 16-byte tag
    }

    /** The offer inside a `pake.ok` box, or null when it does not authenticate. */
    fun openBox(isk: ByteArray, box: ByteArray): ByteArray? {
        if (box.size < TAG_BYTES) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(sealKey(isk), "AES"), GCMParameterSpec(TAG_BYTES * 8, ByteArray(NONCE_BYTES)))
            cipher.updateAAD(SEAL_AAD)
            cipher.doFinal(box)
        } catch (e: Exception) {
            null
        }
    }

    private fun sha512(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-512").digest(data)

    /** Constant-time for equal lengths. */
    internal fun tagsEqual(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    internal fun randomBytes(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }
}

/** Party A (the phone). [ya] goes out first; [finish] takes Yb and returns Ta plus the checks for B's answer. */
class CPaceInitiator(
    prs: ByteArray,
    val sid: ByteArray = CPace.randomBytes(16),
    private val scalar: ByteArray = CPace.randomBytes(32),
    ci: ByteArray = CPace.CODE_CI,
    private val ad: ByteArray = ByteArray(0),
) {
    val ya: ByteArray = CPace.x25519(scalar, CPace.calculateGenerator(prs, ci, sid))
        ?: throw IllegalStateException("cpace: generator rejected")

    /** Null when Yb is invalid (abort). */
    fun finish(yb: ByteArray, peerAd: ByteArray = ByteArray(0)): CPaceInitiatorSession? {
        if (yb.size != 32) return null
        val k = CPace.x25519(scalar, yb) ?: return null
        val isk = CPace.deriveIsk(sid, k, ya, ad, yb, peerAd)
        return CPaceInitiatorSession(isk, CPace.confirmationTag(sid, isk, ya, ad), sid, yb, peerAd)
    }
}

class CPaceInitiatorSession internal constructor(
    val isk: ByteArray,
    val ta: ByteArray,
    private val sid: ByteArray,
    private val yb: ByteArray,
    private val peerAd: ByteArray,
) {
    /** Constant-time check of the bridge's confirmation tag. */
    fun verifyTb(tb: ByteArray): Boolean = CPace.tagsEqual(tb, CPace.confirmationTag(sid, isk, yb, peerAd))

    /** The offer, or null when the box does not authenticate under this session. */
    fun open(box: ByteArray): ByteArray? = CPace.openBox(isk, box)
}

package dev.gajae.gjcmobile.core

import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Party B (the bridge) for tests and the in-memory servers, shaped like the bridge's `CPaceResponder`: Tb and the seal
 * exist only after [confirm] has checked Ta. [start] is null when Ya is invalid (abort).
 */
class CPaceResponder private constructor(
    private val sid: ByteArray,
    private val ya: ByteArray,
    val yb: ByteArray,
    private val peerAd: ByteArray,
    private val ad: ByteArray,
    val isk: ByteArray,
) {
    /** What the bridge may send once Ta checks out: Tb and a single-use seal (one kSeal seals exactly one message). */
    class Confirmed internal constructor(val tb: ByteArray, private val sealOnce: (ByteArray) -> ByteArray) {
        fun seal(plaintext: ByteArray): ByteArray = sealOnce(plaintext)
    }

    /** Null when [ta] does not match: the peer does not know the code. */
    fun confirm(ta: ByteArray): Confirmed? =
        if (MessageDigest.isEqual(ta, CPace.confirmationTag(sid, isk, ya, peerAd))) confirmed() else null

    /** A misbehaving bridge that answers although Ta did not check (tests of the phone's own checks only). */
    fun confirmWithoutChecking(): Confirmed = confirmed()

    private fun confirmed(): Confirmed {
        var sealed = false
        return Confirmed(CPace.confirmationTag(sid, isk, yb, ad)) { plaintext ->
            check(!sealed) { "cpace: kSeal seals exactly one message" }
            sealed = true
            CPace.sealBox(isk, plaintext)
        }
    }

    companion object {
        /** A fresh scalar per call (the seal's nonce invariant); [scalar] is for test vectors only. */
        fun start(
            prs: ByteArray,
            sid: ByteArray,
            ya: ByteArray,
            ci: ByteArray = CPace.CODE_CI,
            scalar: ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) },
            ad: ByteArray = ByteArray(0),
            peerAd: ByteArray = ByteArray(0),
        ): CPaceResponder? {
            if (ya.size != 32 || sid.isEmpty()) return null
            val yb = CPace.x25519(scalar, CPace.calculateGenerator(prs, ci, sid)) ?: return null
            val k = CPace.x25519(scalar, ya) ?: return null
            return CPaceResponder(sid, ya, yb, peerAd, ad, CPace.deriveIsk(sid, k, ya, peerAd, yb, ad))
        }
    }
}

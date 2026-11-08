package dev.gajae.gjcmobile.core

/**
 * When a host connection dials again. A failed dial waits [FIRST_MS], doubling up to [LONGEST_MS]. A connection that
 * drops within [STABLE_AFTER_MS] of attaching counts as a failed dial too: a drop the phone causes itself (a chat
 * snapshot over its frame limit, say) comes back the moment it dials again, and dialing at once repeated it 32 times
 * 0.55s apart (2026-11-08, pve1). A connection that held up dials again at once, with the wait back at [FIRST_MS].
 */
class ReconnectBackoff {
    private var nextMs = FIRST_MS
    private var attachedAtMs: Long? = null

    /** The wait before the next dial after one failed. */
    fun failedDial(): Long {
        val wait = nextMs
        nextMs = minOf(nextMs * 2, LONGEST_MS)
        return wait
    }

    fun attached(nowMs: Long) {
        attachedAtMs = nowMs
    }

    /** The wait before dialing again after an attached connection dropped. */
    fun dropped(nowMs: Long): Long {
        val since = attachedAtMs
        attachedAtMs = null
        if (since != null && nowMs - since >= STABLE_AFTER_MS) {
            nextMs = FIRST_MS
            return 0
        }
        return failedDial()
    }

    companion object {
        const val FIRST_MS = 1_000L
        const val LONGEST_MS = 30_000L
        const val STABLE_AFTER_MS = 10_000L
    }
}

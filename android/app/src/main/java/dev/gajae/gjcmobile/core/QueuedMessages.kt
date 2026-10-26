package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.JsonElement

/** A message waiting on a busy turn: a steer (next step) or a follow-up (after the turn). */
data class QueuedMessage(val text: String, val followUp: Boolean, val sentAtMs: Long = 0) {
    companion object {
        /** One `session.status.queued` entry from the bridge (gjc `queue.messages.list`, mode steer|followUp). */
        fun from(json: JsonElement): QueuedMessage? {
            val text = json["text"].str ?: return null
            val followUp = when (json["mode"].str) {
                "steer" -> false
                "followUp" -> true
                else -> return null
            }
            return QueuedMessage(text, followUp)
        }
    }
}

/**
 * What the chat shows as waiting. The bridge reports gjc's own queue once a second while the session works,
 * including steers typed in the TUI or on another phone. A steer this phone just sent can miss the last report,
 * so it shows on its own for [GRACE_MS]; after that only gjc's queue counts (gjc may have taken it already).
 * `host == null` is a bridge without queue reports: only this phone's steers are known.
 */
object QueuedMessages {
    const val GRACE_MS = 2_500L

    fun merge(sent: List<QueuedMessage>, host: List<QueuedMessage>?, nowMs: Long): List<QueuedMessage> {
        if (host == null) return sent
        val pending = sent.filter { s -> nowMs - s.sentAtMs < GRACE_MS && host.none { it.text == s.text && it.followUp == s.followUp } }
        return host + pending
    }
}

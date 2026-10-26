package dev.gajae.gjcmobile.core

/**
 * Decides which bridge events deserve a local notification: a newly arrived ask (`permission.request`) and a
 * session switching between working and idle (`session.status`). Repeats are dropped — the bridge re-delivers
 * pending asks after a reconnect and sends a status tick every second while a session works.
 */
class ActivityAlerts {
    sealed class Alert {
        abstract val sessionId: String

        data class Ask(override val sessionId: String, val requestId: String, val title: String) : Alert()
        data class Started(override val sessionId: String) : Alert()
        data class Finished(override val sessionId: String) : Alert()
    }

    /** Ask ids already announced, oldest first; bounded so a long-lived connection does not grow without limit. */
    private val announcedAsks = ArrayDeque<String>()
    private val running = mutableMapOf<String, Boolean>()

    fun permission(request: PermissionRequest): Alert? {
        if (request.requestId in announcedAsks) return null
        announcedAsks.addLast(request.requestId)
        while (announcedAsks.size > ASK_MEMORY) announcedAsks.removeFirst()
        return Alert.Ask(request.sessionId, request.requestId, request.title)
    }

    /**
     * A session's first observed state only becomes the baseline: right after connecting the phone cannot tell
     * whether a running session just started.
     */
    fun status(sessionId: String, running: Boolean): Alert? {
        val before = this.running.put(sessionId, running) ?: return null
        if (before == running) return null
        return if (running) Alert.Started(sessionId) else Alert.Finished(sessionId)
    }

    /** Session list rows carry the same running flag; a change seen there (e.g. a turn that ended while reconnecting) is real too. */
    fun sessions(list: List<SessionSummary>): List<Alert> =
        list.mapNotNull { summary -> summary.running?.let { status(summary.sessionId, it) } }

    private companion object {
        const val ASK_MEMORY = 256
    }
}

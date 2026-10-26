package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Test

class QueuedMessagesTest {
    private val tui = QueuedMessage("TUI에서 넣음", followUp = false)

    @Test
    fun statusCarriesTheHostQueueFromTheBridge() {
        val status = SessionStatus.from(
            parseJson(
                """{"sessionId":"s1","running":true,"queued":[{"id":"steer:1","text":"TUI에서 넣음","mode":"steer"},""" +
                    """{"id":"f:1","text":"끝나면","mode":"followUp"},{"id":"x","text":"?","mode":"other"}]}""",
            ),
        )!!
        assertEquals(listOf(tui, QueuedMessage("끝나면", followUp = true)), status.queued)
        assertEquals("an older bridge reports no queue", null, SessionStatus.from(parseJson("""{"sessionId":"s1","running":true}"""))!!.queued)
    }

    @Test
    fun aSteerTypedElsewhereShowsFromTheHostQueue() {
        assertEquals(listOf(tui), QueuedMessages.merge(emptyList(), listOf(tui), nowMs = 10_000))
    }

    @Test
    fun aJustSentSteerShowsUntilTheHostQueueCatchesUp() {
        val sent = QueuedMessage("폰에서", followUp = false, sentAtMs = 10_000)
        assertEquals("report sampled before the steer", listOf(sent), QueuedMessages.merge(listOf(sent), emptyList(), nowMs = 9_800))
        assertEquals(listOf(sent), QueuedMessages.merge(listOf(sent), emptyList(), nowMs = 11_000))
        val listed = QueuedMessage("폰에서", followUp = false)
        assertEquals("listed once, not twice", listOf(listed), QueuedMessages.merge(listOf(sent), listOf(listed), nowMs = 11_000))
        assertEquals("gjc took it already", emptyList<QueuedMessage>(), QueuedMessages.merge(listOf(sent), emptyList(), nowMs = 13_000))
    }

    @Test
    fun withoutHostReportsOnlyThisPhonesSteersAreKnown() {
        val sent = QueuedMessage("폰에서", followUp = false, sentAtMs = 0)
        assertEquals(listOf(sent), QueuedMessages.merge(listOf(sent), null, nowMs = 60_000))
    }
}

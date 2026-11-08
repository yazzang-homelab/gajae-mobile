package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Test

class SentPromptTest {
    private val sent = SentPrompt("이거 보이냐?", turnId = "t1")

    private fun end(seq: Int, turnId: String?, undelivered: Boolean = false): SequencedUpdate {
        val id = turnId?.let { ""","turnId":"$it"""" } ?: ""
        val reason = if (undelivered) "cancelled" else "end_turn"
        val flag = if (undelivered) ""","undelivered":true""" else ""
        return SequencedUpdate(seq, parseJson("""{"sessionUpdate":"x_gjcm_turn_end","stopReason":"$reason"$id$flag}"""))
    }

    @Test
    fun itsTurnStoppedBeforeGjcRanItGivesTheMessageBack() {
        assertEquals(SentPrompt.Settled.GIVE_BACK, sent.settle(listOf(end(5, "t1", undelivered = true)), turnOver = false))
    }

    @Test
    fun itsTurnThatRanIsDone() {
        assertEquals(SentPrompt.Settled.DONE, sent.settle(listOf(end(5, "t1")), turnOver = false))
    }

    @Test
    fun anotherPhonesUndeliveredTurnIsNotThisPhonesMessage() {
        assertEquals(SentPrompt.Settled.WAITING, sent.settle(listOf(end(5, "t2", undelivered = true)), turnOver = false))
        assertEquals(SentPrompt.Settled.DONE, sent.settle(listOf(end(5, "t2", undelivered = true)), turnOver = true))
    }

    @Test
    fun anOpenSnapshotFindsItsTurnEndAmongEarlierAndLaterTurns() {
        val updates = listOf(end(3, "t0", undelivered = true), end(5, "t1", undelivered = true), end(9, "t2"))
        assertEquals(SentPrompt.Settled.GIVE_BACK, sent.settle(updates, turnOver = true))
    }

    @Test
    fun aSnapshotWithItsTurnStillRunningKeepsWaiting() {
        val chunk = SequencedUpdate(4, parseJson("""{"sessionUpdate":"user_message_chunk"}"""))
        assertEquals(SentPrompt.Settled.WAITING, sent.settle(listOf(chunk), turnOver = false))
    }

    @Test
    fun aTurnOverWhoseEndLeftTheBufferIsNotGivenBack() {
        assertEquals(SentPrompt.Settled.DONE, sent.settle(emptyList(), turnOver = true))
        assertEquals("an end without an id", SentPrompt.Settled.DONE, sent.settle(listOf(end(5, null, undelivered = true)), turnOver = true))
    }
}

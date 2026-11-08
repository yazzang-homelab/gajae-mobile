package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Test

class ReconnectBackoffTest {
    @Test
    fun failedDialsWaitLongerUpToTheCap() {
        val backoff = ReconnectBackoff()
        assertEquals(listOf(1_000L, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000), List(7) { backoff.failedDial() })
    }

    @Test
    fun aConnectionDroppingRightAfterAttachingWaitsLikeAFailedDial() {
        // pve1 2026-11-08: every attach dropped about 0.5s later; the dials must spread out instead of repeating.
        val backoff = ReconnectBackoff()
        var now = 100_000L
        val waits = List(6) {
            backoff.attached(now)
            now += 500
            backoff.dropped(now).also { now += it }
        }
        assertEquals(listOf(1_000L, 2_000, 4_000, 8_000, 16_000, 30_000), waits)
    }

    @Test
    fun aConnectionThatHeldUpDialsAgainAtOnceWithTheWaitReset() {
        val backoff = ReconnectBackoff()
        backoff.failedDial()
        backoff.failedDial()
        backoff.attached(0)
        assertEquals(0L, backoff.dropped(ReconnectBackoff.STABLE_AFTER_MS))
        assertEquals("the wait starts over after a connection that held up", 1_000L, backoff.failedDial())
    }

    @Test
    fun aDropRightAfterALongOutageKeepsTheLongerWait() {
        val backoff = ReconnectBackoff()
        repeat(5) { backoff.failedDial() }
        backoff.attached(0)
        assertEquals(30_000L, backoff.dropped(1_000))
    }
}

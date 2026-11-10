package dev.gajae.gjcmobile.core

import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException

class SessionListFailureTest {
    @Test
    fun aCancelledRequestIsNotAFailure() {
        assertEquals(SessionListFailure.Cancelled, SessionListFailure.classify(CancellationException("Job was cancelled")))
    }

    @Test
    fun anErrorReplyKeepsTheConnection() {
        assertEquals(SessionListFailure.Remote, SessionListFailure.classify(BridgeException.Remote(-32000, "boom")))
    }

    @Test
    fun aDroppedSocketIsLeftToTheEventStream() {
        assertEquals(SessionListFailure.Disconnected, SessionListFailure.classify(BridgeException.Disconnected()))
    }

    @Test
    fun transportAndProtocolFailuresEndTheConnection() {
        assertEquals(SessionListFailure.Transport, SessionListFailure.classify(BridgeException.Closed(1006, "")))
        assertEquals(SessionListFailure.Transport, SessionListFailure.classify(BridgeException.ProtocolViolation("x")))
        assertEquals(SessionListFailure.Transport, SessionListFailure.classify(IOException("reset")))
    }
}

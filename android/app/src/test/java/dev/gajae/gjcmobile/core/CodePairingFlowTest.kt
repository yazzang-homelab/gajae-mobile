package dev.gajae.gjcmobile.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** AC7 on the app side: what the pairing hello dials, how its failures are classified, and the key-change gate. */
class CodePairingFlowTest {
    private fun offer(
        hostKey: Byte = 3,
        endpoints: List<String> = listOf("ws://100.85.215.116:7787/ws", "ws://192.168.0.10:7787/ws"),
        pairingId: String = "cGFpcjEy",
    ) = PairingOffer(
        v = 1,
        hostId = "aG9zdC1pZC0x",
        name = "가재 호스트",
        hostKey = B64Url.encode(ByteArray(32) { hostKey }),
        endpoints = endpoints,
        pairingId = pairingId,
        secret = B64Url.encode(ByteArray(32) { 9 }),
        exp = "2026-11-20T12:00:00.000Z",
    )

    private class Call(val offer: PairingOffer, val endpoints: List<String>, val replaceChangedKey: Boolean)

    private class Harness(
        val hosts: List<PairedHost> = emptyList(),
        var failure: Exception? = null,
    ) {
        val calls = mutableListOf<Call>()
        val saved = mutableListOf<PairedHost>()
        val flow = CodePairingFlow(
            hosts = { hosts },
            hello = { offer, endpoints, replace ->
                calls.add(Call(offer, endpoints, replace))
                failure?.let { throw it }
                PairedHost(offer).copy(lastEndpoint = endpoints.first()).also { saved.add(it) }
            },
        )
    }

    private fun codeFailure(block: () -> Unit): BridgeException.CodePairing {
        try {
            block()
        } catch (e: BridgeException.CodePairing) {
            return e
        }
        fail("expected a code pairing failure")
        throw AssertionError()
    }

    // --- hello address order ---

    @Test
    fun endpointKeySpellsOutTheDefaultPort() {
        assertEquals(endpointKey("ws://192.168.0.10/ws"), endpointKey("ws://192.168.0.10:80/ws"))
        assertEquals(endpointKey("ws://Host.Local/ws"), endpointKey("WS://host.local:80/ws"))
        assertEquals(endpointKey("wss://h/ws"), endpointKey("wss://h:443/ws"))
        assertFalse(endpointKey("ws://h/ws") == endpointKey("ws://h:7787/ws"))
        assertFalse(endpointKey("ws://h/ws") == endpointKey("ws://h/other"))
        assertEquals("not a uri", endpointKey("not a uri"))
    }

    @Test
    fun codeAddressFirstThenOfferOrderWithoutRepeats() {
        val o = offer(endpoints = listOf("ws://100.85.215.116:7787/ws", "ws://192.168.0.10:7787/ws", "ws://host.local/ws"))
        assertEquals(
            listOf("ws://192.168.0.10:7787/ws", "ws://100.85.215.116:7787/ws", "ws://host.local/ws"),
            helloEndpoints(o, "ws://192.168.0.10:7787/ws"),
        )
        assertEquals(o.endpoints, helloEndpoints(o, null))
        // The code's address is not one of the offer's: it still goes first.
        assertEquals(listOf("ws://10.1.2.3:7787/ws") + o.endpoints, helloEndpoints(o, "ws://10.1.2.3:7787/ws"))
    }

    @Test
    fun theDefaultPortIsTheSameAddressWhetherOrNotItIsWritten() {
        val o = offer(endpoints = listOf("ws://100.85.215.116:7787/ws", "ws://192.168.0.10:80/ws", "ws://192.168.0.10/ws"))
        assertEquals(
            listOf("ws://192.168.0.10/ws", "ws://100.85.215.116:7787/ws"),
            helloEndpoints(o, "ws://192.168.0.10/ws"),
        )
        // Only the dial order is de-duplicated; the saved host keeps the offer's own list.
        assertEquals(o.endpoints, PairedHost(o).endpoints)
    }

    // --- hello failure classification ---

    @Test
    fun lapsedCodeIsExpiredAndDropsTheOffer() {
        val failure = classifyHelloFailure(BridgeException.Rejected("pairing_invalid", "x"))
        assertTrue(failure.discardOffer)
        assertEquals(CodeFailure.HELLO_EXPIRED, (failure.error as BridgeException.CodePairing).failure)
    }

    @Test
    fun busyHostAndFailedConnectionsKeepTheOfferForARetry() {
        val retryable = listOf(
            BridgeException.Rejected("pairing_busy", "x"),
            BridgeException.NoReachableEndpoint(),
            BridgeException.Disconnected(),
            BridgeException.Closed(1006, ""),
            java.net.ConnectException("refused"),
        )
        for (e in retryable) {
            val failure = classifyHelloFailure(e)
            assertFalse(e.toString(), failure.discardOffer)
            assertEquals(e.toString(), CodeFailure.HELLO_FAILED, (failure.error as BridgeException.CodePairing).failure)
        }
    }

    @Test
    fun anythingElseKeepsItsOwnCause() {
        val others = listOf<Exception>(
            BridgeException.Rejected("unknown_device", "no"),
            BridgeException.ProtocolViolation("malformed welcome"),
            IllegalStateException(KEY_CHANGED_REFUSED_TEXT),
        )
        for (e in others) {
            val failure = classifyHelloFailure(e)
            assertSame(e, failure.error)
            assertFalse(failure.discardOffer)
        }
    }

    // --- the offer's lifetime ---

    @Test
    fun aFailedHelloKeepsTheOfferAndRetryUsesIt() = runBlocking {
        val h = Harness(failure = BridgeException.NoReachableEndpoint())
        val fetched = CodeOffer(offer(), "ws://192.168.0.10:7787/ws")
        val e = codeFailure { runBlocking { h.flow.receive(fetched) } }
        assertEquals(CodeFailure.HELLO_FAILED, e.failure)
        assertSame(fetched, h.flow.offer)
        h.failure = BridgeException.Rejected("pairing_busy", "x")
        assertEquals(CodeFailure.HELLO_FAILED, codeFailure { runBlocking { h.flow.retry() } }.failure)
        assertSame(fetched, h.flow.offer)
        h.failure = null
        val outcome = h.flow.retry() as CodePairingOutcome.Paired
        assertEquals("ws://192.168.0.10:7787/ws", outcome.host.lastEndpoint)
        assertNull("success drops the offer", h.flow.offer)
        assertEquals(3, h.calls.size)
        assertEquals(listOf("ws://192.168.0.10:7787/ws", "ws://100.85.215.116:7787/ws"), h.calls.last().endpoints)
    }

    @Test
    fun anExpiredCodeDropsTheOfferAndRetryHasNothing() = runBlocking {
        val h = Harness(failure = BridgeException.Rejected("pairing_invalid", "x"))
        val e = codeFailure { runBlocking { h.flow.receive(CodeOffer(offer(), "ws://192.168.0.10:7787/ws")) } }
        assertEquals(CodeFailure.HELLO_EXPIRED, e.failure)
        assertNull(h.flow.offer)
        try {
            h.flow.retry()
            fail("expected the lost-offer error")
        } catch (e: IllegalStateException) {
            assertEquals(CODE_OFFER_LOST, e.message)
        }
    }

    @Test
    fun aCancelledHelloKeepsTheOffer() = runBlocking {
        val h = Harness(failure = CancellationException("view model cleared"))
        try {
            h.flow.receive(CodeOffer(offer(), "ws://192.168.0.10:7787/ws"))
            fail("expected cancellation")
        } catch (e: CancellationException) {
            assertNotNull(h.flow.offer)
        }
    }

    @Test
    fun onlyTheNextVerifiedOfferReplacesTheKeptOne() = runBlocking {
        val h = Harness(failure = BridgeException.NoReachableEndpoint())
        val first = CodeOffer(offer(pairingId = "b25l"), "ws://192.168.0.10:7787/ws")
        codeFailure { runBlocking { h.flow.receive(first) } }
        assertSame(first, h.flow.offer)
        val second = CodeOffer(offer(pairingId = "dHdv"), "ws://192.168.0.10:7787/ws")
        codeFailure { runBlocking { h.flow.receive(second) } }
        assertSame(second, h.flow.offer)
    }

    @Test
    fun theOfferChangeIsMirroredForTheUi() = runBlocking {
        val seen = mutableListOf<String?>()
        val flow = CodePairingFlow({ emptyList() }, { o, e, _ -> PairedHost(o).copy(lastEndpoint = e.first()) }) { seen.add(it?.offer?.pairingId) }
        flow.receive(CodeOffer(offer(), "ws://192.168.0.10:7787/ws"))
        assertEquals(listOf("cGFpcjEy", null), seen)
    }

    // --- key change gate ---

    private fun knownHost(hostKey: Byte) = PairedHost(offer(hostKey = hostKey))

    @Test
    fun aChangedKeyAsksBeforeAnyHello() = runBlocking {
        val h = Harness(hosts = listOf(knownHost(hostKey = 1)))
        val fetched = CodeOffer(offer(hostKey = 3), "ws://192.168.0.10:7787/ws")
        val outcome = h.flow.receive(fetched)
        assertTrue(outcome is CodePairingOutcome.ConfirmKeyChange)
        assertTrue("no hello before the user approves", h.calls.isEmpty())
        assertSame(fetched, h.flow.offer)
        // Asking again (the "다시 시도" button) still does not dial.
        assertTrue(h.flow.retry() is CodePairingOutcome.ConfirmKeyChange)
        assertTrue(h.calls.isEmpty())
    }

    @Test
    fun cancellingAChangedKeySavesNothingAndDropsTheOffer() = runBlocking {
        val h = Harness(hosts = listOf(knownHost(hostKey = 1)))
        h.flow.receive(CodeOffer(offer(hostKey = 3), "ws://192.168.0.10:7787/ws"))
        h.flow.discard()
        assertNull(h.flow.offer)
        assertTrue(h.calls.isEmpty())
        assertTrue(h.saved.isEmpty())
    }

    @Test
    fun approvingAChangedKeyDialsWithTheReplacementFlag() = runBlocking {
        val h = Harness(hosts = listOf(knownHost(hostKey = 1)))
        h.flow.receive(CodeOffer(offer(hostKey = 3), "ws://192.168.0.10:7787/ws"))
        val host = h.flow.approveKeyChange()
        assertEquals(1, h.calls.size)
        assertTrue(h.calls.single().replaceChangedKey)
        assertEquals(host, h.saved.single())
        assertNull(h.flow.offer)
    }

    @Test
    fun aFailedApprovedHelloKeepsTheApprovalAndRetryDoesNotAskAgain() = runBlocking {
        val h = Harness(hosts = listOf(knownHost(hostKey = 1)), failure = BridgeException.NoReachableEndpoint())
        h.flow.receive(CodeOffer(offer(hostKey = 3), "ws://192.168.0.10:7787/ws"))
        assertFalse(h.flow.keyChangeApproved)
        assertEquals(CodeFailure.HELLO_FAILED, codeFailure { runBlocking { h.flow.approveKeyChange() } }.failure)
        assertNotNull(h.flow.offer)
        assertTrue(h.flow.keyChangeApproved)
        h.failure = null
        assertTrue(h.flow.retry() is CodePairingOutcome.Paired)
        assertTrue(h.calls.last().replaceChangedKey)
        assertNull(h.flow.offer)
        assertFalse(h.flow.keyChangeApproved)
    }

    @Test
    fun theApprovalIsForgottenWhenTheOfferIsDiscardedOrReplaced() = runBlocking {
        val h = Harness(hosts = listOf(knownHost(hostKey = 1)), failure = BridgeException.NoReachableEndpoint())
        h.flow.receive(CodeOffer(offer(hostKey = 3), "ws://192.168.0.10:7787/ws"))
        codeFailure { runBlocking { h.flow.approveKeyChange() } }
        assertTrue(h.flow.keyChangeApproved)
        h.flow.discard()
        assertFalse(h.flow.keyChangeApproved)

        h.flow.receive(CodeOffer(offer(hostKey = 3), "ws://192.168.0.10:7787/ws"))
        assertFalse(h.flow.keyChangeApproved)
        codeFailure { runBlocking { h.flow.approveKeyChange() } }
        assertTrue(h.flow.keyChangeApproved)
        h.failure = null
        assertTrue(h.flow.receive(CodeOffer(offer(hostKey = 4), "ws://192.168.0.10:7787/ws")) is CodePairingOutcome.ConfirmKeyChange)
        assertFalse(h.flow.keyChangeApproved)
    }

    @Test
    fun theSameKeyOrANewHostGoesStraightToTheHello() = runBlocking {
        val same = Harness(hosts = listOf(knownHost(hostKey = 3)))
        assertTrue(same.flow.receive(CodeOffer(offer(hostKey = 3), "ws://192.168.0.10:7787/ws")) is CodePairingOutcome.Paired)
        assertFalse(same.calls.single().replaceChangedKey)
        val fresh = Harness()
        assertTrue(fresh.flow.receive(CodeOffer(offer(), "ws://192.168.0.10:7787/ws")) is CodePairingOutcome.Paired)
    }

    // --- progress text ---

    @Test
    fun confirmingStageShowsTheRemainingAttempts() {
        assertEquals("확인 중 · 남은 시도 4회", confirmingStage(4))
        assertEquals("확인 중 · 남은 시도 0회", confirmingStage(0))
        assertEquals("확인 중", confirmingStage(null))
    }
}

private const val KEY_CHANGED_REFUSED_TEXT = "key changed"

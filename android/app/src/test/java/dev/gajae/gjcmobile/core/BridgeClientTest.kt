package dev.gajae.gjcmobile.core

import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Drives BridgeClient against an in-memory server that implements the bridge's side of server.ts. */
class BridgeClientTest {
    private class Pipe : FrameTransport {
        val toServer = Channel<TransportMessage>(Channel.UNLIMITED)
        val toClient = Channel<TransportMessage>(Channel.UNLIMITED)
        override fun send(message: TransportMessage) { toServer.trySend(message) }
        override suspend fun receive() = toClient.receive()
        override fun close() { toClient.close(BridgeException.Disconnected()) }
    }

    private val hostPrivate = X25519.generatePrivateKey()
    private val hostPublic = X25519.publicFromPrivate(hostPrivate)

    /** Server half: verifies pairing (if any), answers welcome, then echoes requests and emits one event. */
    private fun CoroutineScope.serve(pipe: Pipe, knownDevice: Boolean, pairingSecret: ByteArray? = null) = launch(Dispatchers.Default) {
        val hello = parseJson((pipe.toServer.receive() as TransportMessage.Text).text)
        val deviceKey = B64Url.decode(hello["deviceKey"].str!!)!!
        val clientEph = B64Url.decode(hello["eph"].str!!)!!
        val clientNonce = B64Url.decode(hello["nonce"].str!!)!!
        val pairingOk = hello["pairing"]?.let { p ->
            val expected = E2EE.pairingProof(pairingSecret!!, deviceKey, clientEph)
            B64Url.decode(p["proof"].str!!)!!.contentEquals(expected)
        }
        if (pairingOk == false || (pairingOk == null && !knownDevice)) {
            val code = if (pairingOk == false) "pairing_invalid" else "unknown_device"
            pipe.toClient.send(TransportMessage.Text(buildJsonObject { put("t", "error"); put("code", code); put("message", "no") }.encode()))
            pipe.toClient.close()
            return@launch
        }
        val ephPrivate = X25519.generatePrivateKey()
        val ephPublic = X25519.publicFromPrivate(ephPrivate)
        val serverNonce = E2EE.randomBytes(16)
        val ikm = X25519.computeSharedSecret(ephPrivate, clientEph) + X25519.computeSharedSecret(hostPrivate, clientEph) +
            X25519.computeSharedSecret(hostPrivate, deviceKey)
        val info = E2EE.PROTOCOL_LABEL.toByteArray() + deviceKey + hostPublic + clientEph + ephPublic
        val okm = Hkdf.computeHkdf("HMACSHA256", ikm, clientNonce + serverNonce, info, 64)
        val cipher = FrameCipher(okm.copyOfRange(32, 64), okm.copyOfRange(0, 32))
        pipe.toClient.send(TransportMessage.Text(buildJsonObject {
            put("t", "welcome"); put("v", 1); put("hostId", "h1")
            put("eph", B64Url.encode(ephPublic)); put("nonce", B64Url.encode(serverNonce))
        }.encode()))
        while (true) {
            val frame = pipe.toServer.receive() as TransportMessage.Data
            val req = parseJson(String(cipher.open(frame.bytes)))
            val reply = when (req["m"].str) {
                "session.interrupt" -> buildJsonObject {
                    put("id", req["id"].int!!)
                    put("e", buildJsonObject { put("code", -32005); put("message", "nothing queued") })
                }
                "session.prompt" -> buildJsonObject {
                    put("id", req["id"].int!!)
                    put("e", buildJsonObject {
                        put("code", -32004); put("message", "터미널 턴")
                        put("data", buildJsonObject { put("code", "host_turn") })
                    })
                }
                "permission.list" -> parseJson(
                    """{"id":${req["id"].int},"r":{"requests":[{"requestId":"r1","sessionId":"s2","toolCall":{"title":"ask"},"options":[]}]}}""",
                )
                else -> buildJsonObject { put("id", req["id"].int!!); put("r", buildJsonObject { put("echo", req["m"].str!!) }) }
            }
            pipe.toClient.send(TransportMessage.Data(cipher.seal(reply.encode().toByteArray())))
            val event = buildJsonObject {
                put("ev", "session.status")
                put("p", buildJsonObject { put("sessionId", "s1"); put("running", true); put("tokensPerSecond", 42.5) })
            }
            pipe.toClient.send(TransportMessage.Data(cipher.seal(event.encode().toByteArray())))
        }
    }

    @Test
    fun handshakeRequestsErrorsAndEvents() = runBlocking {
        withTimeout(10_000) {
            val pipe = Pipe()
            val server = serve(pipe, knownDevice = true)
            val client = BridgeClient.connect(pipe, DeviceIdentity(), hostPublic, "test")
            assertEquals("h1", client.hostId)
            assertEquals("ping", client.request("ping")["echo"].str)
            assertEquals("host.info", client.request("host.info")["echo"].str)
            assertEquals(listOf("r1" to "s2"), client.pendingPermissions().map { it.requestId to it.sessionId })
            try {
                client.interrupt("s1")
                fail("expected remote error")
            } catch (e: BridgeException.Remote) {
                assertEquals(-32005, e.code)
                assertEquals("an error without data has no reason", null, e.reason)
            }
            try {
                client.request("session.prompt")
                fail("expected remote error")
            } catch (e: BridgeException.Remote) {
                assertEquals(-32004 to "host_turn", e.code to e.reason)
            }
            val status = client.events.first() as BridgeEvent.Status
            assertEquals(SessionStatus("s1", true, 42.5), status.status)
            client.close()
            server.cancel()
        }
    }

    @Test
    fun pairingProofIsAcceptedAndBadProofIsRejected() = runBlocking {
        withTimeout(10_000) {
            val secret = ByteArray(32) { 3 }
            val ok = Pipe()
            val s1 = serve(ok, knownDevice = false, pairingSecret = secret)
            BridgeClient.connect(ok, DeviceIdentity(), hostPublic, "test", pairing = "p1" to secret).close()
            s1.cancel()

            val bad = Pipe()
            serve(bad, knownDevice = false, pairingSecret = secret)
            try {
                BridgeClient.connect(bad, DeviceIdentity(), hostPublic, "test", pairing = "p1" to ByteArray(32))
                fail("expected rejection")
            } catch (e: BridgeException.Rejected) {
                assertEquals("pairing_invalid", e.code)
            }
        }
    }

    @Test
    fun unknownDeviceIsRejectedWithKoreanMessage() = runBlocking {
        withTimeout(10_000) {
            val pipe = Pipe()
            serve(pipe, knownDevice = false)
            try {
                BridgeClient.connect(pipe, DeviceIdentity(), hostPublic, "test")
                fail("expected rejection")
            } catch (e: BridgeException.Rejected) {
                assertEquals("unknown_device", e.code)
                assertTrue(e.message!!.contains("페어링되지 않은"))
            }
        }
    }

    // --- device-code pairing (gjcm-code-v1, #128) ---

    private val code = "4PUXU36F4W"

    private val offerJson = buildJsonObject {
        put("v", 1)
        put("hostId", "aG9zdC1pZC0x")
        put("name", "가재 호스트")
        put("hostKey", B64Url.encode(ByteArray(32) { 3 }))
        put("endpoints", JsonArray(listOf("ws://100.85.215.116:7787/ws", "ws://192.168.0.10:7787/ws").map(::JsonPrimitive)))
        put("pairingId", "cGFpcjEy")
        put("secret", B64Url.encode(ByteArray(32) { 9 }))
        put("exp", "2026-11-20T12:00:00.000Z")
    }.encode()

    private fun text(json: JsonElement) = TransportMessage.Text(json.encode())

    /** Bridge half of the code exchange; [prs] is the code the bridge believes in. */
    private fun CoroutineScope.serveCode(
        pipe: Pipe,
        prs: String,
        wrongLeft: Int = 4,
        sendOkEvenIfWrong: Boolean = false,
        left: Int = 5,
        dropAfterReply: Boolean = false,
    ) = launch(Dispatchers.Default) {
        val pake = parseJson((pipe.toServer.receive() as TransportMessage.Text).text)
        assertEquals("pake", pake["t"].str)
        val responder = CPaceResponder.start(prs.toByteArray(), B64Url.decode(pake["sid"].str!!)!!, B64Url.decode(pake["ya"].str!!)!!)!!
        pipe.toClient.send(text(buildJsonObject { put("t", "pake.reply"); put("yb", B64Url.encode(responder.yb)); put("left", left) }))
        if (dropAfterReply) {
            pipe.toServer.receive()
            pipe.toClient.close(BridgeException.Closed(1006, ""))
            return@launch
        }
        val confirm = parseJson((pipe.toServer.receive() as TransportMessage.Text).text)
        assertEquals("pake.confirm", confirm["t"].str)
        val ta = B64Url.decode(confirm["ta"].str!!)!!
        val confirmed = responder.confirm(ta) ?: if (sendOkEvenIfWrong) responder.confirmWithoutChecking() else null
        if (confirmed == null) {
            pipe.toClient.send(text(buildJsonObject { put("t", "error"); put("code", "code_wrong"); put("message", "no"); put("left", wrongLeft) }))
            pipe.toClient.close()
            return@launch
        }
        pipe.toClient.send(text(buildJsonObject {
            put("t", "pake.ok")
            put("tb", B64Url.encode(confirmed.tb))
            put("box", B64Url.encode(confirmed.seal(offerJson.toByteArray())))
        }))
        pipe.toClient.close()
    }

    private fun CoroutineScope.serveError(pipe: Pipe, errorCode: String) = launch(Dispatchers.Default) {
        pipe.toServer.receive()
        pipe.toClient.send(text(buildJsonObject { put("t", "error"); put("code", errorCode); put("message", "x") }))
        pipe.toClient.close()
    }

    private suspend fun codeFailure(block: suspend () -> Unit): BridgeException.CodePairing {
        try {
            block()
        } catch (e: BridgeException.CodePairing) {
            return e
        }
        fail("expected a code pairing failure")
        throw AssertionError()
    }

    private class Failing(private val error: Throwable) : FrameTransport {
        override fun send(message: TransportMessage) {}
        override suspend fun receive(): TransportMessage = throw error
        override fun close() {}
    }

    @Test
    fun codeExchangeDeliversTheOfferAndReportsConfirming() = runBlocking {
        withTimeout(20_000) {
            val pipe = Pipe()
            serveCode(pipe, code)
            val confirming = mutableListOf<Int?>()
            val offer = fetchOfferWithCode(pipe, code, onConfirming = { confirming.add(it) })
            assertEquals(listOf<Int?>(5), confirming)
            assertEquals("aG9zdC1pZC0x", offer.hostId)
            assertEquals(listOf("ws://100.85.215.116:7787/ws", "ws://192.168.0.10:7787/ws"), offer.endpoints)
        }
    }

    @Test
    fun pairWithCodeDecodesTheCodeAndReturnsTheAnsweringAddress() = runBlocking {
        withTimeout(20_000) {
            val pipe = Pipe()
            serveCode(pipe, code)
            var dialed = ""
            val result = BridgeClient.pairWithCode("4pux-u36f-4w", openTransport = { dialed = it; pipe })
            assertEquals("ws://100.85.215.116:7787/ws", dialed)
            assertEquals(dialed, result.endpoint)
            assertEquals("cGFpcjEy", result.offer.pairingId)

            val local = Pipe()
            serveCode(local, code)
            val viaDial = BridgeClient.pairWithCode(code, dial = "ws://127.0.0.1:9/ws", openTransport = { dialed = it; local })
            assertEquals("ws://127.0.0.1:9/ws", dialed)
            assertEquals("ws://127.0.0.1:9/ws", viaDial.endpoint)
        }
    }

    @Test
    fun badCodesNeverDial() = runBlocking {
        val never: (String) -> FrameTransport = { throw AssertionError("dialed $it") }
        val format = codeFailure { BridgeClient.pairWithCode("4P0XU36F4W", openTransport = never) }
        assertEquals(CodeFailure.CODE_FORMAT, format.failure)
        assertTrue(format.message!!.contains("3번째 글자"))
        assertEquals(CodeFailure.CODE_FORMAT, codeFailure { BridgeClient.pairWithCode("4PUXU36F42", openTransport = never) }.failure)
        assertEquals(CodeFailure.CODE_UNSUPPORTED, codeFailure { BridgeClient.pairWithCode("2PUXU36F4W", openTransport = never) }.failure)
    }

    @Test
    fun badHelloFromAnOlderBridgeIsBridgeOutdated() = runBlocking {
        withTimeout(20_000) {
            val pipe = Pipe()
            serveError(pipe, "bad_hello")
            val e = codeFailure { fetchOfferWithCode(pipe, code) }
            assertEquals(CodeFailure.BRIDGE_OUTDATED, e.failure)
            assertTrue(e.message!!.contains("0.1.6"))
        }
    }

    @Test
    fun codeWrongKeepsTheRemainingAttempts() = runBlocking {
        withTimeout(20_000) {
            val pipe = Pipe()
            serveCode(pipe, "4PUXU36F4X", wrongLeft = 3)
            val e = codeFailure { fetchOfferWithCode(pipe, code) }
            assertEquals(CodeFailure.CODE_WRONG, e.failure)
            assertEquals(3, e.left)
            assertTrue(e.message!!.contains("남은 시도 3회"))
        }
    }

    @Test
    fun bridgeErrorCodesMapToTheirMessages() = runBlocking {
        withTimeout(20_000) {
            val expected = mapOf(
                "code_expired" to CodeFailure.CODE_EXPIRED,
                "code_locked" to CodeFailure.CODE_LOCKED,
                "code_busy" to CodeFailure.CODE_BUSY,
                "bad_pake" to CodeFailure.BAD_PAKE,
            )
            for ((remote, failure) in expected) {
                val pipe = Pipe()
                serveError(pipe, remote)
                val e = codeFailure { fetchOfferWithCode(pipe, code) }
                assertEquals(remote, failure, e.failure)
                assertEquals(remote, codeFailureMessage(failure), e.message)
            }
        }
    }

    @Test
    fun aBridgeThatDoesNotKnowTheCodeFailsKeyConfirmation() = runBlocking {
        withTimeout(20_000) {
            val pipe = Pipe()
            serveCode(pipe, "4PUXU36F4X", sendOkEvenIfWrong = true)
            assertEquals(CodeFailure.PAKE_FAILED, codeFailure { fetchOfferWithCode(pipe, code) }.failure)
        }
    }

    @Test
    fun invalidPointFromTheBridgeAborts() = runBlocking {
        withTimeout(20_000) {
            val pipe = Pipe()
            launch(Dispatchers.Default) {
                pipe.toServer.receive()
                // A low-order point (u = 0) as Yb.
                pipe.toClient.send(text(buildJsonObject { put("t", "pake.reply"); put("yb", B64Url.encode(ByteArray(32))); put("left", 5) }))
            }
            assertEquals(CodeFailure.PAKE_FAILED, codeFailure { fetchOfferWithCode(pipe, code) }.failure)
        }
    }

    @Test
    fun connectTimeoutAndRefusalAreToldApart() = runBlocking {
        val address = (DeviceCode.decode(code) as DecodeResult.Ok).address
        val timeout = codeFailure { fetchOfferWithCode(Failing(java.net.SocketTimeoutException("timeout")), code, address) }
        assertEquals(CodeFailure.CONNECT_TIMEOUT, timeout.failure)
        assertTrue(timeout.message!!.contains("100.85.215.116(Tailscale)에 닿지 않습니다"))
        val refused = codeFailure {
            fetchOfferWithCode(Failing(java.net.ConnectException("failed to connect to /100.85.215.116 (port 7787): ECONNREFUSED (Connection refused)")), code, address)
        }
        assertEquals(CodeFailure.CONNECT_REFUSED, refused.failure)
        assertTrue(refused.message!!.contains("gjcm-bridge serve"))
        // OkHttp wraps the refusal: the errno is in the cause.
        val wrapped = java.net.ConnectException("Failed to connect to /100.85.215.116:7787").apply {
            initCause(java.net.ConnectException("connect failed: ECONNREFUSED (Connection refused)"))
        }
        assertEquals(CodeFailure.CONNECT_REFUSED, codeFailure { fetchOfferWithCode(Failing(wrapped), code, address) }.failure)
        // Any other ConnectException (no route, network unreachable) is "does not reach", not "serve is not running".
        val unreachable = codeFailure {
            fetchOfferWithCode(Failing(java.net.ConnectException("connect failed: ENETUNREACH (Network is unreachable)")), code, address)
        }
        assertEquals(CodeFailure.CONNECT_TIMEOUT, unreachable.failure)
        assertFalse(unreachable.message!!.contains("gjcm-bridge serve"))
        val lan = (DeviceCode.decode("A2233W9JE") as DecodeResult.Ok).address
        assertFalse(codeFailureMessage(CodeFailure.CONNECT_TIMEOUT, address = lan).contains("Tailscale"))
        assertFalse(codeFailureMessage(CodeFailure.CONNECT_TIMEOUT, address = lan).contains("--code-lan"))
        assertTrue(codeFailureMessage(CodeFailure.CONNECT_TIMEOUT, address = address).contains("--code-lan"))
    }

    @Test
    fun aDropBeforeTheReplyIsADisconnectAndAfterItAnUncertainAttempt() = runBlocking {
        withTimeout(20_000) {
            val early = codeFailure { fetchOfferWithCode(Failing(BridgeException.Closed(1006, "")), code) }
            assertEquals(CodeFailure.DISCONNECTED, early.failure)
            assertTrue(early.message!!.contains("잠시 후 다시 시도하세요"))
            assertTrue(early.message!!.contains("`gjcm-bridge pair`를 다시 실행"))

            val pipe = Pipe()
            serveCode(pipe, code, dropAfterReply = true)
            val late = codeFailure { fetchOfferWithCode(pipe, code) }
            assertEquals(CodeFailure.RESPONSE_LOST, late.failure)
            assertTrue(late.message!!.contains("남은 시도가 줄었을 수 있습니다"))
        }
    }

    @Test
    fun aTimeoutAfterTheReplyIsAnUncertainAttempt() = runBlocking {
        withTimeout(20_000) {
            val pipe = Pipe()
            launch(Dispatchers.Default) {
                val pake = parseJson((pipe.toServer.receive() as TransportMessage.Text).text)
                val responder = CPaceResponder.start(code.toByteArray(), B64Url.decode(pake["sid"].str!!)!!, B64Url.decode(pake["ya"].str!!)!!)!!
                pipe.toClient.send(text(buildJsonObject { put("t", "pake.reply"); put("yb", B64Url.encode(responder.yb)); put("left", 2) }))
                // The bridge never answers the confirmation.
            }
            val lefts = mutableListOf<Int?>()
            val e = codeFailure { BridgeClient.pairWithCode(code, timeoutMs = 300, onConfirming = { lefts.add(it) }, openTransport = { pipe }) }
            assertEquals(CodeFailure.RESPONSE_LOST, e.failure)
            assertEquals(listOf<Int?>(2), lefts)
            val silent = Pipe()
            assertEquals(CodeFailure.CONNECT_TIMEOUT, codeFailure { BridgeClient.pairWithCode(code, timeoutMs = 300, openTransport = { silent }) }.failure)
        }
    }
}

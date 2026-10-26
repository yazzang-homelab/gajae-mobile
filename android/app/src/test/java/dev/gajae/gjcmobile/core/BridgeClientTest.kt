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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
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
}

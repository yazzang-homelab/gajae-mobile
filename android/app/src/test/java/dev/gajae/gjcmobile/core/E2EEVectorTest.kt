package dev.gajae.gjcmobile.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File

/** Replays fixtures/e2ee-vector.json (written by bridge/test/gen-e2ee-vector.ts). */
class E2EEVectorTest {
    private val vector = parseJson(File(System.getProperty("gjcm.fixtures"), "e2ee-vector.json").readText())
    private fun bytes(key: String) = B64Url.decode(vector[key].str!!)!!

    @Test
    fun reproducesBridgeKeyScheduleFramesAndPairingProof() {
        val device = DeviceIdentity(bytes("devicePrivate"))
        val ephPrivate = bytes("clientEphPrivate")
        val ephPublic = E2EE.publicKey(ephPrivate)
        val keys = E2EE.clientKeys(device.privateKey, ephPrivate, E2EE.Transcript(
            deviceKey = device.publicKey,
            hostKey = bytes("hostPublic"),
            clientEph = ephPublic,
            serverEph = bytes("serverEphPublic"),
            clientNonce = bytes("clientNonce"),
            serverNonce = bytes("serverNonce"),
        ))
        assertArrayEquals(bytes("c2s"), keys.c2s)
        assertArrayEquals(bytes("s2c"), keys.s2c)
        assertArrayEquals(bytes("hostPublic"), E2EE.publicKey(bytes("hostPrivate")))

        val phone = FrameCipher(keys.c2s, keys.s2c)
        val frames = vector["serverFrames"].array!!.map { B64Url.decode(it.str!!)!! }
        assertEquals(vector["plaintext"].str, String(phone.open(frames[0]), Charsets.UTF_8))
        assertEquals("{}", String(phone.open(frames[1]), Charsets.UTF_8))
        val replay = assertThrows(E2EEException::class.java) { phone.open(frames[0]) }
        assertEquals("replayed or reordered frame", replay.message)

        val proof = E2EE.pairingProof(bytes("pairingSecret"), device.publicKey, ephPublic)
        assertArrayEquals(bytes("pairingProof"), proof)
    }

    @Test
    fun sealedFrameMatchesBridgeLayout() {
        // The bridge sealed frame0 with s2c at counter 0; sealing the same plaintext with s2c must be identical.
        val server = FrameCipher(bytes("s2c"), bytes("c2s"))
        val sealed = server.seal(vector["plaintext"].str!!.toByteArray())
        assertEquals(vector["serverFrames"].array!![0].str, B64Url.encode(sealed))
    }

    @Test
    fun tamperedFrameIsRejectedWithoutAdvancingState() {
        val key = ByteArray(32) { 9 }
        val a = FrameCipher(key, key)
        val b = FrameCipher(key, key)
        val frame = a.seal("hello".toByteArray())
        frame[frame.size - 1] = (frame.last().toInt() xor 1).toByte()
        assertEquals("authentication failed", assertThrows(E2EEException::class.java) { b.open(frame) }.message)
        assertEquals("next", String(b.open(a.seal("next".toByteArray()))))
    }
}

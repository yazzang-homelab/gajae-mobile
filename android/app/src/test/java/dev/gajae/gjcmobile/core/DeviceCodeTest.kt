package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Replays fixtures/cpace-vector.json `codes`: the same strings the bridge's device-code.test.ts pins. */
class DeviceCodeTest {
    private val codes = parseJson(File(System.getProperty("gjcm.fixtures"), "cpace-vector.json").readText())["codes"]

    private fun range(name: String) = when (name) {
        "tailscale" -> CodeRange.TAILSCALE
        "ten" -> CodeRange.TEN
        "oneSevenTwo" -> CodeRange.ONE_SEVEN_TWO
        "oneNineTwo" -> CodeRange.ONE_NINE_TWO
        else -> error(name)
    }

    @Test
    fun alphabetAndDefaultPortMatchTheFixture() {
        assertEquals(codes["alphabet"].str, DeviceCode.ALPHABET)
        assertEquals(codes["defaultPort"].int, DeviceCode.DEFAULT_PORT)
    }

    @Test
    fun validCodesEncodeAndDecodeBothWays() {
        val valid = codes["valid"].array!!
        assertTrue(valid.size >= 10)
        for (v in valid) {
            val ip = v["ip"].str!!
            val port = v["port"].int!!
            assertEquals(v["code"].str, DeviceCode.encode(ip, port, v["secret"].int!!))
            for (text in listOf(v["code"].str!!, v["formatted"].str!!, v["code"].str!!.lowercase())) {
                val decoded = DeviceCode.decode(text) as DecodeResult.Ok
                assertEquals(v["code"].str, decoded.code)
                assertEquals(CodeAddress(ip, port, range(v["range"].str!!)), decoded.address)
                assertEquals("ws://$ip:$port/ws", decoded.endpoint)
            }
            assertEquals(v["formatted"].str, DeviceCode.format(v["code"].str!!))
        }
    }

    @Test
    fun rejectedCodesGiveTheBridgesErrorAndPosition() {
        val reject = codes["reject"].array!!
        assertTrue(reject.size >= 10)
        for (r in reject) {
            val result = DeviceCode.decode(r["input"].str!!)
            when (r["error"].str) {
                "code_format" -> assertEquals("input=${r["input"].str}", DecodeResult.Format(r["position"].int), result)
                "code_unsupported" -> assertEquals("input=${r["input"].str}", DecodeResult.Unsupported, result)
                else -> error(r.toString())
            }
        }
    }

    @Test
    fun normalizeUppercasesAndDropsSpacesAndHyphens() {
        for (n in codes["normalize"].array!!) {
            assertEquals(NormalizeResult.Ok(n["code"].str!!), DeviceCode.normalize(n["input"].str!!))
        }
    }

    @Test
    fun invalidCharacterPositionCountsKeptCharactersOnly() {
        assertEquals(NormalizeResult.Invalid(3, "0"), DeviceCode.normalize("4P-0X"))
        assertEquals(NormalizeResult.Invalid(1, "I"), DeviceCode.normalize(" i"))
        assertEquals(NormalizeResult.Ok("L"), DeviceCode.normalize("l"))
    }

    @Test
    fun addressesOutsideTheRangesDoNotEncode() {
        for (ip in listOf("8.8.8.8", "100.128.0.0", "172.32.0.0", "192.169.0.1", "10.0.0")) {
            val e = runCatching { DeviceCode.encode(ip, 7787, 0) }.exceptionOrNull()
            assertTrue(ip, e is IllegalArgumentException)
        }
    }
}

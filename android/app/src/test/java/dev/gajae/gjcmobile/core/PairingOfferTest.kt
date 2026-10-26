package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.time.Instant

class PairingOfferTest {
    private fun link(exp: String = "2026-10-23T12:10:00.000Z", v: Int = 1, endpoints: List<String> = listOf("ws://100.64.0.1:7749/ws", "wss://h.ts.net/ws")): String {
        val json = buildJsonObject {
            put("v", v)
            put("hostId", "h1")
            put("name", "mac")
            put("hostKey", B64Url.encode(ByteArray(32) { 1 }))
            put("endpoints", JsonArray(endpoints.map(::JsonPrimitive)))
            put("pairingId", "p1")
            put("secret", B64Url.encode(ByteArray(32) { 7 }))
            put("exp", exp)
        }
        return "gjcm://pair?o=" + B64Url.encode(json.encode().toByteArray())
    }

    private val now = Instant.parse("2026-10-23T12:00:00Z")

    private fun error(text: String) = assertThrows(PairingOffer.ParseException::class.java) { PairingOffer.parse(text, now) }.error

    @Test
    fun parsesValidOffer() {
        val offer = PairingOffer.parse("  ${link()}\n", now)
        assertEquals("h1", offer.hostId)
        assertEquals(listOf("ws://100.64.0.1:7749/ws", "wss://h.ts.net/ws"), offer.endpoints)
    }

    @Test
    fun rejectsExpiredOffer() = assertEquals(PairingOffer.ParseError.EXPIRED, error(link(exp = "2026-10-23T11:59:59Z")))

    @Test
    fun rejectsWrongScheme() {
        assertEquals(PairingOffer.ParseError.NOT_GJCM_URL, error(link().replace("gjcm://", "https://")))
        assertEquals(PairingOffer.ParseError.NOT_GJCM_URL, error("hello world"))
    }

    @Test
    fun rejectsMissingMalformedAndFutureVersions() {
        assertEquals(PairingOffer.ParseError.MISSING_OFFER, error("gjcm://pair"))
        assertEquals(PairingOffer.ParseError.MALFORMED, error("gjcm://pair?o=" + B64Url.encode("{}".toByteArray())))
        assertEquals(PairingOffer.ParseError.MALFORMED, error(link(endpoints = emptyList())))
        assertEquals(PairingOffer.ParseError.UNSUPPORTED_VERSION, error(link(v = 2)))
    }

    @Test
    fun lastWorkingEndpointIsTriedFirst() {
        val host = PairedHost(PairingOffer.parse(link(), now)).copy(lastEndpoint = "wss://h.ts.net/ws")
        assertEquals(listOf("wss://h.ts.net/ws", "ws://100.64.0.1:7749/ws"), host.endpointsToTry)
        assertEquals(host, PairedHost.fromJson(host.toJson()))
    }
}

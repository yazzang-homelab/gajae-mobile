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

    /** A host saved by 1.0.1 (no preferredCwd) must still load with its key, or the app would drop the pairing. */
    @Test
    fun hostsSavedBeforePreferredCwdStillLoad() {
        val saved = parseJson("""{"hostId":"h1","name":"pve","hostKey":"AQID","endpoints":["ws://100.64.0.1:7787/ws"],"lastEndpoint":"ws://100.64.0.1:7787/ws","pairedAt":"2026-11-01T00:00:00Z"}""")
        val host = PairedHost.fromJson(saved)!!
        assertEquals("AQID", host.hostKey)
        assertEquals(null, host.preferredCwd)
        val withDefault = host.copy(preferredCwd = "C:\\AI\\shared")
        assertEquals(withDefault, PairedHost.fromJson(parseJson(withDefault.toJson().encode())))
    }

    private fun dispositionFor(existingKey: String?, otherHost: Boolean = false): PairingDisposition {
        val offer = PairingOffer.parse(link(), now)
        val hosts = buildList {
            if (otherHost) add(PairedHost("h2", "other", "zzz", emptyList()))
            if (existingKey != null) add(PairedHost("h1", "mac", existingKey, emptyList()))
        }
        return pairingDisposition(offer, hosts)
    }

    @Test
    fun unknownHostIdIsANewHost() {
        assertEquals(PairingDisposition.NEW_HOST, dispositionFor(null))
        assertEquals(PairingDisposition.NEW_HOST, dispositionFor(null, otherHost = true))
    }

    @Test
    fun sameHostIdAndKeyIsARepairing() =
        assertEquals(PairingDisposition.SAME_KEY, dispositionFor(B64Url.encode(ByteArray(32) { 1 })))

    @Test
    fun sameHostIdWithDifferentKeyIsAKeyChange() =
        assertEquals(PairingDisposition.KEY_CHANGED, dispositionFor(B64Url.encode(ByteArray(32) { 2 })))

    private val k1 = B64Url.encode(ByteArray(32) { 1 })
    private val k2 = B64Url.encode(ByteArray(32) { 2 })
    private fun hostWith(key: String) = listOf(PairedHost("h1", "mac", key, emptyList()))

    @Test
    fun linksAreAlwaysConfirmedAndInAppScansOnlyWhenTheKeyChanges() {
        val offer = PairingOffer.parse(link(), now)
        assertEquals(PairingConfirmation.CONNECT, pairingConfirmation(offer, emptyList(), fromLink = true))
        assertEquals(PairingConfirmation.CONNECT, pairingConfirmation(offer, hostWith(k1), fromLink = true))
        assertEquals(PairingConfirmation.NONE, pairingConfirmation(offer, emptyList(), fromLink = false))
        assertEquals(PairingConfirmation.NONE, pairingConfirmation(offer, hostWith(k1), fromLink = false))
        assertEquals(PairingConfirmation.REPLACE_KEY, pairingConfirmation(offer, hostWith(k2), fromLink = true))
        assertEquals(PairingConfirmation.REPLACE_KEY, pairingConfirmation(offer, hostWith(k2), fromLink = false))
    }

    @Test
    fun keyChangeIsRefusedWithoutExplicitApproval() {
        val offer = PairingOffer.parse(link(), now)
        assertEquals(false, pairingAllowed(offer, hostWith(k2), keyChangeApproved = false))
        assertEquals(true, pairingAllowed(offer, hostWith(k2), keyChangeApproved = true))
        assertEquals(true, pairingAllowed(offer, hostWith(k1), keyChangeApproved = false))
        assertEquals(true, pairingAllowed(offer, emptyList(), keyChangeApproved = false))
    }

    @Test
    fun newChatCwdPrefersThisChatThenSavedDefaultThenBridge() {
        val host = PairedHost("h", "n", "k", emptyList())
        assertEquals("/home/u", host.newChatCwd(explicit = null, bridgeDefault = "/home/u"))
        assertEquals("", host.newChatCwd(explicit = null, bridgeDefault = null))
        val saved = host.copy(preferredCwd = "/srv/work")
        assertEquals("/srv/work", saved.newChatCwd(explicit = null, bridgeDefault = "/home/u"))
        assertEquals("/tmp/once", saved.newChatCwd(explicit = "/tmp/once", bridgeDefault = "/home/u"))
        assertEquals("/home/u", saved.copy(preferredCwd = null).newChatCwd(explicit = null, bridgeDefault = "/home/u"))
    }
}

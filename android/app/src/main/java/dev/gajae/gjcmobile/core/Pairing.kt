package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.net.URLDecoder
import java.time.Instant
import java.time.OffsetDateTime

/** QR payload from `gjcm-bridge pair`: `gjcm://pair?o=<base64url(JSON)>`. */
data class PairingOffer(
    val v: Int,
    val hostId: String,
    val name: String,
    val hostKey: String,
    val endpoints: List<String>,
    val pairingId: String,
    val secret: String,
    val exp: String,
) {
    enum class ParseError { NOT_GJCM_URL, MISSING_OFFER, UNSUPPORTED_VERSION, MALFORMED, EXPIRED }

    class ParseException(val error: ParseError) : Exception(error.name)

    companion object {
        fun parse(text: String, now: Instant = Instant.now()): PairingOffer {
            val uri = try {
                URI(text.trim())
            } catch (e: Exception) {
                throw ParseException(ParseError.NOT_GJCM_URL)
            }
            if (uri.scheme != "gjcm") throw ParseException(ParseError.NOT_GJCM_URL)
            val encoded = uri.rawQuery?.split('&')
                ?.map { it.split('=', limit = 2) }
                ?.firstOrNull { it[0] == "o" && it.size == 2 }
                ?.let { URLDecoder.decode(it[1], "UTF-8") }
            val data = encoded?.let(B64Url::decode) ?: throw ParseException(ParseError.MISSING_OFFER)
            val json = try {
                parseJson(String(data, Charsets.UTF_8))
            } catch (e: Exception) {
                throw ParseException(ParseError.MALFORMED)
            }
            val offer = try {
                PairingOffer(
                    v = json["v"].int!!,
                    hostId = json["hostId"].str!!,
                    name = json["name"].str!!,
                    hostKey = json["hostKey"].str!!,
                    endpoints = json["endpoints"].array!!.map { it.str!! },
                    pairingId = json["pairingId"].str!!,
                    secret = json["secret"].str!!,
                    exp = json["exp"].str!!,
                )
            } catch (e: NullPointerException) {
                throw ParseException(ParseError.MALFORMED)
            }
            if (offer.v != 1) throw ParseException(ParseError.UNSUPPORTED_VERSION)
            if (B64Url.decode(offer.hostKey)?.size != 32 || B64Url.decode(offer.secret)?.size != 32 || offer.endpoints.isEmpty()) {
                throw ParseException(ParseError.MALFORMED)
            }
            val expiry = parseInstant(offer.exp)
            if (expiry != null && expiry.isBefore(now)) throw ParseException(ParseError.EXPIRED)
            return offer
        }
    }
}

fun parseInstant(text: String): Instant? =
    runCatching { Instant.parse(text) }.getOrNull() ?: runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()

/** A host this phone has paired with. Persisted (encrypted) by the app. */
data class PairedHost(
    val hostId: String,
    val name: String,
    val hostKey: String,
    val endpoints: List<String>,
    val lastEndpoint: String? = null,
    val pairedAt: String = Instant.now().toString(),
) {
    constructor(offer: PairingOffer) : this(offer.hostId, offer.name, offer.hostKey, offer.endpoints)

    /** Endpoint that last worked first, then the advertised order. */
    val endpointsToTry: List<String>
        get() = lastEndpoint?.let { last -> listOf(last) + endpoints.filter { it != last } } ?: endpoints

    fun toJson(): JsonElement = buildJsonObject {
        put("hostId", hostId)
        put("name", name)
        put("hostKey", hostKey)
        put("endpoints", JsonArray(endpoints.map(::JsonPrimitive)))
        lastEndpoint?.let { put("lastEndpoint", it) }
        put("pairedAt", pairedAt)
    }

    companion object {
        fun fromJson(json: JsonElement): PairedHost? {
            return PairedHost(
                hostId = json["hostId"].str ?: return null,
                name = json["name"].str ?: return null,
                hostKey = json["hostKey"].str ?: return null,
                endpoints = json["endpoints"].array?.mapNotNull { it.str } ?: return null,
                lastEndpoint = json["lastEndpoint"].str,
                pairedAt = json["pairedAt"].str ?: Instant.now().toString(),
            )
        }
    }
}

/** The phone's static X25519 identity (one per install, shared across hosts). */
class DeviceIdentity(val privateKey: ByteArray = E2EE.generatePrivateKey()) {
    val publicKey: ByteArray = E2EE.publicKey(privateKey)
}

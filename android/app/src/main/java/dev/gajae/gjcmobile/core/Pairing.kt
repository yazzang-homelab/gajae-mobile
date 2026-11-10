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

/** How a pairing offer relates to the hosts already paired, judged by hostId and hostKey. */
enum class PairingDisposition { NEW_HOST, SAME_KEY, KEY_CHANGED }

/** An offer for a hostId we already hold under a different hostKey is a replacement the user must approve. */
fun pairingDisposition(offer: PairingOffer, hosts: List<PairedHost>): PairingDisposition {
    val existing = hosts.firstOrNull { it.hostId == offer.hostId } ?: return PairingDisposition.NEW_HOST
    return if (existing.hostKey == offer.hostKey) PairingDisposition.SAME_KEY else PairingDisposition.KEY_CHANGED
}

/** What the user must approve before an offer is submitted. */
enum class PairingConfirmation { NONE, CONNECT, REPLACE_KEY }

/**
 * A link that arrived from outside the app is always confirmed; an offer the user scanned or pasted in the app
 * goes straight through unless it would replace a known host's key.
 */
fun pairingConfirmation(offer: PairingOffer, hosts: List<PairedHost>, fromLink: Boolean): PairingConfirmation = when {
    pairingDisposition(offer, hosts) == PairingDisposition.KEY_CHANGED -> PairingConfirmation.REPLACE_KEY
    fromLink -> PairingConfirmation.CONNECT
    else -> PairingConfirmation.NONE
}

/** Replacing a known host's key is refused unless the user explicitly approved the replacement. */
fun pairingAllowed(offer: PairingOffer, hosts: List<PairedHost>, keyChangeApproved: Boolean): Boolean =
    keyChangeApproved || pairingDisposition(offer, hosts) != PairingDisposition.KEY_CHANGED

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
    /** Directory on the host PC that new chats on this host start in; set only by an explicit "save as default". */
    val preferredCwd: String? = null,
) {
    constructor(offer: PairingOffer) : this(offer.hostId, offer.name, offer.hostKey, offer.endpoints)

    /** Endpoint that last worked first, then the advertised order. */
    val endpointsToTry: List<String>
        get() = lastEndpoint?.let { last -> listOf(last) + endpoints.filter { it != last } } ?: endpoints

    /**
     * Directory a new chat starts in: a path picked for this chat, else this host's saved default, else the
     * bridge's `host.info.defaultCwd`. Empty means "let the bridge decide".
     */
    fun newChatCwd(explicit: String?, bridgeDefault: String?): String = explicit ?: preferredCwd ?: bridgeDefault ?: ""

    fun toJson(): JsonElement = buildJsonObject {
        put("hostId", hostId)
        put("name", name)
        put("hostKey", hostKey)
        put("endpoints", JsonArray(endpoints.map(::JsonPrimitive)))
        lastEndpoint?.let { put("lastEndpoint", it) }
        put("pairedAt", pairedAt)
        preferredCwd?.let { put("preferredCwd", it) }
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
                preferredCwd = json["preferredCwd"].str,
            )
        }
    }
}

/** The phone's static X25519 identity (one per install, shared across hosts). */
class DeviceIdentity(val privateKey: ByteArray = E2EE.generatePrivateKey()) {
    val publicKey: ByteArray = E2EE.publicKey(privateKey)
}

package dev.gajae.gjcmobile.core

import kotlinx.coroutines.CancellationException
import java.net.URI

const val CODE_OFFER_LOST = "연결할 코드 정보가 없습니다. 코드를 다시 입력하세요."

const val STAGE_CONNECTING = "연결 중"

/** The progress line once the bridge answered: `left` is the attempts it still allows (null when not sent). */
fun confirmingStage(left: Int?): String = "확인 중" + (left?.let { " · 남은 시도 ${it}회" } ?: "")

/** What a device-code pairing needs next from the user. */
sealed class CodePairingOutcome {
    class Paired(val host: PairedHost) : CodePairingOutcome()

    /** The offer is for a known host under a different key; the hello waits for [CodePairingFlow.approveKeyChange]. */
    class ConfirmKeyChange(val offer: PairingOffer) : CodePairingOutcome()
}

/**
 * Identity of an endpoint for de-duplication: scheme and host in lower case and the port spelled out, so
 * `ws://h/ws` and `ws://h:80/ws` are the same address. Text that is not a URI is compared as written.
 */
fun endpointKey(endpoint: String): String {
    val uri = runCatching { URI(endpoint.trim()) }.getOrNull() ?: return endpoint
    val scheme = uri.scheme?.lowercase() ?: return endpoint
    val host = uri.host?.lowercase() ?: return endpoint
    val port = if (uri.port >= 0) uri.port else when (scheme) {
        "ws", "http" -> 80
        "wss", "https" -> 443
        else -> -1
    }
    return "$scheme://$host:$port${uri.rawPath.orEmpty()}${uri.rawQuery?.let { "?$it" }.orEmpty()}"
}

/**
 * The order the pairing hello dials: the address the code was answered on first, then the offer's endpoints in their
 * order, each address once (the first spelling wins). The saved host keeps the offer's own order.
 */
fun helloEndpoints(offer: PairingOffer, preferredEndpoint: String?): List<String> =
    (listOfNotNull(preferredEndpoint) + offer.endpoints).distinctBy(::endpointKey)

/** How a failed pairing hello is reported, and whether the code's offer is dead. */
class HelloFailure(val error: Exception, val discardOffer: Boolean)

/**
 * Classifies a failure of the pairing hello after a successful exchange. `pairing_invalid` means the code lapsed:
 * the offer is dropped. `pairing_busy` and failing to connect are worth another try with the same offer. Anything
 * else is reported with its own cause (and the offer stays: only success, expiry and cancel drop it).
 */
fun classifyHelloFailure(e: Exception): HelloFailure = when {
    e is BridgeException.Rejected && e.code == "pairing_invalid" ->
        HelloFailure(BridgeException.CodePairing(CodeFailure.HELLO_EXPIRED), discardOffer = true)
    e is BridgeException.Rejected && e.code == "pairing_busy" ->
        HelloFailure(BridgeException.CodePairing(CodeFailure.HELLO_FAILED), discardOffer = false)
    e is BridgeException.NoReachableEndpoint || e is BridgeException.Disconnected || e is BridgeException.Closed ||
        e is java.io.IOException ->
        HelloFailure(BridgeException.CodePairing(CodeFailure.HELLO_FAILED), discardOffer = false)
    else -> HelloFailure(e, discardOffer = false)
}

/**
 * The second half of a device-code pairing: holds the verified offer, asks for approval before replacing a known
 * host's key, and runs the pairing hello through [hello] (`offer, endpoints in dial order, replaceChangedKey`).
 *
 * The offer is overwritten only by the next verified offer and dropped only on success, expiry or [discard]; a failed
 * hello keeps it for [retry]. [onOfferChanged] mirrors it for the UI.
 */
class CodePairingFlow(
    private val hosts: () -> List<PairedHost>,
    private val hello: suspend (PairingOffer, List<String>, Boolean) -> PairedHost,
    private val onOfferChanged: (CodeOffer?) -> Unit = {},
) {
    var offer: CodeOffer? = null
        private set(value) {
            field = value
            keyChangeApproved = false // an approval belongs to one kept offer
            onOfferChanged(value)
        }

    /** The user approved replacing the changed key of the kept offer's host; a failed hello keeps it for [retry]. */
    var keyChangeApproved = false
        private set

    /** A new `pake.ok` result: replaces the kept offer, then goes on to the confirmation or the hello. */
    suspend fun receive(fetched: CodeOffer): CodePairingOutcome {
        offer = fetched
        return proceed(fetched)
    }

    /** The kept offer goes through the same confirmation and hello again; an already approved key change is not asked twice. */
    suspend fun retry(): CodePairingOutcome {
        val kept = offer ?: throw IllegalStateException(CODE_OFFER_LOST)
        return if (keyChangeApproved) CodePairingOutcome.Paired(helloFor(kept, replaceChangedKey = true)) else proceed(kept)
    }

    /** The user approved replacing the changed key of the kept offer's host. */
    suspend fun approveKeyChange(): PairedHost {
        val kept = offer ?: throw IllegalStateException(CODE_OFFER_LOST)
        keyChangeApproved = true
        return helloFor(kept, replaceChangedKey = true)
    }

    /** The user cancelled: nothing was saved and the offer is dropped. */
    fun discard() {
        offer = null
    }

    private suspend fun proceed(kept: CodeOffer): CodePairingOutcome =
        if (pairingConfirmation(kept.offer, hosts(), fromLink = false) == PairingConfirmation.REPLACE_KEY) {
            CodePairingOutcome.ConfirmKeyChange(kept.offer)
        } else {
            CodePairingOutcome.Paired(helloFor(kept, replaceChangedKey = false))
        }

    private suspend fun helloFor(kept: CodeOffer, replaceChangedKey: Boolean): PairedHost =
        try {
            hello(kept.offer, helloEndpoints(kept.offer, kept.endpoint), replaceChangedKey).also { offer = null }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val failure = classifyHelloFailure(e)
            if (failure.discardOffer) offer = null
            throw failure.error
        }
}

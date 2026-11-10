package dev.gajae.gjcmobile.core

import kotlinx.coroutines.CancellationException

/**
 * What a failed session-list request means for the connection. Only a transport failure ends it: a cancelled
 * request (the search text changed, the last row scrolled away) and an error reply from a live bridge leave it up.
 */
enum class SessionListFailure {
    /** The calling coroutine was cancelled; nothing failed. */
    Cancelled,

    /** The socket dropped; the event stream reports it and reconnects. */
    Disconnected,

    /** The bridge answered the request with an error: the connection is fine, only the list failed. */
    Remote,

    /** Any other failure (transport, protocol, undecodable reply): the host status becomes Failed; nothing is closed or redialed here. */
    Transport,
    ;

    companion object {
        /** The query to keep after a search was cancelled: the previous one, unless something else already replaced [attempted]. */
        fun queryAfterCancelledSearch(current: String, attempted: String, previous: String): String =
            if (current == attempted) previous else current

        fun classify(error: Throwable): SessionListFailure = when (error) {
            is CancellationException -> Cancelled
            is BridgeException.Disconnected -> Disconnected
            is BridgeException.Remote -> Remote
            else -> Transport
        }
    }
}

package dev.gajae.gjcmobile.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

sealed class TransportMessage {
    data class Text(val text: String) : TransportMessage()
    class Data(val bytes: ByteArray) : TransportMessage()
}

/** Minimal WebSocket surface so the client logic is testable without a network. */
interface FrameTransport {
    /** Must deliver messages in call order. */
    fun send(message: TransportMessage)
    suspend fun receive(): TransportMessage
    fun close()
}

class OkHttpFrameTransport(url: String, client: OkHttpClient = sharedClient) : FrameTransport {
    private val inbox = Channel<TransportMessage>(Channel.UNLIMITED)
    private val socket: WebSocket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) { inbox.trySend(TransportMessage.Text(text)) }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) { inbox.trySend(TransportMessage.Data(bytes.toByteArray())) }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            inbox.close(BridgeException.Closed(code, reason))
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { inbox.close(BridgeException.Closed(code, reason)) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { inbox.close(t) }
    })

    override fun send(message: TransportMessage) {
        val ok = when (message) {
            is TransportMessage.Text -> socket.send(message.text)
            is TransportMessage.Data -> socket.send(message.bytes.toByteString())
        }
        if (!ok) throw BridgeException.Disconnected()
    }

    override suspend fun receive(): TransportMessage = inbox.receive()

    override fun close() {
        socket.close(1000, null)
        inbox.close(BridgeException.Disconnected())
    }

    companion object {
        val sharedClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}

sealed class BridgeException(message: String) : Exception(message) {
    /** Handshake refused by the bridge (`{t:"error"}`): retrying another endpoint cannot help. */
    class Rejected(val code: String, val detail: String) : BridgeException(
        when (code) {
            "unknown_device" -> "이 호스트와 페어링되지 않은 기기입니다. 다시 페어링하세요."
            "pairing_invalid" -> "페어링 코드가 만료됐거나 이미 사용됐습니다. 호스트에서 `gjcm-bridge pair`를 다시 실행하세요."
            "pairing_busy" -> "호스트가 다른 페어링을 처리하는 중입니다. 잠시 후 다시 시도하세요."
            else -> "$detail ($code)"
        },
    )
    /** A JSON-RPC error from the bridge; [reason] is its `data.code` (`host_turn`, `prompt_too_large`, ...) when sent. */
    class Remote(val code: Int, detail: String, val reason: String? = null) : BridgeException(detail)
    class ProtocolViolation(detail: String) : BridgeException("브리지 프로토콜 오류: $detail")
    class Disconnected : BridgeException("호스트와 연결이 끊겼습니다.")
    class NoReachableEndpoint : BridgeException("호스트에 연결할 수 없습니다. 같은 네트워크 또는 Tailscale에 연결돼 있는지 확인하세요.")
    class Closed(val code: Int, val reason: String) : BridgeException(reason.ifEmpty { "connection closed ($code)" })

    /** A device-code pairing (gjcm-code-v1, #128) that failed; [failure] picks the message, [left] is the bridge's remaining attempts. */
    class CodePairing(
        val failure: CodeFailure,
        val left: Int? = null,
        address: CodeAddress? = null,
        position: Int? = null,
    ) : BridgeException(codeFailureMessage(failure, left, address, position))
}

/** App-side and bridge-side outcomes of a code pairing. `CODE_*` (except FORMAT/UNSUPPORTED), `BAD_PAKE` come from the bridge's `{t:"error"}`. */
enum class CodeFailure {
    CODE_FORMAT, CODE_UNSUPPORTED, CONNECT_TIMEOUT, CONNECT_REFUSED, UNREACHABLE, DISCONNECTED,
    BRIDGE_OUTDATED, CODE_EXPIRED, CODE_WRONG, CODE_LOCKED, CODE_BUSY, BAD_PAKE, PAKE_FAILED,

    /** The connection dropped or timed out after `pake.reply`: the bridge already spent one attempt. */
    RESPONSE_LOST,

    /** pake.ok succeeded but the pairing hello did not connect: the offer is kept and the user may retry. */
    HELLO_FAILED,

    /** The bridge refused the pairing hello (`pairing_invalid`): the code lapsed after pake.ok. */
    HELLO_EXPIRED,
}

fun codeFailureMessage(failure: CodeFailure, left: Int? = null, address: CodeAddress? = null, position: Int? = null): String = when (failure) {
    CodeFailure.CODE_FORMAT ->
        if (position != null) "코드가 올바르지 않습니다. ${position}번째 글자를 확인하세요." else "코드가 올바르지 않습니다. 입력한 코드를 다시 확인하세요."
    CodeFailure.CODE_UNSUPPORTED -> "첫 글자를 다시 확인하세요. 맞게 입력했다면 이 앱이 모르는 코드 형식이니 앱을 업데이트하세요."
    CodeFailure.CONNECT_TIMEOUT ->
        if (address == null) {
            "호스트에 닿지 않습니다. 폰의 Tailscale이나 같은 Wi-Fi를 확인하세요."
        } else if (address.range == CodeRange.TAILSCALE) {
            "${address.ip}(Tailscale)에 닿지 않습니다. 폰의 Tailscale이나 같은 Wi-Fi를 확인하세요. 폰이 Tailscale 밖이면 호스트에서 `pair --code-lan`을 쓰거나 QR을 쓰세요."
        } else {
            "${address.ip}에 닿지 않습니다. 폰이 호스트와 같은 Wi-Fi에 있는지 확인하세요. 안 되면 QR을 쓰세요."
        }
    CodeFailure.CONNECT_REFUSED -> "호스트에서 `gjcm-bridge serve`가 실행 중인지, `pair`와 `serve`의 포트가 같은지 확인하세요."
    CodeFailure.UNREACHABLE -> "호스트에 연결할 수 없습니다. 같은 네트워크 또는 Tailscale에 연결돼 있는지 확인하세요."
    CodeFailure.DISCONNECTED -> "호스트와 연결이 끊겼습니다. 잠시 후 다시 시도하세요. 계속되면 호스트에서 `gjcm-bridge pair`를 다시 실행하세요."
    CodeFailure.RESPONSE_LOST -> "호스트 응답이 끊겼습니다. 남은 시도가 줄었을 수 있습니다. 잠시 후 다시 시도하세요."
    CodeFailure.BRIDGE_OUTDATED -> "호스트의 gjcm-bridge를 0.1.6 이상으로 업데이트하거나 QR을 쓰세요."
    CodeFailure.CODE_EXPIRED -> "코드가 만료됐거나 이미 사용됐습니다. 호스트에서 `gjcm-bridge pair`를 다시 실행하세요."
    CodeFailure.CODE_WRONG ->
        "코드가 맞지 않습니다(가장 최근 `pair`의 코드인지 확인)." + (left?.let { " 남은 시도 ${it}회" } ?: "")
    CodeFailure.CODE_LOCKED -> "틀린 시도가 많아 코드가 폐기됐습니다. `pair`를 다시 실행하세요."
    CodeFailure.CODE_BUSY -> "다른 기기가 이 코드로 연결 중이거나 호스트가 다른 페어링을 처리하는 중입니다. 잠시 후 다시 시도하세요."
    CodeFailure.BAD_PAKE -> "호스트와 프로토콜이 맞지 않습니다. 앱과 브리지를 업데이트하세요."
    CodeFailure.PAKE_FAILED -> "호스트 확인에 실패했습니다. 코드를 다시 확인하세요."
    CodeFailure.HELLO_FAILED -> "인증은 끝났지만 연결하지 못했습니다. 다시 시도를 누르세요."
    CodeFailure.HELLO_EXPIRED -> "코드가 만료됐습니다. 호스트에서 `pair`를 다시 실행하세요."
}

/** The offer a device-code exchange delivered and the address that answered it (the pairing hello tries it first). */
class CodeOffer(val offer: PairingOffer, val endpoint: String)

/**
 * A transport failure before the bridge answered. Only a refusal (ECONNREFUSED in the message or a cause) says the
 * bridge is not listening; any other connect failure, like a timeout, means the address did not answer.
 */
fun connectionFailure(e: Exception, address: CodeAddress?): BridgeException.CodePairing = when {
    e is java.net.SocketTimeoutException -> BridgeException.CodePairing(CodeFailure.CONNECT_TIMEOUT, address = address)
    e is java.net.ConnectException ->
        if (generateSequence<Throwable>(e) { it.cause }.take(8).any { it.message?.contains("ECONNREFUSED") == true }) {
            BridgeException.CodePairing(CodeFailure.CONNECT_REFUSED, address = address)
        } else {
            BridgeException.CodePairing(CodeFailure.CONNECT_TIMEOUT, address = address)
        }
    e is BridgeException.Closed || e is BridgeException.Disconnected -> BridgeException.CodePairing(CodeFailure.DISCONNECTED)
    else -> BridgeException.CodePairing(CodeFailure.UNREACHABLE)
}

/**
 * Runs the CPace exchange of a device code over [transport] and returns the offer out of `pake.ok`.
 * [onConfirming] fires once the bridge's first answer is in and the key confirmation goes out, with that answer's
 * `left` (the attempts remaining after this one; null when the bridge did not send it). From then on a dropped or
 * timed-out connection is [CodeFailure.RESPONSE_LOST]: the bridge already counted the attempt.
 * The transport is always closed. [address] only shapes the connection-failure messages.
 */
suspend fun fetchOfferWithCode(
    transport: FrameTransport,
    code: String,
    address: CodeAddress? = null,
    onConfirming: (left: Int?) -> Unit = {},
): PairingOffer {
    var replied = false

    fun failure(e: Exception): Exception = when {
        e is CancellationException || e is BridgeException.CodePairing -> e
        replied -> BridgeException.CodePairing(CodeFailure.RESPONSE_LOST)
        else -> connectionFailure(e, address)
    }

    suspend fun expect(type: String): JsonElement {
        val text = try {
            (transport.receive() as? TransportMessage.Text)?.text
        } catch (e: Exception) {
            throw failure(e)
        } ?: throw BridgeException.CodePairing(CodeFailure.BAD_PAKE)
        val message = runCatching { parseJson(text) }.getOrNull() ?: throw BridgeException.CodePairing(CodeFailure.BAD_PAKE)
        if (message["t"].str == type) return message
        if (message["t"].str == "error") {
            val remote = message["code"].str ?: ""
            throw when (remote) {
                "bad_hello" -> BridgeException.CodePairing(CodeFailure.BRIDGE_OUTDATED)
                "code_expired" -> BridgeException.CodePairing(CodeFailure.CODE_EXPIRED)
                "code_wrong" -> BridgeException.CodePairing(CodeFailure.CODE_WRONG, left = message["left"].int)
                "code_locked" -> BridgeException.CodePairing(CodeFailure.CODE_LOCKED)
                "code_busy" -> BridgeException.CodePairing(CodeFailure.CODE_BUSY)
                "bad_pake" -> BridgeException.CodePairing(CodeFailure.BAD_PAKE)
                else -> BridgeException.Rejected(remote.ifEmpty { "error" }, message["message"].str ?: "")
            }
        }
        throw BridgeException.CodePairing(CodeFailure.BAD_PAKE)
    }

    fun send(json: JsonElement) {
        try {
            transport.send(TransportMessage.Text(json.encode()))
        } catch (e: Exception) {
            throw failure(e)
        }
    }

    try {
        val initiator = try {
            CPaceInitiator(code.toByteArray(Charsets.UTF_8))
        } catch (e: IllegalStateException) {
            throw BridgeException.CodePairing(CodeFailure.PAKE_FAILED)
        }
        send(buildJsonObject {
            put("t", "pake")
            put("v", 1)
            put("sid", B64Url.encode(initiator.sid))
            put("ya", B64Url.encode(initiator.ya))
        })
        val reply = expect("pake.reply")
        // The bridge spent an attempt when it sent this; whatever happens next is counted against the code.
        replied = true
        val yb = reply["yb"].str?.let(B64Url::decode)
        val session = yb?.let { initiator.finish(it) } ?: throw BridgeException.CodePairing(CodeFailure.PAKE_FAILED)
        onConfirming(reply["left"].int)
        send(buildJsonObject {
            put("t", "pake.confirm")
            put("ta", B64Url.encode(session.ta))
        })
        val ok = expect("pake.ok")
        val tb = ok["tb"].str?.let(B64Url::decode)
        if (tb == null || !session.verifyTb(tb)) throw BridgeException.CodePairing(CodeFailure.PAKE_FAILED)
        val plain = ok["box"].str?.let(B64Url::decode)?.let(session::open) ?: throw BridgeException.CodePairing(CodeFailure.PAKE_FAILED)
        return try {
            PairingOffer.fromJson(parseJson(String(plain, Charsets.UTF_8)))
        } catch (e: Exception) {
            throw BridgeException.CodePairing(CodeFailure.PAKE_FAILED)
        }
    } finally {
        transport.close()
    }
}

/** Phone side of the bridge protocol: handshake, encrypted request/response, event stream. */
class BridgeClient private constructor(private val transport: FrameTransport) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val eventChannel = Channel<BridgeEvent>(Channel.UNLIMITED)
    /** Single consumer; ends with [BridgeEvent.Disconnected]. */
    val events: Flow<BridgeEvent> = eventChannel.receiveAsFlow()
    private lateinit var cipher: FrameCipher
    private val sendLock = Mutex()
    private var nextId = 1
    private val pending = ConcurrentHashMap<Int, CompletableDeferred<JsonElement>>()
    private var reader: Job? = null
    @Volatile var isClosed = false; private set
    var hostId: String? = null; private set

    private suspend fun handshake(device: DeviceIdentity, hostKey: ByteArray, deviceName: String, pairing: Pair<String, ByteArray>?) {
        val ephPrivate = E2EE.generatePrivateKey()
        val ephPublic = E2EE.publicKey(ephPrivate)
        val clientNonce = E2EE.randomBytes(16)
        val hello = buildJsonObject {
            put("t", "hello")
            put("v", 1)
            put("deviceKey", B64Url.encode(device.publicKey))
            put("eph", B64Url.encode(ephPublic))
            put("nonce", B64Url.encode(clientNonce))
            put("name", deviceName)
            if (pairing != null) {
                put("pairing", buildJsonObject {
                    put("id", pairing.first)
                    put("proof", B64Url.encode(E2EE.pairingProof(pairing.second, device.publicKey, ephPublic)))
                })
            }
        }
        transport.send(TransportMessage.Text(hello.encode()))
        val replyText = (transport.receive() as? TransportMessage.Text)?.text
            ?: throw BridgeException.ProtocolViolation("expected welcome")
        val reply = runCatching { parseJson(replyText) }.getOrNull() ?: throw BridgeException.ProtocolViolation("expected welcome")
        if (reply["t"].str == "error") throw BridgeException.Rejected(reply["code"].str ?: "error", reply["message"].str ?: "")
        val serverEph = reply["eph"].str?.let(B64Url::decode)
        val serverNonce = reply["nonce"].str?.let(B64Url::decode)
        if (reply["t"].str != "welcome" || serverEph == null || serverNonce == null) throw BridgeException.ProtocolViolation("malformed welcome")
        val keys = E2EE.clientKeys(device.privateKey, ephPrivate, E2EE.Transcript(device.publicKey, hostKey, ephPublic, serverEph, clientNonce, serverNonce))
        cipher = FrameCipher(keys.c2s, keys.s2c)
        hostId = reply["hostId"].str
        reader = scope.launch { readLoop() }
    }

    private suspend fun readLoop() {
        while (!isClosed) {
            try {
                val message = transport.receive() as? TransportMessage.Data ?: throw BridgeException.ProtocolViolation("expected binary frame")
                handle(parseJson(String(cipher.open(message.bytes), Charsets.UTF_8)))
            } catch (e: Exception) {
                shutdown(e.message ?: e.toString())
                return
            }
        }
    }

    private fun handle(message: JsonElement) {
        val id = message["id"].int
        if (id != null) {
            val deferred = pending.remove(id) ?: return
            val error = message["e"]
            if (error != null) {
                deferred.completeExceptionally(BridgeException.Remote(error["code"].int ?: -1, error["message"].str ?: "error", error["data"]["code"].str))
            } else {
                deferred.complete(message["r"] ?: JsonNull)
            }
            return
        }
        val name = message["ev"].str ?: return
        BridgeEvent.parse(name, message["p"])?.let { eventChannel.trySend(it) }
    }

    @Synchronized
    private fun shutdown(reason: String) {
        if (isClosed) return
        isClosed = true
        transport.close()
        pending.values.forEach { it.completeExceptionally(BridgeException.Disconnected()) }
        pending.clear()
        eventChannel.trySend(BridgeEvent.Disconnected(reason))
        eventChannel.close()
        scope.cancel()
    }

    fun close() = shutdown("closed")

    suspend fun request(method: String, params: JsonElement = JsonObject(emptyMap())): JsonElement {
        if (isClosed) throw BridgeException.Disconnected()
        val deferred = CompletableDeferred<JsonElement>()
        // Frames carry strictly increasing counters, so seal and enqueue must happen together in order.
        sendLock.withLock {
            val id = nextId++
            val body = buildJsonObject {
                put("id", id)
                put("m", method)
                put("p", params)
            }
            pending[id] = deferred
            try {
                transport.send(TransportMessage.Data(cipher.seal(body.encode().toByteArray())))
            } catch (e: Exception) {
                pending.remove(id)
                throw e
            }
        }
        return deferred.await()
    }

    // MARK: typed API

    suspend fun hostInfo() = HostInfo.from(request("host.info"))

    suspend fun listSessions(query: String? = null, cursor: String? = null): SessionList = SessionList.from(request("session.list", buildJsonObject {
        if (!query.isNullOrEmpty()) put("query", query)
        if (cursor != null) put("cursor", cursor)
    }))

    suspend fun newSession(cwd: String?) = OpenSnapshot.from(request("session.new", buildJsonObject { if (cwd != null) put("cwd", cwd) }))

    suspend fun openSession(sessionId: String, cwd: String?, afterSeq: Int) = OpenSnapshot.from(request("session.open", buildJsonObject {
        put("sessionId", sessionId)
        put("afterSeq", afterSeq)
        if (cwd != null) put("cwd", cwd)
    }))

    suspend fun forkSession(sessionId: String) = OpenSnapshot.from(request("session.fork", buildJsonObject { put("sessionId", sessionId) }))

    suspend fun closeSession(sessionId: String) { request("session.close", buildJsonObject { put("sessionId", sessionId) }) }

    suspend fun deleteSession(sessionId: String) { request("session.delete", buildJsonObject { put("sessionId", sessionId) }) }

    /** Returns the bridge's id for the turn the prompt starts (`null` from bridges older than `turnId`). */
    suspend fun prompt(sessionId: String, blocks: List<JsonElement>): String? =
        request("session.prompt", buildJsonObject {
            put("sessionId", sessionId)
            put("prompt", JsonArray(blocks))
        })["turnId"].str

    /** Stops the busy turn and runs the waiting steers as the next turn; `-32005` means the model already took them. */
    suspend fun interrupt(sessionId: String): String = request("session.interrupt", buildJsonObject { put("sessionId", sessionId) })["text"].str ?: ""

    suspend fun cancel(sessionId: String) { request("session.cancel", buildJsonObject { put("sessionId", sessionId) }) }

    suspend fun setConfig(sessionId: String, configId: String, value: String): List<ConfigOption> = ConfigOption.list(
        request("session.setConfig", buildJsonObject {
            put("sessionId", sessionId)
            put("configId", configId)
            put("value", value)
        })["configOptions"],
    )

    suspend fun sdkControl(sessionId: String, op: String, input: JsonElement = JsonObject(emptyMap()), confirm: Boolean = false): JsonElement =
        request("sdk.control", buildJsonObject {
            put("sessionId", sessionId)
            put("op", op)
            put("input", input)
            if (confirm) put("confirm", true)
        })["result"] ?: JsonNull

    /** Switches the session's permission mode; every phone sees it as an `x_gjcm_permission_mode` update. */
    suspend fun setPermissionMode(sessionId: String, mode: PermissionMode) {
        request("session.setPermissionMode", buildJsonObject {
            put("sessionId", sessionId)
            put("mode", mode.wire)
        })
    }

    /** Every session's waiting asks and tool approvals, without opening the chats. */
    suspend fun pendingPermissions(): List<PermissionRequest> =
        request("permission.list")["requests"].array.orEmpty().mapNotNull(PermissionRequest::from)

    suspend fun respondPermission(requestId: String, optionId: String?) {
        request("permission.respond", buildJsonObject {
            put("requestId", requestId)
            put("optionId", optionId?.let(::JsonPrimitive) ?: JsonNull)
        })
    }

    companion object {
        fun textBlock(text: String): JsonElement = buildJsonObject {
            put("type", "text")
            put("text", text)
        }

        fun imageBlock(base64: String, mimeType: String): JsonElement = buildJsonObject {
            put("type", "image")
            put("mimeType", mimeType)
            put("data", base64)
        }

        /** Opens an authenticated channel. Pass `pairing` only for the first connection from a QR offer. */
        suspend fun connect(
            transport: FrameTransport,
            device: DeviceIdentity,
            hostKey: ByteArray,
            deviceName: String,
            pairing: Pair<String, ByteArray>? = null,
        ): BridgeClient {
            val client = BridgeClient(transport)
            try {
                client.handshake(device, hostKey, deviceName, pairing)
            } catch (e: Exception) {
                transport.close()
                throw e
            }
            return client
        }

        /**
         * Device-code pairing, first half (gjcm-code-v1, #128): decodes [code], runs the CPace exchange on the address the
         * code names and returns the verified offer. The pairing hello (the second half) is `CodePairingFlow`.
         * [dial] overrides the address only (tests dial 127.0.0.1); the password is still the code. Failures are
         * [BridgeException.CodePairing]: `code_format`, `code_unsupported`, `bridge_outdated` (a bridge older than the codes
         * answers `bad_hello`), `pake_failed`, and the bridge's `code_wrong` (with `left`) and friends.
         */
        suspend fun pairWithCode(
            code: String,
            dial: String? = null,
            timeoutMs: Long = 20_000,
            onConfirming: (left: Int?) -> Unit = {},
            openTransport: (String) -> FrameTransport = { OkHttpFrameTransport(it) },
        ): CodeOffer {
            val decoded = when (val result = DeviceCode.decode(code)) {
                is DecodeResult.Ok -> result
                is DecodeResult.Format -> throw BridgeException.CodePairing(CodeFailure.CODE_FORMAT, position = result.position)
                DecodeResult.Unsupported -> throw BridgeException.CodePairing(CodeFailure.CODE_UNSUPPORTED)
            }
            val endpoint = dial ?: decoded.endpoint
            val transport = try {
                openTransport(endpoint)
            } catch (e: IllegalArgumentException) {
                throw BridgeException.CodePairing(CodeFailure.UNREACHABLE)
            }
            var replied = false
            val offer = try {
                withTimeout(timeoutMs) {
                    fetchOfferWithCode(transport, decoded.code, decoded.address) { left -> replied = true; onConfirming(left) }
                }
            } catch (e: TimeoutCancellationException) {
                throw if (replied) BridgeException.CodePairing(CodeFailure.RESPONSE_LOST) else BridgeException.CodePairing(CodeFailure.CONNECT_TIMEOUT, address = decoded.address)
            }
            return CodeOffer(offer, endpoint)
        }

        /** Tries a paired host's endpoints in order. A rejection ends the search: this device is no longer paired. */
        suspend fun connectAny(host: PairedHost, device: DeviceIdentity, deviceName: String): Pair<BridgeClient, String> {
            val hostKey = B64Url.decode(host.hostKey) ?: throw BridgeException.ProtocolViolation("bad host key")
            var lastError: Exception = BridgeException.NoReachableEndpoint()
            for (endpoint in host.endpointsToTry) {
                try {
                    return connect(endpoint, device, hostKey, deviceName) to endpoint
                } catch (e: BridgeException.Rejected) {
                    throw e
                } catch (e: BridgeException) {
                    lastError = e
                }
            }
            throw lastError
        }

        /** An unreachable endpoint would otherwise hang for the TCP timeout, so the handshake is bounded. */
        suspend fun connect(
            url: String,
            device: DeviceIdentity,
            hostKey: ByteArray,
            deviceName: String,
            pairing: Pair<String, ByteArray>? = null,
            timeoutMs: Long = 8_000,
        ): BridgeClient {
            val transport = try {
                OkHttpFrameTransport(url)
            } catch (e: IllegalArgumentException) {
                throw BridgeException.NoReachableEndpoint()
            }
            return try {
                withTimeout(timeoutMs) { connect(transport, device, hostKey, deviceName, pairing) }
            } catch (e: BridgeException.Rejected) {
                throw e
            } catch (e: BridgeException.ProtocolViolation) {
                throw e
            } catch (e: TimeoutCancellationException) {
                transport.close()
                throw BridgeException.NoReachableEndpoint()
            } catch (e: CancellationException) {
                transport.close()
                throw e
            } catch (e: Exception) {
                transport.close()
                throw BridgeException.NoReachableEndpoint()
            }
        }
    }
}

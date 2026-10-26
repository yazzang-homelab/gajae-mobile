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
            else -> "$detail ($code)"
        },
    )
    class Remote(val code: Int, detail: String) : BridgeException(detail)
    class ProtocolViolation(detail: String) : BridgeException("브리지 프로토콜 오류: $detail")
    class Disconnected : BridgeException("호스트와 연결이 끊겼습니다.")
    class NoReachableEndpoint : BridgeException("호스트에 연결할 수 없습니다. 같은 네트워크 또는 Tailscale에 연결돼 있는지 확인하세요.")
    class Closed(val code: Int, val reason: String) : BridgeException(reason.ifEmpty { "connection closed ($code)" })
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
                deferred.completeExceptionally(BridgeException.Remote(error["code"].int ?: -1, error["message"].str ?: "error"))
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

    suspend fun prompt(sessionId: String, blocks: List<JsonElement>) {
        request("session.prompt", buildJsonObject {
            put("sessionId", sessionId)
            put("prompt", JsonArray(blocks))
        })
    }

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

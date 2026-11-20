package dev.gajae.gjcmobile.ui

import android.app.Application
import android.content.Context
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.gajae.gjcmobile.BuildConfig
import dev.gajae.gjcmobile.core.B64Url
import dev.gajae.gjcmobile.core.BridgeClient
import dev.gajae.gjcmobile.core.BridgeException
import dev.gajae.gjcmobile.core.CodeOffer
import dev.gajae.gjcmobile.core.CodePairingFlow
import dev.gajae.gjcmobile.core.CodePairingOutcome
import dev.gajae.gjcmobile.core.STAGE_CONNECTING
import dev.gajae.gjcmobile.core.confirmingStage
import dev.gajae.gjcmobile.core.helloEndpoints
import dev.gajae.gjcmobile.core.DeviceIdentity
import dev.gajae.gjcmobile.core.OkHttpFrameTransport
import dev.gajae.gjcmobile.core.PairedHost
import dev.gajae.gjcmobile.core.PairingOffer
import dev.gajae.gjcmobile.core.pairingAllowed
import dev.gajae.gjcmobile.core.SessionSummary
import dev.gajae.gjcmobile.core.get
import dev.gajae.gjcmobile.core.parseJson
import dev.gajae.gjcmobile.core.str
import dev.gajae.gjcmobile.widget.WidgetStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.util.concurrent.TimeUnit

class AppModel(application: Application) : AndroidViewModel(application) {
    private val store = SecureStore(application)
    private val prefs = application.getSharedPreferences("gjcm_ui", Context.MODE_PRIVATE)
    val device: DeviceIdentity = store.deviceIdentity()
    val deviceName: String = Build.MODEL ?: "Android"
    private val notifier = ActivityNotifier(application)
    private val widget = WidgetStore(application)

    var hosts by mutableStateOf(store.hosts()); private set
    val connections = mutableStateMapOf<String, HostConnection>()
    var selectedHostId by mutableStateOf(hosts.firstOrNull()?.hostId)
    /** A `gjcm://pair` link that arrived by deep link, consumed by the pairing screen once no pairing is running. */
    var pairingUrl by mutableStateOf<String?>(null)
    var showPairing by mutableStateOf(hosts.isEmpty())

    /** gjc TUI Ctrl+T: on shows every reasoning block in full, off folds them to one line. */
    var showThinking by mutableStateOf(prefs.getBoolean("showThinking", false))
        private set

    init {
        hosts.forEach { connections[it.hostId] = makeConnection(it) }
        widget.sync(hosts)
    }

    fun toggleThinking() {
        showThinking = !showThinking
        prefs.edit().putBoolean("showThinking", showThinking).apply()
    }

    val selectedConnection: HostConnection?
        get() = selectedHostId?.let { id -> hosts.firstOrNull { it.hostId == id } }?.let(::connection)

    fun connection(host: PairedHost): HostConnection = connections.getOrPut(host.hostId) { makeConnection(host) }

    private fun makeConnection(host: PairedHost) =
        HostConnection(host, device, deviceName, viewModelScope, notifier, widget) { updated -> update(updated) }

    /** Progress and result of the running pairing live here, not in the screen, so a rotation does not cancel it. */
    var pairWorking by mutableStateOf(false); private set

    /**
     * Progress line of a code pairing: "연결 중" until the host answers, "확인 중 · 남은 시도 n회" while the answer is
     * verified, then "연결 중" again for the hello; null when no code pairing is running.
     */
    var pairStage by mutableStateOf<String?>(null); private set
    var pairError by mutableStateOf<String?>(null)

    /**
     * The pairing screen is opened from the host list. An error the user has not seen yet (the work failed after the
     * screen was closed) stays; one already seen was cleared by [closePairing].
     */
    fun openPairing() {
        showPairing = true
    }

    /** The pairing screen is closed by the user, who has seen its error. */
    fun closePairing() {
        pairError = null
        showPairing = false
    }

    /** An offer a device code delivered whose pairing hello has not succeeded yet; kept in memory for "다시 시도". */
    var codeOffer by mutableStateOf<CodeOffer?>(null); private set

    /** The kept offer would replace a known host's key: the hello waits for the user's approval. */
    var awaitingKeyApproval by mutableStateOf(false); private set

    private val codeFlow = CodePairingFlow({ hosts }, this::pairHello) { codeOffer = it }

    private fun runPairing(stage: String?, step: suspend () -> Unit) {
        if (pairWorking) return
        pairWorking = true
        pairError = null
        pairStage = stage
        viewModelScope.launch {
            try {
                step()
            } catch (e: CancellationException) {
                throw e
            } catch (e: PairingOffer.ParseException) {
                pairError = pairingParseMessage(e)
            } catch (e: Exception) {
                pairError = e.userMessage()
            } finally {
                pairWorking = false
                pairStage = null
                // A link that arrived during the work was left for the screen; keep it open so the link is handled.
                if (pairingUrl != null) showPairing = true
            }
        }
    }

    private fun finish(outcome: CodePairingOutcome) {
        when (outcome) {
            is CodePairingOutcome.Paired -> { awaitingKeyApproval = false; showPairing = false }
            is CodePairingOutcome.ConfirmKeyChange -> awaitingKeyApproval = true
        }
    }

    /** First connection from a QR offer or link: proves the pairing secret, then remembers the host. */
    fun pairWithLink(offerText: String, replaceChangedKey: Boolean = false) = runPairing(null) {
        val offer = PairingOffer.parse(offerText.trim())
        pairHello(offer, helloEndpoints(offer, null), replaceChangedKey)
        showPairing = false
    }

    /**
     * Device-code pairing (gjcm-code-v1, #128): the CPace exchange, then, unless the offer would replace a known
     * host's key (the user must approve that first), the pairing hello. A kept offer survives a failed start; the
     * next verified offer replaces it.
     */
    fun pairWithCode(code: String) = runPairing(STAGE_CONNECTING) {
        val fetched = BridgeClient.pairWithCode(code, onConfirming = { left -> pairStage = confirmingStage(left) })
        pairStage = STAGE_CONNECTING // the host's answer is verified; what is left is the hello
        finish(codeFlow.receive(fetched))
    }

    /** "다시 시도" after the hello failed: the kept offer goes through the same confirmation and hello again. */
    fun retryCodePairing() = runPairing(STAGE_CONNECTING) { finish(codeFlow.retry()) }

    /** The user approved replacing the changed key of the kept offer's host. */
    fun approveCodeKeyChange() = runPairing(STAGE_CONNECTING) {
        awaitingKeyApproval = false
        codeFlow.approveKeyChange()
        showPairing = false
    }

    /** The user cancelled: nothing was saved, and the kept offer is dropped. */
    fun cancelCodePairing() {
        awaitingKeyApproval = false
        pairError = null
        codeFlow.discard()
    }

    /**
     * The pairing hello for a verified offer, dialling [endpoints] in order. The saved host keeps the offer's own
     * endpoint order and remembers the address that worked.
     */
    private suspend fun pairHello(offer: PairingOffer, endpoints: List<String>, replaceChangedKey: Boolean): PairedHost {
        // A known hostId under a different key is replaced only when the user explicitly approved it.
        if (!pairingAllowed(offer, hosts, replaceChangedKey)) {
            throw IllegalStateException(KEY_CHANGED_REFUSED)
        }
        val hostKey = B64Url.decode(offer.hostKey)!!
        val secret = B64Url.decode(offer.secret)!!
        var lastError: Exception = BridgeException.NoReachableEndpoint()
        for (endpoint in endpoints) {
            try {
                val client = BridgeClient.connect(endpoint, device, hostKey, deviceName, pairing = offer.pairingId to secret)
                // Pairing the same host again keeps the directory the user saved for it.
                val saved = hosts.firstOrNull { it.hostId == offer.hostId }?.preferredCwd
                var host = PairedHost(offer).copy(lastEndpoint = endpoint, preferredCwd = saved)
                runCatching { client.hostInfo() }.getOrNull()?.let { host = host.copy(name = it.hostName) }
                update(host)
                connection(host).adopt(client, endpoint, host)
                selectedHostId = host.hostId
                return host
            } catch (e: BridgeException.Rejected) {
                throw e // a rejected pairing will not succeed on another endpoint either
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw lastError
    }

    /** The public review demo host: its `GET /offer` hands out a reusable pairing link. */
    suspend fun demoPairingLink(): String = withContext(Dispatchers.IO) {
        val client = OkHttpFrameTransport.sharedClient.newBuilder().callTimeout(15, TimeUnit.SECONDS).build()
        client.newCall(Request.Builder().url(BuildConfig.DEMO_OFFER_URL).build()).execute().use { response ->
            check(response.code == 200) { "HTTP ${response.code}" }
            parseJson(response.body!!.string())["url"].str ?: error("missing url")
        }
    }

    fun update(host: PairedHost) {
        hosts = if (hosts.any { it.hostId == host.hostId }) hosts.map { if (it.hostId == host.hostId) host else it } else hosts + host
        store.saveHosts(hosts)
        widget.sync(hosts)
    }

    fun forget(host: PairedHost) {
        connections.remove(host.hostId)?.disconnect()
        hosts = hosts.filter { it.hostId != host.hostId }
        store.saveHosts(hosts)
        widget.sync(hosts)
        if (selectedHostId == host.hostId) selectedHostId = hosts.firstOrNull()?.hostId
        if (hosts.isEmpty()) showPairing = true
    }

    /** A widget row (`gjcm://session?host=…&id=…&cwd=…`): switches to that host and opens the chat. */
    fun openSession(hostId: String, sessionId: String, cwd: String) {
        val host = hosts.firstOrNull { it.hostId == hostId } ?: return
        showPairing = false
        selectedHostId = hostId
        val connection = connection(host)
        val summary = connection.sessions.firstOrNull { it.sessionId == sessionId } ?: SessionSummary(sessionId, cwd, null, null, null)
        connection.activeChat = connection.chat(summary)
        connection.ensureConnected()
    }

    fun appBecameActive() {
        connections.values.forEach { it.ensureConnected() }
    }

    override fun onCleared() {
        connections.values.forEach { it.disconnect() }
    }
}

fun Throwable.userMessage(): String = message ?: toString()

const val KEY_CHANGED_REFUSED = "이미 등록된 호스트의 키가 바뀌어 연결하지 않았습니다."

fun pairingParseMessage(e: PairingOffer.ParseException): String = when (e.error) {
    PairingOffer.ParseError.EXPIRED -> "QR 코드가 만료됐습니다. 호스트에서 다시 `gjcm-bridge pair`를 실행하세요."
    PairingOffer.ParseError.UNSUPPORTED_VERSION -> "이 앱보다 새 버전의 브리지입니다. 앱을 업데이트하세요."
    else -> "가재코드 페어링 QR이 아닙니다."
}

const val DEMO_FAILURE = "데모 호스트에 연결하지 못했습니다. 잠시 후 다시 시도하세요."

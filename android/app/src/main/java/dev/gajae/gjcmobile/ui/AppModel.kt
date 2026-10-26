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
import dev.gajae.gjcmobile.core.DeviceIdentity
import dev.gajae.gjcmobile.core.OkHttpFrameTransport
import dev.gajae.gjcmobile.core.PairedHost
import dev.gajae.gjcmobile.core.PairingOffer
import dev.gajae.gjcmobile.core.SessionSummary
import dev.gajae.gjcmobile.core.get
import dev.gajae.gjcmobile.core.parseJson
import dev.gajae.gjcmobile.core.str
import dev.gajae.gjcmobile.widget.WidgetStore
import kotlinx.coroutines.Dispatchers
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
    /** A `gjcm://pair` link that arrived by deep link, consumed by the pairing screen. */
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

    /** First connection from a QR offer: proves the pairing secret, then remembers the host. */
    suspend fun pair(offerText: String): PairedHost {
        val offer = PairingOffer.parse(offerText)
        val hostKey = B64Url.decode(offer.hostKey)!!
        val secret = B64Url.decode(offer.secret)!!
        var lastError: Exception = BridgeException.NoReachableEndpoint()
        for (endpoint in offer.endpoints) {
            try {
                val client = BridgeClient.connect(endpoint, device, hostKey, deviceName, pairing = offer.pairingId to secret)
                var host = PairedHost(offer).copy(lastEndpoint = endpoint)
                runCatching { client.hostInfo() }.getOrNull()?.let { host = host.copy(name = it.hostName) }
                update(host)
                connection(host).adopt(client, endpoint)
                selectedHostId = host.hostId
                return host
            } catch (e: BridgeException.Rejected) {
                throw e // a rejected pairing will not succeed on another endpoint either
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

const val DEMO_FAILURE = "데모 호스트에 연결하지 못했습니다. 잠시 후 다시 시도하세요."

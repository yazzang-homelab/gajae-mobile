package dev.gajae.gjcmobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.gajae.gjcmobile.core.ActivityAlerts
import dev.gajae.gjcmobile.core.BridgeClient
import dev.gajae.gjcmobile.core.BridgeEvent
import dev.gajae.gjcmobile.core.BridgeException
import dev.gajae.gjcmobile.core.DeviceIdentity
import dev.gajae.gjcmobile.core.HostInfo
import dev.gajae.gjcmobile.core.PairedHost
import dev.gajae.gjcmobile.core.PermissionRequest
import dev.gajae.gjcmobile.core.SessionSummary
import dev.gajae.gjcmobile.widget.WidgetStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * Live link to one paired host's bridge. Reconnects with backoff and re-opens visible chats with
 * `afterSeq`, so a phone that slept or changed networks catches up without reloading history.
 * All state is Compose snapshot state mutated on the main dispatcher ([scope]).
 */
class HostConnection(
    host: PairedHost,
    private val device: DeviceIdentity,
    private val deviceName: String,
    private val scope: CoroutineScope,
    private val notifier: ActivityNotifier,
    private val widget: WidgetStore,
    private val onHostChange: (PairedHost) -> Unit,
) {
    sealed class Status {
        data object Idle : Status()
        data object Connecting : Status()
        data object Connected : Status()
        data class Failed(val reason: String) : Status()
    }

    var host by mutableStateOf(host); private set
    var status by mutableStateOf<Status>(Status.Idle); private set
    var info by mutableStateOf<HostInfo?>(null); private set
    var sessions by mutableStateOf<List<SessionSummary>>(emptyList()); private set
    var permissions by mutableStateOf<List<PermissionRequest>>(emptyList()); private set
    var nextCursor by mutableStateOf<String?>(null); private set
    var loadingMore by mutableStateOf(false); private set
    var searchQuery by mutableStateOf(""); private set
    /** The host home's chat (null shows the new-chat composer) and that composer's directory. */
    var activeChat by mutableStateOf<ChatModel?>(null)
    var draftCwd by mutableStateOf<String?>(null)

    private val chats = mutableMapOf<String, ChatModel>()
    private var client: BridgeClient? = null
    private var eventJob: Job? = null
    private var connectJob: Job? = null
    private var retryDelayMs = 1_000L
    private val alerts = ActivityAlerts()
    /** The widget may only record what this connection fully knows: the unfiltered list and every waiting ask. */
    private var listKnown = false
    private var waitingKnown = false
    /** Asks delivered live on this connection: kept when the `permission.list` reply, possibly older, lacks them. */
    private val arrivedSinceAttach = mutableSetOf<String>()

    val connectedClient: BridgeClient? get() = if (status == Status.Connected) client else null

    fun ensureConnected() {
        if (status == Status.Connected || connectJob?.isActive == true) return
        connectJob = scope.launch { connectLoop() }
    }

    fun disconnect() {
        connectJob?.cancel()
        connectJob = null
        eventJob?.cancel()
        client?.close()
        client = null
        status = Status.Idle
    }

    /** Takes over a client that was just created by pairing. */
    fun adopt(client: BridgeClient, endpoint: String) = attach(client, endpoint)

    private suspend fun connectLoop() {
        while (scope.isActive) {
            status = Status.Connecting
            try {
                val (client, endpoint) = BridgeClient.connectAny(host, device, deviceName)
                attach(client, endpoint)
                return
            } catch (e: BridgeException.Rejected) {
                status = Status.Failed(e.userMessage())
                return // unpaired: retrying cannot help
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                status = Status.Failed(e.userMessage())
                delay(retryDelayMs)
                retryDelayMs = minOf(retryDelayMs * 2, 30_000)
            }
        }
    }

    private fun attach(client: BridgeClient, endpoint: String) {
        this.client = client
        status = Status.Connected
        listKnown = false
        waitingKnown = false
        arrivedSinceAttach.clear()
        retryDelayMs = 1_000
        if (host.lastEndpoint != endpoint) {
            host = host.copy(lastEndpoint = endpoint)
            onHostChange(host)
        }
        eventJob?.cancel()
        eventJob = scope.launch { client.events.collect(::handle) }
        scope.launch {
            info = runCatching { client.hostInfo() }.getOrNull()
            // Asks raised while this phone was away are only re-offered inside an opened chat; fetch them all.
            runCatching { client.pendingPermissions() }.onSuccess { pending ->
                val live = permissions.associateBy { it.requestId }
                val listed = pending.map { it.requestId }.toSet()
                // Drops asks remembered from before a disconnect that were settled meanwhile.
                permissions = pending.map { live[it.requestId] ?: it } +
                    permissions.filter { it.requestId in arrivedSinceAttach && it.requestId !in listed }
                pending.forEach { notify(alerts.permission(it)) }
                waitingKnown = true
            }
            refreshSessions()
            chats.values.filter { it.isVisible }.forEach { it.open(client) }
        }
    }

    private fun handle(event: BridgeEvent) {
        when (event) {
            is BridgeEvent.SessionUpdate -> chats[event.sessionId]?.apply(event.update)
            is BridgeEvent.Permission -> {
                permissions = permissions.filter { it.requestId != event.request.requestId } + event.request
                arrivedSinceAttach += event.request.requestId
                chats[event.request.sessionId]?.add(event.request)
                notify(alerts.permission(event.request))
                recordWidget()
            }
            is BridgeEvent.PermissionResolved -> {
                permissions = permissions.filter { it.requestId != event.requestId }
                chats[event.sessionId]?.removePermission(event.requestId)
                notifier.withdrawAsk(event.requestId)
                recordWidget()
            }
            is BridgeEvent.Status -> {
                sessions = sessions.map { if (it.sessionId == event.status.sessionId) it.with(event.status) else it }
                chats[event.status.sessionId]?.apply(event.status)
                notify(alerts.status(event.status.sessionId, event.status.running))
                recordWidget()
            }
            is BridgeEvent.Disconnected -> {
                client = null
                listKnown = false
                waitingKnown = false
                status = Status.Failed(event.reason)
                ensureConnected()
            }
        }
    }

    private fun notify(alert: ActivityAlerts.Alert?) {
        alert ?: return
        notifier.post(alert, sessionLabel(alert.sessionId), host.name)
    }

    private fun sessionLabel(sessionId: String): String {
        chats[sessionId]?.let { return it.title }
        val summary = sessions.firstOrNull { it.sessionId == sessionId } ?: return "세션"
        return summary.title?.takeIf { it.isNotEmpty() } ?: summary.cwd.substringAfterLast('/')
    }

    /** First page of gjc's saved sessions, newest first. */
    suspend fun refreshSessions() {
        val client = connectedClient ?: return
        try {
            val list = client.listSessions(query = searchQuery)
            alerts.sessions(list.sessions).forEach(::notify)
            sessions = list.sessions
            nextCursor = list.nextCursor
            if (searchQuery.isEmpty()) {
                listKnown = true
                recordWidget()
            }
        } catch (e: BridgeException.Disconnected) {
            // the event stream reports the drop and reconnects
        } catch (e: Exception) {
            status = Status.Failed(e.userMessage())
        }
    }

    private fun recordWidget() {
        if (status != Status.Connected || !listKnown || !waitingKnown || searchQuery.isNotEmpty()) return
        widget.observe(host, sessions, permissions)
    }

    /** Server-side title/id/cwd search. */
    suspend fun search(query: String) {
        val trimmed = query.trim()
        if (trimmed == searchQuery) return
        searchQuery = trimmed
        refreshSessions()
    }

    suspend fun loadMoreSessions() {
        val client = connectedClient ?: return
        val cursor = nextCursor ?: return
        if (loadingMore) return
        loadingMore = true
        try {
            val page = client.listSessions(query = searchQuery, cursor = cursor)
            val known = sessions.map { it.sessionId }.toSet()
            alerts.sessions(page.sessions).forEach(::notify)
            sessions = sessions + page.sessions.filter { it.sessionId !in known }
            nextCursor = page.nextCursor
        } catch (e: Exception) {
            status = Status.Failed(e.userMessage())
        } finally {
            loadingMore = false
        }
    }

    /** Deletes the saved session on the host. The bridge refuses while a turn is running. */
    suspend fun delete(sessionId: String) {
        val client = connectedClient ?: throw BridgeException.Disconnected()
        client.deleteSession(sessionId)
        chats.remove(sessionId)
        if (activeChat?.sessionId == sessionId) activeChat = null
        sessions = sessions.filter { it.sessionId != sessionId }
    }

    fun chat(session: SessionSummary): ChatModel =
        chats.getOrPut(session.sessionId) { ChatModel(session.sessionId, session.cwd, session.title, this, scope) }

    suspend fun createSession(cwd: String?): ChatModel {
        val client = connectedClient ?: throw BridgeException.Disconnected()
        val snapshot = client.newSession(cwd?.takeIf { it.isNotEmpty() })
        val chat = ChatModel(snapshot.sessionId, snapshot.cwd, null, this, scope)
        chat.apply(snapshot)
        chats[snapshot.sessionId] = chat
        sessions = listOf(SessionSummary(snapshot.sessionId, snapshot.cwd, null, Instant.now().toString(), false)) + sessions
        return chat
    }

    /** Copies a session (gjc `session/fork`) and returns the open copy. */
    suspend fun fork(sessionId: String, title: String?): ChatModel {
        val client = connectedClient ?: throw BridgeException.Disconnected()
        val snapshot = client.forkSession(sessionId)
        val chat = ChatModel(snapshot.sessionId, snapshot.cwd, title?.let { "$it (포크)" }, this, scope)
        chat.apply(snapshot)
        chats[snapshot.sessionId] = chat
        sessions = listOf(SessionSummary(snapshot.sessionId, snapshot.cwd, chat.title, Instant.now().toString(), false)) + sessions
        return chat
    }

    fun startNewChat(cwd: String?) {
        draftCwd = cwd
        activeChat = null
    }
}

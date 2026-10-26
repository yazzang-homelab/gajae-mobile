package dev.gajae.gjcmobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.gajae.gjcmobile.core.BridgeClient
import dev.gajae.gjcmobile.core.BridgeException
import dev.gajae.gjcmobile.core.BtwConversation
import dev.gajae.gjcmobile.core.ConfigOption
import dev.gajae.gjcmobile.core.ConfigTarget
import dev.gajae.gjcmobile.core.OpenSnapshot
import dev.gajae.gjcmobile.core.PendingAttachment
import dev.gajae.gjcmobile.core.PermissionMode
import dev.gajae.gjcmobile.core.PermissionOption
import dev.gajae.gjcmobile.core.PermissionRequest
import dev.gajae.gjcmobile.core.QueuedMessage
import dev.gajae.gjcmobile.core.QueuedMessages
import dev.gajae.gjcmobile.core.SequencedUpdate
import dev.gajae.gjcmobile.core.SessionStatus
import dev.gajae.gjcmobile.core.SessionTranscript
import dev.gajae.gjcmobile.core.TranscriptItem
import dev.gajae.gjcmobile.core.get
import dev.gajae.gjcmobile.core.promptBlocks
import dev.gajae.gjcmobile.core.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One chat: the folded transcript plus composer state. Mutated on the main dispatcher only. */
class ChatModel(
    val sessionId: String,
    val cwd: String,
    private val initialTitle: String?,
    private val connection: HostConnection,
    private val scope: CoroutineScope,
) {
    private val transcript = SessionTranscript()

    var items by mutableStateOf<List<TranscriptItem>>(emptyList()); private set
    var running by mutableStateOf(false); private set
    var phase by mutableStateOf<String?>(null); private set
    var configOptions by mutableStateOf<List<ConfigOption>>(emptyList()); private set
    private var transcriptTitle by mutableStateOf<String?>(null)
    var permissions by mutableStateOf<List<PermissionRequest>>(emptyList()); private set
    var loading by mutableStateOf(false); private set
    var sending by mutableStateOf(false); private set
    var uploadProgress by mutableStateOf<Double?>(null); private set
    /** Steers and follow-ups this phone sent during the current turn. */
    private var sentQueue by mutableStateOf<List<QueuedMessage>>(emptyList())
    /** gjc's own queue from `session.status`, including steers typed in the TUI; `null` until the bridge reports one. */
    private var hostQueue by mutableStateOf<List<QueuedMessage>?>(null)
    /** When the last report arrived: the clock the grace period runs on, so each report (once a second) recomposes. */
    private var hostQueueAtMs by mutableStateOf(0L)
    val queued: List<QueuedMessage> get() = QueuedMessages.merge(sentQueue, hostQueue, hostQueueAtMs)
    var fastMode by mutableStateOf<Boolean?>(null); private set
    var permissionMode by mutableStateOf<PermissionMode?>(null); private set
    /** Typing `/btw ` pops the composer out into the side-chat bubble, carrying what follows. */
    private var draftState by mutableStateOf("")
    var draft: String
        get() = draftState
        set(value) {
            val rest = if (attachments.isEmpty()) BtwConversation.trigger(value) else null
            if (rest == null) {
                draftState = value
            } else {
                draftState = ""
                openBtw()
                btwDraft = rest
            }
        }

    /** `/btw` side chat shown as a floating bubble; `null` when closed. Never written to the transcript. */
    var btw by mutableStateOf<BtwConversation?>(null); private set
    var btwDraft by mutableStateOf("")
    /** Bumped on every open/close so an answer that arrives after the bubble closed is dropped. */
    private var btwEpoch = 0
    var attachments by mutableStateOf<List<PendingAttachment>>(emptyList())
    var errorMessage by mutableStateOf<String?>(null)
    var isVisible = false

    val title: String get() = transcriptTitle ?: initialTitle ?: "새 세션"
    val connected: Boolean get() = connection.connectedClient != null
    val hasQueuedSteer: Boolean get() = queued.any { !it.followUp }
    val canSend: Boolean
        get() {
            if (sending || !connected) return false
            val text = draft.isNotBlank()
            return if (running) text && attachments.isEmpty() else text || attachments.isNotEmpty()
        }

    fun configOption(target: ConfigTarget): ConfigOption? = configOptions.firstOrNull(target::matches)

    private fun publish() {
        items = transcript.items
        running = transcript.running
        phase = transcript.phase
        configOptions = transcript.configOptions
        transcriptTitle = transcript.title
        permissionMode = transcript.permissionMode
    }

    // Session lifecycle

    suspend fun open(using: BridgeClient? = null) {
        val client = using ?: connection.connectedClient ?: return
        loading = items.isEmpty()
        try {
            apply(client.openSession(sessionId, cwd, transcript.lastSeq))
        } catch (e: Exception) {
            show(e)
        } finally {
            loading = false
        }
    }

    /**
     * The bridge answers -32002 when gjc dropped this process's attachment to the session. Reopen once
     * and retry instead of surfacing "SDK session attachment is stale".
     */
    private suspend fun <T> reopening(client: BridgeClient, body: suspend () -> T): T = try {
        body()
    } catch (e: BridgeException.Remote) {
        if (e.code != -32002) throw e
        apply(client.openSession(sessionId, cwd, transcript.lastSeq))
        body()
    }

    fun apply(snapshot: OpenSnapshot) {
        transcript.apply(snapshot)
        permissions = snapshot.permissions
        publish()
    }

    fun apply(update: SequencedUpdate) {
        transcript.apply(update)
        if (update.update["sessionUpdate"].str == "x_gjcm_turn_end") {
            sentQueue = emptyList()
            hostQueue = hostQueue?.let { emptyList() }
        }
        publish()
    }

    fun apply(status: SessionStatus) {
        val queue = status.queued ?: return
        hostQueue = queue
        hostQueueAtMs = System.currentTimeMillis()
    }

    fun add(permission: PermissionRequest) {
        permissions = permissions.filter { it.requestId != permission.requestId } + permission
    }

    fun removePermission(requestId: String) {
        permissions = permissions.filter { it.requestId != requestId }
    }

    fun leave() {
        isVisible = false
        val client = connection.connectedClient ?: return
        scope.launch { runCatching { client.closeSession(sessionId) } }
    }

    // Composer

    /** Sends the draft on the model's own scope: the composer that triggered it may leave composition right away
     *  (the new-chat screen swaps to this chat), and a composition-scoped send would be cancelled mid-request. */
    fun launchSubmit() {
        scope.launch { submit() }
    }

    /** Sends the draft; while a turn runs, text steers the turn. */
    suspend fun submit() {
        if (running) steer(followUp = false) else send()
    }

    private suspend fun send() {
        val client = connection.connectedClient ?: return
        if (!canSend) return
        sending = true
        errorMessage = null
        val text = draft
        val files = attachments
        try {
            val blocks = client.promptBlocks(text, files, sessionId) { f -> scope.launch { uploadProgress = f } }
            reopening(client) { client.prompt(sessionId, blocks) }
            transcript.markRunning()
            publish()
            draft = ""
            attachments = emptyList()
        } catch (e: Exception) {
            show(e)
        } finally {
            sending = false
            uploadProgress = null
        }
    }

    /** `turn.steer` reaches the model at its next step; `turn.follow_up` waits for the turn to end. */
    suspend fun steer(followUp: Boolean) {
        val text = draft.trim()
        val client = connection.connectedClient ?: return
        if (!running || text.isEmpty()) return
        sending = true
        try {
            reopening(client) {
                client.sdkControl(sessionId, if (followUp) "turn.follow_up" else "turn.steer", buildJsonObject { put("text", text) })
            }
            draft = ""
            sentQueue = sentQueue + QueuedMessage(text, followUp, System.currentTimeMillis())
            transcript.appendNotice(if (followUp) "턴이 끝나면 보낼 메시지를 대기열에 넣었습니다." else "진행 중인 턴에 지시를 끼워 넣었습니다.")
            publish()
        } catch (e: Exception) {
            show(e)
        } finally {
            sending = false
        }
    }

    /** "끼어들기": stop the turn now and send the waiting steers. */
    suspend fun interrupt() {
        val client = connection.connectedClient ?: return
        if (!running || !hasQueuedSteer) return
        sending = true
        try {
            reopening(client) { client.interrupt(sessionId) }
            dropSteers()
            transcript.appendNotice("진행 중인 턴을 중단하고 대기 중인 지시를 바로 보냈습니다.")
            publish()
        } catch (e: BridgeException.Remote) {
            if (e.code == -32005) {
                dropSteers()
                transcript.appendNotice("대기 중인 지시는 이미 모델에 전달됐습니다.")
                publish()
            } else {
                show(e)
            }
        } catch (e: Exception) {
            show(e)
        } finally {
            sending = false
        }
    }

    private fun dropSteers() {
        sentQueue = sentQueue.filter { it.followUp }
        hostQueue = hostQueue?.filter { it.followUp }
    }

    suspend fun cancel() {
        val client = connection.connectedClient ?: return
        runCatching { client.cancel(sessionId) }
    }

    suspend fun respond(request: PermissionRequest, option: PermissionOption?) {
        val client = connection.connectedClient ?: return
        try {
            client.respondPermission(request.requestId, option?.optionId)
            removePermission(request.requestId)
        } catch (e: Exception) {
            show(e)
        }
    }

    /** Session-only change (gjc's ACP config option). */
    suspend fun setConfig(target: ConfigTarget, value: String) {
        val client = connection.connectedClient ?: return
        val option = configOption(target) ?: return
        try {
            transcript.setConfigOptions(reopening(client) { client.setConfig(sessionId, option.id, value) })
            publish()
        } catch (e: Exception) {
            show(e)
        }
    }

    suspend fun setFast(on: Boolean) {
        val client = connection.connectedClient ?: return
        sending = true
        try {
            reopening(client) {
                client.sdkControl(sessionId, "service_tier.set", buildJsonObject { put("tier", if (on) "priority" else "none") })
            }
            fastMode = on
            transcript.appendNotice(if (on) "우선 처리 티어를 켰습니다." else "우선 처리 티어를 껐습니다.")
            publish()
        } catch (e: Exception) {
            show(e)
        } finally {
            sending = false
        }
    }

    /** The session menu's permission-mode item: each tap moves to the next mode (prompt → allow → deny). */
    suspend fun cyclePermissionMode() {
        val current = permissionMode ?: return
        val client = connection.connectedClient ?: return
        val mode = current.next
        sending = true
        try {
            // The bridge's x_gjcm_permission_mode update moves the menu label, here and on other phones.
            reopening(client) { client.setPermissionMode(sessionId, mode) }
            transcript.appendNotice("권한모드를 '${mode.label}'(으)로 바꿨습니다.")
            publish()
        } catch (e: Exception) {
            show(e)
        } finally {
            sending = false
        }
    }

    suspend fun deleteSelf() {
        try {
            connection.delete(sessionId)
            connection.startNewChat(cwd)
        } catch (e: Exception) {
            show(e)
        }
    }

    // /btw side chat

    fun openBtw() {
        if (btw != null) return
        btw = BtwConversation()
        btwEpoch++
    }

    fun closeBtw() {
        btw = null
        btwDraft = ""
        btwEpoch++
    }

    /** Sends the bubble's draft on the model's own scope (the bubble may close mid-request). */
    fun launchAskBtw() {
        scope.launch { askBtw() }
    }

    suspend fun askBtw() {
        val conversation = btw ?: return
        val client = connection.connectedClient ?: return
        val asked = conversation.ask(btwDraft)
        if (asked is BtwConversation.Asked.Rejected) {
            errorMessage = asked.rejection.message
            return
        }
        asked as BtwConversation.Asked.Accepted
        btw = asked.conversation
        btwDraft = ""
        val epoch = btwEpoch
        try {
            val result = reopening(client) { client.sdkControl(sessionId, "turn.btw", asked.input) }
            if (epoch == btwEpoch) btw = btw?.finish(result)
        } catch (e: Exception) {
            if (epoch == btwEpoch) btw = btw?.fail(e.userMessage())
        }
    }

    /** Forks this session and opens the copy with the side chat as its draft, so it can be continued there. */
    fun launchForkBtw() {
        val conversation = btw?.takeIf { it.hasAnswer && !it.isPending } ?: return
        scope.launch {
            sending = true
            try {
                val forked = connection.fork(sessionId, title)
                forked.draft = conversation.forkDraft
                closeBtw()
                connection.activeChat = forked
            } catch (e: Exception) {
                show(e)
            } finally {
                sending = false
            }
        }
    }

    val lastAgentText: String?
        get() = items.asReversed().firstNotNullOfOrNull { (it.kind as? TranscriptItem.Kind.Agent)?.text?.takeIf(String::isNotEmpty) }

    fun notice(text: String) {
        transcript.appendNotice(text)
        publish()
    }

    private fun show(error: Throwable) {
        errorMessage = error.userMessage()
    }
}

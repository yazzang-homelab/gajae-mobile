package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.JsonElement

/** One rendered row of a chat. */
data class TranscriptItem(val id: String, val kind: Kind) {
    sealed class Kind {
        data class User(val text: String, val attachments: List<Attachment>) : Kind()
        data class Agent(val text: String) : Kind()
        data class Thought(val text: String) : Kind()
        data class Tool(val call: ToolCall) : Kind()
        data class Plan(val entries: List<PlanEntry>) : Kind()
        data class TurnEnded(val stopReason: String, val error: String?) : Kind()
        data class Notice(val text: String) : Kind()
    }
}

data class Attachment(val name: String, val kind: Kind) {
    sealed class Kind {
        data class Image(val mimeType: String, val base64: String) : Kind()
        data class File(val uri: String, val mimeType: String?, val size: Int?) : Kind()
        data class EmbeddedText(val uri: String) : Kind()
    }
}

data class ToolCall(
    val toolCallId: String,
    val title: String,
    val kind: String?,
    val status: String,
    val rawInput: JsonElement?,
    val output: String,
) {
    val isFinished: Boolean get() = status == "completed" || status == "failed"
}

data class PlanEntry(val content: String, val status: String, val priority: String?)

/**
 * Folds the bridge's sequenced ACP `session/update` stream into chat rows (port of the Swift
 * `SessionTranscript`). Deterministic: the same updates always yield the same transcript.
 */
class SessionTranscript {
    private val rows = mutableListOf<TranscriptItem>()
    val items: List<TranscriptItem> get() = rows.toList()
    var lastSeq = 0; private set
    var running = false; private set
    var title: String? = null; private set
    var phase: String? = null; private set
    var configOptions: List<ConfigOption> = emptyList(); private set
    var availableCommands: List<String> = emptyList(); private set
    /** `null` until the bridge reports one (older bridges cannot switch it). */
    var permissionMode: PermissionMode? = null; private set

    private val toolIndex = mutableMapOf<String, Int>()
    private var counter = 0

    private fun clear() {
        rows.clear(); toolIndex.clear(); counter = 0
        lastSeq = 0; running = false; title = null; phase = null
        configOptions = emptyList(); availableCommands = emptyList(); permissionMode = null
    }

    /** Applies an open snapshot (resets when the bridge says the client's view is stale). */
    fun apply(snapshot: OpenSnapshot) {
        if (snapshot.reset) clear()
        configOptions = snapshot.configOptions
        snapshot.updates.forEach(::apply)
        running = snapshot.running
        PermissionMode.of(snapshot.permissionMode)?.let { permissionMode = it }
    }

    fun setConfigOptions(options: List<ConfigOption>) { configOptions = options }

    /** Marks a locally submitted turn as running until the bridge's turn-end arrives. */
    fun markRunning() { running = true }

    /** A phone-side status row. Not part of the gjc history; a reset drops it. */
    fun appendNotice(text: String) = push(TranscriptItem.Kind.Notice(text))

    fun apply(entry: SequencedUpdate) {
        if (entry.seq <= lastSeq) return // snapshot/live overlap
        lastSeq = entry.seq
        val u = entry.update
        when (u["sessionUpdate"].str ?: "") {
            "user_message_chunk" -> appendUser(u["content"])
            "agent_message_chunk" -> appendStreaming(u["content"]["text"].str ?: "", thought = false)
            "agent_thought_chunk" -> appendStreaming(u["content"]["text"].str ?: "", thought = true)
            "tool_call", "tool_call_update" -> mergeTool(u)
            "plan" -> {
                val entries = u["entries"].array.orEmpty().map {
                    PlanEntry(it["content"].str ?: "", it["status"].str ?: "pending", it["priority"].str)
                }
                if (rows.lastOrNull()?.kind is TranscriptItem.Kind.Plan) {
                    rows[rows.lastIndex] = rows.last().copy(kind = TranscriptItem.Kind.Plan(entries))
                } else {
                    push(TranscriptItem.Kind.Plan(entries))
                }
            }
            "session_info_update" -> {
                u["title"].str?.let { title = it }
                u["_meta"]["gjcPhase"].str?.let { phase = it }
                u["_meta"]["running"].bool?.let { running = it }
            }
            "config_option_update" -> u["configOptions"]?.let { configOptions = ConfigOption.list(it) }
            "available_commands_update" -> availableCommands = u["availableCommands"].array.orEmpty().mapNotNull { it["name"].str }
            "x_gjcm_turn_end" -> {
                running = false
                phase = "idle"
                val reason = u["stopReason"].str ?: "end_turn"
                if (reason != "end_turn") push(TranscriptItem.Kind.TurnEnded(reason, u["error"].str))
                for (index in toolIndex.values) {
                    val call = (rows[index].kind as? TranscriptItem.Kind.Tool)?.call ?: continue
                    if (call.isFinished) continue
                    rows[index] = rows[index].copy(kind = TranscriptItem.Kind.Tool(call.copy(status = if (reason == "end_turn") "completed" else "failed")))
                }
            }
            "x_gjcm_permission_mode" -> PermissionMode.of(u["mode"].str)?.let { permissionMode = it }
            "x_gjcm_agent_exit" -> {
                running = false
                push(TranscriptItem.Kind.Notice("호스트의 gjc 프로세스가 종료됐습니다. 다음 요청 때 다시 시작합니다."))
            }
        }
    }

    private fun push(kind: TranscriptItem.Kind) {
        counter += 1
        rows.add(TranscriptItem("i$counter", kind))
    }

    private fun lastPathComponent(uri: String) = uri.trimEnd('/').substringAfterLast('/').ifEmpty { uri }

    private fun appendUser(content: JsonElement?) {
        content ?: return
        var text = ""
        val attachments = mutableListOf<Attachment>()
        when (content["type"].str) {
            "text" -> text = content["text"].str ?: ""
            "image" -> attachments += Attachment("이미지", Attachment.Kind.Image(content["mimeType"].str ?: "image/png", content["data"].str ?: ""))
            "resource_link" -> {
                val uri = content["uri"].str ?: ""
                attachments += Attachment(
                    content["name"].str ?: lastPathComponent(uri),
                    Attachment.Kind.File(uri, content["mimeType"].str, content["size"].int),
                )
            }
            "resource" -> {
                val uri = content["resource"]["uri"].str ?: ""
                attachments += Attachment(lastPathComponent(uri), Attachment.Kind.EmbeddedText(uri))
            }
            else -> return
        }
        val last = rows.lastOrNull()?.kind as? TranscriptItem.Kind.User
        if (last != null) {
            val joined = if (last.text.isEmpty() || text.isEmpty()) last.text + text else last.text + "\n" + text
            rows[rows.lastIndex] = rows.last().copy(kind = TranscriptItem.Kind.User(joined, last.attachments + attachments))
        } else {
            push(TranscriptItem.Kind.User(text, attachments))
        }
    }

    private fun appendStreaming(chunk: String, thought: Boolean) {
        val last = rows.lastOrNull()?.kind
        when {
            !thought && last is TranscriptItem.Kind.Agent ->
                rows[rows.lastIndex] = rows.last().copy(kind = TranscriptItem.Kind.Agent(last.text + chunk))
            thought && last is TranscriptItem.Kind.Thought ->
                rows[rows.lastIndex] = rows.last().copy(kind = TranscriptItem.Kind.Thought(last.text + chunk))
            else -> push(if (thought) TranscriptItem.Kind.Thought(chunk) else TranscriptItem.Kind.Agent(chunk))
        }
    }

    private fun mergeTool(u: JsonElement) {
        val id = u["toolCallId"].str ?: return
        val index = toolIndex[id]
        var call = (index?.let { rows[it].kind as? TranscriptItem.Kind.Tool })?.call
            ?: ToolCall(id, "도구", null, "pending", null, "")
        u["title"].str?.let { call = call.copy(title = it) }
        u["kind"].str?.let { call = call.copy(kind = it) }
        u["status"].str?.let { call = call.copy(status = it) }
        u["rawInput"]?.let { call = call.copy(rawInput = it) }
        u["content"].array?.let { content ->
            val texts = content.mapNotNull { it["content"]["text"].str ?: it["text"].str }
            if (texts.isNotEmpty()) call = call.copy(output = texts.joinToString("\n"))
        }
        if (index != null) {
            rows[index] = rows[index].copy(kind = TranscriptItem.Kind.Tool(call))
        } else {
            push(TranscriptItem.Kind.Tool(call))
            toolIndex[id] = rows.lastIndex
        }
    }
}

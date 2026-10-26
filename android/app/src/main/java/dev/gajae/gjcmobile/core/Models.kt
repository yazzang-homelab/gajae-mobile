package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.time.Instant

// Bridge RPC payloads (bridge/src/server.ts `dispatch`), parsed leniently from JSON trees.

data class HostInfo(val hostName: String, val defaultCwd: String, val bridgeVersion: String) {
    companion object {
        fun from(json: JsonElement) = HostInfo(
            hostName = json["hostName"].str ?: "",
            defaultCwd = json["defaultCwd"].str ?: "",
            bridgeVersion = json["bridgeVersion"].str ?: "",
        )
    }
}

data class SessionSummary(
    val sessionId: String,
    val cwd: String,
    val title: String?,
    val updatedAt: String?,
    val running: Boolean?,
    /** Bridge estimate of output tokens/s: live while running, the last turn's average when idle. */
    val tokensPerSecond: Double? = null,
) {
    fun with(status: SessionStatus) = copy(running = status.running, tokensPerSecond = status.tokensPerSecond)

    val updatedInstant: Instant? get() = updatedAt?.let(::parseInstant)

    companion object {
        fun from(json: JsonElement): SessionSummary? {
            return SessionSummary(
            sessionId = json["sessionId"].str ?: return null,
            cwd = json["cwd"].str ?: "",
            title = json["title"].str,
            updatedAt = json["updatedAt"].str,
            running = json["running"].bool,
            tokensPerSecond = json["tokensPerSecond"].double,
        )
        }
    }
}

/** `session.status` event: a session started or stopped working, or (once a second while working) its rate. */
data class SessionStatus(
    val sessionId: String,
    val running: Boolean,
    val tokensPerSecond: Double?,
    /** gjc's waiting steers and follow-ups from whichever client queued them; `null` from a bridge that does not report them. */
    val queued: List<QueuedMessage>? = null,
) {
    companion object {
        fun from(json: JsonElement): SessionStatus? {
            return SessionStatus(
            sessionId = json["sessionId"].str ?: return null,
            running = json["running"].bool ?: return null,
            tokensPerSecond = json["tokensPerSecond"].double,
            queued = json["queued"].array?.mapNotNull(QueuedMessage::from),
        )
        }
    }
}

data class SessionList(val sessions: List<SessionSummary>, val nextCursor: String?) {
    companion object {
        fun from(json: JsonElement) = SessionList(
            sessions = json["sessions"].array.orEmpty().mapNotNull(SessionSummary::from),
            nextCursor = json["nextCursor"].str,
        )
    }
}

/** ACP session config option (mode, model, thinking, …). `options` may arrive flat or grouped. */
data class ConfigOption(
    val id: String,
    val name: String,
    val category: String?,
    val type: String?,
    val currentValue: JsonElement?,
    val choices: List<Choice>,
) {
    data class Choice(val value: String, val name: String, val group: String?)

    val currentChoiceName: String?
        get() {
            val current = currentValue.str ?: return currentValue.bool?.let { if (it) "on" else "off" }
            return choices.firstOrNull { it.value == current }?.name ?: current
        }

    companion object {
        fun from(json: JsonElement): ConfigOption? {
            val id = json["id"].str ?: return null
            val choices = json["options"].array.orEmpty().flatMap { item ->
                val nested = item["options"].array
                if (nested != null) {
                    val group = item["name"].str ?: item["group"].str
                    nested.mapNotNull { choice(it, group) }
                } else {
                    listOfNotNull(choice(item, null))
                }
            }
            return ConfigOption(id, json["name"].str ?: id, json["category"].str, json["type"].str, json["currentValue"], choices)
        }

        fun list(json: JsonElement?): List<ConfigOption> = json.array.orEmpty().mapNotNull(::from)

        private fun choice(json: JsonElement, group: String?): Choice? {
            val value = json["value"].str ?: return null
            return Choice(value, json["name"].str ?: value, group)
        }
    }
}

/** gjc's ACP config option ids/categories (`model`, `thinking`/`thought_level`, `mode`). */
enum class ConfigTarget(val label: String) {
    MODEL("모델"), THINKING("추론 강도"), MODE("모드");

    fun matches(option: ConfigOption): Boolean = when (this) {
        MODEL -> option.id == "model" || option.category == "model"
        THINKING -> option.id == "thinking" || option.category == "thought_level"
        MODE -> option.id == "mode" || option.category == "mode"
    }
}

data class SequencedUpdate(val seq: Int, val update: JsonElement)

data class PermissionOption(val optionId: String, val name: String, val kind: String) {
    val isAllow: Boolean get() = kind.startsWith("allow")
}

data class PermissionRequest(
    val requestId: String,
    val sessionId: String,
    val toolCall: JsonElement,
    val options: List<PermissionOption>,
) {
    val title: String get() = toolCall["title"].str ?: toolCall["toolName"].str ?: "도구 실행"
    val detail: String?
        get() = toolCall["rawInput"]["command"].str ?: toolCall["rawInput"]?.prettyText

    companion object {
        fun from(json: JsonElement): PermissionRequest? {
            return PermissionRequest(
            requestId = json["requestId"].str ?: return null,
            sessionId = json["sessionId"].str ?: return null,
            toolCall = json["toolCall"] ?: JsonObject(emptyMap()),
            options = json["options"].array.orEmpty().mapNotNull { o ->
                PermissionOption(o["optionId"].str ?: return@mapNotNull null, o["name"].str ?: "", o["kind"].str ?: "")
            },
        )
        }
    }
}

data class OpenSnapshot(
    val sessionId: String,
    val cwd: String,
    val configOptions: List<ConfigOption>,
    val running: Boolean,
    val seq: Int,
    val reset: Boolean,
    val updates: List<SequencedUpdate>,
    val permissions: List<PermissionRequest>,
    /** Raw [PermissionMode] value; absent from bridges without `session.setPermissionMode`. */
    val permissionMode: String? = null,
) {
    companion object {
        fun from(json: JsonElement): OpenSnapshot = OpenSnapshot(
            sessionId = json["sessionId"].str ?: throw BridgeException.ProtocolViolation("snapshot without sessionId"),
            cwd = json["cwd"].str ?: "",
            configOptions = ConfigOption.list(json["configOptions"]),
            running = json["running"].bool ?: false,
            seq = json["seq"].int ?: 0,
            reset = json["reset"].bool ?: false,
            updates = json["updates"].array.orEmpty().mapNotNull { u ->
                val seq = u["seq"].int ?: return@mapNotNull null
                SequencedUpdate(seq, u["update"] ?: return@mapNotNull null)
            },
            permissions = json["permissions"].array.orEmpty().mapNotNull(PermissionRequest::from),
            permissionMode = json["permissionMode"].str,
        )
    }
}

/** gjc's per-session policy for guarded tools (bash, eval, delete, move), switched from the session menu. */
enum class PermissionMode(val wire: String, val label: String) {
    /** Ask on the phone before each guarded tool call (the ACP default). */
    Prompt("prompt", "매번 묻기"),
    /** Run guarded tools without asking. */
    Allow("allow", "자동 허용"),
    /** Reject guarded tools without asking. */
    Deny("deny", "모두 거부");

    /** The mode a tap on the menu item switches to: prompt → allow → deny → prompt. */
    val next: PermissionMode get() = entries[(ordinal + 1) % entries.size]

    companion object {
        fun of(wire: String?): PermissionMode? = entries.firstOrNull { it.wire == wire }
    }
}

/** gjc model selector `provider/model[:thinking]`. */
data class ModelSelector(val model: String, val thinking: String?) {
    val raw: String get() = thinking?.let { "$model:$it" } ?: model

    companion object {
        val thinkingLevels = listOf("inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max")

        fun of(model: String, thinking: String?) = ModelSelector(model, thinking?.takeUnless { it.isEmpty() || it == "inherit" })

        fun parse(raw: String): ModelSelector {
            val colon = raw.lastIndexOf(':')
            if (colon >= 0 && raw.substring(colon + 1) in thinkingLevels) return of(raw.substring(0, colon), raw.substring(colon + 1))
            return of(raw, null)
        }
    }
}

sealed class BridgeEvent {
    data class SessionUpdate(val sessionId: String, val update: SequencedUpdate) : BridgeEvent()
    data class Permission(val request: PermissionRequest) : BridgeEvent()
    data class PermissionResolved(val requestId: String, val sessionId: String) : BridgeEvent()
    data class Status(val status: SessionStatus) : BridgeEvent()
    data class Disconnected(val reason: String) : BridgeEvent()

    companion object {
        fun parse(name: String, payload: JsonElement?): BridgeEvent? = when (name) {
            "session.update" -> {
                val sid = payload["sessionId"].str
                val seq = payload["seq"].int
                val update = payload["update"]
                if (sid != null && seq != null && update != null) SessionUpdate(sid, SequencedUpdate(seq, update)) else null
            }
            "permission.request" -> payload?.let(PermissionRequest::from)?.let(::Permission)
            "permission.resolved" -> {
                val rid = payload["requestId"].str
                val sid = payload["sessionId"].str
                if (rid != null && sid != null) PermissionResolved(rid, sid) else null
            }
            "session.status" -> payload?.let(SessionStatus::from)?.let(::Status)
            else -> null
        }
    }
}

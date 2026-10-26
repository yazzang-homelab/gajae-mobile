package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Duration
import java.time.Instant

/**
 * One paired host as the home-screen widget last saw it. The app writes it (live connection or background
 * refresh); the widget only reads it. It never holds question or command text, only counts, labels and times.
 * Mirrors `WidgetSnapshot.swift`.
 */
data class WidgetHost(
    val hostId: String,
    val name: String,
    /** Last time the app had the full picture (session list and pending asks) over a live connection; null = never. */
    val observedAt: Instant?,
    val sessions: List<WidgetSession>,
) {
    fun toJson(): JsonElement = buildJsonObject {
        put("hostId", hostId)
        put("name", name)
        put("observedAt", observedAt?.toString()?.let(::JsonPrimitive) ?: JsonNull)
        put("sessions", JsonArray(sessions.map { it.toJson() }))
    }

    companion object {
        /** Sessions that ended longer ago than this drop out of the widget. */
        val ENDED_MEMORY: Duration = Duration.ofHours(12)
        const val MAX_SESSIONS = 12

        fun unobserved(hostId: String, name: String) = WidgetHost(hostId, name, null, emptyList())

        /**
         * The host as seen right now. A session that was working at [previous] and is idle now ended between the two
         * observations; [now] is the latest time it can have ended.
         */
        fun observe(
            previous: WidgetHost?,
            hostId: String,
            name: String,
            sessions: List<SessionSummary>,
            waiting: List<PermissionRequest>,
            now: Instant,
        ): WidgetHost {
            val waitingBySession = waiting.groupingBy { it.sessionId }.eachCount()
            val before = previous?.sessions.orEmpty().associateBy { it.sessionId }
            val listed = sessions.map { summary ->
                val running = summary.running == true
                val prior = before[summary.sessionId]
                WidgetSession(
                    sessionId = summary.sessionId,
                    cwd = summary.cwd,
                    label = summary.title?.takeIf { it.isNotBlank() } ?: summary.cwd.substringAfterLast('/').ifEmpty { "세션" },
                    running = running,
                    waiting = waitingBySession[summary.sessionId] ?: 0,
                    endedAt = when {
                        running -> null
                        prior?.running == true -> now
                        else -> prior?.endedAt
                    },
                )
            }
            val listedIds = listed.map { it.sessionId }.toSet()
            // An ask in a session past the first page of the list still counts.
            val unlisted = waitingBySession.filterKeys { it !in listedIds }.map { (sessionId, count) ->
                before[sessionId]?.copy(waiting = count, running = true, endedAt = null)
                    ?: WidgetSession(sessionId, "", "세션", running = true, waiting = count, endedAt = null)
            }
            val kept = (unlisted + listed).filter {
                it.waiting > 0 || it.running || (it.endedAt != null && Duration.between(it.endedAt, now) < ENDED_MEMORY)
            }
            return WidgetHost(hostId, name, now, kept.take(MAX_SESSIONS))
        }

        fun from(json: JsonElement): WidgetHost? {
            return WidgetHost(
                hostId = json["hostId"].str ?: return null,
                name = json["name"].str ?: "",
                observedAt = json["observedAt"].str?.let(::parseInstant),
                sessions = json["sessions"].array.orEmpty().mapNotNull(WidgetSession::from),
            )
        }

        fun list(text: String?): List<WidgetHost> =
            text?.let { runCatching { parseJson(it).array.orEmpty().mapNotNull(::from) }.getOrNull() }.orEmpty()

        fun encode(hosts: List<WidgetHost>): String = JsonArray(hosts.map { it.toJson() }).encode()
    }
}

data class WidgetSession(
    val sessionId: String,
    /** Only for opening the chat from the widget; never displayed. */
    val cwd: String,
    val label: String,
    val running: Boolean,
    /** Pending asks and tool approvals. */
    val waiting: Int,
    /** When the app saw this session go from working to idle; null when it never saw it working. */
    val endedAt: Instant?,
) {
    fun toJson(): JsonElement = buildJsonObject {
        put("sessionId", sessionId)
        put("cwd", cwd)
        put("label", label)
        put("running", running)
        put("waiting", waiting)
        put("endedAt", endedAt?.toString()?.let(::JsonPrimitive) ?: JsonNull)
    }

    companion object {
        fun from(json: JsonElement): WidgetSession? {
            return WidgetSession(
                sessionId = json["sessionId"].str ?: return null,
                cwd = json["cwd"].str ?: "",
                label = json["label"].str ?: "세션",
                running = json["running"].bool ?: false,
                waiting = json["waiting"].int ?: 0,
                endedAt = json["endedAt"].str?.let(::parseInstant),
            )
        }
    }
}

/**
 * What the widget draws. A host whose last observation is older than [STALE_AFTER] (or that was never observed)
 * contributes no counts: its old "0 waiting" or "working" would read as current, so it turns into "확인 필요".
 */
data class WidgetState(
    val paired: Boolean,
    /** Waiting asks/approvals on hosts seen recently. A lower bound when [needsCheck]. */
    val waiting: Int,
    val running: Int,
    val needsCheck: Boolean,
    /** The oldest observation among hosts that have one; null when no host was ever observed. */
    val observedAt: Instant?,
    val rows: List<Row>,
) {
    enum class Kind { WAITING, UNCONFIRMED, RUNNING, ENDED }

    data class Row(
        val hostId: String,
        val hostName: String,
        val sessionId: String,
        val cwd: String,
        val label: String,
        val kind: Kind,
        val waiting: Int,
        /** Observation time for WAITING/RUNNING/UNCONFIRMED, end time for ENDED. */
        val at: Instant?,
    )

    /** Big status line: what to do, never a reassuring number that may be stale. */
    val headline: String
        get() = when {
            !paired -> "연결된 컴퓨터 없음"
            waiting > 0 -> "응답 대기 $waiting"
            needsCheck -> "확인 필요"
            running > 0 -> "작업 중 $running"
            else -> "대기 없음"
        }

    /** One line for the lock screen and small widget footer: no session names. */
    fun summary(now: Instant): String {
        if (!paired) return headline
        val age = observedAt?.let { age(it, now) } ?: "확인 안 됨"
        val parts = buildList {
            if (waiting > 0) add("대기 $waiting")
            if (needsCheck) add("확인 필요") else if (running > 0) add("작업중 $running") else if (waiting == 0) add("대기 없음")
            add(age)
        }
        return parts.joinToString(" · ")
    }

    companion object {
        val STALE_AFTER: Duration = Duration.ofMinutes(15)

        fun present(hosts: List<WidgetHost>, now: Instant, maxRows: Int = 6): WidgetState {
            var waiting = 0
            var running = 0
            var needsCheck = false
            val rows = mutableListOf<Row>()
            for (host in hosts) {
                val observed = host.observedAt
                val fresh = observed != null && Duration.between(observed, now) <= STALE_AFTER
                if (!fresh) needsCheck = true
                for (s in host.sessions) {
                    val kind = when {
                        s.waiting > 0 || s.running -> if (fresh) (if (s.waiting > 0) Kind.WAITING else Kind.RUNNING) else Kind.UNCONFIRMED
                        s.endedAt != null -> Kind.ENDED
                        else -> continue
                    }
                    if (kind == Kind.WAITING) waiting += s.waiting
                    if (fresh && s.running && s.waiting == 0) running += 1
                    rows += Row(host.hostId, host.name, s.sessionId, s.cwd, s.label, kind, s.waiting, if (kind == Kind.ENDED) s.endedAt else observed)
                }
            }
            val ordered = rows.sortedWith(compareBy<Row> { it.kind.ordinal }.thenByDescending { it.at ?: Instant.EPOCH })
            return WidgetState(
                paired = hosts.isNotEmpty(),
                waiting = waiting,
                running = running,
                needsCheck = needsCheck || hosts.isEmpty(),
                observedAt = hosts.mapNotNull { it.observedAt }.minOrNull(),
                rows = ordered.take(maxRows),
            )
        }

        /** The moment a fresh host turns stale, so the widget can redraw then. */
        fun nextStaleAt(hosts: List<WidgetHost>, now: Instant): Instant? =
            hosts.mapNotNull { it.observedAt?.plus(STALE_AFTER) }.filter { it.isAfter(now) }.minOrNull()

        fun age(at: Instant, now: Instant): String {
            val minutes = Duration.between(at, now).toMinutes().coerceAtLeast(0)
            return when {
                minutes < 1 -> "방금"
                minutes < 60 -> "${minutes}분 전"
                minutes < 60 * 24 -> "${minutes / 60}시간 전"
                else -> "${minutes / (60 * 24)}일 전"
            }
        }
    }
}

fun WidgetState.Row.status(now: Instant): String = when (kind) {
    WidgetState.Kind.WAITING -> if (waiting > 1) "응답 대기 $waiting" else "응답 대기"
    WidgetState.Kind.UNCONFIRMED -> "확인 필요"
    WidgetState.Kind.RUNNING -> "작업 중"
    WidgetState.Kind.ENDED -> "실행 종료 · ${at?.let { WidgetState.age(it, now) } ?: ""}".trimEnd(' ', '·')
}

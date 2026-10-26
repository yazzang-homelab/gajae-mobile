package dev.gajae.gjcmobile.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import dev.gajae.gjcmobile.core.PairedHost
import dev.gajae.gjcmobile.core.PermissionRequest
import dev.gajae.gjcmobile.core.SessionSummary
import dev.gajae.gjcmobile.core.WidgetHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

/**
 * The widget's only data source: what the app last observed per paired host (no keys, no question text).
 * Written by the live connections and by [WidgetRefreshWorker]; both run in the app process, so a process-wide
 * lock keeps their read-modify-write steps from interleaving.
 */
class WidgetStore(context: Context) {
    private val context = context.applicationContext
    private val prefs = this.context.getSharedPreferences("gjcm_widget", Context.MODE_PRIVATE)

    fun hosts(): List<WidgetHost> = synchronized(lock) { WidgetHost.list(prefs.getString(KEY_HOSTS, null)) }

    /** Records a full observation of one host. Unchanged content within a minute is not rewritten (status ticks every second). */
    fun observe(host: PairedHost, sessions: List<SessionSummary>, waiting: List<PermissionRequest>, now: Instant = Instant.now()) {
        val changed = synchronized(lock) {
            val all = WidgetHost.list(prefs.getString(KEY_HOSTS, null))
            val previous = all.firstOrNull { it.hostId == host.hostId }
            val next = WidgetHost.observe(previous, host.hostId, host.name, sessions, waiting, now)
            val unchanged = previous?.observedAt != null && previous.copy(observedAt = null) == next.copy(observedAt = null) &&
                Duration.between(previous.observedAt, now) < REWRITE_AFTER
            if (!unchanged) write(all.filter { it.hostId != host.hostId } + next, order = all.map { it.hostId })
            !unchanged
        }
        if (changed) redraw()
    }

    /** Keeps the stored hosts equal to the paired ones: forgotten hosts disappear, new ones show as never checked. */
    fun sync(paired: List<PairedHost>) {
        synchronized(lock) {
            val all = WidgetHost.list(prefs.getString(KEY_HOSTS, null)).associateBy { it.hostId }
            val next = paired.map { p -> all[p.hostId]?.copy(name = p.name) ?: WidgetHost.unobserved(p.hostId, p.name) }
            if (next == all.values.toList()) return
            write(next, order = paired.map { it.hostId })
        }
        redraw()
    }

    private fun write(hosts: List<WidgetHost>, order: List<String>) {
        val sorted = hosts.sortedBy { h -> order.indexOf(h.hostId).let { if (it < 0) Int.MAX_VALUE else it } }
        prefs.edit().putString(KEY_HOSTS, WidgetHost.encode(sorted)).apply()
    }

    /** Redraws every widget (ages and staleness move on even when nothing new was observed). */
    fun redraw() {
        scope.launch { runCatching { GjcWidget().updateAll(context) } }
    }

    private companion object {
        const val KEY_HOSTS = "hosts"
        val REWRITE_AFTER: Duration = Duration.ofMinutes(1)
        val lock = Any()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }
}

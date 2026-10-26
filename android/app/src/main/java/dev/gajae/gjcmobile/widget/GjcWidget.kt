package dev.gajae.gjcmobile.widget

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.core.DataStore
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.state.GlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.gajae.gjcmobile.core.WidgetHost
import dev.gajae.gjcmobile.core.WidgetState
import dev.gajae.gjcmobile.core.status
import dev.gajae.gjcmobile.ui.MainActivity
import dev.gajae.gjcmobile.ui.Palette
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.io.File
import java.time.Instant

/**
 * Home-screen widget: "does the agent need me?" first, then the sessions worth opening. Tapping a row opens that
 * chat (`gjcm://session`), anywhere else opens the app. It has no approve/deny buttons on purpose: an approval
 * belongs next to the command it allows, and the widget's data may be minutes old.
 */
class GjcWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, MEDIUM, LARGE))
    override val stateDefinition: GlanceStateDefinition<*> = SnapshotState

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { Content(currentState<List<WidgetHost>>()) }
    }

    @Composable
    private fun Content(hosts: List<WidgetHost>) {
        val context = LocalContext.current
        val size = LocalSize.current
        val now = Instant.now()
        val maxRows = when {
            // Narrow: the single most urgent session, so the square widget names who is waiting.
            size.width < MEDIUM.width -> 1
            size.height < LARGE.height -> 2
            else -> 5
        }
        val state = WidgetState.present(hosts, now, maxRows)
        val headlineColor = when {
            state.waiting > 0 -> RED
            state.needsCheck -> GOLD
            state.running > 0 -> GREEN
            else -> CREAM
        }
        val multiHost = hosts.size > 1
        Column(
            GlanceModifier.fillMaxSize().background(INK).cornerRadius(16.dp).padding(12.dp)
                .clickable(actionStartActivity(openApp(context, null))),
        ) {
            Text("가재코드", style = TextStyle(color = ColorProvider(MUTED), fontSize = 11.sp))
            Text(state.headline, maxLines = 1, style = TextStyle(color = ColorProvider(headlineColor), fontSize = 20.sp, fontWeight = FontWeight.Bold))
            Text(state.summary(now), maxLines = 1, style = TextStyle(color = ColorProvider(MUTED), fontSize = 12.sp))
            if (state.rows.isNotEmpty()) Spacer(GlanceModifier.height(8.dp))
            for (row in state.rows) {
                Row(
                    GlanceModifier.fillMaxWidth().padding(vertical = 3.dp)
                        .clickable(actionStartActivity(openApp(context, row))),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (multiHost) "${row.label} · ${row.hostName}" else row.label,
                        maxLines = 1,
                        modifier = GlanceModifier.defaultWeight(),
                        style = TextStyle(color = ColorProvider(CREAM), fontSize = 13.sp),
                    )
                    Spacer(GlanceModifier.width(8.dp))
                    Text(row.status(now), maxLines = 1, style = TextStyle(color = ColorProvider(rowColor(row.kind)), fontSize = 12.sp))
                }
            }
        }
    }

    private fun rowColor(kind: WidgetState.Kind) = when (kind) {
        WidgetState.Kind.WAITING -> RED
        WidgetState.Kind.UNCONFIRMED -> GOLD
        WidgetState.Kind.RUNNING -> GREEN
        WidgetState.Kind.ENDED -> MUTED
    }

    private fun openApp(context: Context, row: WidgetState.Row?): Intent {
        val intent = Intent(Intent.ACTION_VIEW).setComponent(ComponentName(context, MainActivity::class.java))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (row != null) {
            intent.data = Uri.Builder().scheme("gjcm").authority("session")
                .appendQueryParameter("host", row.hostId)
                .appendQueryParameter("id", row.sessionId)
                .appendQueryParameter("cwd", row.cwd)
                .build()
        }
        return intent
    }

    /** Glance re-reads its state on every update; this one is the app's [WidgetStore], not a per-widget file. */
    private object SnapshotState : GlanceStateDefinition<List<WidgetHost>> {
        override suspend fun getDataStore(context: Context, fileKey: String): DataStore<List<WidgetHost>> =
            object : DataStore<List<WidgetHost>> {
                override val data: Flow<List<WidgetHost>> = flow { emit(WidgetStore(context).hosts()) }
                override suspend fun updateData(transform: suspend (t: List<WidgetHost>) -> List<WidgetHost>) =
                    transform(WidgetStore(context).hosts())
            }

        override fun getLocation(context: Context, fileKey: String): File = File(context.filesDir, "gjcm_widget_$fileKey")
    }

    private companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val MEDIUM = DpSize(250.dp, 110.dp)
        val LARGE = DpSize(250.dp, 220.dp)
        val RED = Palette.gajaeRed
        val GOLD = Palette.strawGold
        val GREEN = Palette.visorGreen
        val CREAM = Palette.cream
        val INK = Palette.ink
        val MUTED = Palette.muted
    }
}

class GjcWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = GjcWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        WidgetRefreshWorker.schedule(context)
        WidgetRefreshWorker.refreshNow(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        WidgetRefreshWorker.cancel(context)
    }
}

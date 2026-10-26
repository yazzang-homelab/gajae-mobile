package dev.gajae.gjcmobile.widget

import android.content.Context
import android.os.Build
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.gajae.gjcmobile.core.BridgeClient
import dev.gajae.gjcmobile.ui.SecureStore
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/**
 * Background check for the widget while the app is not on screen: a short connection per paired host reads the
 * session list and the waiting asks, then closes. The device key never leaves the app process. A host that cannot
 * be reached keeps its last observation, which the widget turns into "확인 필요" once it is old.
 */
class WidgetRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val secure = SecureStore(applicationContext)
        val hosts = secure.hosts()
        val store = WidgetStore(applicationContext)
        store.sync(hosts)
        if (hosts.isEmpty()) return Result.success()
        val device = secure.deviceIdentity()
        val deviceName = Build.MODEL ?: "Android"
        coroutineScope {
            hosts.map { host ->
                async {
                    withTimeoutOrNull(PER_HOST_TIMEOUT_MS) {
                        runCatching {
                            val (client, _) = BridgeClient.connectAny(host, device, deviceName)
                            try {
                                val sessions = client.listSessions().sessions
                                val waiting = client.pendingPermissions()
                                store.observe(host, sessions, waiting)
                            } finally {
                                client.close()
                            }
                        }
                    }
                }
            }.awaitAll()
        }
        store.redraw()
        return Result.success()
    }

    companion object {
        private const val PERIODIC = "widget-refresh"
        private const val NOW = "widget-refresh-now"
        private const val PER_HOST_TIMEOUT_MS = 25_000L

        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Every 15 minutes (WorkManager's floor) while at least one widget is on the home screen. */
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<WidgetRefreshWorker>(15, TimeUnit.MINUTES).setConstraints(online).build(),
            )
        }

        fun refreshNow(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                NOW,
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<WidgetRefreshWorker>().setConstraints(online).build(),
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        }
    }
}

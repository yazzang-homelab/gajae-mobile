package dev.gajae.gjcmobile.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.gajae.gjcmobile.R
import dev.gajae.gjcmobile.core.ActivityAlerts

/**
 * Posts local notifications for an ask and for working ↔ idle changes. Only works while the app process is alive
 * and connected to the bridge; a killed or frozen process receives no events (that needs remote push).
 */
class ActivityNotifier(context: Context) {
    private val context = context.applicationContext
    private val manager = NotificationManagerCompat.from(this.context)

    init {
        val system = this.context.getSystemService(NotificationManager::class.java)
        system.createNotificationChannel(
            NotificationChannel(CHANNEL_ASK, "질문 대기", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "gjc가 선택을 기다릴 때" },
        )
        system.createNotificationChannel(
            NotificationChannel(CHANNEL_STATUS, "작업 상태", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "세션이 작업을 시작하거나 마쳤을 때" },
        )
    }

    @SuppressLint("MissingPermission") // checked right below
    fun post(alert: ActivityAlerts.Alert, session: String, host: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val (channel, title, body) = when (alert) {
            is ActivityAlerts.Alert.Ask -> Triple(CHANNEL_ASK, "질문 대기 · $session", alert.title)
            is ActivityAlerts.Alert.Started -> Triple(CHANNEL_STATUS, "작업 시작 · $session", null)
            is ActivityAlerts.Alert.Finished -> Triple(CHANNEL_STATUS, "작업 끝 · $session", "응답을 기다리고 있습니다.")
        }
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setSubText(host)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        manager.notify(tag(alert), 0, notification)
    }

    /** Drops the notification of an ask that was answered (here or on another phone). */
    fun withdrawAsk(requestId: String) = manager.cancel("ask-$requestId", 0)

    /** One working/idle notification per session: a newer state replaces the older one. */
    private fun tag(alert: ActivityAlerts.Alert) = when (alert) {
        is ActivityAlerts.Alert.Ask -> "ask-${alert.requestId}"
        else -> "status-${alert.sessionId}"
    }

    private companion object {
        const val CHANNEL_ASK = "ask"
        const val CHANNEL_STATUS = "status"
    }
}

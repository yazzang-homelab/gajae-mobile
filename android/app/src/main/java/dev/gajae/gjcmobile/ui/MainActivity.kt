package dev.gajae.gjcmobile.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels

class MainActivity : ComponentActivity() {
    private val model: AppModel by viewModels()
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Ask and working/idle alerts (ActivityNotifier); asked once, Android remembers a denial.
        if (savedInstanceState == null && Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        if (savedInstanceState == null) handle(intent)
        setContent { GjcTheme { RootScreen(model) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        model.appBecameActive()
    }

    /**
     * `gjcm://pair?o=…` deep links open the pairing screen with the link pre-submitted; `gjcm://session?…` comes
     * from a widget row (an explicit intent, so it is not in the manifest's browsable filter).
     */
    private fun handle(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "gjcm") return
        if (data.host == "session") {
            val hostId = data.getQueryParameter("host") ?: return
            val sessionId = data.getQueryParameter("id") ?: return
            model.openSession(hostId, sessionId, data.getQueryParameter("cwd").orEmpty())
            return
        }
        model.pairingUrl = data.toString()
        model.showPairing = true
    }
}

package dev.gajae.gjcmobile.ui

import dev.gajae.gjcmobile.BuildConfig

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.gajae.gjcmobile.R
import dev.gajae.gjcmobile.core.PairingOffer
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(model: AppModel, onClose: (() -> Unit)?) {
    var manual by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun submit(text: String) {
        if (working) return
        working = true
        error = null
        scope.launch {
            try {
                model.pair(text.trim())
                model.showPairing = false
            } catch (e: PairingOffer.ParseException) {
                error = when (e.error) {
                    PairingOffer.ParseError.EXPIRED -> "QR 코드가 만료됐습니다. 호스트에서 다시 `gjcm-bridge pair`를 실행하세요."
                    PairingOffer.ParseError.UNSUPPORTED_VERSION -> "이 앱보다 새 버전의 브리지입니다. 앱을 업데이트하세요."
                    else -> "가재코드 페어링 QR이 아닙니다."
                }
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                working = false
            }
        }
    }

    val scanner = androidx.activity.compose.rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let(::submit)
    }

    LaunchedEffect(model.pairingUrl) {
        model.pairingUrl?.let {
            model.pairingUrl = null
            submit(it)
        }
    }

    Scaffold(
        containerColor = Palette.ink,
        topBar = {
            TopAppBar(
                title = { Text("호스트 페어링") },
                navigationIcon = {
                    if (onClose != null) IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = "닫기") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.ink),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Image(painterResource(R.drawable.mascot), contentDescription = null, modifier = Modifier.size(120.dp))
            Button(
                onClick = {
                    scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("호스트의 QR 코드를 비추세요").setBeepEnabled(false).setOrientationLocked(false))
                },
                enabled = !working,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("QR 코드 스캔") }
            Text(
                "호스트 터미널에서 `gjcm-bridge pair`를 실행하면 10분 동안 한 번 쓸 수 있는 QR 코드가 나옵니다.",
                style = MaterialTheme.typography.bodySmall, color = Palette.muted,
            )
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("또는 링크 붙여 넣기", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
                OutlinedTextField(
                    value = manual,
                    onValueChange = { manual = it },
                    placeholder = { Text("gjcm://pair?o=…") },
                    textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(onClick = { submit(manual) }, enabled = manual.isNotEmpty() && !working) { Text("연결") }
            }
            if (working) CircularProgressIndicator(color = Palette.cream)
            error?.let { Text(it, color = Palette.gajaeRed, style = MaterialTheme.typography.bodySmall) }
            // Builds without a demo host (GJCM_DEMO_OFFER_URL unset) have no demo button.
            if (BuildConfig.DEMO_OFFER_URL.isNotEmpty()) {
            HorizontalDivider(color = Palette.shellLine)
            OutlinedButton(
                onClick = {
                    if (working) return@OutlinedButton
                    error = null
                    scope.launch {
                        val link = try {
                            model.demoPairingLink()
                        } catch (e: Exception) {
                            error = DEMO_FAILURE
                            return@launch
                        }
                        submit(link)
                    }
                },
                enabled = !working,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.strawGold),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.PlayArrow, contentDescription = null)
                Spacer(Modifier.size(6.dp))
                Text("컴퓨터 없이 데모로 체험")
            }
            Text(
                "컴퓨터가 없어도 정해진 응답을 돌려주는 데모 호스트에 연결해 기능을 둘러볼 수 있습니다. 데모 호스트에서는 아무 명령도 실행되지 않습니다.",
                style = MaterialTheme.typography.labelSmall, color = Palette.muted, textAlign = TextAlign.Center,
            )
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

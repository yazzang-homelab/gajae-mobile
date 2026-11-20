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
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.gajae.gjcmobile.R
import dev.gajae.gjcmobile.core.CodeInputFormatter
import dev.gajae.gjcmobile.core.PairingConfirmation
import dev.gajae.gjcmobile.core.PairingOffer
import dev.gajae.gjcmobile.core.pairingConfirmation
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(model: AppModel, onClose: (() -> Unit)?) {
    var manual by remember { mutableStateOf("") }
    var showLink by remember { mutableStateOf(false) }
    // The device code's characters: uppercase, no separators. The hyphens are only drawn (CodeVisualTransformation).
    var codeField by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue("")) }
    val code = codeField.text
    // Input past the longest code was refused (the field kept its value); said once, until the next accepted edit.
    var codeTooLong by remember { mutableStateOf(false) }
    // A link waiting for the user's confirmation; saved so rotating the screen does not lose it.
    var pending by rememberSaveable { mutableStateOf<String?>(null) }
    // Only the demo link download runs here; every pairing runs in the model so a rotation does not cancel it.
    val scope = rememberCoroutineScope()
    // The pairing's progress and result are the model's: "연결 중" until the host answers, then "확인 중 · 남은 시도 n회".
    val working = model.pairWorking
    val stage = model.pairStage
    val error = model.pairError

    fun submitCode() {
        val entered = CodeInputFormatter.format(code)
        if (working || entered.chars.isEmpty() || entered.invalid != null) return
        model.pairWithCode(entered.chars)
    }

    /**
     * A link that arrived from outside the app is always confirmed first; an offer the user scanned or pasted
     * here goes straight through unless it would replace a known host's key.
     */
    fun request(text: String, fromLink: Boolean) {
        if (working || (pending != null && !fromLink)) return
        val offer = try {
            PairingOffer.parse(text)
        } catch (e: PairingOffer.ParseException) {
            model.pairError = pairingParseMessage(e)
            return
        }
        if (pairingConfirmation(offer, model.hosts, fromLink) != PairingConfirmation.NONE) {
            model.pairError = null
            pending = text.trim()
        } else {
            model.pairWithLink(text)
        }
    }

    val scanner = androidx.activity.compose.rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { request(it, fromLink = false) }
    }

    // A link that arrives while a pairing runs, or while a code's key change waits for an answer, stays in the model
    // and is handled once that is over, so two confirmations never stack.
    LaunchedEffect(model.pairingUrl, working, model.awaitingKeyApproval) {
        if (!working && !model.awaitingKeyApproval) {
            model.pairingUrl?.let {
                model.pairingUrl = null
                request(it, fromLink = true)
            }
        }
    }

    // The pending link is kept as text across rotation and parsed again; one that no longer parses is dropped.
    val pendingOffer = pending?.let { text -> runCatching { PairingOffer.parse(text) }.getOrNull() }
    if (pending != null && pendingOffer == null) pending = null
    val pendingText = pending
    if (pendingText != null && pendingOffer != null) {
        val text = pendingText
        val offer = pendingOffer
        val keyChanged = pairingConfirmation(offer, model.hosts, fromLink = true) == PairingConfirmation.REPLACE_KEY
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text(if (keyChanged) "호스트 교체" else "이 호스트에 연결할까요?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (keyChanged) {
                        Text("이미 등록된 호스트의 키가 바뀌었습니다", color = Palette.gajaeRed, style = MaterialTheme.typography.bodyMedium)
                        Text("믿을 수 있는 호스트가 아니라면 교체하지 마세요. 교체하면 이후 지시문과 첨부 파일이 이 호스트로 갑니다.", style = MaterialTheme.typography.bodySmall)
                    }
                    Text(offer.name.ifBlank { offer.hostId }, style = MaterialTheme.typography.titleSmall)
                    offer.endpoints.forEach {
                        Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { pending = null; model.pairWithLink(text, replaceChangedKey = keyChanged) }) {
                    Text(if (keyChanged) "교체" else "연결")
                }
            },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("취소") } },
        )
    }

    // Approving a replaced host key is a decision: only the buttons answer it, not a tap outside or the back key.
    val keptOffer = model.codeOffer?.offer
    // The code that produced a kept offer is spent; the field starts empty once the offer is cancelled.
    LaunchedEffect(keptOffer != null) {
        if (keptOffer != null) {
            codeField = TextFieldValue("")
            codeTooLong = false
        }
    }
    if (model.awaitingKeyApproval && keptOffer != null) {
        AlertDialog(
            onDismissRequest = {},
            properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false),
            title = { Text("호스트 교체") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("이미 등록된 호스트의 키가 바뀌었습니다", color = Palette.gajaeRed, style = MaterialTheme.typography.bodyMedium)
                    Text("믿을 수 있는 호스트가 아니라면 교체하지 마세요. 교체하면 이후 지시문과 첨부 파일이 이 호스트로 갑니다.", style = MaterialTheme.typography.bodySmall)
                    Text(keptOffer.name.ifBlank { keptOffer.hostId }, style = MaterialTheme.typography.titleSmall)
                    keptOffer.endpoints.forEach {
                        Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                    }
                }
            },
            confirmButton = { TextButton(onClick = { model.approveCodeKeyChange() }) { Text("교체") } },
            dismissButton = { TextButton(onClick = { model.cancelCodePairing() }) { Text("취소") } },
        )
    }

    val entered = CodeInputFormatter.format(code)

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
            if (keptOffer == null) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("호스트에 나온 코드 입력", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
                    OutlinedTextField(
                        value = codeField,
                        onValueChange = { input ->
                            // Input that would pass the longest code is refused, keeping the previous value.
                            val edited = CodeInputFormatter.edit(input.text, input.selection.start, input.selection.end)
                            codeTooLong = edited == null
                            if (edited != null) {
                                // Already normal: keep the IME's composition, or the keyboard restarts on every key.
                                codeField = if (edited.chars == input.text) {
                                    input
                                } else {
                                    TextFieldValue(edited.chars, TextRange(edited.selStart, edited.selEnd))
                                }
                            }
                        },
                        visualTransformation = CodeVisualTransformation,
                        placeholder = { Text("K7M2-9QXD-HP") },
                        singleLine = true,
                        isError = entered.invalid != null || codeTooLong,
                        supportingText = CodeInputFormatter.message(entered.invalid, codeTooLong)?.let { message -> { Text(message) } },
                        textStyle = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Characters,
                            keyboardType = KeyboardType.Ascii,
                            autoCorrectEnabled = false,
                        ),
                        enabled = !working,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = { submitCode() },
                        enabled = entered.chars.isNotEmpty() && entered.invalid == null && !working,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("연결") }
                }
                Text(
                    "호스트 터미널에서 `gjcm-bridge pair`를 실행하면 15분 동안 한 번 쓸 수 있는 코드와 QR이 나옵니다.",
                    style = MaterialTheme.typography.bodySmall, color = Palette.muted,
                )
            } else if (!model.awaitingKeyApproval) {
                // The code was accepted and only the connection is left: retry it or give it up. A new code is
                // entered after cancelling, so "연결" never means two things.
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "${keptOffer.name.ifBlank { keptOffer.hostId }} 인증은 끝났고 연결만 남았습니다.",
                        style = MaterialTheme.typography.bodyMedium, color = Palette.cream,
                    )
                    Button(onClick = { model.retryCodePairing() }, enabled = !working, modifier = Modifier.fillMaxWidth()) { Text("다시 시도") }
                    OutlinedButton(onClick = { model.cancelCodePairing() }, enabled = !working, modifier = Modifier.fillMaxWidth()) { Text("취소") }
                }
            }
            HorizontalDivider(color = Palette.shellLine)
            OutlinedButton(
                onClick = {
                    scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("호스트의 QR 코드를 비추세요").setBeepEnabled(false).setOrientationLocked(false))
                },
                enabled = !working,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("QR 코드 스캔") }
            OutlinedButton(onClick = { showLink = !showLink }, enabled = !working, modifier = Modifier.fillMaxWidth()) { Text("링크 붙여 넣기") }
            if (showLink) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = manual,
                        onValueChange = { manual = it },
                        placeholder = { Text("gjcm://pair?o=…") },
                        textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(onClick = { request(manual, fromLink = false) }, enabled = manual.isNotEmpty() && !working) { Text("연결") }
                }
            }
            stage?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.cream) }
            if (working) CircularProgressIndicator(color = Palette.cream)
            error?.let { Text(it, color = Palette.gajaeRed, style = MaterialTheme.typography.bodySmall) }
            // Builds without a demo host (GJCM_DEMO_OFFER_URL unset) have no demo button.
            if (BuildConfig.DEMO_OFFER_URL.isNotEmpty()) {
            HorizontalDivider(color = Palette.shellLine)
            OutlinedButton(
                onClick = {
                    if (working) return@OutlinedButton
                    model.pairError = null
                    scope.launch {
                        val link = try {
                            model.demoPairingLink()
                        } catch (e: Exception) {
                            model.pairError = DEMO_FAILURE
                            return@launch
                        }
                        request(link, fromLink = false)
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

/**
 * Draws the hyphen after every four characters of the raw code, so the field's text (and the cursor in it) never
 * contains a hyphen; the offset mapping is [CodeInputFormatter]'s pure functions.
 */
private object CodeVisualTransformation : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val raw = text.text
        return TransformedText(
            AnnotatedString(CodeInputFormatter.displayText(raw)),
            object : OffsetMapping {
                override fun originalToTransformed(offset: Int): Int = CodeInputFormatter.originalToTransformed(offset)
                override fun transformedToOriginal(offset: Int): Int = CodeInputFormatter.transformedToOriginal(offset, raw.length)
            },
        )
    }
}

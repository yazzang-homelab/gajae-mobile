package dev.gajae.gjcmobile.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.gajae.gjcmobile.R
import dev.gajae.gjcmobile.core.AttachmentLimits
import dev.gajae.gjcmobile.core.AttachmentTooLarge
import dev.gajae.gjcmobile.core.PendingAttachment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** What a host lands on: a new-chat composer, or the active chat. Hosts and sessions live in the drawer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostHome(model: AppModel, connection: HostConnection, onOpenSidebar: () -> Unit) {
    val active = connection.activeChat
    LaunchedEffect(connection) {
        connection.ensureConnected()
        connection.refreshSessions()
    }
    val pendingElsewhere = model.connections.values.any { other -> other.permissions.any { it.sessionId != active?.sessionId } }
    Scaffold(
        containerColor = Palette.ink,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.ink),
                navigationIcon = {
                    Row {
                        IconButton(onClick = onOpenSidebar) {
                            Icon(Icons.Filled.Menu, contentDescription = if (pendingElsewhere) "사이드바 · 승인 대기 있음" else "사이드바",
                                tint = if (pendingElsewhere) Palette.strawGold else Palette.cream)
                        }
                        if (active != null) {
                            IconButton(onClick = { connection.startNewChat(active.cwd) }) { Icon(Icons.Filled.Create, contentDescription = "새 채팅") }
                        }
                    }
                },
                title = {
                    if (active != null) ChatTitle(active) else Text(connection.host.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                actions = { if (active != null) ChatActions(model, active) },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
            if (active != null) {
                androidx.compose.runtime.key(active.sessionId) { ChatScreen(model, active) }
            } else {
                NewChatScreen(connection, onShowSessions = onOpenSidebar)
            }
        }
    }
}

/** Composer for a session that does not exist yet; the session is created on the first send. */
@Composable
private fun NewChatScreen(connection: HostConnection, onShowSessions: () -> Unit) {
    var draft by remember { mutableStateOf("") }
    var starting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var editingCwd by remember { mutableStateOf(false) }
    var cwdDraft by remember { mutableStateOf("") }
    var attachments by remember { mutableStateOf<List<PendingAttachment>>(emptyList()) }
    val scope = rememberCoroutineScope()
    val effectiveCwd = connection.draftCwd ?: connection.info?.defaultCwd ?: ""
    val canSend = (draft.isNotBlank() || attachments.isNotEmpty()) && !starting && connection.status == HostConnection.Status.Connected

    fun send() {
        if (!canSend) return
        starting = true
        error = null
        scope.launch {
            try {
                val chat = connection.createSession(effectiveCwd.ifEmpty { null })
                chat.draft = draft.trim()
                chat.attachments = attachments
                draft = ""
                attachments = emptyList()
                connection.activeChat = chat
                chat.launchSubmit()
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                starting = false
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Spacer(Modifier.size(16.dp))
            Image(painterResource(R.drawable.mascot), contentDescription = null, modifier = Modifier.size(120.dp))
            Text("무엇을 맡길까요?", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = Palette.cream)
            Text(
                if (effectiveCwd.isEmpty()) "작업 디렉터리" else displayPath(effectiveCwd),
                style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = Palette.muted, maxLines = 1,
                modifier = Modifier.card().clickable { cwdDraft = effectiveCwd; editingCwd = true }.padding(horizontal = 10.dp, vertical = 6.dp),
            )
            val recent = connection.sessions.take(5)
            if (recent.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().card().padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("최근 세션", style = MaterialTheme.typography.labelMedium, color = Palette.muted, modifier = Modifier.weight(1f))
                        TextButton(onClick = onShowSessions) { Text("전체 보기", color = Palette.strawGold) }
                    }
                    recent.forEachIndexed { index, session ->
                        SessionRow(session, Modifier.fillMaxWidth().clickable { connection.activeChat = connection.chat(session) }.padding(vertical = 8.dp))
                        if (index < recent.lastIndex) HorizontalDivider(color = Palette.shellLine)
                    }
                }
            }
        }
        Composer(
            draft = draft,
            onDraft = { draft = it },
            placeholder = "gjc에게 지시",
            attachments = attachments,
            onAttach = { attachments = attachments + it },
            onRemove = { a -> attachments = attachments.filter { it.id != a.id } },
            onError = { error = it },
            attachEnabled = !starting,
            canSend = canSend,
            busy = starting,
            onSend = ::send,
            error = error,
            onDismissError = { error = null },
            header = {
                if (starting) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(14.dp), color = Palette.strawGold, strokeWidth = 2.dp)
                        Text(" 호스트에서 세션을 준비하는 중…", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
                    }
                }
            },
            footer = {
                if (connection.status != HostConnection.Status.Connected) {
                    Text(statusText(connection.status), style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                }
            },
        )
    }

    if (editingCwd) {
        AlertDialog(
            onDismissRequest = { editingCwd = false },
            title = { Text("작업 디렉터리") },
            text = {
                Column {
                    Text("호스트에서 gjc가 실행될 디렉터리입니다.", color = Palette.muted)
                    OutlinedTextField(cwdDraft, { cwdDraft = it }, placeholder = { Text("경로") }, singleLine = true)
                }
            },
            confirmButton = { TextButton(onClick = { connection.draftCwd = cwdDraft.ifEmpty { null }; editingCwd = false }) { Text("적용") } },
            dismissButton = { TextButton(onClick = { editingCwd = false }) { Text("취소") } },
        )
    }
}

fun statusText(status: HostConnection.Status): String = when (status) {
    HostConnection.Status.Connecting -> "호스트에 연결하는 중…"
    is HostConnection.Status.Failed -> status.reason
    else -> "호스트에 연결되지 않았습니다."
}

/** Shared composer row: error line, header slot, attachment chips, + menu (사진/파일), text field, send. */
@Composable
fun Composer(
    draft: String,
    onDraft: (String) -> Unit,
    placeholder: String,
    attachments: List<PendingAttachment>,
    onAttach: (PendingAttachment) -> Unit,
    onRemove: (PendingAttachment) -> Unit,
    onError: (String) -> Unit,
    attachEnabled: Boolean,
    canSend: Boolean,
    busy: Boolean,
    onSend: () -> Unit,
    error: String?,
    onDismissError: () -> Unit,
    header: @Composable () -> Unit = {},
    footer: @Composable () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch { runCatching { loadImage(context, uri) }.onSuccess(onAttach).onFailure { onError(it.userMessage()) } }
    }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch { runCatching { loadFile(context, uri) }.onSuccess(onAttach).onFailure { onError(it.userMessage()) } }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        error?.let {
            Row(verticalAlignment = Alignment.Top) {
                Text(it, style = MaterialTheme.typography.labelMedium, color = Palette.gajaeRed, modifier = Modifier.weight(1f))
                IconButton(onClick = onDismissError, modifier = Modifier.size(24.dp)) { Icon(Icons.Filled.Close, contentDescription = "오류 닫기", tint = Palette.muted) }
            }
        }
        header()
        if (attachments.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                attachments.forEach { a ->
                    Row(Modifier.card().padding(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(a.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 120.dp))
                        Text(" ${formatBytes(a.data.size)}", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                        IconButton(onClick = { onRemove(a) }, modifier = Modifier.size(24.dp)) { Icon(Icons.Filled.Close, contentDescription = "${a.name} 제거", tint = Palette.muted) }
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Box {
                IconButton(onClick = { menu = true }, enabled = attachEnabled) { Icon(Icons.Filled.AddCircle, contentDescription = "첨부") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("사진") }, onClick = {
                        menu = false
                        photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    })
                    DropdownMenuItem(text = { Text("파일") }, onClick = { menu = false; files.launch(arrayOf("*/*")) })
                }
            }
            OutlinedTextField(
                value = draft,
                onValueChange = onDraft,
                placeholder = { Text(placeholder) },
                maxLines = 6,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Palette.gajaeRed, unfocusedBorderColor = Palette.shellLine,
                    focusedContainerColor = Palette.shell, unfocusedContainerColor = Palette.shell),
                shape = CardShape,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onSend, enabled = canSend) {
                if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "보내기", tint = if (canSend) Palette.gajaeRed else Palette.muted)
            }
        }
        footer()
    }
}

fun formatBytes(n: Int): String = when {
    n < 1024 -> "${n}B"
    n < 1024 * 1024 -> "${n / 1024}KB"
    else -> String.format("%.1fMB", n / 1024.0 / 1024.0)
}

private fun displayName(context: Context, uri: Uri): String =
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
    } ?: uri.lastPathSegment ?: "file"

/** Downscales to the model's longest edge and re-encodes JPEG under the inline image cap. */
private suspend fun loadImage(context: Context, uri: Uri): PendingAttachment = withContext(Dispatchers.IO) {
    val name = displayName(context, uri)
    val bytes = context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("$name: 이미지를 읽을 수 없습니다.")
    val longest = maxOf(bitmap.width, bitmap.height)
    val scale = minOf(1f, AttachmentLimits.MAX_IMAGE_EDGE.toFloat() / longest)
    val resized = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true) else bitmap
    for (quality in listOf(85, 70, 50)) {
        val out = ByteArrayOutputStream()
        resized.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (out.size() <= AttachmentLimits.MAX_IMAGE_BYTES) return@withContext PendingAttachment(name, out.toByteArray(), "image/jpeg", isImage = true)
    }
    throw AttachmentTooLarge(name, AttachmentLimits.MAX_IMAGE_BYTES)
}

private suspend fun loadFile(context: Context, uri: Uri): PendingAttachment = withContext(Dispatchers.IO) {
    val name = displayName(context, uri)
    val bytes = context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
    if (bytes.size > AttachmentLimits.MAX_FILE_BYTES) throw AttachmentTooLarge(name, AttachmentLimits.MAX_FILE_BYTES)
    PendingAttachment(name, bytes, context.contentResolver.getType(uri) ?: "application/octet-stream", isImage = false)
}

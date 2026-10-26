package dev.gajae.gjcmobile.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.gajae.gjcmobile.core.Attachment
import dev.gajae.gjcmobile.core.ConfigTarget
import dev.gajae.gjcmobile.core.PermissionOption
import dev.gajae.gjcmobile.core.PermissionRequest
import dev.gajae.gjcmobile.core.PlanEntry
import dev.gajae.gjcmobile.core.ToolCall
import dev.gajae.gjcmobile.core.TranscriptItem
import dev.gajae.gjcmobile.core.prettyText
import kotlinx.coroutines.launch
import java.util.Base64

@Composable
fun ChatTitle(chat: ChatModel) {
    Column {
        Text(chat.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(if (chat.connected) Palette.visorGreen else Palette.gajaeRed))
            Text(
                " " + (chat.configOption(ConfigTarget.MODEL)?.currentChoiceName ?: displayPath(chat.cwd)),
                style = MaterialTheme.typography.labelSmall, color = Palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Session actions: model/effort sheet, reasoning toggle, fast mode, copy, delete. */
@Composable
fun ChatActions(model: AppModel, chat: ChatModel) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var menu by remember { mutableStateOf(false) }
    var modelSheet by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    IconButton(onClick = { modelSheet = true }, enabled = chat.connected) { Icon(Icons.Filled.Settings, contentDescription = "모델") }
    Box {
        IconButton(onClick = { menu = true }, enabled = chat.connected) { Icon(Icons.Filled.MoreVert, contentDescription = "세션 메뉴") }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text(modelSummary(chat)) }, onClick = { menu = false; modelSheet = true })
            DropdownMenuItem(text = { Text(if (model.showThinking) "추론 보기: 켬" else "추론 보기: 끔") }, onClick = { menu = false; model.toggleThinking() })
            DropdownMenuItem(
                text = { Text(if (chat.fastMode == true) "빠른 모드: 켬" else "빠른 모드: 끔") },
                onClick = { menu = false; scope.launch { chat.setFast(chat.fastMode != true) } },
            )
            // Each tap moves to the next mode, like the TUI's mode-cycling hotkeys.
            chat.permissionMode?.let { mode ->
                DropdownMenuItem(
                    text = { Text("권한모드: ${mode.label}") },
                    onClick = { menu = false; scope.launch { chat.cyclePermissionMode() } },
                )
            }
            DropdownMenuItem(text = { Text("/btw 잠깐 묻기 (기록 안 남음)") }, onClick = { menu = false; chat.openBtw() })
            HorizontalDivider()
            DropdownMenuItem(text = { Text("마지막 답변 복사") }, onClick = {
                menu = false
                val text = chat.lastAgentText
                if (text != null) {
                    clipboard.setText(AnnotatedString(text))
                    chat.notice("마지막 답변을 복사했습니다.")
                } else {
                    chat.errorMessage = "복사할 답변이 없습니다."
                }
            })
            DropdownMenuItem(
                text = { Text("세션 삭제", color = Palette.gajaeRed) },
                enabled = !chat.running,
                onClick = { menu = false; confirmDelete = true },
            )
            HorizontalDivider()
            DropdownMenuItem(text = { Text(chat.cwd, style = MaterialTheme.typography.labelSmall, color = Palette.muted) }, onClick = { menu = false })
        }
    }
    if (modelSheet) ModelSheet(chat) { modelSheet = false }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("이 세션을 삭제할까요?") },
            text = { Text("호스트의 gjc 세션 기록이 지워집니다.") },
            confirmButton = { TextButton(onClick = { confirmDelete = false; scope.launch { chat.deleteSelf() } }) { Text("실행", color = Palette.gajaeRed) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("취소") } },
        )
    }
}

private fun modelSummary(chat: ChatModel): String {
    val model = chat.configOption(ConfigTarget.MODEL)?.currentChoiceName ?: "모델"
    val effort = chat.configOption(ConfigTarget.THINKING)?.currentChoiceName ?: return model
    return "$model · $effort"
}

/** This session's model and reasoning effort (ACP config options `model` and `thinking`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelSheet(chat: ChatModel, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Palette.ink) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val targets = listOf(ConfigTarget.THINKING, ConfigTarget.MODEL, ConfigTarget.MODE)
            if (targets.none { chat.configOption(it) != null }) Text("이 세션에는 모델 설정이 없습니다.", color = Palette.muted)
            for (target in targets) {
                val option = chat.configOption(target) ?: continue
                if (option.choices.isEmpty()) continue
                Text(target.label, style = MaterialTheme.typography.titleSmall, color = Palette.strawGold, modifier = Modifier.padding(top = 8.dp))
                var lastGroup: String? = null
                for (choice in option.choices) {
                    if (choice.group != null && choice.group != lastGroup) {
                        lastGroup = choice.group
                        Text(choice.group, style = MaterialTheme.typography.labelSmall, color = Palette.muted, modifier = Modifier.padding(top = 6.dp))
                    }
                    val selected = option.currentValue?.let { it.prettyText == choice.value } == true
                    Row(
                        Modifier.fillMaxWidth().clip(CardShape).background(if (selected) Palette.shellLine else Palette.shell)
                            .clickable { scope.launch { chat.setConfig(target, choice.value) } }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(choice.name, color = Palette.cream, modifier = Modifier.weight(1f))
                        if (selected) Icon(Icons.Filled.CheckCircle, contentDescription = "선택됨", tint = Palette.gajaeRed)
                    }
                }
            }
            Spacer(Modifier.size(24.dp))
        }
    }
}

@Composable
fun ChatScreen(model: AppModel, chat: ChatModel) {
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    DisposableEffect(chat) {
        chat.isVisible = true
        scope.launch { chat.open() }
        onDispose { chat.leave() }
    }
    val lastText = (chat.items.lastOrNull()?.kind as? TranscriptItem.Kind.Agent)?.text?.length
    LaunchedEffect(chat.items.size, lastText, chat.running) {
        val count = listState.layoutInfo.totalItemsCount
        if (count > 0) listState.animateScrollToItem(count - 1)
    }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            state = listState,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (chat.loading) item { Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Palette.strawGold)
                Text("  세션을 불러오는 중…", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
            } }
            items(chat.items, key = { it.id }) { TranscriptRow(it, model.showThinking) }
            if (chat.running) item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Palette.visorGreen)
                    Text(chat.phase?.takeIf { it != "idle" } ?: "작업 중", style = MaterialTheme.typography.labelMedium, color = Palette.muted, modifier = Modifier.weight(1f))
                    if (chat.hasQueuedSteer) {
                        Button(
                            onClick = { scope.launch { chat.interrupt() } },
                            enabled = !chat.sending,
                            colors = ButtonDefaults.buttonColors(containerColor = Palette.strawGold, contentColor = Palette.ink),
                        ) { Text("끼어들기") }
                    }
                    OutlinedButton(onClick = { scope.launch { chat.cancel() } }, colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.gajaeRed)) { Text("중단") }
                }
            }
        }
        chat.permissions.firstOrNull()?.let { request ->
            PermissionCard(request, Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) { option -> scope.launch { chat.respond(request, option) } }
        }
        Composer(
            draft = chat.draft,
            onDraft = { chat.draft = it },
            placeholder = if (chat.running) "끼어들 지시 (진행 중인 턴에 전달)" else "gjc에게 지시 · /btw 잠깐 묻기",
            attachments = chat.attachments,
            onAttach = { chat.attachments = chat.attachments + it },
            onRemove = { a -> chat.attachments = chat.attachments.filter { it.id != a.id } },
            onError = { chat.errorMessage = it },
            attachEnabled = !chat.running,
            canSend = chat.canSend,
            busy = chat.sending,
            onSend = { chat.launchSubmit() },
            error = chat.errorMessage,
            onDismissError = { chat.errorMessage = null },
            header = {
                if (chat.queued.isNotEmpty()) {
                    Text(
                        "전달 대기 ${chat.queued.size}건: ${chat.queued.last().text}",
                        style = MaterialTheme.typography.labelMedium, color = Palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                chat.uploadProgress?.takeIf { it < 1 }?.let { LinearProgressIndicator(progress = { it.toFloat() }, color = Palette.strawGold, modifier = Modifier.fillMaxWidth()) }
            },
        )
    }
    chat.btw?.let { BtwBubble(chat, it) }
}

@Composable
fun TranscriptRow(item: TranscriptItem, showThinking: Boolean) {
    when (val kind = item.kind) {
        is TranscriptItem.Kind.User -> Row(Modifier.fillMaxWidth()) {
            Spacer(Modifier.weight(1f).widthIn(min = 40.dp))
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                kind.attachments.forEach { AttachmentView(it) }
                if (kind.text.isNotEmpty()) {
                    SelectionContainer {
                        Text(inlineMarkdown(kind.text, styles = false), color = Palette.ink, modifier = Modifier.background(Palette.cream, CardShape).padding(10.dp))
                    }
                }
            }
        }
        is TranscriptItem.Kind.Agent -> MarkdownText(kind.text)
        is TranscriptItem.Kind.Thought -> ThoughtView(kind.text, showThinking)
        is TranscriptItem.Kind.Tool -> ToolCallView(kind.call)
        is TranscriptItem.Kind.Plan -> PlanView(kind.entries)
        is TranscriptItem.Kind.TurnEnded -> when {
            kind.error != null -> Text("⚠ ${kind.error}", style = MaterialTheme.typography.labelMedium, color = Palette.gajaeRed)
            kind.stopReason == "cancelled" -> Text("중단됨", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
            kind.stopReason != "end_turn" -> Text("종료: ${kind.stopReason}", style = MaterialTheme.typography.labelMedium, color = Palette.strawGold)
        }
        is TranscriptItem.Kind.Notice -> Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Info, contentDescription = null, tint = Palette.muted, modifier = Modifier.size(14.dp))
            Text(" ${kind.text}", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
        }
    }
}

/**
 * Inline markdown (**bold**, `code`, links) per paragraph; fenced code blocks render monospaced in a card.
 * One SelectionContainer for the whole message so a drag can select across paragraphs and code blocks;
 * links open in the default browser through the platform UriHandler.
 */
@Composable
private fun MarkdownText(text: String) {
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            markdownSegments(text).forEach { (code, body) ->
                if (code) {
                    Box(Modifier.fillMaxWidth().card().horizontalScroll(rememberScrollState()).padding(10.dp)) {
                        Text(body, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = Palette.cream)
                    }
                } else {
                    Text(inlineMarkdown(body), color = Palette.cream)
                }
            }
        }
    }
}

internal fun markdownSegments(text: String): List<Pair<Boolean, String>> {
    val result = mutableListOf<Pair<Boolean, String>>()
    var inCode = false
    val buffer = mutableListOf<String>()
    fun flush() {
        val joined = buffer.joinToString("\n")
        if (joined.isNotBlank()) result += inCode to joined
        buffer.clear()
    }
    for (line in text.split("\n")) {
        if (line.trim().startsWith("```")) {
            flush()
            inCode = !inCode
        } else {
            buffer += line
        }
    }
    flush()
    return result
}

private val linkStyles = TextLinkStyles(SpanStyle(color = Palette.strawGold, textDecoration = TextDecoration.Underline))
private val bareUrl = Regex("""https?://[^\s<>()\[\]"'`]+""")

/** `[label](https://…)` at [start], as (label, url, end index). */
private fun markdownLink(text: String, start: Int): Triple<String, String, Int>? {
    if (text[start] != '[') return null
    val close = text.indexOf("](", start + 1).takeIf { it > start + 1 } ?: return null
    if (text.indexOf('\n', start).let { it in start until close }) return null
    val end = text.indexOf(')', close + 2).takeIf { it > close + 2 } ?: return null
    val url = text.substring(close + 2, end)
    if (!url.startsWith("http://") && !url.startsWith("https://") || url.any { it.isWhitespace() }) return null
    return Triple(text.substring(start + 1, close), url, end + 1)
}

/** A bare http(s) URL at [start], without trailing sentence punctuation. */
private fun bareLink(text: String, start: Int): String? {
    if (!text.startsWith("http", start) || (start > 0 && text[start - 1].isLetterOrDigit())) return null
    val match = bareUrl.matchAt(text, start) ?: return null
    return match.value.trimEnd('.', ',', ';', ':', '!', '?').takeIf { it.length > "https://".length - 1 }
}

/**
 * Inline markdown: **bold**, `code`, `[label](url)` and bare URLs; links carry a [LinkAnnotation.Url].
 * [styles] false keeps typed text literal and only links URLs (the user's own messages).
 */
internal fun inlineMarkdown(text: String, styles: Boolean = true): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < text.length) {
        val link = if (styles) markdownLink(text, i) else null
        val bare = if (link == null) bareLink(text, i) else null
        when {
            link != null -> {
                withLink(LinkAnnotation.Url(link.second, linkStyles)) { append(link.first) }
                i = link.third
            }
            bare != null -> {
                withLink(LinkAnnotation.Url(bare, linkStyles)) { append(bare) }
                i += bare.length
            }
            styles && text.startsWith("**", i) && text.indexOf("**", i + 2) > i + 2 -> {
                val end = text.indexOf("**", i + 2)
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text.substring(i + 2, end)) }
                i = end + 2
            }
            styles && text[i] == '`' && text.indexOf('`', i + 1) > i + 1 -> {
                val end = text.indexOf('`', i + 1)
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Palette.shell, color = Palette.strawGold)) { append(text.substring(i + 1, end)) }
                i = end + 1
            }
            else -> {
                append(text[i])
                i++
            }
        }
    }
}

/** Global like the TUI's Ctrl+T: on shows reasoning in full, off folds it behind a tap. */
@Composable
private fun ThoughtView(text: String, show: Boolean) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier.then(if (show) Modifier else Modifier.clickable { expanded = !expanded }),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("추론", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
            if (!show) Icon(if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = Palette.muted, modifier = Modifier.size(16.dp))
        }
        if (show || expanded) SelectionContainer { Text(inlineMarkdown(text), style = MaterialTheme.typography.bodySmall, color = Palette.muted) }
    }
}

@Composable
private fun ToolCallView(call: ToolCall) {
    var expanded by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().card(stroke = if (call.status == "failed") Palette.gajaeRed else Palette.shellLine).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(Modifier.fillMaxWidth().clickable { expanded = !expanded }, verticalAlignment = Alignment.CenterVertically) {
            when (call.status) {
                "completed" -> Icon(Icons.Filled.CheckCircle, contentDescription = "완료", tint = Palette.visorGreen, modifier = Modifier.size(16.dp))
                "failed" -> Icon(Icons.Filled.Warning, contentDescription = "실패", tint = Palette.gajaeRed, modifier = Modifier.size(16.dp))
                else -> CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = Palette.strawGold)
            }
            Text(
                "  " + call.title, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelMedium, color = Palette.cream,
                maxLines = if (expanded) Int.MAX_VALUE else 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Icon(if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = Palette.muted, modifier = Modifier.size(16.dp))
        }
        if (expanded) {
            call.rawInput?.let { SelectionContainer { Text(it.prettyText, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, color = Palette.muted) } }
            if (call.output.isNotEmpty()) {
                Box(Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState())) {
                    SelectionContainer { Text(call.output.takeLast(8000), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, color = Palette.cream) }
                }
            }
        }
    }
}

@Composable
private fun PlanView(entries: List<PlanEntry>) {
    Column(Modifier.fillMaxWidth().card().padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("계획", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = Palette.strawGold)
        entries.forEach { entry ->
            val done = entry.status == "completed"
            Text(
                (when (entry.status) { "completed" -> "☑ "; "in_progress" -> "▶ "; else -> "☐ " }) + entry.content,
                style = MaterialTheme.typography.labelMedium,
                color = if (done) Palette.muted else Palette.cream,
                textDecoration = if (done) TextDecoration.LineThrough else null,
            )
        }
    }
}

@Composable
private fun AttachmentView(attachment: Attachment) {
    when (val kind = attachment.kind) {
        is Attachment.Kind.Image -> {
            val bitmap = remember(kind.base64) {
                runCatching { Base64.getDecoder().decode(kind.base64) }.getOrNull()?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            }
            bitmap?.let { Image(it.asImageBitmap(), contentDescription = attachment.name, modifier = Modifier.widthIn(max = 220.dp).heightIn(max = 220.dp).clip(CardShape)) }
        }
        is Attachment.Kind.File -> Text(
            "📄 " + attachment.name + (kind.size?.let { " · " + formatBytes(it) } ?: ""),
            style = MaterialTheme.typography.labelMedium, modifier = Modifier.card().padding(8.dp),
        )
        is Attachment.Kind.EmbeddedText -> Text("📄 " + attachment.name, style = MaterialTheme.typography.labelMedium, modifier = Modifier.card().padding(8.dp))
    }
}

@Composable
private fun PermissionCard(request: PermissionRequest, modifier: Modifier = Modifier, onChoose: (PermissionOption?) -> Unit) {
    Column(modifier.fillMaxWidth().card(stroke = Palette.strawGold).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("승인 필요", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = Palette.strawGold)
        Text(request.title, fontFamily = FontFamily.Monospace, color = Palette.cream)
        request.detail?.let {
            Box(Modifier.heightIn(max = 120.dp).verticalScroll(rememberScrollState())) {
                SelectionContainer { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
            }
        }
        // One full-width row per choice: ask labels are often long sentences that a single row cuts off.
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            request.options.forEach { option ->
                val label = @Composable { Text(option.name, Modifier.fillMaxWidth()) }
                if (option.isAllow) {
                    Button(
                        onClick = { onChoose(option) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = if (option.kind == "allow_always") Palette.strawGold else Palette.visorGreen, contentColor = Palette.ink),
                    ) { label() }
                } else {
                    OutlinedButton(
                        onClick = { onChoose(option) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.gajaeRed),
                    ) { label() }
                }
            }
        }
    }
}

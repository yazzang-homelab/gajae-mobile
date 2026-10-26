package dev.gajae.gjcmobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.gajae.gjcmobile.core.BtwConversation

private val BubbleShape = RoundedCornerShape(22.dp)

/**
 * The `/btw` side chat as a speech bubble floating over the chat: its own composer, answered from the
 * session's visible conversation (`turn.btw`) and never written to the transcript.
 * 닫기 drops it, the composer asks a follow-up, 포크 continues it in a copy of the session.
 */
@Composable
fun BtwBubble(chat: ChatModel, conversation: BtwConversation) {
    Dialog(
        onDismissRequest = { chat.closeBtw() },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.55f))
                .clickable(remember { MutableInteractionSource() }, indication = null) { chat.closeBtw() }
                .imePadding(),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier.padding(20.dp).fillMaxWidth().heightIn(max = 520.dp)
                    .background(Palette.shell, BubbleShape)
                    .border(1.dp, Palette.strawGold.copy(alpha = 0.7f), BubbleShape)
                    .clickable(remember { MutableInteractionSource() }, indication = null) {}
                    .testTag("btw-bubble"),
            ) {
                Header(chat, conversation)
                Exchanges(conversation, Modifier.weight(1f, fill = false))
                Input(chat, conversation)
            }
        }
    }
}

@Composable
private fun Header(chat: ChatModel, conversation: BtwConversation) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("/btw 사이드 대화", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = Palette.cream)
            Text("본 대화를 참고하지만 기록에는 남지 않습니다", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
        }
        OutlinedButton(
            onClick = { chat.launchForkBtw() },
            enabled = conversation.hasAnswer && !conversation.isPending && !chat.sending,
        ) { Text(if (chat.sending) "포크 중…" else "포크", color = Palette.strawGold) }
        IconButton(onClick = { chat.closeBtw() }) { Icon(Icons.Filled.Close, contentDescription = "사이드 대화 닫기", tint = Palette.muted) }
    }
}

@Composable
private fun Exchanges(conversation: BtwConversation, modifier: Modifier) {
    val listState = rememberLazyListState()
    LaunchedEffect(conversation) {
        if (conversation.exchanges.isNotEmpty()) listState.animateScrollToItem(conversation.exchanges.size - 1)
    }
    LazyColumn(
        modifier.fillMaxWidth(),
        state = listState,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (conversation.exchanges.isEmpty()) item {
            Text("진행 중인 작업을 멈추지 않고 잠깐 물어볼 수 있습니다.", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
        }
        items(conversation.exchanges, key = { it.id }) { exchange ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(Modifier.fillMaxWidth()) {
                    Spacer(Modifier.weight(1f).widthIn(min = 40.dp))
                    Text(
                        exchange.question, color = Palette.ink,
                        modifier = Modifier.background(Palette.cream, RoundedCornerShape(14.dp)).padding(10.dp),
                    )
                }
                when {
                    exchange.answer != null -> SelectionContainer { Text(exchange.answer, color = Palette.cream) }
                    exchange.error != null -> Text(exchange.error, style = MaterialTheme.typography.labelMedium, color = Palette.gajaeRed)
                    else -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = Palette.strawGold)
                        Text("답변 중", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
                    }
                }
            }
        }
    }
}

@Composable
private fun Input(chat: ChatModel, conversation: BtwConversation) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (conversation.exchanges.isEmpty()) focus.requestFocus() }
    val canAsk = chat.connected && !conversation.isPending && chat.btwDraft.isNotBlank()
    Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.Bottom) {
        OutlinedTextField(
            value = chat.btwDraft,
            onValueChange = { chat.btwDraft = it },
            placeholder = { Text(if (conversation.exchanges.isEmpty()) "잠깐 물어볼 것" else "이어서 묻기", color = Palette.muted) },
            maxLines = 4,
            modifier = Modifier.weight(1f).focusRequester(focus).testTag("btw-input"),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Palette.strawGold, unfocusedBorderColor = Palette.shellLine,
                focusedTextColor = Palette.cream, unfocusedTextColor = Palette.cream, cursorColor = Palette.strawGold,
            ),
        )
        IconButton(onClick = { chat.launchAskBtw() }, enabled = canAsk) {
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "사이드 질문 보내기", tint = if (canAsk) Palette.strawGold else Palette.muted)
        }
    }
}

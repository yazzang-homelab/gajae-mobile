package dev.gajae.gjcmobile.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.gajae.gjcmobile.core.PairedHost
import dev.gajae.gjcmobile.core.SessionSummary
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun RootScreen(model: AppModel) {
    if (model.showPairing || model.hosts.isEmpty()) {
        PairingScreen(model, onClose = if (model.hosts.isEmpty()) null else ({ model.showPairing = false }))
        return
    }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val connection = model.selectedConnection ?: model.hosts.first().let { model.selectedHostId = it.hostId; model.connection(it) }
    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = Palette.ink, modifier = Modifier.width(320.dp)) {
                Sidebar(model, connection, onClose = { scope.launch { drawer.close() } })
            }
        },
    ) {
        HostHome(model, connection, onOpenSidebar = { scope.launch { drawer.open() } })
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Sidebar(model: AppModel, connection: HostConnection, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var query by remember(connection.host.hostId) { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var pendingDelete by remember { mutableStateOf<SessionSummary?>(null) }
    var pendingForget by remember { mutableStateOf<PairedHost?>(null) }
    var menuFor by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(query, connection) {
        delay(300)
        connection.search(query)
    }

    LazyColumn(Modifier.fillMaxHeight().background(Palette.ink).padding(horizontal = 12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 8.dp)) {
                Text("가재코드", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = "사이드바 닫기") }
            }
            SectionHeader("호스트")
        }
        items(model.hosts, key = { it.hostId }) { host ->
            val hostConnection = model.connection(host)
            val selected = host.hostId == connection.host.hostId
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clip(CardShape)
                    .background(if (selected) Palette.shellLine else Palette.shell)
                    .combinedClickable(onClick = { model.selectedHostId = host.hostId; hostConnection.ensureConnected() }, onLongClick = { pendingForget = host })
                    .padding(12.dp),
            ) {
                HostRow(hostConnection, Modifier.weight(1f))
                if (hostConnection.permissions.isNotEmpty()) {
                    Icon(Icons.Filled.Warning, contentDescription = "승인 대기 ${hostConnection.permissions.size}건", tint = Palette.strawGold)
                }
                if (selected) Icon(Icons.Filled.Check, contentDescription = "선택됨", tint = Palette.gajaeRed)
                IconButton(onClick = { pendingForget = host }) { Icon(Icons.Filled.Delete, contentDescription = "호스트 삭제", tint = Palette.muted) }
            }
            Spacer(Modifier.size(6.dp))
        }
        item {
            TextButton(onClick = { model.showPairing = true; onClose() }) {
                Icon(Icons.Filled.Add, contentDescription = null, tint = Palette.strawGold)
                Text(" 호스트 추가", color = Palette.strawGold)
            }
            HorizontalDivider(color = Palette.shellLine, modifier = Modifier.padding(vertical = 8.dp))
            TextButton(onClick = { connection.startNewChat(connection.activeChat?.cwd); onClose() }) {
                Icon(Icons.Filled.Create, contentDescription = null, tint = Palette.cream)
                Text(" 새 채팅", color = Palette.cream)
            }
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("세션 검색 · 제목·ID·디렉터리") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
            )
        }
        if (connection.permissions.isNotEmpty()) {
            item { SectionHeader("승인 대기") }
            items(connection.permissions, key = { "p" + it.requestId }) { request ->
                TextButton(onClick = {
                    connection.sessions.firstOrNull { it.sessionId == request.sessionId }?.let { connection.activeChat = connection.chat(it); onClose() }
                }) { Text(request.title, color = Palette.strawGold, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        item {
            SectionHeader(if (connection.searchQuery.isEmpty()) "${connection.host.name} · 최근 세션" else "'${connection.searchQuery}' 검색 결과")
        }
        items(connection.sessions, key = { it.sessionId }) { session ->
            Box {
                SessionRow(
                    session,
                    Modifier.fillMaxWidth().clip(CardShape)
                        .background(if (session.sessionId == connection.activeChat?.sessionId) Palette.shellLine else Palette.shell)
                        .combinedClickable(
                            onClick = { connection.activeChat = connection.chat(session); onClose() },
                            onLongClick = { menuFor = session.sessionId },
                        )
                        .padding(12.dp),
                )
                DropdownMenu(expanded = menuFor == session.sessionId, onDismissRequest = { menuFor = null }) {
                    DropdownMenuItem(text = { Text("세션 ID 복사") }, onClick = { clipboard.setText(AnnotatedString(session.sessionId)); menuFor = null })
                    DropdownMenuItem(text = { Text("디렉터리 복사") }, onClick = { clipboard.setText(AnnotatedString(session.cwd)); menuFor = null })
                    DropdownMenuItem(
                        text = { Text("삭제", color = Palette.gajaeRed) },
                        enabled = session.running != true,
                        onClick = { pendingDelete = session; menuFor = null },
                    )
                }
            }
            Spacer(Modifier.size(6.dp))
            if (session.sessionId == connection.sessions.lastOrNull()?.sessionId) {
                LaunchedEffect(session.sessionId) { connection.loadMoreSessions() }
            }
        }
        item {
            if (connection.loadingMore) CircularProgressIndicator(Modifier.padding(12.dp))
            if (connection.nextCursor == null && connection.sessions.isNotEmpty()) {
                Text("세션 ${connection.sessions.size}개 · 호스트 ~/.gjc/agent/sessions", style = MaterialTheme.typography.labelSmall, color = Palette.muted, modifier = Modifier.padding(vertical = 8.dp))
            }
        }
    }

    pendingDelete?.let { session ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("이 세션을 삭제할까요?") },
            text = { Text("${session.title ?: session.sessionId}\n호스트의 gjc 세션 기록이 지워집니다.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    scope.launch { runCatching { connection.delete(session.sessionId) }.onFailure { error = it.userMessage() } }
                }) { Text("삭제", color = Palette.gajaeRed) }
            },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("취소") } },
        )
    }
    pendingForget?.let { host ->
        AlertDialog(
            onDismissRequest = { pendingForget = null },
            title = { Text("이 호스트를 삭제할까요?") },
            text = { Text("${host.name}\n이 기기의 페어링만 지워집니다. 다시 쓰려면 QR로 다시 페어링하세요.") },
            confirmButton = { TextButton(onClick = { pendingForget = null; model.forget(host) }) { Text("삭제", color = Palette.gajaeRed) } },
            dismissButton = { TextButton(onClick = { pendingForget = null }) { Text("취소") } },
        )
    }
    error?.let {
        AlertDialog(
            onDismissRequest = { error = null },
            title = { Text("오류") },
            text = { Text(it) },
            confirmButton = { TextButton(onClick = { error = null }) { Text("확인") } },
        )
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = Palette.muted, modifier = Modifier.padding(vertical = 8.dp))
}

@Composable
fun HostRow(connection: HostConnection, modifier: Modifier = Modifier) {
    val (color, label) = when (val s = connection.status) {
        HostConnection.Status.Connected -> Palette.visorGreen to "연결됨"
        HostConnection.Status.Connecting -> Palette.strawGold to "연결 중…"
        HostConnection.Status.Idle -> Palette.muted to "대기"
        is HostConnection.Status.Failed -> Palette.gajaeRed to s.reason
    }
    Column(modifier) {
        Text(connection.host.name, color = Palette.cream, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).clip(CircleShape).background(color))
            Text(" $label", style = MaterialTheme.typography.labelSmall, color = Palette.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

fun displayPath(path: String): String {
    val parts = path.split('/').filter { it.isNotEmpty() }
    return if (parts.size > 3) "…/" + parts.takeLast(3).joinToString("/") else path
}

/** Coarse on purpose: enough to tell a fresh session from an old one, never ticking seconds. */
fun sessionAge(date: Instant, now: Instant = Instant.now()): String {
    val minutes = Duration.between(date, now).toMinutes()
    return when {
        minutes < 1 -> "방금"
        minutes < 60 -> "${minutes}분 전"
        minutes < 60 * 24 -> "${minutes / 60}시간 전"
        minutes < 60 * 24 * 30 -> "${minutes / (60 * 24)}일 전"
        else -> DateTimeFormatter.ofPattern("yyyy. M. d.").withZone(ZoneId.systemDefault()).format(date)
    }
}

@Composable
fun SessionRow(session: SessionSummary, modifier: Modifier = Modifier) {
    val now by produceState(Instant.now()) {
        while (true) {
            delay(60_000)
            value = Instant.now()
        }
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(session.title ?: "제목 없음", color = Palette.cream, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (session.running == true) {
                    val rate = session.tokensPerSecond?.takeIf { it > 0 }
                    Text(if (rate == null) "≈– tok/s" else "≈${Math.round(rate)} tok/s", style = MaterialTheme.typography.labelSmall, color = Palette.visorGreen)
                } else {
                    session.updatedInstant?.let { Text(sessionAge(it, now), style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
                }
                Text(displayPath(session.cwd), style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = Palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (session.running == true) {
            CircularProgressIndicator(Modifier.size(16.dp), color = Palette.visorGreen, strokeWidth = 2.dp)
        }
    }
}

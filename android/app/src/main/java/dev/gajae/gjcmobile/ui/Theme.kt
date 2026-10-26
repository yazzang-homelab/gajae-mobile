package dev.gajae.gjcmobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Colors measured from the gajae-code hero/logo art (brand/PALETTE.md). Dark theme only. */
object Palette {
    val gajaeRed = Color(0xFFEA4523)
    val strawGold = Color(0xFFED9324)
    val visorGreen = Color(0xFF25DF87)
    val cream = Color(0xFFF7E7D1)
    val ink = Color(0xFF0A0707)
    val shell = Color(0xFF1A1110)
    val shellLine = Color(0xFF3A2420)
    val muted = Color(0xFFA8968A)
}

val CardShape = RoundedCornerShape(14.dp)

fun Modifier.card(stroke: Color = Palette.shellLine): Modifier =
    background(Palette.shell, CardShape).border(BorderStroke(1.dp, stroke), CardShape)

@Composable
fun GjcTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Palette.gajaeRed,
            onPrimary = Palette.cream,
            secondary = Palette.strawGold,
            onSecondary = Palette.ink,
            tertiary = Palette.visorGreen,
            background = Palette.ink,
            onBackground = Palette.cream,
            surface = Palette.ink,
            onSurface = Palette.cream,
            surfaceVariant = Palette.shell,
            onSurfaceVariant = Palette.muted,
            surfaceContainer = Palette.shell,
            surfaceContainerHigh = Palette.shell,
            surfaceContainerHighest = Palette.shellLine,
            surfaceContainerLow = Palette.shell,
            outline = Palette.shellLine,
            outlineVariant = Palette.shellLine,
            error = Palette.gajaeRed,
        ),
        content = content,
    )
}

package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CodeInputFormatterTest {
    @Test
    fun typingUppercasesAndGroupsInFours() {
        assertEquals("4PUX", CodeInputFormatter.displayText(CodeInputFormatter.format("4pux").chars))
        assertEquals("4PUX-U", CodeInputFormatter.displayText(CodeInputFormatter.format("4puxu").chars))
        assertEquals("4PUX-U36F-4W", CodeInputFormatter.displayText(CodeInputFormatter.format("4puxu36f4w").chars))
        assertEquals("4PUXU36F4W", CodeInputFormatter.format("4puxu36f4w").chars)
        assertEquals("", CodeInputFormatter.displayText(CodeInputFormatter.format("").chars))
    }

    @Test
    fun deletingBackPastAHyphenDropsIt() {
        assertEquals("4PUX", CodeInputFormatter.displayText(CodeInputFormatter.format("4PUX-").chars))
    }

    @Test
    fun pasteOfAnySpacingAndCaseIsRegrouped() {
        for (pasted in listOf(" 4pux-u36f-4w ", "4 P U X U 3 6 F 4 W", "4PUXU36F4W\n", "4pux u36f 4w")) {
            val result = CodeInputFormatter.format(pasted)
            assertEquals(pasted, "4PUX-U36F-4W", CodeInputFormatter.displayText(result.chars))
            assertNull(pasted, result.invalid)
        }
    }

    @Test
    fun lIsValidButZeroOOneIAreNot() {
        assertNull(CodeInputFormatter.format("L").invalid)
        assertEquals(CodeInputFormatter.Invalid(3, "0"), CodeInputFormatter.format("4p0x").invalid)
        assertEquals(CodeInputFormatter.Invalid(5, "O"), CodeInputFormatter.format("4puxo").invalid)
        assertEquals(CodeInputFormatter.Invalid(1, "1"), CodeInputFormatter.format("1").invalid)
        assertEquals(CodeInputFormatter.Invalid(2, "I"), CodeInputFormatter.format("4i").invalid)
    }

    @Test
    fun badCharacterStaysVisibleAndFirstOneIsReported() {
        val result = CodeInputFormatter.format("4P0X-U1")
        assertEquals("4P0X-U1", CodeInputFormatter.displayText(result.chars))
        assertEquals(CodeInputFormatter.Invalid(3, "0"), result.invalid)
    }

    @Test
    fun inputIsCappedAtTheLongestCode() {
        val result = CodeInputFormatter.format("2".repeat(40))
        assertEquals(CodeInputFormatter.MAX_CHARS, result.chars.length)
        assertEquals("2222-2222-2222-22", CodeInputFormatter.displayText(result.chars))
    }

    @Test
    fun separatorsAreExactlyTheHyphenAndTheJsWhitespaceSet() {
        val separators = listOf('-', '\t', '\n', '\u000B', '\u000C', '\r', ' ', '\u00A0', '\u1680', '\u2000', '\u2005', '\u200A',
            '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF')
        for (sep in separators) {
            val result = CodeInputFormatter.format("4PUX${sep}U36F${sep}4W")
            assertEquals("U+%04X".format(sep.code), "4PUXU36F4W", result.chars)
            assertNull(result.invalid)
        }
        // Not separators: a zero-width space, NEL, a line-separator look-alike.
        for (other in listOf('\u200B', '\u0085', '\u200C', '\u2060')) {
            val result = CodeInputFormatter.format("4PUX${other}U36F4W")
            assertEquals(CodeInputFormatter.Invalid(5, other.toString()), result.invalid)
            assertEquals("4PUX${other}U36F", result.chars.substring(0, 9))
        }
    }

    @Test
    fun onlyAsciiLettersAreUppercased() {
        assertEquals("4PUXU36F4W", CodeInputFormatter.format("4pux-u36f-4w").chars)
        for (bad in listOf("\u00DF", "\u017F", "\uFF21", "\uFF41")) {
            val result = CodeInputFormatter.format("4PUX${bad}36F4W")
            assertEquals(bad, "4PUX${bad}36F4W", result.chars)
            assertEquals(bad, CodeInputFormatter.Invalid(5, bad), result.invalid)
        }
    }

    @Test
    fun aCharacterOutsideTheBmpIsOnePositionAndTheFieldShowsItAsReplacementCharacter() {
        val result = CodeInputFormatter.format("4P\uD83D\uDE00X")
        assertEquals("4P\uFFFDX", result.chars)
        assertEquals(CodeInputFormatter.Invalid(3, "\uD83D\uDE00"), result.invalid)
        // The field keeps only chars, so what the user sees (and the message built from it) is U+FFFD.
        assertEquals(CodeInputFormatter.Invalid(3, "\uFFFD"), CodeInputFormatter.format(result.chars).invalid)
    }

    @Test
    fun inputBeyondTheLongestCodeIsMarkedTruncated() {
        assertTrue(CodeInputFormatter.format("2".repeat(15)).truncated)
        assertTrue(CodeInputFormatter.format("2".repeat(14) + "x").truncated)
        assertFalse(CodeInputFormatter.format("2".repeat(14) + " - ").truncated)
        assertFalse(CodeInputFormatter.format("2".repeat(14)).truncated)
    }

    @Test
    fun typingAtTheEndMovesTheCursorWithTheText() {
        val edited = CodeInputFormatter.edit("4PUXU", 5, 5)!!
        assertEquals(CodeInputFormatter.Edited("4PUXU", 5, 5), edited)
    }

    @Test
    fun typingASeparatorInTheMiddleKeepsTheCursorBesideTheSameCharacter() {
        // "4PUXU" with a space typed after "4P": the cursor was at 3 in the raw text of 6 characters.
        assertEquals(CodeInputFormatter.Edited("4PUXU", 2, 2), CodeInputFormatter.edit("4P UXU", 3, 3))
        assertEquals(CodeInputFormatter.Edited("4PUXU", 2, 2), CodeInputFormatter.edit("4P-UXU", 3, 3))
    }

    @Test
    fun pastingWithSeparatorsInTheMiddleLandsAfterThePastedCharacters() {
        // "4P" + paste "U-X U" + "36F": the cursor is after the pasted text (raw offset 7).
        assertEquals(CodeInputFormatter.Edited("4PUXU36F", 5, 5), CodeInputFormatter.edit("4PU-X U36F", 7, 7))
    }

    @Test
    fun bothEndsOfASelectionAreMapped() {
        assertEquals(CodeInputFormatter.Edited("4PUXU", 1, 4), CodeInputFormatter.edit("4- PUX-U", 3, 7))
    }

    @Test
    fun insertingInTheMiddleOfAFullCodeIsRejected() {
        val full = "2".repeat(CodeInputFormatter.MAX_CHARS)
        assertNull(CodeInputFormatter.edit(full.substring(0, 5) + "3" + full.substring(5), 6, 6))
        assertNull(CodeInputFormatter.edit(full + "3", 15, 15))
        // A separator typed into a full code adds no character and is accepted.
        assertEquals(CodeInputFormatter.Edited(full, 5, 5), CodeInputFormatter.edit(full.substring(0, 5) + "-" + full.substring(5), 6, 6))
    }

    @Test
    fun aNormalEditIsReturnedUnchangedSoTheFieldCanKeepTheImeComposition() {
        // The field keeps the IME's value (and its composition) exactly when the text and selection come back unchanged.
        for ((text, start, end) in listOf(Triple("4PUXU", 2, 2), Triple("4PUXU", 1, 4), Triple("4PUXU", 4, 1), Triple("", 0, 0))) {
            assertEquals(CodeInputFormatter.Edited(text, start, end), CodeInputFormatter.edit(text, start, end))
        }
    }

    @Test
    fun theLineUnderTheFieldNamesTheBadCharacterFirstThenARefusedLongInput() {
        val bad = CodeInputFormatter.format("4PO").invalid
        assertEquals("3번째 글자 'O'는 코드에 쓰지 않습니다. 0·O·1·I는 코드에 없습니다.", CodeInputFormatter.message(bad, tooLong = true))
        assertEquals("코드는 최대 14자입니다. 호스트에 나온 코드만 입력하세요.", CodeInputFormatter.message(null, tooLong = true))
        assertNull(CodeInputFormatter.message(null, tooLong = false))
    }

    @Test
    fun aCharacterOutsideTheBmpBeforeTheCursorCountsOnce() {
        assertEquals(CodeInputFormatter.Edited("4P\uFFFDX", 3, 3), CodeInputFormatter.edit("4P\uD83D\uDE00X", 4, 4))
        // A cursor between the two halves of the pair is moved past the pair.
        assertEquals(CodeInputFormatter.Edited("4P\uFFFDX", 3, 3), CodeInputFormatter.edit("4P\uD83D\uDE00X", 3, 3))
    }

    @Test
    fun typingOneCharacterAtATimeKeepsTheOrder() {
        // The field's state is the raw characters, so appending never reorders them (the hyphens are only drawn).
        var state = ""
        for (c in "4pux-u36f-4w") state = CodeInputFormatter.format(state + c).chars
        assertEquals("4PUXU36F4W", state)
        assertEquals("4PUX-U36F-4W", CodeInputFormatter.displayText(state))
    }

    @Test
    fun displayOffsetsAtTheGroupBoundaries() {
        val expected = mapOf(0 to 0, 1 to 1, 4 to 4, 5 to 6, 8 to 9, 9 to 11, 12 to 14, 13 to 16, 14 to 17)
        for ((original, shown) in expected) assertEquals("original $original", shown, CodeInputFormatter.originalToTransformed(original))
        // A cursor beside a hyphen maps back to the group boundary, never past the text.
        val back = mapOf(0 to 0, 4 to 4, 5 to 4, 6 to 5, 9 to 8, 10 to 8, 11 to 9, 14 to 12, 17 to 14)
        for ((shown, original) in back) assertEquals("shown $shown", original, CodeInputFormatter.transformedToOriginal(shown, 14))
        assertEquals(3, CodeInputFormatter.transformedToOriginal(9, 3))
    }

    @Test
    fun offsetsRoundTripAndMatchTheDisplayedText() {
        for (n in 0..CodeInputFormatter.MAX_CHARS) {
            val raw = "2".repeat(n)
            val shown = CodeInputFormatter.displayText(raw)
            assertEquals(shown.length, CodeInputFormatter.originalToTransformed(n))
            var previous = -1
            for (offset in 0..n) {
                val t = CodeInputFormatter.originalToTransformed(offset)
                assertEquals("n=$n offset=$offset", offset, CodeInputFormatter.transformedToOriginal(t, n))
                assertTrue(t > previous)
                assertTrue(t <= shown.length)
                previous = t
            }
            for (t in 0..shown.length) assertTrue(CodeInputFormatter.transformedToOriginal(t, n) in 0..n)
        }
    }
}

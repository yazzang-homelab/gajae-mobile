package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class InlineImageBudgetTest {
    @Test
    fun photosUnderTheBudgetKeepTheirSize() {
        assertEquals(listOf<Int?>(null, null), AttachmentLimits.inlineImageTargets(listOf(60_000, 100_000), budget = 180_000))
    }

    @Test
    fun onePhotoOverTheBudgetIsReEncodedToAllOfIt() {
        assertEquals(listOf<Int?>(180_000), AttachmentLimits.inlineImageTargets(listOf(700_000), budget = 180_000))
    }

    @Test
    fun aSmallPhotoLeavesItsUnusedShareToTheLargeOnes() {
        // An even share is 60 KB; the 20 KB photo keeps its size, the other two split the remaining 160 KB.
        assertEquals(listOf(80_000, null, 80_000), AttachmentLimits.inlineImageTargets(listOf(500_000, 20_000, 300_000), budget = 180_000))
    }

    @Test
    fun targetsTogetherStayWithinTheBudget() {
        val sizes = listOf(900_000, 31_000, 47_000, 2_000_000)
        val targets = AttachmentLimits.inlineImageTargets(sizes, budget = 180_000)
        assertTrue(sizes.zip(targets).sumOf { (size, target) -> target ?: size } <= 180_000)
        assertEquals(listOf(null, null), listOf(targets[1], targets[2]))
    }

    @Test
    fun aShortTextLeavesThePhotosTheFullBudget() {
        assertEquals(AttachmentLimits.MAX_INLINE_IMAGE_BYTES, AttachmentLimits.inlineImageBudget("이거 봐", images = 3, files = 1))
    }

    @Test
    fun theTextIsMeasuredAsTheBridgeMeasuresIt() {
        // 가 is 3 bytes in UTF-8; a quote and a newline are escaped to 2; other control characters to \u00XX.
        assertEquals(3 + 2 + 2 + 6 + 1 + 4, AttachmentLimits.jsonStringBytes("가\"\n\u0001a\uD83D\uDE00"))
    }

    /** Whatever the text, the blocks the bridge measures stay under its limit when the photos fill their budget. */
    @Test
    fun aLongTextShrinksThePhotoBudgetToFitTheBridgeLimit() {
        for (text in listOf("a".repeat(60_000), "가".repeat(25_000), "\"\n".repeat(20_000))) {
            for (images in 1..4) {
                val budget = AttachmentLimits.inlineImageBudget(text, images, files = 0)!!
                assertTrue(budget < AttachmentLimits.MAX_INLINE_IMAGE_BYTES)
                val photos = AttachmentLimits.inlineImageTargets(List(images) { 1_000_000 }, budget)
                val blocks = JsonArray(
                    listOf(buildJsonObject { put("type", "text"); put("text", text) }) + photos.map { size ->
                        buildJsonObject {
                            put("type", "image"); put("mimeType", "image/jpeg")
                            put("data", Base64.getEncoder().encodeToString(ByteArray(size!!) { -1 }))
                        }
                    },
                )
                val bytes = blocks.toString().toByteArray().size
                assertTrue("${text.length} chars, $images photos: $bytes", bytes <= AttachmentLimits.PROMPT_BYTES_LIMIT)
            }
        }
    }

    @Test
    fun tooManyPhotosAreToldApartFromATooLongText() {
        // 18 photos of 10 KB fill the 180 KB budget; a 19th leaves each too little to stay readable.
        assertTrue(AttachmentLimits.inlineImageBudget("", images = 18, files = 0) != null)
        assertTrue(AttachmentLimits.noRoomError(images = 19, files = 0) is TooManyPhotos)
        assertTrue(AttachmentLimits.noRoomError(images = 1, files = 0) is TextCrowdsOutPhotos)
    }

    @Test
    fun aTextThatLeavesNoRoomRefusesThePhotos() {
        val text = "a".repeat(255_000)
        assertNull(AttachmentLimits.inlineImageBudget(text, images = 1, files = 0))
    }
}

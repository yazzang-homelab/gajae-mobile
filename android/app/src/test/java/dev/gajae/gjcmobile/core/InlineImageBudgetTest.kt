package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

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
}

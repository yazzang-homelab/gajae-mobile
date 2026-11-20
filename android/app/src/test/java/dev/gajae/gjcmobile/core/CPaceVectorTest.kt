package dev.gajae.gjcmobile.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

internal fun hexBytes(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

/** Replays fixtures/cpace-vector.json (written by bridge/test/gen-cpace-vector.ts) against the Kotlin CPace. */
class CPaceVectorTest {
    private val vector = parseJson(File(System.getProperty("gjcm.fixtures"), "cpace-vector.json").readText())
    private fun hex(s: String?) = hexBytes(s!!)

    @Test
    fun fixturePinsTheDraft() {
        assertEquals("draft-irtf-cfrg-cpace-21", vector["spec"]["draft"].str)
        assertTrue(Regex("[0-9a-f]{64}").matches(vector["spec"]["sha256"].str!!))
    }

    @Test
    fun prependLenAndLvCat() {
        assertEquals("00", CPace.prependLen(ByteArray(0)).toHex())
        assertEquals("0431323334", CPace.prependLen("1234".toByteArray()).toHex())
        assertEquals("7f", CPace.prependLen(ByteArray(127)).toHex().substring(0, 2))
        assertEquals("8001", CPace.prependLen(ByteArray(128)).toHex().substring(0, 4))
        assertEquals(
            "043132333401350003363738",
            CPace.lvCat("1234".toByteArray(), "5".toByteArray(), ByteArray(0), "678".toByteArray()).toHex(),
        )
    }

    @Test
    fun draftB11Generator() {
        val g = vector["draft"]["generator"]
        assertEquals(g["generatorString"].str, CPace.generatorString(CPace.DSI, hex(g["prs"].str), hex(g["ci"].str), hex(g["sid"].str)).toHex())
        assertEquals(g["u"].str, CPace.encodeLittleEndian(CPace.decodeUCoordinate(hex(g["hash"].str))).toHex())
        assertEquals(g["g"].str, CPace.calculateGenerator(hex(g["prs"].str), hex(g["ci"].str), hex(g["sid"].str)).toHex())
    }

    @Test
    fun draftB12ToB15MessagesKAndIsk() {
        val e = vector["draft"]["exchange"]
        val g = hex(e["g"].str)
        val ya = CPace.x25519(hex(e["ya"].str), g)!!
        val yb = CPace.x25519(hex(e["yb"].str), g)!!
        assertEquals(e["Ya"].str, ya.toHex())
        assertEquals(e["Yb"].str, yb.toHex())
        assertEquals(e["K"].str, CPace.x25519(hex(e["ya"].str), yb)!!.toHex())
        assertEquals(e["K"].str, CPace.x25519(hex(e["yb"].str), ya)!!.toHex())
        assertEquals(
            e["transcriptIr"].str,
            (CPace.lvCat(ya, hex(e["ADa"].str)) + CPace.lvCat(yb, hex(e["ADb"].str))).toHex(),
        )
        assertEquals(e["ISK"].str, CPace.deriveIsk(hex(e["sid"].str), hex(e["K"].str), ya, hex(e["ADa"].str), yb, hex(e["ADb"].str)).toHex())
        // The same through the protocol objects, with the draft's scalars and AD.
        val a = CPaceInitiator(hex(e["prs"].str), sid = hex(e["sid"].str), scalar = hex(e["ya"].str), ci = hex(e["ci"].str), ad = hex(e["ADa"].str))
        val b = CPaceResponder.start(
            hex(e["prs"].str), hex(e["sid"].str), a.ya,
            ci = hex(e["ci"].str), scalar = hex(e["yb"].str), ad = hex(e["ADb"].str), peerAd = hex(e["ADa"].str),
        )!!
        assertEquals(e["ISK"].str, b.isk.toHex())
        assertEquals(e["ISK"].str, a.finish(b.yb, hex(e["ADb"].str))!!.isk.toHex())
    }

    @Test
    fun draftB110LowOrderPointsAbortAndTheRestMatch() {
        val s = hex(vector["draft"]["lowOrder"]["s"].str)
        val cases = vector["draft"]["lowOrder"]["cases"].array!!
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val out = CPace.x25519(s, hex(c["u"].str))
            assertEquals("u=${c["u"].str}", c["q"].str, out?.toHex())
        }
        // The abort cases also stop either side of the protocol.
        val sid = ByteArray(16) { 7 }
        for (c in cases.filter { it["q"].str == null }) {
            val u = hex(c["u"].str)
            assertNull(CPaceResponder.start("X".toByteArray(), sid, u))
            assertNull(CPaceInitiator("X".toByteArray()).finish(u))
        }
    }

    @Test
    fun elligator2MapMatchesTheIndependentReference() {
        val map = vector["map"].array!!
        assertTrue(map.size >= 17)
        for (m in map) assertEquals("u=${m["u"].str}", m["g"].str, CPace.elligator2(hex(m["u"].str)).toHex())
    }

    @Test
    fun generatorsForTheCodeChannelMatchTheIndependentReference() {
        val generators = vector["generator"].array!!
        assertTrue(generators.size >= 200)
        for (g in generators) assertEquals(g["g"].str, CPace.calculateGenerator(hex(g["prs"].str), CPace.CODE_CI, hex(g["sid"].str)).toHex())
    }

    @Test
    fun x25519VectorsAbortAsNull() {
        val vectors = vector["x25519"].array!!
        assertTrue(vectors.any { it["out"].str == null })
        assertTrue(vectors.any { it["out"].str != null })
        for (x in vectors) {
            val out = CPace.x25519(hex(x["k"].str), hex(x["u"].str))
            assertEquals("u=${x["u"].str}", x["out"].str, out?.toHex())
        }
    }

    @Test
    fun fullTransactionFromSidToBox() {
        val t = vector["transaction"]
        val code = t["code"].str!!.toByteArray(Charsets.UTF_8)
        val a = CPaceInitiator(code, sid = hex(t["sid"].str), scalar = hex(t["ya"].str))
        assertEquals(t["Ya"].str, a.ya.toHex())
        val b = CPaceResponder.start(code, hex(t["sid"].str), a.ya, scalar = hex(t["yb"].str))!!
        assertEquals(t["Yb"].str, b.yb.toHex())
        assertEquals(t["ISK"].str, b.isk.toHex())
        assertEquals(t["kSeal"].str, CPace.sealKey(b.isk).toHex())
        val session = a.finish(b.yb)!!
        assertEquals(t["Ta"].str, session.ta.toHex())
        val confirmed = b.confirm(session.ta)!!
        assertEquals(t["Tb"].str, confirmed.tb.toHex())
        assertTrue(session.verifyTb(confirmed.tb))
        assertEquals(t["box"].str, confirmed.seal(t["offer"].str!!.toByteArray(Charsets.UTF_8)).toHex())
        assertEquals(t["offer"].str, String(session.open(hex(t["box"].str))!!, Charsets.UTF_8))
    }

    @Test
    fun aWrongCodeFailsBothConfirmationsAndCannotOpenTheBox() {
        val a = CPaceInitiator("4PUXU36F4W".toByteArray())
        val b = CPaceResponder.start("4PUXU36F4X".toByteArray(), a.sid, a.ya)!!
        val session = a.finish(b.yb)!!
        assertNull(b.confirm(session.ta))
        val forced = b.confirmWithoutChecking()
        assertFalse(session.verifyTb(forced.tb))
        assertNull(session.open(forced.seal("offer".toByteArray())))
    }

    @Test
    fun aFreshResponderScalarGivesAFreshIskAndOneSealPerSession() {
        val a = CPaceInitiator("4PUXU36F4W".toByteArray())
        val first = CPaceResponder.start("4PUXU36F4W".toByteArray(), a.sid, a.ya)!!
        val second = CPaceResponder.start("4PUXU36F4W".toByteArray(), a.sid, a.ya)!!
        assertFalse(first.yb.contentEquals(second.yb))
        assertFalse(first.isk.contentEquals(second.isk))
        val confirmed = first.confirmWithoutChecking()
        confirmed.seal("x".toByteArray())
        assertThrows(IllegalStateException::class.java) { confirmed.seal("y".toByteArray()) }
    }

    @Test
    fun aTamperedOrShortBoxDoesNotOpen() {
        val a = CPaceInitiator("CODE".toByteArray())
        val b = CPaceResponder.start("CODE".toByteArray(), a.sid, a.ya)!!
        val box = b.confirmWithoutChecking().seal("offer".toByteArray())
        assertNotNull(CPace.openBox(b.isk, box))
        box[0] = (box[0].toInt() xor 1).toByte()
        assertNull(CPace.openBox(b.isk, box))
        assertNull(CPace.openBox(b.isk, ByteArray(3)))
    }

    @Test
    fun malformedInputsAbortInsteadOfThrowing() {
        assertNull(CPace.x25519(ByteArray(31), ByteArray(32) { 9 }))
        assertNull(CPaceResponder.start("CODE".toByteArray(), ByteArray(16), ByteArray(31)))
        assertNull(CPaceInitiator("CODE".toByteArray()).finish(ByteArray(33)))
    }

    @Test
    fun nonCanonicalPointsAreTakenModP() {
        val k = hex(vector["x25519"].array!![0]["k"].str)
        val u = hexBytes("09" + "00".repeat(31))
        val high = u.copyOf().also { it[31] = 0x80.toByte() } // bit 255 set: ignored
        assertArrayEquals(CPace.x25519(k, u), CPace.x25519(k, high))
    }
}

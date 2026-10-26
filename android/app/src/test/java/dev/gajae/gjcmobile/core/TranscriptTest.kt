package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptTest {
    private fun u(seq: Int, json: String) = SequencedUpdate(seq, parseJson(json))

    @Test
    fun foldsChunksToolsAndTurnEnd() {
        val t = SessionTranscript()
        t.apply(u(1, """{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}"""))
        t.apply(u(2, """{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"th"}}"""))
        t.apply(u(3, """{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"ink"}}"""))
        t.apply(u(4, """{"sessionUpdate":"tool_call","toolCallId":"t1","title":"bash","status":"pending"}"""))
        t.apply(u(5, """{"sessionUpdate":"tool_call_update","toolCallId":"t1","content":[{"content":{"text":"ok"}}]}"""))
        t.apply(u(6, """{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"가재"}}"""))
        t.apply(u(7, """{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" 🦞"}}"""))
        t.apply(u(7, """{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"dup"}}"""))
        t.markRunning()
        assertTrue(t.running)
        t.apply(u(8, """{"sessionUpdate":"x_gjcm_turn_end","stopReason":"end_turn"}"""))
        assertFalse(t.running)
        val kinds = t.items.map { it.kind }
        assertEquals(TranscriptItem.Kind.User("hi", emptyList()), kinds[0])
        assertEquals(TranscriptItem.Kind.Thought("think"), kinds[1])
        val tool = (kinds[2] as TranscriptItem.Kind.Tool).call
        assertEquals("completed", tool.status)
        assertEquals("ok", tool.output)
        assertEquals(TranscriptItem.Kind.Agent("가재 🦞"), kinds[3])
        assertEquals(4, kinds.size)
        assertEquals(8, t.lastSeq)
    }

    @Test
    fun permissionModeCyclesAndFollowsSnapshotAndUpdates() {
        assertEquals(
            listOf(PermissionMode.Allow, PermissionMode.Deny, PermissionMode.Prompt),
            listOf(PermissionMode.Prompt.next, PermissionMode.Allow.next, PermissionMode.Deny.next),
        )
        val t = SessionTranscript()
        assertNull(t.permissionMode)
        // The snapshot's mode is the current one even when its replayed updates still carry an older change.
        val snapshot = OpenSnapshot.from(
            parseJson(
                """{"sessionId":"s","cwd":"/","configOptions":[],"running":false,"seq":1,"reset":true,"permissions":[],"permissionMode":"deny",
                   "updates":[{"seq":1,"update":{"sessionUpdate":"x_gjcm_permission_mode","mode":"allow"}}]}""",
            ),
        )
        t.apply(snapshot)
        assertEquals(PermissionMode.Deny, t.permissionMode)
        t.apply(u(2, """{"sessionUpdate":"x_gjcm_permission_mode","mode":"prompt"}"""))
        assertEquals(PermissionMode.Prompt, t.permissionMode)
        t.apply(u(3, """{"sessionUpdate":"x_gjcm_permission_mode","mode":"bogus"}"""))
        assertEquals(PermissionMode.Prompt, t.permissionMode)
        assertTrue(t.items.isEmpty())
    }

    @Test
    fun configOptionsParseGroupedChoices() {
        val option = ConfigOption.from(parseJson("""{"id":"model","name":"Model","currentValue":"b","options":[{"name":"G","options":[{"value":"a","name":"A"},{"value":"b","name":"B"}]}]}"""))!!
        assertEquals(listOf("a", "b"), option.choices.map { it.value })
        assertEquals("B", option.currentChoiceName)
        assertTrue(ConfigTarget.MODEL.matches(option))
    }
}

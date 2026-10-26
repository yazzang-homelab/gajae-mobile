package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BtwConversationTest {
    private fun BtwConversation.accept(text: String): Pair<BtwConversation, String> {
        val asked = ask(text) as BtwConversation.Asked.Accepted
        return asked.conversation to asked.input.encode()
    }

    @Test
    fun followUpsCarryOnlyAnsweredExchanges() {
        var (chat, input) = BtwConversation().accept("  비밀단어가 뭐였지? ")
        assertEquals("""{"question":"비밀단어가 뭐였지?"}""", input)
        assertTrue(chat.isPending)
        assertEquals(BtwConversation.Asked.Rejected(BtwConversation.Rejection.Busy), chat.ask("또?"))

        chat = chat.finish(parseJson("""{"replyText":" KIWI\n"}"""))
        assertFalse(chat.isPending)
        assertEquals("KIWI", chat.exchanges.first().answer)

        chat.accept("거꾸로 써").also { (next, json) ->
            assertEquals("""{"question":"거꾸로 써","exchanges":[{"question":"비밀단어가 뭐였지?","answer":"KIWI"}]}""", json)
            chat = next.fail("시간 초과")
        }
        assertEquals("시간 초과", chat.exchanges.last().error)

        // A failed question is shown but never sent back as context.
        chat.accept("다시").also { (next, json) ->
            assertEquals("""{"question":"다시","exchanges":[{"question":"비밀단어가 뭐였지?","answer":"KIWI"}]}""", json)
            chat = next.finish(parseJson("""{"replyText":"   "}"""))
        }
        assertEquals("빈 답변을 받았습니다.", chat.exchanges.last().error)
        assertEquals("방금 /btw 사이드 대화에서 이어서 진행합니다.\n\n질문: 비밀단어가 뭐였지?\n답변: KIWI\n\n", chat.forkDraft)
    }

    @Test
    fun rejectsEmptyAndOversizedQuestions() {
        val chat = BtwConversation()
        assertEquals(BtwConversation.Asked.Rejected(BtwConversation.Rejection.Empty), chat.ask(" \n"))
        assertEquals(BtwConversation.Asked.Rejected(BtwConversation.Rejection.TooLong(16384)), chat.ask("가".repeat(5462)))
        assertTrue(chat.ask("가".repeat(5461)) is BtwConversation.Asked.Accepted)
    }

    @Test
    fun composerTrigger() {
        assertEquals("", BtwConversation.trigger("/btw "))
        assertEquals("이거 뭐야", BtwConversation.trigger("/BTW 이거 뭐야"))
        assertNull(BtwConversation.trigger("/btw"))
        assertNull(BtwConversation.trigger("/btwx "))
        assertNull(BtwConversation.trigger("btw "))
    }
}

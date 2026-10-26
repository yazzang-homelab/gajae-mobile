package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The `/btw` side chat: questions answered from the session's visible conversation through
 * `_gjc/sdk/control` `turn.btw` (gjc local patch 0004). Nothing is written to the session transcript.
 *
 * The host is stateless: each call carries the earlier answered exchanges, so follow-ups keep context and
 * closing the bubble simply drops this value. Immutable so Compose state sees every change.
 * Mirrors ios/Core/Sources/GjcMobileCore/BtwConversation.swift.
 */
data class BtwConversation(val exchanges: List<Exchange> = emptyList()) {
    data class Exchange(val id: Int, val question: String, val answer: String? = null, val error: String? = null) {
        val isPending: Boolean get() = answer == null && error == null
    }

    sealed class Rejection(val message: String) {
        data object Empty : Rejection("질문을 입력하세요.")
        data object Busy : Rejection("앞 질문의 답을 기다리는 중입니다.")
        data class TooLong(val maxBytes: Int) : Rejection("질문은 ${maxBytes / 1024}KB까지 보낼 수 있습니다.")
    }

    sealed class Asked {
        data class Accepted(val conversation: BtwConversation, val input: JsonObject) : Asked()
        data class Rejected(val rejection: Rejection) : Asked()
    }

    val isPending: Boolean get() = exchanges.lastOrNull()?.isPending ?: false
    val hasAnswer: Boolean get() = exchanges.any { it.answer != null }

    /** Appends a pending question; [Asked.Accepted.input] is the `turn.btw` input (question + answered exchanges). */
    fun ask(text: String): Asked {
        val question = text.trim()
        if (question.isEmpty()) return Asked.Rejected(Rejection.Empty)
        if (isPending) return Asked.Rejected(Rejection.Busy)
        if (question.toByteArray(Charsets.UTF_8).size > MAX_QUESTION_BYTES) return Asked.Rejected(Rejection.TooLong(MAX_QUESTION_BYTES))
        val context = exchanges.mapNotNull { e ->
            e.answer?.let { JsonObject(mapOf("question" to JsonPrimitive(e.question), "answer" to JsonPrimitive(it))) }
        }
        val input = buildMap<String, JsonElement> {
            put("question", JsonPrimitive(question))
            if (context.isNotEmpty()) put("exchanges", JsonArray(context))
        }
        return Asked.Accepted(copy(exchanges = exchanges + Exchange(exchanges.size, question)), JsonObject(input))
    }

    /** Completes the pending question with the `turn.btw` result (`{ replyText }`). */
    fun finish(result: JsonElement): BtwConversation {
        val reply = result["replyText"].str?.trim().orEmpty()
        return if (reply.isEmpty()) fail("빈 답변을 받았습니다.") else resolve { it.copy(answer = reply) }
    }

    fun fail(message: String): BtwConversation = resolve { it.copy(error = message) }

    private fun resolve(change: (Exchange) -> Exchange): BtwConversation {
        val last = exchanges.lastOrNull()?.takeIf { it.isPending } ?: return this
        return copy(exchanges = exchanges.dropLast(1) + change(last))
    }

    /** Draft for the forked session: the side chat so far, for the user to edit and send there. */
    val forkDraft: String
        get() {
            val body = exchanges.mapNotNull { e -> e.answer?.let { "질문: ${e.question}\n답변: $it" } }.joinToString("\n\n")
            return "방금 /btw 사이드 대화에서 이어서 진행합니다.\n\n$body\n\n"
        }

    companion object {
        /** gjc's `BTW_MAX_QUESTION_UTF8_BYTES`. */
        const val MAX_QUESTION_BYTES = 16 * 1024

        /** The text after `/btw ` when the composer just turned into a side question, else `null`. */
        fun trigger(draft: String): String? {
            if (draft.length < 5 || !draft.substring(0, 4).equals("/btw", ignoreCase = true) || !draft[4].isWhitespace()) return null
            return draft.substring(5)
        }
    }
}

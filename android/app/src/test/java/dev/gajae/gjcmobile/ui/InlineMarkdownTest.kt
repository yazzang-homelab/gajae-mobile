package dev.gajae.gjcmobile.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import org.junit.Assert.assertEquals
import org.junit.Test

class InlineMarkdownTest {
    /** (linked text, url) pairs in order. */
    private fun links(s: AnnotatedString) = s.getLinkAnnotations(0, s.length).map {
        s.text.substring(it.start, it.end) to (it.item as LinkAnnotation.Url).url
    }

    @Test
    fun markdownLinkShowsLabelAndOpensUrl() {
        val s = inlineMarkdown("문서는 [가이드](https://example.com/a?b=1) 참고")
        assertEquals("문서는 가이드 참고", s.text)
        assertEquals(listOf("가이드" to "https://example.com/a?b=1"), links(s))
    }

    @Test
    fun bareUrlIsLinkedWithoutTrailingPunctuation() {
        val s = inlineMarkdown("PR: https://github.com/o/r/pull/12. 그리고 http://x.dev, 끝")
        assertEquals("PR: https://github.com/o/r/pull/12. 그리고 http://x.dev, 끝", s.text)
        assertEquals(
            listOf("https://github.com/o/r/pull/12" to "https://github.com/o/r/pull/12", "http://x.dev" to "http://x.dev"),
            links(s),
        )
    }

    @Test
    fun nonHttpTargetsAndBrokenSyntaxStayLiteral() {
        val text = "[a](file:///etc/passwd) [c](mailto:a@b) [d](https) shttp://no httpx 'http://'"
        val s = inlineMarkdown(text)
        assertEquals(text, s.text)
        assertEquals(emptyList<Pair<String, String>>(), links(s))
    }

    @Test
    fun userTextKeepsMarkupLiteralButLinksUrls() {
        val s = inlineMarkdown("**굵게** `x` [l](https://a.b) https://c.d", styles = false)
        assertEquals("**굵게** `x` [l](https://a.b) https://c.d", s.text)
        assertEquals(listOf("https://a.b" to "https://a.b", "https://c.d" to "https://c.d"), links(s))
    }

    @Test
    fun boldAndCodeStillRender() {
        val s = inlineMarkdown("**굵게** 와 `code` 그리고 [링크](https://a.b)")
        assertEquals("굵게 와 code 그리고 링크", s.text)
        assertEquals(listOf("링크" to "https://a.b"), links(s))
    }
}

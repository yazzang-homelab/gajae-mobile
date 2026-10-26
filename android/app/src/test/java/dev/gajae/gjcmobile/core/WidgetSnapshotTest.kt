package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class WidgetSnapshotTest {
    private val t0 = Instant.parse("2026-10-26T12:00:00Z")
    private fun min(n: Long) = t0.plusSeconds(n * 60)

    private fun summary(id: String, running: Boolean?, title: String? = null, cwd: String = "/w/$id") =
        SessionSummary(id, cwd, title, null, running)

    private fun ask(id: String, session: String) = PermissionRequest.from(
        parseJson("""{"requestId":"$id","sessionId":"$session","toolCall":{"title":"비밀 질문 본문"},"options":[]}"""),
    )!!

    @Test
    fun observeCountsAsksAndKeepsOnlyActiveOrRecentlyEndedSessions() {
        val host = WidgetHost.observe(
            null, "h", "맥북",
            listOf(summary("a", true, "리팩터"), summary("b", false), summary("c", null)),
            listOf(ask("r1", "a"), ask("r2", "a")),
            t0,
        )
        assertEquals(t0, host.observedAt)
        assertEquals(listOf("a"), host.sessions.map { it.sessionId })
        assertEquals(2, host.sessions[0].waiting)
        assertEquals("리팩터", host.sessions[0].label)
        assertFalse("question text is never stored", WidgetHost.encode(listOf(host)).contains("비밀"))
    }

    @Test
    fun endIsRecordedOnlyWhenTheTransitionWasObserved() {
        val first = WidgetHost.observe(null, "h", "맥북", listOf(summary("a", true), summary("b", false)), emptyList(), t0)
        val second = WidgetHost.observe(first, "h", "맥북", listOf(summary("a", false), summary("b", false)), emptyList(), min(5))
        assertEquals(listOf("a"), second.sessions.map { it.sessionId })
        assertEquals(min(5), second.sessions[0].endedAt)
        val third = WidgetHost.observe(second, "h", "맥북", listOf(summary("a", false)), emptyList(), min(30))
        assertEquals("the end time survives later idle observations", min(5), third.sessions[0].endedAt)
        val restarted = WidgetHost.observe(third, "h", "맥북", listOf(summary("a", true)), emptyList(), min(31))
        assertNull(restarted.sessions[0].endedAt)
        val longAfter = WidgetHost.observe(second, "h", "맥북", listOf(summary("a", false)), emptyList(), min(5 + 13 * 60))
        assertTrue("old ends drop out", longAfter.sessions.isEmpty())
    }

    @Test
    fun askOutsideTheListedPageStillCounts() {
        val host = WidgetHost.observe(null, "h", "맥북", listOf(summary("a", false)), listOf(ask("r1", "zz")), t0)
        assertEquals(1, host.sessions.single { it.sessionId == "zz" }.waiting)
        assertEquals(1, WidgetState.present(listOf(host), t0).waiting)
    }

    @Test
    fun freshHostShowsCountsAndOrdersWaitingFirst() {
        val host = WidgetHost.observe(
            WidgetHost("h", "맥북", t0, listOf(WidgetSession("e", "/w/e", "e", running = true, waiting = 0, endedAt = null))),
            "h", "맥북",
            listOf(summary("r", true), summary("w", true), summary("e", false)),
            listOf(ask("q", "w")),
            min(1),
        )
        val state = WidgetState.present(listOf(host), min(3))
        assertEquals(1, state.waiting)
        assertEquals(1, state.running)
        assertFalse(state.needsCheck)
        assertEquals(listOf(WidgetState.Kind.WAITING, WidgetState.Kind.RUNNING, WidgetState.Kind.ENDED), state.rows.map { it.kind })
        assertEquals("응답 대기 1", state.headline)
        assertEquals("대기 1 · 작업중 1 · 2분 전", state.summary(min(3)))
        assertEquals("실행 종료 · 2분 전", state.rows.last().status(min(3)))
    }

    @Test
    fun staleHostNeverShowsAReassuringZeroOrWorkingBadge() {
        val host = WidgetHost.observe(null, "h", "맥북", listOf(summary("r", true)), emptyList(), t0)
        assertEquals("작업 중 1", WidgetState.present(listOf(host), min(15)).headline)
        val stale = WidgetState.present(listOf(host), min(16))
        assertTrue(stale.needsCheck)
        assertEquals(0, stale.running)
        assertEquals("확인 필요", stale.headline)
        assertEquals(WidgetState.Kind.UNCONFIRMED, stale.rows.single().kind)
        assertEquals("확인 필요 · 16분 전", stale.summary(min(16)))
    }

    @Test
    fun oneStaleHostDoesNotHideWaitingOnAFreshOne() {
        val fresh = WidgetHost.observe(null, "a", "A", listOf(summary("s", true)), listOf(ask("q", "s")), min(20))
        val never = WidgetHost.unobserved("b", "B")
        val state = WidgetState.present(listOf(fresh, never), min(21))
        assertTrue(state.needsCheck)
        assertEquals("응답 대기 1", state.headline)
        assertEquals("대기 1 · 확인 필요 · 1분 전", state.summary(min(21)))
    }

    @Test
    fun noHostsAndIdleHosts() {
        assertEquals("연결된 컴퓨터 없음", WidgetState.present(emptyList(), t0).headline)
        val idle = WidgetHost.observe(null, "h", "맥북", listOf(summary("a", false)), emptyList(), t0)
        val state = WidgetState.present(listOf(idle), min(2))
        assertEquals("대기 없음", state.headline)
        assertEquals("대기 없음 · 2분 전", state.summary(min(2)))
        assertEquals(min(15), WidgetState.nextStaleAt(listOf(idle), min(2)))
        assertNull(WidgetState.nextStaleAt(listOf(idle), min(16)))
    }

    @Test
    fun jsonRoundTrip() {
        val host = WidgetHost.observe(null, "h", "맥북", listOf(summary("a", true, "제목")), listOf(ask("q", "a")), t0)
        assertEquals(listOf(host, WidgetHost.unobserved("x", "X")), WidgetHost.list(WidgetHost.encode(listOf(host, WidgetHost.unobserved("x", "X")))))
        assertEquals(emptyList<WidgetHost>(), WidgetHost.list("not json"))
    }

    @Test
    fun ageText() {
        assertEquals("방금", WidgetState.age(t0, t0.plusSeconds(30)))
        assertEquals("59분 전", WidgetState.age(t0, min(59)))
        assertEquals("2시간 전", WidgetState.age(t0, min(150)))
        assertEquals("1일 전", WidgetState.age(t0, min(60 * 30)))
    }
}

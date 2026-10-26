package dev.gajae.gjcmobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ActivityAlertsTest {
    private fun request(id: String, session: String = "s1") = PermissionRequest.from(
        parseJson("""{"requestId":"$id","sessionId":"$session","toolCall":{"title":"어느 쪽?"},"options":[]}"""),
    )!!

    @Test
    fun eachAskIsAnnouncedOnceEvenWhenRedelivered() {
        val alerts = ActivityAlerts()
        assertEquals(ActivityAlerts.Alert.Ask("s1", "r1", "어느 쪽?"), alerts.permission(request("r1")))
        assertNull("reconnect re-delivers the pending ask", alerts.permission(request("r1")))
        assertEquals("s2", alerts.permission(request("r2", "s2"))?.sessionId)
    }

    @Test
    fun onlyWorkingIdleTransitionsAlert() {
        val alerts = ActivityAlerts()
        assertNull("first observation is the baseline", alerts.status("s1", true))
        assertNull("per-second rate tick", alerts.status("s1", true))
        assertEquals(ActivityAlerts.Alert.Finished("s1"), alerts.status("s1", false))
        assertNull(alerts.status("s1", false))
        assertEquals(ActivityAlerts.Alert.Started("s1"), alerts.status("s1", true))
    }

    @Test
    fun sessionListSeedsAndReportsMissedTransitions() {
        val alerts = ActivityAlerts()
        val rows = listOf(SessionSummary("a", "/a", null, null, true), SessionSummary("b", "/b", null, null, null))
        assertEquals(emptyList<ActivityAlerts.Alert>(), alerts.sessions(rows))
        assertEquals(listOf(ActivityAlerts.Alert.Finished("a")), alerts.sessions(listOf(SessionSummary("a", "/a", null, null, false))))
        assertNull(alerts.status("a", false))
    }
}

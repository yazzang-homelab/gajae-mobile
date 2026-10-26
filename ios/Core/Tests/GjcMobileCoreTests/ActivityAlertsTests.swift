@testable import GjcMobileCore
import XCTest

final class ActivityAlertsTests: XCTestCase {
    private func request(_ id: String, session: String = "s1") throws -> PermissionRequest {
        let json = #"{"requestId":"\#(id)","sessionId":"\#(session)","toolCall":{"title":"어느 쪽?"},"options":[]}"#
        return try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))
    }

    func testEachAskIsAnnouncedOnceEvenWhenRedelivered() throws {
        var alerts = ActivityAlerts()
        XCTAssertEqual(alerts.permission(try request("r1")), .ask(sessionId: "s1", requestId: "r1", title: "어느 쪽?"))
        XCTAssertNil(alerts.permission(try request("r1")), "reconnect re-delivers the pending ask")
        XCTAssertEqual(alerts.permission(try request("r2", session: "s2"))?.sessionId, "s2")
    }

    func testOnlyWorkingIdleTransitionsAlert() {
        var alerts = ActivityAlerts()
        XCTAssertNil(alerts.status(sessionId: "s1", running: true), "first observation is the baseline")
        XCTAssertNil(alerts.status(sessionId: "s1", running: true), "per-second rate tick")
        XCTAssertEqual(alerts.status(sessionId: "s1", running: false), .finished(sessionId: "s1"))
        XCTAssertNil(alerts.status(sessionId: "s1", running: false))
        XCTAssertEqual(alerts.status(sessionId: "s1", running: true), .started(sessionId: "s1"))
    }

    func testSessionListSeedsAndReportsMissedTransitions() {
        var alerts = ActivityAlerts()
        let rows = [
            SessionSummary(sessionId: "a", cwd: "/a", title: nil, updatedAt: nil, running: true),
            SessionSummary(sessionId: "b", cwd: "/b", title: nil, updatedAt: nil, running: nil),
        ]
        XCTAssertEqual(alerts.sessions(rows), [])
        let later = [SessionSummary(sessionId: "a", cwd: "/a", title: nil, updatedAt: nil, running: false)]
        XCTAssertEqual(alerts.sessions(later), [.finished(sessionId: "a")])
        XCTAssertNil(alerts.status(sessionId: "a", running: false))
    }
}

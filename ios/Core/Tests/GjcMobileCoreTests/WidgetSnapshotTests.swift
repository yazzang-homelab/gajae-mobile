@testable import GjcMobileCore
import XCTest

final class WidgetSnapshotTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_792_000_000)
    private func min(_ n: Double) -> Date { t0.addingTimeInterval(n * 60) }

    private func summary(_ id: String, _ running: Bool?, title: String? = nil) -> SessionSummary {
        SessionSummary(sessionId: id, cwd: "/w/\(id)", title: title, updatedAt: nil, running: running)
    }

    private func ask(_ id: String, _ session: String) throws -> PermissionRequest {
        try JSONDecoder().decode(PermissionRequest.self, from: Data(
            #"{"requestId":"\#(id)","sessionId":"\#(session)","toolCall":{"title":"비밀 질문 본문"},"options":[]}"#.utf8
        ))
    }

    func testObserveCountsAsksAndKeepsOnlyActiveOrRecentlyEndedSessions() throws {
        let host = WidgetHost.observe(
            previous: nil, hostId: "h", name: "맥북",
            sessions: [summary("a", true, title: "리팩터"), summary("b", false), summary("c", nil)],
            waiting: [try ask("r1", "a"), try ask("r2", "a")], now: t0
        )
        XCTAssertEqual(host.observedAt, t0)
        XCTAssertEqual(host.sessions.map(\.sessionId), ["a"])
        XCTAssertEqual(host.sessions[0].waiting, 2)
        XCTAssertEqual(host.sessions[0].label, "리팩터")
        let stored = String(decoding: try WidgetHost.encode([host]), as: UTF8.self)
        XCTAssertFalse(stored.contains("비밀"), "question text is never stored")
    }

    func testEndIsRecordedOnlyWhenTheTransitionWasObserved() {
        let first = WidgetHost.observe(previous: nil, hostId: "h", name: "맥북", sessions: [summary("a", true), summary("b", false)], waiting: [], now: t0)
        let second = WidgetHost.observe(previous: first, hostId: "h", name: "맥북", sessions: [summary("a", false), summary("b", false)], waiting: [], now: min(5))
        XCTAssertEqual(second.sessions.map(\.sessionId), ["a"])
        XCTAssertEqual(second.sessions[0].endedAt, min(5))
        let third = WidgetHost.observe(previous: second, hostId: "h", name: "맥북", sessions: [summary("a", false)], waiting: [], now: min(30))
        XCTAssertEqual(third.sessions[0].endedAt, min(5), "the end time survives later idle observations")
        let restarted = WidgetHost.observe(previous: third, hostId: "h", name: "맥북", sessions: [summary("a", true)], waiting: [], now: min(31))
        XCTAssertNil(restarted.sessions[0].endedAt)
        let longAfter = WidgetHost.observe(previous: second, hostId: "h", name: "맥북", sessions: [summary("a", false)], waiting: [], now: min(5 + 13 * 60))
        XCTAssertTrue(longAfter.sessions.isEmpty, "old ends drop out")
    }

    func testAskOutsideTheListedPageStillCounts() throws {
        let host = WidgetHost.observe(previous: nil, hostId: "h", name: "맥북", sessions: [summary("a", false)], waiting: [try ask("r1", "zz")], now: t0)
        XCTAssertEqual(host.sessions.first { $0.sessionId == "zz" }?.waiting, 1)
        XCTAssertEqual(WidgetState.present([host], now: t0).waiting, 1)
    }

    func testFreshHostShowsCountsAndOrdersWaitingFirst() throws {
        let previous = WidgetHost(hostId: "h", name: "맥북", observedAt: t0,
                                  sessions: [WidgetSession(sessionId: "e", cwd: "/w/e", label: "e", running: true, waiting: 0, endedAt: nil)])
        let host = WidgetHost.observe(previous: previous, hostId: "h", name: "맥북",
                                      sessions: [summary("r", true), summary("w", true), summary("e", false)],
                                      waiting: [try ask("q", "w")], now: min(1))
        let state = WidgetState.present([host], now: min(3))
        XCTAssertEqual(state.waiting, 1)
        XCTAssertEqual(state.running, 1)
        XCTAssertFalse(state.needsCheck)
        XCTAssertEqual(state.rows.map(\.kind), [.waiting, .running, .ended])
        XCTAssertEqual(state.headline, "응답 대기 1")
        XCTAssertEqual(state.summary(now: min(3)), "대기 1 · 작업중 1 · 2분 전")
        XCTAssertEqual(state.rows.last?.status(now: min(3)), "실행 종료 · 2분 전")
    }

    func testStaleHostNeverShowsAReassuringZeroOrWorkingBadge() {
        let host = WidgetHost.observe(previous: nil, hostId: "h", name: "맥북", sessions: [summary("r", true)], waiting: [], now: t0)
        XCTAssertEqual(WidgetState.present([host], now: min(15)).headline, "작업 중 1")
        let stale = WidgetState.present([host], now: min(16))
        XCTAssertTrue(stale.needsCheck)
        XCTAssertEqual(stale.running, 0)
        XCTAssertEqual(stale.headline, "확인 필요")
        XCTAssertEqual(stale.rows.map(\.kind), [.unconfirmed])
        XCTAssertEqual(stale.summary(now: min(16)), "확인 필요 · 16분 전")
    }

    func testOneStaleHostDoesNotHideWaitingOnAFreshOne() throws {
        let fresh = WidgetHost.observe(previous: nil, hostId: "a", name: "A", sessions: [summary("s", true)], waiting: [try ask("q", "s")], now: min(20))
        let state = WidgetState.present([fresh, .unobserved(hostId: "b", name: "B")], now: min(21))
        XCTAssertTrue(state.needsCheck)
        XCTAssertEqual(state.headline, "응답 대기 1")
        XCTAssertEqual(state.summary(now: min(21)), "대기 1 · 확인 필요 · 1분 전")
    }

    func testNoHostsAndIdleHosts() {
        XCTAssertEqual(WidgetState.present([], now: t0).headline, "연결된 컴퓨터 없음")
        let idle = WidgetHost.observe(previous: nil, hostId: "h", name: "맥북", sessions: [summary("a", false)], waiting: [], now: t0)
        let state = WidgetState.present([idle], now: min(2))
        XCTAssertEqual(state.headline, "대기 없음")
        XCTAssertEqual(state.summary(now: min(2)), "대기 없음 · 2분 전")
        XCTAssertEqual(WidgetState.nextStaleAt([idle], now: min(2)), min(15))
        XCTAssertNil(WidgetState.nextStaleAt([idle], now: min(16)))
    }

    func testJSONRoundTrip() throws {
        let host = WidgetHost.observe(previous: nil, hostId: "h", name: "맥북", sessions: [summary("a", true, title: "제목")], waiting: [try ask("q", "a")], now: t0)
        let hosts = [host, .unobserved(hostId: "x", name: "X")]
        XCTAssertEqual(WidgetHost.decode(try WidgetHost.encode(hosts)), hosts)
        XCTAssertEqual(WidgetHost.decode(Data("not json".utf8)), [])
    }

    func testAgeText() {
        XCTAssertEqual(WidgetState.age(t0, now: t0.addingTimeInterval(30)), "방금")
        XCTAssertEqual(WidgetState.age(t0, now: min(59)), "59분 전")
        XCTAssertEqual(WidgetState.age(t0, now: min(150)), "2시간 전")
        XCTAssertEqual(WidgetState.age(t0, now: min(60 * 30)), "1일 전")
    }
}

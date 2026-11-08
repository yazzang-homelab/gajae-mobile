import XCTest
@testable import GjcMobileCore

final class ReconnectBackoffTests: XCTestCase {
    func testFailedDialsWaitLongerUpToTheCap() {
        var backoff = ReconnectBackoff()
        XCTAssertEqual((0..<7).map { _ in backoff.failedDial() }, [1, 2, 4, 8, 16, 30, 30])
    }

    func testAConnectionDroppingRightAfterAttachingWaitsLikeAFailedDial() {
        // pve1 2026-11-08: every attach dropped about 0.5s later; the dials must spread out instead of repeating.
        var backoff = ReconnectBackoff()
        var waits: [TimeInterval] = []
        var now: TimeInterval = 100
        for _ in 0..<6 {
            backoff.attached(at: now)
            now += 0.5
            let wait = backoff.dropped(at: now)
            waits.append(wait)
            now += wait
        }
        XCTAssertEqual(waits, [1, 2, 4, 8, 16, 30])
    }

    func testAConnectionThatHeldUpDialsAgainAtOnceWithTheWaitReset() {
        var backoff = ReconnectBackoff()
        _ = backoff.failedDial()
        _ = backoff.failedDial()
        backoff.attached(at: 0)
        XCTAssertEqual(backoff.dropped(at: ReconnectBackoff.stableAfter), 0)
        XCTAssertEqual(backoff.failedDial(), 1, "the wait starts over after a connection that held up")
    }

    func testADropRightAfterALongOutageKeepsTheLongerWait() {
        var backoff = ReconnectBackoff()
        for _ in 0..<5 { _ = backoff.failedDial() }
        backoff.attached(at: 0)
        XCTAssertEqual(backoff.dropped(at: 1), 30)
    }
}

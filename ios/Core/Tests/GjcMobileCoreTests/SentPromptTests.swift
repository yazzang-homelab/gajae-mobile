@testable import GjcMobileCore
import XCTest

final class SentPromptTests: XCTestCase {
    private let sent = SentPrompt(message: "이거 보이냐?", turnId: "t1")

    private func end(_ seq: Int, turnId: String?, undelivered: Bool = false) -> SequencedUpdate {
        var update: [String: JSONValue] = ["sessionUpdate": "x_gjcm_turn_end", "stopReason": undelivered ? "cancelled" : "end_turn"]
        if let turnId { update["turnId"] = .string(turnId) }
        if undelivered { update["undelivered"] = true }
        return SequencedUpdate(seq: seq, update: .object(update))
    }

    func testItsTurnStoppedBeforeGjcRanItGivesTheMessageBack() {
        XCTAssertEqual(sent.settle(after: [end(5, turnId: "t1", undelivered: true)], turnOver: false), .giveBack)
    }

    func testItsTurnThatRanIsDone() {
        XCTAssertEqual(sent.settle(after: [end(5, turnId: "t1")], turnOver: false), .done)
    }

    func testAnotherPhonesUndeliveredTurnIsNotThisPhonesMessage() {
        XCTAssertEqual(sent.settle(after: [end(5, turnId: "t2", undelivered: true)], turnOver: false), .waiting)
        XCTAssertEqual(sent.settle(after: [end(5, turnId: "t2", undelivered: true)], turnOver: true), .done)
    }

    func testAnOpenSnapshotFindsItsTurnEndAmongEarlierAndLaterTurns() {
        let updates = [end(3, turnId: "t0", undelivered: true), end(5, turnId: "t1", undelivered: true), end(9, turnId: "t2")]
        XCTAssertEqual(sent.settle(after: updates, turnOver: true), .giveBack)
    }

    func testASnapshotWithItsTurnStillRunningKeepsWaiting() {
        XCTAssertEqual(sent.settle(after: [SequencedUpdate(seq: 4, update: ["sessionUpdate": "user_message_chunk"])], turnOver: false), .waiting)
    }

    func testATurnOverWhoseEndLeftTheBufferIsNotGivenBack() {
        XCTAssertEqual(sent.settle(after: [], turnOver: true), .done)
        XCTAssertEqual(sent.settle(after: [end(5, turnId: nil, undelivered: true)], turnOver: true), .done, "an end without an id")
    }
}

@testable import GjcMobileCore
import XCTest

final class QueuedMessagesTests: XCTestCase {
    private let tui = QueuedMessage(text: "TUI에서 넣음", followUp: false)

    private func status(_ json: String) throws -> SessionStatus {
        try JSONDecoder().decode(SessionStatus.self, from: Data(json.utf8))
    }

    func testStatusCarriesTheHostQueueFromTheBridge() throws {
        let decoded = try status(
            #"{"sessionId":"s1","running":true,"queued":[{"id":"steer:1","text":"TUI에서 넣음","mode":"steer"},"#
                + #"{"id":"f:1","text":"끝나면","mode":"followUp"},{"id":"x","text":"?","mode":"other"}]}"#
        )
        XCTAssertEqual(decoded.queued, [tui, QueuedMessage(text: "끝나면", followUp: true)])
        XCTAssertNil(try status(#"{"sessionId":"s1","running":true}"#).queued, "an older bridge reports no queue")
    }

    func testASteerTypedElsewhereShowsFromTheHostQueue() {
        XCTAssertEqual(QueuedMessages.merge(sent: [], host: [tui], now: 10), [tui])
    }

    func testAJustSentSteerShowsUntilTheHostQueueCatchesUp() {
        let sent = QueuedMessage(text: "폰에서", followUp: false, sentAt: 10)
        XCTAssertEqual(QueuedMessages.merge(sent: [sent], host: [], now: 9.8), [sent], "report sampled before the steer")
        XCTAssertEqual(QueuedMessages.merge(sent: [sent], host: [], now: 11), [sent])
        let listed = QueuedMessage(text: "폰에서", followUp: false)
        XCTAssertEqual(QueuedMessages.merge(sent: [sent], host: [listed], now: 11), [listed], "listed once, not twice")
        XCTAssertEqual(QueuedMessages.merge(sent: [sent], host: [], now: 13), [], "gjc took it already")
    }

    func testWithoutHostReportsOnlyThisPhonesSteersAreKnown() {
        let sent = QueuedMessage(text: "폰에서", followUp: false, sentAt: 0)
        XCTAssertEqual(QueuedMessages.merge(sent: [sent], host: nil, now: 60), [sent])
    }
}

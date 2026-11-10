import XCTest
@testable import GjcMobileCore

final class SessionListFailureTests: XCTestCase {
    func testACancelledRequestIsNotAFailure() {
        XCTAssertEqual(SessionListFailure.classify(CancellationError()), .cancelled)
    }

    func testAnErrorReplyKeepsTheConnection() {
        XCTAssertEqual(SessionListFailure.classify(BridgeError.remote(code: -32000, message: "boom")), .remote)
    }

    func testADroppedSocketIsLeftToTheEventStream() {
        XCTAssertEqual(SessionListFailure.classify(BridgeError.disconnected), .disconnected)
    }

    func testTransportAndProtocolFailuresEndTheConnection() {
        XCTAssertEqual(SessionListFailure.classify(BridgeError.protocolViolation("x")), .transport)
        XCTAssertEqual(SessionListFailure.classify(BridgeError.noReachableEndpoint), .transport)
        XCTAssertEqual(SessionListFailure.classify(URLError(.networkConnectionLost)), .transport)
    }
}

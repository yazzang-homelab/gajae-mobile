import Foundation
import XCTest
@testable import GjcMobileCore

final class CodePairingFlowTests: XCTestCase {
    private let keyA = Data(repeating: 7, count: 32).base64URL
    private let keyB = Data(repeating: 8, count: 32).base64URL

    private func offer(hostKey: String? = nil, endpoints: [String] = ["ws://100.100.1.2:7787/ws"]) throws -> PairingOffer {
        let json: JSONValue = [
            "v": 1, "hostId": "host-1", "name": "sim", "hostKey": .string(hostKey ?? keyA),
            "endpoints": .array(endpoints.map(JSONValue.string)), "pairingId": "pid-1",
            "secret": .string(Data(repeating: 9, count: 32).base64URL), "exp": "2000-01-01T00:00:00.000Z",
        ]
        return try PairingOffer.parse(json: try JSONEncoder().encode(json))
    }

    private func knownHost(key: String) -> PairedHost {
        PairedHost(hostId: "host-1", name: "sim", hostKey: key, endpoints: ["ws://100.100.1.2:7787/ws"])
    }

    // MARK: endpointKey

    func testEndpointKeyUsesTheSchemesDefaultPort() {
        XCTAssertEqual(endpointKey("ws://h/ws"), endpointKey("ws://h:80/ws"))
        XCTAssertEqual(endpointKey("http://h/ws"), endpointKey("http://h:80/ws"))
        XCTAssertEqual(endpointKey("wss://h/ws"), endpointKey("wss://h:443/ws"))
        XCTAssertEqual(endpointKey("https://h/ws"), endpointKey("https://h:443/ws"))
        XCTAssertNotEqual(endpointKey("wss://h/ws"), endpointKey("wss://h:80/ws"))
        XCTAssertNotEqual(endpointKey("ws://h/ws"), endpointKey("ws://h:443/ws"))
        XCTAssertNotEqual(endpointKey("ws://h:7787/ws"), endpointKey("ws://h:7788/ws"))
    }

    func testEndpointKeyIgnoresSchemeAndHostCaseButNotThePath() {
        XCTAssertEqual(endpointKey("WS://Host.Example/ws"), endpointKey("ws://host.example:80/ws"))
        XCTAssertNotEqual(endpointKey("ws://h/ws"), endpointKey("ws://h/other"))
        XCTAssertNotEqual(endpointKey("ws://h/ws"), endpointKey("ws://h/WS"))
        XCTAssertEqual(endpointKey("ws://h"), endpointKey("ws://h/"))
    }

    func testEndpointKeyOfTextThatIsNotAURLIsTheText() {
        XCTAssertEqual(endpointKey("garbage"), "garbage")
    }

    func testEndpointsToTryListsEachAddressOnceWithTheLastWorkingFirst() {
        var host = PairedHost(hostId: "h", name: "n", hostKey: keyA, endpoints: ["ws://a/ws", "ws://A:80/ws", "ws://b:7787/ws"])
        XCTAssertEqual(host.endpointsToTry, ["ws://a/ws", "ws://b:7787/ws"])
        host.lastEndpoint = "ws://b:7787/ws"
        XCTAssertEqual(host.endpointsToTry, ["ws://b:7787/ws", "ws://a/ws"])
        host.lastEndpoint = "ws://a:80/ws"
        XCTAssertEqual(host.endpointsToTry, ["ws://a:80/ws", "ws://b:7787/ws"])
    }

    func testHelloDialsTheAnsweredAddressFirstAndEachAddressOnce() throws {
        var keeper = CodeOfferKeeper()
        keeper.keep(code: "C", offer: try offer(endpoints: ["ws://5.6.7.8:7787/ws", "ws://1.2.3.4:7787/ws"]), endpoint: "ws://1.2.3.4:7787/ws")
        XCTAssertEqual(keeper.held?.helloEndpoints, ["ws://1.2.3.4:7787/ws", "ws://5.6.7.8:7787/ws"])
    }

    // MARK: CodeOfferKeeper

    func testTheSameCodeRetriesTheKeptOfferAndAnotherCodeResets() throws {
        var keeper = CodeOfferKeeper()
        XCTAssertTrue(keeper.submit(code: "A"))
        keeper.keep(code: "A", offer: try offer(), endpoint: "ws://x/ws")
        XCTAssertFalse(keeper.submit(code: "A"))
        XCTAssertNotNil(keeper.held)
        XCTAssertFalse(keeper.submit(code: "A", approvingKeyChange: true))
        XCTAssertEqual(keeper.held?.keyChangeApproved, true)
        // An approval sent with another code is for an offer the user has not seen: it is ignored.
        XCTAssertTrue(keeper.submit(code: "B", approvingKeyChange: true))
        XCTAssertNil(keeper.held)
        keeper.keep(code: "B", offer: try offer(), endpoint: "ws://x/ws")
        XCTAssertEqual(keeper.held?.keyChangeApproved, false, "an approval does not carry over to another offer")
    }

    func testAChangedKeyNeedsApprovalBeforeAnyHelloAndTheApprovalIsKept() throws {
        var keeper = CodeOfferKeeper()
        XCTAssertFalse(keeper.needsKeyChangeApproval(among: [knownHost(key: keyB)]), "nothing kept")
        keeper.keep(code: "A", offer: try offer(), endpoint: "ws://x/ws")
        XCTAssertFalse(keeper.needsKeyChangeApproval(among: []))
        XCTAssertFalse(keeper.needsKeyChangeApproval(among: [knownHost(key: keyA)]))
        XCTAssertTrue(keeper.needsKeyChangeApproval(among: [knownHost(key: keyB)]))
        XCTAssertFalse(keeper.submit(code: "A", approvingKeyChange: true))
        XCTAssertFalse(keeper.needsKeyChangeApproval(among: [knownHost(key: keyB)]))
        // A retry with the same code keeps the approval, so the user is not asked again.
        XCTAssertFalse(keeper.submit(code: "A"))
        XCTAssertFalse(keeper.needsKeyChangeApproval(among: [knownHost(key: keyB)]))
    }

    func testAFailedHelloKeepsTheOfferExceptWhenThePairingLapsed() throws {
        var keeper = CodeOfferKeeper()
        keeper.keep(code: "A", offer: try offer(), endpoint: "ws://x/ws")
        XCTAssertFalse(keeper.submit(code: "A", approvingKeyChange: true))
        for error in [BridgeError.noReachableEndpoint, .disconnected, .rejected(code: "pairing_busy", message: ""),
                      .rejected(code: "unknown_device", message: ""), .protocolViolation("x")] {
            _ = keeper.helloFailed(error)
            XCTAssertEqual(keeper.held?.keyChangeApproved, true, "kept with its approval after \(error)")
        }
        let expired = keeper.helloFailed(BridgeError.rejected(code: "pairing_invalid", message: ""))
        XCTAssertEqual(expired, .pairingExpired)
        XCTAssertNil(keeper.held)
    }

    func testAFailedHelloIsClassifiedLikeHelloFailure() throws {
        var keeper = CodeOfferKeeper()
        keeper.keep(code: "A", offer: try offer(), endpoint: "ws://x/ws")
        let failure = keeper.helloFailed(BridgeError.disconnected)
        XCTAssertEqual(failure, CodePairingError.helloFailure(BridgeError.disconnected))
    }

    func testSuccessAndCancelDropTheOffer() throws {
        var keeper = CodeOfferKeeper()
        keeper.keep(code: "A", offer: try offer(), endpoint: "ws://x/ws")
        keeper.helloSucceeded()
        XCTAssertNil(keeper.held)
        keeper.keep(code: "A", offer: try offer(), endpoint: "ws://x/ws")
        keeper.discard()
        XCTAssertNil(keeper.held)
        XCTAssertTrue(keeper.submit(code: "A"))
    }
}

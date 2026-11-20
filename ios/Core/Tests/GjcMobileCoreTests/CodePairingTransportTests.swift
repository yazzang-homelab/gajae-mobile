import Foundation
import XCTest
@testable import GjcMobileCore

/// `BridgeClient.fetchOfferWithCode(transport:)` against a simulated bridge: the real CPace responder answers over a
/// fake `FrameTransport`, so the whole phone side of gjcm-code-v1 runs without a network.
private let simCode = "4PUXU36F4W"

final class CodePairingTransportTests: XCTestCase {
    private static let code = simCode

    private struct ExpectedFailure: Error {}

    private func failure(_ mode: SimBridge.Mode) async throws -> CodePairingError {
        let bridge = SimBridge(mode: mode)
        let transport = ScriptedTransport { bridge.handle($0) }
        do {
            _ = try await BridgeClient.fetchOfferWithCode(transport: transport, code: Self.code)
        } catch let error as CodePairingError {
            XCTAssertTrue(transport.closed, "the transport is closed on failure")
            return error
        }
        XCTFail("expected a CodePairingError")
        throw ExpectedFailure()
    }

    func testABridgeThatAnswersBadHelloIsOutdated() async throws {
        let error = try await failure(.badHello)
        XCTAssertEqual(error, .bridgeOutdated)
    }

    func testAnUnknownFrameTypeIsABadPake() async throws {
        let error = try await failure(.unknownType)
        XCTAssertEqual(error, .remote(code: "bad_pake", left: nil))
    }

    func testAFlippedTbBitFailsEvenWithAGoodBox() async throws {
        let error = try await failure(.flippedTb)
        XCTAssertEqual(error, .pakeFailed)
    }

    func testAWrongCodeCarriesTheAttemptsLeftIntoTheMessage() async throws {
        let error = try await failure(.wrongCode(left: 3))
        XCTAssertEqual(error, .remote(code: "code_wrong", left: 3))
        XCTAssertTrue(try XCTUnwrap(error.errorDescription).contains("남은 시도 3회"))
    }

    func testAnHonestExchangeReturnsTheOfferAndReportsTheAttemptsLeft() async throws {
        let bridge = SimBridge(mode: .honest(left: 4))
        let transport = ScriptedTransport { bridge.handle($0) }
        let log = StageLog()
        let offer = try await BridgeClient.fetchOfferWithCode(transport: transport, code: Self.code) { log.add($0) }
        XCTAssertEqual(offer.hostId, "host-1")
        XCTAssertEqual(offer.pairingId, "pid-1")
        XCTAssertEqual(log.stages, [.connecting, .verifying(left: 4)])
        XCTAssertTrue(transport.closed)
        XCTAssertEqual(transport.sentTypes, ["pake", "pake.confirm"])
    }

    func testAReplyWithoutALeftCountReportsNil() async throws {
        let bridge = SimBridge(mode: .honest(left: nil))
        let transport = ScriptedTransport { bridge.handle($0) }
        let log = StageLog()
        _ = try await BridgeClient.fetchOfferWithCode(transport: transport, code: Self.code) { log.add($0) }
        XCTAssertEqual(log.stages, [.connecting, .verifying(left: nil)])
    }

    /// The bridge decides expiry when the code is used, so the phone's clock must not reject the sealed offer.
    func testAnOfferFromACodeIsNotRejectedForAnExpiredExp() throws {
        let json = SimBridge.offerJSON(exp: "2000-01-01T00:00:00.000Z")
        XCTAssertEqual(try PairingOffer.parse(json: json).exp, "2000-01-01T00:00:00.000Z")
        let offer = try PairingOffer.parse(json: json)
        XCTAssertThrowsError(try offer.validated(checkingExpiryAt: Date())) {
            XCTAssertEqual($0 as? PairingOffer.ParseError, .expired)
        }
    }

    func testOnlyRecoverableHelloFailuresAreRetryable() throws {
        XCTAssertTrue(CodePairingError.helloFailure(BridgeError.noReachableEndpoint).isRetryable)
        XCTAssertTrue(CodePairingError.helloFailure(BridgeError.disconnected).isRetryable)
        let busy = CodePairingError.helloFailure(BridgeError.rejected(code: "pairing_busy", message: ""))
        XCTAssertTrue(busy.isRetryable)
        let busyText = try XCTUnwrap(busy.errorDescription)
        XCTAssertTrue(busyText.contains("다른 페어링을 처리하는 중"))
        XCTAssertEqual(busyText.components(separatedBy: "다시 시도").count - 1, 1, "the retry hint appears once: \(busyText)")
        let other = CodePairingError.helloFailure(BridgeError.rejected(code: "unknown_device", message: ""))
        XCTAssertFalse(other.isRetryable)
        XCTAssertTrue(try XCTUnwrap(other.errorDescription).contains("페어링되지 않은 기기"))
        XCTAssertFalse(CodePairingError.helloFailure(BridgeError.protocolViolation("x")).isRetryable)
        XCTAssertFalse(CodePairingError.helloFailure(PairingOffer.ParseError.malformed).isRetryable)
    }

    private func urlFailure(_ transport: FrameTransport) async throws -> CodePairingError {
        do {
            _ = try await BridgeClient.fetchOfferWithCode(
                url: URL(string: "ws://100.100.1.2:7787/ws")!, code: Self.code, timeout: .milliseconds(200),
                makeTransport: { _ in transport }
            )
        } catch let error as CodePairingError {
            return error
        }
        XCTFail("expected a CodePairingError")
        throw ExpectedFailure()
    }

    func testAStallAfterTheHostReplyIsHostInterrupted() async throws {
        let transport = StallingTransport(bridge: SimBridge(mode: .honest(left: 4)))
        let error = try await urlFailure(transport)
        XCTAssertEqual(error, .hostInterrupted)
        XCTAssertTrue(transport.closed)
    }

    func testAStallBeforeAnyReplyIsTimedOut() async throws {
        let transport = StallingTransport(bridge: nil)
        let error = try await urlFailure(transport)
        XCTAssertEqual(error, .timedOut(host: "100.100.1.2"))
        XCTAssertTrue(transport.closed)
    }

    func testAConnectionRefusedIsRefused() async throws {
        let transport = StallingTransport(bridge: nil, sendError: URLError(.cannotConnectToHost))
        let error = try await urlFailure(transport)
        XCTAssertEqual(error, .refused)
    }

    func testAnotherTransportFailureIsUnreachable() async throws {
        let transport = StallingTransport(bridge: nil, sendError: URLError(.notConnectedToInternet))
        let error = try await urlFailure(transport)
        XCTAssertEqual(error, .unreachable(host: "100.100.1.2"))
    }

    func testUnreachableAdviceDependsOnTheCodesRange() throws {
        for error in [CodePairingError.timedOut(host: "100.100.1.2"), .unreachable(host: "100.100.1.2")] {
            let text = try XCTUnwrap(error.errorDescription)
            XCTAssertTrue(text.contains("--code-lan"), text)
            XCTAssertFalse(text.contains("로컬 네트워크"), text)
        }
        for error in [CodePairingError.timedOut(host: "192.168.0.10"), .unreachable(host: "10.1.2.3")] {
            let text = try XCTUnwrap(error.errorDescription)
            XCTAssertFalse(text.contains("--code-lan"), text)
            XCTAssertTrue(text.contains("로컬 네트워크"), text)
        }
    }

    func testATimeoutAfterTheHostReplyHasItsOwnMessage() throws {
        let text = try XCTUnwrap(CodePairingError.hostInterrupted.errorDescription)
        XCTAssertTrue(text.contains("남은 시도가 줄었을 수 있습니다"))
        XCTAssertFalse(text.contains("닿지 않습니다"))
        XCTAssertTrue(CodePairingError.hostInterrupted.isRetryable)
    }
}

private final class StageLog: @unchecked Sendable {
    private let lock = NSLock()
    private var log: [CodePairingStage] = []

    func add(_ stage: CodePairingStage) {
        lock.lock()
        log.append(stage)
        lock.unlock()
    }

    var stages: [CodePairingStage] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }
}

/// A `FrameTransport` whose peer is a closure: every frame the phone sends is answered with the frames it returns.
private final class ScriptedTransport: FrameTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [JSONValue] = []
    private var sent: [JSONValue] = []
    private var isClosed = false
    private let respond: @Sendable (JSONValue) -> [JSONValue]

    init(respond: @escaping @Sendable (JSONValue) -> [JSONValue]) {
        self.respond = respond
    }

    func send(_ message: TransportMessage) async throws {
        guard case let .text(text) = message, let frame = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else {
            throw BridgeError.protocolViolation("expected a text frame")
        }
        record(frame, answers: respond(frame))
    }

    func receive() async throws -> TransportMessage {
        .text(String(decoding: try JSONEncoder().encode(try next()), as: UTF8.self))
    }

    // NSLock is taken only in synchronous helpers: it is unavailable from async contexts in Swift 6.
    private func record(_ frame: JSONValue, answers: [JSONValue]) {
        lock.lock()
        defer { lock.unlock() }
        sent.append(frame)
        inbox += answers
    }

    private func next() throws -> JSONValue {
        lock.lock()
        defer { lock.unlock() }
        guard !inbox.isEmpty else { throw BridgeError.disconnected }
        return inbox.removeFirst()
    }

    func close() {
        lock.lock()
        isClosed = true
        lock.unlock()
    }

    var closed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isClosed
    }

    var sentTypes: [String] {
        lock.lock()
        defer { lock.unlock() }
        return sent.compactMap { $0["t"]?.string }
    }
}

/// A transport that never answers on its own: with a bridge it relays the `pake.reply` and then goes silent, without
/// one it is silent from the start; `sendError` makes the first send fail. `receive` fails once the transport is closed.
private final class StallingTransport: FrameTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [JSONValue] = []
    private var isClosed = false
    private let bridge: SimBridge?
    private let sendError: Error?

    init(bridge: SimBridge?, sendError: Error? = nil) {
        self.bridge = bridge
        self.sendError = sendError
    }

    func send(_ message: TransportMessage) async throws {
        if let sendError { throw sendError }
        guard case let .text(text) = message, let frame = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else {
            throw BridgeError.protocolViolation("expected a text frame")
        }
        guard frame["t"]?.string == "pake", let bridge else { return }
        enqueue(bridge.handle(frame))
    }

    private func enqueue(_ answers: [JSONValue]) {
        lock.lock()
        defer { lock.unlock() }
        inbox += answers
    }

    private func poll() throws -> TransportMessage? {
        lock.lock()
        defer { lock.unlock() }
        if !inbox.isEmpty {
            return .text(String(decoding: try JSONEncoder().encode(inbox.removeFirst()), as: UTF8.self))
        }
        if isClosed { throw URLError(.networkConnectionLost) }
        return nil
    }

    func receive() async throws -> TransportMessage {
        while true {
            if let message = try poll() { return message }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func close() {
        lock.lock()
        isClosed = true
        lock.unlock()
    }

    var closed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isClosed
    }
}

/// The bridge's side of the code exchange, built on the shared CPace responder.
private final class SimBridge: @unchecked Sendable {
    enum Mode {
        case honest(left: Int?)
        case badHello
        case unknownType
        /// A valid box, but one bit of Tb is flipped.
        case flippedTb
        /// The bridge holds a different code, so Ta does not check.
        case wrongCode(left: Int)
    }

    private let mode: Mode
    private var responder: CPaceResponderSession?

    init(mode: Mode) {
        self.mode = mode
    }

    static func offerJSON(exp: String) -> Data {
        let offer: JSONValue = [
            "v": 1, "hostId": "host-1", "name": "sim", "hostKey": .string(Data(repeating: 7, count: 32).base64URL),
            "endpoints": ["ws://100.100.1.2:7787/ws"], "pairingId": "pid-1",
            "secret": .string(Data(repeating: 9, count: 32).base64URL), "exp": .string(exp),
        ]
        return try! JSONEncoder().encode(offer)
    }

    func handle(_ frame: JSONValue) -> [JSONValue] {
        switch frame["t"]?.string {
        case "pake":
            switch mode {
            case .badHello: return [["t": "error", "code": "bad_hello"]]
            case .unknownType: return [["t": "nonsense"]]
            default: break
            }
            guard let sid = frame["sid"]?.string.flatMap(Data.init(base64URL:)),
                  let ya = frame["ya"]?.string.flatMap(Data.init(base64URL:))
            else { return [["t": "error", "code": "bad_pake"]] }
            var prs = Data(simCode.utf8)
            var left: Int?
            switch mode {
            case let .honest(count): left = count
            case let .wrongCode(count):
                prs = Data("9ZZZZZZZZZ".utf8)
                left = count
            default: break
            }
            guard let session = cpaceRespond(prs: prs, sid: sid, ya: ya) else { return [["t": "error", "code": "bad_pake"]] }
            responder = session
            var fields: [String: JSONValue] = ["t": "pake.reply", "yb": .string(session.yb.base64URL)]
            if let left { fields["left"] = .number(Double(left)) }
            return [.object(fields)]
        case "pake.confirm":
            guard let ta = frame["ta"]?.string.flatMap(Data.init(base64URL:)), let confirmed = responder?.confirm(ta) else {
                var left = 0
                if case let .wrongCode(count) = mode { left = count }
                return [["t": "error", "code": "code_wrong", "left": .number(Double(left))]]
            }
            var tb = confirmed.tb
            if case .flippedTb = mode { tb[tb.startIndex] ^= 1 }
            let box = try! confirmed.seal(Self.offerJSON(exp: "2000-01-01T00:00:00.000Z"))
            return [["t": "pake.ok", "tb": .string(tb.base64URL), "box": .string(box.base64URL)]]
        default:
            return [["t": "error", "code": "bad_pake"]]
        }
    }
}

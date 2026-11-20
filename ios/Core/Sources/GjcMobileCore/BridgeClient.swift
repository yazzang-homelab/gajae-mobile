import Crypto
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum TransportMessage: Sendable {
    case text(String)
    case data(Data)
}

/// Minimal WebSocket surface so the client logic is testable without a network.
public protocol FrameTransport: AnyObject, Sendable {
    func send(_ message: TransportMessage) async throws
    func receive() async throws -> TransportMessage
    func close()
}

public final class URLSessionFrameTransport: FrameTransport, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    public init(url: URL, session: URLSession = .shared) {
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = 32 * 1024 * 1024
        task.resume()
    }

    public func send(_ message: TransportMessage) async throws {
        switch message {
        case let .text(text): try await task.send(.string(text))
        case let .data(data): try await task.send(.data(data))
        }
    }

    public func receive() async throws -> TransportMessage {
        switch try await task.receive() {
        case let .string(text): return .text(text)
        case let .data(data): return .data(data)
        @unknown default: throw BridgeError.protocolViolation("unknown websocket message")
        }
    }

    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

public enum BridgeError: Error, Equatable, LocalizedError {
    case rejected(code: String, message: String)
    /// A JSON-RPC error from the bridge; `reason` is its `data.code` (`host_turn`, `prompt_too_large`, ...) when sent.
    case remote(code: Int, message: String, reason: String? = nil)
    case protocolViolation(String)
    case disconnected
    case noReachableEndpoint

    public var errorDescription: String? {
        switch self {
        case let .rejected(code, message):
            switch code {
            case "unknown_device": return "이 호스트와 페어링되지 않은 기기입니다. 다시 페어링하세요."
            case "pairing_invalid": return "페어링 코드가 만료됐거나 이미 사용됐습니다. 호스트에서 `gjcm-bridge pair`를 다시 실행하세요."
            case "pairing_busy": return "호스트가 다른 페어링을 처리하는 중입니다. 잠시 후 다시 시도하세요."
            default: return "\(message) (\(code))"
            }
        case let .remote(_, message, _): return message
        case let .protocolViolation(detail): return "브리지 프로토콜 오류: \(detail)"
        case .disconnected: return "호스트와 연결이 끊겼습니다."
        case .noReachableEndpoint: return "호스트에 연결할 수 없습니다. 같은 네트워크 또는 Tailscale에 연결돼 있는지 확인하세요."
        }
    }
}

/// Phone side of the bridge protocol: handshake, encrypted request/response, event stream.
public actor BridgeClient {
    public nonisolated let events: AsyncStream<BridgeEvent>
    private let eventSink: AsyncStream<BridgeEvent>.Continuation
    private let transport: FrameTransport
    private var cipher: FrameCipher?
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var outbox: [(Int, Data)] = []
    private var pumping = false
    private var readerTask: Task<Void, Never>?
    private var closed = false
    public private(set) var hostId: String?

    init(transport: FrameTransport) {
        self.transport = transport
        (events, eventSink) = AsyncStream.makeStream(of: BridgeEvent.self, bufferingPolicy: .unbounded)
    }

    /// Opens an authenticated channel. Pass `pairing` only for the first connection from a QR offer.
    public static func connect(
        transport: FrameTransport,
        device: DeviceIdentity,
        hostKey: Data,
        deviceName: String,
        pairing: (id: String, secret: Data)? = nil
    ) async throws -> BridgeClient {
        let client = BridgeClient(transport: transport)
        try await client.handshake(device: device, hostKey: hostKey, deviceName: deviceName, pairing: pairing)
        return client
    }

    /// Connects over URLSession. An unreachable endpoint (e.g. LAN address while on cellular) would
    /// otherwise hang for the TCP timeout, so the handshake is bounded by `timeout`.
    public static func connect(
        url: URL,
        device: DeviceIdentity,
        hostKey: Data,
        deviceName: String,
        pairing: (id: String, secret: Data)? = nil,
        timeout: Duration = .seconds(8)
    ) async throws -> BridgeClient {
        let transport = URLSessionFrameTransport(url: url)
        let watchdog = Task {
            try await Task.sleep(for: timeout)
            transport.close()
        }
        defer { watchdog.cancel() }
        do {
            return try await connect(transport: transport, device: device, hostKey: hostKey, deviceName: deviceName, pairing: pairing)
        } catch let error as BridgeError {
            throw error
        } catch {
            throw BridgeError.noReachableEndpoint
        }
    }

    private func handshake(device: DeviceIdentity, hostKey: Data, deviceName: String, pairing: (id: String, secret: Data)?) async throws {
        let eph = Curve25519.KeyAgreement.PrivateKey()
        var nonceBytes = [UInt8](repeating: 0, count: 16)
        var rng = SystemRandomNumberGenerator()
        for i in nonceBytes.indices { nonceBytes[i] = rng.next() }
        let clientNonce = Data(nonceBytes)
        var hello: [String: JSONValue] = [
            "t": "hello",
            "v": 1,
            "deviceKey": .string(device.publicKey.base64URL),
            "eph": .string(eph.publicKey.rawRepresentation.base64URL),
            "nonce": .string(clientNonce.base64URL),
            "name": .string(deviceName),
        ]
        if let pairing {
            let proof = E2EE.pairingProof(secret: pairing.secret, deviceKey: device.publicKey, clientEph: eph.publicKey.rawRepresentation)
            hello["pairing"] = ["id": .string(pairing.id), "proof": .string(proof.base64URL)]
        }
        try await transport.send(.text(String(decoding: try JSONEncoder().encode(JSONValue.object(hello)), as: UTF8.self)))
        guard case let .text(replyText) = try await transport.receive(),
              let reply = try? JSONDecoder().decode(JSONValue.self, from: Data(replyText.utf8))
        else { throw BridgeError.protocolViolation("expected welcome") }
        if reply["t"]?.string == "error" {
            throw BridgeError.rejected(code: reply["code"]?.string ?? "error", message: reply["message"]?.string ?? "")
        }
        guard reply["t"]?.string == "welcome",
              let serverEph = reply["eph"]?.string.flatMap(Data.init(base64URL:)),
              let serverNonce = reply["nonce"]?.string.flatMap(Data.init(base64URL:))
        else { throw BridgeError.protocolViolation("malformed welcome") }
        let keys = try E2EE.clientKeys(device: device.privateKey, clientEph: eph, transcript: .init(
            deviceKey: device.publicKey,
            hostKey: hostKey,
            clientEph: eph.publicKey.rawRepresentation,
            serverEph: serverEph,
            clientNonce: clientNonce,
            serverNonce: serverNonce
        ))
        cipher = FrameCipher(sendKey: keys.c2s, recvKey: keys.s2c)
        hostId = reply["hostId"]?.string
        readerTask = Task { [weak self] in await self?.readLoop() }
    }

    private func readLoop() async {
        while !closed {
            do {
                let message = try await transport.receive()
                guard case let .data(frame) = message, var cipher else { throw BridgeError.protocolViolation("expected binary frame") }
                let plaintext = try cipher.open(frame)
                self.cipher = cipher
                handle(try JSONDecoder().decode(JSONValue.self, from: plaintext))
            } catch {
                shutdown(reason: (error as? LocalizedError)?.errorDescription ?? "\(error)")
                return
            }
        }
    }

    private func handle(_ message: JSONValue) {
        if let id = message["id"]?.int {
            guard let continuation = pending.removeValue(forKey: id) else { return }
            if let error = message["e"] {
                continuation.resume(throwing: BridgeError.remote(
                    code: error["code"]?.int ?? -1,
                    message: error["message"]?.string ?? "error",
                    reason: error["data"]?["code"]?.string
                ))
            } else {
                continuation.resume(returning: message["r"] ?? .null)
            }
        } else if let name = message["ev"]?.string, let event = BridgeEvent(name: name, payload: message["p"] ?? .null) {
            eventSink.yield(event)
        }
    }

    private func shutdown(reason: String) {
        guard !closed else { return }
        closed = true
        transport.close()
        for continuation in pending.values { continuation.resume(throwing: BridgeError.disconnected) }
        pending.removeAll()
        eventSink.yield(.disconnected(reason: reason))
        eventSink.finish()
    }

    public func close() {
        readerTask?.cancel()
        shutdown(reason: "closed")
    }

    public var isClosed: Bool { closed }

    // MARK: requests

    public func request(_ method: String, _ params: JSONValue = .object([:])) async throws -> JSONValue {
        guard !closed, var cipher else { throw BridgeError.disconnected }
        let id = nextId
        nextId += 1
        let body = try JSONEncoder().encode(JSONValue.object(["id": .number(Double(id)), "m": .string(method), "p": params]))
        let frame = try cipher.seal(body)
        self.cipher = cipher
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            outbox.append((id, frame))
            if !pumping { Task { await self.pumpOutbox() } }
        }
    }

    /// Frames carry strictly increasing counters, so they must hit the socket in seal order.
    private func pumpOutbox() async {
        guard !pumping else { return }
        pumping = true
        defer { pumping = false }
        while !outbox.isEmpty {
            let (id, frame) = outbox.removeFirst()
            do { try await transport.send(.data(frame)) } catch { failRequest(id, error) }
        }
    }

    private func failRequest(_ id: Int, _ error: Error) {
        pending.removeValue(forKey: id)?.resume(throwing: error)
    }

    public func request<T: Decodable>(_ method: String, _ params: JSONValue = .object([:]), as type: T.Type) async throws -> T {
        try await request(method, params).decode(T.self)
    }
}

// MARK: typed API

public extension BridgeClient {
    func hostInfo() async throws -> HostInfo { try await request("host.info", as: HostInfo.self) }

    func listSessions(cwd: String? = nil, query: String? = nil, cursor: String? = nil) async throws -> SessionList {
        var params: [String: JSONValue] = [:]
        if let cwd { params["cwd"] = .string(cwd) }
        if let query, !query.isEmpty { params["query"] = .string(query) }
        if let cursor { params["cursor"] = .string(cursor) }
        return try await request("session.list", .object(params), as: SessionList.self)
    }

    func forkSession(_ sessionId: String) async throws -> OpenSnapshot {
        try await request("session.fork", ["sessionId": .string(sessionId)], as: OpenSnapshot.self)
    }

    func deleteSession(_ sessionId: String) async throws {
        _ = try await request("session.delete", ["sessionId": .string(sessionId)])
    }

    /// `_gjc/sdk/query` page items (bridge allowlist: hub.ts `SDK_QUERIES`).
    func sdkQuery(_ sessionId: String, _ op: String, input: JSONValue = [:]) async throws -> [JSONValue] {
        try await request("sdk.query", ["sessionId": .string(sessionId), "op": .string(op), "input": input])["items"]?.array ?? []
    }

    /// `_gjc/sdk/control` result (bridge allowlist: hub.ts `SDK_CONTROLS`).
    @discardableResult
    func sdkControl(_ sessionId: String, _ op: String, input: JSONValue = [:], confirm: Bool = false) async throws -> JSONValue {
        var params: [String: JSONValue] = ["sessionId": .string(sessionId), "op": .string(op), "input": input]
        if confirm { params["confirm"] = true }
        return try await request("sdk.control", .object(params))["result"] ?? .null
    }

    func newSession(cwd: String?) async throws -> OpenSnapshot {
        try await request("session.new", cwd.map { ["cwd": .string($0)] } ?? [:], as: OpenSnapshot.self)
    }

    func openSession(_ sessionId: String, cwd: String?, afterSeq: Int) async throws -> OpenSnapshot {
        var params: [String: JSONValue] = ["sessionId": .string(sessionId), "afterSeq": .number(Double(afterSeq))]
        if let cwd { params["cwd"] = .string(cwd) }
        return try await request("session.open", .object(params), as: OpenSnapshot.self)
    }

    func closeSession(_ sessionId: String) async throws {
        _ = try await request("session.close", ["sessionId": .string(sessionId)])
    }

    /// Returns the bridge's id for the turn the prompt starts (`nil` from bridges older than `turnId`).
    @discardableResult
    func prompt(_ sessionId: String, blocks: [PromptBlock]) async throws -> String? {
        try await request("session.prompt", ["sessionId": .string(sessionId), "prompt": .array(blocks.map(\.json))])["turnId"]?.string
    }

    /// Stops the busy turn and runs the steers still waiting in gjc's queue as the next turn (TUI Esc with a
    /// queued steer). Returns the text sent; `-32005` means the model already took every steer.
    func interrupt(_ sessionId: String) async throws -> String {
        try await request("session.interrupt", ["sessionId": .string(sessionId)])["text"]?.string ?? ""
    }

    func cancel(_ sessionId: String) async throws {
        _ = try await request("session.cancel", ["sessionId": .string(sessionId)])
    }

    func setConfig(_ sessionId: String, configId: String, value: String) async throws -> [ConfigOption] {
        try await request(
            "session.setConfig",
            ["sessionId": .string(sessionId), "configId": .string(configId), "value": .string(value)],
            as: ConfigResult.self
        ).configOptions
    }

    /// Per-role model assignments from the host's gjc config (`/model` roles).
    func modelRoles() async throws -> ModelRoles {
        try await request("model.roles", as: ModelRoles.self)
    }

    /// Persists a role assignment through gjc (`nil` clears it); answers the roles as saved.
    func setModelRole(_ sessionId: String, role: String, value: ModelSelector?) async throws -> ModelRoles {
        try await request(
            "model.setRole",
            ["sessionId": .string(sessionId), "role": .string(role), "value": value.map { JSONValue.string($0.raw) } ?? .null],
            as: ModelRoles.self
        )
    }

    /// Switches the session's permission mode; every phone sees it as an `x_gjcm_permission_mode` update.
    func setPermissionMode(_ sessionId: String, mode: PermissionMode) async throws {
        _ = try await request("session.setPermissionMode", ["sessionId": .string(sessionId), "mode": .string(mode.rawValue)])
    }

    /// Every session's waiting asks and tool approvals, without opening the chats.
    func pendingPermissions() async throws -> [PermissionRequest] {
        try await request("permission.list", as: PendingPermissions.self).requests
    }

    /// Tries a paired host's endpoints in order. A rejection ends the search: this device is no longer paired.
    static func connectAny(host: PairedHost, device: DeviceIdentity, deviceName: String) async throws -> (BridgeClient, String) {
        guard let hostKey = Data(base64URL: host.hostKey) else { throw BridgeError.protocolViolation("bad host key") }
        var lastError: Error = BridgeError.noReachableEndpoint
        for endpoint in host.endpointsToTry {
            guard let url = URL(string: endpoint) else { continue }
            do {
                return (try await connect(url: url, device: device, hostKey: hostKey, deviceName: deviceName), endpoint)
            } catch let error as BridgeError {
                if case .rejected = error { throw error }
                lastError = error
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    func respondPermission(_ requestId: String, optionId: String?) async throws {
        _ = try await request("permission.respond", ["requestId": .string(requestId), "optionId": optionId.map(JSONValue.string) ?? .null])
    }
}

// MARK: device-code pairing (gjcm-code-v1, #128)

/// Where a code pairing is, for the progress line.
public enum CodePairingStage: Sendable, Equatable {
    /// Dialing the host and waiting for its first answer.
    case connecting
    /// The host answered; the code is being proven (CPace key confirmation). `left` is the host's count of wrong
    /// attempts still allowed for this code (`pake.reply`), when it says.
    case verifying(left: Int?)
}

/// Failures of the code flow. The bridge's own codes (`code_expired`, `code_wrong`, `code_locked`, `code_busy`,
/// `bad_pake`) arrive as `.remote`; the rest are decided on the phone.
public enum CodePairingError: Error, Equatable, LocalizedError {
    /// `code_format`; `position` is the first character outside the alphabet.
    case invalidCode(position: Int?)
    /// `code_unsupported`: a code format newer than this app.
    case unsupportedCode
    case timedOut(host: String)
    case refused
    case unreachable(host: String)
    /// The connection dropped or timed out after the host's `pake.reply`: the host may have counted an attempt.
    case hostInterrupted
    /// A 0.1.5 bridge answers `pake` with `bad_hello`.
    case bridgeOutdated
    /// Tb mismatch, a box that does not open, a bad offer, or an aborted key agreement.
    case pakeFailed
    case remote(code: String, left: Int?)
    /// The code was accepted but the hello that follows failed. `reason` is the hello's own description; the offer is
    /// kept, and `retryable` says whether trying again can help.
    case helloFailed(reason: String, retryable: Bool)
    /// The hello was refused with `pairing_invalid`: the host has to run `pair` again.
    case pairingExpired

    init(_ error: DeviceCodeError) {
        switch error {
        case let .format(position): self = .invalidCode(position: position)
        case .unsupported: self = .unsupportedCode
        }
    }

    /// A hello failure that trying again can fix: no endpoint answered, the link dropped, or the host was busy.
    /// Everything else (a malformed offer, a protocol violation, other rejections) is shown as it is, without a retry.
    public static func helloFailure(_ error: Error) -> CodePairingError {
        let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        switch error {
        case BridgeError.noReachableEndpoint, BridgeError.disconnected:
            return .helloFailed(reason: reason, retryable: true)
        case let BridgeError.rejected(code, _) where code == "pairing_busy":
            // The retry hint is added by `errorDescription`; the busy reason must not carry its own.
            return .helloFailed(reason: "호스트가 다른 페어링을 처리하는 중입니다.", retryable: true)
        default:
            return .helloFailed(reason: reason, retryable: false)
        }
    }

    /// Whether the app offers "다시 시도" for this failure.
    public var isRetryable: Bool {
        switch self {
        case let .helloFailed(_, retryable): return retryable
        case .hostInterrupted: return true
        default: return false
        }
    }

    /// How to read an address that did not answer: Tailscale codes point at `--code-lan`, LAN codes at the iOS
    /// local-network permission.
    private static func unreachableAdvice(host: String) -> String {
        if DeviceCode.isTailscale(host) {
            return "폰의 Tailscale 연결을 확인하세요. 폰이 Tailscale 밖이면 호스트에서 `pair --code-lan`을 쓰거나 QR을 쓰세요."
        }
        return "폰이 호스트와 같은 Wi-Fi에 있는지 확인하세요. 설정 > 개인정보 > 로컬 네트워크에서 가재코드가 허용돼 있는지도 확인하세요."
    }

    public var errorDescription: String? {
        switch self {
        case let .invalidCode(position):
            if let position { return "코드가 올바르지 않습니다. \(position)번째 글자를 확인하세요." }
            return "코드가 올바르지 않습니다. 글자 수와 글자를 다시 확인하세요."
        case .unsupportedCode:
            return "첫 글자를 다시 확인하세요. 맞게 입력했다면 이 앱이 모르는 코드 형식이니 앱을 업데이트하세요."
        case let .timedOut(host):
            let target = DeviceCode.isTailscale(host) ? "\(host)(Tailscale)" : host
            return "\(target)에 닿지 않습니다. " + Self.unreachableAdvice(host: host)
        case .refused:
            return "호스트에서 `gjcm-bridge serve`가 실행 중인지, `pair`와 `serve`의 포트가 같은지 확인하세요."
        case let .unreachable(host):
            return "호스트에 연결할 수 없습니다. " + Self.unreachableAdvice(host: host)
        case .hostInterrupted:
            return "호스트 응답이 끊겼습니다. 남은 시도가 줄었을 수 있습니다. 다시 시도하세요."
        case .bridgeOutdated:
            return "호스트의 gjcm-bridge를 0.1.6 이상으로 업데이트하거나 QR을 쓰세요."
        case .pakeFailed:
            return "호스트 확인에 실패했습니다. 코드를 다시 확인하세요."
        case let .remote(code, left):
            switch code {
            case "code_expired": return "코드가 만료됐거나 이미 사용됐습니다. 호스트에서 `gjcm-bridge pair`를 다시 실행하세요."
            case "code_wrong":
                let base = "코드가 맞지 않습니다(가장 최근 `pair`의 코드인지 확인)."
                guard let left else { return base }
                return base + " 남은 시도 \(left)회"
            case "code_locked": return "틀린 시도가 많아 코드가 폐기됐습니다. `pair`를 다시 실행하세요."
            case "code_busy": return "다른 기기가 이 코드로 연결 중이거나 호스트가 다른 페어링을 처리하는 중입니다. 잠시 후 다시 시도하세요."
            case "bad_pake": return "호스트와 프로토콜이 맞지 않습니다. 앱과 브리지를 업데이트하세요."
            default: return "호스트가 코드를 받아들이지 않았습니다(\(code))."
            }
        case let .helloFailed(reason, retryable):
            return "인증은 끝났지만 연결하지 못했습니다. " + reason + (retryable ? " ‘다시 시도’를 누르세요." : "")
        case .pairingExpired:
            return "코드가 만료됐습니다. 호스트에서 `pair`를 다시 실행하세요."
        }
    }
}

/// The result of a completed code pairing.
struct CodePairing: Sendable {
    let client: BridgeClient
    let offer: PairingOffer
    /// The address that answered, which the hello used.
    let endpoint: URL
}

public extension DecodedCode {
    /// `DeviceCode.decode` with the failure as the app's `CodePairingError`.
    static func parse(_ input: String) throws -> DecodedCode {
        switch DeviceCode.decode(input) {
        case let .success(decoded): return decoded
        case let .failure(error): throw CodePairingError(error)
        }
    }
}

/// How far a code exchange got, shared between the exchange and its watchdog: whether the time ran out, and whether
/// the host's `pake.reply` arrived (a failure after that may have cost an attempt).
private final class CodeExchangeProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var isTimedOut = false
    private var hasReplied = false

    func markReplied() {
        lock.lock()
        hasReplied = true
        lock.unlock()
    }

    var replied: Bool {
        lock.lock()
        defer { lock.unlock() }
        return hasReplied
    }

    func markTimedOut() {
        lock.lock()
        isTimedOut = true
        lock.unlock()
    }

    var timedOut: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isTimedOut
    }
}

public extension BridgeClient {
    /// Runs the CPace exchange of a normalized device code over `transport` and returns the offer out of `pake.ok`.
    /// Closes the transport when done. Transport failures propagate unchanged; protocol failures are `CodePairingError`.
    internal static func fetchOfferWithCode(
        transport: FrameTransport,
        code: String,
        onStage: (@Sendable (CodePairingStage) -> Void)? = nil
    ) async throws -> PairingOffer {
        defer { transport.close() }
        guard let cpace = CPaceInitiator(prs: Data(code.utf8)) else { throw CodePairingError.pakeFailed }
        onStage?(.connecting)
        try await sendCodeFrame(transport, ["t": "pake", "v": 1, "sid": .string(cpace.sid.base64URL), "ya": .string(cpace.ya.base64URL)])
        let reply = try await expectCodeFrame("pake.reply", from: transport)
        onStage?(.verifying(left: reply["left"]?.int))
        guard let yb = reply["yb"]?.string.flatMap(Data.init(base64URL:)), let session = cpace.finish(yb: yb) else {
            throw CodePairingError.pakeFailed
        }
        try await sendCodeFrame(transport, ["t": "pake.confirm", "ta": .string(session.ta.base64URL)])
        let ok = try await expectCodeFrame("pake.ok", from: transport)
        guard let tb = ok["tb"]?.string.flatMap(Data.init(base64URL:)), session.verifyTb(tb) else { throw CodePairingError.pakeFailed }
        guard let box = ok["box"]?.string.flatMap(Data.init(base64URL:)), let plain = session.open(box) else {
            throw CodePairingError.pakeFailed
        }
        do {
            return try PairingOffer.parse(json: plain)
        } catch {
            throw CodePairingError.pakeFailed
        }
    }

    /// The exchange over URLSession. An unreachable address would hang for the TCP timeout, so the whole exchange is
    /// bounded by `timeout`; a timeout and a refused connection are told apart for the message.
    static func fetchOfferWithCode(
        url: URL,
        code: String,
        timeout: Duration = .seconds(10),
        makeTransport: @Sendable (URL) -> FrameTransport = { URLSessionFrameTransport(url: $0) },
        onStage: (@Sendable (CodePairingStage) -> Void)? = nil
    ) async throws -> PairingOffer {
        let transport = makeTransport(url)
        let progress = CodeExchangeProgress()
        let notify: @Sendable (CodePairingStage) -> Void = { stage in
            if case .verifying = stage { progress.markReplied() }
            onStage?(stage)
        }
        let watchdog = Task {
            try await Task.sleep(for: timeout)
            progress.markTimedOut()
            transport.close()
        }
        defer { watchdog.cancel() }
        do {
            return try await fetchOfferWithCode(transport: transport, code: code, onStage: notify)
        } catch let error as CodePairingError {
            throw error
        } catch {
            if progress.replied { throw CodePairingError.hostInterrupted }
            if progress.timedOut { throw CodePairingError.timedOut(host: url.host ?? "") }
            if let urlError = error as? URLError {
                switch urlError.code {
                case .timedOut: throw CodePairingError.timedOut(host: url.host ?? "")
                case .cannotConnectToHost: throw CodePairingError.refused
                default: break
                }
            }
            throw CodePairingError.unreachable(host: url.host ?? "")
        }
    }

    /// Device-code pairing: a CPace session on the code's address gets the offer, then the usual pairing hello follows
    /// on the same address. `dial` overrides the address only (tests dial 127.0.0.1); the password is still the code.
    internal static func pairWithCode(
        _ code: String,
        dial: URL? = nil,
        device: DeviceIdentity,
        deviceName: String,
        timeout: Duration = .seconds(10),
        onStage: (@Sendable (CodePairingStage) -> Void)? = nil
    ) async throws -> CodePairing {
        let decoded = try DecodedCode.parse(code)
        let endpoint = dial ?? decoded.endpoint
        let offer = try await fetchOfferWithCode(url: endpoint, code: decoded.code, timeout: timeout, onStage: onStage)
        guard let hostKey = Data(base64URL: offer.hostKey), let secret = Data(base64URL: offer.secret) else {
            throw CodePairingError.pakeFailed
        }
        let client = try await connect(url: endpoint, device: device, hostKey: hostKey, deviceName: deviceName,
                                       pairing: (offer.pairingId, secret))
        return CodePairing(client: client, offer: offer, endpoint: endpoint)
    }
}

private extension BridgeClient {
    static func sendCodeFrame(_ transport: FrameTransport, _ frame: JSONValue) async throws {
        try await transport.send(.text(String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)))
    }

    static func expectCodeFrame(_ type: String, from transport: FrameTransport) async throws -> JSONValue {
        let message = try await transport.receive()
        guard case let .text(text) = message, let frame = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else {
            throw CodePairingError.pakeFailed
        }
        if frame["t"]?.string == type { return frame }
        if frame["t"]?.string == "error" {
            let remote = frame["code"]?.string ?? ""
            if remote == "bad_hello" { throw CodePairingError.bridgeOutdated }
            throw CodePairingError.remote(code: remote, left: frame["left"]?.int)
        }
        throw CodePairingError.remote(code: "bad_pake", left: nil)
    }
}

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
    case remote(code: Int, message: String)
    case protocolViolation(String)
    case disconnected
    case noReachableEndpoint

    public var errorDescription: String? {
        switch self {
        case let .rejected(code, message):
            switch code {
            case "unknown_device": return "이 호스트와 페어링되지 않은 기기입니다. 다시 페어링하세요."
            case "pairing_invalid": return "페어링 코드가 만료됐거나 이미 사용됐습니다. 호스트에서 `gjcm-bridge pair`를 다시 실행하세요."
            default: return "\(message) (\(code))"
            }
        case let .remote(_, message): return message
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
                continuation.resume(throwing: BridgeError.remote(code: error["code"]?.int ?? -1, message: error["message"]?.string ?? "error"))
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

    func prompt(_ sessionId: String, blocks: [PromptBlock]) async throws {
        _ = try await request("session.prompt", ["sessionId": .string(sessionId), "prompt": .array(blocks.map(\.json))])
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

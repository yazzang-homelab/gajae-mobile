import Foundation

// Bridge RPC payloads (see bridge/src/server.ts `dispatch`).

public struct AgentInfo: Codable, Equatable, Sendable {
    public let name: String
    public let title: String?
    public let version: String?
}

public struct HostInfo: Codable, Equatable, Sendable {
    public let hostName: String
    public let agentInfo: AgentInfo?
    public let defaultCwd: String
    public let bridgeVersion: String
}

public struct SessionSummary: Codable, Equatable, Identifiable, Sendable {
    public var id: String { sessionId }
    public let sessionId: String
    public let cwd: String
    public let title: String?
    public let updatedAt: String?
    public let running: Bool?
    /// Bridge estimate of output tokens/s: live while running, the last turn's average when idle.
    public let tokensPerSecond: Double?

    public init(sessionId: String, cwd: String, title: String?, updatedAt: String?, running: Bool?, tokensPerSecond: Double? = nil) {
        self.sessionId = sessionId
        self.cwd = cwd
        self.title = title
        self.updatedAt = updatedAt
        self.running = running
        self.tokensPerSecond = tokensPerSecond
    }

    /// The same row with a `session.status` event applied.
    public func with(status: SessionStatus) -> SessionSummary {
        SessionSummary(sessionId: sessionId, cwd: cwd, title: title, updatedAt: updatedAt, running: status.running,
                       tokensPerSecond: status.tokensPerSecond)
    }

    public var updatedDate: Date? {
        updatedAt.flatMap { ISO8601DateFormatter.withFractions.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }
    }
}

/// `session.status` event: a session started or stopped working, or (once a second while working) its rate.
public struct SessionStatus: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let running: Bool
    public let tokensPerSecond: Double?
    /// gjc's waiting steers and follow-ups from whichever client queued them; `nil` from a bridge that does not report them.
    public let queued: [QueuedMessage]?

    private enum CodingKeys: String, CodingKey { case sessionId, running, tokensPerSecond, queued }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        running = try c.decode(Bool.self, forKey: .running)
        tokensPerSecond = try c.decodeIfPresent(Double.self, forKey: .tokensPerSecond)
        queued = try c.decodeIfPresent([ReportedQueuedMessage].self, forKey: .queued)?.compactMap(\.message)
    }
}

public struct SessionList: Codable, Equatable, Sendable {
    public let sessions: [SessionSummary]
    public let nextCursor: String?
}

/// `permission.list` reply.
public struct PendingPermissions: Codable, Equatable, Sendable {
    public let requests: [PermissionRequest]
}

/// ACP session config option (mode, model, thinking, …). `options` may arrive flat or grouped.
public struct ConfigOption: Codable, Equatable, Identifiable, Sendable {
    public struct Choice: Codable, Equatable, Hashable, Sendable {
        public let value: String
        public let name: String
        public let group: String?
    }

    public let id: String
    public let name: String
    public let category: String?
    public let type: String?
    public let currentValue: JSONValue?
    public let choices: [Choice]

    enum CodingKeys: String, CodingKey { case id, name, category, type, currentValue, options }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        category = try c.decodeIfPresent(String.self, forKey: .category)
        type = try c.decodeIfPresent(String.self, forKey: .type)
        currentValue = try c.decodeIfPresent(JSONValue.self, forKey: .currentValue)
        let raw = try c.decodeIfPresent([JSONValue].self, forKey: .options) ?? []
        choices = raw.flatMap { item -> [Choice] in
            if let nested = item["options"]?.array {
                let group = item["name"]?.string ?? item["group"]?.string
                return nested.compactMap { Self.choice($0, group: group) }
            }
            return Self.choice(item, group: nil).map { [$0] } ?? []
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(category, forKey: .category)
        try c.encodeIfPresent(type, forKey: .type)
        try c.encodeIfPresent(currentValue, forKey: .currentValue)
        try c.encode(choices.map { JSONValue.object(["value": .string($0.value), "name": .string($0.name)]) }, forKey: .options)
    }

    private static func choice(_ value: JSONValue, group: String?) -> Choice? {
        guard let v = value["value"]?.string else { return nil }
        return Choice(value: v, name: value["name"]?.string ?? v, group: group)
    }

    public var currentChoiceName: String? {
        guard let current = currentValue?.string else { return currentValue?.bool.map { $0 ? "on" : "off" } }
        return choices.first(where: { $0.value == current })?.name ?? current
    }
}

public struct SequencedUpdate: Codable, Equatable, Sendable {
    public let seq: Int
    public let update: JSONValue
}

public struct PermissionOption: Codable, Equatable, Hashable, Sendable {
    public let optionId: String
    public let name: String
    public let kind: String

    public var isAllow: Bool { kind.hasPrefix("allow") }
}

public struct PermissionRequest: Codable, Equatable, Identifiable, Sendable {
    public var id: String { requestId }
    public let requestId: String
    public let sessionId: String
    public let toolCall: JSONValue
    public let options: [PermissionOption]

    public var title: String { toolCall["title"]?.string ?? toolCall["toolName"]?.string ?? "도구 실행" }
    public var detail: String? {
        if let command = toolCall["rawInput"]?["command"]?.string { return command }
        return toolCall["rawInput"].map(\.prettyText)
    }
}

public struct OpenSnapshot: Codable, Equatable, Sendable {
    public let sessionId: String
    public let cwd: String
    public let configOptions: [ConfigOption]
    public let running: Bool
    public let seq: Int
    public let reset: Bool
    public let updates: [SequencedUpdate]
    public let permissions: [PermissionRequest]
    /// Raw `PermissionMode` value; absent from bridges without `session.setPermissionMode`.
    public let permissionMode: String?

    public init(sessionId: String, cwd: String, configOptions: [ConfigOption], running: Bool, seq: Int, reset: Bool,
                updates: [SequencedUpdate], permissions: [PermissionRequest], permissionMode: String? = nil) {
        self.sessionId = sessionId
        self.cwd = cwd
        self.configOptions = configOptions
        self.running = running
        self.seq = seq
        self.reset = reset
        self.updates = updates
        self.permissions = permissions
        self.permissionMode = permissionMode
    }
}

/// gjc's per-session policy for guarded tools (bash, eval, delete, move), switched from the session menu.
public enum PermissionMode: String, CaseIterable, Equatable, Sendable {
    /// Ask on the phone before each guarded tool call (the ACP default).
    case prompt
    /// Run guarded tools without asking.
    case allow
    /// Reject guarded tools without asking.
    case deny

    /// The mode a tap on the menu item switches to: prompt → allow → deny → prompt.
    public var next: PermissionMode {
        let all = Self.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }

    public var label: String {
        switch self {
        case .prompt: "매번 묻기"
        case .allow: "자동 허용"
        case .deny: "모두 거부"
        }
    }
}

public struct ConfigResult: Codable, Equatable, Sendable {
    public let configOptions: [ConfigOption]
}

/// gjc model selector `provider/model[:thinking]` as stored in `modelRoles` / `task.agentModelOverrides`.
public struct ModelSelector: Equatable, Hashable, Sendable {
    /// gjc's thinking levels (`ThinkingLevel`); a trailing `:<level>` is the effort, anything else is part of the id.
    public static let thinkingLevels = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]

    public let model: String
    public let thinking: String?

    public init(model: String, thinking: String?) {
        self.model = model
        self.thinking = thinking.flatMap { $0.isEmpty || $0 == "inherit" ? nil : $0 }
    }

    public init(raw: String) {
        if let colon = raw.lastIndex(of: ":"), Self.thinkingLevels.contains(String(raw[raw.index(after: colon)...])) {
            self.init(model: String(raw[..<colon]), thinking: String(raw[raw.index(after: colon)...]))
        } else {
            self.init(model: raw, thinking: nil)
        }
    }

    public var raw: String { thinking.map { "\(model):\($0)" } ?? model }
}

public struct ModelRoles: Codable, Equatable, Sendable {
    public struct Role: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let value: String?

        public init(id: String, name: String, value: String?) {
            self.id = id
            self.name = name
            self.value = value
        }

        public var selector: ModelSelector? { value.map(ModelSelector.init(raw:)) }
    }

    public let roles: [Role]
    /// Active gjc model profile; while set, roles can only be changed on the host.
    public let profile: String?

    public init(roles: [Role], profile: String?) {
        self.roles = roles
        self.profile = profile
    }
}

public struct UploadTicket: Codable, Equatable, Sendable {
    public let uploadId: String
    public let chunkBytes: Int
}

public struct StoredUpload: Codable, Equatable, Sendable {
    public let uri: String
    public let path: String
    public let name: String
    public let mimeType: String
    public let size: Int
}

public enum BridgeEvent: Equatable, Sendable {
    case sessionUpdate(sessionId: String, update: SequencedUpdate)
    case permissionRequest(PermissionRequest)
    case permissionResolved(requestId: String, sessionId: String)
    case sessionStatus(SessionStatus)
    case disconnected(reason: String)

    init?(name: String, payload: JSONValue) {
        switch name {
        case "session.update":
            guard let sid = payload["sessionId"]?.string, let seq = payload["seq"]?.int, let update = payload["update"] else { return nil }
            self = .sessionUpdate(sessionId: sid, update: SequencedUpdate(seq: seq, update: update))
        case "permission.request":
            guard let request = try? payload.decode(PermissionRequest.self) else { return nil }
            self = .permissionRequest(request)
        case "permission.resolved":
            guard let rid = payload["requestId"]?.string, let sid = payload["sessionId"]?.string else { return nil }
            self = .permissionResolved(requestId: rid, sessionId: sid)
        case "session.status":
            guard let status = try? payload.decode(SessionStatus.self) else { return nil }
            self = .sessionStatus(status)
        default:
            return nil
        }
    }
}

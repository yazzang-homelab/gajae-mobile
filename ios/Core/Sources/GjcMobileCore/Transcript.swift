import Foundation

/// One rendered row of a chat.
public struct TranscriptItem: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case user(text: String, attachments: [Attachment])
        case agent(text: String)
        case thought(text: String)
        case tool(ToolCall)
        case plan(entries: [PlanEntry])
        case turnEnded(stopReason: String, error: String?)
        case notice(String)
    }

    public let id: String
    public var kind: Kind
}

public struct Attachment: Equatable, Sendable, Hashable {
    public enum Kind: Equatable, Sendable, Hashable {
        case image(mimeType: String, base64: String)
        case file(uri: String, mimeType: String?, size: Int?)
        case embeddedText(uri: String)
    }

    public let name: String
    public let kind: Kind
}

public struct ToolCall: Equatable, Sendable {
    public let toolCallId: String
    public var title: String
    public var kind: String?
    public var status: String
    public var rawInput: JSONValue?
    public var output: String

    public var isFinished: Bool { status == "completed" || status == "failed" }
}

public struct PlanEntry: Equatable, Sendable {
    public let content: String
    public let status: String
    public let priority: String?
}

/// Folds the bridge's sequenced ACP `session/update` stream into chat rows.
/// Pure and deterministic: the same updates always yield the same transcript.
public struct SessionTranscript: Equatable, Sendable {
    public private(set) var items: [TranscriptItem] = []
    public private(set) var lastSeq = 0
    public private(set) var running = false
    public private(set) var title: String?
    public private(set) var phase: String?
    public private(set) var configOptions: [ConfigOption] = []
    public private(set) var availableCommands: [String] = []
    public private(set) var usage: JSONValue?
    /// `nil` until the bridge reports one (older bridges cannot switch it).
    public private(set) var permissionMode: PermissionMode?

    private var toolIndex: [String: Int] = [:]
    private var counter = 0

    public init() {}

    /// Applies an open snapshot (resets when the bridge says the client's view is stale).
    public mutating func apply(snapshot: OpenSnapshot) {
        if snapshot.reset { self = SessionTranscript() }
        configOptions = snapshot.configOptions
        for update in snapshot.updates { apply(update) }
        running = snapshot.running
        if let mode = snapshot.permissionMode.flatMap(PermissionMode.init(rawValue:)) { permissionMode = mode }
    }

    public mutating func setConfigOptions(_ options: [ConfigOption]) {
        configOptions = options
    }

    /// Marks a locally submitted turn as running until the bridge's turn-end arrives.
    public mutating func markRunning() {
        running = true
    }

    /// A phone-side status row (slash command results). Not part of the gjc history; a reset drops it.
    public mutating func appendNotice(_ text: String) {
        push(.notice(text))
    }

    /// The last answer the agent streamed, for `/copy`.
    public var lastAgentText: String? {
        for item in items.reversed() {
            if case let .agent(text) = item.kind, !text.isEmpty { return text }
        }
        return nil
    }

    /// The conversation as plain text, for `/dump` and sharing. Thoughts are left out; tools are one line each.
    public var plainText: String {
        items.compactMap { item -> String? in
            switch item.kind {
            case let .user(text, attachments):
                let files = attachments.map { "[첨부: \($0.name)]" }.joined(separator: " ")
                return "## 나\n" + [text, files].filter { !$0.isEmpty }.joined(separator: "\n")
            case let .agent(text): return "## gjc\n" + text
            case let .tool(call): return "- 도구 \(call.title) (\(call.status))"
            case let .plan(entries): return entries.map { "- [\($0.status == "completed" ? "x" : " ")] \($0.content)" }.joined(separator: "\n")
            case let .turnEnded(reason, error): return "— 턴 종료: \(reason)" + (error.map { " (\($0))" } ?? "")
            case let .notice(text): return "— \(text)"
            case .thought: return nil
            }
        }.joined(separator: "\n\n")
    }

    public mutating func apply(_ entry: SequencedUpdate) {
        guard entry.seq > lastSeq else { return } // snapshot/live overlap
        lastSeq = entry.seq
        let u = entry.update
        switch u["sessionUpdate"]?.string ?? "" {
        case "user_message_chunk":
            appendUser(u["content"])
        case "agent_message_chunk":
            appendStreaming(u["content"]?["text"]?.string ?? "", thought: false)
        case "agent_thought_chunk":
            appendStreaming(u["content"]?["text"]?.string ?? "", thought: true)
        case "tool_call", "tool_call_update":
            mergeTool(u)
        case "plan":
            let entries = (u["entries"]?.array ?? []).map {
                PlanEntry(content: $0["content"]?.string ?? "", status: $0["status"]?.string ?? "pending", priority: $0["priority"]?.string)
            }
            if case .plan = items.last?.kind {
                items[items.count - 1].kind = .plan(entries: entries)
            } else {
                push(.plan(entries: entries))
            }
        case "session_info_update":
            if let t = u["title"]?.string { title = t }
            if let p = u["_meta"]?["gjcPhase"]?.string { phase = p }
            if let r = u["_meta"]?["running"]?.bool { running = r }
        case "config_option_update":
            if let options = try? (u["configOptions"] ?? .array([])).decode([ConfigOption].self) { configOptions = options }
        case "available_commands_update":
            availableCommands = (u["availableCommands"]?.array ?? []).compactMap { $0["name"]?.string }
        case "usage_update":
            usage = u
        case "x_gjcm_turn_end":
            running = false
            phase = "idle"
            let reason = u["stopReason"]?.string ?? "end_turn"
            if reason != "end_turn" { push(.turnEnded(stopReason: reason, error: u["error"]?.string)) }
            for index in toolIndex.values {
                guard case var .tool(call) = items[index].kind, !call.isFinished else { continue }
                call.status = reason == "end_turn" ? "completed" : "failed"
                items[index].kind = .tool(call)
            }
        case "x_gjcm_permission_mode":
            if let mode = u["mode"]?.string.flatMap(PermissionMode.init(rawValue:)) { permissionMode = mode }
        case "x_gjcm_agent_exit":
            running = false
            push(.notice("호스트의 gjc 프로세스가 종료됐습니다. 다음 요청 때 다시 시작합니다."))
        default:
            break
        }
    }

    private mutating func push(_ kind: TranscriptItem.Kind) {
        counter += 1
        items.append(TranscriptItem(id: "i\(counter)", kind: kind))
    }

    private mutating func appendUser(_ content: JSONValue?) {
        guard let content else { return }
        var text = ""
        var attachments: [Attachment] = []
        switch content["type"]?.string {
        case "text":
            text = content["text"]?.string ?? ""
        case "image":
            attachments.append(Attachment(name: "이미지", kind: .image(mimeType: content["mimeType"]?.string ?? "image/png", base64: content["data"]?.string ?? "")))
        case "resource_link":
            let uri = content["uri"]?.string ?? ""
            attachments.append(Attachment(
                name: content["name"]?.string ?? URL(string: uri)?.lastPathComponent ?? uri,
                kind: .file(uri: uri, mimeType: content["mimeType"]?.string, size: content["size"]?.int)
            ))
        case "resource":
            let uri = content["resource"]?["uri"]?.string ?? ""
            attachments.append(Attachment(name: URL(string: uri)?.lastPathComponent ?? uri, kind: .embeddedText(uri: uri)))
        default:
            return
        }
        if case let .user(prevText, prevAttachments) = items.last?.kind {
            let joined = prevText.isEmpty || text.isEmpty ? prevText + text : prevText + "\n" + text
            items[items.count - 1].kind = .user(text: joined, attachments: prevAttachments + attachments)
        } else {
            push(.user(text: text, attachments: attachments))
        }
    }

    private mutating func appendStreaming(_ chunk: String, thought: Bool) {
        switch items.last?.kind {
        case let .agent(text) where !thought:
            items[items.count - 1].kind = .agent(text: text + chunk)
        case let .thought(text) where thought:
            items[items.count - 1].kind = .thought(text: text + chunk)
        default:
            push(thought ? .thought(text: chunk) : .agent(text: chunk))
        }
    }

    private mutating func mergeTool(_ u: JSONValue) {
        guard let id = u["toolCallId"]?.string else { return }
        var call: ToolCall
        if let index = toolIndex[id], case let .tool(existing) = items[index].kind {
            call = existing
        } else {
            call = ToolCall(toolCallId: id, title: "도구", kind: nil, status: "pending", rawInput: nil, output: "")
        }
        if let title = u["title"]?.string { call.title = title }
        if let kind = u["kind"]?.string { call.kind = kind }
        if let status = u["status"]?.string { call.status = status }
        if let input = u["rawInput"] { call.rawInput = input }
        if let content = u["content"]?.array {
            let texts = content.compactMap { $0["content"]?["text"]?.string ?? $0["text"]?.string }
            if !texts.isEmpty { call.output = texts.joined(separator: "\n") }
        }
        if let index = toolIndex[id] {
            items[index].kind = .tool(call)
        } else {
            push(.tool(call))
            toolIndex[id] = items.count - 1
        }
    }
}

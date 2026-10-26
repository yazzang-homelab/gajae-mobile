/// Decides which bridge events deserve a local notification: a newly arrived ask (`permission.request`) and a
/// session switching between working and idle (`session.status`). Repeats are dropped — the bridge re-delivers
/// pending asks after a reconnect and sends a status tick every second while a session works.
public struct ActivityAlerts: Sendable {
    public enum Alert: Equatable, Sendable {
        case ask(sessionId: String, requestId: String, title: String)
        case started(sessionId: String)
        case finished(sessionId: String)

        public var sessionId: String {
            switch self {
            case let .ask(sessionId, _, _), let .started(sessionId), let .finished(sessionId): sessionId
            }
        }
    }

    /// Ask ids already announced, oldest first; bounded so a long-lived connection does not grow without limit.
    private var announcedAsks: [String] = []
    private var running: [String: Bool] = [:]
    static let askMemory = 256

    public init() {}

    public mutating func permission(_ request: PermissionRequest) -> Alert? {
        guard !announcedAsks.contains(request.requestId) else { return nil }
        announcedAsks.append(request.requestId)
        if announcedAsks.count > Self.askMemory { announcedAsks.removeFirst(announcedAsks.count - Self.askMemory) }
        return .ask(sessionId: request.sessionId, requestId: request.requestId, title: request.title)
    }

    /// A session's first observed state only becomes the baseline: right after connecting the phone cannot tell
    /// whether a running session just started.
    public mutating func status(sessionId: String, running now: Bool) -> Alert? {
        guard let before = running.updateValue(now, forKey: sessionId), before != now else { return nil }
        return now ? .started(sessionId: sessionId) : .finished(sessionId: sessionId)
    }

    /// Session list rows carry the same running flag; a change seen there (e.g. a turn that ended while the
    /// phone was reconnecting) is a real transition too.
    public mutating func sessions(_ list: [SessionSummary]) -> [Alert] {
        list.compactMap { summary in summary.running.flatMap { status(sessionId: summary.sessionId, running: $0) } }
    }
}

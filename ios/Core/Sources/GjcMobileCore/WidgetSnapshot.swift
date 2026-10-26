import Foundation

/// One paired host as the home-screen widget last saw it. The app writes it (live connection or background
/// refresh); the widget extension only reads it. It never holds question or command text, only counts, labels
/// and times. Mirrors Android `core/WidgetSnapshot.kt`.
public struct WidgetHost: Codable, Equatable, Sendable {
    public let hostId: String
    public var name: String
    /// Last time the app had the full picture (session list and pending asks) over a live connection; nil = never.
    public var observedAt: Date?
    public var sessions: [WidgetSession]

    public init(hostId: String, name: String, observedAt: Date?, sessions: [WidgetSession]) {
        self.hostId = hostId
        self.name = name
        self.observedAt = observedAt
        self.sessions = sessions
    }

    /// App Group shared by the app and the widget extension (project.yml entitlements), and the snapshot file in it.
    public static let appGroup = "group.dev.gajae.gjcmobile"
    public static let fileName = "widget.json"

    /// Sessions that ended longer ago than this drop out of the widget.
    public static let endedMemory: TimeInterval = 12 * 3600
    public static let maxSessions = 12

    public static func unobserved(hostId: String, name: String) -> WidgetHost {
        WidgetHost(hostId: hostId, name: name, observedAt: nil, sessions: [])
    }

    /// The host as seen right now. A session that was working at `previous` and is idle now ended between the two
    /// observations; `now` is the latest time it can have ended.
    public static func observe(
        previous: WidgetHost?,
        hostId: String,
        name: String,
        sessions: [SessionSummary],
        waiting: [PermissionRequest],
        now: Date
    ) -> WidgetHost {
        let waitingBySession = Dictionary(grouping: waiting, by: \.sessionId).mapValues(\.count)
        let before = Dictionary((previous?.sessions ?? []).map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first })
        let listed = sessions.map { summary -> WidgetSession in
            let running = summary.running == true
            let prior = before[summary.sessionId]
            let endedAt: Date? = if running { nil } else if prior?.running == true { now } else { prior?.endedAt }
            let title = summary.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let folder = URL(fileURLWithPath: summary.cwd).lastPathComponent
            return WidgetSession(
                sessionId: summary.sessionId,
                cwd: summary.cwd,
                label: !title.isEmpty ? title : (folder.isEmpty || folder == "/" ? "세션" : folder),
                running: running,
                waiting: waitingBySession[summary.sessionId] ?? 0,
                endedAt: endedAt
            )
        }
        let listedIds = Set(listed.map(\.sessionId))
        // An ask in a session past the first page of the list still counts.
        let unlisted = waitingBySession.keys.filter { !listedIds.contains($0) }.sorted().map { sessionId -> WidgetSession in
            let count = waitingBySession[sessionId] ?? 0
            if var known = before[sessionId] {
                known.waiting = count
                known.running = true
                known.endedAt = nil
                return known
            }
            return WidgetSession(sessionId: sessionId, cwd: "", label: "세션", running: true, waiting: count, endedAt: nil)
        }
        let kept = (unlisted + listed).filter { session in
            if session.waiting > 0 || session.running { return true }
            guard let ended = session.endedAt else { return false }
            return now.timeIntervalSince(ended) < endedMemory
        }
        return WidgetHost(hostId: hostId, name: name, observedAt: now, sessions: Array(kept.prefix(maxSessions)))
    }

    public static func encode(_ hosts: [WidgetHost]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(hosts)
    }

    public static func decode(_ data: Data?) -> [WidgetHost] {
        guard let data else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([WidgetHost].self, from: data)) ?? []
    }
}

public struct WidgetSession: Codable, Equatable, Sendable {
    public let sessionId: String
    /// Only for opening the chat from the widget; never displayed.
    public let cwd: String
    public let label: String
    public var running: Bool
    /// Pending asks and tool approvals.
    public var waiting: Int
    /// When the app saw this session go from working to idle; nil when it never saw it working.
    public var endedAt: Date?

    public init(sessionId: String, cwd: String, label: String, running: Bool, waiting: Int, endedAt: Date?) {
        self.sessionId = sessionId
        self.cwd = cwd
        self.label = label
        self.running = running
        self.waiting = waiting
        self.endedAt = endedAt
    }
}

/// What the widget draws. A host whose last observation is older than `staleAfter` (or that was never observed)
/// contributes no counts: its old "0 waiting" or "working" would read as current, so it turns into "확인 필요".
public struct WidgetState: Equatable, Sendable {
    public enum Kind: Int, Comparable, Sendable {
        case waiting, unconfirmed, running, ended
        public static func < (a: Kind, b: Kind) -> Bool { a.rawValue < b.rawValue }
    }

    public struct Row: Equatable, Identifiable, Sendable {
        public var id: String { "\(hostId)/\(sessionId)" }
        public let hostId: String
        public let hostName: String
        public let sessionId: String
        public let cwd: String
        public let label: String
        public let kind: Kind
        public let waiting: Int
        /// Observation time for waiting/running/unconfirmed, end time for ended.
        public let at: Date?

        public func status(now: Date) -> String {
            switch kind {
            case .waiting: waiting > 1 ? "응답 대기 \(waiting)" : "응답 대기"
            case .unconfirmed: "확인 필요"
            case .running: "작업 중"
            case .ended: at.map { "실행 종료 · \(WidgetState.age($0, now: now))" } ?? "실행 종료"
            }
        }
    }

    public let paired: Bool
    /// Waiting asks/approvals on hosts seen recently. A lower bound when `needsCheck`.
    public let waiting: Int
    public let running: Int
    public let needsCheck: Bool
    /// The oldest observation among hosts that have one; nil when no host was ever observed.
    public let observedAt: Date?
    public let rows: [Row]

    public static let staleAfter: TimeInterval = 15 * 60

    /// Big status line: what to do, never a reassuring number that may be stale.
    public var headline: String {
        if !paired { return "연결된 컴퓨터 없음" }
        if waiting > 0 { return "응답 대기 \(waiting)" }
        if needsCheck { return "확인 필요" }
        if running > 0 { return "작업 중 \(running)" }
        return "대기 없음"
    }

    /// One line for the lock screen and small widget footer: no session names.
    public func summary(now: Date) -> String {
        if !paired { return headline }
        var parts: [String] = []
        if waiting > 0 { parts.append("대기 \(waiting)") }
        if needsCheck {
            parts.append("확인 필요")
        } else if running > 0 {
            parts.append("작업중 \(running)")
        } else if waiting == 0 {
            parts.append("대기 없음")
        }
        parts.append(observedAt.map { Self.age($0, now: now) } ?? "확인 안 됨")
        return parts.joined(separator: " · ")
    }

    public static func present(_ hosts: [WidgetHost], now: Date, maxRows: Int = 6) -> WidgetState {
        var waiting = 0
        var running = 0
        var needsCheck = hosts.isEmpty
        var rows: [Row] = []
        for host in hosts {
            let fresh = host.observedAt.map { now.timeIntervalSince($0) <= staleAfter } ?? false
            if !fresh { needsCheck = true }
            for session in host.sessions {
                let kind: Kind
                if session.waiting > 0 || session.running {
                    kind = fresh ? (session.waiting > 0 ? .waiting : .running) : .unconfirmed
                } else if session.endedAt != nil {
                    kind = .ended
                } else {
                    continue
                }
                if kind == .waiting { waiting += session.waiting }
                if kind == .running { running += 1 }
                rows.append(Row(hostId: host.hostId, hostName: host.name, sessionId: session.sessionId, cwd: session.cwd,
                                label: session.label, kind: kind, waiting: session.waiting,
                                at: kind == .ended ? session.endedAt : host.observedAt))
            }
        }
        // Stable sort: kind first, then newest first.
        let ordered = rows.enumerated().sorted { a, b in
            if a.element.kind != b.element.kind { return a.element.kind < b.element.kind }
            let at = a.element.at ?? .distantPast, bt = b.element.at ?? .distantPast
            return at != bt ? at > bt : a.offset < b.offset
        }.map(\.element)
        return WidgetState(
            paired: !hosts.isEmpty,
            waiting: waiting,
            running: running,
            needsCheck: needsCheck,
            observedAt: hosts.compactMap(\.observedAt).min(),
            rows: Array(ordered.prefix(maxRows))
        )
    }

    /// The moment a fresh host turns stale, so the widget timeline can redraw then.
    public static func nextStaleAt(_ hosts: [WidgetHost], now: Date) -> Date? {
        hosts.compactMap { $0.observedAt?.addingTimeInterval(staleAfter) }.filter { $0 > now }.min()
    }

    public static func age(_ at: Date, now: Date) -> String {
        let minutes = max(0, Int(now.timeIntervalSince(at) / 60))
        switch minutes {
        case ..<1: return "방금"
        case ..<60: return "\(minutes)분 전"
        case ..<(60 * 24): return "\(minutes / 60)시간 전"
        default: return "\(minutes / (60 * 24))일 전"
        }
    }
}

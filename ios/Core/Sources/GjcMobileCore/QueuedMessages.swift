import Foundation

/// A message waiting on a busy turn: a steer (next step) or a follow-up (after the turn).
public struct QueuedMessage: Equatable, Sendable {
    public let text: String
    public let followUp: Bool
    /// When this phone sent it (seconds since 1970); 0 for entries from the bridge's report.
    public let sentAt: TimeInterval

    public init(text: String, followUp: Bool, sentAt: TimeInterval = 0) {
        self.text = text
        self.followUp = followUp
        self.sentAt = sentAt
    }
}

/// One `session.status.queued` entry (gjc `queue.messages.list`, mode steer|followUp). Unknown modes decode to `nil`.
struct ReportedQueuedMessage: Decodable {
    let message: QueuedMessage?

    private enum CodingKeys: String, CodingKey { case text, mode }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let text = try? c.decode(String.self, forKey: .text) else { message = nil; return }
        switch try? c.decode(String.self, forKey: .mode) {
        case "steer": message = QueuedMessage(text: text, followUp: false)
        case "followUp": message = QueuedMessage(text: text, followUp: true)
        default: message = nil
        }
    }
}

/// What the chat shows as waiting. The bridge reports gjc's own queue once a second while the session works,
/// including steers typed in the TUI or on another phone. A steer this phone just sent can miss the last report,
/// so it shows on its own for `graceSeconds`; after that only gjc's queue counts (gjc may have taken it already).
/// `host == nil` is a bridge without queue reports: only this phone's steers are known.
public enum QueuedMessages {
    public static let graceSeconds: TimeInterval = 2.5

    public static func merge(sent: [QueuedMessage], host: [QueuedMessage]?, now: TimeInterval) -> [QueuedMessage] {
        guard let host else { return sent }
        let pending = sent.filter { s in
            now - s.sentAt < graceSeconds && !host.contains { $0.text == s.text && $0.followUp == s.followUp }
        }
        return host + pending
    }
}

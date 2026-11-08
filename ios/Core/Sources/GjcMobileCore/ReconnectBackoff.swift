import Foundation

/// When a host connection dials again. A failed dial waits `first` seconds, doubling up to `longest`. A connection that
/// drops within `stableAfter` of attaching counts as a failed dial too: a drop the phone causes itself (a chat snapshot
/// over its frame limit, say) comes back the moment it dials again, and dialing at once repeated it 32 times 0.55s
/// apart (2026-11-08, pve1). A connection that held up dials again at once, with the wait back at `first`.
public struct ReconnectBackoff: Sendable, Equatable {
    public static let first: TimeInterval = 1
    public static let longest: TimeInterval = 30
    public static let stableAfter: TimeInterval = 10

    private var next: TimeInterval = ReconnectBackoff.first
    private var attachedAt: TimeInterval?

    public init() {}

    /// The wait before the next dial after one failed.
    public mutating func failedDial() -> TimeInterval {
        let wait = next
        next = min(next * 2, Self.longest)
        return wait
    }

    public mutating func attached(at now: TimeInterval) {
        attachedAt = now
    }

    /// The wait before dialing again after an attached connection dropped.
    public mutating func dropped(at now: TimeInterval) -> TimeInterval {
        defer { attachedAt = nil }
        if let attachedAt, now - attachedAt >= Self.stableAfter {
            next = Self.first
            return 0
        }
        return failedDial()
    }
}

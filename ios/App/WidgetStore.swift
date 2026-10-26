import Foundation
import GjcMobileCore
import WidgetKit

/// The widget's only data source: what the app last observed per paired host, in the shared App Group container
/// (no keys, no question text). Written by the live connections and by `WidgetRefresher`; a lock keeps their
/// read-modify-write steps from interleaving. The file stays readable on the lock screen after the first unlock.
enum WidgetStore {
    private static let lock = NSLock()
    /// Unchanged content is not rewritten within this window (`session.status` ticks every second while working).
    private static let rewriteAfter: TimeInterval = 60

    private static var fileURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetHost.appGroup)?
            .appendingPathComponent(WidgetHost.fileName)
    }

    static func hosts() -> [WidgetHost] {
        lock.withLock { read() }
    }

    /// Records a full observation of one host.
    static func observe(host: PairedHost, sessions: [SessionSummary], waiting: [PermissionRequest], now: Date = Date()) {
        let changed = lock.withLock {
            let all = read()
            let previous = all.first { $0.hostId == host.hostId }
            let next = WidgetHost.observe(previous: previous, hostId: host.hostId, name: host.name,
                                          sessions: sessions, waiting: waiting, now: now)
            if let previous, let seen = previous.observedAt, now.timeIntervalSince(seen) < rewriteAfter {
                var same = previous
                same.observedAt = next.observedAt
                if same == next { return false }
            }
            var updated = all
            if let index = updated.firstIndex(where: { $0.hostId == host.hostId }) { updated[index] = next } else { updated.append(next) }
            write(updated)
            return true
        }
        if changed { redraw() }
    }

    /// Keeps the stored hosts equal to the paired ones: forgotten hosts disappear, new ones show as never checked.
    static func sync(_ paired: [PairedHost]) {
        let changed = lock.withLock {
            let all = read()
            let next = paired.map { host in
                guard var known = all.first(where: { $0.hostId == host.hostId }) else {
                    return WidgetHost.unobserved(hostId: host.hostId, name: host.name)
                }
                known.name = host.name
                return known
            }
            guard next != all else { return false }
            write(next)
            return true
        }
        if changed { redraw() }
    }

    static func redraw() {
        WidgetCenter.shared.reloadAllTimelines()
    }

    private static func read() -> [WidgetHost] {
        WidgetHost.decode(fileURL.flatMap { try? Data(contentsOf: $0) })
    }

    private static func write(_ hosts: [WidgetHost]) {
        guard let url = fileURL, let data = try? WidgetHost.encode(hosts) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

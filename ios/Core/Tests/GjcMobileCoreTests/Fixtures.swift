import Foundation
@testable import GjcMobileCore

/// Shared fixtures live in <repo>/fixtures so the bridge (TypeScript) and the app (Swift) test the same bytes.
enum Fixtures {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // GjcMobileCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // Core
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // repo
        .appendingPathComponent("fixtures")

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: root.appendingPathComponent(name))
    }

    static func json(_ name: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: data(name))
    }

    /// `session/update` notifications from a recorded real gjc ACP run, numbered like the bridge does.
    static func recordedUpdates(_ name: String) throws -> [SequencedUpdate] {
        let text = String(decoding: try data(name), as: UTF8.self)
        var seq = 0
        return text.split(separator: "\n").compactMap { line -> SequencedUpdate? in
            guard !line.hasPrefix(">>"),
                  let message = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)),
                  message["method"]?.string == "session/update",
                  let update = message["params"]?["update"]
            else { return nil }
            seq += 1
            return SequencedUpdate(seq: seq, update: update)
        }
    }
}

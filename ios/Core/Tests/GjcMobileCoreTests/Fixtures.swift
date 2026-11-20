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

    /// Lowercase hex (as in cpace-vector.json) to bytes.
    static func hex(_ text: String) -> Data {
        var bytes: [UInt8] = []
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            bytes.append(UInt8(text[index ..< next], radix: 16)!)
            index = next
        }
        return Data(bytes)
    }

    static func hexString(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
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

import Foundation
import XCTest
@testable import GjcMobileCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Swift client ↔ real bridge process (with the fake ACP agent). Opt-in: set GJCM_BRIDGE_DIR to
/// <repo>/bridge (needs `bun` on PATH and `bun install` done there).
final class BridgeLiveTests: XCTestCase {
    private var process: Process?
    private var home: URL?

    override func tearDown() {
        process?.terminate()
        process?.waitUntilExit()
        if let home { try? FileManager.default.removeItem(at: home) }
    }

    private func startBridge(bridgeDir: String) throws -> (endpoint: URL, hostKey: Data, pairing: (id: String, secret: Data)) {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("gjcm-swift-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        self.home = home
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", "\(bridgeDir)/test/serve-fixture.ts"]
        var env = ProcessInfo.processInfo.environment
        env["GJCM_HOME"] = home.path
        env["GJCM_TEST_AGENT"] = String(decoding: try JSONEncoder().encode(["bun", "\(bridgeDir)/test/fake-acp-agent.ts"]), as: UTF8.self)
        env["GJCM_TEST_CWD"] = FileManager.default.temporaryDirectory.path
        env["FAKE_ACP_STATE"] = home.appendingPathComponent("fake.json").path
        // Scratch session store for both the fake agent and the bridge's saved-session index; the
        // inherited GJC_CODING_AGENT_DIR is the user's real ~/.gjc/agent.
        env["GJCM_FAKE_AGENT_DIR"] = home.appendingPathComponent("agent").path
        env["GJC_CODING_AGENT_DIR"] = home.appendingPathComponent("agent").path
        process.environment = env
        let stdout = Pipe()
        process.standardOutput = stdout
        try process.run()
        self.process = process

        var line = Data()
        while !line.contains(UInt8(ascii: "\n")) {
            let chunk = stdout.fileHandleForReading.availableData
            if chunk.isEmpty { throw XCTSkip("bridge fixture exited") }
            line.append(chunk)
        }
        let port = try XCTUnwrap(try JSONDecoder().decode(JSONValue.self, from: line)["port"]?.int)
        let hostJSON = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: home.appendingPathComponent("host.json")))
        let hostKey = try XCTUnwrap(hostJSON["publicKey"]?.string.flatMap(Data.init(base64URL:)))
        // Same record `gjcm-bridge pair` writes.
        let secret = Data((0 ..< 32).map { _ in UInt8.random(in: 0 ... 255) })
        let pairing: JSONValue = [["id": "swift", "secret": .string(secret.base64URL), "expiresAt": "2999-01-01T00:00:00.000Z"]]
        try JSONEncoder().encode(pairing).write(to: home.appendingPathComponent("pairings.json"))
        return (URL(string: "ws://127.0.0.1:\(port)/ws")!, hostKey, ("swift", secret))
    }

    func testPairPromptPermissionAttachmentsOverRealBridge() async throws {
        guard let bridgeDir = ProcessInfo.processInfo.environment["GJCM_BRIDGE_DIR"] else {
            throw XCTSkip("set GJCM_BRIDGE_DIR to run the live bridge test")
        }
        let bridge = try startBridge(bridgeDir: bridgeDir)
        let device = DeviceIdentity()
        let client = try await BridgeClient.connect(url: bridge.endpoint, device: device, hostKey: bridge.hostKey,
                                                    deviceName: "swift-test", pairing: bridge.pairing)
        let info = try await client.hostInfo()
        XCTAssertEqual(info.agentInfo?.name, "fake-gjc")

        let opened = try await client.newSession(cwd: nil)
        var transcript = SessionTranscript()
        transcript.apply(snapshot: opened)
        XCTAssertEqual(transcript.configOptions.map(\.id), ["model", "thinking"])

        let file = Data((0 ..< 700_000).map { UInt8(truncatingIfNeeded: $0) })
        let blocks = try await client.promptBlocks(text: "tool 써서 첨부 봐줘", attachments: [
            PendingAttachment(name: "사진.jpg", payload: .image(Data([0xFF, 0xD8, 0xFF]), mimeType: "image/jpeg")),
            PendingAttachment(name: "로그.bin", payload: .file(file, mimeType: "application/octet-stream")),
        ], sessionId: opened.sessionId)
        guard case let .resourceLink(stored) = blocks[2] else { return XCTFail("expected uploaded link") }
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: stored.path)), file)

        try await client.prompt(opened.sessionId, blocks: blocks)
        var answered = false
        events: for await event in client.events {
            switch event {
            case let .permissionRequest(request):
                XCTAssertEqual(request.title, "echo hi")
                // What the widget refresh reads without opening the chat.
                let pending = try await client.pendingPermissions()
                XCTAssertEqual(pending.map(\.requestId), [request.requestId])
                let allow = try XCTUnwrap(request.options.first(where: \.isAllow))
                try await client.respondPermission(request.requestId, optionId: allow.optionId)
                answered = true
            case let .sessionUpdate(_, update):
                transcript.apply(update)
                if update.update["sessionUpdate"]?.string == "x_gjcm_turn_end" { break events }
            case let .disconnected(reason):
                return XCTFail("disconnected: \(reason)")
            default:
                break
            }
        }
        XCTAssertEqual(transcript.items.last?.kind, .agent(text: "받은 블록: text,image,resource_link"))
        XCTAssertTrue(answered)
        guard case let .user(text, attachments) = transcript.items.first?.kind else { return XCTFail("user row") }
        XCTAssertEqual(text, "tool 써서 첨부 봐줘")
        XCTAssertEqual(attachments.count, 2)
        guard case let .tool(call) = transcript.items[1].kind else { return XCTFail("tool row") }
        XCTAssertEqual(call.status, "completed")
        await client.close()
    }
}

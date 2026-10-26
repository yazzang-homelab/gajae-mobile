import Crypto
import Foundation
import XCTest
@testable import GjcMobileCore

final class E2EEVectorTests: XCTestCase {
    func testSwiftDerivesTheBridgeKeysAndOpensItsFrames() throws {
        let v = try Fixtures.json("e2ee-vector.json")
        func bytes(_ key: String) throws -> Data { try XCTUnwrap(v[key]?.string.flatMap(Data.init(base64URL:)), key) }
        let device = try DeviceIdentity(rawPrivateKey: bytes("devicePrivate"))
        let clientEph = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: bytes("clientEphPrivate"))
        let keys = try E2EE.clientKeys(device: device.privateKey, clientEph: clientEph, transcript: .init(
            deviceKey: device.publicKey,
            hostKey: bytes("hostPublic"),
            clientEph: clientEph.publicKey.rawRepresentation,
            serverEph: bytes("serverEphPublic"),
            clientNonce: bytes("clientNonce"),
            serverNonce: bytes("serverNonce")
        ))
        XCTAssertEqual(keys.c2s, try bytes("c2s"))
        XCTAssertEqual(keys.s2c, try bytes("s2c"))

        var phone = FrameCipher(sendKey: keys.c2s, recvKey: keys.s2c)
        let frames = try XCTUnwrap(v["serverFrames"]?.array).compactMap { $0.string.flatMap(Data.init(base64URL:)) }
        XCTAssertEqual(String(decoding: try phone.open(frames[0]), as: UTF8.self), v["plaintext"]?.string)
        XCTAssertEqual(String(decoding: try phone.open(frames[1]), as: UTF8.self), "{}")
        XCTAssertThrowsError(try phone.open(frames[0])) { XCTAssertEqual($0 as? E2EEError, .replayedFrame) }

        let proof = E2EE.pairingProof(secret: try bytes("pairingSecret"), deviceKey: device.publicKey, clientEph: clientEph.publicKey.rawRepresentation)
        XCTAssertEqual(proof, try bytes("pairingProof"))
    }

    func testTamperedFrameIsRejectedWithoutAdvancingState() throws {
        let key = Data(repeating: 9, count: 32)
        var a = FrameCipher(sendKey: key, recvKey: key)
        var b = FrameCipher(sendKey: key, recvKey: key)
        var frame = try a.seal(Data("hello".utf8))
        frame[frame.count - 1] ^= 1
        XCTAssertThrowsError(try b.open(frame)) { XCTAssertEqual($0 as? E2EEError, .authenticationFailed) }
        XCTAssertEqual(try b.open(a.seal(Data("next".utf8))), Data("next".utf8))
    }
}

final class TranscriptTests: XCTestCase {
    func testRecordedGjcTurnFoldsIntoUserToolAndAgentRows() throws {
        var transcript = SessionTranscript()
        for update in try Fixtures.recordedUpdates("acp-echo-permission.trace") { transcript.apply(update) }
        transcript.apply(SequencedUpdate(seq: transcript.lastSeq + 1, update: ["sessionUpdate": "x_gjcm_turn_end", "stopReason": "end_turn"]))

        XCTAssertEqual(transcript.items.count, 3)
        guard case let .user(text, attachments) = transcript.items[0].kind else { return XCTFail("user row") }
        XCTAssertTrue(text.hasPrefix("bash 도구로"))
        XCTAssertTrue(attachments.isEmpty)
        guard case let .tool(call) = transcript.items[1].kind else { return XCTFail("tool row") }
        XCTAssertEqual(call.status, "completed")
        XCTAssertEqual(call.kind, "execute")
        XCTAssertTrue(call.output.contains("hello-acp"))
        XCTAssertEqual(call.rawInput?["command"]?.string, "echo hello-acp")
        guard case let .agent(answer) = transcript.items[2].kind else { return XCTFail("agent row") }
        XCTAssertEqual(answer, "`echo hello-acp`를 실행했고, 출력은 `hello-acp`였습니다.")
        XCTAssertFalse(transcript.running)
        XCTAssertTrue(transcript.availableCommands.contains { $0.hasPrefix("skill:") })
    }

    func testSnapshotResetAndLiveOverlapAreIdempotent() {
        let chunk: (Int, String) -> SequencedUpdate = { seq, text in
            SequencedUpdate(seq: seq, update: ["sessionUpdate": "agent_message_chunk", "content": ["type": "text", "text": .string(text)]])
        }
        var transcript = SessionTranscript()
        transcript.apply(chunk(1, "가"))
        transcript.apply(chunk(2, "재"))
        transcript.apply(chunk(2, "재")) // duplicate from snapshot/live overlap
        XCTAssertEqual(transcript.items.map(\.kind), [.agent(text: "가재")])

        let snapshot = OpenSnapshot(sessionId: "s", cwd: "/", configOptions: [], running: true, seq: 1, reset: true,
                                    updates: [chunk(1, "새")], permissions: [])
        transcript.apply(snapshot: snapshot)
        XCTAssertEqual(transcript.items.map(\.kind), [.agent(text: "새")])
        XCTAssertTrue(transcript.running)
    }

    func testPermissionModeCyclesAndFollowsSnapshotAndUpdates() {
        XCTAssertEqual([PermissionMode.prompt.next, .allow.next, .deny.next], [.allow, .deny, .prompt])
        var t = SessionTranscript()
        XCTAssertNil(t.permissionMode)
        let changed = SequencedUpdate(seq: 1, update: ["sessionUpdate": "x_gjcm_permission_mode", "mode": "allow"])
        // The snapshot's mode is the current one even when its replayed updates still carry an older change.
        t.apply(snapshot: OpenSnapshot(sessionId: "s", cwd: "/", configOptions: [], running: false, seq: 1, reset: true,
                                       updates: [changed], permissions: [], permissionMode: "deny"))
        XCTAssertEqual(t.permissionMode, .deny)
        t.apply(SequencedUpdate(seq: 2, update: ["sessionUpdate": "x_gjcm_permission_mode", "mode": "prompt"]))
        XCTAssertEqual(t.permissionMode, .prompt)
        t.apply(SequencedUpdate(seq: 3, update: ["sessionUpdate": "x_gjcm_permission_mode", "mode": "bogus"]))
        XCTAssertEqual(t.permissionMode, .prompt)
        XCTAssertTrue(t.items.isEmpty)
    }

    func testAttachmentsAndCancelledTurn() {
        var t = SessionTranscript()
        t.apply(SequencedUpdate(seq: 1, update: ["sessionUpdate": "user_message_chunk", "content": ["type": "text", "text": "봐줘"]]))
        t.apply(SequencedUpdate(seq: 2, update: ["sessionUpdate": "user_message_chunk", "content": ["type": "image", "mimeType": "image/jpeg", "data": "AAAA"]]))
        t.apply(SequencedUpdate(seq: 3, update: ["sessionUpdate": "user_message_chunk",
                                                 "content": ["type": "resource_link", "uri": "file:///h/u/a-보고서.pdf", "name": "보고서.pdf", "size": 10]]))
        t.apply(SequencedUpdate(seq: 4, update: ["sessionUpdate": "tool_call", "toolCallId": "t", "title": "read", "status": "pending"]))
        t.apply(SequencedUpdate(seq: 5, update: ["sessionUpdate": "x_gjcm_turn_end", "stopReason": "cancelled"]))
        guard case let .user(text, attachments) = t.items[0].kind else { return XCTFail() }
        XCTAssertEqual(text, "봐줘")
        XCTAssertEqual(attachments.map(\.name), ["이미지", "보고서.pdf"])
        guard case let .tool(call) = t.items[1].kind else { return XCTFail() }
        XCTAssertEqual(call.status, "failed")
        XCTAssertEqual(t.items[2].kind, .turnEnded(stopReason: "cancelled", error: nil))
    }
}

final class ModelTests: XCTestCase {
    func testPairingOfferParsing() throws {
        let offer: JSONValue = [
            "v": 1, "hostId": "h1", "name": "pve", "hostKey": .string(Data(repeating: 1, count: 32).base64URL),
            "endpoints": ["ws://100.64.0.1:7787/ws"], "pairingId": "p1",
            "secret": .string(Data(repeating: 2, count: 32).base64URL), "exp": "2999-01-01T00:00:00.000Z",
        ]
        let url = "gjcm://pair?o=" + (try JSONEncoder().encode(offer)).base64URL
        let parsed = try PairingOffer.parse(url)
        XCTAssertEqual(parsed.endpoints, ["ws://100.64.0.1:7787/ws"])
        XCTAssertThrowsError(try PairingOffer.parse(url, now: Date(timeIntervalSince1970: 40_000_000_000))) {
            XCTAssertEqual($0 as? PairingOffer.ParseError, .expired)
        }
        XCTAssertThrowsError(try PairingOffer.parse("https://example.com")) {
            XCTAssertEqual($0 as? PairingOffer.ParseError, .notGjcmURL)
        }
        let host = PairedHost(offer: parsed)
        var moved = host
        moved.lastEndpoint = "ws://192.168.0.2:7787/ws"
        moved.endpoints.append("ws://192.168.0.2:7787/ws")
        XCTAssertEqual(moved.endpointsToTry.first, "ws://192.168.0.2:7787/ws")
    }

    func testConfigOptionsDecodeFlatAndGroupedChoices() throws {
        let raw: JSONValue = [
            ["id": "model", "name": "Model", "currentValue": "b", "options": [
                ["name": "Anthropic", "options": [["value": "a", "name": "A"], ["value": "b", "name": "B"]]],
                ["value": "c", "name": "C"],
            ]],
        ]
        let options = try raw.decode([ConfigOption].self)
        XCTAssertEqual(options[0].choices.map(\.value), ["a", "b", "c"])
        XCTAssertEqual(options[0].choices[0].group, "Anthropic")
        XCTAssertEqual(options[0].currentChoiceName, "B")
    }

    func testSessionStatusEventUpdatesTheListRow() throws {
        let event = BridgeEvent(name: "session.status", payload: ["sessionId": "s1", "running": true, "tokensPerSecond": 42.5])
        guard case let .sessionStatus(status)? = event else { return XCTFail("not a session.status event") }
        let row = SessionSummary(sessionId: "s1", cwd: "/tmp", title: "t", updatedAt: nil, running: false)
        let updated = row.with(status: status)
        XCTAssertEqual(updated.running, true)
        XCTAssertEqual(updated.tokensPerSecond, 42.5)
        XCTAssertEqual(updated.title, "t")
        let idle = BridgeEvent(name: "session.status", payload: ["sessionId": "s1", "running": false])
        guard case let .sessionStatus(stopped)? = idle else { return XCTFail("idle status without a rate must still decode") }
        XCTAssertNil(updated.with(status: stopped).tokensPerSecond)
        XCTAssertNil(BridgeEvent(name: "session.status", payload: ["running": true]))
    }

    func testModelSelectorSplitsOnlyAKnownThinkingSuffix() {
        let full = ModelSelector(raw: "oci-opencodex/anthropic/claude-opus-5-5:xhigh")
        XCTAssertEqual(full.model, "oci-opencodex/anthropic/claude-opus-5-5")
        XCTAssertEqual(full.thinking, "xhigh")
        XCTAssertEqual(full.raw, "oci-opencodex/anthropic/claude-opus-5-5:xhigh")
        // A colon inside the model id (ollama tags) is not an effort.
        let tagged = ModelSelector(raw: "ollama/qwen3:8b")
        XCTAssertEqual(tagged.model, "ollama/qwen3:8b")
        XCTAssertNil(tagged.thinking)
        XCTAssertEqual(ModelSelector(raw: "a/b:inherit").raw, "a/b")
        XCTAssertEqual(ModelSelector(model: "a/b", thinking: "inherit").raw, "a/b")
        XCTAssertEqual(ModelSelector(model: "a/b", thinking: "low").raw, "a/b:low")
    }

    func testModelRolesDecodeTheBridgeShape() throws {
        let json = #"{"roles":[{"id":"default","name":"기본","value":"p/m:high"},{"id":"critic","name":"Critic"}],"profile":"ox-luna"}"#
        let roles = try JSONDecoder().decode(ModelRoles.self, from: Data(json.utf8))
        XCTAssertEqual(roles.roles.first?.selector, ModelSelector(model: "p/m", thinking: "high"))
        XCTAssertNil(roles.roles.last?.selector)
        XCTAssertEqual(roles.profile, "ox-luna")
        let none = try JSONDecoder().decode(ModelRoles.self, from: Data(#"{"roles":[]}"#.utf8))
        XCTAssertNil(none.profile)
    }

    func testPromptBlocksMatchAcpShapes() {
        XCTAssertEqual(PromptBlock.image(data: Data([1, 2]), mimeType: "image/jpeg").json,
                       ["type": "image", "mimeType": "image/jpeg", "data": "AQI="])
        let link = PromptBlock.resourceLink(StoredUpload(uri: "file:///x/a.pdf", path: "/x/a.pdf", name: "a.pdf", mimeType: "application/pdf", size: 3))
        XCTAssertEqual(link.json["type"], "resource_link")
        XCTAssertEqual(link.json["size"]?.int, 3)
    }
}

@testable import GjcMobileCore
import XCTest

final class InlineImageBudgetTests: XCTestCase {
    func testPhotosUnderTheBudgetKeepTheirSize() {
        XCTAssertEqual(AttachmentLimits.inlineImageTargets([60_000, 100_000], budget: 180_000), [nil, nil])
    }

    func testOnePhotoOverTheBudgetIsReEncodedToAllOfIt() {
        XCTAssertEqual(AttachmentLimits.inlineImageTargets([700_000], budget: 180_000), [180_000])
    }

    func testASmallPhotoLeavesItsUnusedShareToTheLargeOnes() {
        // An even share is 60 KB; the 20 KB photo keeps its size, the other two split the remaining 160 KB.
        XCTAssertEqual(AttachmentLimits.inlineImageTargets([500_000, 20_000, 300_000], budget: 180_000), [80_000, nil, 80_000])
    }

    func testTargetsTogetherStayWithinTheBudget() {
        let sizes = [900_000, 31_000, 47_000, 2_000_000]
        let targets = AttachmentLimits.inlineImageTargets(sizes, budget: 180_000)
        let total = zip(sizes, targets).reduce(0) { $0 + ($1.1 ?? $1.0) }
        XCTAssertLessThanOrEqual(total, 180_000)
        XCTAssertEqual(targets[1], nil)
        XCTAssertEqual(targets[2], nil)
    }

    func testPromptBlocksRefusePhotosOverTheBudget() async throws {
        let transport = UnusedTransport()
        let client = BridgeClient(transport: transport)
        let photo = PendingAttachment(name: "사진.jpg", payload: .image(Data(count: AttachmentLimits.maxInlineImageBytes + 1), mimeType: "image/jpeg"))
        do {
            _ = try await client.promptBlocks(text: "봐", attachments: [photo], sessionId: "s1")
            XCTFail("photos over the inline budget must not be sent")
        } catch let error as AttachmentError {
            XCTAssertEqual(error, .inlineImagesTooLarge(bytes: AttachmentLimits.maxInlineImageBytes + 1, limit: AttachmentLimits.maxInlineImageBytes))
        }
        XCTAssertEqual(transport.sent, 0, "nothing reaches the bridge")
    }

    func testAShortTextLeavesThePhotosTheFullBudget() {
        XCTAssertEqual(AttachmentLimits.inlineImageBudget(text: "이거 봐", images: 3, files: 1), AttachmentLimits.maxInlineImageBytes)
    }

    func testTheTextIsMeasuredAsTheBridgeMeasuresIt() {
        // 가 is 3 bytes in UTF-8; a quote and a newline are escaped to 2; other control characters to \u00XX.
        XCTAssertEqual(AttachmentLimits.jsonStringBytes("가\"\n\u{1}a"), 3 + 2 + 2 + 6 + 1)
    }

    /// Whatever the text, the blocks the bridge measures stay under its limit when the photos fill their budget.
    func testALongTextShrinksThePhotoBudgetToFitTheBridgeLimit() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        for text in [String(repeating: "a", count: 60_000), String(repeating: "가", count: 25_000), String(repeating: "\"\n", count: 20_000)] {
            for images in 1 ... 4 {
                let budget = try XCTUnwrap(AttachmentLimits.inlineImageBudget(text: text, images: images, files: 0))
                XCTAssertLessThan(budget, AttachmentLimits.maxInlineImageBytes)
                let photos = AttachmentLimits.inlineImageTargets([Int](repeating: 1_000_000, count: images), budget: budget)
                var blocks = [WireBlock(type: "text", text: text, data: nil, mimeType: nil)]
                for size in photos {
                    blocks.append(WireBlock(type: "image", text: nil, data: Data(repeating: 0xFF, count: try XCTUnwrap(size)).base64EncodedString(), mimeType: "image/jpeg"))
                }
                XCTAssertLessThanOrEqual(try encoder.encode(blocks).count, AttachmentLimits.promptBytesLimit, "\(text.count) chars, \(images) photos")
            }
        }
    }

    func testATextThatLeavesNoRoomRefusesThePhotos() async throws {
        let text = String(repeating: "a", count: 255_000)
        XCTAssertNil(AttachmentLimits.inlineImageBudget(text: text, images: 1, files: 0))
        let client = BridgeClient(transport: UnusedTransport())
        let photo = PendingAttachment(name: "사진.jpg", payload: .image(Data(count: 1_000), mimeType: "image/jpeg"))
        do {
            _ = try await client.promptBlocks(text: text, attachments: [photo], sessionId: "s1")
            XCTFail("expected the photo to be refused")
        } catch let error as AttachmentError {
            XCTAssertEqual(error, .textCrowdsOutPhotos)
        }
    }
}

private struct WireBlock: Encodable {
    let type: String
    let text: String?
    let data: String?
    let mimeType: String?
}

private final class UnusedTransport: FrameTransport, @unchecked Sendable {
    private(set) var sent = 0
    func send(_ message: TransportMessage) async throws { sent += 1 }
    func receive() async throws -> TransportMessage { throw CancellationError() }
    func close() {}
}

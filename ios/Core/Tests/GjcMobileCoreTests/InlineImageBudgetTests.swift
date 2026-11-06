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
        let photo = PendingAttachment(name: "사진.jpg", payload: .image(Data(count: AttachmentLimits.inlineImageBudget + 1), mimeType: "image/jpeg"))
        do {
            _ = try await client.promptBlocks(text: "봐", attachments: [photo], sessionId: "s1")
            XCTFail("photos over the inline budget must not be sent")
        } catch let error as AttachmentError {
            XCTAssertEqual(error, .inlineImagesTooLarge(bytes: AttachmentLimits.inlineImageBudget + 1, limit: AttachmentLimits.inlineImageBudget))
        }
        XCTAssertEqual(transport.sent, 0, "nothing reaches the bridge")
    }
}

private final class UnusedTransport: FrameTransport, @unchecked Sendable {
    private(set) var sent = 0
    func send(_ message: TransportMessage) async throws { sent += 1 }
    func receive() async throws -> TransportMessage { throw CancellationError() }
    func close() {}
}

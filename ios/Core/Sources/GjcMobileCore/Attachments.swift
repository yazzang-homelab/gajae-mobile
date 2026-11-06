import Foundation

/// ACP prompt content blocks gjc accepts (`acpPromptPayload`): text, image, resource_link, text resource.
public enum PromptBlock: Equatable, Sendable {
    case text(String)
    case image(data: Data, mimeType: String)
    case resourceLink(StoredUpload)
    case textResource(uri: String, text: String, mimeType: String?)

    public var json: JSONValue {
        switch self {
        case let .text(text):
            return ["type": "text", "text": .string(text)]
        case let .image(data, mimeType):
            return ["type": "image", "mimeType": .string(mimeType), "data": .string(data.base64EncodedString())]
        case let .resourceLink(upload):
            return [
                "type": "resource_link",
                "uri": .string(upload.uri),
                "name": .string(upload.name),
                "mimeType": .string(upload.mimeType),
                "size": .number(Double(upload.size)),
            ]
        case let .textResource(uri, text, mimeType):
            var resource: [String: JSONValue] = ["uri": .string(uri), "text": .string(text)]
            if let mimeType { resource["mimeType"] = .string(mimeType) }
            return ["type": "resource", "resource": .object(resource)]
        }
    }
}

/// A file the user picked in the composer, before it is sent.
public struct PendingAttachment: Identifiable, Equatable, Sendable {
    public enum Payload: Equatable, Sendable {
        /// Already downscaled/re-encoded by the app (see ImagePreparation in the app target).
        case image(Data, mimeType: String)
        case file(Data, mimeType: String)
    }

    public let id: UUID
    public let name: String
    public let payload: Payload

    public init(id: UUID = UUID(), name: String, payload: Payload) {
        self.id = id
        self.name = name
        self.payload = payload
    }

    public var byteCount: Int {
        switch payload {
        case let .image(data, _), let .file(data, _): return data.count
        }
    }
}

public enum AttachmentLimits {
    /// Inline image ceiling after downscaling (mirrors gajae-app's 5 MB image cap).
    public static let maxImageBytes = 5 * 1024 * 1024
    /// Bridge-side upload ceiling (bridge/src/uploads.ts MAX_UPLOAD_BYTES).
    public static let maxFileBytes = 25 * 1024 * 1024
    /// Longest image edge sent to the model.
    public static let maxImageEdge = 2048
    /// Photos sent inline in one prompt, all together. gjc's ACP refuses a prompt whose SDK frame passes 256 KiB
    /// (`MAX_PROMPT_FRAME_BYTES`, gjc 0.19.3) and photos travel there as base64 (4/3 their size): 180 KB of JPEG
    /// is 234 KiB on the wire, leaving room for the text. Measured 2026-11-06 with claude-opus-5-5, gpt-5.6-sol and
    /// claude-haiku-5-5: a phone screenshot or a menu photo re-encoded into 190 KB (or 47 KB, one of four) read
    /// as well as the 2048px original; dense small print, such as a bus timetable shot from a step away, did not.
    public static let inlineImageBudget = 180_000

    /// The byte size each inline photo has to be re-encoded to so that together they fit `budget`, in the order
    /// given; `nil` keeps that photo as it is. Photos under an even share keep their size and leave the rest of it
    /// to the larger ones, which share what is left evenly.
    public static func inlineImageTargets(_ sizes: [Int], budget: Int = inlineImageBudget) -> [Int?] {
        guard sizes.reduce(0, +) > budget else { return sizes.map { _ in nil } }
        var targets = [Int?](repeating: nil, count: sizes.count)
        var remaining = budget
        var left = sizes.count
        for index in sizes.indices.sorted(by: { sizes[$0] < sizes[$1] }) {
            let share = remaining / left
            if sizes[index] > share {
                targets[index] = share
                remaining -= share
            } else {
                remaining -= sizes[index]
            }
            left -= 1
        }
        return targets
    }
}

public enum AttachmentError: Error, Equatable, LocalizedError {
    case tooLarge(name: String, limit: Int)
    case inlineImagesTooLarge(bytes: Int, limit: Int)

    public var errorDescription: String? {
        switch self {
        case let .tooLarge(name, limit):
            return "\(name): \(limit / 1024 / 1024)MB를 넘어 보낼 수 없습니다."
        case let .inlineImagesTooLarge(bytes, limit):
            return "사진이 모두 합쳐 \(bytes / 1000)KB라 한 번에 보낼 수 있는 \(limit / 1000)KB를 넘습니다. 사진 수를 줄이세요."
        }
    }
}

public extension BridgeClient {
    /// Uploads a file in bridge-sized chunks with an end-to-end SHA-256 check.
    func upload(_ data: Data, name: String, mimeType: String, sessionId: String,
                progress: (@Sendable (Double) -> Void)? = nil) async throws -> StoredUpload {
        guard data.count <= AttachmentLimits.maxFileBytes else {
            throw AttachmentError.tooLarge(name: name, limit: AttachmentLimits.maxFileBytes)
        }
        let ticket = try await request("upload.begin", [
            "sessionId": .string(sessionId),
            "name": .string(name),
            "size": .number(Double(data.count)),
            "mimeType": .string(mimeType),
            "sha256": .string(data.sha256Hex),
        ], as: UploadTicket.self)
        var offset = 0
        while offset < data.count {
            let end = min(offset + ticket.chunkBytes, data.count)
            let chunk = data.subdata(in: offset ..< end)
            _ = try await request("upload.chunk", [
                "uploadId": .string(ticket.uploadId),
                "offset": .number(Double(offset)),
                "data": .string(chunk.base64EncodedString()),
            ])
            offset = end
            progress?(Double(offset) / Double(data.count))
        }
        return try await request("upload.commit", ["uploadId": .string(ticket.uploadId)], as: StoredUpload.self)
    }

    /// Turns composer text + attachments into prompt blocks, uploading non-image files first.
    /// `progress` reports the fraction of attachment bytes delivered so far (images count as sent immediately).
    func promptBlocks(text: String, attachments: [PendingAttachment], sessionId: String,
                      progress: (@Sendable (Double) -> Void)? = nil) async throws -> [PromptBlock] {
        let inlineBytes = attachments.reduce(0) { sum, attachment in
            if case let .image(data, _) = attachment.payload { return sum + data.count }
            return sum
        }
        guard inlineBytes <= AttachmentLimits.inlineImageBudget else {
            throw AttachmentError.inlineImagesTooLarge(bytes: inlineBytes, limit: AttachmentLimits.inlineImageBudget)
        }
        let total = max(1, attachments.reduce(0) { $0 + $1.byteCount })
        var done = 0
        var blocks: [PromptBlock] = []
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { blocks.append(.text(trimmed)) }
        for attachment in attachments {
            switch attachment.payload {
            case let .image(data, mimeType):
                guard data.count <= AttachmentLimits.maxImageBytes else {
                    throw AttachmentError.tooLarge(name: attachment.name, limit: AttachmentLimits.maxImageBytes)
                }
                blocks.append(.image(data: data, mimeType: mimeType))
            case let .file(data, mimeType):
                let before = done
                blocks.append(.resourceLink(try await upload(data, name: attachment.name, mimeType: mimeType, sessionId: sessionId) { fraction in
                    progress?((Double(before) + fraction * Double(data.count)) / Double(total))
                }))
            }
            done += attachment.byteCount
            progress?(Double(done) / Double(total))
        }
        return blocks
    }
}

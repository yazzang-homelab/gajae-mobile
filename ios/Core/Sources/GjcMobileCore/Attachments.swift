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
}

public enum AttachmentError: Error, Equatable, LocalizedError {
    case tooLarge(name: String, limit: Int)

    public var errorDescription: String? {
        switch self {
        case let .tooLarge(name, limit):
            return "\(name): \(limit / 1024 / 1024)MB를 넘어 보낼 수 없습니다."
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

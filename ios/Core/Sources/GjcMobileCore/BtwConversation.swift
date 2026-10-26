import Foundation

/// The `/btw` side chat: questions answered from the session's visible conversation through
/// `_gjc/sdk/control` `turn.btw` (gjc local patch 0004). Nothing is written to the session transcript.
///
/// The host is stateless: each call carries the earlier answered exchanges, so follow-ups keep context
/// and closing the bubble simply drops this value.
public struct BtwConversation: Equatable, Sendable {
    public struct Exchange: Equatable, Sendable, Identifiable {
        public let id: Int
        public let question: String
        public var answer: String?
        public var error: String?

        public var isPending: Bool { answer == nil && error == nil }
    }

    /// gjc's `BTW_MAX_QUESTION_UTF8_BYTES`.
    public static let maxQuestionBytes = 16 * 1024

    public private(set) var exchanges: [Exchange] = []

    public init() {}

    public var isPending: Bool { exchanges.last?.isPending ?? false }
    public var hasAnswer: Bool { exchanges.contains { $0.answer != nil } }

    public enum Rejection: Error, Equatable, Sendable {
        case empty
        case busy
        case tooLong(maxBytes: Int)

        public var message: String {
            switch self {
            case .empty: "질문을 입력하세요."
            case .busy: "앞 질문의 답을 기다리는 중입니다."
            case let .tooLong(maxBytes): "질문은 \(maxBytes / 1024)KB까지 보낼 수 있습니다."
            }
        }
    }

    /// Appends a pending question and returns the `turn.btw` input (question + answered exchanges).
    public mutating func ask(_ text: String) -> Result<JSONValue, Rejection> {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return .failure(.empty) }
        guard !isPending else { return .failure(.busy) }
        guard question.utf8.count <= Self.maxQuestionBytes else { return .failure(.tooLong(maxBytes: Self.maxQuestionBytes)) }
        let context: [JSONValue] = exchanges.compactMap { exchange in
            exchange.answer.map { .object(["question": .string(exchange.question), "answer": .string($0)]) }
        }
        exchanges.append(Exchange(id: exchanges.count, question: question))
        var input: [String: JSONValue] = ["question": .string(question)]
        if !context.isEmpty { input["exchanges"] = .array(context) }
        return .success(.object(input))
    }

    /// Completes the pending question with the `turn.btw` result (`{ replyText }`).
    public mutating func finish(result: JSONValue) {
        let reply = result["replyText"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if reply.isEmpty { fail("빈 답변을 받았습니다.") } else { resolve { $0.answer = reply } }
    }

    public mutating func fail(_ message: String) {
        resolve { $0.error = message }
    }

    private mutating func resolve(_ change: (inout Exchange) -> Void) {
        guard let last = exchanges.indices.last, exchanges[last].isPending else { return }
        change(&exchanges[last])
    }

    /// Draft for the forked session: the side chat so far, for the user to edit and send there.
    public var forkDraft: String {
        let body = exchanges.compactMap { exchange in
            exchange.answer.map { "질문: \(exchange.question)\n답변: \($0)" }
        }.joined(separator: "\n\n")
        return "방금 /btw 사이드 대화에서 이어서 진행합니다.\n\n\(body)\n\n"
    }

    /// The text after `/btw ` when the composer just turned into a side question, else `nil`.
    public static func trigger(in draft: String) -> String? {
        guard draft.count >= 5, draft.prefix(4).lowercased() == "/btw", let fifth = draft.dropFirst(4).first, fifth.isWhitespace else { return nil }
        return String(draft.dropFirst(5))
    }
}

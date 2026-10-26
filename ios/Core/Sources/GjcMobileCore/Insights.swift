import Foundation

// Decoded `_gjc/sdk/query` results the phone renders natively. Shapes were measured against gjc 0.18.7
// (see bridge/test/e2e-gjc.test.ts); unknown fields are ignored and missing ones read as absent.

public struct ContextUsage: Equatable, Sendable {
    public let tokens: Int
    public let contextWindow: Int
    public let percent: Double
    public let estimated: Bool
    public let steeringQueueDepth: Int
    public let followUpQueueDepth: Int
    public let systemPromptChars: Int?

    public init?(_ item: JSONValue?) {
        guard let usage = item?["usage"], let window = usage["contextWindow"]?.int, window > 0 else { return nil }
        tokens = usage["tokens"]?.int ?? 0
        contextWindow = window
        percent = usage["percent"]?.number ?? Double(tokens) / Double(window) * 100
        estimated = usage["source"]?.string == "heuristic"
        steeringQueueDepth = item?["steeringQueueDepth"]?.int ?? 0
        followUpQueueDepth = item?["followupQueueDepth"]?.int ?? 0
        systemPromptChars = item?["systemPromptChars"]?.int
    }

    public var fraction: Double { min(max(percent / 100, 0), 1) }
    public var remainingTokens: Int { max(contextWindow - tokens, 0) }
}

public struct UsageTotals: Equatable, Sendable {
    public let input: Int
    public let output: Int
    public let cacheRead: Int
    public let cacheWrite: Int
    public let premiumRequests: Int
    public let cost: Double

    public init?(_ item: JSONValue?) {
        guard let item, item.object != nil else { return nil }
        input = item["input"]?.int ?? 0
        output = item["output"]?.int ?? 0
        cacheRead = item["cacheRead"]?.int ?? 0
        cacheWrite = item["cacheWrite"]?.int ?? 0
        premiumRequests = item["premiumRequests"]?.int ?? 0
        cost = item["cost"]?.number ?? 0
    }

    public var totalTokens: Int { input + output + cacheRead + cacheWrite }
}

public struct TodoTask: Equatable, Sendable {
    public let content: String
    public let status: String
    public let notes: [String]

    public var isDone: Bool { status == "completed" || status == "abandoned" }
}

public struct TodoPhase: Equatable, Sendable {
    public let name: String
    public let tasks: [TodoTask]

    /// `todo.list` items are gjc `TodoPhase`s: `{name, tasks:[{content, status, notes?}]}`.
    public static func parse(_ items: [JSONValue]) -> [TodoPhase] {
        items.compactMap { item in
            guard let tasks = item["tasks"]?.array else { return nil }
            return TodoPhase(
                name: item["name"]?.string ?? "",
                tasks: tasks.map {
                    TodoTask(content: $0["content"]?.string ?? "", status: $0["status"]?.string ?? "pending",
                         notes: ($0["notes"]?.array ?? []).compactMap(\.string))
                }
            )
        }
    }
}

public extension Array where Element == TodoPhase {
    var taskCount: Int { reduce(0) { $0 + $1.tasks.count } }
    var doneCount: Int { reduce(0) { $0 + $1.tasks.filter(\.isDone).count } }
    var current: TodoTask? { lazy.flatMap(\.tasks).first(where: { $0.status == "in_progress" }) }
}

public struct GoalState: Equatable, Sendable {
    public let enabled: Bool
    public let objective: String?
    public let status: String?
    public let message: String?

    public init?(_ item: JSONValue?) {
        guard let item, item.object != nil else { return nil }
        enabled = item["enabled"]?.bool ?? false
        let goal = item["goal"]
        objective = goal?["objective"]?.string ?? goal?["text"]?.string
        status = goal?["status"]?.string ?? item["status"]?.string
        message = item["message"]?.string
    }
}

public struct JobsSnapshot: Equatable, Sendable {
    public struct Job: Equatable, Sendable {
        public let id: String
        public let label: String
        public let status: String
    }

    public let running: [Job]
    public let recent: [Job]
    public let queuedDeliveries: Int

    public init?(_ item: JSONValue?) {
        guard let item, item.object != nil else { return nil }
        func jobs(_ value: JSONValue?) -> [Job] {
            (value?.array ?? []).map {
                Job(id: $0["id"]?.string ?? $0["jobId"]?.string ?? "",
                    label: $0["label"]?.string ?? $0["description"]?.string ?? $0["kind"]?.string ?? $0["id"]?.string ?? "작업",
                    status: $0["status"]?.string ?? "")
            }
        }
        running = jobs(item["running"])
        recent = jobs(item["recent"])
        queuedDeliveries = item["delivery"]?["queued"]?.int ?? 0
    }
}

public extension Int {
    /// 55356 → "55.4K", 1000000 → "1M".
    var compactTokens: String {
        switch self {
        case ..<1_000: return "\(self)"
        case ..<1_000_000: return Self.trim(Double(self) / 1_000) + "K"
        default: return Self.trim(Double(self) / 1_000_000) + "M"
        }
    }

    private static func trim(_ value: Double) -> String {
        let text = String(format: value >= 100 ? "%.0f" : "%.1f", value)
        return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
    }
}

import Foundation
import XCTest
@testable import GjcMobileCore

final class SlashCommandTests: XCTestCase {
    func testBuiltinsMapToTheNativeCallsGjcWouldHaveRun() {
        XCTAssertEqual(SlashCommandCatalog.resolve("/context"), .run(.showInfo(.context)))
        XCTAssertEqual(SlashCommandCatalog.resolve("  /compact  "), .run(.control(op: "compaction.run", input: [:], confirm: false, notice: "컨텍스트를 압축했습니다.")))
        XCTAssertEqual(SlashCommandCatalog.resolve("/clear"), .run(.control(op: "context.clear", input: [:], confirm: true, notice: "컨텍스트를 비웠습니다.")))
        XCTAssertEqual(SlashCommandCatalog.resolve("/model"), .run(.pickConfig(.model)))
        XCTAssertEqual(SlashCommandCatalog.resolve("/model gpt 5.6"), .run(.setConfig(.model, query: "gpt 5.6")))
        XCTAssertEqual(SlashCommandCatalog.resolve("/effort high"), .run(.setConfig(.thinking, query: "high")))
        if case .hostOnly(name: "plan", _) = SlashCommandCatalog.resolve("/plan on") {} else { XCTFail("plan is host-only over ACP") }
        XCTAssertEqual(SlashCommandCatalog.resolve("/fast on"), .run(.control(op: "service_tier.set", input: ["tier": "priority"], confirm: false, notice: "우선 처리 티어를 켰습니다.")))
        XCTAssertEqual(SlashCommandCatalog.resolve("/rename 새 이름 두 단어"), .run(.control(op: "session.rename", input: ["name": "새 이름 두 단어"], confirm: false, notice: "이름을 바꿨습니다.")))
        XCTAssertEqual(SlashCommandCatalog.resolve("/rename"), .run(.askRename))
        XCTAssertEqual(SlashCommandCatalog.resolve("/goal set 테스트 통과시키기"),
                       .run(.control(op: "mode.goal.operate", input: ["op": "create", "objective": "테스트 통과시키기"], confirm: false, notice: "목표를 설정했습니다.")))
        XCTAssertEqual(SlashCommandCatalog.resolve("/goal"), .run(.showInfo(.goal)))
        XCTAssertEqual(SlashCommandCatalog.resolve("/session delete"), .run(.deleteSession))
        XCTAssertEqual(SlashCommandCatalog.resolve("/resume"), .run(.openSessions))
        XCTAssertEqual(SlashCommandCatalog.resolve("/FORK"), .run(.forkSession))
    }

    func testArgumentErrorsHostOnlySkillsAndProse() {
        XCTAssertEqual(SlashCommandCatalog.resolve("/fast"), .missingArgument(name: "fast", hint: "on|off"))
        XCTAssertEqual(SlashCommandCatalog.resolve("/goal set"), .missingArgument(name: "goal set", hint: "<목표>"))
        if case .hostOnly(name: "login", _) = SlashCommandCatalog.resolve("/login") {} else { XCTFail("login") }
        XCTAssertEqual(SlashCommandCatalog.resolve("/skill:ralplan 계획 세워"), .sendAsPrompt)
        XCTAssertEqual(SlashCommandCatalog.resolve("/ralplan x", skills: ["ralplan"]), .sendAsPrompt)
        XCTAssertEqual(SlashCommandCatalog.resolve("/nope"), .unknown(name: "nope"))
        XCTAssertEqual(SlashCommandCatalog.resolve("/etc/hosts 파일을 봐줘"), .notCommand)
        XCTAssertEqual(SlashCommandCatalog.resolve("그냥 질문"), .notCommand)
        XCTAssertEqual(SlashCommandCatalog.resolve("/"), .notCommand)
    }

    func testPaletteOrdersRunnableThenSkillsThenHostOnly() {
        let all = SlashCommandCatalog.suggestions(for: "/", skills: ["ralplan"])
        XCTAssertEqual(all.first?.name, "context")
        let kinds = all.map { $0.isRunnable ? ($0.kind == .skill ? 1 : 0) : 2 }
        XCTAssertEqual(kinds, kinds.sorted())
        XCTAssertEqual(SlashCommandCatalog.suggestions(for: "/co", skills: []).map(\.name), ["context", "compact", "copy", "contribute-pr"])
        XCTAssertEqual(SlashCommandCatalog.suggestions(for: "/ral", skills: ["skill:ralplan"]).map(\.name), ["skill:ralplan"])
        XCTAssertTrue(SlashCommandCatalog.suggestions(for: "/model gpt", skills: []).isEmpty)
        XCTAssertTrue(SlashCommandCatalog.suggestions(for: "hi", skills: []).isEmpty)
        XCTAssertEqual(Set(SlashCommandCatalog.builtins.map(\.name)).count, SlashCommandCatalog.builtins.count)
    }

    func testConfigChoiceMatching() throws {
        let raw: JSONValue = [["id": "model", "name": "Model", "options": [
            ["value": "anthropic/claude-sonnet-5", "name": "Claude Sonnet 5"],
            ["value": "openai/gpt-5.6-luna", "name": "GPT 5.6 Luna"],
            ["value": "openai/gpt-5.6-sol", "name": "GPT 5.6 Sol"],
        ]]]
        let model = try raw.decode([ConfigOption].self)[0]
        XCTAssertEqual(model.choice(matching: "sonnet")?.value, "anthropic/claude-sonnet-5")
        XCTAssertEqual(model.choice(matching: "GPT 5.6 SOL")?.value, "openai/gpt-5.6-sol")
        XCTAssertNil(model.choice(matching: "gpt"), "ambiguous")
        XCTAssertNil(model.choice(matching: "  "))
        XCTAssertTrue(ConfigTarget.model.matches(model))
        XCTAssertFalse(ConfigTarget.thinking.matches(model))
    }
}

final class InsightTests: XCTestCase {
    func testMeasuredQueryShapesDecode() throws {
        let ctx = try XCTUnwrap(ContextUsage([
            "usage": ["tokens": 55356, "contextWindow": 1_000_000, "percent": 5.5356, "source": "heuristic"],
            "isStreaming": false, "steeringQueueDepth": 1, "followupQueueDepth": 0, "systemPromptChars": 41672,
        ]))
        XCTAssertEqual(ctx.tokens.compactTokens, "55.4K")
        XCTAssertEqual(ctx.contextWindow.compactTokens, "1M")
        XCTAssertEqual(ctx.fraction, 0.055356, accuracy: 1e-9)
        XCTAssertTrue(ctx.estimated)
        XCTAssertEqual(ctx.steeringQueueDepth, 1)
        XCTAssertNil(ContextUsage(["usage": ["tokens": 1, "contextWindow": 0]]))

        let usage = try XCTUnwrap(UsageTotals(["input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 1, "premiumRequests": 0, "cost": 0.25]))
        XCTAssertEqual(usage.totalTokens, 116)
        XCTAssertEqual(usage.cost, 0.25)

        let phases = TodoPhase.parse([
            ["name": "구현", "tasks": [["content": "a", "status": "completed"], ["content": "b", "status": "in_progress", "notes": ["n"]]]],
            ["name": "검증", "tasks": [["content": "c", "status": "pending"]]],
            "garbage",
        ])
        XCTAssertEqual(phases.count, 2)
        XCTAssertEqual(phases.taskCount, 3)
        XCTAssertEqual(phases.doneCount, 1)
        XCTAssertEqual(phases.current?.content, "b")
        XCTAssertEqual(phases.current?.notes, ["n"])

        let goal = try XCTUnwrap(GoalState(["enabled": false, "goal": nil, "reason": "no_active_goal", "message": "No goal is active"]))
        XCTAssertFalse(goal.enabled)
        XCTAssertNil(goal.objective)
        XCTAssertEqual(goal.message, "No goal is active")

        let jobs = try XCTUnwrap(JobsSnapshot(["running": [], "recent": [["id": "j1", "label": "build", "status": "done"]], "delivery": ["queued": 2]]))
        XCTAssertEqual(jobs.recent.first?.label, "build")
        XCTAssertEqual(jobs.queuedDeliveries, 2)
        XCTAssertEqual(999.compactTokens, "999")
        XCTAssertEqual(250_000.compactTokens, "250K")
    }

    func testTranscriptNoticesCopyAndPlainText() {
        var t = SessionTranscript()
        t.apply(SequencedUpdate(seq: 1, update: ["sessionUpdate": "user_message_chunk", "content": ["type": "text", "text": "질문"]]))
        t.apply(SequencedUpdate(seq: 2, update: ["sessionUpdate": "agent_thought_chunk", "content": ["type": "text", "text": "생각"]]))
        t.apply(SequencedUpdate(seq: 3, update: ["sessionUpdate": "agent_message_chunk", "content": ["type": "text", "text": "답"]]))
        t.apply(SequencedUpdate(seq: 4, update: ["sessionUpdate": "tool_call", "toolCallId": "t", "title": "ls", "status": "completed"]))
        t.appendNotice("컨텍스트를 압축했습니다.")
        XCTAssertEqual(t.lastAgentText, "답")
        XCTAssertEqual(t.plainText, "## 나\n질문\n\n## gjc\n답\n\n- 도구 ls (completed)\n\n— 컨텍스트를 압축했습니다.")
        XCTAssertEqual(t.lastSeq, 4, "notices do not consume bridge sequence numbers")
    }
}

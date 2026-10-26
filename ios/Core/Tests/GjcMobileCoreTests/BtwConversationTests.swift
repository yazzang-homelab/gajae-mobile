@testable import GjcMobileCore
import XCTest

final class BtwConversationTests: XCTestCase {
    func testFollowUpsCarryOnlyAnsweredExchanges() throws {
        var chat = BtwConversation()
        XCTAssertEqual(try chat.ask("  비밀단어가 뭐였지? ").get(), ["question": "비밀단어가 뭐였지?"])
        XCTAssertTrue(chat.isPending)
        XCTAssertEqual(chat.ask("또?"), .failure(.busy))

        chat.finish(result: ["replyText": " KIWI\n"])
        XCTAssertFalse(chat.isPending)
        XCTAssertEqual(chat.exchanges.first?.answer, "KIWI")

        XCTAssertEqual(try chat.ask("거꾸로 써").get(), [
            "question": "거꾸로 써",
            "exchanges": [["question": "비밀단어가 뭐였지?", "answer": "KIWI"]],
        ])
        chat.fail("시간 초과")
        XCTAssertEqual(chat.exchanges.last?.error, "시간 초과")

        // A failed question is shown but never sent back as context.
        XCTAssertEqual(try chat.ask("다시").get()["exchanges"], [["question": "비밀단어가 뭐였지?", "answer": "KIWI"]])
        chat.finish(result: ["replyText": "   "])
        XCTAssertEqual(chat.exchanges.last?.error, "빈 답변을 받았습니다.")
        XCTAssertEqual(chat.forkDraft, "방금 /btw 사이드 대화에서 이어서 진행합니다.\n\n질문: 비밀단어가 뭐였지?\n답변: KIWI\n\n")
    }

    func testRejectsEmptyAndOversizedQuestions() {
        var chat = BtwConversation()
        XCTAssertEqual(chat.ask(" \n"), .failure(.empty))
        XCTAssertEqual(chat.ask(String(repeating: "가", count: 5462)), .failure(.tooLong(maxBytes: 16384)), "3 bytes per syllable")
        XCTAssertTrue(chat.exchanges.isEmpty)
        XCTAssertNoThrow(try chat.ask(String(repeating: "가", count: 5461)).get())
    }

    func testComposerTriggerAndSlashMapping() {
        XCTAssertEqual(BtwConversation.trigger(in: "/btw "), "")
        XCTAssertEqual(BtwConversation.trigger(in: "/BTW 이거 뭐야"), "이거 뭐야")
        XCTAssertNil(BtwConversation.trigger(in: "/btw"))
        XCTAssertNil(BtwConversation.trigger(in: "/btwx "))
        XCTAssertNil(BtwConversation.trigger(in: "btw "))
        XCTAssertEqual(SlashCommandCatalog.resolve("/btw 지금 뭐 해?"), .run(.openBtw(question: "지금 뭐 해?")))
        XCTAssertEqual(SlashCommandCatalog.resolve("/btw"), .run(.openBtw(question: "")))
        XCTAssertEqual(SlashCommandCatalog.suggestions(for: "/bt", skills: []).map(\.name), ["btw"])
    }
}

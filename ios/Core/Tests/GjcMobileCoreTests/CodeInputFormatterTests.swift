import XCTest
@testable import GjcMobileCore

final class CodeInputFormatterTests: XCTestCase {
    func testUppercasesAndGroupsByFourWhileTyping() {
        XCTAssertEqual(CodeInputFormatter.format("").display, "")
        XCTAssertEqual(CodeInputFormatter.format("4pu").display, "4PU")
        XCTAssertEqual(CodeInputFormatter.format("4pux").display, "4PUX")
        XCTAssertEqual(CodeInputFormatter.format("4puxu").display, "4PUX-U")
        XCTAssertEqual(CodeInputFormatter.format("4puxu36f4w").display, "4PUX-U36F-4W")
    }

    func testDeletingTheTrailingCharacterNeverLeavesAHyphen() {
        XCTAssertEqual(CodeInputFormatter.format("4PUX-").display, "4PUX")
        XCTAssertEqual(CodeInputFormatter.format("4PUX-U36F-").display, "4PUX-U36F")
    }

    func testPastedCodesWithAnySeparatorsAreNormalized() {
        for pasted in ["4PUXU36F4W", "4pux-u36f-4w", " 4PUX U36F 4W ", "4PUX\nU36F-4W", "4pux--u36f--4w"] {
            let state = CodeInputFormatter.format(pasted)
            XCTAssertEqual(state.display, "4PUX-U36F-4W", pasted)
            XCTAssertEqual(state.code, "4PUXU36F4W", pasted)
            XCTAssertNil(state.invalidPosition, pasted)
        }
    }

    func testFormattingIsIdempotent() {
        let once = CodeInputFormatter.format("4puxu36f4w").display
        XCTAssertEqual(CodeInputFormatter.format(once).display, once)
    }

    func testLIsAValidCharacter() {
        let state = CodeInputFormatter.format("lll")
        XCTAssertEqual(state.display, "LLL")
        XCTAssertNil(state.invalidPosition)
    }

    func testTheFirstWrongCharacterIsReportedWithItsPosition() {
        let zero = CodeInputFormatter.format("4P0X")
        XCTAssertEqual(zero.invalidPosition, 3)
        XCTAssertEqual(zero.invalidCharacter, "0")
        XCTAssertEqual(zero.display, "4P0X")
        XCTAssertEqual(CodeInputFormatter.format("ipux").invalidPosition, 1)
        XCTAssertEqual(CodeInputFormatter.format("4pux-o").invalidPosition, 5)
        XCTAssertEqual(CodeInputFormatter.format("4PUXU16F4W").invalidPosition, 6)
        // Separators do not count toward the position.
        XCTAssertEqual(CodeInputFormatter.format("4P-0").invalidPosition, 3)
        // Only the first wrong character is reported.
        XCTAssertEqual(CodeInputFormatter.format("1O").invalidPosition, 1)
    }

    func testInputIsCappedAtTheLongestCode() {
        let state = CodeInputFormatter.format(String(repeating: "A", count: 40))
        XCTAssertEqual(state.code.count, DeviceCode.maxLength)
        XCTAssertEqual(state.display, "AAAA-AAAA-AAAA-AA")
    }

    func testAgreesWithNormalizeOnTheWrongCharacterPosition() {
        for input in ["4P0XU36F4W", "4PUXO36F4W", "4PUXU16F4W", "IPUXU36F4W"] {
            guard case let .failure(.format(position)) = DeviceCode.normalize(input) else { return XCTFail(input) }
            XCTAssertEqual(CodeInputFormatter.format(input).invalidPosition, position, input)
        }
    }

    /// The field and the decoder share one rule: the bridge's separators and ASCII-only uppercasing.
    func testAgreesWithNormalizeOnTheSharedFixtureInputs() throws {
        let codes = try XCTUnwrap(try Fixtures.json("cpace-vector.json")["codes"])
        let inputs = try XCTUnwrap(codes["normalize"]?.array).compactMap { $0["input"]?.string }
            + XCTUnwrap(codes["reject"]?.array).compactMap { $0["input"]?.string }
        for input in inputs {
            let state = CodeInputFormatter.format(input)
            switch DeviceCode.normalize(input) {
            case let .success(code):
                XCTAssertNil(state.invalidPosition, input)
                XCTAssertEqual(state.code, String(code.prefix(DeviceCode.maxLength)), input)
            case let .failure(.format(position)):
                XCTAssertEqual(state.invalidPosition, position, input)
            case .failure:
                XCTFail(input)
            }
        }
    }

    func testOnlyHyphenAndJavaScriptWhitespaceSeparate() {
        XCTAssertEqual(CodeInputFormatter.format("4P\u{00A0}UX\u{3000}U3\u{FEFF}6F\u{2028}4W").code, "4PUXU36F4W")
        XCTAssertEqual(CodeInputFormatter.format("4P\u{200B}UX").invalidPosition, 3)
        XCTAssertEqual(CodeInputFormatter.format("4P\u{0085}UX").invalidPosition, 3)
        XCTAssertEqual(CodeInputFormatter.format("4Pß").invalidPosition, 3)
        XCTAssertEqual(CodeInputFormatter.format("4Pſ").invalidPosition, 3)
        XCTAssertEqual(CodeInputFormatter.format("４").invalidPosition, 1)
    }
}

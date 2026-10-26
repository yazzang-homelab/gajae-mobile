import XCTest

/// Drives the real app against a local scripted demo host (bridge/demo) so .github/workflows/ios-footage.yml can
/// record the Simulator screen: demo pairing, a task, the approval request, the home-screen widget, the deep link
/// back into the session, approving, the answer. Needs a build with GJCM_DEMO_OFFER_URL pointing at that host.
/// The pauses pace the recording; they are not synchronization.
@MainActor
final class DemoFlowUITests: XCTestCase {
    private let app = XCUIApplication()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    func testDemoFlow() throws {
        continueAfterFailure = false
        app.launch()
        allowNotificationsIfAsked()
        pause(2)

        let demo = app.buttons.matching(NSPredicate(format: "label CONTAINS '데모로 체험'")).firstMatch
        XCTAssertTrue(demo.waitForExistence(timeout: 20), "demo button (is GJCM_DEMO_OFFER_URL set?)")
        demo.tap()
        allowNotificationsIfAsked()

        let composer = app.descendants(matching: .any)
            .matching(NSPredicate(format: "placeholderValue CONTAINS 'gjc에게 지시'")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "chat composer after pairing")
        pause(2)
        composer.tap()
        // The placeholder query stops matching once text is in the field, so type into whatever has focus.
        for (index, word) in "Run the test suite and fix any failures".split(separator: " ").enumerated() {
            app.typeText(index == 0 ? String(word) : " " + word)
            dismissKeyboardTip()
            pause(0.2)
        }
        pause(1)
        app.buttons["보내기"].tap()

        let allow = app.buttons["Allow once"]
        pause(3)
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "approval card")
        pause(4)

        XCUIDevice.shared.press(.home)
        pause(2)
        let widgetOpened = addWidgetAndTapIt()
        if !widgetOpened { app.activate() }
        XCTAssertTrue(allow.waitForExistence(timeout: 20), "back on the approval card")
        pause(3)
        allow.tap()
        pause(14)

        XCUIDevice.shared.press(.home)
        pause(5)
    }

    /// The first keyboard use shows a one-time slide-to-type tip that covers the keyboard.
    private func dismissKeyboardTip() {
        let tip = app.buttons["Continue"]
        if tip.exists { tip.tap() }
    }

    private func allowNotificationsIfAsked() {
        for label in ["Allow", "허용"] {
            let button = springboard.alerts.buttons[label]
            if button.waitForExistence(timeout: 3) {
                button.tap()
                return
            }
        }
    }

    /// Adds the 가재코드 widget from the Home Screen gallery and taps its waiting row. Springboard's layout differs
    /// between iOS versions, so every step is optional; the tree is logged when a step is missing.
    private func addWidgetAndTapIt() -> Bool {
        let existing = widget()
        if !existing.exists {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)).press(forDuration: 1.6)
            pause(1)
            if let edit = first(springboard.buttons, labels: ["Edit", "편집"]) {
                edit.tap()
                pause(1)
            }
            guard let add = first(springboard.buttons, labels: ["Add Widget", "위젯 추가"]) else {
                print("SPRINGBOARD (no Add Widget):\n\(springboard.debugDescription)")
                XCUIDevice.shared.press(.home)
                return false
            }
            add.tap()
            pause(1.5)
            let search = springboard.searchFields.firstMatch
            if search.waitForExistence(timeout: 5) {
                search.tap()
                search.typeText("가재코드")
                pause(1)
            }
            let entry = springboard.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS '가재코드'")).element(boundBy: 0)
            guard entry.waitForExistence(timeout: 5) else {
                print("SPRINGBOARD (no gallery entry):\n\(springboard.debugDescription)")
                XCUIDevice.shared.press(.home)
                return false
            }
            entry.tap()
            pause(2)
            guard let confirm = first(springboard.buttons, labels: ["Add Widget", "위젯 추가"]) else {
                print("SPRINGBOARD (no confirm):\n\(springboard.debugDescription)")
                XCUIDevice.shared.press(.home)
                return false
            }
            confirm.tap()
            pause(1.5)
            if let done = first(springboard.buttons, labels: ["Done", "완료"]) { done.tap() }
            pause(4)
        }
        let added = widget()
        guard added.waitForExistence(timeout: 10) else {
            print("SPRINGBOARD (widget missing):\n\(springboard.debugDescription)")
            return false
        }
        pause(4)
        added.tap()
        return true
    }

    private func widget() -> XCUIElement {
        springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS '응답 대기' OR label CONTAINS '가재코드 상태'")).firstMatch
    }

    /// Springboard pads some labels with a leading space (" Add Widget"), so match by suffix.
    private func first(_ query: XCUIElementQuery, labels: [String]) -> XCUIElement? {
        for label in labels {
            let element = query.matching(NSPredicate(format: "label ENDSWITH %@", label)).firstMatch
            if element.waitForExistence(timeout: 2) { return element }
        }
        return nil
    }

    /// Waits while filming: with GJCM_SHOTS set (TEST_RUNNER_GJCM_SHOTS in xcodebuild's environment) every pause
    /// writes screenshots named by capture time into that directory, about four per second.
    private func pause(_ seconds: Double) {
        let end = Date().addingTimeInterval(seconds)
        guard let dir = ProcessInfo.processInfo.environment["GJCM_SHOTS"] else {
            Thread.sleep(forTimeInterval: seconds)
            return
        }
        while Date() < end {
            let started = Date()
            let name = String(format: "%.3f.png", started.timeIntervalSince1970)
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
            let left = 0.25 - Date().timeIntervalSince(started)
            if left > 0 { Thread.sleep(forTimeInterval: min(left, end.timeIntervalSinceNow)) }
        }
    }
}

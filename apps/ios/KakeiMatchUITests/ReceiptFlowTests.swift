import XCTest

final class ReceiptFlowTests: XCTestCase {
    @MainActor
    private func launch(_ scenario: String, appearance: String = "light", source: String = "photo") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "receipt", "-ReceiptScenario", scenario, "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        XCTAssertTrue(app.buttons["add-record"].waitForExistence(timeout: 10))
        app.buttons["add-record"].tap()
        app.buttons["chooser.\(source)"].tap()
        XCTAssertTrue(app.buttons["receipt.itemsTab"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    func testWarningCorrectionSaveAndRecords() {
        continueAfterFailure = false
        let app = launch("warnings")
        let warning = app.staticTexts["receipt-review-title"]
        XCTAssertTrue(warning.waitForExistence(timeout: 5))
        app.buttons["receipt.warning.0"].tap()
        let amount = app.textFields["receipt-amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: 5))
        amount.tap()
        amount.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4) + "2138")
        XCTAssertFalse(warning.exists)
        app.buttons["receipt.itemsTab"].tap() // dismiss keyboard and inspect read-only items
        XCTAssertTrue(app.staticTexts["receipt.itemsHandoff"].exists)
        app.buttons["receipt.overviewTab"].tap()
        app.swipeUp()
        app.buttons["receipt-account"].tap()
        app.buttons["PayPayカード"].tap()
        app.buttons["receipt.saveButton"].tap()
        let saved = app.staticTexts["receipt-save-state"]
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        XCTAssertEqual(saved.label, "登録しました。")
        app.buttons["receipt.recordsButton"].tap()
        XCTAssertTrue(app.buttons["records.search"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "スーパーみどり")).count > 0)
        app.terminate()
    }

    @MainActor func testScreensLight() { screenshots("light") }
    @MainActor func testScreensDark() { screenshots("dark") }

    @MainActor
    private func screenshots(_ appearance: String) {
        continueAfterFailure = false
        for scenario in ["initial", "loading", "result", "warnings", "failure"] {
            let app = launch(scenario, appearance: appearance, source: scenario == "initial" ? "receipt" : "photo")
            if scenario == "loading" {
                XCTAssertTrue(app.buttons["receipt.stopWaiting"].exists)
            }
            if scenario == "failure" {
                XCTAssertTrue(app.buttons["receipt.manualButton"].exists)
                XCTAssertFalse(app.buttons["receipt.retryButton"].exists)
                let scroll = app.scrollViews.firstMatch
                scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)).press(forDuration: 0.01,
                    thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)))
                XCTAssertTrue(app.staticTexts["! 写真から読み取れませんでした"].isHittable)
            }
            capture(app, "receipt-\(scenario)-\(appearance)")
            if scenario == "result" {
                app.buttons["receipt.itemsTab"].tap()
                XCTAssertTrue(app.staticTexts["台所用洗剤"].exists)
                capture(app, "receipt-items-tab-\(appearance)")
                app.buttons["receipt.overviewTab"].tap()
            }
            if scenario == "result" || scenario == "loading" {
                app.buttons["receipt.imagePreview"].tap()
                XCTAssertTrue(app.buttons["receipt.closeImage"].waitForExistence(timeout: 5))
                app.buttons["receipt.closeImage"].tap()
            }
            if scenario == "loading" {
                app.buttons["receipt.stopWaiting"].tap()
                XCTAssertTrue(app.buttons["receipt.saveButton"].exists)
            }
            if scenario == "failure" {
                app.buttons["receipt.manualButton"].tap()
                XCTAssertTrue(app.buttons["receipt.saveButton"].exists)
            }
            app.terminate()
        }
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}


extension ReceiptFlowTests {
    @MainActor func testPendingReceiptUsesEditorAndReturnsToRecords() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "receipt", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launch()
        app.buttons["receipt-tab"].tap()
        let pending = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "records.pending.")).firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 10))
        pending.tap()
        XCTAssertTrue(app.buttons["receipt.itemsTab"].waitForExistence(timeout: 5))
        app.buttons["receipt.itemsTab"].tap()
        XCTAssertTrue(app.staticTexts["receipt.itemsHandoff"].exists)
        app.buttons["records.pendingBackButton"].tap()
        XCTAssertTrue(app.buttons["records.search"].waitForExistence(timeout: 5))
        app.terminate()
    }
}

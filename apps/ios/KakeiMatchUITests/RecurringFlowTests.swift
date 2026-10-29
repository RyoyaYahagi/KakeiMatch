import XCTest

final class RecurringFlowTests: XCTestCase {
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor private func launchList(_ appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        app.buttons["settings-tab"].tap()
        app.buttons["settings.recurring"].tap()
        XCTAssertTrue(app.staticTexts["recurring.title"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor func testRecurringInitialLightScreenshot() {
        continueAfterFailure = false
        let app = launchList("light")
        capture(app, "recurring-initial-light")
        app.terminate()
    }

    @MainActor func testRecurringInitialDarkScreenshot() {
        continueAfterFailure = false
        let app = launchList("dark")
        capture(app, "recurring-initial-dark")
        app.terminate()
    }

    @MainActor func testCreateRecurringScheduleFromSettings() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        app.launch()
        app.buttons["settings-tab"].tap()
        let entrance = app.buttons["settings.recurring"]
        XCTAssertTrue(entrance.waitForExistence(timeout: 10))
        entrance.tap()
        XCTAssertTrue(app.staticTexts["recurring.title"].waitForExistence(timeout: 5))
        app.buttons["recurring.add"].tap()
        XCTAssertTrue(app.staticTexts["recurring.editor.title"].waitForExistence(timeout: 5))
        let name = app.textFields["recurring.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap(); name.typeText("合成の定期予定")
        let amount = app.textFields["recurring.amount"]
        amount.tap(); amount.typeText("12000")
        app.descendants(matching: .any)["recurring.category"].tap()
        app.buttons["食費"].tap()
        app.descendants(matching: .any)["recurring.account"].tap()
        app.buttons["PayPayカード"].tap()
        app.buttons["recurring.save"].tap()
        XCTAssertTrue(app.staticTexts["recurring.status"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["定期登録を保存しました。"].exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "合成の定期予定")).firstMatch.waitForExistence(timeout: 5))
        app.terminate()
    }
}

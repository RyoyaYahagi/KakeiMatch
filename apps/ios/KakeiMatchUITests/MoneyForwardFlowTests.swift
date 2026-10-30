import XCTest

final class MoneyForwardFlowTests: XCTestCase {
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor func testMoneyForwardImportScreenshotsLightAndDark() {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            app.launchArguments = [
                "-UITestFixture", "migration", "-MoneyForwardScenario", "sample",
                "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP",
            ]
            app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
            app.launch()
            app.buttons["settings-tab"].tap()
            let backup = app.buttons["settings.backup"]
            XCTAssertTrue(backup.waitForExistence(timeout: 10))
            backup.tap()
            let entry = app.buttons["settings.moneyforward"]
            XCTAssertTrue(entry.waitForExistence(timeout: 10))
            entry.tap()
            XCTAssertTrue(app.staticTexts["moneyforward.title"].waitForExistence(timeout: 10))
            XCTAssertTrue(app.buttons["moneyforward.preview"].waitForExistence(timeout: 10))
            capture(app, "moneyforward-mapping-\(appearance)")
            app.buttons["moneyforward.preview"].tap()
            XCTAssertTrue(app.staticTexts["取り込み前の確認"].waitForExistence(timeout: 10))
            app.scrollViews.firstMatch.swipeDown()
            capture(app, "moneyforward-preview-\(appearance)")
            app.buttons["moneyforward.back"].tap()
            XCTAssertTrue(app.buttons["settings.moneyforward"].waitForExistence(timeout: 10))
            app.terminate()
        }
    }
}

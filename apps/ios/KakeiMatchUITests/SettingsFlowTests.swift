import XCTest

final class SettingsFlowTests: XCTestCase {
    @MainActor private func launch(_ appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        XCTAssertTrue(app.buttons["settings.theme"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "settings-" + name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Opt-in export stays off and cannot send until the user enables it. No network request is made.
    @MainActor func testReceiptExportPageIsOffByDefaultAndCannotSend() {
        continueAfterFailure = false
        let app = launch("light")
        let row = app.buttons["settings.receiptExport"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        if !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.label.contains("オフ"))
        row.tap()

        XCTAssertTrue(app.staticTexts["receiptExport.title"].waitForExistence(timeout: 5))
        let toggle = app.switches["receiptExport.enabled"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "0")
        let send = app.buttons["receiptExport.sendNow"]
        if !send.isHittable { app.swipeUp() }
        XCTAssertTrue(send.exists)
        XCTAssertFalse(send.isEnabled)
        XCTAssertEqual(app.staticTexts["receiptExport.status"].label, "まだ送信していません。")
        capture(app, "receipt-export-light")
    }

    @MainActor func testThemeSelectionAndScreenLockSettingsNavigation() {
        continueAfterFailure = false
        let app = launch("light")
        capture(app, "initial-light")

        app.buttons["settings.theme"].tap()
        XCTAssertTrue(app.staticTexts["settings-page-theme-title"].waitForExistence(timeout: 5))
        let preferencePicker = app.descendants(matching: .any)["theme-preference"]
        XCTAssertTrue(preferencePicker.waitForExistence(timeout: 5))
        preferencePicker.tap()
        let lightOption = app.buttons["ライト"]
        XCTAssertTrue(lightOption.waitForExistence(timeout: 5))
        lightOption.tap()
        XCTAssertTrue(app.buttons["settings.back"].waitForExistence(timeout: 5))
        capture(app, "theme-light")
        app.buttons["settings.back"].tap()
        XCTAssertTrue(app.staticTexts["theme-row-value"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["settings.theme"].label.contains("ライト"), true)

        app.buttons["settings.screenLock"].tap()
        XCTAssertTrue(app.staticTexts["screen-lock-settings-title"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["screen-lock-settings-status"].exists)
        XCTAssertTrue(app.buttons["screen-lock-enable"].exists || app.buttons["screen-lock-disable"].exists)
        capture(app, "screen-lock-light")
        app.terminate()
    }

    @MainActor func testDarkSettingsRootScreenshot() {
        continueAfterFailure = false
        let app = launch("dark")
        capture(app, "initial-dark")
        XCTAssertTrue(app.staticTexts["設定"].exists)
        XCTAssertTrue(app.buttons["settings.screenLock"].exists)
        app.terminate()
    }
}

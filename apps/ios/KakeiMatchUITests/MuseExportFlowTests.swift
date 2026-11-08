import XCTest

final class MuseExportFlowTests: XCTestCase {
    @MainActor private func launch(_ appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        let entry = app.buttons["settings.museExport"]
        for _ in 0..<4 where !entry.isHittable { app.swipeUp() }
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        entry.tap()
        XCTAssertTrue(app.otherElements["museExport.screen"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor func testSettingsOpensScreenWithDefaultRangeAndSharesGeneratedFile() {
        continueAfterFailure = false
        // The migration fixture reference date is 2026-10-14, so "today" is October 2026.
        let app = launch("light")

        XCTAssertTrue(app.staticTexts["museExport.title"].exists)
        XCTAssertTrue(app.staticTexts["museExport.description"].label.contains("店名とメモ"))
        XCTAssertTrue(app.staticTexts["museExport.sensitiveNotice"].label.contains("暗号化されません"))
        let summary = app.staticTexts["museExport.rangeSummary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 5))
        XCTAssertTrue(summary.label.contains("2026年8月"), summary.label)
        XCTAssertTrue(summary.label.contains("2026年10月"), summary.label)
        XCTAssertTrue(app.descendants(matching: .any)["museExport.fromMonth"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["museExport.toMonth"].exists)
        XCTAssertTrue(app.buttons["museExport.exportButton"].isEnabled)
        XCTAssertFalse(app.descendants(matching: .any)["museExport.shareLink"].exists)

        app.buttons["museExport.exportButton"].tap()
        let exportedStatus = app.staticTexts.matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "museExport.status", "書き出しました")).firstMatch
        XCTAssertTrue(exportedStatus.waitForExistence(timeout: 10), "書き出しの完了が表示されません")
        XCTAssertTrue(exportedStatus.label.contains("書き出しました"), exportedStatus.label)
        XCTAssertTrue(app.descendants(matching: .any)["museExport.shareLink"].waitForExistence(timeout: 5))
        capture(app, name: "muse-export-light")

        app.buttons["settings.back"].tap()
        XCTAssertTrue(app.buttons["settings.backup"].waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor func testMuseExportInitialScreenshotsInLightAndDark() {
        for appearance in ["light", "dark"] {
            let app = launch(appearance)
            capture(app, name: "muse-export-initial-\(appearance)")
            app.terminate()
        }
    }
}

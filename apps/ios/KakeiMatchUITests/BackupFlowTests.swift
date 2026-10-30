import XCTest

final class BackupFlowTests: XCTestCase {
    @MainActor private func launchBackup(_ appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        XCTAssertTrue(app.buttons["settings.backup"].waitForExistence(timeout: 5))
        app.buttons["settings.backup"].tap()
        XCTAssertTrue(app.staticTexts["backup.title"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor func testBackupInitialScreenshotsInLightAndDark() {
        for appearance in ["light", "dark"] {
            let app = launchBackup(appearance)
            let title = app.staticTexts["backup.title"]
            if !title.isHittable { app.swipeDown() }
            XCTAssertTrue(title.isHittable)
            capture(app, name: "backup-initial-\(appearance)")
            app.terminate()
        }
    }

    @MainActor func testBackupPageShowsPWACopyDisclosureAndActionStatus() {
        continueAfterFailure = false
        let app = launchBackup("light")

        XCTAssertTrue(app.staticTexts["backup.lastExport"].label.contains("まだバックアップを書き出していません。"))
        XCTAssertTrue(app.buttons["backup.export"].exists)
        XCTAssertTrue(app.buttons["backup.import"].exists)
        XCTAssertTrue(app.staticTexts["backup.storage-title"].exists)
        XCTAssertTrue(app.staticTexts["backup.storage-device"].exists)

        app.buttons["backup.about"].tap()
        XCTAssertTrue(app.staticTexts["backup.about.iosOnly"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["backup.about.iosOnly"].label.contains(".kmb"))
        XCTAssertTrue(app.staticTexts["backup.about.restoreFormats"].label.contains("現在の家計データも変更しません。"))

        // The fixture launch has no persistent store; the action must report that instead of
        // pretending a file was written. Real export/restore rollback is covered by Swift Testing.
        app.buttons["backup.export"].tap()
        let status = app.staticTexts["backup.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertTrue(status.label.contains("端末の保存領域を開けませんでした"), status.label)
        XCTAssertFalse(app.buttons["backup.share"].exists)

        app.buttons["settings.back"].tap()
        XCTAssertTrue(app.buttons["settings.backup"].waitForExistence(timeout: 5))
        app.terminate()
    }
}

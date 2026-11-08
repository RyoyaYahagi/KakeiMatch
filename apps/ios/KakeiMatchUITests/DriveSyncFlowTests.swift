import XCTest

final class DriveSyncFlowTests: XCTestCase {
    @MainActor private func launch(_ appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP",
            // The argument domain overrides any value left by an earlier test run
            // on the same simulator, so the default-OFF row is deterministic.
            "-kakeimatch.driveSync.enabled", "0",
        ]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        // Never touch Google's SDK or the network in UI tests.
        app.launchEnvironment["KM_UI_TEST_DRIVE_STATE"] = "signedOut"
        app.launch()
        XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        return app
    }

    @MainActor private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor func testSettingsRowShowsOffAndPageOpensWithToggleOff() {
        continueAfterFailure = false
        let app = launch("light")

        let row = app.buttons["settings.driveSync"]
        for _ in 0..<5 where !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("オフ"), row.label)
        row.tap()

        XCTAssertTrue(app.otherElements["driveSync.screen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["driveSync.title"].exists)
        XCTAssertTrue(app.staticTexts["driveSync.description"].label.contains("店名とメモ"))
        XCTAssertTrue(app.staticTexts["driveSync.sensitiveNotice"].label.contains("暗号化されません"))
        XCTAssertTrue(app.staticTexts["driveSync.readOnlyNotice"].label.contains("読み込むことはありません"))

        let toggle = app.switches["driveSync.toggle"]
        for _ in 0..<4 where !toggle.isHittable { app.swipeUp() }
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        let toggleValue = toggle.value as? String
        XCTAssertTrue(toggleValue == "0" || toggleValue == "オフ", "toggle value was \(String(describing: toggleValue))")

        let sendNow = app.buttons["driveSync.sendNow"]
        for _ in 0..<3 where !sendNow.isHittable { app.swipeUp() }
        XCTAssertTrue(sendNow.exists)
        XCTAssertFalse(sendNow.isEnabled, "未サインインでは今すぐ保存を押せない")
        XCTAssertTrue(app.buttons["driveSync.signIn"].exists)
        XCTAssertFalse(app.buttons["driveSync.signOut"].exists)
        capture(app, name: "drive-sync-light")

        app.buttons["settings.back"].tap()
        XCTAssertTrue(app.buttons["settings.driveSync"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["settings.driveSync"].label.contains("オフ"))
        app.terminate()
    }

    @MainActor func testDriveSyncInitialScreenshotsInLightAndDark() {
        for appearance in ["light", "dark"] {
            let app = launch(appearance)
            let row = app.buttons["settings.driveSync"]
            for _ in 0..<5 where !row.isHittable { app.swipeUp() }
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            row.tap()
            XCTAssertTrue(app.otherElements["driveSync.screen"].waitForExistence(timeout: 5))
            capture(app, name: "drive-sync-initial-\(appearance)")
            app.terminate()
        }
    }
}

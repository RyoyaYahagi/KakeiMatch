import CoreFoundation
import XCTest

final class AppShellSettingsTests: XCTestCase {
    @MainActor func testThemeSelectionChangesTheWholeApplicationImmediately() {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launch()
        XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        XCTAssertTrue(app.buttons["settings.theme"].waitForExistence(timeout: 5))
        app.buttons["settings.theme"].tap()
        XCTAssertTrue(app.staticTexts["settings-page-theme-title"].waitForExistence(timeout: 5))

        let picker = app.descendants(matching: .any)["theme-preference"]
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.tap()
        let darkOption = app.buttons["ダーク"]
        XCTAssertTrue(darkOption.waitForExistence(timeout: 5))
        darkOption.tap()
        XCTAssertTrue(app.staticTexts["settings-page-theme-title"].exists)

        let screenshot = app.screenshot()
        attach(screenshot, named: "settings-shell-theme-dark")
        XCTAssertEqual(backgroundIsDark(screenshot), true, "Selecting ダーク should change the entire app background immediately.")
        app.terminate()
    }

    /// Devices upgraded from a build with the app lock can still have the lock preference in
    /// UserDefaults. It must be ignored, so the household opens without a lock screen.
    @MainActor func testLegacyScreenLockPreferenceNoLongerLocksAnUpgradedApp() {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP",
                               "-kakeimatch.screen-lock.enabled", "YES"]
        // The removed DEBUG override was the other old way to force the lock screen.
        app.launchEnvironment["KM_UI_TEST_SCREEN_LOCK_ENABLED"] = "1"
        app.launch()

        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["shell.screen-lock-title"].exists)
        XCTAssertTrue(app.buttons["settings-tab"].isHittable,
                      "An upgraded device must open the household without a lock screen.")
        app.terminate()
    }

    @MainActor private func attach(_ screenshot: XCUIScreenshot, named name: String) {
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor private func backgroundIsDark(_ screenshot: XCUIScreenshot) -> Bool? {
        guard let image = screenshot.image.cgImage,
              image.bitsPerPixel == 32,
              let data = image.dataProvider?.data,
              let bytes = CFDataGetBytePtr(data) else { return nil }
        let x = 4
        let y = image.height / 2
        let offset = y * image.bytesPerRow + x * 4
        let brightestColorChannel = max(Int(bytes[offset]), max(Int(bytes[offset + 1]), Int(bytes[offset + 2])))
        return brightestColorChannel < 100
    }
}

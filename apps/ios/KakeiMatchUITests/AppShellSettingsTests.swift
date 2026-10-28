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

    @MainActor func testEnabledScreenLockHidesAppAndLocksOnLaunch() {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_SCREEN_LOCK_ENABLED"] = "1"
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "dark"
        app.launch()

        XCTAssertTrue(app.staticTexts["shell.screen-lock-title"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["screen-lock-unlock"].exists)
        XCTAssertFalse(app.buttons["settings-tab"].isHittable, "The locked household UI must be inaccessible.")
        attach(app.screenshot(), named: "settings-shell-screen-lock-launch")
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

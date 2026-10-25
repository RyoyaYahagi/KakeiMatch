import XCTest

final class NavigationSmokeTests: XCTestCase {
    @MainActor
    func testBottomNavigationAndReferenceScreenshots() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        app.launch()

        func screenshot(_ name: String) {
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        func assertScreen(_ identifier: String) {
            XCTAssertTrue(app.otherElements[identifier].waitForExistence(timeout: 10), identifier)
        }

        assertScreen("home.screen")
        screenshot("home-light")
        for (button, screen) in [("receipt-tab", "records.screen"),
                                 ("reconciliation-tab", "reconciliation.screen"),
                                 ("settings-tab", "settings.screen"),
                                 ("home-tab", "home.screen")] {
            app.buttons[button].tap()
            assertScreen(screen)
            XCTAssertTrue(app.buttons[button].isSelected)
            screenshot(screen + "-light")
        }
        app.buttons["add-record"].tap()
        XCTAssertTrue(app.buttons["chooser.receipt"].waitForExistence(timeout: 5))
        screenshot("chooser-light")
        // Transparent native presentations retain the underlying view in XCUI's
        // hierarchy. Its presence is not the same as being interactable.
        XCTAssertFalse(app.buttons["home-tab"].isHittable, "Modal sheet must block background navigation")
        app.buttons["record-sheet.close"].tap()
        assertScreen("home.screen")
        app.buttons["add-record"].tap()
        app.buttons["chooser.expense"].tap()
        assertScreen("manualEntry.screen")
        app.buttons["entry.cancel"].tap()
        XCTAssertTrue(app.buttons["chooser.receipt"].waitForExistence(timeout: 5))
        app.buttons["record-sheet.close"].tap()
        assertScreen("home.screen")

        app.terminate()
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "dark"
        app.launch()
        assertScreen("home.screen")
        screenshot("home-dark")
        for (button, screen) in [("receipt-tab", "records.screen"),
                                 ("reconciliation-tab", "reconciliation.screen"),
                                 ("settings-tab", "settings.screen")] {
            app.buttons[button].tap()
            assertScreen(screen)
            screenshot(screen + "-dark")
        }
        app.buttons["add-record"].tap()
        XCTAssertTrue(app.buttons["chooser.receipt"].waitForExistence(timeout: 5))
        screenshot("chooser-dark")
    }
}

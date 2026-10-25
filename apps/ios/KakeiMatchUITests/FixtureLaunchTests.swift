import XCTest

final class FixtureLaunchTests: XCTestCase {
    @MainActor func testNamedFixturesBootWithoutChangingPlaceholderScreens() {
        let app = XCUIApplication()
        for name in ["migration", "reconciliation"] {
            app.launchArguments = ["-UITestFixture", name, "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
            app.launch()
            XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
            XCTAssertFalse(app.staticTexts["data.fixtureError"].exists)
            app.buttons["reconciliation-tab"].tap()
            XCTAssertTrue(app.otherElements["reconciliation.screen"].waitForExistence(timeout: 5))
            app.terminate()
        }
    }

    @MainActor func testInvalidFixtureShowsErrorInsteadOfEmptyHousehold() {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "unknown-fixture"]
        app.launch()
        XCTAssertTrue(app.staticTexts["data.fixtureError"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.otherElements["home.screen"].exists)
    }
}

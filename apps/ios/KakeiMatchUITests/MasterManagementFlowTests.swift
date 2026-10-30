import XCTest

final class MasterManagementFlowTests: XCTestCase {
    @MainActor
    func testCreateCategoryFromSettings() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        app.launch()

        let settings = app.buttons["settings-tab"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let categories = app.buttons["settings.categories"]
        XCTAssertTrue(categories.waitForExistence(timeout: 5))
        categories.tap()

        XCTAssertTrue(app.staticTexts["masters.title"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["masters.title"].label, "カテゴリ")
        let add = app.buttons["masters.category.add"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()

        let name = app.textFields["masters.category.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText("テスト用カテゴリ")
        app.buttons["masters.category.save"].tap()

        XCTAssertTrue(app.staticTexts["テスト用カテゴリ"].waitForExistence(timeout: 5))
    }
}

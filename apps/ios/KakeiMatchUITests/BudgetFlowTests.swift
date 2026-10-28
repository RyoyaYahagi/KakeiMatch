import XCTest

final class BudgetFlowTests: XCTestCase {
    @MainActor private func launchBudget(_ appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        app.buttons["settings-tab"].tap()
        app.buttons["settings.budget"].tap()
        XCTAssertTrue(app.staticTexts["budget-edit-month"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["budget-overall-amount"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor func testBudgetInitialLightScreenshot() {
        continueAfterFailure = false
        let app = launchBudget("light")
        capture(app, name: "budget-initial-light")
        app.terminate()
    }

    @MainActor func testBudgetInitialDarkScreenshot() {
        continueAfterFailure = false
        let app = launchBudget("dark")
        capture(app, name: "budget-initial-dark")
        app.terminate()
    }

    @MainActor func testHomeOpensBudgetSavesAndReflectsUpdatedTotal() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "empty", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        app.launch()

        let homeBudget = app.buttons["home.budget.setup"]
        XCTAssertTrue(homeBudget.waitForExistence(timeout: 10))
        homeBudget.tap()
        let totalField = app.textFields["budget-overall-amount"]
        XCTAssertTrue(totalField.waitForExistence(timeout: 5))
        totalField.tap()
        totalField.typeText("90000")
        app.buttons["budget.save.monthly"].tap()
        XCTAssertTrue(app.staticTexts["予算を保存しました。"].waitForExistence(timeout: 5))
        app.buttons["settings.back"].tap()
        app.buttons["home-tab"].tap()
        let updatedBudget = app.buttons.matching(NSPredicate(format: "label CONTAINS '90,000'")).firstMatch
        XCTAssertTrue(updatedBudget.waitForExistence(timeout: 8))
        app.terminate()
    }
}

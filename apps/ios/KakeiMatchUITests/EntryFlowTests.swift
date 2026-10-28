import XCTest

final class EntryFlowTests: XCTestCase {
    @MainActor
    func testManualExpenseScreensAndSaveInLightAndDark() {
        continueAfterFailure = false
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
            app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
            app.launch()
            XCTAssertTrue(app.buttons["add-record"].waitForExistence(timeout: 10))
            app.buttons["add-record"].tap()
            app.buttons["chooser.expense"].tap()
            XCTAssertTrue(app.buttons["entry.saveButton"].waitForExistence(timeout: 10))
            capture(app, "entry-expense-\(appearance)")

            let recurrence = app.buttons["manual-transaction-recurrence"]
            recurrence.tap()
            let monthly = app.buttons["entry.recurrence.monthly"]
            XCTAssertTrue(monthly.waitForExistence(timeout: 5))
            monthly.tap()
            capture(app, "entry-recurrence-\(appearance)")
            recurrence.tap()
            app.buttons["entry.recurrence.none"].tap()

            app.buttons["entry.categorySheet"].tap()
            let food = app.buttons["entry.category.fixture-category-0"]
            XCTAssertTrue(food.waitForExistence(timeout: 5))
            capture(app, "entry-category-\(appearance)")
            food.tap()

            app.buttons["manual-transaction-account"].tap()
            let card = app.buttons["entry.account.fixture-account-0"]
            XCTAssertTrue(card.waitForExistence(timeout: 5))
            card.tap()

            if appearance == "light" {
                let amount = app.textFields["manual-transaction-amount"]
                XCTAssertTrue(amount.waitForExistence(timeout: 5))
                amount.tap()
                amount.typeText("1250")
                let payee = app.textFields["manual-transaction-payee"]
                payee.tap()
                payee.typeText("UITestStore")
                app.buttons["entry.date.yesterday"].tap()
                app.swipeUp()
                app.buttons["entry.saveButton"].tap()
                XCTAssertTrue(app.staticTexts["entry.status"].waitForExistence(timeout: 10))
                XCTAssertEqual(app.staticTexts["entry.status"].label, "登録しました。")
            }

            app.buttons["entry.cancel"].tap()
            let income = app.buttons["chooser.income"]
            XCTAssertTrue(income.waitForExistence(timeout: 5))
            income.tap()
            XCTAssertTrue(app.buttons["entry.saveButton"].waitForExistence(timeout: 10))
            capture(app, "entry-income-\(appearance)")

            app.buttons["entry.cancel"].tap()
            let transfer = app.buttons["chooser.transfer"]
            XCTAssertTrue(transfer.waitForExistence(timeout: 5))
            transfer.tap()
            XCTAssertTrue(app.buttons["entry.saveButton"].waitForExistence(timeout: 10))
            capture(app, "entry-transfer-\(appearance)")
            app.terminate()
        }
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

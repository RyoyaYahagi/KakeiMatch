import XCTest

final class ReceiptFlowTests: XCTestCase {
    @MainActor
    private func launch(_ scenario: String, appearance: String = "light", source: String = "photo") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "receipt", "-ReceiptScenario", scenario, "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        XCTAssertTrue(app.buttons["add-record"].waitForExistence(timeout: 10))
        app.buttons["add-record"].tap()
        app.buttons["chooser.\(source)"].tap()
        XCTAssertTrue(app.buttons["receipt.itemsTab"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    func testWarningCorrectionSaveAndRecords() {
        continueAfterFailure = false
        let app = launch("warnings")
        let warning = app.staticTexts["receipt-review-title"]
        XCTAssertTrue(warning.waitForExistence(timeout: 5))
        app.buttons["receipt.warning.0"].tap()
        let amount = app.textFields["receipt-amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: 5))
        amount.tap()
        amount.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4) + "2138")
        XCTAssertFalse(warning.exists)
        app.buttons["receipt.itemsTab"].tap() // dismiss keyboard and inspect the editable item list
        XCTAssertTrue(app.buttons["receipt.applyCategoryToAll"].exists)
        app.buttons["receipt.overviewTab"].tap()
        app.swipeUp()
        app.buttons["receipt-account"].tap()
        app.buttons["PayPayカード"].tap()
        app.buttons["receipt.saveButton"].tap()
        let saved = app.staticTexts["receipt-save-state"]
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        XCTAssertEqual(saved.label, "登録しました。")
        app.buttons["receipt.recordsButton"].tap()
        XCTAssertTrue(app.buttons["records.search"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "スーパーみどり")).count > 0)
        app.terminate()
    }

    @MainActor func testScreensLight() { screenshots("light") }
    @MainActor func testScreensDark() { screenshots("dark") }

    @MainActor
    private func screenshots(_ appearance: String) {
        continueAfterFailure = false
        for scenario in ["initial", "loading", "result", "warnings", "failure"] {
            let app = launch(scenario, appearance: appearance, source: scenario == "initial" ? "receipt" : "photo")
            if scenario == "loading" {
                XCTAssertTrue(app.buttons["receipt.stopWaiting"].exists)
            }
            if scenario == "failure" {
                XCTAssertTrue(app.buttons["receipt.manualButton"].exists)
                XCTAssertFalse(app.buttons["receipt.retryButton"].exists)
                let scroll = app.scrollViews.firstMatch
                scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)).press(forDuration: 0.01,
                    thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)))
                XCTAssertTrue(app.staticTexts["! 写真から読み取れませんでした"].isHittable)
            }
            capture(app, "receipt-\(scenario)-\(appearance)")
            if scenario == "result" {
                app.buttons["receipt.itemsTab"].tap()
                XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "receipt.row.")).firstMatch.exists)
                XCTAssertTrue(app.buttons["receipt.applyCategoryToAll"].exists)
                capture(app, "receipt-items-tab-\(appearance)")
                app.buttons["receipt.overviewTab"].tap()
            }
            if scenario == "result" || scenario == "loading" {
                app.buttons["receipt.imagePreview"].tap()
                XCTAssertTrue(app.buttons["receipt.closeImage"].waitForExistence(timeout: 5))
                app.buttons["receipt.closeImage"].tap()
            }
            if scenario == "loading" {
                app.buttons["receipt.stopWaiting"].tap()
                XCTAssertTrue(app.buttons["receipt.saveButton"].exists)
            }
            if scenario == "failure" {
                app.buttons["receipt.manualButton"].tap()
                XCTAssertTrue(app.buttons["receipt.saveButton"].exists)
            }
            app.terminate()
        }
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}


extension ReceiptFlowTests {
    @MainActor func testPendingReceiptCanCorrectItemCategoryRegisterAndReturnToRecords() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "receipt", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launch()
        app.buttons["receipt-tab"].tap()
        let pending = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "records.pending.")).firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 10))
        pending.tap()
        XCTAssertTrue(app.buttons["receipt.itemsTab"].waitForExistence(timeout: 5))
        app.buttons["receipt.itemsTab"].tap()
        let firstItem = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "receipt.row.")).firstMatch
        XCTAssertTrue(firstItem.waitForExistence(timeout: 5))
        firstItem.tap()
        let itemCategory = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "receipt.item.category.")).firstMatch
        XCTAssertTrue(itemCategory.waitForExistence(timeout: 5))
        let itemCategoryIdentifier = itemCategory.identifier
        itemCategory.tap()
        let dailyChoice = app.buttons["日用品"]
        XCTAssertTrue(dailyChoice.waitForExistence(timeout: 5))
        dailyChoice.tap()
        XCTAssertTrue(app.buttons[itemCategoryIdentifier].label.contains("日用品"))
        app.buttons["receipt.applyCategoryToAll"].tap()
        let foodChoice = app.buttons["食費"]
        XCTAssertTrue(foodChoice.waitForExistence(timeout: 5))
        foodChoice.tap()
        app.buttons["receipt.overviewTab"].tap()
        app.buttons["receipt-account"].tap()
        app.buttons["PayPayカード"].tap()
        app.buttons["receipt.saveButton"].tap()
        XCTAssertTrue(app.buttons["receipt.recordsButton"].waitForExistence(timeout: 10))
        app.buttons["receipt.recordsButton"].tap()
        XCTAssertTrue(app.buttons["records.search"].waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor func testAppliedReceiptDetailZoomsImageAndEditsItemCategory() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "receipt-applied", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launch()
        app.buttons["receipt-tab"].tap()
        let row = app.buttons["records.row.fixture-transaction-receipt"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let categoryRow = app.buttons["records.detail.category"]
        XCTAssertTrue(categoryRow.waitForExistence(timeout: 5))
        // PWA opens the applied receipt editor from a detail row; the image zooms there.
        app.buttons["records.detail.amount"].tap()
        XCTAssertTrue(app.staticTexts["支出の記録を編集"].waitForExistence(timeout: 10))
        let preview = app.buttons["receipt.imagePreview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        preview.tap()
        XCTAssertTrue(app.buttons["receipt.closeImage"].waitForExistence(timeout: 5))
        app.buttons["receipt.closeImage"].tap()
        app.buttons["receipt.itemsTab"].tap()
        let firstItem = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "receipt.row.")).firstMatch
        XCTAssertTrue(firstItem.waitForExistence(timeout: 5))
        firstItem.tap()
        let itemCategory = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "receipt.item.category.")).firstMatch
        XCTAssertTrue(itemCategory.waitForExistence(timeout: 5))
        let identifier = itemCategory.identifier
        itemCategory.tap()
        let household = app.buttons["日用品"]
        XCTAssertTrue(household.waitForExistence(timeout: 5))
        household.tap()
        XCTAssertTrue(app.buttons[identifier].label.contains("日用品"))
        app.buttons["receipt.saveButton"].tap()
        XCTAssertTrue(app.staticTexts["records.message"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["records.message"].label, "変更を保存しました。")
        app.terminate()
    }
}

extension ReceiptFlowTests {
    @MainActor func testUnfinishedPendingInputIsRestoredAfterLeavingTheEditor() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "receipt", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launch()
        app.buttons["receipt-tab"].tap()
        let pending = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "records.pending.")).firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 10))
        pending.tap()
        let merchant = app.textFields["receipt-merchant"]
        XCTAssertTrue(merchant.waitForExistence(timeout: 10))
        merchant.tap()
        merchant.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "合成の下書き")
        app.buttons["receipt.itemsTab"].tap()
        app.buttons["records.pendingBackButton"].tap()
        XCTAssertTrue(pending.waitForExistence(timeout: 10))
        pending.tap()
        let restored = app.textFields["receipt-merchant"]
        XCTAssertTrue(restored.waitForExistence(timeout: 10))
        XCTAssertEqual(restored.value as? String, "合成の下書き")
        app.terminate()
    }
}

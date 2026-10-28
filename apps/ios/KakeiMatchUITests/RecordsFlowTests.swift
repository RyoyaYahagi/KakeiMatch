import XCTest

final class RecordsFlowTests: XCTestCase {
    @MainActor private func launch(_ appearance: String, fixture: String = "reconciliation") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", fixture, "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        XCTAssertTrue(app.buttons["receipt-tab"].waitForExistence(timeout: 10))
        app.buttons["receipt-tab"].tap()
        XCTAssertTrue(app.buttons["records.row.fixture-transaction-010"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "records-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }

    @MainActor private func search(_ app: XCUIApplication) {
        app.buttons["records.search"].tap()
        let keyword = app.textFields["transaction-search-keyword"]
        XCTAssertTrue(keyword.waitForExistence(timeout: 5)); keyword.tap(); keyword.typeText("スーパーみどり")
        app.buttons["records.searchSubmit"].tap()
        let hiddenKeyboard = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hiddenKeyboard], timeout: 5), .completed)
        XCTAssertTrue(app.staticTexts["transaction-search-count"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["transaction-search-count"].label, "2件")
        XCTAssertEqual(app.staticTexts["records.searchTotal"].label, "−¥5,700")
    }

    @MainActor func testRecordsSearchDetailEditDeleteUndoAndReturn() {
        continueAfterFailure = false
        let app = launch("light")
        capture(app, "populated-light")
        app.buttons["records.filter.income"].tap()
        XCTAssertTrue(app.buttons["records.row.fixture-transaction-006"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["records.row.fixture-transaction-010"].exists)
        app.buttons["records.filter.transfer"].tap()
        XCTAssertTrue(app.staticTexts["records.empty"].waitForExistence(timeout: 5))
        capture(app, "transfer-empty-light")
        app.buttons["records.filter.all"].tap()
        search(app)
        capture(app, "search-light")
        app.buttons["records.row.fixture-transaction-008"].tap()
        XCTAssertTrue(app.buttons["records.detail.memo"].waitForExistence(timeout: 5))
        capture(app, "detail-light")
        app.buttons["records.detail.memo"].tap()
        let memo = app.textFields["records.editor.memo"]
        // A multiline SwiftUI field is exposed as a text view by some OS versions.
        let editor = memo.exists ? memo : app.textViews["records.editor.memo"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5)); editor.tap(); editor.typeText("合成の買い物メモ")
        app.swipeUp()
        app.buttons["records.save"].tap()
        XCTAssertTrue(app.staticTexts["records.message"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["records.message"].label, "変更を保存しました。")
        app.swipeUp()
        app.buttons["records.delete"].tap()
        app.alerts.buttons["削除する"].tap()
        let undo = app.buttons["元に戻す"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5)); undo.tap()
        XCTAssertTrue(app.buttons["records.row.fixture-transaction-008"].waitForExistence(timeout: 5))
        app.buttons["records.row.fixture-transaction-008"].tap()
        app.buttons["records.detailBack"].tap()
        XCTAssertEqual(app.staticTexts["transaction-search-count"].label, "2件")
        XCTAssertEqual(app.textFields["transaction-search-keyword"].value as? String, "スーパーみどり")
        app.buttons["records.searchClear"].tap()
        XCTAssertEqual(app.staticTexts["transaction-search-count"].label, "11件")
        app.buttons["records.searchBack"].tap()
        XCTAssertTrue(app.buttons["records.search"].exists)
        app.terminate()
    }

    @MainActor func testDarkReferenceStatesAndEmptyHousehold() {
        continueAfterFailure = false
        let app = launch("dark")
        capture(app, "populated-dark")
        search(app); capture(app, "search-dark")
        app.buttons["records.row.fixture-transaction-008"].tap()
        capture(app, "detail-dark")
        app.terminate()
        app.launchArguments = ["-UITestFixture", "empty", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launch()
        app.buttons["receipt-tab"].tap()
        XCTAssertTrue(app.staticTexts["records.empty"].waitForExistence(timeout: 5))
        capture(app, "empty-dark")
        app.terminate()
    }
}

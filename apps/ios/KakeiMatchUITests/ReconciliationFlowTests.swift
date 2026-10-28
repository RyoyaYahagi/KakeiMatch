import XCTest

final class ReconciliationFlowTests: XCTestCase {
    @MainActor private func launch(_ appearance: String, fixture: String = "reconciliation") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", fixture, "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        XCTAssertTrue(app.buttons["reconciliation-tab"].waitForExistence(timeout: 10))
        app.buttons["reconciliation-tab"].tap()
        return app
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "reconciliation-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }
    @MainActor private func tap(_ id: String, app: XCUIApplication) {
        let button = app.buttons[id]
        XCTAssertTrue(button.waitForExistence(timeout: 5), id)
        for _ in 0..<6 {
            if button.isHittable { break }
            app.swipeUp()
        }
        button.tap()
    }
    @MainActor func testManualMatchHistoryAndConfirmedUndo() {
        continueAfterFailure = false
        let app = launch("light")
        XCTAssertTrue(app.buttons["review-statement-fixture-statement-0"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["reconciliation.count.要確認"].label.contains("1件"))
        XCTAssertTrue(app.buttons["reconciliation.count.記録なし"].label.contains("2件"))
        XCTAssertTrue(app.buttons["reconciliation.count.一致"].label.contains("4件"))
        capture(app, "needs-review-light")
        tap("review-statement-fixture-statement-0", app: app)
        XCTAssertTrue(app.staticTexts["金額が¥20違います"].exists || app.staticTexts["△ 金額が¥20違います"].exists)
        capture(app, "comparison-light")
        tap("reconciliation.confirmMatch.fixture-statement-0.actual:fixture-transaction-000", app: app)
        XCTAssertTrue(app.buttons["reconciliation.count.一致"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["reconciliation.count.一致"].label, "一致 5件")
        tap("reconciliation-matched", app: app)
        tap("reconciliation.matchedItem.fixture-statement-0", app: app)
        tap("reconciliation.undo.fixture-statement-0", app: app)
        XCTAssertTrue(app.alerts["一致を取り消す"].waitForExistence(timeout: 5))
        app.alerts.buttons["キャンセル"].tap()
        tap("reconciliation.undo.fixture-statement-0", app: app)
        app.alerts.buttons["一致を取り消す"].tap()
        // Return to the top without depending on the scroll position retained by the shell.
        app.buttons["home-tab"].tap(); app.buttons["reconciliation-tab"].tap()
        XCTAssertTrue(app.buttons["reconciliation.count.要確認"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["reconciliation.count.要確認"].label, "要確認 1件")
        XCTAssertEqual(app.buttons["reconciliation.count.一致"].label, "一致 4件")
        app.terminate()
    }
    @MainActor func testReferenceStatesLightDarkAndEmptyImporter() {
        continueAfterFailure = false
        for appearance in ["light", "dark"] {
            let app = launch(appearance)
            XCTAssertTrue(app.buttons["reconciliation-matched"].waitForExistence(timeout: 10))
            if appearance == "dark" { capture(app, "needs-review-dark") }
            tap("reconciliation-matched", app: app)
            capture(app, "matched-" + appearance)
            app.terminate()
            let empty = launch(appearance, fixture: "empty")
            XCTAssertTrue(empty.buttons["statement-file"].waitForExistence(timeout: 10))
            capture(empty, "empty-" + appearance)
            tap("reconciliation.importButton", app: empty)
            XCTAssertTrue(empty.staticTexts["CSVファイルを選択してください。"].waitForExistence(timeout: 5))
            tap("statement-provider", app: empty)
            empty.buttons["イオンカード"].tap()
            XCTAssertTrue(empty.staticTexts["statement-import-availability"].waitForExistence(timeout: 5))
            XCTAssertFalse(empty.buttons["statement-file"].isEnabled)
            XCTAssertFalse(empty.buttons["reconciliation.importButton"].isEnabled)
            empty.terminate()
        }
    }
    @MainActor func testCountsNavigateToHistoryAndPending() {
        continueAfterFailure = false
        let app = launch("light")
        XCTAssertTrue(app.buttons["reconciliation.count.一致"].waitForExistence(timeout: 10))
        let history = app.buttons["reconciliation-matched"]
        let initialHistoryY = history.frame.minY
        app.buttons["reconciliation.count.一致"].tap()
        XCTAssertEqual(history.value as? String, "展開中")
        // Short pages stop at the maximum scroll offset, just like scrollIntoView in PWA.
        XCTAssertLessThan(history.frame.minY, initialHistoryY - 100)
        for _ in 0..<3 { app.swipeDown() }
        let pending = app.buttons["review-statement-fixture-statement-0"]
        let initialPendingY = pending.frame.minY
        app.buttons["reconciliation.count.要確認"].tap()
        XCTAssertLessThan(pending.frame.minY, initialPendingY - 100)
        app.terminate()
    }
    @MainActor func testSuspectedRequiresConfirmationAndCanBeCleared() {
        continueAfterFailure = false
        let app = launch("light")
        tap("review-statement-fixture-statement-2", app: app)
        tap("reconciliation.suspect.fixture-statement-2", app: app)
        XCTAssertTrue(app.alerts["不正利用？"].waitForExistence(timeout: 5))
        app.alerts.buttons["不正利用？"].tap()
        tap("reconciliation-suspected", app: app)
        tap("review-statement-fixture-statement-2", app: app)
        tap("自分の利用だった", app: app)
        app.buttons["home-tab"].tap(); app.buttons["reconciliation-tab"].tap()
        XCTAssertTrue(app.buttons["reconciliation.count.不正利用？"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["reconciliation.count.不正利用？"].label, "不正利用？ 0件")
        XCTAssertEqual(app.buttons["reconciliation.count.記録なし"].label, "記録なし 2件")
        app.terminate()
    }
}

import XCTest

final class RecurringFlowTests: XCTestCase {
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor private func launchList(_ appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        app.buttons["settings-tab"].tap()
        app.buttons["settings.recurring"].tap()
        XCTAssertTrue(app.staticTexts["recurring.title"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor private func openCatchUpDialog(_ appearance: String, name: String) -> XCUIApplication {
        let app = launchList(appearance)
        app.buttons["recurring.add"].tap()
        let title = app.staticTexts["recurring.editor.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let scheduleName = app.textFields["recurring.name"]
        scheduleName.tap(); scheduleName.typeText(name)
        let amount = app.textFields["recurring.amount"]
        amount.tap(); amount.typeText("1200")
        app.descendants(matching: .any)["recurring.category"].tap()
        app.buttons["食費"].tap()
        app.descendants(matching: .any)["recurring.account"].tap()
        app.buttons["PayPayカード"].tap()
        let startDate = app.textFields["recurring.startDate"]
        startDate.tap()
        let existingDate = startDate.value as? String ?? ""
        if !existingDate.isEmpty { startDate.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existingDate.count)) }
        startDate.typeText("2026-08-14")
        app.buttons["recurring.save"].tap()
        XCTAssertTrue(currentMonthChoice(app).waitForExistence(timeout: 8))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        let cancel = app.buttons["recurring.catchUp.cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        XCTAssertTrue(cancel.isHittable)
        return app
    }

    @MainActor private func openHistory(_ appearance: String, name: String) -> XCUIApplication {
        let app = openCatchUpDialog(appearance, name: name)
        currentMonthChoice(app).tap()
        let schedule = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(schedule.waitForExistence(timeout: 8))
        schedule.tap()
        let history = app.staticTexts["recurring.catchUp.history.title"]
        XCTAssertTrue(history.waitForExistence(timeout: 5))
        if !history.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "2026-10-14〜2026-10-14 · 1件 · ¥1,200")).firstMatch.waitForExistence(timeout: 5))
        return app
    }

    @MainActor private func currentMonthChoice(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "recurring.catchUp.currentMonth").firstMatch
    }

    @MainActor func testRecurringInitialLightScreenshot() {
        continueAfterFailure = false
        let app = launchList("light")
        capture(app, "recurring-initial-light")
        app.terminate()
    }

    @MainActor func testRecurringInitialDarkScreenshot() {
        continueAfterFailure = false
        let app = launchList("dark")
        capture(app, "recurring-initial-dark")
        app.terminate()
    }

    @MainActor func testCreateRecurringScheduleFromSettings() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        app.launch()
        app.buttons["settings-tab"].tap()
        let entrance = app.buttons["settings.recurring"]
        XCTAssertTrue(entrance.waitForExistence(timeout: 10))
        entrance.tap()
        XCTAssertTrue(app.staticTexts["recurring.title"].waitForExistence(timeout: 5))
        app.buttons["recurring.add"].tap()
        XCTAssertTrue(app.staticTexts["recurring.editor.title"].waitForExistence(timeout: 5))
        let name = app.textFields["recurring.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap(); name.typeText("合成の定期予定")
        let amount = app.textFields["recurring.amount"]
        amount.tap(); amount.typeText("12000")
        app.descendants(matching: .any)["recurring.category"].tap()
        app.buttons["食費"].tap()
        app.descendants(matching: .any)["recurring.account"].tap()
        app.buttons["PayPayカード"].tap()
        app.buttons["recurring.save"].tap()
        XCTAssertTrue(app.staticTexts["recurring.status"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["定期登録を保存しました。"].exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "合成の定期予定")).firstMatch.waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor func testCatchUpCurrentMonthAppearsInRecordsAndCanBeUndoneFromHistory() {
        continueAfterFailure = false
        let name = "合成過去分の定期"
        let app = openCatchUpDialog("light", name: name)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "2026-08-14〜2026-10-14の未登録分があります。")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "3件 · 合計 ¥3,600")).firstMatch.exists)
        currentMonthChoice(app).tap()

        let schedule = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(schedule.waitForExistence(timeout: 8))
        app.buttons["receipt-tab"].tap()
        let recordsScreen = app.descendants(matching: .any).matching(identifier: "records.screen").firstMatch
        XCTAssertTrue(recordsScreen.waitForExistence(timeout: 8))
        let generatedRecord = recordsScreen.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(generatedRecord.waitForExistence(timeout: 8))

        app.buttons["settings-tab"].tap()
        let recurring = app.buttons["settings.recurring"]
        XCTAssertTrue(recurring.waitForExistence(timeout: 8)); recurring.tap()
        let recurringRow = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(recurringRow.waitForExistence(timeout: 8)); recurringRow.tap()
        let undo = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "この回を一括で取り消す")).firstMatch
        if !undo.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(undo.waitForExistence(timeout: 5)); undo.tap()
        XCTAssertTrue(app.staticTexts["一括取り消し済みです。"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "2026-10-14 · ¥1,200 · 削除済み")).firstMatch.exists)

        app.terminate()
    }

    @MainActor func testCatchUpDialogLightScreenshot() {
        continueAfterFailure = false
        let app = openCatchUpDialog("light", name: "合成スクリーンショット用定期")
        capture(app, "recurring-catch-up-dialog-light")
        app.terminate()
    }

    @MainActor func testCatchUpDialogDarkScreenshot() {
        continueAfterFailure = false
        let app = openCatchUpDialog("dark", name: "合成スクリーンショット用定期")
        capture(app, "recurring-catch-up-dialog-dark")
        app.terminate()
    }

    @MainActor func testCatchUpHistoryLightScreenshot() {
        continueAfterFailure = false
        let app = openHistory("light", name: "合成スクリーンショット用定期")
        capture(app, "recurring-catch-up-history-light")
        app.terminate()
    }

    @MainActor func testCatchUpHistoryDarkScreenshot() {
        continueAfterFailure = false
        let app = openHistory("dark", name: "合成スクリーンショット用定期")
        capture(app, "recurring-catch-up-history-dark")
        app.terminate()
    }
}

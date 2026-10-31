import XCTest

/// Large-text checks for Issue #240. The fixed PWA sizes must not change at the
/// default content size; these tests only exercise accessibility sizes.
final class DynamicTypeLayoutTests: XCTestCase {
    private let accessibilitySizeArgument = [
        "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL",
    ]

    @MainActor
    func testAccessibilityXLHomeRecordsEntryAndSettingsStayInsideScreen() throws {
        continueAfterFailure = false
        executionTimeAllowance = 180
        let app = makeApp(fixture: "migration")
        app.launch()
        let screen = app.windows.firstMatch

        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        assertInside(app.staticTexts["home.monthly.expense"], screen: screen)
        assertTappable(app.buttons["home.month.previous"], screen: screen)
        assertTappable(app.buttons["home.month.next"], screen: screen)
        screenshot(app, named: "dynamic-type-xl-home")

        app.buttons["receipt-tab"].tap()
        XCTAssertTrue(app.otherElements["records.screen"].waitForExistence(timeout: 10))
        assertTappable(app.buttons["records.filter.all"], screen: screen)
        assertTappable(app.buttons["records.accounts"], screen: screen)
        app.swipeUp()
        let visibleRecords = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "records.row."))
            .allElementsBoundByIndex.prefix(6).filter {
                $0.isHittable
                    && $0.frame.minY >= screen.frame.minY
                    && $0.frame.maxY <= screen.frame.maxY
            }
        XCTAssertFalse(visibleRecords.isEmpty, "拡大時に画面内へ収まる記録行がありません")
        if let visibleRecord = visibleRecords.first { assertTappable(visibleRecord, screen: screen) }
        screenshot(app, named: "dynamic-type-xl-records")

        app.buttons["home-tab"].tap()
        app.buttons["add-record"].tap()
        XCTAssertTrue(app.buttons["chooser.expense"].waitForExistence(timeout: 5))
        app.buttons["chooser.expense"].tap()
        XCTAssertTrue(app.otherElements["manualEntry.screen"].waitForExistence(timeout: 10))
        assertTappable(app.textFields["manual-transaction-amount"], screen: screen)
        assertTappable(app.buttons["entry.saveButton"], screen: screen)
        assertAboveNavigation(app.buttons["entry.saveButton"], app: app)
        screenshot(app, named: "dynamic-type-xl-manual-entry")

        app.buttons["home-tab"].tap()
        app.buttons["settings-tab"].tap()
        XCTAssertTrue(app.otherElements["settings.screen"].waitForExistence(timeout: 10))
        assertTappable(app.buttons["settings-tab"], screen: screen)
        screenshot(app, named: "dynamic-type-xl-settings")
        app.swipeUp()
        assertTappable(app.buttons["settings.theme"], screen: screen)
        assertTappable(app.buttons["settings.screenLock"], screen: screen)
    }

    @MainActor
    func testAccessibilityXLReceiptAndReconciliationStayInsideScreen() throws {
        continueAfterFailure = false
        executionTimeAllowance = 180
        let app = makeApp(fixture: "receipt", extraArguments: ["-ReceiptScenario", "result"])
        app.launch()
        let screen = app.windows.firstMatch

        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        app.buttons["add-record"].tap()
        XCTAssertTrue(app.buttons["chooser.photo"].waitForExistence(timeout: 5))
        app.buttons["chooser.photo"].tap()
        XCTAssertTrue(app.otherElements["receipt.screen"].waitForExistence(timeout: 10))
        assertHittable(app.buttons["receipt.itemsTab"], screen: screen)
        assertTappable(app.buttons["receipt.saveButton"], screen: screen)
        assertAboveNavigation(app.buttons["receipt.saveButton"], app: app)
        app.swipeUp()
        assertTappable(app.textFields["receipt-amount"], screen: screen)
        screenshot(app, named: "dynamic-type-xl-receipt")

        app.terminate()
        let reconciliation = makeApp(fixture: "reconciliation")
        reconciliation.launch()
        XCTAssertTrue(reconciliation.otherElements["home.screen"].waitForExistence(timeout: 10))
        reconciliation.buttons["reconciliation-tab"].tap()
        XCTAssertTrue(reconciliation.otherElements["reconciliation.screen"].waitForExistence(timeout: 10))
        let reconciliationScreen = reconciliation.windows.firstMatch
        assertHittable(reconciliation.buttons["reconciliation.runAgain"], screen: reconciliationScreen)
        reconciliation.swipeUp()
        assertHittable(reconciliation.buttons["reconciliation.importCsvButton"], screen: reconciliationScreen)
        assertTappable(reconciliation.buttons["reconciliation-tab"], screen: reconciliationScreen)
        screenshot(reconciliation, named: "dynamic-type-xl-reconciliation")
    }

    @MainActor
    private func makeApp(fixture: String, extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", fixture, "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
            + extraArguments + accessibilitySizeArgument
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        return app
    }

    @MainActor
    private func assertInside(_ element: XCUIElement, screen: XCUIElement,
                              file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 10), "要素がありません", file: file, line: line)
        XCTAssertGreaterThanOrEqual(element.frame.minX, screen.frame.minX - 1, "左にはみ出しています: \(element)", file: file, line: line)
        XCTAssertLessThanOrEqual(element.frame.maxX, screen.frame.maxX + 1, "右にはみ出しています: \(element)", file: file, line: line)
        XCTAssertGreaterThanOrEqual(element.frame.minY, screen.frame.minY - 1, "上にはみ出しています: \(element)", file: file, line: line)
        XCTAssertLessThanOrEqual(element.frame.maxY, screen.frame.maxY + 1, "下にはみ出しています: \(element)", file: file, line: line)
    }

    @MainActor
    private func assertTappable(_ element: XCUIElement, screen: XCUIElement,
                                file: StaticString = #filePath, line: UInt = #line) {
        assertInside(element, screen: screen, file: file, line: line)
        XCTAssertTrue(element.isHittable, "タップできません: \(element)", file: file, line: line)
        XCTAssertGreaterThanOrEqual(element.frame.height, 43.5, "タップ領域が44pt未満です: \(element)", file: file, line: line)
    }

    @MainActor
    private func assertHittable(_ element: XCUIElement, screen: XCUIElement,
                                file: StaticString = #filePath, line: UInt = #line) {
        assertInside(element, screen: screen, file: file, line: line)
        XCTAssertTrue(element.isHittable, "タップできません: \(element)", file: file, line: line)
    }

    @MainActor
    private func assertAboveNavigation(_ element: XCUIElement, app: XCUIApplication,
                                       file: StaticString = #filePath, line: UInt = #line) {
        let navigation = app.buttons["home-tab"]
        XCTAssertTrue(navigation.waitForExistence(timeout: 5), file: file, line: line)
        XCTAssertLessThanOrEqual(element.frame.maxY, navigation.frame.minY + 1,
                                 "下部ナビと重なっています", file: file, line: line)
    }

    @MainActor
    private func screenshot(_ app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

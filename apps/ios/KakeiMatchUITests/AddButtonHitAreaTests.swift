import CoreGraphics
import XCTest

final class AddButtonHitAreaTests: XCTestCase {
    @MainActor
    func testAddTileOnlyRespondsInsideItsRaisedShapeAcrossTabs() {
        continueAfterFailure = false
        let app = makeApp()
        app.launch()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        capture(app, "add-hit-area-home")

        for tab in ["home-tab", "receipt-tab", "reconciliation-tab", "settings-tab"] {
            app.buttons[tab].tap()
            XCTAssertTrue(app.buttons[tab].isSelected)
            assertTileCoordinates(app)
        }
    }

    @MainActor
    func testTapBesideRaisedTileStillActivatesUnderlyingRecordRow() {
        continueAfterFailure = false
        let app = makeApp()
        app.launch()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        app.buttons["receipt-tab"].tap()
        XCTAssertTrue(app.otherElements["records.screen"].waitForExistence(timeout: 10))

        let homeTab = app.buttons["home-tab"]
        let add = app.buttons["add-record"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        let rowTop = homeTab.frame.minY
        let x = app.frame.midX - 30 // 2pt outside the centered tile, inside the full-width row.
        let y = rowTop - 18 // the top-edge test point, within the raised tile's vertical span.
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "records.row."))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "テスト用の記録行がありません")
        var underlyingRow: XCUIElement?
        for _ in 0..<6 {
            underlyingRow = rows.allElementsBoundByIndex.first {
                $0.frame.minX <= x && x <= $0.frame.maxX && $0.frame.minY <= y && y <= $0.frame.maxY
            }
            if underlyingRow != nil { break }
            app.swipeUp(velocity: .slow)
        }
        guard underlyingRow != nil else {
            XCTFail("タイル横の座標に重なる記録行を表示できませんでした")
            return
        }

        tap(app, x: x, y: y)
        XCTAssertTrue(app.otherElements["records.detailScreen"].waitForExistence(timeout: 10),
                      "タイル外のタップが背後の記録行へ届きません")
    }

    @MainActor
    func testAddTileTracksDynamicTypeAndKeyboard() {
        continueAfterFailure = false
        let app = makeApp(dynamicTypeXL: true)
        app.launch()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        assertTopTileTap(app)

        app.buttons["record-sheet.close"].tap()
        waitForChooserToClose(app)
        app.buttons["add-record"].tap()
        XCTAssertTrue(app.buttons["chooser.expense"].waitForExistence(timeout: 5))
        app.buttons["chooser.expense"].tap()
        XCTAssertTrue(app.otherElements["manualEntry.screen"].waitForExistence(timeout: 10))

        let amount = app.textFields["manual-transaction-amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: 5))
        amount.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        assertTopTileTap(app)
        XCTAssertTrue(app.buttons["record-sheet.close"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["add-record"].isHittable, "選択シート表示中に背後の追加ボタンが操作可能です")
        app.buttons["record-sheet.close"].tap()
        waitForChooserToClose(app)
        app.buttons["entry.cancel"].tap()
        XCTAssertTrue(app.buttons["chooser.expense"].waitForExistence(timeout: 5))
        app.buttons["record-sheet.close"].tap()
        waitForChooserToClose(app)
        XCTAssertFalse(app.otherElements["manualEntry.screen"].exists, "キャンセル後も入力画面が残っています")
    }

    @MainActor
    func testAddTileTracksMoneyForwardRoute() {
        continueAfterFailure = false
        let app = makeApp()
        app.launch()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        XCTAssertTrue(app.buttons["settings.backup"].waitForExistence(timeout: 10))
        app.buttons["settings.backup"].tap()
        XCTAssertTrue(app.buttons["settings.moneyforward"].waitForExistence(timeout: 10))
        app.buttons["settings.moneyforward"].tap()
        XCTAssertTrue(app.staticTexts["moneyforward.title"].waitForExistence(timeout: 10))
        capture(app, "add-hit-area-moneyforward")
        assertTopTileTap(app)
        app.buttons["record-sheet.close"].tap()
        waitForChooserToClose(app)
    }

    @MainActor
    func testAddButtonAccessibilityOrderAndLandscapeLock() {
        continueAfterFailure = false
        let app = makeApp()
        app.launch()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))

        let navigationIDs = ["home-tab", "receipt-tab", "add-record", "reconciliation-tab", "settings-tab"]
        let observedIDs = app.buttons.allElementsBoundByIndex
            .map(\.identifier)
            .filter { navigationIDs.contains($0) }
        XCTAssertEqual(observedIDs, navigationIDs, "下部ナビのアクセシビリティ順が変わっています")
        XCTAssertEqual(app.buttons.matching(identifier: "add-record").count, 1)
        XCTAssertEqual(app.buttons["add-record"].label, "記録を追加")

        let device = XCUIDevice.shared
        defer { device.orientation = .portrait }
        device.orientation = .landscapeLeft
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 5))
        XCTAssertGreaterThan(app.frame.height, app.frame.width, "縦向き固定の画面が横向きになりました")
        assertTopTileTap(app)
        app.buttons["record-sheet.close"].tap()
        waitForChooserToClose(app)
    }

    @MainActor
    private func makeApp(dynamicTypeXL: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        if dynamicTypeXL {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"]
        }
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        return app
    }

    @MainActor
    private func assertTileCoordinates(_ app: XCUIApplication) {
        let homeTab = app.buttons["home-tab"]
        let add = app.buttons["add-record"]
        XCTAssertTrue(homeTab.waitForExistence(timeout: 5))
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        let rowTop = homeTab.frame.minY
        let centerX = app.frame.midX
        let top = rowTop - 22

        for y in [top + 4, rowTop + 6, top + 52] {
            tap(app, x: centerX, y: y)
            XCTAssertTrue(app.buttons["chooser.receipt"].waitForExistence(timeout: 5),
                          "タイル内のタップが反応しません: x=\(centerX), y=\(y)")
            app.buttons["record-sheet.close"].tap()
            waitForChooserToClose(app)
        }

        for (x, y) in [
            (centerX - 30, rowTop + 6), (centerX + 30, rowTop + 6),
            (centerX, top - 2), (centerX, rowTop + 36),
            (centerX - 26, top + 2), (centerX + 26, top + 2),
            (centerX - 26, top + 54), (centerX + 26, top + 54),
        ] {
            tap(app, x: x, y: y)
            XCTAssertFalse(app.buttons["chooser.receipt"].waitForExistence(timeout: 1),
                           "タイル形状の外のタップで追加画面が開きました: x=\(x), y=\(y)")
        }
    }

    @MainActor
    private func assertTopTileTap(_ app: XCUIApplication) {
        let rowTop = app.buttons["home-tab"].frame.minY
        let centerX = app.frame.midX
        tap(app, x: centerX, y: rowTop - 22 + 4)
        XCTAssertTrue(app.buttons["chooser.receipt"].waitForExistence(timeout: 5),
                      "タイル上端の内側をタップしても記録方法選択が開きません")
    }

    @MainActor
    private func tap(_ app: XCUIApplication, x: CGFloat, y: CGFloat) {
        let frame = app.frame
        app.coordinate(withNormalizedOffset: CGVector(
            dx: (x - frame.minX) / frame.width,
            dy: (y - frame.minY) / frame.height
        )).tap()
    }

    @MainActor
    private func waitForChooserToClose(_ app: XCUIApplication) {
        let sheet = app.descendants(matching: .any)["record-sheet"]
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: sheet)
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 5), .completed)
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

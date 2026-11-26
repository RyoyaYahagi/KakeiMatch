import CoreGraphics
import SwiftUI
import XCTest

final class AddButtonHitAreaTests: XCTestCase {
    @MainActor
    func testAddTileOnlyRespondsInsideItsRaisedShapeOnHomeTab() {
        continueAfterFailure = false
        let app = makeApp()
        app.launch()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        capture(app, "add-hit-area-home")

        // The tile stays at the same place on every tab, so the shape is checked once on the home tab.
        // Checking it again on each tab only repeated the same assertions.
        assertTileCoordinates(app, currentTab: "home-tab")
    }

    @MainActor
    func testAddTileCornerBoundaryRespondsJustInsideAndIgnoresJustOutside() {
        continueAfterFailure = false
        let app = makeApp()
        app.launch()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))

        let homeTab = app.buttons["home-tab"]
        let add = app.buttons["add-record"]
        XCTAssertTrue(homeTab.waitForExistence(timeout: 5))
        XCTAssertTrue(add.waitForExistence(timeout: 5))

        let tileSize: CGFloat = 56
        let tileBounds = CGRect(x: 0, y: 0, width: tileSize, height: tileSize)
        let continuousPath = RoundedRectangle(cornerRadius: 18, style: .continuous).path(in: tileBounds)
        var low: CGFloat = 0
        var high = tileSize / 2
        for _ in 0..<24 {
            let mid = (low + high) / 2
            if continuousPath.contains(CGPoint(x: mid, y: mid)) {
                high = mid
            } else {
                low = mid
            }
        }
        let cornerDiagonal = high
        let margin: CGFloat = 1.5
        let insideInset = cornerDiagonal + margin
        let outsideInset = cornerDiagonal - margin
        XCTAssertGreaterThan(outsideInset, 0)
        XCTAssertFalse(continuousPath.contains(CGPoint(x: outsideInset, y: outsideInset)))
        XCTAssertTrue(continuousPath.contains(CGPoint(x: insideInset, y: insideInset)))

        let rowTop = homeTab.frame.minY
        let centerX = app.frame.midX
        let left = centerX - tileSize / 2
        let right = centerX + tileSize / 2
        let top = rowTop - 22
        let bottom = top + tileSize

        let corners: [(name: String, inside: CGPoint, outside: CGPoint)] = [
            ("左上", CGPoint(x: left + insideInset, y: top + insideInset),
             CGPoint(x: left + outsideInset, y: top + outsideInset)),
            ("右上", CGPoint(x: right - insideInset, y: top + insideInset),
             CGPoint(x: right - outsideInset, y: top + outsideInset)),
            ("左下", CGPoint(x: left + insideInset, y: bottom - insideInset),
             CGPoint(x: left + outsideInset, y: bottom - outsideInset)),
            ("右下", CGPoint(x: right - insideInset, y: bottom - insideInset),
             CGPoint(x: right - outsideInset, y: bottom - outsideInset)),
        ]

        for corner in corners {
            tap(app, x: corner.inside.x, y: corner.inside.y)
            XCTAssertTrue(app.buttons["chooser.receipt"].waitForExistence(timeout: 5),
                          "\(corner.name)角の境界すぐ内側のタップが反応しません: \(corner.inside)")
            app.buttons["record-sheet.close"].tap()
            waitForChooserToClose(app)

            tap(app, x: corner.outside.x, y: corner.outside.y)
            XCTAssertFalse(app.buttons["chooser.receipt"].waitForExistence(timeout: 1),
                           "\(corner.name)角の境界すぐ外側のタップで追加画面が開きました: \(corner.outside)")
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
        let y = rowTop - 18 // the top-edge test point, within the raised tile's vertical span.
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "records.row."))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "テスト用の記録行がありません")

        func assertSideTapOpensUnderlyingRow(atX x: CGFloat) {
            var underlyingRow: XCUIElement?
            for _ in 0..<6 {
                underlyingRow = rows.allElementsBoundByIndex.first {
                    $0.frame.minX <= x && x <= $0.frame.maxX && $0.frame.minY <= y && y <= $0.frame.maxY
                }
                if underlyingRow != nil { break }
                app.swipeUp(velocity: .slow)
            }
            guard underlyingRow != nil else {
                XCTFail("タイル横の座標に重なる記録行を表示できませんでした: x=\(x), y=\(y)")
                return
            }

            tap(app, x: x, y: y)
            XCTAssertTrue(app.buttons["records.detailBack"].waitForExistence(timeout: 10),
                          "タイル外のタップが背後の記録行へ届きません")
            XCTAssertTrue(app.staticTexts["records.detail.heading"].waitForExistence(timeout: 5),
                          "背後の記録行から記録詳細の見出しが表示されません")
            XCTAssertFalse(app.buttons["chooser.receipt"].exists,
                           "タイル外のタップで追加画面が開きました")
        }

        // 2pt outside the centered 56pt tile on both sides, within the raised row's span.
        assertSideTapOpensUnderlyingRow(atX: app.frame.midX - 30)
        app.buttons["records.detailBack"].tap()
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "記録詳細から記録一覧へ戻れません")
        assertSideTapOpensUnderlyingRow(atX: app.frame.midX + 30)
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
        // At Accessibility XL the save button stays tappable above the tab bar before the keyboard opens.
        let save = app.buttons["entry.saveButton"]
        XCTAssertTrue(save.isHittable, "タップできません: 保存ボタン")
        XCTAssertLessThanOrEqual(save.frame.maxY, app.buttons["home-tab"].frame.minY + 1, "下部ナビと重なっています")

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
    private func assertTileCoordinates(_ app: XCUIApplication, currentTab: String) {
        let homeTab = app.buttons["home-tab"]
        let receiptTab = app.buttons["receipt-tab"]
        let reconciliationTab = app.buttons["reconciliation-tab"]
        let add = app.buttons["add-record"]
        XCTAssertTrue(homeTab.waitForExistence(timeout: 5))
        XCTAssertTrue(receiptTab.waitForExistence(timeout: 5))
        XCTAssertTrue(reconciliationTab.waitForExistence(timeout: 5))
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        let rowTop = homeTab.frame.minY
        let centerX = app.frame.midX
        let top = rowTop - 22

        let addFrame = add.frame
        XCTAssertEqual(addFrame.width, 56, accuracy: 1, "追加ボタンの幅が56ptではありません")
        XCTAssertEqual(addFrame.height, 56, accuracy: 1, "追加ボタンの高さが56ptではありません")
        XCTAssertEqual(addFrame.midX, centerX, accuracy: 1, "追加ボタンが中央に配置されていません")
        XCTAssertEqual(addFrame.minY, top, accuracy: 1, "追加ボタンの上端がナビ行上端-22ptではありません")

        for y in [top + 4, rowTop + 6, top + 52] {
            tap(app, x: centerX, y: y)
            XCTAssertTrue(app.buttons["chooser.receipt"].waitForExistence(timeout: 5),
                          "タイル内のタップが反応しません: x=\(centerX), y=\(y)")
            app.buttons["record-sheet.close"].tap()
            waitForChooserToClose(app)
        }

        let leftTabTapX = receiptTab.frame.maxX - 4
        tap(app, x: leftTabTapX, y: rowTop + 6)
        XCTAssertFalse(app.buttons["chooser.receipt"].waitForExistence(timeout: 1),
                       "左隣タブの内側端タップで追加画面が開きました: x=\(leftTabTapX), y=\(rowTop + 6)")
        XCTAssertTrue(receiptTab.isSelected, "左隣タブの内側端タップで記録タブへ切り替わりません")

        let rightTabTapX = reconciliationTab.frame.minX + 4
        tap(app, x: rightTabTapX, y: rowTop + 6)
        XCTAssertFalse(app.buttons["chooser.receipt"].waitForExistence(timeout: 1),
                       "右隣タブの内側端タップで追加画面が開きました: x=\(rightTabTapX), y=\(rowTop + 6)")
        XCTAssertTrue(reconciliationTab.isSelected, "右隣タブの内側端タップで照合タブへ切り替わりません")

        app.buttons[currentTab].tap()
        XCTAssertTrue(app.buttons[currentTab].isSelected)

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

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
        if XCTWaiter.wait(for: [hiddenKeyboard], timeout: 10) != .completed {
            attachContext(app, name: "keyboard-not-hidden")
            XCTFail("検索実行後10秒以内にキーボードが閉じない")
        }
        XCTAssertTrue(app.staticTexts["transaction-search-count"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["transaction-search-count"].label, "2件")
        XCTAssertEqual(app.staticTexts["records.searchTotal"].label, "−¥5,700")
    }

    /// The same text is attached to the xcresult and printed to the test log.
    /// The print keeps a failure readable from the job log, without downloading
    /// the whole xcresult artifact (90MB in run 42799907472).
    @MainActor private func attachContext(_ app: XCUIApplication, name: String, row: XCUIElement? = nil) {
        var lines = ["records-\(name)"]
        if let row {
            if row.exists {
                lines.append("row.exists=true row.isHittable=\(row.isHittable) row.isEnabled=\(row.isEnabled) row.frame=\(row.frame)")
            } else {
                lines.append("row.exists=false")
            }
        }
        // While `KMRecordsModel.busy` is true the whole search screen is
        // disabled and the submit label changes, so these separate an undo
        // reload from a row that was simply never tappable.
        let submit = app.buttons["records.searchSubmit"]
        if submit.exists {
            lines.append("searchSubmit.exists=true searchSubmit.label=\(submit.label) searchSubmit.isEnabled=\(submit.isEnabled)")
        } else {
            lines.append("searchSubmit.exists=false")
        }
        let message = app.staticTexts["records.message"]
        if message.exists {
            lines.append("records.message=\(message.label)")
        } else {
            lines.append("records.message.exists=false")
        }
        lines.append("deletionRestored.exists=\(app.descendants(matching: .any)["shell.deletionRestored"].exists)")
        lines.append("searchScreen.exists=\(app.descendants(matching: .any)["records.searchScreen"].exists)")
        lines.append("detailBack.exists=\(app.buttons["records.detailBack"].exists)")
        lines.append("detailScreen.exists=\(app.descendants(matching: .any)["records.detailScreen"].exists)")
        lines.append("detailLoading.exists=\(app.descendants(matching: .any)["records.detail.loading"].exists)")
        lines.append("app.debugDescription:")
        lines.append(app.debugDescription)
        let text = lines.joined(separator: "\n")
        let attachment = XCTAttachment(string: text)
        attachment.name = "records-\(name)-diagnostics"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("[records-diagnostics] \(name)\n\(text)")
    }

    @MainActor private func waitUntilHittable(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    /// Keep the two waits separate: the first tells a lost tap from a slow
    /// detail read, and the second gives the read time to finish.
    ///
    /// `hittableTimeout` is wider only for the call after an undo. Undo bumps
    /// `recordsRefreshToken`, which starts `reload()`; while `busy` is true the
    /// search screen is `.disabled(model.busy)` and the row cannot be tapped.
    /// That reload outlasted the 2s gate in run 42799907472, so the undo path
    /// waits 10s. The other gates (search screen 2s, detail 10s) stay as they are.
    @MainActor private func openSearchResult(_ app: XCUIApplication, row id: String, detail detailID: String,
                                             hittableTimeout: TimeInterval = 2) {
        let row = app.buttons[id]
        if !row.waitForExistence(timeout: 5) {
            attachContext(app, name: "row-missing", row: row)
            XCTFail("\(id) が見つからない")
            return
        }
        if !waitUntilHittable(row, timeout: hittableTimeout) {
            attachContext(app, name: "row-not-hittable", row: row)
            XCTFail("\(id) が\(Int(hittableTimeout))秒以内にタップ可能にならない")
            return
        }
        row.tap()
        let searchHidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"),
            object: app.descendants(matching: .any)["records.searchScreen"])
        if XCTWaiter.wait(for: [searchHidden], timeout: 2) != .completed {
            attachContext(app, name: "search-not-dismissed", row: row)
            XCTFail("行をタップしてから2秒以内に検索画面が閉じない")
            return
        }
        if !app.buttons[detailID].waitForExistence(timeout: 10) {
            attachContext(app, name: "detail-not-rendered", row: row)
            XCTFail("詳細画面の \(detailID) が10秒以内に表示されない")
        }
    }

    @MainActor private func openListRecord(_ app: XCUIApplication, row id: String, detail detailID: String) {
        let row = app.buttons[id]
        if !row.waitForExistence(timeout: 5) {
            attachContext(app, name: "row-missing", row: row)
            XCTFail("\(id) が見つからない")
            return
        }
        if !waitUntilHittable(row, timeout: 2) {
            attachContext(app, name: "row-not-hittable", row: row)
            XCTFail("\(id) が2秒以内にタップ可能にならない")
            return
        }
        row.tap()
        if !app.buttons["records.detailBack"].waitForExistence(timeout: 5) {
            attachContext(app, name: "detail-not-shown", row: row)
            XCTFail("行をタップしてから5秒以内に詳細画面が表示されない")
            return
        }
        if !app.buttons[detailID].waitForExistence(timeout: 10) {
            attachContext(app, name: "detail-not-rendered", row: row)
            XCTFail("詳細画面の \(detailID) が10秒以内に表示されない")
        }
    }

    @MainActor private func assertDeleteButtonVisibleWithoutScroll(_ app: XCUIApplication) -> XCUIElement {
        let delete = app.buttons["records.delete"]
        let window = app.windows.firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "詳細画面に削除ボタンがありません")
        XCTAssertTrue(delete.isHittable, "スクロールせずに削除ボタンを操作できません")
        XCTAssertTrue(window.frame.contains(delete.frame), "削除ボタン全体が画面内にありません")
        XCTAssertFalse(delete.frame.intersects(app.buttons["records.detailBack"].frame),
                        "戻る操作と削除操作のタップ領域が重なっています")
        return delete
    }

    @MainActor private func assertDeletionPrompt(_ app: XCUIApplication) -> XCUIElement {
        let prompt = app.alerts.firstMatch
        XCTAssertTrue(prompt.waitForExistence(timeout: 5), "削除確認が表示されません")
        XCTAssertTrue(prompt.label.contains("この取引を削除しますか？レシート画像などの原本は残ります。"),
                      "削除確認の文言が変わっています")
        XCTAssertTrue(prompt.buttons["削除する"].exists)
        XCTAssertTrue(prompt.buttons["キャンセル"].exists)
        return prompt
    }

    @MainActor private func assertPromptDismissed(_ prompt: XCUIElement) {
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: prompt)
        if XCTWaiter.wait(for: [dismissed], timeout: 5) != .completed {
            XCTFail("操作後も削除確認が閉じていません")
        }
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
        openSearchResult(app, row: "records.row.fixture-transaction-008", detail: "records.detail.memo")
        capture(app, "detail-light")

        // The first delete attempt must be tappable from the freshly opened detail,
        // with no scroll gesture that could make an off-screen control hittable.
        assertDeleteButtonVisibleWithoutScroll(app).tap()
        let cancelledPrompt = assertDeletionPrompt(app)
        cancelledPrompt.buttons["キャンセル"].tap()
        assertPromptDismissed(cancelledPrompt)
        let detailBackAfterCancel = app.buttons["records.detailBack"]
        XCTAssertTrue(
            detailBackAfterCancel.waitForExistence(timeout: 5) && detailBackAfterCancel.isHittable,
            "キャンセル後に記録詳細へ留まって操作できません"
        )
        XCTAssertTrue(app.buttons["records.detail.memo"].waitForExistence(timeout: 5),
                      "キャンセル後に対象記録の詳細項目が表示されていません")
        app.buttons["records.detailBack"].tap()
        XCTAssertTrue(app.buttons["records.row.fixture-transaction-008"].waitForExistence(timeout: 5),
                      "キャンセル後に検索結果の記録が残っていません")

        // Reopen the record to make the confirm path start from its initial view too.
        openSearchResult(app, row: "records.row.fixture-transaction-008", detail: "records.detail.memo")
        assertDeleteButtonVisibleWithoutScroll(app).tap()
        let confirmedPrompt = assertDeletionPrompt(app)
        confirmedPrompt.buttons["削除する"].tap()
        assertPromptDismissed(confirmedPrompt)
        let undo = app.buttons["元に戻す"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5)); undo.tap()
        XCTAssertTrue(app.buttons["records.row.fixture-transaction-008"].waitForExistence(timeout: 5),
                      "undo 後に記録が復元されていません")

        // The existing edit flow runs after deletion has been cancelled and undone.
        // Scrolling for the memo editor is unrelated to the initial delete checks above.
        openSearchResult(app, row: "records.row.fixture-transaction-008", detail: "records.detail.memo", hittableTimeout: 10)
        app.buttons["records.detail.memo"].tap()
        let memo = app.textFields["records.editor.memo"]
        // A multiline SwiftUI field is exposed as a text view by some OS versions.
        let editor = memo.exists ? memo : app.textViews["records.editor.memo"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5)); editor.tap(); editor.typeText("合成の買い物メモ")
        app.swipeUp()
        app.buttons["records.save"].tap()
        XCTAssertTrue(app.staticTexts["records.message"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["records.message"].label, "変更を保存しました。")
        let detailBack = app.buttons["records.detailBack"]
        for _ in 0..<4 where !detailBack.isHittable { app.swipeDown(velocity: .slow) }
        XCTAssertTrue(detailBack.isHittable, "保存後に検索結果へ戻れません")
        app.buttons["records.detailBack"].tap()
        XCTAssertEqual(app.staticTexts["transaction-search-count"].label, "2件")
        XCTAssertEqual(app.textFields["transaction-search-keyword"].value as? String, "スーパーみどり")
        app.buttons["records.searchClear"].tap()
        XCTAssertEqual(app.staticTexts["transaction-search-count"].label, "11件")
        app.buttons["records.searchBack"].tap()
        XCTAssertTrue(app.buttons["records.search"].exists)
        app.terminate()
    }

    @MainActor func testSearchPeriodOpensCalendar() {
        continueAfterFailure = false
        for appearance in ["light", "dark"] {
            let app = launch(appearance)
            app.buttons["records.search"].tap()
            app.buttons["records.chip.start"].tap()
            XCTAssertTrue(app.datePickers.firstMatch.waitForExistence(timeout: 5), "期間からカレンダーを開けること")
            capture(app, "search-calendar-\(appearance)")
            app.buttons["キャンセル"].tap()
            app.buttons["records.advanced"].tap()
            for field in ["start", "end"] {
                let input = app.buttons["records.search.\(field)"]
                XCTAssertEqual(input.value as? String, "指定なし")
                input.tap()
                XCTAssertTrue(app.datePickers.firstMatch.waitForExistence(timeout: 3))
                app.buttons["records.search.dateApply"].tap()
                XCTAssertNotEqual(input.value as? String, "指定なし")
                input.tap()
                XCTAssertTrue(app.datePickers.firstMatch.waitForExistence(timeout: 3))
                app.buttons["records.search.dateClear"].tap()
                XCTAssertEqual(input.value as? String, "指定なし")
            }
            app.terminate()
        }
    }

    @MainActor func testSearchChipsSelectRequestedCondition() {
        continueAfterFailure = false
        let app = launch("light")
        app.buttons["records.search"].tap()
        app.buttons["records.advanced"].tap()
        for (field, title, option) in [("kind", "種類", "収入"), ("category", "カテゴリ（非表示を含む）", "食費"), ("account", "口座（利用終了を含む）", "PayPayカード")] {
            app.buttons["records.chip.\(field)"].tap()
            // The requested selector must open even when detailed conditions are already expanded.
            XCTAssertTrue(app.buttons[option].waitForExistence(timeout: 3), "\(title)の選択肢が開くこと")
            app.buttons[option].tap()
        }
        app.buttons["records.chip.minimum"].tap()
        let minimum = app.textFields["records.search.minimum"]
        XCTAssertTrue(minimum.waitForExistence(timeout: 3))
        minimum.typeText("100")
        app.terminate()
    }

    @MainActor private func openAppliedPayroll(_ appearance: String) -> XCUIApplication {
        let app = launch(appearance, fixture: "payroll")
        app.buttons["records.filter.income"].tap()
        XCTAssertTrue(app.buttons["records.row.fixture-transaction-006"].waitForExistence(timeout: 5))
        openListRecord(app, row: "records.row.fixture-transaction-006", detail: "records.payrollDetails")
        return app
    }

    @MainActor func testPayrollBreakdownInIncomeRecordDetail() {
        continueAfterFailure = false
        let app = openAppliedPayroll("light")
        let details = app.buttons["records.payrollDetails"]
        XCTAssertEqual(details.label, "給与明細の内訳（登録時）")
        XCTAssertEqual(details.value as? String, "折りたたみ")
        XCTAssertFalse(app.staticTexts["総支給額：¥310,000"].exists)
        details.tap()
        XCTAssertEqual(details.value as? String, "展開中")
        XCTAssertTrue(app.staticTexts["登録時に確認した内訳です。取引の編集後も元の内訳を保持し、削除の取り消しに備えて残します。"].waitForExistence(timeout: 5))
        for line in [
            "総支給額：¥310,000", "所得税：¥8,000", "住民税：¥10,000", "健康保険：¥15,000",
            "厚生年金：¥27,000", "雇用保険：¥2,000", "その他控除：未記載", "控除合計：¥62,000",
            "対象期間：2026年9月 / 給与", "通勤手当：¥10,000", "住宅手当：未記載",
        ] {
            XCTAssertTrue(app.staticTexts[line].exists, line)
        }
        app.terminate()
    }

    @MainActor private func capturePayrollBreakdown(_ appearance: String, name: String) {
        continueAfterFailure = false
        let app = openAppliedPayroll(appearance)
        app.buttons["records.payrollDetails"].tap()
        app.swipeUp()
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        app.terminate()
    }

    @MainActor func testPayrollBreakdownLightScreenshot() { capturePayrollBreakdown("light", name: "records-payroll-breakdown-light") }
    @MainActor func testPayrollBreakdownDarkScreenshot() { capturePayrollBreakdown("dark", name: "records-payroll-breakdown-dark") }

    @MainActor func testDeletionUndoSurvivesTabSwitchAndAccountLinkOpensAccounts() {
        continueAfterFailure = false
        let app = launch("light")

        app.buttons["records.accounts"].tap()
        XCTAssertTrue(app.staticTexts["masters.title"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["masters.title"].label, "支払元・口座")
        capture(app, "accounts-from-records-light")
        app.buttons["masters.back"].tap()
        XCTAssertTrue(app.otherElements["settings.screen"].waitForExistence(timeout: 5))

        app.buttons["receipt-tab"].tap()
        XCTAssertTrue(app.buttons["records.row.fixture-transaction-010"].waitForExistence(timeout: 5))
        openListRecord(app, row: "records.row.fixture-transaction-010", detail: "records.detail.memo")
        assertDeleteButtonVisibleWithoutScroll(app).tap()
        app.alerts.buttons["削除する"].tap()

        let undo = app.buttons["元に戻す"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5))
        app.buttons["home-tab"].tap()
        XCTAssertTrue(app.buttons["home-tab"].isSelected)
        // PWA keeps .deletion-toast outside the tab view, so it is still visible on Home.
        XCTAssertTrue(undo.waitForExistence(timeout: 5))
        capture(app, "deletion-toast-home-light")
        undo.tap()

        XCTAssertTrue(app.buttons["records.row.fixture-transaction-010"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["削除を取り消しました。"].waitForExistence(timeout: 10))
        capture(app, "deletion-restored-light")
        app.terminate()
    }

    @MainActor func testDarkReferenceStatesAndEmptyHousehold() {
        continueAfterFailure = false
        let app = launch("dark")
        capture(app, "populated-dark")
        search(app); capture(app, "search-dark")
        openSearchResult(app, row: "records.row.fixture-transaction-008", detail: "records.detail.memo")
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

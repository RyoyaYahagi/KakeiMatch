import CoreGraphics
import XCTest

/// Issue #391: exploratory UI measurements for the iOS first-run journey.
///
/// These tests keep `continueAfterFailure = true` so a missing element in one
/// step does not hide the later observations. Each step writes an observation
/// line and the scenario attaches the complete log to the xcresult.
///
/// U2 uses the `empty` fixture. That fixture has no categories and no accounts,
/// exactly like a fresh install, so the save failure is the measurement rather
/// than a setup bug. U3 therefore uses the `migration` fixture: the empty U2
/// cannot produce a record to edit. The edit path itself is the same one a
/// record registered from U2 would use.
final class UXExplorationTests: XCTestCase {
    private final class Log {
        private(set) var lines: [String] = []

        func add(_ line: String) {
            lines.append(line)
            print("[ux] \(line)")
        }

        var text: String { lines.joined(separator: "\n") }
    }

    @MainActor
    private func launch(_ fixture: String, _ log: Log) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", fixture, "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        app.launch()
        log.add("launch fixture=\(fixture) appearance=light")
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String, _ log: Log) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        log.add("screenshot \(name)")
    }

    @MainActor
    private func finish(_ log: Log, _ scenario: String) {
        let attachment = XCTAttachment(string: log.text)
        attachment.name = "\(scenario)-observations"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("[ux-\(scenario)-observations]\n\(log.text)")
    }

    @MainActor
    @discardableResult
    private func observe(_ log: Log, _ name: String, _ element: XCUIElement, timeout: TimeInterval = 3) -> Bool {
        let exists = element.waitForExistence(timeout: timeout)
        if exists {
            log.add("\(name).exists=true label=\(element.label) value=\(String(describing: element.value)) hittable=\(element.isHittable)")
        } else {
            log.add("\(name).exists=false")
        }
        return exists
    }

    @MainActor
    private func observeButtons(_ log: Log, _ name: String, _ query: XCUIElementQuery) {
        let count = query.count
        log.add("\(name).count=\(count)")
        for index in 0..<count {
            let element = query.element(boundBy: index)
            log.add("\(name)[\(index)].label=\(element.label) identifier=\(element.identifier) value=\(String(describing: element.value))")
        }
    }

    @MainActor
    @discardableResult
    private func tap(_ element: XCUIElement, in app: XCUIApplication, log: Log, _ name: String,
                     swipes: Int = 4, direction: String = "up") -> Bool {
        guard element.waitForExistence(timeout: 5) else {
            log.add("\(name).tap=skipped(missing)")
            return false
        }
        for _ in 0..<swipes where !element.isHittable {
            if direction == "down" { app.swipeDown() } else { app.swipeUp() }
        }
        guard element.isHittable else {
            log.add("\(name).tap=skipped(notHittable) frame=\(element.frame)")
            return false
        }
        element.tap()
        log.add("\(name).tap=ok")
        return true
    }

    // MARK: - U1 初回ホーム（empty）

    @MainActor
    func testU1EmptyHomeShowsTabsAndBudgetSetup() {
        continueAfterFailure = true
        let log = Log()
        defer { finish(log, "ux-u1") }
        let app = launch("empty", log)

        log.add("STEP U1-1 起動直後のホーム")
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["home.monthly.expense"].waitForExistence(timeout: 10))

        for identifier in ["home-tab", "receipt-tab", "reconciliation-tab", "settings-tab", "add-record"] {
            observe(log, "tab.\(identifier)", app.buttons[identifier])
        }
        log.add("tab.home.selected=\(app.buttons["home-tab"].isSelected)")

        log.add("STEP U1-2 予算未設定の導線")
        let setup = app.buttons["home.budget.setup"]
        if observe(log, "home.budget.setup", setup) {
            log.add("home.budget.setup.label=\(setup.label)")
        }
        log.add("home.budget.details.exists=\(app.buttons["home.budget.details"].exists)")
        log.add("home.monthly.expense.label=\(app.descendants(matching: .any)["home.monthly.expense"].label)")

        capture(app, "ux-u1-home-empty-light", log)
        app.terminate()
    }

    // MARK: - U2 手入力の支出登録と支払元の判定（empty）

    @MainActor
    func testU2EmptyEntryObservesSourceAccountTrap() {
        continueAfterFailure = true
        let log = Log()
        defer { finish(log, "ux-u2") }
        let app = launch("empty", log)

        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10))
        log.add("STEP U2-1 add-record から支出を選ぶ")
        tap(app.buttons["add-record"], in: app, log: log, "add-record")
        XCTAssertTrue(app.buttons["chooser.expense"].waitForExistence(timeout: 5))
        app.buttons["chooser.expense"].tap()
        XCTAssertTrue(app.otherElements["manualEntry.screen"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["entry.saveButton"].waitForExistence(timeout: 10))
        capture(app, "ux-u2-entry-empty-light", log)

        log.add("STEP U2-2 金額3284と店名を入力")
        let amount = app.textFields["manual-transaction-amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: 5))
        amount.tap()
        amount.typeText("3284")
        log.add("amount.value=\(String(describing: amount.value))")

        let payee = app.textFields["manual-transaction-payee"]
        XCTAssertTrue(payee.waitForExistence(timeout: 5))
        payee.tap()
        payee.typeText("スーパーみどり")
        var payeeValue = (payee.value as? String) ?? ""
        log.add("payee.afterJapanese=\(payeeValue)")
        if !payeeValue.contains("スーパーみどり") {
            // U3 audit fallback: a keyboard that cannot type Japanese uses the
            // existing English fixture name instead. The log records the switch.
            payee.tap()
            payee.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: max(payeeValue.count, 20)))
            payee.typeText("UITestStore")
            payeeValue = (payee.value as? String) ?? ""
            log.add("payee.fallback=UITestStore value=\(payeeValue)")
        }
        log.add("U3.japaneseInput=\(payeeValue.contains("スーパーみどり") ? "ok" : "fallback")")

        var categoryCount = 0
        log.add("STEP U2-3 カテゴリ選択シート")
        if tap(app.buttons["entry.categorySheet"], in: app, log: log, "entry.categorySheet") {
            XCTAssertTrue(app.buttons["record-sheet.close"].waitForExistence(timeout: 5))
            capture(app, "ux-u2-category-sheet-light", log)
            let categories = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "entry.category."))
            categoryCount = categories.count
            observeButtons(log, "categoryChoices", categories)
            observe(log, "categorySheet.emptyMessage", app.staticTexts["カテゴリがありません。追加してください。"])
            tap(app.buttons["record-sheet.close"], in: app, log: log, "record-sheet.close", swipes: 0)
        }

        var accountCount = 0
        log.add("STEP U2-4 支払元選択シート")
        if tap(app.buttons["manual-transaction-account"], in: app, log: log, "manual-transaction-account") {
            XCTAssertTrue(app.buttons["record-sheet.close"].waitForExistence(timeout: 5))
            capture(app, "ux-u2-account-sheet-light", log)
            let accounts = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "entry.account."))
            accountCount = accounts.count
            observeButtons(log, "accountChoices", accounts)
            observe(log, "accountSheet.add", app.buttons["entry.addAccountFromPicker"])
            tap(app.buttons["record-sheet.close"], in: app, log: log, "record-sheet.close", swipes: 0)
        }
        log.add("empty.masterCounts categories=\(categoryCount) accounts=\(accountCount)")

        log.add("STEP U2-5 保存")
        if accountCount == 0 {
            tap(app.buttons["entry.saveButton"], in: app, log: log, "entry.saveButton")
            if observe(log, "entry.error", app.staticTexts["entry.error"], timeout: 5) {
                log.add("U2.firstRunTrap.error=\(app.staticTexts["entry.error"].label)")
            }
            log.add("entry.status.exists=\(app.staticTexts["entry.status"].exists)")
            capture(app, "ux-u2-save-failure-light", log)
        } else {
            tap(app.buttons["manual-transaction-account"], in: app, log: log, "manual-transaction-account")
            if app.buttons["record-sheet.close"].waitForExistence(timeout: 5) {
                let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "entry.account.")).firstMatch
                if first.exists {
                    first.tap()
                    log.add("account.selected=\(first.label)")
                }
            }
            tap(app.buttons["entry.categorySheet"], in: app, log: log, "entry.categorySheet")
            if app.buttons["record-sheet.close"].waitForExistence(timeout: 5) {
                let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "entry.category.")).firstMatch
                if first.exists {
                    first.tap()
                    log.add("category.selected=\(first.label)")
                }
            }
            tap(app.buttons["entry.saveButton"], in: app, log: log, "entry.saveButton")
            let status = app.staticTexts["entry.status"]
            let statusAppeared = status.waitForExistence(timeout: 10)
            XCTAssertTrue(statusAppeared, "支払元がある場合、保存結果のステータスが表示される")
            if statusAppeared {
                log.add("entry.status=\(status.label)")
                XCTAssertEqual(status.label, "登録しました。")
                capture(app, "ux-u2-saved-light", log)
            } else {
                observe(log, "entry.error", app.staticTexts["entry.error"], timeout: 2)
            }
        } else {
            tap(app.buttons["entry.saveButton"], in: app, log: log, "entry.saveButton")
            observe(log, "entry.error", app.staticTexts["entry.error"], timeout: 5)
            capture(app, "ux-u2-save-failure-light", log)
        }

        app.terminate()
    }

    // MARK: - U3 登録した記録の編集

    @MainActor
    func testU3EditsRegisteredRecordCategory() {
        continueAfterFailure = true
        let log = Log()
        defer { finish(log, "ux-u3") }
        let app = launch("migration", log)
        log.add("U3.fixtureNote=empty の U2 は支払元0件で保存できないため、登録済みの migration 記録で編集導線を測る")

        XCTAssertTrue(app.buttons["receipt-tab"].waitForExistence(timeout: 10))
        app.buttons["receipt-tab"].tap()
        XCTAssertTrue(app.buttons["records.row.fixture-transaction-008"].waitForExistence(timeout: 10))

        log.add("STEP U3-1 記録一覧から詳細を開く")
        if tap(app.buttons["records.row.fixture-transaction-008"], in: app, log: log, "records.row.fixture-transaction-008") {
            XCTAssertTrue(app.buttons["records.detail.category"].waitForExistence(timeout: 10))
            observe(log, "records.detail.category", app.buttons["records.detail.category"])
            log.add("records.detail.category.label=\(app.buttons["records.detail.category"].label)")
            capture(app, "ux-u3-record-detail-light", log)
        }

        log.add("STEP U3-2 カテゴリを食費から外食へ変更")
        if tap(app.buttons["records.detail.category"], in: app, log: log, "records.detail.category") {
            let picker = app.descendants(matching: .any)["records.editor.category"]
            if picker.waitForExistence(timeout: 5) {
                picker.tap()
                log.add("records.editor.category.tap=ok")
                let option = app.buttons.matching(NSPredicate(format: "label == %@", "外食")).firstMatch
                if option.waitForExistence(timeout: 5) {
                    option.tap()
                    log.add("category.option=外食 tap=ok")
                } else {
                    let fallback = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "外食")).firstMatch
                    if fallback.exists {
                        fallback.tap()
                        log.add("category.option=外食 fallback=any tap=ok")
                    } else {
                        log.add("category.option=外食 missing")
                    }
                }
            } else {
                log.add("records.editor.category missing")
            }
        }
        let pickerAfter = app.descendants(matching: .any)["records.editor.category"]
        observe(log, "records.editor.category.after", pickerAfter, timeout: 2)

        log.add("STEP U3-3 保存")
        if tap(app.buttons["records.save"], in: app, log: log, "records.save") {
            let message = app.staticTexts["records.message"]
            if message.waitForExistence(timeout: 10) {
                log.add("records.message=\(message.label)")
                XCTAssertEqual(message.label, "変更を保存しました。")
                for _ in 0..<3 { app.swipeDown() }
                capture(app, "ux-u3-record-saved-light", log)
            } else {
                observe(log, "records.message.missing", app.staticTexts["records.message"], timeout: 2)
            }
        }

        log.add("STEP U3-4 一覧へ戻る（戻るボタンはCIでisHittable=falseのためタブ切替）")
        // `records.detailBack` reported a 20pt frame and became unresolvable
        // while the saved detail reloaded. Switch tabs to recreate the list;
        // the observation keeps the back-button finding for a separate issue.
        app.buttons["home-tab"].tap()
        app.buttons["receipt-tab"].tap()
        XCTAssertTrue(app.buttons["records.row.fixture-transaction-008"].waitForExistence(timeout: 10))
        log.add("fallback.tabSwitch=ok")
        log.add("records.row.008.label=\(app.buttons["records.row.fixture-transaction-008"].label)")
        capture(app, "ux-u3-records-after-save-light", log)

        app.terminate()
    }

    // MARK: - U4 照合（empty と reconciliation）

    @MainActor
    func testU4ReconciliationEmptyAndPopulatedStates() {
        continueAfterFailure = true
        let log = Log()
        defer { finish(log, "ux-u4") }

        log.add("STEP U4-1 empty の照合タブ")
        var app = launch("empty", log)
        XCTAssertTrue(app.buttons["reconciliation-tab"].waitForExistence(timeout: 10))
        log.add("empty.reconciliation-tab.label=\(app.buttons["reconciliation-tab"].label)")
        app.buttons["reconciliation-tab"].tap()
        XCTAssertTrue(app.otherElements["reconciliation.screen"].waitForExistence(timeout: 10))
        observe(log, "empty.statement-file", app.buttons["statement-file"])
        observe(log, "empty.importButton", app.buttons["reconciliation.importButton"])
        observe(log, "empty.counts", app.descendants(matching: .any)["reconciliation.counts"])
        observe(log, "empty.emptyText", app.staticTexts["明細を取り込んでから照合してください。"])
        capture(app, "ux-u4-reconciliation-empty-light", log)
        app.terminate()

        log.add("STEP U4-2 reconciliation のデータあり状態")
        app = launch("reconciliation", log)
        XCTAssertTrue(app.buttons["reconciliation-tab"].waitForExistence(timeout: 10))
        log.add("data.reconciliation-tab.label=\(app.buttons["reconciliation-tab"].label)")
        app.buttons["reconciliation-tab"].tap()
        XCTAssertTrue(app.buttons["reconciliation.count.一致"].waitForExistence(timeout: 10))
        for label in ["要確認", "記録なし", "一致", "不正利用？"] {
            observe(log, "reconciliation.count.\(label)", app.buttons["reconciliation.count.\(label)"])
        }
        if observe(log, "reconciliation.runStatus", app.staticTexts["reconciliation.runStatus"]) {
            log.add("reconciliation.runStatus.label=\(app.staticTexts["reconciliation.runStatus"].label)")
        }
        capture(app, "ux-u4-reconciliation-data-light", log)

        if tap(app.buttons["reconciliation.count.一致"], in: app, log: log, "reconciliation.count.一致") {
            observe(log, "reconciliation-matched", app.buttons["reconciliation-matched"])
            capture(app, "ux-u4-reconciliation-list-light", log)
        }
        app.terminate()
    }

    // MARK: - U5 設定の発見可能性（migration）

    @MainActor
    func testU5SettingsRowsAndBudgetDiscovery() {
        continueAfterFailure = true
        let log = Log()
        defer { finish(log, "ux-u5") }
        let app = launch("migration", log)

        XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        XCTAssertTrue(app.otherElements["settings.screen"].waitForExistence(timeout: 10))

        log.add("STEP U5-1 設定一覧の行を ID で確認")
        for identifier in ["settings.categories", "settings.accounts", "settings.budget", "settings.backup"] {
            let element = app.buttons[identifier]
            if !element.exists {
                for _ in 0..<3 { app.swipeUp() }
            }
            let exists = observe(log, identifier, element, timeout: 3)
            XCTAssertTrue(exists, "\(identifier) が見つからない")
            log.add("\(identifier).label=\(exists ? element.label : "-") value=\(exists ? String(describing: element.value) : "-")")
        }
        capture(app, "ux-u5-settings-light", log)

        log.add("STEP U5-2 予算だけを開く（値は変更しない）")
        for _ in 0..<3 { app.swipeDown() }
        if tap(app.buttons["settings.budget"], in: app, log: log, "settings.budget", direction: "down") {
            XCTAssertTrue(app.descendants(matching: .any)["budget.screen"].waitForExistence(timeout: 10))
            observe(log, "budget-edit-month", app.staticTexts["budget-edit-month"])
            let total = app.textFields["budget-overall-amount"]
            if observe(log, "budget-overall-amount", total) {
                log.add("budget.overallAmount.value=\(String(describing: total.value))")
            }
            capture(app, "ux-u5-budget-light", log)
        }

        app.terminate()
    }
}

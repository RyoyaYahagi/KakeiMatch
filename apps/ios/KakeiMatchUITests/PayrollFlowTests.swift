import XCTest

final class PayrollFlowTests: XCTestCase {
    @MainActor
    private func openPayroll(appearance: String, draft: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "payroll", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        if draft { app.launchArguments.append("-PayrollDraft") }
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        XCTAssertTrue(app.buttons["add-record"].waitForExistence(timeout: 10))
        app.buttons["add-record"].tap()
        app.buttons["chooser.income"].tap()
        XCTAssertTrue(app.buttons["income.payrollButton"].waitForExistence(timeout: 5))
        app.buttons["income.payrollButton"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["payroll.screen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["payroll.employerName"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor func testPayrollIncomeFlowAndConfirmedBreakdown() {
        continueAfterFailure = false
        let app = openPayroll(appearance: "light")
        XCTAssertTrue(app.staticTexts["給与明細から入力"].exists)
        XCTAssertTrue(app.staticTexts["写真は保存しません。氏名・社員番号・マイナンバー・住所・生年月日・口座番号・支店番号・QRコードを隠してから読み取ります。"].exists)
        XCTAssertEqual(app.textFields["payroll.netPayYen"].value as? String, "260000")
        // The fixture keeps an unresolved pending payroll: PWA shows the retry label for that state.
        let save = app.buttons["payroll.saveButton"]
        XCTAssertTrue(save.exists)
        XCTAssertEqual(save.label, "登録結果を確認する")
        XCTAssertEqual(app.buttons["payroll.reviewed"].value as? String, "選択中")
        app.terminate()
    }

    @MainActor func testPayrollConfirmedFieldsRequireReviewCheckbox() {
        continueAfterFailure = false
        let app = openPayroll(appearance: "light", draft: true)
        XCTAssertTrue(app.staticTexts["写真は保存しません。氏名・社員番号・マイナンバー・住所・生年月日・口座番号・支店番号・QRコードを隠してから読み取ります。"].exists)
        XCTAssertEqual(app.textFields["payroll.netPayYen"].value as? String, "260000")
        XCTAssertTrue(app.staticTexts["手取りだけを収入に登録します。控除から支出は作りません。写真と照らし合わせて、違うところを直してください。"].exists)
        let review = app.buttons["payroll.reviewed"]
        XCTAssertTrue(review.exists)
        XCTAssertEqual(review.label, "勤務先・支給日・手取りと内訳を確認しました")
        XCTAssertEqual(review.value as? String, "選択中")
        let save = app.buttons["payroll.saveButton"]
        XCTAssertTrue(save.exists)
        XCTAssertEqual(save.label, "登録する")
        XCTAssertTrue(save.isEnabled)
        review.tap()
        XCTAssertFalse(save.isEnabled)
        XCTAssertEqual(review.value as? String, "未選択")
        review.tap()
        XCTAssertTrue(save.isEnabled)
        app.terminate()
    }

    @MainActor func testPayrollInitialLightScreenshot() { capture(appearance: "light", name: "payroll-initial-light") }
    @MainActor func testPayrollInitialDarkScreenshot() { capture(appearance: "dark", name: "payroll-initial-dark") }
    @MainActor func testPayrollConfirmLightScreenshot() { capture(appearance: "light", name: "payroll-confirm-light", bottom: true) }
    @MainActor func testPayrollConfirmDarkScreenshot() { capture(appearance: "dark", name: "payroll-confirm-dark", bottom: true) }

    @MainActor private func capture(appearance: String, name: String, bottom: Bool = false) {
        continueAfterFailure = false
        let app = openPayroll(appearance: appearance, draft: true)
        if bottom { app.swipeUp() }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        app.terminate()
    }
}

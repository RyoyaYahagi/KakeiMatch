import XCTest

final class PayrollFlowTests: XCTestCase {
    @MainActor
    private func openPayroll(appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "payroll", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        app.launch()
        XCTAssertTrue(app.buttons["add-record"].waitForExistence(timeout: 10))
        app.buttons["add-record"].tap()
        app.buttons["chooser.income"].tap()
        XCTAssertTrue(app.buttons["income.payrollButton"].waitForExistence(timeout: 5))
        app.buttons["income.payrollButton"].tap()
        XCTAssertTrue(app.otherElements["payroll.screen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["payroll.employerName"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor func testPayrollIncomeFlowAndConfirmedBreakdown() {
        continueAfterFailure = false
        let app = openPayroll(appearance: "light")
        XCTAssertTrue(app.staticTexts["給与明細から入力"].exists)
        XCTAssertTrue(app.staticTexts["写真は保存しません。氏名・社員番号・マイナンバー・住所・生年月日・口座番号・支店番号・QRコードを隠してから読み取ります。"].exists)
        XCTAssertEqual(app.textFields["payroll.netPayYen"].value as? String, "260000")
        XCTAssertTrue(app.buttons["payroll.saveButton"].exists)
        app.terminate()
    }

    @MainActor func testPayrollInitialLightScreenshot() { capture(appearance: "light", name: "payroll-initial-light") }
    @MainActor func testPayrollInitialDarkScreenshot() { capture(appearance: "dark", name: "payroll-initial-dark") }

    @MainActor private func capture(appearance: String, name: String) {
        continueAfterFailure = false
        let app = openPayroll(appearance: appearance)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        app.terminate()
    }
}

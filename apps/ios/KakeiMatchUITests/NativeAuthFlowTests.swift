import XCTest

final class NativeAuthFlowTests: XCTestCase {
    @MainActor private func launch(_ appearance: String, authState: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        if let authState { app.launchEnvironment["KM_UI_TEST_NATIVE_AUTH_STATE"] = authState }
        app.launch()
        XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        XCTAssertTrue(app.buttons["settings.aiUsage"].waitForExistence(timeout: 5))
        app.buttons["settings.aiUsage"].tap()
        XCTAssertTrue(app.staticTexts["settings-page-ai-title"].waitForExistence(timeout: 5))
        return app
    }

    /// The account screen fills its labels after a refresh, so wait for the
    /// expected copy instead of reading a label while it still shows the
    /// loading state.
    @MainActor private func waitForLabel(_ element: XCUIElement, contains text: String, timeout: TimeInterval = 5) {
        expectation(for: NSPredicate(format: "label CONTAINS %@", text), evaluatedWith: element)
        waitForExpectations(timeout: timeout)
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "native-auth-" + name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor func testUnsupportedDeviceExplainsCloudStopAndKeepsLocalUse() {
        continueAfterFailure = false
        // No fake state: on Simulator App Attest is unsupported, as on a real
        // unsupported device. The screen must not attempt a cloud request.
        let app = launch("light")
        XCTAssertTrue(app.staticTexts["account-status"].waitForExistence(timeout: 5))
        waitForLabel(app.staticTexts["usage-summary"], contains: "クラウドのログインとAI機能を利用できません")
        waitForLabel(app.staticTexts["usage-summary"], contains: "家計簿の閲覧や編集")
        XCTAssertFalse(app.buttons["passkey-login"].exists)
        XCTAssertFalse(app.buttons["invite-register"].exists)
        capture(app, "unsupported-light")

        app.buttons["settings.back"].tap()
        XCTAssertTrue(app.buttons["settings.aiUsage"].waitForExistence(timeout: 5))
        app.buttons["home-tab"].tap()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor func testGuestUsagePasskeyLoginAndLogout() {
        continueAfterFailure = false
        let app = launch("light", authState: "signedOut")
        XCTAssertTrue(app.buttons["passkey-login"].waitForExistence(timeout: 5))
        waitForLabel(app.staticTexts["usage-summary"], contains: "ログインしなくても")
        waitForLabel(app.staticTexts["account-status"], contains: "未ログイン")
        capture(app, "signed-out-light")

        app.buttons["passkey-login"].tap()
        XCTAssertTrue(app.buttons["logout"].waitForExistence(timeout: 5))
        waitForLabel(app.staticTexts["usage-summary"], contains: "今月の読み取り 3 / 10回 · Free")
        waitForLabel(app.staticTexts["account-status"], contains: "ログイン中：テスト利用者")
        XCTAssertTrue(app.staticTexts["passkey-list"].exists || app.otherElements["passkey-list"].exists)
        capture(app, "signed-in-light")

        app.buttons["logout"].tap()
        XCTAssertTrue(app.buttons["passkey-login"].waitForExistence(timeout: 5))
        waitForLabel(app.staticTexts["account-message"], contains: "ログアウトしました")
        app.buttons["settings.back"].tap()
        let row = app.buttons["settings.aiUsage"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        // The row reloads the PWA `#ai-row-value` after logout, so wait for the
        // refreshed guest value instead of reading it once.
        expectation(for: NSPredicate(format: "label CONTAINS %@", "1日5回まで"), evaluatedWith: row)
        waitForExpectations(timeout: 5)
        app.buttons["home-tab"].tap()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor func testGuestUsageScreenshotInDark() {
        continueAfterFailure = false
        let app = launch("dark", authState: "guest")
        XCTAssertTrue(app.staticTexts["usage-summary"].waitForExistence(timeout: 5))
        waitForLabel(app.staticTexts["usage-summary"], contains: "今日のAI読み取り 2 / 5回 · 登録なし")
        XCTAssertTrue(app.buttons["passkey-login"].exists)
        capture(app, "guest-dark")
        app.terminate()
    }
}

import XCTest

final class NativeAuthFlowTests: XCTestCase {
    @MainActor private func launch(_ appearance: String, authState: String? = nil, supportId: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
        if let authState { app.launchEnvironment["KM_UI_TEST_NATIVE_AUTH_STATE"] = authState }
        if let supportId { app.launchEnvironment["KM_UI_TEST_SUPPORT_ID"] = supportId }
        app.launch()
        XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        XCTAssertTrue(app.buttons["settings.aiUsage"].waitForExistence(timeout: 5))
        return app
    }

    /// The usage screen fills its labels after a refresh, so wait for the
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

    @MainActor private func assertNoAccountManagementUI(_ app: XCUIApplication) {
        for buttonId in ["passkey-login", "invite-register", "use-ai", "add-passkey", "logout", "delete-account", "manual-entry"] {
            XCTAssertFalse(app.buttons[buttonId].exists, "Unexpected account button: \(buttonId)")
        }
        XCTAssertFalse(app.staticTexts["account-status"].exists)
        XCTAssertFalse(app.staticTexts["account-message"].exists)
    }

    @MainActor func testUnsupportedDeviceExplainsCloudStopAndKeepsLocalUse() {
        continueAfterFailure = false
        // No fake state: on Simulator App Attest is unsupported, as on a real
        // unsupported device. The screen must not attempt a cloud request.
        let app = launch("light")
        XCTAssertFalse(app.buttons["settings.contact"].exists)
        XCTAssertFalse(app.buttons["settings.supportId"].exists)

        app.buttons["settings.aiUsage"].tap()
        XCTAssertTrue(app.staticTexts["settings-page-ai-title"].waitForExistence(timeout: 5))
        waitForLabel(app.staticTexts["usage-summary"], contains: "AI機能を利用できません")
        waitForLabel(app.staticTexts["usage-summary"], contains: "家計簿の閲覧や編集")
        assertNoAccountManagementUI(app)
        capture(app, "unsupported-light")

        app.buttons["settings.back"].tap()
        XCTAssertTrue(app.buttons["settings.aiUsage"].waitForExistence(timeout: 5))
        app.buttons["home-tab"].tap()
        XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor func testUsageAndSupportIdCopyWithoutAccountUI() {
        continueAfterFailure = false

        let guestApp = launch("light", authState: "guest")
        XCTAssertFalse(guestApp.buttons["settings.contact"].exists)
        XCTAssertFalse(guestApp.buttons["settings.supportId"].exists)
        let guestRow = guestApp.buttons["settings.aiUsage"]
        waitForLabel(guestRow, contains: "今日 2/5回")
        guestRow.tap()
        XCTAssertTrue(guestApp.staticTexts["settings-page-ai-title"].waitForExistence(timeout: 5))
        waitForLabel(guestApp.staticTexts["usage-summary"], contains: "今日のAI読み取り 2 / 5回 · 登録なし")
        assertNoAccountManagementUI(guestApp)
        guestApp.terminate()

        let dailyApp = launch("light", authState: "signedInDaily", supportId: "km-sup-test-001")
        XCTAssertFalse(dailyApp.buttons["settings.contact"].exists)
        let supportRow = dailyApp.buttons["settings.supportId"]
        for _ in 0..<4 where !supportRow.isHittable { dailyApp.swipeUp() }
        XCTAssertTrue(supportRow.waitForExistence(timeout: 5))
        waitForLabel(supportRow, contains: "サポートID")
        waitForLabel(supportRow, contains: "km-sup-test-001")
        waitForLabel(supportRow, contains: "コピー")
        supportRow.tap()
        waitForLabel(supportRow, contains: "コピーしました")

        let usageRow = dailyApp.buttons["settings.aiUsage"]
        for _ in 0..<4 where !usageRow.isHittable { dailyApp.swipeDown() }
        XCTAssertTrue(usageRow.waitForExistence(timeout: 5))
        usageRow.tap()
        XCTAssertTrue(dailyApp.staticTexts["settings-page-ai-title"].waitForExistence(timeout: 5))
        waitForLabel(dailyApp.staticTexts["usage-summary"], contains: "今日のAI読み取り 2 / 5回 · Free")
        assertNoAccountManagementUI(dailyApp)
        dailyApp.terminate()
    }

    @MainActor func testGuestUsageScreenshotInDark() {
        continueAfterFailure = false
        let app = launch("dark", authState: "guest")
        app.buttons["settings.aiUsage"].tap()
        XCTAssertTrue(app.staticTexts["settings-page-ai-title"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["usage-summary"].waitForExistence(timeout: 5))
        waitForLabel(app.staticTexts["usage-summary"], contains: "今日のAI読み取り 2 / 5回 · 登録なし")
        assertNoAccountManagementUI(app)
        capture(app, "guest-dark")
        app.terminate()
    }
}

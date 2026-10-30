import XCTest

final class ContactFlowTests: XCTestCase {
    @MainActor func testContactInitialScreenshotsInLightAndDark() {
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
            app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
            app.launch()

            XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
            app.buttons["settings-tab"].tap()
            XCTAssertTrue(app.buttons["settings.contact"].waitForExistence(timeout: 5))
            app.buttons["settings.contact"].tap()
            let title = app.staticTexts["contact-title"]
            XCTAssertTrue(title.waitForExistence(timeout: 5))
            if !title.isHittable { app.swipeDown() }
            XCTAssertTrue(title.isHittable)
            XCTAssertTrue(app.buttons["contact-diagnostics-optin"].exists)
            XCTAssertFalse(app.buttons["contact-record"].exists)

            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = "contact-initial-\(appearance)"
            attachment.lifetime = .keepAlways
            add(attachment)
            app.terminate()
        }
    }

    @MainActor func testSettingsContactSubmitShowsFailureAndKeepsDraft() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        app.launch()

        XCTAssertTrue(app.buttons["settings-tab"].waitForExistence(timeout: 10))
        app.buttons["settings-tab"].tap()
        XCTAssertTrue(app.buttons["settings.contact"].waitForExistence(timeout: 5))
        app.buttons["settings.contact"].tap()
        let contactScreen = app.descendants(matching: .any).matching(identifier: "contact.screen").firstMatch
        XCTAssertTrue(contactScreen.waitForExistence(timeout: 5))

        let send = app.buttons["contact-send"]
        XCTAssertTrue(send.exists)
        XCTAssertFalse(send.isEnabled)
        app.buttons["contact-kind"].tap()
        XCTAssertTrue(app.buttons["不具合"].waitForExistence(timeout: 5))
        app.buttons["不具合"].tap()

        let message = app.textViews["contact-message"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        message.tap()
        message.typeText("問い合わせ画面の送信失敗を確認します")
        XCTAssertTrue(send.isEnabled)
        let diagnostics = app.buttons["contact-diagnostics-optin"]
        XCTAssertTrue(diagnostics.exists)
        XCTAssertEqual(diagnostics.value as? String, "オフ")
        diagnostics.tap()
        XCTAssertEqual(diagnostics.value as? String, "オン")
        send.tap()

        let submissionFinished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: send)
        XCTAssertEqual(XCTWaiter.wait(for: [submissionFinished], timeout: 60), .completed)
        let status = app.staticTexts["contact-status"]
        XCTAssertTrue(status.exists)
        let failurePhrases = ["送信できませんでした", "ログインが必要", "確認できませんでした", "利用できません", "送信が多いため", "短時間に利用"]
        XCTAssertTrue(failurePhrases.contains { status.label.contains($0) }, status.label)
        XCTAssertEqual(message.value as? String, "問い合わせ画面の送信失敗を確認します")

        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "contact-submit-failure-light"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.terminate()
    }
}

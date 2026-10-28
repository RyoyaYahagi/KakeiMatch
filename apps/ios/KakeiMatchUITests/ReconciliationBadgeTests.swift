import XCTest

final class ReconciliationBadgeTests: XCTestCase {
    @MainActor
    func testReconciliationBadgeCountAccessibilityAndEmptyState() {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP", "-UITestFixture", "reconciliation"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        app.launch()

        let badgeTab = app.buttons["reconciliation-tab"]
        XCTAssertTrue(badgeTab.waitForExistence(timeout: 10))
        XCTAssertEqual(badgeTab.label, "照合（確認が必要 3件）")
        let scrollView = app.scrollViews.firstMatch
        XCTAssertTrue(scrollView.exists)
        XCTAssertLessThanOrEqual(scrollView.frame.maxY, badgeTab.frame.minY, "Shell content viewport must end above the fixed bottom navigation")
        let light = XCTAttachment(screenshot: app.screenshot())
        light.name = "shell-review-badge-light"
        light.lifetime = .keepAlways
        add(light)
        app.terminate()
        app.launchArguments = ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP", "-UITestFixture", "reconciliation"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "dark"
        app.launch()
        XCTAssertTrue(app.buttons["reconciliation-tab"].waitForExistence(timeout: 10))
        let dark = XCTAttachment(screenshot: app.screenshot())
        dark.name = "shell-review-badge-dark"
        dark.lifetime = .keepAlways
        add(dark)

        app.terminate()
        app.launchArguments = ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP", "-UITestFixture", "empty"]
        app.launch()
        let emptyTab = app.buttons["reconciliation-tab"]
        XCTAssertTrue(emptyTab.waitForExistence(timeout: 10))
        XCTAssertEqual(emptyTab.label, "照合")
        XCTAssertFalse(app.staticTexts["3"].exists)
    }
}

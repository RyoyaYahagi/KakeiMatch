import XCTest

final class HomeBottomInsetTests: XCTestCase {
    @MainActor
    func testHomeLastRecordClearsBottomNavigationInBothAppearances() {
        continueAfterFailure = false
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["-UITestFixture", "migration", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]
            app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
            app.launch()

            let home = app.otherElements["home.screen"]
            XCTAssertTrue(home.waitForExistence(timeout: 10))
            let lastRecord = app.descendants(matching: .any)
                .matching(identifier: "home.recent.row.fixture-transaction-008").firstMatch
            XCTAssertTrue(lastRecord.waitForExistence(timeout: 5))
            app.scrollViews.firstMatch.swipeUp()
            XCTAssertTrue(lastRecord.isHittable)
            let bottomGap = app.buttons["home-tab"].frame.minY - lastRecord.frame.maxY
            XCTAssertGreaterThanOrEqual(bottomGap, 0)
            XCTAssertLessThanOrEqual(bottomGap, 48, "本文末尾に余分な安全領域が二重加算されないこと")
            capture(app, "home-bottom-\(appearance)")
            app.terminate()
        }
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

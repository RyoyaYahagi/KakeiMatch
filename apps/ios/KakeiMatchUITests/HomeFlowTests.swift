import XCTest

final class HomeFlowTests: XCTestCase {
    @MainActor
    func testHomeReferenceStatesInLightAndDark() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        let states = [
            (fixture: "populated", name: "populated"),
            (fixture: "empty", name: "empty"),
            (fixture: "reconciliation", name: "attention"),
            (fixture: "budget-warning", name: "budget-warning"),
        ]
        var launched = false
        for appearance in ["light", "dark"] {
            for state in states {
                if launched { app.terminate() }
                app.launchArguments = ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP", "-UITestFixture", state.fixture]
                app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = appearance
                app.launch()
                launched = true
                XCTAssertTrue(app.otherElements["home.screen"].waitForExistence(timeout: 10), state.fixture)
                XCTAssertTrue(app.descendants(matching: .any)["home.monthly.expense"].waitForExistence(timeout: 10))
                if state.fixture == "reconciliation" {
                    XCTAssertTrue(app.staticTexts["確認すること"].waitForExistence(timeout: 5))
                }
                let attachment = XCTAttachment(screenshot: app.screenshot())
                attachment.name = "home-\(state.name)-\(appearance)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    @MainActor
    func testAttentionOpensReconciliation() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP", "-UITestFixture", "reconciliation"]
        app.launchEnvironment["KM_UI_TEST_APPEARANCE"] = "light"
        app.launch()
        XCTAssertTrue(app.buttons["home.attention.open"].waitForExistence(timeout: 10))
        app.buttons["home.attention.open"].tap()
        XCTAssertTrue(app.otherElements["reconciliation.screen"].waitForExistence(timeout: 5))
    }
}

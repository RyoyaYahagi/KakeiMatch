import Testing
@testable import KakeiMatch

struct ContactPresentationTests {
    @Test func validatesRequiredKindAndNonBlankMessageLikePWA() {
        #expect(KMContactPresentation.validation(kind: nil, message: "内容") == .kindRequired)
        #expect(KMContactPresentation.validation(kind: .question, message: " \n\t") == .messageRequired)
        #expect(KMContactPresentation.validation(kind: .bug, message: "表示が崩れます") == .valid)
    }

    @Test func countsUTF16UnitsAndEnforcesPWA4000CharacterLimit() {
        #expect(KMContactPresentation.messageLength("a") == 1)
        #expect(KMContactPresentation.messageLength("😀") == 2)
        #expect(KMContactPresentation.validation(kind: .question, message: String(repeating: "あ", count: 4_000)) == .valid)
        #expect(KMContactPresentation.validation(kind: .question, message: String(repeating: "😀", count: 2_001)) == .tooLong)
        #expect(KMContactPresentation.messageLength(KMContactPresentation.limitedMessage(String(repeating: "😀", count: 2_001))) == 4_000)
    }

    @Test func diagnosticsOnlyRetainAllowlistedNonContactEvents() {
        let result = KMContactPresentation.diagnostics(
            currentScreen: .settings,
            isOnline: false,
            events: [
                .init(secondsAgo: 4, screen: .settings, kind: .screenOpen),
                .init(secondsAgo: 3, screen: .contact, kind: .screenOpen),
                .init(secondsAgo: 2, screen: .settings, kind: .action("open_contact")),
                .init(secondsAgo: 1, screen: .records, kind: .error("storage")),
                .init(secondsAgo: 0, screen: .records, kind: .error("private-user-input")),
            ]
        )

        #expect(result.version == 1)
        #expect(result.currentScreen == "settings")
        #expect(result.network == "offline")
        #expect(result.events.count == 3)
        #expect(result.events[0].secondsAgo == 4)
        #expect(result.events[2].errorCode == "storage")
        #expect(!String(describing: result).contains("private-user-input"))
    }

    @Test func diagnosticsClampFutureEventsDiscardStaleEventsAndLimitNewestTwenty() {
        let events = [-1, 0] + Array(2...21) + [901]
        let result = KMContactPresentation.diagnostics(
            currentScreen: .home,
            isOnline: true,
            events: events.map { age in
                KMContactPresentation.DiagnosticEvent(secondsAgo: age, screen: .home, kind: .screenOpen)
            }
        )
        #expect(result.events.count == 20)
        #expect(result.events.allSatisfy { (0...900).contains($0.secondsAgo) })
        #expect(result.events.first?.secondsAgo == 2)
        #expect(result.events.last?.secondsAgo == 21)
    }
}

import Foundation
import Testing
@testable import KakeiMatchCore

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
        #expect(result.events.count == 2)
        #expect(result.events[0].secondsAgo == 4)
        #expect(result.events[1].errorCode == "storage")
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

    @Test @MainActor func recorderMatchesPWAMemoryOnlyBoundsAndExcludesContactFlow() {
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        var current = base
        let recorder = KMContactDiagnosticRecorder(now: { current })
        for index in 0..<45 {
            current = base.addingTimeInterval(TimeInterval(index))
            recorder.recordScreen(.records)
        }
        recorder.recordAction(.openContact, screen: .settings)
        recorder.recordScreen(.contact)
        recorder.recordNetwork(false)
        current = base.addingTimeInterval(45)
        let snapshot = recorder.snapshot(now: current)

        #expect(snapshot.events.count == 20)
        #expect(!snapshot.events.contains { $0.screen == "contact" })
        #expect(!snapshot.events.contains { $0.action == "open_contact" })
        #expect(snapshot.currentScreen == "records")
        #expect(snapshot.network == "offline")
        #expect(snapshot.events.allSatisfy { (0...900).contains($0.secondsAgo) })
        // Seconds are wall-clock seconds, not milliseconds divided by 1000.
        #expect(snapshot.events.first?.secondsAgo == 19)
        #expect(snapshot.events.last?.secondsAgo == 1)
    }

    @Test @MainActor func recorderDropsEventsOlderThanFifteenMinutesAndMapsUnknownErrors() {
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        var current = base
        let recorder = KMContactDiagnosticRecorder(now: { current })
        recorder.recordScreen(.home)
        recorder.recordError("private-user-input", screen: .home)
        let early = recorder.snapshot(now: current)
        #expect(early.events.count == 2)
        #expect(early.events.last?.errorCode == "operation_failed")
        current = base.addingTimeInterval(901)
        let snapshot = recorder.snapshot(now: current)
        #expect(snapshot.events.isEmpty)
    }

    @Test @MainActor func recorderSnapshotIncludesOnlyWorkerSchemaKeys() throws {
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        var current = base
        let recorder = KMContactDiagnosticRecorder(now: { current })
        recorder.recordScreen(.home)
        current = current.addingTimeInterval(1)
        recorder.recordAction(.receiptAIStarted, screen: .records)
        current = current.addingTimeInterval(1)
        recorder.recordError("storage", screen: .records)
        current = current.addingTimeInterval(1)
        recorder.recordNetwork(true)
        let snapshot = recorder.snapshot(now: current)
        #expect(KMContactPresentation.isValidForWorker(snapshot))

        let object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any])
        #expect(Set(object.keys) == ["version", "currentScreen", "network", "events"])
        let events = try #require(object["events"] as? [[String: Any]])
        #expect(events.count == 4)
        #expect(Set(events[0].keys) == ["type", "secondsAgo", "screen"])
        #expect(Set(events[1].keys) == ["type", "secondsAgo", "screen", "action"])
        #expect(Set(events[2].keys) == ["type", "secondsAgo", "screen", "errorCode"])
        #expect(Set(events[3].keys) == ["type", "secondsAgo", "online"])
        #expect(events.allSatisfy { $0["secondsAgo"] as? Int != nil })
    }

    @Test func rejectsDiagnosticsThatDoNotMatchTheWorkerShape() {
        let valid = KMContactDiagnosticContext(version: 1, currentScreen: "settings", network: "online", events: [
            .init(type: "screen_open", secondsAgo: 2, screen: "home"),
        ])
        #expect(KMContactPresentation.isValidForWorker(valid))
        #expect(!KMContactPresentation.isValidForWorker(.init(
            version: 1, currentScreen: "private-screen", network: "online", events: []
        )))
        #expect(!KMContactPresentation.isValidForWorker(.init(
            version: 1, currentScreen: "home", network: "online", events: [.init(type: "screen_open", secondsAgo: 2)]
        )))
        #expect(!KMContactPresentation.isValidForWorker(.init(
            version: 1, currentScreen: "home", network: "online", events: [.init(type: "action", secondsAgo: 2, screen: "home", action: "free_text")]
        )))
        #expect(!KMContactPresentation.isValidForWorker(.init(
            version: 1, currentScreen: "home", network: "online", events: [.init(type: "error", secondsAgo: 2, screen: "home", errorCode: "private")]
        )))
    }

    @Test func contactFailureMessagesSeparateLoginConfigurationAndSimulatorCauses() {
        #expect(KMContactPresentation.failureMessage(forCode: "unauthorized").contains("ログインが必要"))
        #expect(KMContactPresentation.failureMessage(forCode: "not_configured").contains("現在利用できません"))
        #expect(KMContactPresentation.failureMessage(forCode: "native_authentication_unavailable").contains("この端末では"))
        #expect(KMContactPresentation.failureMessage(forCode: "rate_limited").contains("短時間"))
        #expect(KMContactPresentation.failureMessage(forCode: "invalid_ai_response").contains("回答を確認できませんでした"))
        #expect(KMContactPresentation.failureMessage(forCode: "operation_failed").contains("送信できませんでした"))
    }
}

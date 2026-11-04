import Foundation
import Testing
@testable import KakeiMatch

struct AppInformationTests {
    @Test @MainActor func clearingDiagnosticsPreservesScreenAndNetwork() {
        let recorder = KMContactDiagnosticRecorder(now: { Date(timeIntervalSince1970: 1_800_000_000) })
        recorder.recordScreen(.settings)
        recorder.recordNetwork(false)
        #expect(!recorder.snapshot().events.isEmpty)
        recorder.clear()
        let snapshot = recorder.snapshot()
        #expect(snapshot.events.isEmpty)
        #expect(snapshot.currentScreen == "settings")
        #expect(snapshot.network == "offline")
    }

    @Test func licenseResourcesAreBundled() throws {
        for resource in ["ActualLicense", "ThirdPartyLicenses"] {
            let url = try #require(Bundle.main.url(forResource: resource, withExtension: "txt"))
            let text = try String(contentsOf: url, encoding: .utf8)
            #expect(text.contains("MIT License"))
            #expect(text.contains("Permission is hereby granted"))
        }
    }
}

import Foundation
import Testing
@testable import KakeiMatch

struct AppInformationTests {
    @Test @MainActor func aiConsentMustBeAcceptedBeforeActionAndPersistsOnDevice() throws {
        let suiteName = "KMNativeAIConsentTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(true, forKey: "km.nativeAIConsent.v1")
        let consent = KMNativeAIConsent(defaults: defaults)
        var actionCount = 0

        consent.request { actionCount += 1 }
        #expect(consent.isPresented)
        #expect(actionCount == 0)
        #expect(!consent.hasConsented)
        consent.decline()
        #expect(actionCount == 0)
        #expect(!consent.hasConsented)

        consent.request { actionCount += 1 }
        consent.accept()
        #expect(actionCount == 1)
        #expect(consent.hasConsented)
        #expect(defaults.integer(forKey: KMNativeAIConsent.preferenceKey) == KMNativeAIConsent.disclosureVersion)
        #expect(!consent.isPresented)

        let restored = KMNativeAIConsent(defaults: defaults)
        restored.request { actionCount += 1 }
        #expect(actionCount == 2)
        #expect(!restored.isPresented)
    }

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

    /// The camera sheet is OS-provided UI inside this bundle. It follows the
    /// app development region, so "Use Photo" only becomes "写真を使用" when
    /// the bundle declares Japanese.
    @Test func systemProvidedCameraUsesJapanese() {
        #expect(Bundle.main.object(forInfoDictionaryKey: "CFBundleDevelopmentRegion") as? String == "ja")
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

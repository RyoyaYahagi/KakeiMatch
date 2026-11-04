import Foundation
import Testing
@testable import KakeiMatchCore

/// Settings written before the app-lock removal can still contain lock keys. `KMAppSettings`
/// ignores unknown keys, so an upgraded device must open the household instead of failing to
/// decode its stored settings.
struct SettingsMigrationTests {
    @Test func legacyScreenLockKeysInStoredSettingsAreIgnored() throws {
        let data = Data(#"""
        {"theme":"dark","lastExportAt":"2026-10-14T03:30:00.000Z","screenLockEnabled":true,"screenLockBiometric":true,"screenLockSecret":"synthetic-only"}
        """#.utf8)
        let settings = try KMJSON.decoder().decode(KMAppSettings.self, from: data)
        #expect(settings.theme == .dark)
        #expect(settings.lastExportAt == ISO8601DateFormatter().date(from: "2026-10-14T03:30:00Z"))
    }

    @Test func lockOnlySettingsFallBackToTheThemeAlreadyStored() throws {
        let data = Data(#"{"theme":"light","screenLock":{"enabled":true,"biometric":true}}"#.utf8)
        let settings = try KMJSON.decoder().decode(KMAppSettings.self, from: data)
        #expect(settings.theme == .light)
        #expect(settings.lastExportAt == nil)
    }
}

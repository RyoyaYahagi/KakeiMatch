import Foundation

// TS: apps/pwa/src/theme-settings.ts / apps/pwa/index.html kakeimatch-theme.
enum KMThemePreference: String, Codable, CaseIterable, Sendable { case system, light, dark }

// TS: apps/pwa/src/theme-settings.ts and src/lib/local-backup-format.ts settings:backup (separate stores in PWA).
/// Device appearance is not household backup/sync data. No Cloud credentials here.
struct KMAppSettings: Codable, Equatable, Sendable {
    var theme: KMThemePreference = .system
    var lastExportAt: Date? = nil
    /// Off (the default) keeps automatic matching unchanged. On limits automatic matches to pairs whose payment sources agree.
    var requireSamePaymentSourceForAutoMatch = false
}

extension KMAppSettings {
    /// Settings stored before the reconciliation option existed have no key for it; they keep the default.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        theme = try container.decode(KMThemePreference.self, forKey: .theme)
        lastExportAt = try container.decodeIfPresent(Date.self, forKey: .lastExportAt)
        requireSamePaymentSourceForAutoMatch = try container.decodeIfPresent(Bool.self, forKey: .requireSamePaymentSourceForAutoMatch) ?? false
    }
}

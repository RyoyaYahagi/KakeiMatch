import Foundation

// TS: apps/pwa/src/theme-settings.ts / apps/pwa/index.html kakeimatch-theme.
enum KMThemePreference: String, Codable, CaseIterable, Sendable { case system, light, dark }

// TS: apps/pwa/src/theme-settings.ts and src/lib/local-backup-format.ts settings:backup (separate stores in PWA).
/// Device appearance is not household backup/sync data. No Cloud credentials or screen-lock secrets here.
struct KMAppSettings: Codable, Equatable, Sendable {
    var theme: KMThemePreference = .system
    var lastExportAt: Date? = nil
}

import Foundation
import Observation

@MainActor @Observable
final class KMSettingsModel {
    private(set) var settings = KMAppSettings()
    private(set) var loaded = false
    var error: String?
    private var repository: (any SettingsRepository)?

    func load(_ repositories: KMRepositories?) async {
        guard let repositories else {
            error = "設定を読み込めませんでした。アプリを開き直してください。"
            loaded = true
            return
        }
        repository = repositories.settings
        do {
            settings = try await repositories.settings.settings()
            UserDefaults.standard.set(settings.theme.rawValue, forKey: KMSettingsPresentation.themePreferenceKey)
            error = nil
        } catch {
            self.error = "設定を読み込めませんでした。\(error.localizedDescription)"
        }
        loaded = true
    }

    func setTheme(_ theme: KMThemePreference) async {
        guard settings.theme != theme else { return }
        let previous = settings
        settings.theme = theme
        error = nil
        guard let repository else {
            settings = previous
            error = "設定を保存できませんでした。アプリを開き直してください。"
            return
        }
        do {
            var latest = try await repository.settings()
            latest.theme = theme
            try await repository.saveSettings(latest)
            settings = latest
            UserDefaults.standard.set(theme.rawValue, forKey: KMSettingsPresentation.themePreferenceKey)
        } catch {
            settings = previous
            self.error = "外観を保存できませんでした。\(error.localizedDescription)"
        }
    }

}

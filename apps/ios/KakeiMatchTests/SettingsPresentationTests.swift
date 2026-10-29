import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct SettingsModelTests {
    @Test func themeSelectionPersistsToRepositoryAndAppPreference() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let model = KMSettingsModel()
        let key = KMSettingsPresentation.themePreferenceKey
        let previousValue = UserDefaults.standard.object(forKey: key)
        defer {
            if let previousValue { UserDefaults.standard.set(previousValue, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        }

        await model.load(repositories)
        #expect(model.loaded)
        await model.setTheme(.dark)

        #expect(try await repositories.settings.settings().theme == .dark)
        #expect(UserDefaults.standard.string(forKey: key) == KMThemePreference.dark.rawValue)
        #expect(model.settings.theme == .dark)
        #expect(model.error == nil)
    }
}

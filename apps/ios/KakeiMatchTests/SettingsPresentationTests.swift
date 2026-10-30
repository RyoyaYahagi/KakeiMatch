import Foundation
import Testing
@testable import KakeiMatch

struct MasterPresentationTests {
    @Test func accountBalancesFollowPwaLabelsAndGroupingOrder() {
        #expect(KMMasterPresentation.accountBalanceLabel(type: .creditCard, balanceYen: -3_284) == "差引未払額 ¥3,284")
        #expect(KMMasterPresentation.accountBalanceLabel(type: .creditCard, balanceYen: 0) == "差引預り額 ¥0")
        #expect(KMMasterPresentation.accountDetailBalanceLabel(type: .bank, balanceYen: 2_500) == "+¥2,500")
        #expect(KMMasterPresentation.accountTypeOrder == [.creditCard, .bank, .cash, .other])
    }
}

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

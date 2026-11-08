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

struct DriveSyncSettingsRowTests {
    @Test func rowSitsAfterMuseExportAndShowsTheToggleState() {
        let off = KMSettingsPresentation.sections(theme: .system)
        let dataRows = off[1].rows
        #expect(dataRows.map(\.title) == [
            "バックアップと復元", "AIアシスタント向けの書き出し", "Google Driveへの自動保存",
            "原本の整理・全削除",
        ])
        #expect(dataRows[2].destination == .driveSync)
        #expect(dataRows[2].value == "オフ")

        let on = KMSettingsPresentation.sections(
            theme: .system, driveSyncValue: KMSettingsPresentation.driveSyncValue(isEnabled: true))
        #expect(on[1].rows[2].value == "オン")
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

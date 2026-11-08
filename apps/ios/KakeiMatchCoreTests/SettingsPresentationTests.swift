import Foundation
import Testing
@testable import KakeiMatchCore

struct SettingsPresentationTests {
    @Test func settingRowsKeepPWAOrderAndExcludeDeviceSync() {
        let sections = KMSettingsPresentation.sections(theme: .system)
        #expect(sections.map(\.title) == ["家計簿", "データ", "写真の読み取り", "アプリ"])
        #expect(sections.map { $0.rows.map(\.title) } == [
            ["分類ルール", "カテゴリ", "支払元", "予算設定", "定期登録"],
            ["バックアップと復元", "AIアシスタント向けの書き出し", "Google Driveへの自動保存", "原本の整理・全削除"],
            ["ログイン・利用状況"],
            ["外観", "お問い合わせ", "アプリ情報"],
        ])
        #expect(!sections.flatMap(\.rows).contains { $0.title.contains("同期") })
        #expect(sections[1].rows[0].value == nil)
        #expect(sections[1].rows[1].destination == .museExport)
        #expect(!sections[1].rows[1].isDestructive)
        #expect(sections[1].rows[2].destination == .driveSync)
        #expect(sections[1].rows[2].value == "オフ")
        #expect(!sections[1].rows[2].isDestructive)
        #expect(sections[1].rows[3].isDestructive)
        #expect(sections[3].rows[0].value == "システム")
        #expect(sections[3].rows[1].destination == .contact)
        #expect(sections[3].rows[2].destination == .appInfo)
        #expect(sections[2].rows[0].destination == .ai)
        #expect(sections[2].rows[0].value == nil)
        #expect(sections[3].rows[1].value == nil)
    }

    @Test func driveSyncRowReflectsTheStoredToggle() {
        let enabled = KMSettingsPresentation.sections(
            theme: .system, driveSyncValue: KMSettingsPresentation.driveSyncValue(isEnabled: true))
        #expect(enabled[1].rows[2].id == "settings.driveSync")
        #expect(enabled[1].rows[2].title == "Google Driveへの自動保存")
        #expect(enabled[1].rows[2].value == "オン")
        #expect(enabled[1].rows[2].destination == .driveSync)

        let disabled = KMSettingsPresentation.sections(theme: .system)
        #expect(disabled[1].rows[2].value == "オフ")
    }

    @Test func themeLabelsMatchPWAStateMeaning() {
        #expect(KMSettingsPresentation.themeLabel(.light) == "ライト")
        #expect(KMSettingsPresentation.themeLabel(.dark) == "ダーク")
        #expect(KMSettingsPresentation.themeLabel(.system) == "システム")
    }

    @Test func backupReminderMatchesPWAThirtyDayBoundary() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(KMSettingsPresentation.shouldRemindBackup(lastExportAt: nil, now: now))
        #expect(!KMSettingsPresentation.shouldRemindBackup(
            lastExportAt: now.addingTimeInterval(-KMSettingsPresentation.backupReminderAge + 1), now: now))
        #expect(KMSettingsPresentation.shouldRemindBackup(
            lastExportAt: now.addingTimeInterval(-KMSettingsPresentation.backupReminderAge), now: now))
        #expect(!KMSettingsPresentation.shouldRemindBackup(lastExportAt: now.addingTimeInterval(1), now: now))
        #expect(KMSettingsPresentation.shouldRemindBackup(
            lastExportAt: Date(timeIntervalSince1970: .nan), now: now))
    }
}

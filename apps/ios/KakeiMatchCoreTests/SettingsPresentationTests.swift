import Foundation
import Testing
@testable import KakeiMatchCore

struct SettingsPresentationTests {
    @Test func settingRowsKeepPWAOrderAndExcludeDeviceSync() {
        let sections = KMSettingsPresentation.sections(theme: .system, screenLockEnabled: false)
        #expect(sections.map(\.title) == ["家計簿", "データ", "写真の読み取り", "アプリ"])
        #expect(sections.map { $0.rows.map(\.title) } == [
            ["分類ルール", "カテゴリ", "支払元", "予算設定", "定期登録"],
            ["バックアップと復元", "画面ロック", "原本の整理・全削除"],
            ["ログイン・利用状況"],
            ["外観", "お問い合わせ", "アプリ情報"],
        ])
        #expect(!sections.flatMap(\.rows).contains { $0.title.contains("同期") })
        #expect(sections[1].rows[1].value == "オフ")
        #expect(sections[3].rows[0].value == "システム")
        #expect(sections[1].rows[2].isDestructive)
        #expect(sections[3].rows[1].destination == .contact)
        #expect(sections[2].rows[0].destination == .ai)
        #expect(sections[2].rows[0].value == nil)
    }

    @Test func themeAndScreenLockLabelsMatchPWAStateMeaning() {
        #expect(KMSettingsPresentation.themeLabel(.light) == "ライト")
        #expect(KMSettingsPresentation.themeLabel(.dark) == "ダーク")
        #expect(KMSettingsPresentation.themeLabel(.system) == "システム")
        #expect(KMSettingsPresentation.screenLockLabel(isEnabled: true) == "オン")
        #expect(KMSettingsPresentation.screenLockLabel(isEnabled: false) == "オフ")
        #expect(KMSettingsPresentation.screenLockStatus(isEnabled: false) == "無効です。設定や復旧で家計データは削除されません。")
        #expect(KMSettingsPresentation.screenLockStatus(isEnabled: true).contains("Face IDまたはパスコード"))
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

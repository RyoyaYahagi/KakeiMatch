import Foundation

struct KMSettingsRow: Identifiable, Equatable {
    enum Destination: Equatable {
        case unimplemented
        case theme
        case screenLock
        case budget
        case recurring
        case contact
        case categoryRules
        case categories
        case accounts
        case backup
    }

    let id: String
    let title: String
    var value: String? = nil
    var isDestructive = false
    var destination: Destination = .unimplemented
}

struct KMSettingsSection: Identifiable, Equatable {
    let title: String
    let rows: [KMSettingsRow]
    var id: String { title }
}

/// PWA settings labels, ordering, and display conditions without view or storage access.
enum KMSettingsPresentation {
    static let themePreferenceKey = KMAppSettingsPreferences.themePreferenceKey
    static let screenLockEnabledKey = KMAppSettingsPreferences.screenLockEnabledKey
    static let screenLockRequestNotificationName = KMAppSettingsPreferences.screenLockRequestNotificationName
    static let backupReminderAge: TimeInterval = 30 * 24 * 60 * 60

    static let backupReminder = "△ 復旧に備えてバックアップを書き出してください。目安は最終書き出しから30日です。"
    static let settingsFooter = "家計簿と画像はこの端末に保存されます。ログアウトしても消えません。"

    static func themeLabel(_ preference: KMThemePreference) -> String {
        switch preference {
        case .light: "ライト"
        case .dark: "ダーク"
        case .system: "システム"
        }
    }

    static func screenLockLabel(isEnabled: Bool) -> String { isEnabled ? "オン" : "オフ" }

    static func screenLockStatus(isEnabled: Bool) -> String {
        isEnabled
            ? "有効です。解除にはこの端末のFace IDまたはパスコードを使います。設定はこの端末だけに保存されています。"
            : "無効です。設定や復旧で家計データは削除されません。"
    }

    /// Mirrors shouldRemindLocalExport: missing/invalid timestamps remind; future timestamps do not.
    static func shouldRemindBackup(lastExportAt: Date?, now: Date) -> Bool {
        guard let lastExportAt else { return true }
        let exported = lastExportAt.timeIntervalSince1970
        let current = now.timeIntervalSince1970
        guard exported.isFinite, current.isFinite else { return true }
        guard exported <= current else { return false }
        return current - exported >= backupReminderAge
    }

    static func sections(theme: KMThemePreference, screenLockEnabled: Bool) -> [KMSettingsSection] {
        [
            KMSettingsSection(title: "家計簿", rows: [
                .init(id: "settings.categoryRules", title: "分類ルール", destination: .categoryRules),
                .init(id: "settings.categories", title: "カテゴリ", destination: .categories),
                .init(id: "settings.accounts", title: "支払元", destination: .accounts),
                .init(id: "settings.budget", title: "予算設定", destination: .budget),
                .init(id: "settings.recurring", title: "定期登録", destination: .recurring),
            ]),
            KMSettingsSection(title: "データ", rows: [
                .init(id: "settings.backup", title: "バックアップと復元", destination: .backup),
                .init(id: "settings.screenLock", title: "画面ロック", value: screenLockLabel(isEnabled: screenLockEnabled), destination: .screenLock),
                .init(id: "settings.cleanup", title: "原本の整理・全削除", isDestructive: true),
            ]),
            KMSettingsSection(title: "写真の読み取り", rows: [
                .init(id: "settings.aiUsage", title: "ログイン・利用状況"),
            ]),
            KMSettingsSection(title: "アプリ", rows: [
                .init(id: "settings.theme", title: "外観", value: themeLabel(theme), destination: .theme),
                .init(id: "settings.contact", title: "お問い合わせ", destination: .contact),
                .init(id: "settings.appInfo", title: "アプリ情報", value: "診断・ライセンス"),
            ]),
        ]
    }
}

enum KMMasterPresentation {
    static let accountTypeOrder: [KMAccountType] = [.creditCard, .bank, .cash, .other]

    static func accountBalanceLabel(type: KMAccountType, balanceYen: Int) -> String {
        let amount = "¥\(abs(balanceYen).formatted())"
        if type == .creditCard { return balanceYen < 0 ? "差引未払額 \(amount)" : "差引預り額 \(amount)" }
        return "\(balanceYen < 0 ? "−" : "")\(amount)"
    }

    static func accountDetailBalanceLabel(type: KMAccountType, balanceYen: Int) -> String {
        if type == .creditCard { return accountBalanceLabel(type: type, balanceYen: balanceYen) }
        if balanceYen == 0 { return "¥0" }
        return "\(balanceYen < 0 ? "−" : "+")¥\(abs(balanceYen).formatted())"
    }
}

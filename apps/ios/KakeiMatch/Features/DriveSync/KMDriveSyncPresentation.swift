import Foundation

/// Japanese copy and display rules for the Google Drive auto-save page. No
/// technical names (OAuth, drive.file, API) appear in user-facing strings.
enum KMDriveSyncPresentation {
    static let title = "Google Driveへの自動保存"
    static let description = "アプリを開いたときに、残高・取引（店名とメモを含みます）・月ごとのカテゴリ別支出（今月と前の2か月）を、自分のGoogle Driveの「KakeiMatch」フォルダへ保存します。"
    static let sensitiveNotice = "ファイルは暗号化されません。自分だけが見られる場所に保存し、他人と共有しないでください。"
    static let readOnlyNotice = "このアプリが作ったファイルだけを対象にします。Google Driveのほかのファイルは見ません。保存したファイルをこのアプリへ読み込むことはありません。"

    static let autoSaveTitle = "自動保存"
    static let accountHeading = "連携中のアカウント"
    static let signIn = "サインイン"
    static let signOut = "サインアウト"
    static let sendNow = "今すぐ保存"
    static let sending = "保存しています…"
    static let noAccount = "まだGoogle アカウントと連携していません。"

    static let notSignedIn = "Google Driveと連携していません。"
    static let missingScope = "Google Driveへの保存が許可されていません。サインアウトしてから、連携し直してください。"
    static let signInFailure = "Google アカウントにサインインできませんでした。もう一度お試しください。"
    static let storeUnavailable = "家計データを開けませんでした。アプリを開き直してください。"
    static let genericFailure = "Google Driveへ保存できませんでした。もう一度お試しください。"

    /// The settings root shows the same meaning as the switch.
    static func rowValue(isEnabled: Bool) -> String { isEnabled ? "オン" : "オフ" }

    /// `最後に保存: 2026年11月9日 10:15` in Asia/Tokyo, matching the app's clock.
    static func lastSent(at date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: KMMuseSnapshotFormat.timeZone)
        formatter.dateFormat = "yyyy年M月d日 HH:mm"
        return "最後に保存: \(formatter.string(from: date))"
    }

    /// One line for the status area; the view prefixes failures with `!` and
    /// colors them with `KMColor.danger`, so color is not the only signal.
    static func status(lastSentAt: Date?, isSyncing: Bool, failure: String?) -> String? {
        if isSyncing { return sending }
        if let failure { return "! \(failure)" }
        if let lastSentAt { return lastSent(at: lastSentAt) }
        return nil
    }

    /// Keeps the Drive error in Japanese. A non-Japanese diagnostic (for example
    /// a URLSession message) is replaced instead of being shown to the user.
    static func failureMessage(_ error: Error) -> String {
        let message = error.localizedDescription
        return message.range(of: "[ぁ-んァ-ヶ一-龠]", options: .regularExpression) != nil
            ? message
            : genericFailure
    }
}

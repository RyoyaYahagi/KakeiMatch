import Foundation

/// PWA `settings-page-ai` copy and display rules without API or View dependencies.
///
/// The values are derived from `apps/pwa/src/main.ts` (`refreshAccount`,
/// `renderUsage`, `issueAiToken`, login/logout handlers). Native-only wording
/// replaces the browser's Turnstile sentence with the App Attest equivalent.
enum KMNativeAuthPresentation {
    static let pageTitle = "ログイン・利用状況"
    static let accountHeading = "AIアカウント"
    static let signedOutStatus = "未ログインです。"
    static let unavailableStatus = "AIアカウントへ接続できません。家計簿のデータはこの端末で引き続き利用できます。"
    static let unsupportedDetail = "この端末ではクラウドのログインとAI機能を利用できません。家計簿の閲覧や編集はこの端末で引き続き利用できます。"
    static let notConfiguredDetail = "AI機能を現在利用できません。家計簿の閲覧や編集はこの端末で引き続き利用できます。"
    static let usageLoading = "利用状況を読み込んでいます…"
    static let usageUnavailable = "利用状況を取得できません。オンラインで再度お試しください。"
    static let guestUsageUnavailable = "今日の利用回数を取得できません。オンラインで再度お試しください。"
    static let signedOutFreeUsage = "ログインしなくても、AIの読み取りを1日5回まで使えます。"
    static let signedOutRowValue = "1日5回まで"
    static let signedOutLead = "ログインしなくても、AIを1日5回まで使えます。初めて使う時だけ、この端末が正規のアプリかを確かめます。サーバーに記録するのはAIの利用回数だけで、家計データは保存しません。家計簿の閲覧や編集はこの端末で引き続き利用できます。"
    static let usageExplanation = "レシートの読み取りとカテゴリ提案で1回です。読み取り直すと新たに1回使います。お問い合わせのAI機能は回数に数えません。ログインしていない時は1日5回までで、毎日午前0時（日本時間）に戻ります。ログイン中はプランの回数で、毎月1日の午前0時に戻ります。"
    static let loginInProgress = "Passkeyを確認しています…"
    static let loginFailed = "ログインできませんでした。登録済みのPasskeyを確認してください。"
    static let registerInProgress = "Passkeyを登録しています…"
    static let registerFailed = "登録できませんでした。招待コードの有効期限を確認してください。"
    static let invitePrompt = "招待コードを入力してください。"
    static let tokenInProgress = "AI機能を準備しています…"
    static let tokenFailed = "AI機能を準備できませんでした。家計簿の利用は続けられます。"
    static let tokenReady = "AI利用の認証を確認しました。"
    static let sessionExpired = "セッションが切れました。Passkeyで再度ログインしてください。"
    static let passkeyListFailed = "Passkey一覧を取得できません。"
    static let passkeyAdded = "Passkeyを追加しました。"
    static let passkeyAddFailed = "Passkeyを追加できませんでした。"
    static let passkeyDeleteFailed = "Passkeyを削除できませんでした。"
    static let passkeyEmpty = "登録済みのPasskeyはありません。"
    static let logoutDone = "ログアウトしました。端末の家計簿データは保持されています。"
    static let logoutFailed = "ログアウトできませんでした。"
    static let logoutNote = "ログアウトしても、この端末の家計簿はそのまま使えます。"
    static let accountDeleteNote = "Cloud accountを削除しても、家計簿・レシート・明細・照合記録はこの端末に残り、閲覧やバックアップを続けられます。端末内データの全削除は別の操作です。"
    static let accountDeleteConfirm = "Cloud accountを削除します。Passkey、ログイン状態、AI利用情報も削除され、元に戻せません。\n\nこの端末の家計簿・レシート・明細・照合記録は残ります。"
    static let accountDeleteTyping = "アカウントを削除"
    static let accountDeletePrompt = "確認のため「アカウントを削除」と入力してください。"
    static let accountDeleteInProgress = "アカウントを削除しています…"
    static let accountDeleteDone = "家計簿・レシート・明細・照合記録はこの端末に残っています。引き続き利用できます。"
    static let accountDeleteSessionExpired = "ログイン状態を確認できません。ページを再読み込みしてください。"
    static let accountDeleteFailed = "削除を完了できませんでした。オンライン状態を確認して、もう一度お試しください。"
    static let accountDeletedUsage = "アカウントを削除しました。"
    static let guestStartTitle = "確認しています"
    /// PWA `guest-ai.ts` bot-check lead. Native replaces Turnstile with App Attest,
    /// so only the reason for the check differs; the dialog shape stays the same.
    static let guestStartMessage = "登録なしでAIを使う前に、この端末が正規のアプリかを確かめます。多くの場合は数秒で自動的に終わります。"
    static let guestStartProgress = "確認しています…"
    static let guestStartCancel = "やめる"
    static let guestStartCancelled = "写真は残っています。手で入力するか、もう一度読み取れます。"

    static func accountStatus(isSignedIn: Bool, name: String?) -> String {
        guard isSignedIn else { return signedOutStatus }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "ログイン中" : "ログイン中：\(trimmed)"
    }

    static func planName(_ plan: String) -> String {
        switch plan {
        case "family": "Plus"
        case "pro": "Pro"
        default: "Free"
        }
    }

    /// `main.ts` renderUsage. Guest usage has no month and always has a limit.
    static func usageSummary(plan: String, used: Int, limit: Int?) -> String {
        if plan == "guest" {
            return "今日のAI読み取り \(used) / \(limit ?? 0)回 · 登録なし"
        }
        let name = planName(plan)
        guard let limit else { return "今月の読み取り \(used)回 · \(name) · 上限なし" }
        return "今月の読み取り \(used) / \(limit)回 · \(name)"
    }

    /// `#ai-row-value` next to the settings entry.
    static func settingsRowValue(plan: String, used: Int, limit: Int?) -> String {
        if plan == "guest" { return "今日 \(used)/\(limit ?? 0)回" }
        guard let limit else { return "今月 \(used)回" }
        return "今月 \(used)/\(limit)回"
    }

    /// 0...1 for the PWA `.usage-meter`; nil hides the bar, as `meter.hidden` does.
    static func usageFraction(plan: String, used: Int, limit: Int?) -> Double? {
        guard let limit, limit > 0 else { return nil }
        return min(1, max(0, Double(used) / Double(limit)))
    }

    static func invitationIsValid(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= 4096
    }

    static func deletionConfirmationMatches(_ value: String) -> Bool {
        value == accountDeleteTyping
    }
}

import Foundation

/// AI usage copy and display rules without API or View dependencies.
///
/// Account management UI (Passkey login/registration/list/deletion, sign-out,
/// account deletion) has been removed for the accountless migration.
enum KMNativeAuthPresentation {
    static let pageTitle = "利用状況"
    static let unavailableStatus = "AI機能へ接続できません。家計簿のデータはこの端末で引き続き利用できます。"
    static let unsupportedDetail = "この端末ではAI機能を利用できません。家計簿の閲覧や編集はこの端末で引き続き利用できます。"
    static let notConfiguredDetail = "AI機能を現在利用できません。家計簿の閲覧や編集はこの端末で引き続き利用できます。"
    static let usageLoading = "利用状況を読み込んでいます…"
    static let usageUnavailable = "利用状況を取得できません。オンラインで再度お試しください。"
    static let guestUsageUnavailable = "今日の利用回数を取得できません。オンラインで再度お試しください。"
    static let signedOutFreeUsage = "AIの読み取りを1日5回まで使えます。"
    static let signedOutRowValue = "1日5回まで"
    static let usageLead = "初めてAIを使う時だけ、この端末が正規のアプリかを確かめます。サーバーに記録するのはAIの利用回数だけで、家計データは保存しません。家計簿の閲覧や編集はこの端末で引き続き利用できます。"
    static let usageExplanation = "レシートの読み取りとカテゴリ提案で1回です。読み取り直すと新たに1回使います。通常は1日5回までで、毎日午前0時（日本時間）に戻ります。プランがあるときは、プランの回数で、毎月1日の午前0時に戻ります。"
    static let guestStartTitle = "確認しています"
    /// PWA `guest-ai.ts` bot-check lead. Native replaces Turnstile with App Attest,
    /// so only the reason for the check differs; the dialog shape stays the same.
    static let guestStartMessage = "AIを使う前に、この端末が正規のアプリかを確かめます。多くの場合は数秒で自動的に終わります。"
    static let guestStartProgress = "確認しています…"
    static let guestStartCancel = "やめる"
    static let guestStartCancelled = "写真は残っています。手で入力するか、もう一度読み取れます。"

    static func planName(_ plan: String) -> String {
        switch plan {
        case "family": "Plus"
        case "pro": "Pro"
        default: "Free"
        }
    }

    /// `main.ts` renderUsage. Guest usage and the account daily cap have no month.
    static func usageSummary(plan: String, period: String = "month", used: Int, limit: Int?) -> String {
        if plan == "guest" {
            return "今日のAI読み取り \(used) / \(limit ?? 0)回 · 登録なし"
        }
        let name = planName(plan)
        if period == "day" {
            guard let limit else { return "今日のAI読み取り \(used)回 · \(name) · 上限なし" }
            return "今日のAI読み取り \(used) / \(limit)回 · \(name)"
        }
        guard let limit else { return "今月の読み取り \(used)回 · \(name) · 上限なし" }
        return "今月の読み取り \(used) / \(limit)回 · \(name)"
    }

    /// `#ai-row-value` next to the settings entry.
    static func settingsRowValue(plan: String, period: String = "month", used: Int, limit: Int?) -> String {
        if plan == "guest" { return "今日 \(used)/\(limit ?? 0)回" }
        if period == "day" {
            guard let limit else { return "今日 \(used)回" }
            return "今日 \(used)/\(limit)回"
        }
        guard let limit else { return "今月 \(used)回" }
        return "今月 \(used)/\(limit)回"
    }

    /// 0...1 for the PWA `.usage-meter`; nil hides the bar, as `meter.hidden` does.
    static func usageFraction(plan: String, used: Int, limit: Int?) -> Double? {
        guard let limit, limit > 0 else { return nil }
        return min(1, max(0, Double(used) / Double(limit)))
    }
}

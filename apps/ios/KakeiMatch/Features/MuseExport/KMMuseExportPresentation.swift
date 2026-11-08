import Foundation

/// Copy, month limits, and file naming for the Muse snapshot export screen. The screen is an
/// iOS-only addition (docs/MUSE_SNAPSHOT.md); it follows the settings pages and BackupView.
enum KMMuseExportPresentation {
    static let title = "AIアシスタント向けの書き出し"
    static let description = "残高、取引（店名とメモを含みます）、月ごとのカテゴリ別支出を、1つのファイルにまとめて書き出します。"
    static let sensitiveNotice = "ファイルは暗号化されません。自分のGoogle Driveなど、自分だけが見られる場所に保存し、他人と共有しないでください。"
    static let readOnlyNotice = "書き出したファイルをこのアプリへ読み込むことはありません。家計データは変わりません。"
    static let periodTitle = "期間"
    static let fromLabel = "開始月"
    static let toLabel = "終了月"
    static let periodNote = "終了月は今月まで、期間は60か月まで選べます。"
    static let exportButton = "書き出す"
    static let shareButton = "保存・共有"
    static let shareTitle = "AIアシスタント向けの書き出し"
    static let exported = "書き出しました。「保存・共有」から保存先を選んでください。"
    static let notSaved = "生成したファイルは、まだ保存されていません。"
    static let processing = "書き出しています。この画面を閉じずにお待ちください。"
    static let storeUnavailable = "家計データを開けませんでした。アプリを開き直してください。"

    static let reversedRange = "開始月は終了月以前にしてください。"
    static let longRange = "期間は60か月以内で選んでください。"
    static let futureMonth = "終了月は今月より後を選べません。"

    /// Two months before the current Asia/Tokyo month through the current month (3 months).
    static func defaultRange(today: Date) -> (from: KMYearMonth, to: KMYearMonth) {
        let current = KMDate(instant: today).yearMonth
        return (current.shifted(by: -2), current)
    }

    /// The picker never offers a month after today, so the future check is a guard as well.
    static func monthOptions(currentMonth: KMYearMonth) -> [KMYearMonth] {
        (0..<60).reversed().map { currentMonth.shifted(by: -$0) }
    }

    static func monthLabel(_ month: KMYearMonth) -> String {
        "\(month.year)年\(month.month)月"
    }

    static func rangeSummary(from: KMYearMonth, to: KMYearMonth) -> String {
        let months = max(monthCount(from: from, to: to), 0)
        return "\(monthLabel(from))〜\(monthLabel(to))（\(months)か月）"
    }

    static func validationMessage(from: KMYearMonth, to: KMYearMonth, currentMonth: KMYearMonth) -> String? {
        if to > currentMonth { return futureMonth }
        guard from <= to else { return reversedRange }
        if monthCount(from: from, to: to) > 60 { return longRange }
        return nil
    }

    /// Asia/Tokyo clock time, e.g. `kakeimatch-snapshot-20261108-090000.json`.
    static func fileName(now: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: KMMuseSnapshotFormat.timeZone)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "kakeimatch-snapshot-\(formatter.string(from: now)).json"
    }

    static let exportDirectory = FileManager.default.temporaryDirectory
        .appendingPathComponent("KakeiMatchMuseExport", isDirectory: true)

    /// `CFBundleShortVersionString` and `CFBundleVersion`, or nil when either is missing.
    static func appVersion(bundle: Bundle = .main) -> String? {
        appVersion(
            shortVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
    }

    static func appVersion(shortVersion: String?, build: String?) -> String? {
        guard let shortVersion, let build, !shortVersion.isEmpty, !build.isEmpty else { return nil }
        return "\(shortVersion) (\(build))"
    }

    static func failure(_ error: Error) -> String {
        let message = error.localizedDescription
        return message.range(of: "[ぁ-んァ-ヶ一-龠]", options: .regularExpression) != nil
            ? message
            : "書き出しに失敗しました。もう一度お試しください。"
    }

    private static func monthCount(from: KMYearMonth, to: KMYearMonth) -> Int {
        (to.year * 12 + to.month) - (from.year * 12 + from.month) + 1
    }
}

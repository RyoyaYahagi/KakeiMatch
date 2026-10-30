import Foundation

/// PWA backup/restore copy, ordering, and date formatting without view or storage access.
/// Screens the iOS-only `.kmib` backup in place of the PWA `.kmb` export; the PWA file can
/// still be imported here. See apps/pwa/src/local-backup-ui.ts.
enum KMBackupPresentation {
    static let title = "バックアップと復元"
    static let exportButton = "バックアップを書き出す"
    static let restoreButton = "復元する"
    static let previousButton = "変更前のデータに戻す"
    static let aboutSummary = "バックアップについて"
    static let shareButton = "保存・共有"
    static let noExport = "まだバックアップを書き出していません。"
    static let processing = "処理しています。この画面を閉じずにお待ちください。"
    static let exported = "バックアップを生成しました。Filesなどへの保存を確認してください。"
    static let exportNotSaved = "生成したファイルは、まだ保存されていません。"
    static let restored = "バックアップを復元しました。"
    static let previousRestored = "変更前のデータに戻しました。"
    static let storeUnavailable = "端末の保存領域を開けませんでした。アプリを開き直してください。"

    /// Empty-state copy and the exact PWA format: toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).
    static let exportedContent = "書き出す内容：家計簿の取引・支払元・カテゴリ、レシートの確認値と解析情報、明細の取込情報と取引行、照合結果と判断・再試行状態、店舗の対応・端末設定、残っている画像とCSV原本。削除済みの原本は含まれません。アカウント・ログイン情報・AI利用量・支払情報は含みません。"
    static let formatNotice = "iOS用バックアップは暗号化されていない .kmib ファイルです。Filesなどへ保存し、他人に渡さないでください。生成日時は保存完了を保証しません。"
    static let iosOnlyNotice = "iOS用バックアップは、iOSのKakeiMatchでのみ復元できます。PWA（ブラウザー版）へは取り込めません。PWAのバックアップ（.kmb）は、この画面から取り込めます。"
    static let restoreNotice = "読み込みは新しい家計データとして復元します。現在のデータと合併しません。復元に成功した後に切り替え、元のデータも端末に残します。ほかのタブでの家計操作を終えてから実行してください。"
    static let restoreFormats = "復元できるファイルは、iOS用バックアップ（.kmib）とPWAのバックアップ（.kmb）です。壊れたファイルや未対応の形式は取り込まず、現在の家計データも変更しません。"
    static let storageTitle = "保存先"
    static let storageDevice = "この端末"
    static let storageDescription = "家計簿・レシート・明細・照合結果は、この端末に保存されています。"
    static let storageCloud = "家計データはCloudflareに保存しません。AIアカウントの認証や利用枠の情報はCloudflareで管理します。AIを利用する場合だけ、処理に必要な情報をAIサービスへ送信します。"
    static let storageRisk = "端末の紛失やアプリの削除で、家計データが失われることがあります。バックアップを別の場所に保存してください。"

    static let restoreConfirm = "バックアップを新しい保存先へ復元し、成功後に切り替えますか？元の家計データは端末に残ります。"
    static let previousConfirm = "変更前のデータに戻しますか？現在のデータも端末に残ります。"

    static func lastExportText(_ date: Date?) -> String {
        guard let date else { return noExport }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "yyyy/M/d H:mm:ss"
        return "最終書き出し生成日時：\(formatter.string(from: date))（日本時間）"
    }

    /// PWA: `KakeiMatch-${new Date().toISOString().replace(/[:.]/g, '-')}.kmb`.
    static func exportFileName(now: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss-SSS'Z'"
        return "KakeiMatch-\(formatter.string(from: now)).kmib"
    }

    static func exportFailure(_ error: Error) -> String {
        userFacingFailure(error)
    }

    static func restoreFailure(_ error: Error) -> String {
        userFacingFailure(error)
    }

    static func previousFailure(_ error: Error) -> String {
        userFacingFailure(error)
    }

    static func importFailure(_ error: Error) -> String {
        userFacingFailure(error)
    }

    /// Matches the PWA's rule: show Japanese domain errors, but hide low-level system errors.
    private static func userFacingFailure(_ error: Error) -> String {
        let message = error.localizedDescription
        return message.range(of: "[ぁ-んァ-ヶ一-龠]", options: .regularExpression) != nil
            ? message
            : "処理に失敗しました。元のデータを確認してください。"
    }
}

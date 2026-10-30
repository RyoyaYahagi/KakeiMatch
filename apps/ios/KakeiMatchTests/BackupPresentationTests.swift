import Foundation
import Testing
@testable import KakeiMatch

struct BackupPresentationTests {
    private func instant(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return try #require(formatter.date(from: value))
    }

    @Test func lastExportUsesJapanTimeAndMatchesPWAFormat() throws {
        let date = try instant("2026-10-14T03:04:05Z")
        #expect(KMBackupPresentation.lastExportText(date) == "最終書き出し生成日時：2026/10/14 12:04:05（日本時間）")
    }

    @Test func missingLastExportUsesPWAEmptyState() {
        #expect(KMBackupPresentation.lastExportText(nil) == "まだバックアップを書き出していません。")
    }

    @Test func exportFileNameUsesUTCStampAndKMIBExtension() throws {
        let date = try instant("2026-10-14T03:04:05.123Z")
        #expect(KMBackupPresentation.exportFileName(now: date) == "KakeiMatch-2026-10-14T03-04-05-123Z.kmib")
    }

    @Test func confirmationsKeepPWASentences() {
        #expect(KMBackupPresentation.restoreConfirm == "バックアップを新しい保存先へ復元し、成功後に切り替えますか？元の家計データは端末に残ります。")
        #expect(KMBackupPresentation.previousConfirm == "変更前のデータに戻しますか？現在のデータも端末に残ります。")
    }

    @Test func failuresHideLowLevelMessagesAndPreserveJapaneseDomainErrors() {
        let systemError = NSError(domain: "SQLite", code: 19,
            userInfo: [NSLocalizedDescriptionKey: "constraint failed"])
        #expect(KMBackupPresentation.restoreFailure(systemError) == "処理に失敗しました。元のデータを確認してください。")

        let domainError = NSError(domain: "KakeiMatch", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "復元した記録の読み戻しに失敗しました。"])
        #expect(KMBackupPresentation.restoreFailure(domainError) == "復元した記録の読み戻しに失敗しました。")
    }
}

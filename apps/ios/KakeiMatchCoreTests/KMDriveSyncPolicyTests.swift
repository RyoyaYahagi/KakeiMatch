import Foundation
import Testing
@testable import KakeiMatchCore

struct KMDriveSyncPolicyTests {
    @Test func everyConditionMustHold() {
        #expect(KMDriveSyncPolicy.shouldUpload(
            isEnabled: true, isSignedIn: true, hasScope: true,
            fingerprint: "new", lastUploadedFingerprint: "old"))
        #expect(!KMDriveSyncPolicy.shouldUpload(
            isEnabled: false, isSignedIn: true, hasScope: true,
            fingerprint: "new", lastUploadedFingerprint: "old"))
        #expect(!KMDriveSyncPolicy.shouldUpload(
            isEnabled: true, isSignedIn: false, hasScope: true,
            fingerprint: "new", lastUploadedFingerprint: "old"))
        #expect(!KMDriveSyncPolicy.shouldUpload(
            isEnabled: true, isSignedIn: true, hasScope: false,
            fingerprint: "new", lastUploadedFingerprint: "old"))
        #expect(!KMDriveSyncPolicy.shouldUpload(
            isEnabled: true, isSignedIn: true, hasScope: true,
            fingerprint: "same", lastUploadedFingerprint: "same"))
        #expect(KMDriveSyncPolicy.shouldUpload(
            isEnabled: true, isSignedIn: true, hasScope: true,
            fingerprint: "first", lastUploadedFingerprint: nil))
    }
}

struct KMDriveSnapshotFingerprintTests {
    private func snapshot(generatedAt: String, transactionID: String = "tx-1") -> KMMuseSnapshot {
        KMMuseSnapshot(
            generatedAt: generatedAt,
            appVersion: "0.1.0 (1)",
            range: KMMuseSnapshotRange(fromMonth: "2026-09", toMonth: "2026-11"),
            accounts: [
                KMMuseSnapshotAccount(id: "acc-1", name: "合成銀行", type: "bank",
                                      closed: false, offBudget: false, balanceYen: 10_000),
            ],
            transactions: [
                KMMuseSnapshotTransaction(
                    id: transactionID, date: "2026-10-05", amountYen: -1280, kind: "expense",
                    accountId: "acc-1", categoryId: "cat-food", categoryName: "食費",
                    payeeName: "合成ベーカリー", memo: "合成メモ", transferAccountId: nil,
                    excludedFromSpending: false, splits: []),
            ],
            monthly: [
                KMMuseSnapshotMonthly(month: "2026-10", incomeYen: 0, expenseYen: 1280,
                                      balanceYen: -1280, byCategory: [
                                        KMMuseSnapshotCategory(categoryId: "cat-food",
                                                               categoryName: "食費", amountYen: 1280),
                                      ]),
            ])
    }

    @Test func generatedAtDoesNotChangeTheFingerprint() throws {
        let first = try KMDriveSnapshotFingerprint.compute(snapshot(generatedAt: "2026-11-09T10:15:00+09:00"))
        let second = try KMDriveSnapshotFingerprint.compute(snapshot(generatedAt: "2026-11-10T18:00:00+09:00"))
        #expect(first == second)
        #expect(first.count == 64)
        #expect(first.allSatisfy { $0.isHexDigit })
    }

    @Test func changingATransactionChangesTheFingerprint() throws {
        let first = try KMDriveSnapshotFingerprint.compute(snapshot(generatedAt: "", transactionID: "tx-1"))
        let second = try KMDriveSnapshotFingerprint.compute(snapshot(generatedAt: "", transactionID: "tx-2"))
        #expect(first != second)
    }
}

struct KMDriveSyncPreferencesTests {
    private func defaults() throws -> (UserDefaults, String) {
        let name = "KMDriveSyncPreferencesTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        return (defaults, name)
    }

    @Test func defaultsToOffAndUsesPrefixedKeys() throws {
        let (defaults, name) = try defaults()
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = KMDriveSyncPreferences(defaults: defaults)

        #expect(!preferences.isEnabled)
        #expect(preferences.lastSentAt == nil)
        #expect(preferences.lastFingerprint == nil)
        #expect(KMDriveSyncPreferences.enabledKey == "kakeimatch.driveSync.enabled")
        #expect(KMDriveSyncPreferences.lastSentAtKey == "kakeimatch.driveSync.lastSentAt")
        #expect(KMDriveSyncPreferences.lastFingerprintKey == "kakeimatch.driveSync.lastFingerprint")
        #expect(defaults.object(forKey: KMDriveSyncPreferences.enabledKey) == nil)
    }

    @Test func storesAndClearsTheLastUpload() throws {
        let (defaults, name) = try defaults()
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = KMDriveSyncPreferences(defaults: defaults)
        let sentAt = Date(timeIntervalSince1970: 1_800_000_000)

        preferences.isEnabled = true
        preferences.lastSentAt = sentAt
        preferences.lastFingerprint = "abc123"

        let reopened = KMDriveSyncPreferences(defaults: defaults)
        #expect(reopened.isEnabled)
        #expect(reopened.lastSentAt == sentAt)
        #expect(reopened.lastFingerprint == "abc123")

        reopened.lastSentAt = nil
        reopened.lastFingerprint = nil
        #expect(reopened.lastSentAt == nil)
        #expect(reopened.lastFingerprint == nil)
    }
}

struct KMDriveSyncPresentationTests {
    @Test func statusShowsSendingFailureOrLastSent() throws {
        let sentAt = try #require(ISO8601DateFormatter().date(from: "2026-11-09T01:15:00Z"))
        #expect(KMDriveSyncPresentation.status(lastSentAt: sentAt, isSyncing: true, failure: "失敗")
            == "保存しています…")
        #expect(KMDriveSyncPresentation.status(lastSentAt: sentAt, isSyncing: false, failure: "失敗")
            == "! 失敗")
        #expect(KMDriveSyncPresentation.status(lastSentAt: sentAt, isSyncing: false, failure: nil)
            == "最後に保存: 2026年11月9日 10:15")
        #expect(KMDriveSyncPresentation.status(lastSentAt: nil, isSyncing: false, failure: nil) == nil)
    }

    @Test func rowValueMatchesTheSwitchMeaning() {
        #expect(KMDriveSyncPresentation.rowValue(isEnabled: true) == "オン")
        #expect(KMDriveSyncPresentation.rowValue(isEnabled: false) == "オフ")
        #expect(KMDriveSyncPresentation.sensitiveNotice.contains("暗号化されません"))
        #expect(KMDriveSyncPresentation.readOnlyNotice.contains("読み込むことはありません"))
        #expect(!KMDriveSyncPresentation.description.contains("API"))
        #expect(!KMDriveSyncPresentation.description.contains("OAuth"))
    }

    @Test func failureMessagesStayJapanese() {
        #expect(KMDriveSyncPresentation.failureMessage(
            KMDriveUploadError.server(status: 503, message: "backend unavailable"))
            .contains("503"))
        #expect(KMDriveSyncPresentation.failureMessage(
            NSError(domain: "test", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "The network connection was lost."]))
            == KMDriveSyncPresentation.genericFailure)
        #expect(KMDriveSyncPresentation.failureMessage(
            KMDriveUploadError.network(URLError(.timedOut)))
            .contains("通信状態"))
    }
}

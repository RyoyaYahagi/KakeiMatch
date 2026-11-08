import Foundation
import Testing
@testable import KakeiMatch

/// Bundled synthetic fixtures and repository doubles shared by the Muse snapshot suites.
enum MuseSnapshotTestFiles {
    static let appVersion = "0.1.0 (202611080000)"

    static func sample(_ name: String) throws -> Data {
        let directory = try #require(Bundle(for: MuseSnapshotBundleMarker.self).url(forResource: "muse-snapshot", withExtension: nil))
        return try Data(contentsOf: directory.appendingPathComponent(name))
    }

    static func sampleURL(_ name: String) throws -> URL {
        let directory = try #require(Bundle(for: MuseSnapshotBundleMarker.self).url(forResource: "muse-snapshot", withExtension: nil))
        return directory.appendingPathComponent(name)
    }

    static func generatedAt() throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return try #require(formatter.date(from: "2026-11-08T09:00:00+09:00"))
    }
}

private final class MuseSnapshotBundleMarker: NSObject {}

/// Delegates reads to the real in-memory store and records any write attempt.
@MainActor
final class MuseSnapshotReadOnlyStore: TransactionRepository, AccountRepository, CategoryRepository {
    enum WriteTrap: Error, Equatable { case called(String) }

    let base: KMInMemoryStore
    private(set) var writeCalls: [String] = []
    /// Lets a test hold the first ledger read so a range change can be attempted mid-export.
    var beforeTransactionRead: (() async -> Void)?

    init(base: KMInMemoryStore) { self.base = base }

    private func trap(_ name: String) -> WriteTrap {
        writeCalls.append(name)
        return .called(name)
    }

    func transactions(matching query: KMTransactionQuery) async throws -> [KMTransaction] {
        if let beforeTransactionRead { await beforeTransactionRead() }
        return try await base.transactions(matching: query)
    }
    func transaction(id: String) async throws -> KMTransaction? { try await base.transaction(id: id) }
    func recordDays(matching query: KMTransactionQuery) async throws -> [KMRecordDay] {
        try await base.recordDays(matching: query)
    }
    func home(month: KMYearMonth) async throws -> KMHomeSnapshot { try await base.home(month: month) }
    func homeDashboard(month: KMYearMonth, today: KMDate) async throws -> KMHomeDashboard {
        try await base.homeDashboard(month: month, today: today)
    }
    func saveManual(_ input: KMManualTransactionInput, id: String?) async throws -> KMTransaction {
        throw trap("saveManual")
    }
    func saveTransfer(_ input: KMTransferInput, id: String?) async throws -> KMTransaction {
        throw trap("saveTransfer")
    }
    func importExternalTransaction(_ input: KMExternalTransactionInput) async throws -> KMExternalTransactionResult {
        throw trap("importExternalTransaction")
    }
    func setSpendingExclusion(id: String, excluded: Bool) async throws { throw trap("setSpendingExclusion") }
    func deleteTransaction(id: String) async throws { throw trap("deleteTransaction") }
    func deleteTransaction(id: String, expected: [KMTransaction]?, at timestamp: Date) async throws -> KMTransactionDeletion {
        throw trap("deleteTransaction(expected:)")
    }
    func transactionDeletions() async throws -> [KMTransactionDeletion] { throw trap("transactionDeletions") }
    func undoTransactionDeletion(id: String, at timestamp: Date) async throws { throw trap("undoTransactionDeletion") }

    func accounts(includeClosed: Bool) async throws -> [KMAccount] {
        try await base.accounts(includeClosed: includeClosed)
    }
    func accounts(asOf date: KMDate, includeClosed: Bool) async throws -> [KMAccount] {
        try await base.accounts(asOf: date, includeClosed: includeClosed)
    }
    func createAccount(_ account: KMAccount, startingBalanceYen: Int, startingDate: KMDate) async throws {
        throw trap("createAccount")
    }
    func saveAccount(_ account: KMAccount) async throws { throw trap("saveAccount") }
    func deleteAccount(id: String) async throws { throw trap("deleteAccount") }

    func categories(includeHidden: Bool) async throws -> [KMCategory] {
        try await base.categories(includeHidden: includeHidden)
    }
    func categoryGroups() async throws -> [KMCategoryGroup] { try await base.categoryGroups() }
    func saveCategory(_ category: KMCategory) async throws { throw trap("saveCategory") }
    func deleteCategory(id: String) async throws { throw trap("deleteCategory") }
    func saveCategoryGroup(_ group: KMCategoryGroup) async throws { throw trap("saveCategoryGroup") }
    func deleteCategoryGroup(id: String) async throws { throw trap("deleteCategoryGroup") }
    func reorderCategoryGroups(ids: [String]) async throws { throw trap("reorderCategoryGroups") }
    func reorderCategories(groupId: String, ids: [String]) async throws { throw trap("reorderCategories") }
}

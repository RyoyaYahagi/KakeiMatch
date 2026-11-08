import Foundation
import Testing
@testable import KakeiMatch

@MainActor
struct MuseSnapshotBuilderTests {
    @Test func normalSampleMatchesAssembledSnapshot() async throws {
        let snapshot = try await MuseSnapshotFixture.builder().build(
            fromMonth: try KMYearMonth("2026-09"), toMonth: try KMYearMonth("2026-10"),
            generatedAt: try MuseSnapshotFixture.generatedAt(), appVersion: MuseSnapshotFixture.appVersion)
        let actual = try MuseSnapshotFixture.normalized(try snapshot.jsonData())
        let expected = try MuseSnapshotFixture.normalized(try MuseSnapshotFixture.sample("snapshot-sample-normal.json"))
        #expect(actual == expected)
    }

    @Test func emptySampleMatchesAssembledSnapshot() async throws {
        let store = KMInMemoryStore()
        let builder = KMMuseSnapshotBuilder(transactions: store, accounts: store, categories: store)
        let snapshot = try await builder.build(
            fromMonth: try KMYearMonth("2026-11"), toMonth: try KMYearMonth("2026-11"),
            generatedAt: try MuseSnapshotFixture.generatedAt(), appVersion: MuseSnapshotFixture.appVersion)
        let actual = try MuseSnapshotFixture.normalized(try snapshot.jsonData())
        let expected = try MuseSnapshotFixture.normalized(try MuseSnapshotFixture.sample("snapshot-sample-empty.json"))
        #expect(actual == expected)
    }

    @Test func optionalValuesAreWrittenAsNullAndPlainTransactionsHaveEmptySplits() async throws {
        let snapshot = try await MuseSnapshotFixture.builder().build(
            fromMonth: try KMYearMonth("2026-09"), toMonth: try KMYearMonth("2026-10"),
            generatedAt: try MuseSnapshotFixture.generatedAt(), appVersion: nil)
        let json = try MuseSnapshotFixture.object(try snapshot.jsonData())
        #expect(MuseSnapshotFixture.isNull(json["appVersion"]))

        let transactions = try #require(json["transactions"] as? [[String: Any]])
        let plain = try #require(transactions.first { $0["id"] as? String == "tx-1006" })
        #expect(MuseSnapshotFixture.isNull(plain["categoryId"]))
        #expect(MuseSnapshotFixture.isNull(plain["categoryName"]))
        #expect(plain["payeeName"] as? String == "合成コンビニ")
        #expect(MuseSnapshotFixture.isNull(plain["memo"]))
        #expect(MuseSnapshotFixture.isNull(plain["transferAccountId"]))
        let plainSplits = try #require(plain["splits"] as? [Any])
        #expect(plainSplits.isEmpty)

        let split = try #require(transactions.first { $0["id"] as? String == "tx-1001" })
        #expect(MuseSnapshotFixture.isNull(split["categoryId"]))
        #expect(MuseSnapshotFixture.isNull(split["categoryName"]))
        let splitRows = try #require(split["splits"] as? [[String: Any]])
        let firstSplit = try #require(splitRows.first)
        #expect(MuseSnapshotFixture.isNull(firstSplit["payeeName"]))
        #expect(MuseSnapshotFixture.isNull(firstSplit["memo"]))
        let lastSplit = try #require(splitRows.last)
        #expect(lastSplit["memo"] as? String == "洗剤")
    }

    @Test func rejectsReversedRange() async throws {
        let builder = MuseSnapshotFixture.builder()
        await #expect(throws: KMDataError.self) {
            try await builder.build(fromMonth: try KMYearMonth("2026-10"), toMonth: try KMYearMonth("2026-09"),
                generatedAt: Date(timeIntervalSince1970: 0), appVersion: nil)
        }
    }

    @Test func rejectsRangesLongerThanSixtyMonths() async throws {
        let builder = MuseSnapshotFixture.builder()
        await #expect(throws: KMDataError.self) {
            try await builder.build(fromMonth: try KMYearMonth("2021-01"), toMonth: try KMYearMonth("2026-01"),
                generatedAt: Date(timeIntervalSince1970: 0), appVersion: nil)
        }
    }

    @Test func oneAndSixtyMonthBoundariesAreAccepted() async throws {
        let store = KMInMemoryStore()
        let builder = KMMuseSnapshotBuilder(transactions: store, accounts: store, categories: store)
        let one = try await builder.build(fromMonth: try KMYearMonth("2026-11"), toMonth: try KMYearMonth("2026-11"),
            generatedAt: Date(timeIntervalSince1970: 0), appVersion: nil)
        #expect(one.monthly.map(\.month) == ["2026-11"])

        let sixty = try await builder.build(fromMonth: try KMYearMonth("2021-12"), toMonth: try KMYearMonth("2026-11"),
            generatedAt: Date(timeIntervalSince1970: 0), appVersion: nil)
        #expect(sixty.monthly.count == 60)
        #expect(sixty.monthly.first?.month == "2021-12")
        #expect(sixty.monthly.last?.month == "2026-11")
    }

    @Test func builderCallsOnlyReadOperations() async throws {
        let store = MuseSnapshotFixture.store()
        let readOnly = MuseSnapshotReadOnlyStore(base: store)
        let builder = KMMuseSnapshotBuilder(transactions: readOnly, accounts: readOnly, categories: readOnly)
        _ = try await builder.build(
            fromMonth: try KMYearMonth("2026-09"), toMonth: try KMYearMonth("2026-10"),
            generatedAt: try MuseSnapshotFixture.generatedAt(), appVersion: MuseSnapshotFixture.appVersion)
        #expect(readOnly.writeCalls.isEmpty)
    }
}

@MainActor
private enum MuseSnapshotFixture {
    static let appVersion = "0.1.0 (202611080000)"

    static func builder() -> KMMuseSnapshotBuilder {
        let store = store()
        return KMMuseSnapshotBuilder(transactions: store, accounts: store, categories: store)
    }

    static func generatedAt() throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return try #require(formatter.date(from: "2026-11-08T09:00:00+09:00"))
    }

    static func sample(_ name: String) throws -> Data {
        let directory = try #require(Bundle(for: MuseSnapshotBundleMarker.self).url(forResource: "muse-snapshot", withExtension: nil))
        return try Data(contentsOf: directory.appendingPathComponent(name))
    }

    static func normalized(_ data: Data) throws -> Data {
        try JSONSerialization.data(withJSONObject: try JSONSerialization.jsonObject(with: data), options: [.sortedKeys])
    }

    static func object(_ data: Data) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    static func isNull(_ value: Any?) -> Bool {
        guard let value else { return true }
        return value is NSNull
    }

    static func store() -> KMInMemoryStore {
        KMInMemoryStore(
            transactions: [
                KMTransaction(id: "tx-1001", date: KMDate(rawValue: "2026-10-31"), amountYen: -3480, kind: .expense,
                    payeeName: "合成スーパー", accountId: "acc-card", excludedFromSpending: false, isSplit: true,
                    splits: [
                        .init(id: "tx-1001-a", categoryId: "cat-food", amountYen: -2980),
                        .init(id: "tx-1001-b", categoryId: "cat-daily", amountYen: -500, memo: "洗剤"),
                    ]),
                KMTransaction(id: "tx-1002", date: KMDate(rawValue: "2026-10-28"), amountYen: -30000, kind: .transfer,
                    payeeName: "合成カードへ振替", accountId: "acc-bank", excludedFromSpending: false,
                    transferAccountId: "acc-card", transferId: "tx-1003"),
                KMTransaction(id: "tx-1003", date: KMDate(rawValue: "2026-10-28"), amountYen: 30000, kind: .transfer,
                    payeeName: "合成銀行から振替", accountId: "acc-card", excludedFromSpending: false,
                    transferAccountId: "acc-bank", transferId: "tx-1002"),
                KMTransaction(id: "tx-1004", date: KMDate(rawValue: "2026-10-25"), amountYen: 250000, kind: .income,
                    payeeName: "合成株式会社", categoryName: "給与", accountId: "acc-bank", excludedFromSpending: false,
                    categoryId: "cat-salary", memo: "10月分"),
                KMTransaction(id: "tx-1005", date: KMDate(rawValue: "2026-10-20"), amountYen: -12000, kind: .expense,
                    payeeName: "立替分", categoryName: "日用品", accountId: "acc-bank", excludedFromSpending: true,
                    categoryId: "cat-daily", memo: "あとで精算"),
                KMTransaction(id: "tx-1006", date: KMDate(rawValue: "2026-10-12"), amountYen: -640, kind: .expense,
                    payeeName: "合成コンビニ", accountId: "acc-cash", excludedFromSpending: false),
                KMTransaction(id: "tx-1007", date: KMDate(rawValue: "2026-10-05"), amountYen: -50000, kind: .expense,
                    payeeName: "合成証券", categoryName: "日用品", accountId: "acc-invest", excludedFromSpending: false,
                    categoryId: "cat-daily"),
                KMTransaction(id: "tx-1008", date: KMDate(rawValue: "2026-10-03"), amountYen: -1280, kind: .expense,
                    payeeName: "合成ベーカリー", categoryName: "食費", accountId: "acc-card", excludedFromSpending: false,
                    categoryId: "cat-food"),
                KMTransaction(id: "tx-0901", date: KMDate(rawValue: "2026-09-27"), amountYen: -2200, kind: .expense,
                    payeeName: "合成鉄道", categoryName: "交通費", accountId: "acc-card", excludedFromSpending: false,
                    categoryId: "cat-transport"),
                KMTransaction(id: "tx-0902", date: KMDate(rawValue: "2026-09-25"), amountYen: 248000, kind: .income,
                    payeeName: "合成株式会社", categoryName: "給与", accountId: "acc-bank", excludedFromSpending: false,
                    categoryId: "cat-salary", memo: "9月分"),
                KMTransaction(id: "tx-0903", date: KMDate(rawValue: "2026-09-14"), amountYen: -4560, kind: .expense,
                    payeeName: "合成スーパー", categoryName: "食費", accountId: "acc-card", excludedFromSpending: false,
                    categoryId: "cat-food"),
                KMTransaction(id: "tx-0904", date: KMDate(rawValue: "2026-09-14"), amountYen: 300, kind: .income,
                    payeeName: "合成スーパー", categoryName: "食費", accountId: "acc-card", excludedFromSpending: false,
                    categoryId: "cat-food", memo: "返品"),
            ],
            accounts: [
                // Starting balances chosen so today's computed balances equal the sample accounts.
                KMAccount(id: "acc-bank", name: "合成銀行", accountType: .bank, balanceYen: -274000),
                KMAccount(id: "acc-card", name: "合成カード", accountType: .creditCard, balanceYen: -27020),
                KMAccount(id: "acc-cash", name: "財布", accountType: .cash, balanceYen: 4000),
                KMAccount(id: "acc-invest", name: "合成証券", accountType: .other, balanceYen: 500000, offbudget: true),
                KMAccount(id: "acc-old", name: "旧口座", closed: true, accountType: .bank, balanceYen: 0),
            ],
            categories: [
                KMCategory(id: "cat-food", name: "食費"),
                KMCategory(id: "cat-daily", name: "日用品"),
                KMCategory(id: "cat-transport", name: "交通費"),
                KMCategory(id: "cat-salary", name: "給与", isIncome: true),
            ])
    }
}

private final class MuseSnapshotBundleMarker: NSObject {}

/// Delegates reads to the real in-memory store and records any write attempt.
@MainActor
private final class MuseSnapshotReadOnlyStore: TransactionRepository, AccountRepository, CategoryRepository {
    enum WriteTrap: Error, Equatable { case called(String) }

    let base: KMInMemoryStore
    private(set) var writeCalls: [String] = []

    init(base: KMInMemoryStore) { self.base = base }

    private func trap(_ name: String) -> WriteTrap {
        writeCalls.append(name)
        return .called(name)
    }

    func transactions(matching query: KMTransactionQuery) async throws -> [KMTransaction] {
        try await base.transactions(matching: query)
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

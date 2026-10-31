import Foundation
import Testing
@testable import KakeiMatch

/// Home's screen values are produced by the repository's one read, not by the View.
/// The same assertions run against in-memory and SQLite adapters.
@MainActor struct HomeDashboardTests {
    private let month = KMYearMonth(rawValue: "2026-10")
    private let today = KMDate(rawValue: "2026-10-14")
    private let timestamp = Date(timeIntervalSince1970: 1_790_000_000)

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func database(_ store: KMSQLiteStore) throws -> KMStoreDatabase {
        try KMStoreDatabase(url: store.directory.appendingPathComponent(try store.profile().current.uuidString)
            .appendingPathComponent("household.sqlite"))
    }

    private func repositories(_ memory: KMInMemoryStore, durable: Bool, directory: URL) throws -> KMRepositories {
        if !durable { return KMRepositories(inMemory: memory, referenceDate: timestamp) }
        let store = try KMSQLiteStore(directory: directory)
        try database(store).save(memory)
        return KMRepositories(persistent: store)
    }

    private func seed() throws -> KMInMemoryStore {
        let memory = KMInMemoryStore(transactions: [
            transaction("food", day: "05", amount: -400, category: "food", name: "合成スーパー"),
            transaction("daily", day: "06", amount: -300, category: "daily", name: "合成ストア"),
            transaction("comm", day: "07", amount: -200, category: "comm", name: "合成通信"),
            transaction("transport", day: "08", amount: -100, category: "transport", name: "合成交通")
        ], accounts: [.init(id: "cash", name: "合成現金")],
           categories: [.init(id: "food", name: "食費"), .init(id: "daily", name: "日用品"),
                        .init(id: "comm", name: "通信"), .init(id: "transport", name: "交通")])
        memory.monthlySettings = try memory.monthlySettings.applyingDefaultPlan(totalYen: 80_000, breakdownEnabled: false, allocations: [:])
        memory.statementValues = [
            statement("review", merchant: "合成レビュー"), statement("unmatched", merchant: "合成未登録"),
            statement("matched", merchant: "合成一致")
        ]
        memory.runValues = [.init(runId: "run", createdAt: timestamp, completedAt: timestamp, ruleVersion: "test",
            candidates: [.init(statementTransactionId: "review", receiptId: "receipt", rank: 1, score: 1,
                               amountDeltaYen: -20, dateDistanceDays: 0, merchantSimilarity: 1, reasons: [])],
            statementResults: [
                .init(statementTransactionId: "review", status: .needsReview, reasonCodes: []),
                .init(statementTransactionId: "unmatched", status: .unmatchedStatement, reasonCodes: []),
                .init(statementTransactionId: "matched", status: .matched, reasonCodes: [])
            ], receiptResults: [])]
        memory.resolutionValues = [.init(id: "resolution", runId: "run", statementId: "matched",
            resolution: .sameExpense, source: .user, statementAmountYen: 100, status: .applied,
            createdAt: timestamp, updatedAt: timestamp)]
        return memory
    }

    @Test(arguments: [false, true]) func oneReadReturnsAttentionSlicesAndDayScale(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let memory = try seed()
        let repo = try repositories(memory, durable: durable, directory: dir)

        let dashboard = try await repo.transactions.homeDashboard(month: month, today: today)

        #expect(dashboard == (try await memory.homeDashboard(month: month, today: today)))
        #expect(dashboard.snapshot == (try await repo.transactions.home(month: month)))
        #expect(dashboard.attention.count == 2)
        #expect(dashboard.attention.matchedCount == 1)
        #expect(!dashboard.attention.showsImportHint)
        #expect(dashboard.attention.items.map(\.merchant) == ["合成レビュー", "合成未登録"])
        #expect(dashboard.attention.items.map(\.reason) == ["金額が¥20違います", "記録が見つかりません"])
        #expect(dashboard.attention.items.map(\.severity) == [.warning, .missing])
        #expect(dashboard.categorySlices.map(\.name) == ["食費", "日用品", "通信", "その他"])
        #expect(dashboard.categorySlices.map(\.amountYen) == [400, 300, 200, 100])
        #expect(dashboard.categorySlices.map(\.percentage) == ["40.0%", "30.0%", "20.0%", "10.0%"])
        #expect(dashboard.categoryRows.map(\.name) == ["食費", "日用品", "通信", "交通"])
        #expect(dashboard.budgetScale.dayCount == 31)
        #expect(dashboard.budgetScale.filledDayCount == 0)
        #expect(dashboard.budgetScale.elapsedDayCount == 14)
        #expect(dashboard.budgetScale.paceDifferenceYen == -35_129)

        guard durable else { return }
        let reopened = KMRepositories(persistent: try KMSQLiteStore(directory: dir))
        #expect(try await reopened.transactions.homeDashboard(month: month, today: today) == dashboard)
    }

    @Test func migrationFixtureMatchesTheHomeScreenValues() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let dashboard = try await repositories.transactions.homeDashboard(
            month: month, today: KMDate(instant: repositories.referenceDate))
        #expect(dashboard.snapshot.summary.expenseYen == 24_730)
        #expect(dashboard.attention.showsImportHint)
        #expect(dashboard.attention.count == 0)
        #expect(dashboard.categorySlices.first?.name == "食費")
        #expect(dashboard.budgetScale.filledDayCount == 10)
        #expect(dashboard.budgetScale.elapsedDayCount == 14)
    }

    @Test func reconciliationFixtureKeepsThreeAttentionRowsAndFourMatches() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let dashboard = try await repositories.transactions.homeDashboard(
            month: month, today: KMDate(instant: repositories.referenceDate))
        #expect(dashboard.attention.count == 3)
        #expect(dashboard.attention.matchedCount == 4)
        #expect(!dashboard.attention.showsImportHint)
        #expect(dashboard.attention.items.map(\.reason) == ["金額が¥20違います", "記録が見つかりません", "記録が見つかりません"])
        #expect(dashboard.categorySlices.map(\.name) == ["食費", "水道・光熱", "通信", "その他"])
    }

    private func transaction(_ id: String, day: String, amount: Int, category: String, name: String) -> KMTransaction {
        let date = KMDate(rawValue: "2026-10-\(day)")
        return .init(id: id, date: date, amountYen: amount, kind: .expense, payeeName: name,
                     categoryName: nil, accountId: "cash", categoryId: category, importedId: "synthetic-\(id)")
    }

    private func statement(_ id: String, merchant: String) -> KMStatementTransaction {
        .init(id: id, importId: "import", provider: .paypayCard, kind: .purchase, usedDate: today,
              merchant: merchant, amountYen: 100, sourceFingerprint: id, duplicateOrdinal: 0)
    }
}

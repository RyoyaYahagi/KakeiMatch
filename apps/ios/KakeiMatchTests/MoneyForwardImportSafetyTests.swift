import Foundation
import Testing
@testable import KakeiMatch

/// 取り込みの安全性（再送で増えない・失敗時に何も残らない）だけを固定する。
/// 解析・重複判定の規則そのものは MoneyForwardParserTests / MasterWriteTests が持つ。
@MainActor struct MoneyForwardImportSafetyTests {
    private let now = ISO8601DateFormatter().date(from: "2026-10-14T03:30:00Z")!
    private let expenseKey = KMMoneyForwardParser.categoryKey(kind: .expense, major: "食費", minor: "食料品")
    private let incomeKey = KMMoneyForwardParser.categoryKey(kind: .income, major: "給与", minor: "給与")

    private func temporary() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func database(_ store: KMSQLiteStore) throws -> KMStoreDatabase {
        try KMStoreDatabase(url: store.directory.appendingPathComponent(try store.profile().current.uuidString).appendingPathComponent("household.sqlite"))
    }

    private func seed() -> KMInMemoryStore {
        KMInMemoryStore(accounts: [.init(id: "cash", name: "現金", accountType: .cash)],
            categories: [.init(id: "food", name: "食費"), .init(id: "daily", name: "日用品"), .init(id: "salary", name: "給与", isIncome: true)])
    }

    private func repository(_ memory: KMInMemoryStore, durable: Bool, directory: URL) throws -> KMRepositories {
        if !durable { return KMRepositories(inMemory: memory) }
        let store = try KMSQLiteStore(directory: directory)
        try database(store).save(memory)
        return KMRepositories(persistent: store)
    }

    private func rows() -> [KMMoneyForwardRow] {
        KMMoneyForwardParser.parse(data: Data(("日付,内容,金額（円）,大項目,中項目,ID\n" +
            "2026/10/01,合成ストア,-1000,食費,食料品,safety-expense\n" +
            "2026/10/02,合成給与,200000,給与,給与,safety-income\n").utf8), now: now).transactions
    }

    private func mappings() -> KMMoneyForwardMappings {
        .init(categories: [expenseKey: .existing(id: "food"), incomeKey: .existing(id: "salary")])
    }

    @Test(arguments: [false, true])
    func importingTheSameCSVTwiceNeverAddsTransactions(durable: Bool) async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repo = try repository(seed(), durable: durable, directory: directory)
        let rows = rows()
        #expect(rows.count == 2)

        let first = try await repo.statements.importMoneyForward(id: "safety-first", rows: rows, mappings: mappings(), choices: [:], at: now)
        #expect(first.rows.filter { $0.status == .created }.count == 2)
        let countAfterFirst = try await repo.transactions.transactions(matching: .init(limit: nil)).count
        #expect(countAfterFirst == 2)

        // A second import with a new batch ID must recognize every provider ID and add nothing.
        let second = try await repo.statements.importMoneyForward(id: "safety-second", rows: rows, mappings: mappings(), choices: [:], at: now)
        #expect(second.rows.allSatisfy { $0.status == .duplicate })
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == countAfterFirst)
        #expect(try await repo.statements.moneyForwardHistory().count == 2)
    }

    @Test(arguments: [false, true])
    func similarRowImportsOnlyWithAnExplicitSeparateChoice(durable: Bool) async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repo = try repository(seed(), durable: durable, directory: directory)
        let expense = try #require(rows().first { $0.kind == .expense })
        let existing = try await repo.transactions.saveManual(.init(
            kind: .expense, amountYen: 1000, date: expense.date, payeeName: "既存ストア",
            categoryId: "food", accountId: "cash", importedId: "safety-existing"), id: nil)

        let preview = try await repo.statements.previewMoneyForward(
            rows: [expense], mappings: mappings(), choices: [:], at: now)
        let item = try #require(preview.first)
        #expect(item.status == .review)
        #expect(item.candidates.map(\.id) == [existing.id])

        // No keep/separate decision means the whole import is refused.
        await #expect(throws: (any Error).self) {
            try await repo.statements.importMoneyForward(
                id: "safety-no-choice", rows: [expense], mappings: mappings(), choices: [:], at: now)
        }

        let separated = try await repo.statements.importMoneyForward(
            id: "safety-separate", rows: [expense], mappings: mappings(),
            choices: [item.importedId: .separate], at: now)
        #expect(separated.rows.map(\.status) == [.created])
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 2)
        #expect(try await repo.transactions.transaction(id: existing.id) != nil)
        #expect(try await repo.statements.moneyForwardHistory().count == 1)
    }

    @Test(arguments: [false, true])
    func failedImportRollsBackEveryWriteAndAcceptsTheSameBatchAgain(durable: Bool) async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repo = try repository(seed(), durable: durable, directory: directory)
        let rows = rows()
        let accountCount = try await repo.accounts.accounts(includeClosed: true).count
        let categoryCount = try await repo.categories.categories(includeHidden: true).count

        // The second row maps an income to an expense category: the first row is written inside
        // the atomic working copy, then the mismatch throws. Nothing may survive that failure.
        var invalid = mappings()
        invalid.categories[incomeKey] = .existing(id: "food")
        await #expect(throws: (any Error).self) {
            try await repo.statements.importMoneyForward(id: "safety-rollback", rows: rows, mappings: invalid, choices: [:], at: now)
        }

        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).isEmpty)
        #expect(try await repo.statements.moneyForwardHistory().isEmpty)
        #expect(try await repo.accounts.accounts(includeClosed: true).count == accountCount)
        #expect(try await repo.categories.categories(includeHidden: true).count == categoryCount)

        // Same batch ID, corrected mapping: the retry is not blocked by the failed attempt.
        let retried = try await repo.statements.importMoneyForward(id: "safety-rollback", rows: rows, mappings: mappings(), choices: [:], at: now)
        #expect(retried.rows.filter { $0.status == .created }.count == 2)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 2)
        #expect(try await repo.statements.moneyForwardHistory().count == 1)
    }

    @Test(arguments: [false, true])
    func mappingsAreRememberedOnlyWhenRequested(durable: Bool) async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repo = try repository(seed(), durable: durable, directory: directory)
        _ = try await repo.statements.importMoneyForward(
            id: "safety-no-rules", rows: rows(), mappings: mappings(), choices: [:],
            rememberMappings: false, at: now)
        #expect(try await repo.statements.moneyForwardRules().categories.isEmpty)

        _ = try await repo.statements.importMoneyForward(
            id: "safety-remember-rules", rows: rows(), mappings: mappings(), choices: [:],
            rememberMappings: true, at: now)
        #expect(try await repo.statements.moneyForwardRules().categories == mappings().categories)
    }
}

import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct ServicePersistenceTests {
    private let now = Date(timeIntervalSince1970: 1_792_000_000)
    private let day = KMDate(rawValue: "2026-10-01")
    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func seed() -> KMInMemoryStore {
        let store = KMInMemoryStore(transactions: [.init(id: "t", date: day, amountYen: -980, kind: .expense,
            payeeName: "人工ストア", accountId: "card")],
            accounts: [.init(id: "card", name: "PayPayカード", accountType: .creditCard, statementProvider: .paypayCard),
                .init(id: "cash", name: "現金", accountType: .cash)], categories: [.init(id: "food", name: "食費")])
        store.statementValues = [.init(id: "s", importId: "import", provider: .paypayCard, kind: .purchase,
            usedDate: day, merchant: "人工ストア", amountYen: 1000, sourceFingerprint: "synthetic", duplicateOrdinal: 1)]
        return store
    }
    private func install(_ memory: KMInMemoryStore, at directory: URL) throws -> KMSQLiteStore {
        let store = try KMSQLiteStore(directory: directory)
        let db = try database(store)
        _ = try db.load(); try db.save(memory)
        return store
    }
    private func database(_ store: KMSQLiteStore) throws -> KMStoreDatabase {
        try KMStoreDatabase(url: store.directory.appendingPathComponent(try store.profile().current.uuidString).appendingPathComponent("household.sqlite"))
    }
    private func repositories(_ memory: KMInMemoryStore, durable: Bool, directory: URL) throws -> KMRepositories {
        durable ? KMRepositories(persistent: try install(memory, at: directory)) : KMRepositories(inMemory: memory)
    }
    private func reopen(_ repositories: KMRepositories, durable: Bool, directory: URL) throws -> KMRepositories {
        durable ? KMRepositories(persistent: try KMSQLiteStore(directory: directory)) : repositories
    }

    @Test(arguments: [false, true]) func goldenComputedThroughBothRepositories(durable: Bool) async throws {
        struct Golden: Decodable { var run: KMReconciliationRun; var resolutions: [KMReconciliationResolution] }
        let url = try #require(Bundle.main.url(forResource: "reconciliation", withExtension: "json"))
        let golden = try KMJSON.decoder().decode(Golden.self, from: Data(contentsOf: url))
        let fixture = try KMFixtureLoader.load(named: "reconciliation")
        let memory = try #require(fixture.transactions as? KMInMemoryStore)
        memory.resolutionValues = []; memory.runValues = []; memory.reconciliationState = nil
        for i in memory.transactionValues.indices { memory.transactionValues[i].cleared = false }
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let initial = try repositories(memory, durable: durable, directory: directory)
        #expect(try await initial.reconciliation.runReconciliation(id: golden.run.runId, at: golden.run.createdAt) == golden.run)
        let after = try reopen(initial, durable: durable, directory: directory)
        #expect(try await after.reconciliation.latestRun() == golden.run)
        #expect(try await after.reconciliation.resolutions() == golden.resolutions)
    }

    @Test(arguments: [false, true]) func manualApplyUndoAndStaleRunSurviveReopen(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        var repo = try repositories(seed(), durable: durable, directory: directory)
        let run = try await repo.reconciliation.runReconciliation(id: "one", at: now)
        #expect(run.statementResults.first?.status == .needsReview)
        repo = try reopen(repo, durable: durable, directory: directory)
        let decision = try await repo.reconciliation.confirmSameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        repo = try reopen(repo, durable: durable, directory: directory)
        #expect(try await repo.transactions.transaction(id: "t")?.amountYen == -1000)
        #expect(try await repo.transactions.transaction(id: "t")?.cleared == true)
        #expect(try await repo.reconciliation.resolutions() == [decision])
        try await repo.reconciliation.undoSameExpense(id: decision.id, at: now)
        repo = try reopen(repo, durable: durable, directory: directory)
        #expect(try await repo.transactions.transaction(id: "t")?.amountYen == -980)
        #expect(try await repo.transactions.transaction(id: "t")?.cleared == false)
        #expect(try await repo.reconciliation.resolutions().isEmpty)
        await #expect(throws: KMReconciliationError("stale_run")) {
            try await repo.reconciliation.confirmSameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        }
        let rerun = try await repo.reconciliation.runReconciliation(id: "two", at: now)
        #expect(rerun.statementResults.first?.status == .needsReview)
        if let local = repo.localStore {
            let state = try #require(try database(local).load().reconciliationState)
            #expect(state.undoHistory.count == 1 && state.manualStatementIds.contains("s"))
        }
    }

    @Test(arguments: [false, true]) func rejectionRegistrationIgnoreAndRetryPersist(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        var repo = try repositories(seed(), durable: durable, directory: directory)
        _ = try await repo.reconciliation.runReconciliation(id: "one", at: now)
        try await repo.reconciliation.rejectCandidate(runId: "one", statementId: "s", receiptId: "actual:t")
        repo = try reopen(repo, durable: durable, directory: directory)
        await #expect(throws: KMReconciliationError("stale_run")) {
            try await repo.reconciliation.ignoreStatement(runId: "one", statementId: "s", at: now)
        }
        let run = try await repo.reconciliation.runReconciliation(id: "two", at: now)
        #expect(run.candidates.isEmpty)
        repo = try reopen(repo, durable: durable, directory: directory)
        let decision = try await repo.reconciliation.registerStatement(runId: "two", statementId: "s", categoryId: "food",
            destinationAccountId: nil, excludedFromSpending: true, newAccountId: "unused", at: now)
        repo = try reopen(repo, durable: durable, directory: directory)
        #expect(decision.status == .applied)
        #expect(try await repo.transactions.transaction(id: #require(decision.actualTransactionId))?.excludedFromSpending == true)
        var failed = decision; failed.status = .failed
        try await repo.reconciliation.saveResolution(failed)
        repo = try reopen(repo, durable: durable, directory: directory)
        try await repo.reconciliation.retryResolution(id: failed.id, at: now)
        #expect(try await repo.reconciliation.resolutions().first?.status == .applied)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 2)
        // An independent undecided statement exercises ignored history.
        let memory = seed(); memory.transactionValues = []
        let other = directory.appendingPathComponent("other")
        var ignored = try repositories(memory, durable: durable, directory: other)
        _ = try await ignored.reconciliation.runReconciliation(id: "ignore", at: now)
        _ = try await ignored.reconciliation.ignoreStatement(runId: "ignore", statementId: "s", at: now)
        ignored = try reopen(ignored, durable: durable, directory: other)
        #expect(try await ignored.reconciliation.resolutions().first?.resolution == .ignored)
    }

    @Test(arguments: [false, true]) func learningRecurringAndBudgetPersist(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        var repo = try repositories(seed(), durable: durable, directory: directory)
        for id in ["r1", "r2", "r3"] {
            let observation = try #require(KMCategoryLearningService.observation(receiptId: id, merchant: "人工ストア", defaultCategoryId: "food",
                items: [(name: "人工商品", categoryId: "food")], availableCategoryIds: ["food"], confirmedAt: now))
            try await repo.categoryLearning.saveCategoryObservation(observation)
        }
        repo = try reopen(repo, durable: durable, directory: directory)
        #expect(try await repo.categoryLearning.categoryObservations().count == 3)
        #expect(try await repo.categoryLearning.categoryRules().count == 2)
        let expected = try await repo.categoryLearning.categoryRules()
        try await repo.categoryLearning.setCategoryRuleOverride(.init(targetType: .merchant, normalizedName: "人工ストア", disabled: true))
        repo = try reopen(repo, durable: durable, directory: directory)
        #expect(try await repo.categoryLearning.categoryRules().first { $0.targetType == .merchant }?.enabled == false)
        try await repo.categoryLearning.resetCategoryRuleOverrides()
        #expect(try await repo.categoryLearning.categoryRules() == expected)
        var older = try #require(try await repo.categoryLearning.categoryObservations().first)
        older.confirmedAt = now.addingTimeInterval(-1); older.merchantCategoryId = nil
        try await repo.categoryLearning.saveCategoryObservation(older)
        #expect(try await repo.categoryLearning.categoryRules() == expected)
        let schedule = KMRecurringTransaction(id: "schedule", name: "合成定期", kind: .expense, amountYen: 100, categoryId: "food", accountId: "card",
            frequency: .monthly, startDate: day, postsTransaction: true, completed: false, editable: true)
        try await repo.recurring.saveRecurring(schedule)
        try await repo.recurring.catchUpRecurring(id: schedule.id, dates: [day], through: day, at: now)
        repo = try reopen(repo, durable: durable, directory: directory)
        try await repo.recurring.catchUpRecurring(id: schedule.id, dates: [day], through: day, at: now)
        #expect(try await repo.recurring.recurringOccurrences(scheduleId: schedule.id).count == 1)
        let generated = KMRecurringScheduleService.importedId(scheduleId: schedule.id, date: day)
        try await repo.transactions.deleteTransaction(id: generated)
        repo = try reopen(repo, durable: durable, directory: directory)
        try await repo.recurring.catchUpRecurring(id: schedule.id, dates: [day], through: day, at: now)
        #expect(try await repo.transactions.transaction(id: generated) == nil) // consumed even after deletion
        let settings = try await repo.budgets.budgetSettings().applyingDefaultPlan(totalYen: 5000, breakdownEnabled: false, allocations: [:])
        try await repo.budgets.saveBudgetSettings(settings)
        repo = try reopen(repo, durable: durable, directory: directory)
        #expect(try await repo.budgets.budgetSettings() == settings)
        #expect(try await repo.budgets.budgetSummary(month: day.yearMonth).budgetYen == 5000)
    }

    @Test func serviceWritesRollbackTogetherAndV1Migrates() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try install(seed(), at: directory)
        _ = try await store.runReconciliation(id: "one", at: now)
        let db = try database(store)
        try db.sql.execute("CREATE TRIGGER fail_service BEFORE INSERT ON objects WHEN NEW.collection='service-state' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        await #expect(throws: (any Error).self) {
            try await store.confirmSameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        }
        #expect(try await store.resolutions().isEmpty)
        #expect(try await store.transaction(id: "t")?.amountYen == -980)
        try db.sql.execute("DROP TRIGGER fail_service")
        // Recreate an actual v1 layout by removing only the v2 collection.
        try db.sql.execute("DELETE FROM objects WHERE collection='service-state'")
        try db.sql.execute("PRAGMA user_version=1")
        let migrated = try KMSQLiteStore(directory: directory)
        #expect(try await migrated.transaction(id: "t")?.amountYen == -980)
        #expect(try await migrated.latestRun()?.runId == "one")
        await #expect(throws: KMReconciliationError("stale_run")) {
            try await migrated.confirmSameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        }
        #expect(try database(migrated).sql.rows("PRAGMA user_version").first?.int("user_version") == 2)
    }
}

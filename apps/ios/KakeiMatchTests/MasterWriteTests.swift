import Foundation
import Testing
@testable import KakeiMatch

/// Inputs/expectations ported from actual-browser-ledger, local-statements,
/// moneyforward-import, local-recurring TS tests. Not the separate cross-runtime parity suite.
@MainActor struct MasterWriteTests {
    private let now = ISO8601DateFormatter().date(from: "2026-10-14T03:30:00Z")!
    private let day = KMDate(rawValue: "2026-10-01")
    private func temporary() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true); return directory
    }
    private func database(_ store: KMSQLiteStore) throws -> KMStoreDatabase {
        try KMStoreDatabase(url: store.directory.appendingPathComponent(try store.profile().current.uuidString).appendingPathComponent("household.sqlite"))
    }
    private func seed() -> KMInMemoryStore {
        KMInMemoryStore(accounts: [.init(id: "cash", name: "現金", accountType: .cash), .init(id: "bank", name: "銀行", accountType: .bank)],
            categories: [.init(id: "food", name: "食費"), .init(id: "home", name: "日用品"), .init(id: "income", name: "給与", isIncome: true)])
    }
    private func repository(_ memory: KMInMemoryStore, durable: Bool, directory: URL) throws -> KMRepositories {
        if !durable { return KMRepositories(inMemory: memory) }
        let store = try KMSQLiteStore(directory: directory); try database(store).save(memory); return KMRepositories(persistent: store)
    }
    private func reopened(_ repo: KMRepositories, durable: Bool, directory: URL) throws -> KMRepositories {
        durable ? KMRepositories(persistent: try KMSQLiteStore(directory: directory)) : repo
    }
    private func csv() -> Data {
        Data(("利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日\n" +
            "2026/10/01,合成ストア,本人,PayPayクレジット,1回,1000,0,1000,1000,0,0,2026/10/27\n").utf8)
    }
    private func moneyForwardRows() -> [KMMoneyForwardRow] {
        KMMoneyForwardParser.parse(data: Data("日付,内容,金額（円）,大項目,ID\n2026/10/01,合成ストア,-1000,食費,one\n".utf8), now: now).transactions
    }
    private func mappings(_ rows: [KMMoneyForwardRow]) -> KMMoneyForwardMappings {
        .init(categories: [KMMoneyForwardParser.categoryKey(kind: rows[0].kind, major: rows[0].majorCategory, minor: rows[0].minorCategory): .existing(id: "food")])
    }
    private func schedule(posts: Bool = false) -> KMRecurringTransaction {
        .init(id: "schedule", name: "合成定期", kind: .expense, amountYen: 1000, categoryId: "food", accountId: "bank",
            frequency: .monthly, startDate: day, postsTransaction: posts, completed: false, editable: true)
    }
    @Test(arguments: [false, true]) func statementsAreProviderOnlyIdempotentAndRecoverMissingRows(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let memory = seed(); var repo = try repository(memory, durable: durable, directory: directory)
        let first = try await repo.statements.importStatement(data: csv(), provider: .paypayCard, at: now)
        #expect(first.added == 1 && first.duplicates == 0)
        repo = try reopened(repo, durable: durable, directory: directory)
        let second = try await repo.statements.importStatement(data: csv(), provider: .paypayCard, at: now)
        #expect(second.id == first.id && second.added == 0 && second.duplicates == 1)
        #expect(try await repo.statements.statementImports().count == 1)
        #expect(try await repo.statements.statementImports().first?.value.accountId == nil)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).isEmpty)
        if let store = repo.localStore { #expect(try store.originalArtifact(id: "statement-source:\(first.id)") == csv()) }
        let working = try repo.localStore.map { try database($0).load() } ?? memory
        let saved = try #require(working.statementValues.first)
        working.statementValues = [] // simulate legacy partial import: repeat restores only the missing row
        if let store = repo.localStore { try database(store).save(working) }
        let recovered = try await repo.statements.importStatement(data: csv(), provider: .paypayCard, at: now)
        #expect(recovered.id == first.id && recovered.added == 1)
        #expect(try await repo.statements.statementTransactions().first?.id == saved.id)
    }
    @Test(arguments: [false, true]) func repeatedStatementRowsAndReviewReasonsMatchTS(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let repo = try repository(seed(), durable: durable, directory: directory)
        let lines = String(data: csv(), encoding: .utf8)!.split(separator: "\n").map(String.init)
        let repeated = Data((lines[0] + "\n" + lines[1] + "\n" + lines[1] + "\n").utf8)
        let first = try await repo.statements.importStatement(data: repeated, provider: .paypayCard, at: now)
        #expect(first.added == 2 && first.duplicates == 0 && first.duplicateRowsInFile == 0)
        let again = try await repo.statements.importStatement(data: repeated, provider: .paypayCard, at: now)
        #expect(again.id == first.id && again.added == 0 && again.duplicates == 2)
        let review = Data((lines[0] + "\n" + lines[1] + "\n2026/10/01,合成ストア,本人,PayPayクレジット,分割払い,1200,0,1200,400,800,0,2026/10/27\n").utf8)
        let result = try await repo.statements.importStatement(data: review, provider: .paypayCard, at: now)
        #expect(result.added == 0 && result.needsReviewRows == [.init(rowNumber: 3, reason: "1回払い以外の可能性があります")])
    }
    @Test func externalNumberConflictDoesNotPublishSourceOrRows() throws {
        let memory = seed()
        let row = KMParsedStatementTransaction(provider: .paypayCard, externalId: "stable", usedDate: day,
            merchant: "合成", amountYen: 1000, sourceFingerprint: "fp", duplicateOrdinal: 1)
        let parsed = KMStatementParseResult(transactions: [row], totalRows: 1, headerSignature: "synthetic")
        _ = try memory.importParsedStatement(parsed, data: Data("first".utf8), provider: .paypayCard, at: now)
        var changed = parsed; changed.transactions[0].amountYen = 2000
        #expect(throws: (any Error).self) { try memory.importParsedStatement(changed, data: Data("changed".utf8), provider: .paypayCard, at: now) }
        #expect(memory.statementValues.count == 1 && memory.importValues.count == 1 && memory.imageValues.count == 1)
    }
    @Test(arguments: [false, true]) func externalIdsSkipGloballyAndCreatePayees(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        var repo = try repository(seed(), durable: durable, directory: directory)
        let input = KMExternalTransactionInput(accountId: "bank", date: KMDate(rawValue: "2026-09-30"), amountYen: 2400, kind: .income,
            payeeName: "Synthetic Refund", categoryId: nil, importedId: "moneyforward:id:mf-900")
        let first = try await repo.transactions.importExternalTransaction(input)
        repo = try reopened(repo, durable: durable, directory: directory)
        var different = input; different.accountId = "missing"; different.amountYen = 2000
        let repeatResult = try await repo.transactions.importExternalTransaction(different)
        #expect(!first.alreadyExisted && repeatResult.alreadyExisted && repeatResult.transaction == first.transaction)
        #expect(first.transaction.amountYen == 2400 && first.transaction.kind == .income && first.transaction.categoryId == nil && !first.transaction.cleared)
        #expect(try await repo.payees.payees().contains { $0.id == first.transaction.payeeId })
    }
    @Test(arguments: [false, true]) func accountOpeningBalanceCutoffCloseReopenDelete(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        var repo = try repository(seed(), durable: durable, directory: directory)
        try await repo.accounts.createAccount(.init(id: "new", name: "新口座"), startingBalanceYen: 5000, startingDate: day)
        let before = try await repo.accounts.accounts(asOf: KMDate("2026-09-30"), includeClosed: true)
        #expect(before.first { $0.id == "new" }?.balanceYen == 0)
        #expect(try await repo.accounts.accounts(asOf: day, includeClosed: true).first { $0.id == "new" }?.balanceYen == 5000)
        #expect(try await repo.transactions.home(month: day.yearMonth).summary.incomeYen == 0)
        var account = try #require(try await repo.accounts.accounts(includeClosed: true).first { $0.id == "new" }); account.closed = true
        await #expect(throws: (any Error).self) { try await repo.accounts.saveAccount(account) }
        var empty = KMAccount(id: "empty", name: "空口座")
        try await repo.accounts.saveAccount(empty); empty.closed = true; try await repo.accounts.saveAccount(empty)
        repo = try reopened(repo, durable: durable, directory: directory)
        #expect(try await repo.accounts.accounts(includeClosed: true).first { $0.id == "empty" }?.closed == true)
        empty.closed = false; try await repo.accounts.saveAccount(empty)
        try await repo.accounts.deleteAccount(id: "empty")
        await #expect(throws: (any Error).self) { try await repo.accounts.deleteAccount(id: "new") }
        _ = try await repo.transactions.importExternalTransaction(.init(accountId: "bank", date: KMDate("2099-01-01"), amountYen: 10,
            kind: .expense, payeeName: "未来", categoryId: "food", importedId: "future"))
        #expect(try await repo.accounts.accounts(asOf: day, includeClosed: true).first { $0.id == "bank" }?.balanceYen == 0)
        var bank = try #require(try await repo.accounts.accounts(includeClosed: true).first { $0.id == "bank" }); bank.closed = true
        await #expect(throws: (any Error).self) { try await repo.accounts.saveAccount(bank) }
    }
    @Test(arguments: [false, true]) func usedCategoryRefusesDeletionAndGroupVisibilityIsEffective(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let memory = seed()
        memory.transactionValues = [.init(id: "split", date: KMDate(rawValue: "2099-01-01"), amountYen: -10, kind: .expense,
            accountId: "bank", isSplit: true, splits: [.init(id: "child", categoryId: "food", amountYen: -10)])]
        var repo = try repository(memory, durable: durable, directory: directory)
        await #expect(throws: (any Error).self) { try await repo.categories.deleteCategory(id: "food") }
        try await repo.categories.saveCategoryGroup(.init(id: "group", name: "合成グループ"))
        try await repo.categories.saveCategory(.init(id: "food", name: "新しい名前", groupId: "group"))
        try await repo.categories.saveCategory(.init(id: "second", name: "二つ目", groupId: "group"))
        try await repo.categories.reorderCategories(groupId: "group", ids: ["second", "food"])
        try await repo.categories.saveCategoryGroup(.init(id: "group", name: "非表示", hidden: true))
        repo = try reopened(repo, durable: durable, directory: directory)
        #expect(try await repo.categories.categoryGroups().first { $0.id == "group" }?.categoryIds == ["second", "food"])
        #expect(try await repo.categories.categories(includeHidden: false).contains { $0.id == "food" } == false)
        #expect(try await repo.categories.categories(includeHidden: true).first { $0.id == "food" }?.hidden == true)
        await #expect(throws: (any Error).self) { try await repo.categories.deleteCategoryGroup(id: "group") }
        try await repo.categories.deleteCategory(id: "second")
    }
    @Test(arguments: [false, true]) func moneyForwardDuplicatesReviewAndUndoOnlyOwnedRows(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        var repo = try repository(seed(), durable: durable, directory: directory)
        let rows = moneyForwardRows(), map = mappings(rows)
        let batch = try await repo.statements.importMoneyForward(id: "one", rows: rows + rows, mappings: map, choices: [:], at: now)
        #expect(batch.rows.map(\.status) == [.created, .duplicate])
        #expect(try await repo.accounts.accounts(includeClosed: true).contains { $0.name == "移行元未設定" })
        repo = try reopened(repo, durable: durable, directory: directory)
        #expect(try await repo.statements.importMoneyForward(id: "one", rows: rows + rows, mappings: map, choices: [:], at: now) == batch)
        let again = try await repo.statements.importMoneyForward(id: "two", rows: rows, mappings: map, choices: [:], at: now)
        #expect(again.rows.first?.status == .duplicate)
        var separate = rows; separate[0].sourceKey = "different-id"
        let preview = try await repo.statements.previewMoneyForward(rows: separate, mappings: map, choices: [:], at: now)
        #expect(preview.first?.status == .review && preview.first?.candidates.count == 1)
        await #expect(throws: (any Error).self) { try await repo.statements.importMoneyForward(id: "blocked", rows: separate, mappings: map, choices: [:], at: now) }
        let original = try #require(batch.rows.first?.transaction)
        let kept = try await repo.statements.importMoneyForward(id: "keep", rows: separate, mappings: map,
            choices: ["moneyforward:different-id": .keep(transactionId: original.id)], at: now)
        #expect(kept.rows.first?.status == .duplicate)
        try await repo.statements.undoMoneyForward(id: "keep", at: now)
        #expect(try await repo.transactions.transaction(id: original.id) != nil)
        try await repo.statements.undoMoneyForward(id: "two", at: now)
        #expect(try await repo.transactions.transaction(id: original.id) != nil)
        try await repo.statements.undoMoneyForward(id: "one", at: now)
        #expect(try await repo.transactions.transaction(id: original.id) == nil)
        #expect(try await repo.statements.moneyForwardHistory().count == 3)
    }
    @Test(arguments: [false, true]) func recurringUndoDoesNotAdoptManualOrDeleteEditedOccurrence(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        var repo = try repository(seed(), durable: durable, directory: directory)
        let manual = try await repo.transactions.saveManual(.init(kind: .expense, amountYen: 1000, date: day, payeeName: "合成定期",
            categoryId: "food", accountId: "bank", importedId: "manual"), id: nil)
        try await repo.recurring.saveRecurring(schedule(), at: now)
        try await repo.recurring.catchUpRecurring(id: "schedule", dates: [day], through: day, at: now)
        repo = try reopened(repo, durable: durable, directory: directory)
        let audit = try #require(try await repo.recurring.recurringGenerations(scheduleId: "schedule").first)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 2)
        try await repo.recurring.undoRecurringGeneration(id: audit.id, dates: nil, at: now)
        #expect(try await repo.transactions.transaction(id: manual.id) != nil)
        #expect(try await repo.transactions.transaction(id: audit.occurrences[0].transaction.id) == nil)
        try await repo.recurring.catchUpRecurring(id: "schedule", dates: [day], through: day, at: now)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 1)
        let secondDay = KMDate(rawValue: "2026-11-01"), later = ISO8601DateFormatter().date(from: "2026-11-02T00:00:00Z")!
        try await repo.recurring.catchUpRecurring(id: "schedule", dates: [secondDay], through: secondDay, at: later)
        let secondAudit = try #require(try await repo.recurring.recurringGenerations(scheduleId: "schedule").first { $0.createdAt == later })
        let created = secondAudit.occurrences[0].transaction
        _ = try await repo.transactions.saveManual(.init(kind: .expense, amountYen: 900, date: secondDay, payeeName: "編集済み",
            categoryId: "food", accountId: "bank", importedId: "ignored"), id: created.id)
        await #expect(throws: (any Error).self) { try await repo.recurring.undoRecurringGeneration(id: secondAudit.id, dates: [secondDay], at: later) }
        try await repo.recurring.undoRecurringGeneration(id: secondAudit.id, dates: nil, at: later)
        #expect(try await repo.transactions.transaction(id: created.id)?.amountYen == -900)
        #expect(try await repo.recurring.recurringGenerations(scheduleId: "schedule").first { $0.id == secondAudit.id }?.occurrences.first?.status == .retained)
        try await repo.recurring.deleteRecurring(id: "schedule")
        #expect(try await repo.transactions.transaction(id: created.id) != nil)
    }
    @Test(arguments: [false, true]) func recurringUndoComparesLedgerFieldsNotMasterDisplayNames(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        var repo = try repository(seed(), durable: durable, directory: directory)
        try await repo.recurring.saveRecurring(schedule(posts: true), at: now)
        let audit = try #require(try await repo.recurring.recurringGenerations(scheduleId: "schedule").first)
        let row = audit.occurrences[0].transaction
        try await repo.categories.saveCategory(.init(id: "food", name: "食費の新しい名前"))
        try await repo.transactions.setSpendingExclusion(id: row.id, excluded: true)
        repo = try reopened(repo, durable: durable, directory: directory)
        // PWA's native snapshot contains the category ID, not its current display name;
        // spending exclusion is separate local metadata and does not edit the native row.
        try await repo.recurring.undoRecurringGeneration(id: audit.id, dates: [day], at: now)
        #expect(try await repo.transactions.transaction(id: row.id) == nil)
        #expect(try await repo.recurring.recurringGenerations(scheduleId: "schedule").first?.occurrences.first?.status == .deleted)
    }
    @Test(arguments: [false, true]) func recurringEditsPreserveOtherSchedulesAndRollbackInvalidMaster(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        var repo = try repository(seed(), durable: durable, directory: directory)
        let first = schedule()
        var second = schedule(); second.id = "second"; second.name = "二つ目の定期"
        try await repo.recurring.saveRecurring(first, at: now)
        try await repo.recurring.saveRecurring(second, at: now)
        var edited = first; edited.name = "変更後"; edited.amountYen = 900
        try await repo.recurring.saveRecurring(edited, at: now)
        repo = try reopened(repo, durable: durable, directory: directory)
        let saved = try await repo.recurring.recurringTransactions()
        #expect(saved.count == 2)
        #expect(saved.first { $0.id == first.id }?.amountYen == 900)
        #expect(saved.first { $0.id == second.id }?.name == second.name)
        var invalid = edited; invalid.accountId = "missing"
        await #expect(throws: (any Error).self) { try await repo.recurring.saveRecurring(invalid, at: now) }
        #expect(try await repo.recurring.recurringTransactions() == saved)
        try await repo.recurring.deleteRecurring(id: first.id)
        repo = try reopened(repo, durable: durable, directory: directory)
        #expect(try await repo.recurring.recurringTransactions().map(\.id) == [second.id])
    }
    @Test(arguments: [false, true]) func automaticRecurringRunsOnSaveAndIsIdempotent(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let repo = try repository(seed(), durable: durable, directory: directory)
        try await repo.recurring.saveRecurring(schedule(posts: true), at: now)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 1)
        try await repo.recurring.runRecurring(through: KMDate("2026-10-14"), at: now)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 1)
        var edited = schedule(posts: true); edited.amountYen = 900
        try await repo.recurring.saveRecurring(edited, at: now)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).first?.amountYen == -1000)
        #expect(try await repo.recurring.recurringTransactions().first?.nextDate == KMDate(rawValue: "2026-11-01"))
    }
    @Test(arguments: [false, true]) func reconciliationUsesLedgerPayeesAndPreservesSnapshotOnUndo(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let memory = seed()
        memory.statementValues = [.init(id: "s", importId: "import", provider: .paypayCard, kind: .purchase, usedDate: day,
            merchant: "合成ストア", amountYen: 1000, sourceFingerprint: "fp", duplicateOrdinal: 1)]
        memory.accountValues.append(.init(id: "card", name: "PayPayカード", accountType: .creditCard, statementProvider: .paypayCard))
        memory.transactionValues = [.init(id: "t", date: day, amountYen: -980, kind: .expense, payeeName: "合成ストア",
            accountId: "card", categoryId: "food", memo: "保持", importedId: "manual-original", reconciled: true)]
        var repo = try repository(memory, durable: durable, directory: directory)
        _ = try await repo.reconciliation.runReconciliation(id: "run", at: now)
        let decision = try await repo.reconciliation.confirmSameExpense(runId: "run", statementId: "s", receiptId: "actual:t", at: now)
        #expect(try await repo.transactions.transaction(id: "t")?.amountYen == -1000)
        repo = try reopened(repo, durable: durable, directory: directory)
        try await repo.reconciliation.undoSameExpense(id: decision.id, at: now)
        let row = try #require(try await repo.transactions.transaction(id: "t"))
        #expect(row.amountYen == -980 && !row.cleared && row.reconciled == true && row.importedId == "manual-original" && row.memo == "保持")
        _ = try await repo.reconciliation.runReconciliation(id: "again", at: now)
        try await repo.reconciliation.rejectCandidate(runId: "again", statementId: "s", receiptId: "actual:t")
        _ = try await repo.reconciliation.runReconciliation(id: "after-reject", at: now)
        let created = try await repo.reconciliation.registerStatement(runId: "after-reject", statementId: "s", categoryId: "food",
            destinationAccountId: nil, excludedFromSpending: true, newAccountId: "new-card", at: now)
        let registeredId = try #require(created.actualTransactionId)
        let registered = try #require(try await repo.transactions.transaction(id: registeredId))
        #expect(created.status == .applied && registered.cleared && registered.excludedFromSpending == true)
        #expect(try await repo.payees.payees().contains { $0.id == registered.payeeId })
        #expect(registered.importedId == "kakeimatch:statement:s")
    }
    @Test(arguments: [false, true]) func statementTransferUsesLedgerPairAndBothAccountBalances(durable: Bool) async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let memory = seed()
        memory.statementValues = [.init(id: "s", importId: "import", provider: .paypayCard, kind: .purchase, usedDate: day,
            merchant: "合成チャージ", amountYen: 1000, sourceFingerprint: "fp", duplicateOrdinal: 1)]
        var repo = try repository(memory, durable: durable, directory: directory)
        _ = try await repo.reconciliation.runReconciliation(id: "run", at: now)
        let decision = try await repo.reconciliation.registerStatement(runId: "run", statementId: "s", categoryId: nil,
            destinationAccountId: "bank", excludedFromSpending: nil, newAccountId: "card", at: now)
        repo = try reopened(repo, durable: durable, directory: directory)
        let rootId = try #require(decision.actualTransactionId)
        let root = try #require(try await repo.transactions.transaction(id: rootId))
        let peerId = try #require(root.transferId)
        let peer = try #require(try await repo.transactions.transaction(id: peerId))
        #expect(root.kind == .transfer && root.cleared && root.amountYen == -1000)
        #expect(peer.transferId == root.id && peer.accountId == "bank" && peer.amountYen == 1000)
        #expect(root.importedId == "kakeimatch:statement:s" && peer.importedId == nil)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 1)
        let balances = try await repo.accounts.accounts(asOf: day, includeClosed: true)
        #expect(balances.first { $0.id == "card" }?.balanceYen == -1000)
        #expect(balances.first { $0.id == "bank" }?.balanceYen == 1000)
        let summary = try await repo.transactions.home(month: day.yearMonth).summary
        #expect(summary.expenseYen == 0 && summary.incomeYen == 0)
    }
    @Test func versionThreeMigrationAndFailedMigrationPreserveLedgerAndRevision() throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("legacy.sqlite"), db = try KMStoreDatabase(url: path)
        let memory = seed(); memory.transactionValues = [.init(id: "old", date: day, amountYen: -20, kind: .expense, accountId: "bank", importedId: "stable")]
        try db.save(memory)
        try db.sql.execute("DELETE FROM objects WHERE collection='master-writes'")
        try db.sql.execute("PRAGMA user_version=3")
        let revision = try db.sql.rows("SELECT revision FROM control").first?.int("revision")
        try db.sql.execute("CREATE TRIGGER fail_migration BEFORE INSERT ON objects WHEN NEW.collection='master-writes' BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        #expect(throws: (any Error).self) { try KMStoreDatabase(url: path) }
        #expect(try db.sql.rows("PRAGMA user_version").first?.int("user_version") == 3)
        #expect(try db.sql.rows("SELECT revision FROM control").first?.int("revision") == revision)
        try db.sql.execute("DROP TRIGGER fail_migration")
        let migrated = try KMStoreDatabase(url: path), snapshot = try migrated.load()
        #expect(snapshot.transactionValues == memory.transactionValues && snapshot.masterWriteState.balanceEntries.isEmpty)
        #expect(try migrated.sql.rows("PRAGMA user_version").first?.int("user_version") == 4)
    }
    @Test func sqliteFailureRollsBackCSVOriginalRowsPayeeAndHistory() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let repo = try repository(seed(), durable: true, directory: directory), store = try #require(repo.localStore)
        let db = try database(store), revision = try db.sql.rows("SELECT revision FROM control").first?.int("revision")
        try db.sql.execute("CREATE TRIGGER fail_masters BEFORE INSERT ON objects WHEN NEW.collection='master-writes' BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        await #expect(throws: (any Error).self) { try await store.importStatement(data: csv(), provider: .paypayCard, at: now) }
        let rows = moneyForwardRows()
        await #expect(throws: (any Error).self) { try await store.importMoneyForward(id: "one", rows: rows, mappings: mappings(rows), at: now) }
        let reopened = try KMSQLiteStore(directory: directory)
        #expect(try await reopened.statementImports().isEmpty)
        #expect(try await reopened.statementTransactions().isEmpty)
        #expect(try await reopened.moneyForwardHistory().isEmpty)
        #expect(try await reopened.transactions(matching: .init(limit: nil)).isEmpty)
        #expect(try await reopened.payees().isEmpty)
        #expect(try await reopened.accounts(includeClosed: true).count == 2)
        #expect(try database(store).artifacts().isEmpty)
        #expect(try db.sql.rows("SELECT revision FROM control").first?.int("revision") == revision)
        try db.sql.execute("DROP TRIGGER fail_masters")
        _ = try await reopened.importStatement(data: csv(), provider: .paypayCard, at: now)
        let batch = try await reopened.importMoneyForward(id: "saved", rows: rows, mappings: mappings(rows), at: now)
        try await reopened.saveRecurring(schedule(posts: true), at: now)
        let generation = try #require(try await reopened.recurringGenerations(scheduleId: "schedule").first)
        let backup = try await reopened.exportNativeBackup(); defer { try? FileManager.default.removeItem(at: backup) }
        let targetDirectory = try temporary(); defer { try? FileManager.default.removeItem(at: targetDirectory) }
        let target = try KMSQLiteStore(directory: targetDirectory); try await target.importBackup(from: backup)
        #expect(try await target.statementTransactions().count == 1)
        let imported = try #require(try await target.statementImports().first)
        #expect(try target.originalArtifact(id: "statement-source:\(imported.id)") == csv())
        #expect(try await target.moneyForwardHistory() == [batch])
        #expect(try await target.recurringGenerations(scheduleId: "schedule") == [generation])
        try await target.undoRecurringGeneration(id: generation.id, at: now)
        #expect(try await target.transaction(id: generation.occurrences[0].transaction.id) == nil)
        let migratedId = try #require(batch.rows.first?.transaction?.id)
        #expect(try await target.transaction(id: migratedId) != nil)
        try await target.undoMoneyForward(id: batch.id, at: now)
        #expect(try await target.transaction(id: migratedId) == nil)
    }
}

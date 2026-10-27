import Foundation
import Testing
@testable import KakeiMatch

/// Same synthetic inputs as actual-browser-ledger.test.ts and local-receipts.test.ts.
/// Both adapters execute the same operations; durable cases reopen after every important boundary.
@MainActor struct LedgerWriteTests {
    private let timestamp = Date(timeIntervalSince1970: 1_790_000_000)
    private func seed() -> KMInMemoryStore {
        KMInMemoryStore(accounts: [.init(id: "cash", name: "合成現金"), .init(id: "bank", name: "合成銀行"), .init(id: "outside", name: "合成予算外", offbudget: true)],
            categories: [.init(id: "food", name: "食費"), .init(id: "household", name: "日用品"), .init(id: "income-category", name: "給与", isIncome: true)])
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true); return url
    }
    private func database(_ store: KMSQLiteStore) throws -> KMStoreDatabase {
        try KMStoreDatabase(url: store.directory.appendingPathComponent(try store.profile().current.uuidString).appendingPathComponent("household.sqlite"))
    }
    private func repositories(_ memory: KMInMemoryStore, durable: Bool, directory: URL) throws -> KMRepositories {
        if !durable { return KMRepositories(inMemory: memory) }
        let store = try KMSQLiteStore(directory: directory); try database(store).save(memory)
        return KMRepositories(persistent: store)
    }
    private func reopen(_ repo: KMRepositories, durable: Bool, directory: URL) throws -> KMRepositories {
        durable ? KMRepositories(persistent: try KMSQLiteStore(directory: directory)) : repo
    }
    private func manual(_ id: String = "kakeimatch:manual:income-1") throws -> KMManualTransactionInput {
        .init(kind: .income, amountYen: 65000, date: try KMDate("2099-04-05"), payeeName: "Synthetic Salary",
            categoryId: "income-category", accountId: "cash", memo: "monthly", importedId: id)
    }
    private func confirmed() throws -> KMConfirmedReceipt {
        .init(merchant: "Synthetic", purchasedDate: try KMDate("2026-09-30"), purchasedTime: nil, totalAmountYen: 1400,
            categoryId: "food", accountId: "cash", items: [
                .init(id: "a", name: "Synthetic apple", amountYen: 1000, categoryId: "food"),
                .init(id: "b", name: "Synthetic soap", amountYen: 500, categoryId: "household")],
            adjustments: [.init(id: "discount", label: "値引き", amountYen: -100, targetItemId: "a")])
    }
    private func receipt(_ value: KMConfirmedReceipt, image: Bool = true) -> KMReceipt {
        .init(id: "receipt:synthetic", createdAt: timestamp, updatedAt: timestamp,
            image: image ? .init(blobId: "synthetic-image", contentType: "image/png", sizeBytes: 3) : nil,
            extraction: nil, aiFlowId: nil, itemCategories: nil, reviewedWarnings: nil, classificationAttempt: nil,
            aiSuggestion: .init(categoryId: nil, source: .unclassified), confirmedValue: value,
            registration: .init(status: .pending, actualTransactionId: nil, lastError: nil))
    }

    @Test(arguments: [false, true]) func manualIdempotencyConflictAndEditPreserveNativeState(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let memory = seed(), input = try manual()
        var repo = try repositories(memory, durable: durable, directory: dir)
        let created = try await repo.transactions.saveManual(input, id: nil)
        #expect(created.amountYen == 65000 && created.importedId == input.importedId)
        repo = try reopen(repo, durable: durable, directory: dir)
        #expect(try await repo.transactions.saveManual(input, id: nil).id == created.id)
        var conflict = input; conflict.amountYen = 64000
        await #expect(throws: (any Error).self) { try await repo.transactions.saveManual(conflict, id: nil) }
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 1)
        var closed = try #require(try await repo.accounts.accounts(includeClosed: true).first { $0.id == "cash" }); closed.closed = true
        try await repo.accounts.saveAccount(closed)
        #expect(try await repo.transactions.saveManual(input, id: nil).id == created.id)
        closed.closed = false; try await repo.accounts.saveAccount(closed)
        // Add native lock state as if imported; the edit API must not replace it with defaults.
        let working = durable ? try database(try #require(repo.localStore)).load() : memory
        working.transactionValues[0].cleared = true; working.transactionValues[0].reconciled = true
        if let store = repo.localStore { try database(store).save(working) }
        var edit = input; edit.accountId = "bank"; edit.amountYen = 2000; edit.memo = "moved entry"; edit.importedId = "must-not-replace-original"
        let updated = try await repo.transactions.saveManual(edit, id: created.id)
        #expect(updated.id == created.id && updated.importedId == input.importedId && updated.cleared && updated.reconciled == true)
        #expect(updated.accountId == "bank" && updated.amountYen == 2000 && updated.memo == "moved entry")
        repo = try reopen(repo, durable: durable, directory: dir)
        #expect(try await repo.transactions.transaction(id: created.id) == updated)
    }

    @Test(arguments: [false, true]) func pwaOrdinaryExpenseEditGolden(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let memory = seed(); memory.categoryValues.append(.init(id: "home", name: "日用品"))
        memory.transactionValues = [.init(id: "expense", date: KMDate(rawValue: "2026-09-29"), amountYen: -3284, kind: .expense,
            payeeName: "Synthetic Store", accountId: "cash", cleared: true, categoryId: "food", importedId: "receipt:1")]
        let repo = try repositories(memory, durable: durable, directory: dir)
        let result = try await repo.transactions.saveManual(.init(kind: .expense, amountYen: 2000, date: KMDate("2099-06-07"),
            payeeName: "Synthetic Books", categoryId: "home", accountId: "bank", memo: "moved entry", importedId: "ignored-on-edit"), id: "expense")
        #expect(result.id == "expense" && result.kind == .expense && result.amountYen == -2000 && result.date.rawValue == "2099-06-07")
        #expect(result.accountId == "bank" && result.payeeName == "Synthetic Books" && result.categoryId == "home" && result.memo == "moved entry" && result.cleared)
        #expect(result.importedId == "receipt:1")
    }

    @Test(arguments: [false, true]) func payeesFollowActualImportAndPWAEditNormalization(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let memory = seed()
        memory.payeeValues = [.init(id: "unicode", name: "ÉCOLE"), .init(id: "width", name: "Ｆｏｏ　店")]
        var repo = try repositories(memory, durable: durable, directory: dir)
        var input = try manual("payee-one"); input.payeeName = " École "
        let row = try await repo.transactions.saveManual(input, id: nil)
        #expect(row.payeeName == "ÉCOLE")
        input.payeeName = "foo 店"; input.importedId = "payee-two"
        let fresh = try await repo.transactions.saveManual(input, id: nil)
        #expect(fresh.payeeName == "Foo 店") // imports do NOT use NFKC to reuse the full-width master.
        repo = try reopen(repo, durable: durable, directory: dir)
        #expect(try await repo.payees.payees().count == 3)
        input.payeeName = "foo   店"
        let edited = try await repo.transactions.saveManual(input, id: fresh.id)
        #expect(edited.payeeName == "Ｆｏｏ　店") // ordinary edit DOES use PWA normalizeMerchant.
        input.payeeName = String(repeating: "😀", count: 101); input.importedId = "too-long"
        await #expect(throws: (any Error).self) { try await repo.transactions.saveManual(input, id: nil) }
        #expect(try await repo.payees.payees().count == 3)
    }
    @Test func actualTitleRulesAndASCIIOnlyReadbackKey() throws {
        #expect(try KMPayeeNormalization.importedName("  the API and the coffee SHOP  ") == "The API and the Coffee Shop")
        #expect(try KMPayeeNormalization.importedName("github: the store") == "GitHub: The Store")
        #expect(try KMPayeeNormalization.importedName("nodeXjs") == "Node.js")
        #expect(KMPayeeNormalization.merchantKey("\u{FEFF}Ａ\u{FEFF}Ｂ\u{FEFF}") == "a b")
        #expect(KMPayeeNormalization.merchantKey("\u{0085}Ａ") == "\u{0085}a")
        #expect(KMPayeeNormalization.merchantKey("  ＡＢＣ　店  ") == "abc 店")
        #expect(KMPayeeNormalization.merchantKey("ÉCOLE") == "École")
        #expect(KMPayeeNormalization.merchantKey("école") == "école")
    }

    @Test(arguments: [false, true]) func idlessImportMatchDoesNotDuplicateAndDoesNotOverwriteDifferentFields(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let memory = seed(); let input = try manual()
        memory.transactionValues = [.init(id: "idless", date: input.date, amountYen: input.amountYen, kind: .income,
            payeeName: input.payeeName, accountId: "cash", cleared: true, categoryId: input.categoryId)]
        let repo = try repositories(memory, durable: durable, directory: dir)
        let saved = try await repo.transactions.saveManual(input, id: nil)
        #expect(saved.id == "idless" && saved.cleared && saved.memo == "monthly")
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 1)
        var changed = input; changed.memo = "different"
        await #expect(throws: (any Error).self) { try await repo.transactions.saveManual(changed, id: nil) }
        #expect(try await repo.transactions.transaction(id: "idless") == saved)
    }

    @Test(arguments: [false, true]) func transferPairRetryEditIncomingAndBudgetBoundary(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        var repo = try repositories(seed(), durable: durable, directory: dir)
        var input = KMTransferInput(amountYen: 12500, date: try KMDate("2026-09-30"), sourceAccountId: "cash", destinationAccountId: "outside", memo: "移動", importedId: "kakeimatch:transfer:one")
        let created = try await repo.transactions.saveTransfer(input, id: nil)
        let peerId = try #require(created.transferId)
        let peer = try #require(try await repo.transactions.transaction(id: peerId))
        #expect(peer.transferId == created.id && peer.importedId == nil && peer.amountYen == 12500)
        #expect(created.categoryId == nil && peer.categoryId == nil)
        repo = try reopen(repo, durable: durable, directory: dir)
        #expect(try await repo.transactions.saveTransfer(input, id: nil).id == created.id)
        input.amountYen = 2400; input.sourceAccountId = "bank"; input.destinationAccountId = "cash"; input.memo = "修正"
        await #expect(throws: (any Error).self) { try await repo.transactions.saveTransfer(input, id: nil) }
        let edited = try await repo.transactions.saveTransfer(input, id: peer.id)
        #expect(edited.id == created.id && edited.transferId == peer.id && edited.amountYen == -2400)
        let movedPeer = try #require(try await repo.transactions.transaction(id: peer.id))
        #expect(movedPeer.accountId == "cash" && movedPeer.amountYen == 2400 && movedPeer.memo == "修正" && movedPeer.transferId == created.id)
        #expect(try await repo.transactions.transactions(matching: .init(kind: .transfer, limit: nil)).count == 1)
        #expect(try await repo.transactions.home(month: KMYearMonth("2026-09")).summary.expenseYen == 0)
        #expect(try await repo.accounts.accounts(includeClosed: true).first { $0.id == "cash" }?.balanceYen == 2400)
        input.destinationAccountId = "bank"
        await #expect(throws: (any Error).self) { try await repo.transactions.saveTransfer(input, id: edited.id) }
    }

    @Test(arguments: [false, true]) func receiptRegistrationSplitRebuildAndZeroPhoto(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let memory = seed(); let original = receipt(try confirmed()); memory.receiptValues = [original]
        var repo = try repositories(memory, durable: durable, directory: dir)
        let posted = try await repo.receipts.registerReceipt(id: original.id, at: timestamp)
        let id = try #require(posted.registration.actualTransactionId)
        let row = try #require(try await repo.transactions.transaction(id: id))
        #expect(row.amountYen == -1400 && row.categoryId == nil && row.isSplit == true)
        #expect(row.splits?.map(\.amountYen) == [-900, -500])
        #expect(try await repo.receipts.registerReceipt(id: original.id, at: timestamp.addingTimeInterval(1)) == posted)
        repo = try reopen(repo, durable: durable, directory: dir)
        #expect(try await repo.transactions.home(month: KMYearMonth("2026-09")).summary.expenseYen == 1400)
        var value = try confirmed(); value.items = nil; value.adjustments = nil; value.totalAmountYen = 1600
        let edited = try await repo.receipts.editReceipt(id: original.id, value: value, expectedUpdatedAt: posted.updatedAt, at: timestamp.addingTimeInterval(2))
        let single = try #require(try await repo.transactions.transaction(id: id))
        #expect(single.id == row.id && single.importedId == row.importedId && single.splits == nil && single.categoryId == "food")
        await #expect(throws: (any Error).self) {
            try await repo.receipts.editReceipt(id: original.id, value: value, expectedUpdatedAt: posted.updatedAt, at: timestamp.addingTimeInterval(3))
        }
        let splitAgain = try await repo.receipts.editReceipt(id: original.id, value: confirmed(), expectedUpdatedAt: edited.updatedAt, at: timestamp.addingTimeInterval(4))
        #expect(splitAgain.registration.actualTransactionId == id)
        let rebuilt = try #require(try await repo.transactions.transaction(id: id))
        #expect(Set(rebuilt.splits!.map(\.id)).isDisjoint(with: Set(row.splits!.map(\.id))))
        var zero = value; zero.totalAmountYen = 0
        _ = try await repo.receipts.editReceipt(id: original.id, value: zero, expectedUpdatedAt: splitAgain.updatedAt, at: timestamp.addingTimeInterval(5))
        #expect(try await repo.transactions.transaction(id: id)?.amountYen == 0)
        var noPhoto = receipt(zero, image: false); noPhoto.id = "receipt:no-photo"
        try await repo.receipts.saveReceipt(noPhoto)
        await #expect(throws: (any Error).self) { try await repo.receipts.registerReceipt(id: noPhoto.id, at: timestamp) }
    }

    @Test(arguments: [false, true]) func splitEditRetainsChildrenMemoAndClearedReconciled(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let memory = seed(); memory.receiptValues = [receipt(try confirmed())]
        let repo = try repositories(memory, durable: durable, directory: dir)
        let posted = try await repo.receipts.registerReceipt(id: "receipt:synthetic", at: timestamp)
        let id = try #require(posted.registration.actualTransactionId)
        let working = durable ? try database(try #require(repo.localStore)).load() : memory
        working.transactionValues[0].cleared = true; working.transactionValues[0].reconciled = true
        working.transactionValues[0].splits![0].memo = "子のメモ"
        let childIds = working.transactionValues[0].splits!.map(\.id)
        if let store = repo.localStore { try database(store).save(working) }
        var input = try confirmed(); input.totalAmountYen = 1540; input.taxAmountYen = 140
        _ = try await repo.receipts.editReceipt(id: posted.id, value: input, expectedUpdatedAt: posted.updatedAt, at: timestamp.addingTimeInterval(1))
        let updated = try #require(try await repo.transactions.transaction(id: id))
        #expect(updated.cleared && updated.reconciled == true && updated.splits?.map(\.id) == childIds)
        #expect(updated.splits?.map(\.amountYen) == [-990, -550])
        #expect(updated.splits?.allSatisfy { $0.cleared == true && $0.reconciled == true } == true)
        #expect(try await repo.transactions.transactions(matching: .init(keyword: "子のメモ", limit: nil)).map(\.id) == [id])
    }
    @Test func brokenTransferAndMissingChildMasterDoNotPartiallyMutate() async throws {
        let memory = seed()
        let row = try await memory.saveTransfer(.init(amountYen: 100, date: KMDate("2026-09-30"), sourceAccountId: "cash", destinationAccountId: "bank", memo: nil, importedId: "broken-pair"))
        memory.transactionValues.removeAll { $0.id == row.transferId }
        await #expect(throws: (any Error).self) { try await memory.deleteTransaction(id: row.id, expected: nil, at: timestamp) }
        #expect(memory.transactionValues.count == 1 && memory.ledgerWriteState.tombstones.isEmpty)
        let original = receipt(try confirmed()); memory.receiptValues = [original]
        memory.categoryValues.removeAll { $0.id == "household" }
        await #expect(throws: (any Error).self) { try await memory.registerReceipt(id: original.id, at: timestamp) }
        #expect(memory.receiptValues == [original] && memory.transactionValues.count == 1)
    }

    @Test(arguments: [false, true]) func scalarSplitAndTransferDeleteUndoPersistSameIDs(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let memory = seed(); let original = receipt(try confirmed()); memory.receiptValues = [original]
        var repo = try repositories(memory, durable: durable, directory: dir)
        let manual = try await repo.transactions.saveManual(manual(), id: nil)
        let posted = try await repo.receipts.registerReceipt(id: original.id, at: timestamp)
        let parentId = try #require(posted.registration.actualTransactionId)
        let parent = try #require(try await repo.transactions.transaction(id: parentId))
        let transfer = try await repo.transactions.saveTransfer(.init(amountYen: 100, date: KMDate("2026-09-30"), sourceAccountId: "cash", destinationAccountId: "bank", memo: "Synthetic", importedId: "synthetic-delete-transfer"), id: nil)
        for row in [manual, parent, transfer] {
            let before = try await repo.accounts.accounts(includeClosed: true)
            let audit = try await repo.transactions.deleteTransaction(id: row.id, expected: nil, at: timestamp)
            repo = try reopen(repo, durable: durable, directory: dir)
            #expect(try await repo.transactions.transaction(id: row.id) == nil)
            if let peer = row.transferId { #expect(try await repo.transactions.transaction(id: peer) == nil) }
            if row.id == parent.id {
                #expect(try await repo.receipts.receipt(id: original.id)?.registration.status == .deleted)
                #expect(try await repo.receipts.receipt(id: original.id)?.confirmedValue == original.confirmedValue)
                await #expect(throws: (any Error).self) { try await repo.receipts.registerReceipt(id: original.id, at: timestamp) }
            }
            #expect(try await repo.transactions.transactionDeletions().last?.id == audit.id)
            try await repo.transactions.undoTransactionDeletion(id: audit.id, at: timestamp.addingTimeInterval(9.999))
            repo = try reopen(repo, durable: durable, directory: dir)
            #expect(try await repo.transactions.transaction(id: row.id) == row)
            #expect(try await repo.accounts.accounts(includeClosed: true) == before)
            if row.id == parent.id { #expect(try await repo.receipts.receipt(id: original.id) == posted) }
        }
    }
    @Test(arguments: [false, true]) func deletionRejectsStaleSnapshotExpiryAndOccupiedImportedID(durable: Bool) async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let repo = try repositories(seed(), durable: durable, directory: dir)
        let input = try manual(), row = try await repo.transactions.saveManual(input, id: nil)
        var stale = row; stale.memo = "stale"
        await #expect(throws: (any Error).self) { try await repo.transactions.deleteTransaction(id: row.id, expected: [stale], at: timestamp) }
        let audit = try await repo.transactions.deleteTransaction(id: row.id, expected: [row], at: timestamp)
        await #expect(throws: (any Error).self) { try await repo.transactions.undoTransactionDeletion(id: audit.id, at: timestamp.addingTimeInterval(10)) }
        #expect(try await repo.transactions.transaction(id: row.id) == nil)
        _ = try await repo.transactions.saveManual(input, id: nil)
        await #expect(throws: (any Error).self) { try await repo.transactions.undoTransactionDeletion(id: audit.id, at: timestamp.addingTimeInterval(1)) }
    }
    @Test func sqliteFailureRollsBackReceiptPayeeTombstoneAndHistory() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let memory = seed(); memory.receiptValues = [receipt(try confirmed())]
        let repo = try repositories(memory, durable: true, directory: dir), store = try #require(repo.localStore)
        let db = try database(store)
        try db.sql.execute("CREATE TRIGGER fail_write BEFORE INSERT ON objects WHEN NEW.collection='ledger-writes' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        await #expect(throws: (any Error).self) { try await repo.receipts.registerReceipt(id: "receipt:synthetic", at: timestamp) }
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).isEmpty)
        #expect(try await repo.payees.payees().isEmpty)
        #expect(try await repo.receipts.receipt(id: "receipt:synthetic")?.registration.status == .pending)
        try db.sql.execute("DROP TRIGGER fail_write")
        let posted = try await repo.receipts.registerReceipt(id: "receipt:synthetic", at: timestamp)
        try db.sql.execute("CREATE TRIGGER fail_write BEFORE INSERT ON objects WHEN NEW.collection='ledger-writes' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        let postedTransactionId = try #require(posted.registration.actualTransactionId)
        await #expect(throws: (any Error).self) { try await repo.transactions.deleteTransaction(id: postedTransactionId, expected: nil, at: timestamp) }
        #expect(try await repo.transactions.transactionDeletions().isEmpty)
        #expect(try await repo.receipts.receipt(id: posted.id)?.registration.status == .applied)
        #expect(try database(store).load().ledgerWriteState.tombstones.isEmpty)
        try db.sql.execute("DROP TRIGGER fail_write")
        let audit = try await repo.transactions.deleteTransaction(id: postedTransactionId, expected: nil, at: timestamp)
        try db.sql.execute("CREATE TRIGGER fail_write BEFORE INSERT ON objects WHEN NEW.collection='ledger-writes' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        await #expect(throws: (any Error).self) { try await repo.transactions.undoTransactionDeletion(id: audit.id, at: timestamp.addingTimeInterval(1)) }
        #expect(try await repo.transactions.transaction(id: postedTransactionId) == nil)
        #expect(try await repo.receipts.receipt(id: posted.id)?.registration.status == .deleted)
        #expect(try await repo.transactions.transactionDeletions().last?.restoredAt == nil)
        try db.sql.execute("DROP TRIGGER fail_write")
        try await repo.transactions.undoTransactionDeletion(id: audit.id, at: timestamp.addingTimeInterval(2))
        #expect(try await repo.receipts.receipt(id: posted.id) == posted)
    }
    @Test func v2MigrationAndNativeBackupRetainTombstonesAndUndo() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let repo = try repositories(seed(), durable: true, directory: dir), store = try #require(repo.localStore)
        let row = try await repo.transactions.saveManual(manual(), id: nil)
        let db = try database(store)
        try db.sql.execute("DELETE FROM objects WHERE collection='ledger-writes'")
        try db.sql.execute("PRAGMA user_version=2")
        try db.sql.execute("CREATE TRIGGER fail_migration BEFORE INSERT ON objects WHEN NEW.collection='ledger-writes' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        #expect(throws: (any Error).self) { try KMSQLiteStore(directory: dir) }
        #expect(try db.sql.rows("PRAGMA user_version").first?.int("user_version") == 2)
        #expect(try db.sql.rows("SELECT id FROM objects WHERE collection='transactions'").count == 1)
        try db.sql.execute("DROP TRIGGER fail_migration")
        let reopened = try KMSQLiteStore(directory: dir)
        #expect(try await reopened.transaction(id: row.id) == row)
        #expect(try database(reopened).sql.rows("PRAGMA user_version").first?.int("user_version") == 3)
        let audit = try await reopened.deleteTransaction(id: row.id, expected: nil, at: timestamp)
        let backup = try await reopened.exportNativeBackup(); defer { try? FileManager.default.removeItem(at: backup) }
        try await reopened.importBackup(from: backup)
        #expect(try await reopened.transaction(id: row.id) == nil)
        #expect(try database(reopened).load().ledgerWriteState.tombstones.first?.transaction == row)
        try await reopened.undoTransactionDeletion(id: audit.id, at: timestamp.addingTimeInterval(1))
        #expect(try await reopened.transaction(id: row.id) == row)
    }
}

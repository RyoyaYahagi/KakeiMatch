import Foundation
import Testing
@testable import KakeiMatch

/// Synthetic bytes only; no household photo is read or logged.
@MainActor struct ReceiptImageDraftStoreTests {
    private let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    private let replacementPNG = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03])
    private let timestamp = Date(timeIntervalSince1970: 1_800_000_000)

    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func draft(_ merchant: String = "合成の未完成入力") -> KMReceiptDraft {
        .init(merchant: merchant, purchasedDate: "2026-10-14", purchasedTime: nil,
              totalAmountText: "", categoryId: "", accountId: "", items: [.init(id: "synthetic-item", name: "", amountYen: nil)],
              adjustments: [], taxAmountText: "", memo: "途中", excludedFromSpending: false)
    }

    @Test func sqliteStoresImageAndDraftTogetherAcrossReopenAndDeletesBoth() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        let receipt = try await store.saveReceiptImage(data: png, contentType: "image/png", at: timestamp)
        let blobId = try #require(receipt.image?.blobId)
        #expect(receipt.registration.status == .pending)
        #expect(receipt.image?.contentType == "image/png")
        #expect(receipt.image?.sizeBytes == png.count)
        #expect(try await store.receiptImage(blobId: blobId) == png)
        try await store.saveReceiptDraft(draft(), receiptId: receipt.id, at: timestamp)

        let reopened = try KMSQLiteStore(directory: directory)
        #expect(try await reopened.receipt(id: receipt.id) == receipt)
        #expect(try await reopened.receiptImage(blobId: blobId) == png)
        #expect(try await reopened.receiptDraft(receiptId: receipt.id) == draft())

        try await reopened.deleteReceipt(id: receipt.id)
        #expect(try await reopened.receipts().isEmpty)
        #expect(try await reopened.receiptImage(blobId: blobId) == nil)
        #expect(try await reopened.receiptDraft(receiptId: receipt.id) == nil)
        let sql = try KMSQLite(url: directory.appendingPathComponent(try reopened.profile().current.uuidString)
            .appendingPathComponent("household.sqlite"))
        #expect(try sql.rows("SELECT id FROM artifacts").isEmpty)
    }

    @Test func failedSQLiteWriteLeavesNoReceiptImageOrDraft() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        let sql = try KMSQLite(url: directory.appendingPathComponent(try store.profile().current.uuidString)
            .appendingPathComponent("household.sqlite"))
        try sql.execute("CREATE TRIGGER fail_save BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        await #expect(throws: (any Error).self) {
            _ = try await store.saveReceiptImage(data: png, contentType: "image/png", at: timestamp)
        }
        #expect(try await store.receipts().isEmpty)
        #expect(try sql.rows("SELECT id FROM artifacts").isEmpty)
        #expect(try sql.rows("SELECT json FROM objects WHERE collection='receipt-drafts'").isEmpty)
        try sql.execute("DROP TRIGGER fail_save")

        let saved = try await store.saveReceiptImage(data: png, contentType: "image/png", at: timestamp)
        #expect(try await store.receiptImage(blobId: try #require(saved.image?.blobId)) == png)
    }

    @Test func replacingAPendingReceiptDropsItsOldImageAndDraft() async throws {
        let store = KMInMemoryStore()
        let first = try await store.saveReceiptImage(data: png, contentType: "image/png", at: timestamp)
        let oldBlobId = try #require(first.image?.blobId)
        try await store.saveReceiptDraft(draft(), receiptId: first.id, at: timestamp)
        let second = try await store.saveReceiptImage(data: replacementPNG, contentType: "image/png",
            replacingReceiptId: first.id, at: timestamp)
        #expect(try await store.receipt(id: first.id) == nil)
        #expect(try await store.receiptImage(blobId: oldBlobId) == nil)
        #expect(try await store.receiptDraft(receiptId: first.id) == nil)
        #expect(try await store.receiptImage(blobId: try #require(second.image?.blobId)) == replacementPNG)
    }

    @Test func registrationUsesTheImageClearsTheDraftAndKeepsTheOriginal() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        let reference = try #require(try await repositories.receipts.receipts().first)
        let saved = try await repositories.receipts.saveReceiptImage(data: png, contentType: "image/png",
            replacingReceiptId: reference.id, at: repositories.referenceDate)
        let account = try #require(try await repositories.accounts.accounts(includeClosed: false).first)
        let category = try #require(try await repositories.categories.categories(includeHidden: false).first { !$0.isIncome })
        var pending = saved
        pending.confirmedValue = .init(merchant: "合成店舗", purchasedDate: try KMDate("2026-10-14"), purchasedTime: nil,
            totalAmountYen: 100, categoryId: category.id, accountId: account.id,
            excludedFromSpending: false, memo: nil, taxAmountYen: nil, items: nil, adjustments: nil)
        try await repositories.receipts.saveReceipt(pending)
        try await repositories.receipts.saveReceiptDraft(draft(), receiptId: saved.id, at: repositories.referenceDate)
        let applied = try await repositories.receipts.registerReceipt(id: saved.id, at: repositories.referenceDate)
        #expect(applied.registration.status == .applied)
        #expect(try await repositories.receipts.receiptDraft(receiptId: saved.id) == nil)
        #expect(try await repositories.receipts.receiptImage(blobId: try #require(saved.image?.blobId)) == png)
    }

    @Test func draftIsNotRecreatedForADeletedPendingReceipt() async throws {
        let store = KMInMemoryStore()
        await #expect(throws: (any Error).self) {
            try await store.saveReceiptDraft(draft(), receiptId: "missing-synthetic-receipt", at: timestamp)
        }
    }

    @Test func savingOneDraftWritesOnlyThatRowAdvancesRevisionAndPreservesLedger() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        try await store.saveAccount(.init(id: "test-cash", name: "合成現金", accountType: .cash))
        try await store.saveCategory(.init(id: "test-food", name: "食費"))
        let ledgerRow = try await store.saveManual(.init(
            kind: .expense, amountYen: 500, date: KMDate("2026-10-14"),
            payeeName: "合成台帳店", categoryId: "test-food", accountId: "test-cash",
            memo: nil, importedId: "ledger-row"
        ))
        let first = try await store.saveReceiptImage(data: png, contentType: "image/png", at: timestamp)
        let second = try await store.saveReceiptImage(data: replacementPNG, contentType: "image/png", at: timestamp)
        let secondDraft = draft("別の下書き")
        try await store.saveReceiptDraft(secondDraft, receiptId: second.id, at: timestamp)

        let dbURL = directory.appendingPathComponent(try store.profile().current.uuidString)
            .appendingPathComponent("household.sqlite")
        let sql = try KMSQLite(url: dbURL)
        let revisionBefore = try KMStoreDatabase(url: dbURL).revision()

        // Fail if saving `first`'s draft deletes or re-inserts any other row in `objects`.
        try sql.execute(
            "CREATE TRIGGER forbid_other_deletes BEFORE DELETE ON objects "
            + "WHEN OLD.collection != 'receipt-drafts' OR OLD.id != '\(first.id)' "
            + "BEGIN SELECT RAISE(ABORT,'rewrote other row'); END"
        )
        try sql.execute(
            "CREATE TRIGGER forbid_other_inserts BEFORE INSERT ON objects "
            + "WHEN NEW.collection != 'receipt-drafts' OR NEW.id != '\(first.id)' "
            + "BEGIN SELECT RAISE(ABORT,'rewrote other row'); END"
        )

        let firstDraft = draft("一件目の下書き")
        try await store.saveReceiptDraft(firstDraft, receiptId: first.id, at: timestamp)
        let revisionAfterInsert = try KMStoreDatabase(url: dbURL).revision()
        #expect(revisionAfterInsert == revisionBefore + 1)

        let firstUpdated = draft("一件目の更新")
        try await store.saveReceiptDraft(firstUpdated, receiptId: first.id, at: timestamp.addingTimeInterval(5))
        let revisionAfterUpdate = try KMStoreDatabase(url: dbURL).revision()
        #expect(revisionAfterUpdate == revisionBefore + 2)
        #expect(try sql.rows("PRAGMA user_version").first?.int("user_version") == 4)

        try sql.execute("DROP TRIGGER forbid_other_deletes")
        try sql.execute("DROP TRIGGER forbid_other_inserts")

        let reopened = try KMSQLiteStore(directory: directory)
        #expect(try await reopened.receiptDraft(receiptId: first.id) == firstUpdated)
        #expect(try await reopened.receiptDraft(receiptId: second.id) == secondDraft)
        #expect(try await reopened.transactions(matching: .init(limit: nil)).map(\.id) == [ledgerRow.id])

        // Verify `.kmib` export/import roundtrip remains intact after single-row draft writes.
        let backupURL = try await reopened.exportNativeBackup()
        defer { try? FileManager.default.removeItem(at: backupURL) }
        let restoredDir = try temporary(); defer { try? FileManager.default.removeItem(at: restoredDir) }
        let restored = try KMSQLiteStore(directory: restoredDir)
        try await restored.importBackup(from: backupURL)
        #expect(try await restored.receiptDraft(receiptId: first.id) == firstUpdated)
        #expect(try await restored.receiptDraft(receiptId: second.id) == secondDraft)
        #expect(try await restored.transactions(matching: .init(limit: nil)).map(\.id) == [ledgerRow.id])
    }
}

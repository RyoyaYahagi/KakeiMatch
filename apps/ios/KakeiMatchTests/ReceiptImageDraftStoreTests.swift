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
}

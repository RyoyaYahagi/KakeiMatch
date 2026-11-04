import Foundation
import Testing
@testable import KakeiMatch

/// The SQLite store keeps one published snapshot per active profile. These tests use only
/// synthetic data and check that the cache never replaces SQLite's transaction boundary.
@MainActor struct StoreCacheTests {
    private let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    private let otherPNG = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03])
    private let timestamp = Date(timeIntervalSince1970: 1_800_000_000)

    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func databaseURL(_ store: KMSQLiteStore, in directory: URL) throws -> URL {
        directory.appendingPathComponent(try store.profile().current.uuidString).appendingPathComponent("household.sqlite")
    }

    private func seed(_ store: KMSQLiteStore, payee: String = "合成テスト店") async throws -> KMTransaction {
        try await store.saveAccount(.init(id: "test-cash", name: "合成現金", accountType: .cash))
        try await store.saveCategory(.init(id: "test-food", name: "食費"))
        return try await store.saveManual(.init(kind: .expense, amountYen: 100, date: KMDate("2026-10-14"),
            payeeName: payee, categoryId: "test-food", accountId: "test-cash", memo: nil, importedId: "test-op"))
    }

    private func artifact(id: String, data: Data) -> KMBackupArtifact {
        .init(metadata: .init(id: id, ownerKind: "receipt", ownerId: "receipt-synthetic", contentType: "image/png",
            createdAt: timestamp, present: true, entry: nil, size: data.count, sha256: KMInMemoryStore.sha256(data)), data: data)
    }

    /// Opening a household must not decode receipt images. The metadata list is enough to prune or
    /// keep artifacts; screens ask for one payload by ID when they actually show or send it.
    @Test func loadSnapshotReadsArtifactIDsWithoutPayloads() throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let db = try KMStoreDatabase(url: directory.appendingPathComponent("store.sqlite"))
        try db.saveArtifacts([artifact(id: "receipt-image:synthetic", data: png)])

        let loaded = try db.load()
        #expect(loaded.imageValues.isEmpty)
        #expect(loaded.artifactIds == ["receipt-image:synthetic"])
        #expect(try db.original("receipt-image:synthetic") == png)
    }

    /// A write mutates a working copy. When COMMIT fails, the published snapshot must still show
    /// the previous household and the next successful write must build on it.
    @Test func failedCommitKeepsPublishedSnapshotAndNextWriteRecovers() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        let row = try await seed(store)
        let sql = try KMSQLite(url: try databaseURL(store, in: directory))
        try sql.execute("CREATE TRIGGER fail_save BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")

        await #expect(throws: (any Error).self) {
            _ = try await store.saveManual(.init(kind: .expense, amountYen: 200, date: KMDate("2026-10-14"),
                payeeName: "合成の失敗", categoryId: "test-food", accountId: "test-cash", memo: nil, importedId: "failed"))
        }
        #expect(try await store.transactions(matching: .init(limit: nil)).map(\.id) == [row.id])
        #expect(try sql.rows("SELECT id FROM objects WHERE collection='transactions'").count == 1)

        try sql.execute("DROP TRIGGER fail_save")
        _ = try await store.saveManual(.init(kind: .expense, amountYen: 300, date: KMDate("2026-10-14"),
            payeeName: "合成の再試行", categoryId: "test-food", accountId: "test-cash", memo: nil, importedId: "retry"))
        #expect(try await store.transactions(matching: .init(limit: nil)).count == 2)
        #expect(try await store.accounts().first?.balanceYen == -400)
    }

    /// Another connection (another scene, extension, or test) can commit without going through this
    /// store. Its revision mismatch must invalidate the cache instead of serving stale rows.
    @Test func readReloadsWhenAnotherConnectionCommits() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        _ = try await seed(store)
        #expect(try await store.settings().theme == .system)

        let other = try KMStoreDatabase(url: try databaseURL(store, in: directory))
        let external = try other.load()
        external.settingsValue.theme = .dark
        try other.save(external)

        #expect(try await store.settings().theme == .dark)
        #expect(try await store.transactions(matching: .init(limit: nil)).count == 1)
    }

    /// Restoring a backup replaces the profile pointer. The cached snapshot belongs to the old
    /// household, so the next read must load the imported profile; undo switches back again.
    @Test func profileSwitchAndUndoDiscardTheCachedHousehold() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let first = try KMSQLiteStore(directory: directory.appendingPathComponent("first"))
        _ = try await seed(first, payee: "合成の元の家計簿")
        let second = try KMSQLiteStore(directory: directory.appendingPathComponent("second"))
        _ = try await seed(second, payee: "合成の復元した家計簿")
        let backup = try await second.exportNativeBackup()

        try await first.importBackup(from: backup)
        #expect(try await first.transactions(matching: .init(limit: nil)).map(\.payeeName) == ["合成の復元した家計簿"])

        try await first.returnToPreviousProfile()
        #expect(try await first.transactions(matching: .init(limit: nil)).map(\.payeeName) == ["合成の元の家計簿"])
    }

    /// Deleting one pending receipt removes only its image. The snapshot loaded from SQLite has no
    /// payloads in memory, so retention must be driven by known artifact IDs and not by `imageValues`.
    @Test func deletingOnePersistedImageKeepsOtherArtifacts() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        let first = try await store.saveReceiptImage(data: png, contentType: "image/png", at: timestamp)
        let second = try await store.saveReceiptImage(data: otherPNG, contentType: "image/png", at: timestamp)
        let firstBlob = try #require(first.image?.blobId), secondBlob = try #require(second.image?.blobId)

        // Reopen so the published snapshot knows artifact IDs only; no payload is loaded.
        let reopened = try KMSQLiteStore(directory: directory)
        try await reopened.deleteReceipt(id: first.id)

        #expect(try await reopened.receipt(id: first.id) == nil)
        #expect(try await reopened.receipt(id: second.id) == second)
        #expect(try await reopened.receiptImage(blobId: firstBlob) == nil)
        #expect(try await reopened.receiptImage(blobId: secondBlob) == otherPNG)
        let sql = try KMSQLite(url: try databaseURL(reopened, in: directory))
        #expect(try sql.rows("SELECT id FROM artifacts").compactMap { $0.string("id") } == [secondBlob])
    }
}

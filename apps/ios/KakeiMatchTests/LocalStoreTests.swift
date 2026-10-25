import Foundation
import Testing
import ZIPFoundation
@testable import KakeiMatch

@MainActor struct LocalStoreTests {
    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func fixture(_ name: String, _ ext: String) throws -> URL {
        try #require(Bundle(for: ResourceAnchor.self).url(forResource: name, withExtension: ext, subdirectory: "Fixtures"))
    }
    private class ResourceAnchor: NSObject {}
    private func seed(_ store: KMSQLiteStore) async throws -> KMTransaction {
        try await store.saveAccount(.init(id: "test-cash", name: "合成現金", accountType: .cash))
        try await store.saveCategory(.init(id: "test-food", name: "食費"))
        return try await store.saveManual(.init(kind: .expense, amountYen: 100, date: KMDate("2026-10-14"),
            payeeName: "合成テスト店", categoryId: "test-food", accountId: "test-cash", memo: nil, importedId: "test-op"))
    }
    @Test func durableCRUDReopenAndRollback() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory), row = try await seed(store)
        let reopened = try KMSQLiteStore(directory: directory)
        #expect(try await reopened.transaction(id: row.id) == row)
        #expect(try await reopened.accounts().first?.balanceYen == -100)
        try await reopened.setSpendingExclusion(id: row.id, excluded: true)
        #expect(try await store.home(month: KMYearMonth("2026-10")).summary.expenseYen == 0)
        var settings = try await store.settings(); settings.theme = .dark
        try await store.saveSettings(settings)
        #expect(try await reopened.settings().theme == .dark)
        // Inject a real SQLite write failure after DELETE; rollback restores all collections.
        let path = directory.appendingPathComponent(try store.profile().current.uuidString).appendingPathComponent("household.sqlite")
        let sql = try KMSQLite(url: path)
        try sql.execute("CREATE TRIGGER fail_save BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        await #expect(throws: (any Error).self) { try await store.deleteTransaction(id: row.id) }
        #expect(try await reopened.transaction(id: row.id)?.excludedFromSpending == true)
        try sql.execute("DROP TRIGGER fail_save")
        try await store.deleteTransaction(id: row.id)
        #expect(try await reopened.transactions(matching: .init()).isEmpty)
    }
    @Test func migrationZeroToOneAndFutureVersionAreNonDestructive() throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("v0.sqlite")
        let db = try KMStoreDatabase(url: file)
        #expect(try db.sql.rows("PRAGMA user_version").first?.int("user_version") == 1)
        #expect(try db.load().transactionValues.isEmpty)
        try db.sql.execute("CREATE TABLE sentinel (value TEXT)")
        try db.sql.execute("INSERT INTO sentinel VALUES('synthetic survives')")
        try db.sql.execute("PRAGMA user_version=2")
        #expect(throws: (any Error).self) { try KMStoreDatabase(url: file) }
        #expect(try db.sql.rows("SELECT value FROM sentinel").first?.string("value") == "synthetic survives")
        #expect(try db.sql.rows("PRAGMA user_version").first?.int("user_version") == 2)
        let malformed = directory.appendingPathComponent("malformed.sqlite")
        let invalid = try KMSQLite(url: malformed)
        try invalid.execute("CREATE TABLE sentinel (value TEXT)")
        #expect(throws: (any Error).self) { try KMStoreDatabase(url: malformed) }
        #expect(try invalid.rows("PRAGMA user_version").first?.int("user_version") == 0)
    }
    @Test func staleDatabaseRevisionCannotOverwriteAnotherWriter() throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("shared.sqlite")
        let first = try KMStoreDatabase(url: path), second = try KMStoreDatabase(url: path)
        let oldFirst = try first.load(), oldSecond = try second.load()
        oldFirst.accountValues = [.init(id: "winner", name: "合成の先行保存")]
        try first.save(oldFirst)
        oldSecond.accountValues = [.init(id: "stale", name: "合成の古いsnapshot")]
        #expect(throws: (any Error).self) { try second.save(oldSecond) }
        #expect(try first.load().accountValues.map(\.id) == ["winner"])
    }
    @Test func importsRealPWABackupWithImagesStatementsAndIDs() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory), before = try await seed(store), old = try store.profile().current
        try await store.importBackup(from: fixture("synthetic", "kmb"))
        let reopened = try KMSQLiteStore(directory: directory)
        #expect(try reopened.profile().previous == old)
        #expect(try await reopened.transaction(id: before.id) == nil)
        let seed = try KMJSON.decoder().decode(KMMigrationFixture.self, from: Data(contentsOf: fixture("fixture", "json")))
        let transactions = try await reopened.transactions(matching: .init(limit: nil)), accounts = try await reopened.accounts(), categories = try await reopened.categories()
        // The exported archive additionally contains the registered 2,138-yen image receipt (12, not 11 rows).
        #expect(transactions.count == seed.transactions.count + 1)
        for expected in seed.transactions {
            #expect(transactions.contains { value in
                value.date == expected.date && value.payeeName == expected.payee
                    && value.amountYen == (expected.type == .expense ? -expected.amountYen : expected.amountYen)
                    && value.categoryName == expected.category && accounts.first { $0.id == value.accountId }?.name == expected.account
            })
        }
        #expect(Set(accounts.map(\.name)) == Set(seed.accounts.map(\.name)))
        for expected in seed.accounts { #expect(accounts.first { $0.name == expected.name }?.accountType == expected.type) }
        for name in seed.categories + [seed.incomeCategory] { #expect(categories.contains { $0.name == name }) }
        #expect(try await reopened.payees().contains { $0.name == "スーパーみどり" && !$0.id.hasPrefix("fixture-") })
        let home = try await reopened.home(month: KMYearMonth("2026-10"))
        #expect(home.summary.expenseYen == 24730 + seed.receipt.totalYen)
        #expect(home.summary.incomeYen == 248000)
        #expect(home.budget.budgetYen == seed.budgetYen)
        #expect(try await reopened.receipts().count == 12) // 11 registered receipts + one unregistered draft
        let receipt = try #require(try await reopened.receipts().first { $0.image != nil })
        #expect(receipt.confirmedValue?.totalAmountYen == seed.receipt.totalYen)
        let blobId = try #require(receipt.image?.blobId), image = try #require(try await reopened.receiptImage(blobId: blobId))
        #expect(image.prefix(8) == Data([137, 80, 78, 71, 13, 10, 26, 10]))
        #expect(image.count == receipt.image?.sizeBytes)
        #expect(try await reopened.transaction(id: #require(receipt.registration.actualTransactionId))?.amountYen == -seed.receipt.totalYen)
        let statements = try await reopened.statementTransactions()
        #expect(statements.count == seed.statement.count)
        for expected in seed.statement { #expect(statements.contains { $0.merchant == expected.merchant && $0.amountYen == expected.amountYen }) }
        let source = try #require(try await reopened.statementImports().first)
        let csv = try #require(try reopened.originalArtifact(id: "statement-source:\(source.id)"))
        #expect(KMPortableBackup.sha256(csv) == source.value.fileHash)
        let run = try #require(try await reopened.latestRun())
        #expect(run.statementResults.filter { $0.status == .matched }.count == 4)
        #expect(run.statementResults.filter { $0.status == .needsReview }.count == 1)
        #expect(run.statementResults.filter { $0.status == .unmatchedStatement }.count == 2)
        #expect(try await reopened.resolutions().filter { $0.status == .applied }.count == 4)
        try reopened.returnToPreviousProfile()
        #expect(try await reopened.transaction(id: before.id) == before)
        try reopened.returnToPreviousProfile()
        #expect(try await reopened.transactions(matching: .init(limit: nil)).count == 12)
    }

    /// Rebuild a container with honest hashes, so schema/path tests cannot pass solely on a checksum error.
    private func rewrite(_ bytes: Data, manifest changeManifest: (inout [String: Any]) throws -> Void = { _ in },
                         local changeLocal: ((inout [String: Any]) throws -> Void)? = nil,
                         actual changeActual: ((Data) throws -> Data)? = nil) throws -> Data {
        let n = bytes[8..<12].reduce(0) { $0 * 256 + Int($1) }
        var manifest = try #require(try JSONSerialization.jsonObject(with: bytes.subdata(in: 12..<12+n)) as? [String: Any])
        var entries = try #require(manifest["entries"] as? [[String: Any]])
        var cursor = 12 + n, payload = Data()
        for index in entries.indices {
            let size = try #require(entries[index]["size"] as? Int)
            var data = bytes.subdata(in: cursor..<cursor+size); cursor += size
            if entries[index]["path"] as? String == "local-data.json", let changeLocal {
                var object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any]); try changeLocal(&object)
                data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            }
            if entries[index]["path"] as? String == "actual-budget.zip", let changeActual { data = try changeActual(data) }
            entries[index]["size"] = data.count; entries[index]["sha256"] = KMPortableBackup.sha256(data); payload.append(data)
        }
        manifest["entries"] = entries; try changeManifest(&manifest)
        let json = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        var result = Data("KMATCHB1".utf8)
        let length = UInt32(json.count)
        result.append(contentsOf: [UInt8(length >> 24), UInt8((length >> 16) & 255), UInt8((length >> 8) & 255), UInt8(length & 255)])
        result.append(json); result.append(payload); return result
    }
    @Test func rejectsInvalidArchivesWithoutChangingExistingProfile() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory), original = try await seed(store), id = try store.profile().current
        let bytes = try Data(contentsOf: fixture("synthetic", "kmb"))
        var corrupt = bytes; corrupt[corrupt.count - 1] ^= 1
        let variants: [Data] = try [
            Data(bytes.dropLast()), bytes + Data([0]), corrupt,
            rewrite(bytes, manifest: { $0["backupFormatVersion"] = 2 }),
            rewrite(bytes, manifest: { $0["localDataSchemaVersion"] = 1 }),
            rewrite(bytes, manifest: { $0["unexpected"] = true }),
            rewrite(bytes, manifest: { $0["missingRawArtifacts"] = [["id": "fake", "ownerKind": "receipt", "ownerId": "fake", "contentType": NSNull()]] }),
            rewrite(bytes, manifest: { m in var e = m["entries"] as! [[String: Any]]; e[0]["path"] = "../actual-budget.zip"; m["entries"] = e }),
            rewrite(bytes, manifest: { m in var e = m["entries"] as! [[String: Any]]; e[0]["size"] = KMPortableBackup.maxEntry + 1; m["entries"] = e }),
            rewrite(bytes, manifest: { m in var e = m["entries"] as! [[String: Any]]; e[1]["path"] = "actual-budget.zip"; m["entries"] = e }),
            rewrite(bytes, local: { $0["schemaVersion"] = 1 }),
            rewrite(bytes, local: { d in var r = d["records"] as! [[String: Any]]; r[0]["kind"] = "future-record"; d["records"] = r }),
            rewrite(bytes, local: { d in var r = d["records"] as! [[String: Any]]; r.append(r[0]); d["records"] = r }),
            rewrite(bytes, local: { d in var r = d["records"] as! [[String: Any]]; var v = r[0]["value"] as! [String: Any]; v["futureField"] = true; r[0]["value"] = v; d["records"] = r }),
            rewrite(bytes, local: { d in var r = d["records"] as! [[String: Any]]; var v = r[0]["value"] as! [String: Any]; v.removeValue(forKey: "externalId"); r[0]["value"] = v; d["records"] = r }),
            rewrite(bytes, local: { d in var r = d["records"] as! [[String: Any]]; var v = r[0]["value"] as! [String: Any]; v["amountYen"] = 1.5; r[0]["value"] = v; d["records"] = r })
        ]
        let file = directory.appendingPathComponent("bad.kmb")
        for data in variants {
            try data.write(to: file)
            await #expect(throws: (any Error).self) { try await store.importBackup(from: file) }
            #expect(try store.profile().current == id)
            #expect(try await store.transaction(id: original.id) == original)
        }
        for path in ["/absolute", "a\\b", "a//b", "a/./b", "a/../b", "a/", "A.zip", "", String(repeating: "a", count: 257)] { #expect(!KMPortableBackup.safePath(path)) }
    }
    private func changeZIP(_ bytes: Data, in directory: URL, _ change: (KMSQLite) throws -> Void) throws -> Data {
        let input = directory.appendingPathComponent("input.zip"), output = directory.appendingPathComponent("output.zip")
        let dbFile = directory.appendingPathComponent("db.sqlite"), metadata = directory.appendingPathComponent("metadata.json")
        try bytes.write(to: input)
        let archive = try Archive(url: input, accessMode: .read)
        for (name, target) in [("db.sqlite", dbFile), ("metadata.json", metadata)] {
            _ = try archive.extract(#require(archive[name]), to: target)
        }
        try change(KMSQLite(url: dbFile))
        let result = try Archive(url: output, accessMode: .create)
        try result.addEntry(with: "db.sqlite", fileURL: dbFile, compressionMethod: .deflate)
        try result.addEntry(with: "metadata.json", fileURL: metadata, compressionMethod: .deflate)
        return try Data(contentsOf: output)
    }
    @Test func failedActualStagingKeepsExistingDataAndCleansTarget() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory), row = try await seed(store), id = try store.profile().current
        let bytes = try Data(contentsOf: fixture("synthetic", "kmb")), editDirectory = try temporary()
        defer { try? FileManager.default.removeItem(at: editDirectory) }
        let altered = try rewrite(bytes, actual: { zip in
            try changeZIP(zip, in: editDirectory) { try $0.execute("INSERT INTO __migrations__ VALUES(9999999999999)") }
        })
        let file = directory.appendingPathComponent("future.kmb"); try altered.write(to: file)
        let directoriesBefore = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        await #expect(throws: (any Error).self) { try await store.importBackup(from: file) }
        #expect(try store.profile().current == id)
        #expect(try await store.transaction(id: row.id) == row)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted() == directoriesBefore)
    }
}

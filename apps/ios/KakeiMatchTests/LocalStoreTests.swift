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
    @Test func migrationZeroToFourAndFutureVersionAreNonDestructive() throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("v0.sqlite")
        let db = try KMStoreDatabase(url: file)
        #expect(try db.sql.rows("PRAGMA user_version").first?.int("user_version") == 4)
        #expect(try db.load().transactionValues.isEmpty)
        try db.sql.execute("CREATE TABLE sentinel (value TEXT)")
        try db.sql.execute("INSERT INTO sentinel VALUES('synthetic survives')")
        try db.sql.execute("PRAGMA user_version=5")
        #expect(throws: (any Error).self) { try KMStoreDatabase(url: file) }
        #expect(try db.sql.rows("SELECT value FROM sentinel").first?.string("value") == "synthetic survives")
        #expect(try db.sql.rows("PRAGMA user_version").first?.int("user_version") == 5)
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
    @Test func nativeBackupRoundTripsEveryProjectionAndOriginal() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let source = try KMSQLiteStore(directory: directory.appendingPathComponent("source"))
        try await source.importBackup(from: fixture("synthetic", "kmb"))
        let beforeHome = try await source.home(month: KMYearMonth("2026-10"))
        let beforeTransactions = try await source.transactions(matching: .init(limit: nil))
        let beforeAccounts = try await source.accounts(), beforeCategories = try await source.categories()
        let beforeReceipts = try await source.receipts(), beforeStatements = try await source.statementTransactions()
        let beforeRuns = try await source.latestRun(), beforeResolutions = try await source.resolutions()
        let beforeBudget = try await source.budgetSettings(), beforePayroll = try await source.payrollRecords()
        let originalRecords = try source.importedRecords()
        let original = try #require(beforeReceipts.first { $0.image != nil })
        let blobId = try #require(original.image?.blobId)
        let image = try #require(try await source.receiptImage(blobId: blobId))
        let importRecord = try #require(try await source.statementImports().first)
        let csv = try #require(try source.originalArtifact(id: "statement-source:\(importRecord.id)"))
        let output = try await source.exportNativeBackup()
        #expect(output.pathExtension == "kmib")
        let parsedBackup = try KMNativeBackup.read(url: output)
        #expect(parsedBackup.artifacts.count == 2)
        #expect(try await source.settings().lastExportAt != nil)
        let restored = try KMSQLiteStore(directory: directory.appendingPathComponent("restored"))
        try await restored.saveSettings(.init(theme: .dark))
        try await restored.importBackup(from: output)
        #expect(try await restored.transactions(matching: .init(limit: nil)) == beforeTransactions)
        #expect(try await restored.accounts() == beforeAccounts)
        #expect(try await restored.categories() == beforeCategories)
        #expect(try await restored.receipts() == beforeReceipts)
        #expect(try await restored.statementTransactions() == beforeStatements)
        #expect(try await restored.latestRun() == beforeRuns)
        #expect(try await restored.resolutions() == beforeResolutions)
        #expect(try await restored.budgetSettings() == beforeBudget)
        #expect(try await restored.payrollRecords() == beforePayroll)
        #expect(try await restored.home(month: KMYearMonth("2026-10")) == beforeHome)
        #expect(try await restored.receiptImage(blobId: blobId) == image)
        #expect(try restored.originalArtifact(id: "statement-source:\(importRecord.id)") == csv)
        let restoredRecords = try restored.importedRecords()
        #expect(restoredRecords.map(\.id) == originalRecords.map(\.id))
        #expect(restoredRecords.map(\.kind.rawValue) == originalRecords.map(\.kind.rawValue))
        #expect(restoredRecords.map(\.value) == originalRecords.map(\.value))
        #expect(restoredRecords.map(\.updatedAt) == originalRecords.map(\.updatedAt))
        #expect(try await restored.settings().theme == .dark) // Keep device-local appearance while restoring all originals.
    }

    private func rewriteNative(_ data: Data, _ change: (inout [String: Any]) -> Void) throws -> Data {
        let length = data[8..<12].reduce(0) { $0 * 256 + Int($1) }
        var manifest = try #require(try JSONSerialization.jsonObject(with: data.subdata(in: 12..<12 + length)) as? [String: Any])
        change(&manifest)
        let json = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        var result = KMNativeBackup.magic
        let size = UInt32(json.count)
        result.append(contentsOf: [UInt8(size >> 24), UInt8((size >> 16) & 255), UInt8((size >> 8) & 255), UInt8(size & 255)])
        result.append(json); result.append(data.dropFirst(12 + length)); return result
    }
    @Test func nativeBackupRejectsCorruptionFutureVersionAndUnsafePathsWithoutSwitching() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory), row = try await seed(store), active = try store.profile().current
        let dbURL = directory.appendingPathComponent("fixture.sqlite")
        try KMStoreDatabase(url: dbURL).snapshot(to: directory.appendingPathComponent("unused.sqlite"))
        let snapshot = try Data(contentsOf: directory.appendingPathComponent("unused.sqlite"))
        let good = try KMNativeBackup.package(database: snapshot, artifacts: [], exportedAt: Date())
        let damaged = directory.appendingPathComponent("damaged.kmib")
        var bytes = good; bytes[bytes.count - 1] ^= 1
        let variants = try [bytes,
            rewriteNative(good) { $0["formatVersion"] = 2 },
            rewriteNative(good) { manifest in var entries = manifest["entries"] as! [[String: Any]]; entries[0]["path"] = "../household.sqlite"; manifest["entries"] = entries },
            rewriteNative(good) { manifest in var entries = manifest["entries"] as! [[String: Any]]; entries[0]["size"] = KMNativeBackup.maxEntry + 1; manifest["entries"] = entries }
        ]
        for variant in variants {
            try variant.write(to: damaged)
            await #expect(throws: (any Error).self) { try await store.importBackup(from: damaged) }
            #expect(try store.profile().current == active)
            #expect(try await store.transaction(id: row.id) == row)
        }
        var pwa = try Data(contentsOf: fixture("synthetic", "kmb"))
        let pwaURL = directory.appendingPathComponent("pwa.kmb"); try pwa.write(to: pwaURL)
        try await store.importBackup(from: pwaURL)
        #expect(try store.profile().previous == active)
        #expect(try await store.transactions(matching: .init(limit: nil)).count == 12)
        pwa.removeAll()
    }

    @Test func importsRealPWABackupWithImagesStatementsAndIDs() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory), before = try await seed(store), old = try store.profile().current
        try await store.saveSettings(.init(theme: .dark))
        try await store.importBackup(from: fixture("synthetic", "kmb"))
        let reopened = try KMSQLiteStore(directory: directory)
        #expect(try reopened.profile().previous == old)
        #expect(try await reopened.settings().theme == .dark)
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
        #expect(try reopened.importedRecords().count == 44)
        #expect(try reopened.importedRecords().contains { $0.kind == .correctionAudit })
        let observations = try reopened.importedRecords().filter { record in
            guard record.kind == .correctionAudit else { return false }
            return try record.object()["targetType"] as? String == "category-learning"
        }.map { try $0.decode(KMCategoryLearningObservation.self) }
        #expect(!observations.isEmpty)
        #expect(try await reopened.categoryObservations() == observations)
        let derived = KMCategoryLearningService.deriveStats(observations: observations, availableCategoryIds: Set(categories.filter { !$0.isIncome }.map(\.id)))
        #expect(try await reopened.categoryRules() == KMCategoryLearningService.applyingOverrides(derived, overrides: [], availableCategoryIds: Set(categories.map(\.id))))
        await #expect(throws: KMReconciliationError("stale_run")) {
            try await reopened.ignoreStatement(runId: run.runId, statementId: statements[0].id, at: run.createdAt)
        }
        // Recreate v1's persisted layout and recover imported history from its untouched provenance.
        let profile = try reopened.profile().current
        let database = try KMStoreDatabase(url: directory.appendingPathComponent(profile.uuidString).appendingPathComponent("household.sqlite"))
        try database.sql.execute("DELETE FROM objects WHERE collection IN ('service-state','ledger-writes')")
        try database.sql.execute("PRAGMA user_version=1")
        let migrated = try KMSQLiteStore(directory: directory)
        #expect(try await migrated.categoryObservations() == observations)
        #expect(try await migrated.latestRun() == run)
        let decisions = try await reopened.resolutions()
        #expect(try await migrated.resolutions() == decisions)
        #expect(try await migrated.transactions(matching: .init(limit: nil)) == transactions)
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
            rewrite(bytes, manifest: { m in m["entries"] = Array(repeating: (m["entries"] as! [[String: Any]])[0], count: 10001) }),
            rewrite(bytes, manifest: { m in var raw = m["rawArtifacts"] as! [[String: Any]]; raw[0]["ownerId"] = "missing-owner"; m["rawArtifacts"] = raw }),
            rewrite(bytes, manifest: { m in var raw = m["rawArtifacts"] as! [[String: Any]]; raw[0]["present"] = false; m["rawArtifacts"] = raw }),
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
    @Test func rejectsUnsafeZIPNamesAndSymlinksBeforeExtraction() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory), row = try await seed(store), id = try store.profile().current
        let bytes = try Data(contentsOf: fixture("synthetic", "kmb"))
        for (name, type) in [("../escape", Entry.EntryType.file), ("C:/escape", .file), ("link", .symlink)] {
            let zip = directory.appendingPathComponent(UUID().uuidString + ".zip")
            let archive = try Archive(url: zip, accessMode: .create)
            try archive.addEntry(with: name, type: type, uncompressedSize: Int64(1)) { _, _ in Data([0]) }
            let malformed = try rewrite(bytes, actual: { _ in try Data(contentsOf: zip) })
            let file = directory.appendingPathComponent("unsafe.kmb"); try malformed.write(to: file)
            await #expect(throws: (any Error).self) { try await store.importBackup(from: file) }
            #expect(try store.profile().current == id)
            #expect(try await store.transaction(id: row.id) == row)
            #expect(!FileManager.default.fileExists(atPath: directory.deletingLastPathComponent().appendingPathComponent("escape").path))
        }
    }
    @Test func acceptsDeclaredMissingOriginalsWithoutLosingRecords() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let source = try fixture("synthetic", "kmb"), backup = try KMPortableBackup.read(url: source)
        var manifest = try #require(try JSONSerialization.jsonObject(with: backup.manifestJSON) as? [String: Any])
        var missing: [[String: Any]] = []
        for record in backup.records {
            if record.kind == .statementImport { missing.append(["id": "statement-source:\(record.id)", "ownerKind": "statement-import", "ownerId": record.id, "contentType": NSNull()]) }
            if record.kind == .receiptMetadata, let image = try record.decode(KMReceipt.self).image {
                missing.append(["id": image.blobId, "ownerKind": "receipt", "ownerId": record.id, "contentType": image.contentType])
            }
        }
        manifest["entries"] = (manifest["entries"] as! [[String: Any]]).filter { !($0["path"] as! String).hasPrefix("artifacts/") }
        manifest["rawArtifacts"] = []; manifest["missingRawArtifacts"] = missing
        let json = try JSONSerialization.data(withJSONObject: manifest)
        var data = Data("KMATCHB1".utf8); let n = UInt32(json.count)
        data.append(contentsOf: [UInt8(n >> 24), UInt8((n >> 16) & 255), UInt8((n >> 8) & 255), UInt8(n & 255)])
        data.append(json); data.append(backup.actualZIP); data.append(backup.localJSON)
        let file = directory.appendingPathComponent("missing.kmb"); try data.write(to: file)
        let store = try KMSQLiteStore(directory: directory); try await store.importBackup(from: file)
        #expect(try await store.transactions(matching: .init(limit: nil)).count == 12)
        #expect(try await store.receipts().count == 12)
        #expect(try await store.statementTransactions().count == 7)
        let receipt = try #require(try await store.receipts().first { $0.image != nil })
        #expect(try await store.receiptImage(blobId: #require(receipt.image?.blobId)) == nil)
        #expect(try store.originalArtifact(id: "statement-source:\(backup.records.first { $0.kind == .statementImport }!.id)") == nil)
    }
    @Test func actualSplitsTransfersOpeningBalancesAndOffbudgetAreProjected() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let editDirectory = try temporary(); defer { try? FileManager.default.removeItem(at: editDirectory) }
        let bytes = try Data(contentsOf: fixture("synthetic", "kmb"))
        let altered = try rewrite(bytes, actual: { zip in
            try changeZIP(zip, in: editDirectory) { db in
                let bank = try #require(try db.rows("SELECT id FROM accounts WHERE name='メイン口座'").first?.string("id"))
                let cash = try #require(try db.rows("SELECT id FROM accounts WHERE name='現金'").first?.string("id"))
                let food = try #require(try db.rows("SELECT id FROM categories WHERE name='食費'").first?.string("id"))
                let daily = try #require(try db.rows("SELECT id FROM categories WHERE name='日用品'").first?.string("id"))
                try db.execute("INSERT INTO accounts(id,name,offbudget) VALUES('off','合成対象外口座',1)")
                try db.execute("UPDATE category_groups SET hidden=1 WHERE is_income=1")
                for (id, account, amount, category) in [("split", bank, -3000, food), ("child-a", bank, -1000, food),
                    ("child-b", bank, -2000, daily), ("out", bank, -10000, food), ("in", cash, 10000, food),
                    ("opening", cash, 50000, food), ("off-tx", "off", -500, food)] {
                    try db.execute("INSERT INTO transactions(id,acct,date,amount,category) VALUES(?,?,20261014,?,?)",
                        [.text(id), .text(account), .integer(amount), .text(category)])
                }
                try db.execute("UPDATE transactions SET isParent=1,category=NULL WHERE id='split'")
                try db.execute("UPDATE transactions SET isChild=1,parent_id='split' WHERE id IN ('child-a','child-b')")
                try db.execute("UPDATE transactions SET transferred_id='in',category=NULL WHERE id='out'")
                try db.execute("UPDATE transactions SET transferred_id='out',category=NULL WHERE id='in'")
                try db.execute("UPDATE transactions SET starting_balance_flag=1 WHERE id='opening'")
                try db.execute("INSERT INTO zero_budgets(id,month,category,amount) VALUES('native-test',202610,?,60000)", [.text(food)])
            }
        })
        let file = directory.appendingPathComponent("edges.kmb"); try altered.write(to: file)
        let store = try KMSQLiteStore(directory: directory); try await store.importBackup(from: file)
        #expect(try await store.transaction(id: "split")?.splits?.map(\.amountYen) == [-1000, -2000])
        #expect(try await store.transactions(matching: .init(kind: .transfer)).map(\.id) == ["out"])
        #expect(try await store.home(month: KMYearMonth("2026-10")).summary.expenseYen == 29868)
        #expect(try await store.accounts().first { $0.name == "現金" }?.balanceYen == 58340)
        #expect(try await store.transaction(id: "opening") == nil)
        #expect(try await store.categories(includeHidden: false).allSatisfy { !$0.isIncome })
        #expect(try await store.categories().first { $0.name == "給与" }?.hidden == true)
        let budgetId = try await store.budgetSettings().budgetId
        try await store.saveBudgetSettings(.empty(budgetId: budgetId))
        #expect(try await store.budgetSummary(month: KMYearMonth("2026-10")).budgetYen == 60000)
        // Simulate the actual v3 representation: hidden dated rows were flattened into base balances.
        let beforeCutoff = try await store.accounts(asOf: KMDate("2026-10-13"))
        let path = directory.appendingPathComponent(try store.profile().current.uuidString).appendingPathComponent("household.sqlite")
        let db = try KMStoreDatabase(url: path), legacy = try db.load()
        for entry in legacy.masterWriteState.balanceEntries {
            let index = try #require(legacy.accountValues.firstIndex { $0.id == entry.accountId })
            legacy.accountValues[index].balanceYen = try KMYen.add(legacy.accountValues[index].balanceYen, entry.amountYen)
        }
        try db.save(legacy)
        try db.sql.execute("DELETE FROM objects WHERE collection='master-writes'")
        try db.sql.execute("PRAGMA user_version=3")
        let migrated = try KMSQLiteStore(directory: directory)
        #expect(try await migrated.accounts(asOf: KMDate("2026-10-13")) == beforeCutoff)
        #expect(try await migrated.accounts().first { $0.name == "現金" }?.balanceYen == 58340)
        #expect(try await migrated.transaction(id: "split")?.splits?.map(\.amountYen) == [-1000, -2000])
    }
    @Test func failedActualStagingKeepsExistingDataAndCleansTarget() async throws {
        let directory = try temporary(); defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory), row = try await seed(store), id = try store.profile().current
        let bytes = try Data(contentsOf: fixture("synthetic", "kmb"))
        for sql in ["INSERT INTO __migrations__ VALUES(9999999999999)",
                    "INSERT INTO preferences(id,value) VALUES('defaultCurrencyCode','USD')",
                    "INSERT INTO schedules(id,completed,tombstone) VALUES('unsupported-schedule',0,0)",
                    "UPDATE transactions SET amount=amount+1 WHERE id='e9098745-2f4a-4bda-a534-1ca975c40c72'"] {
            let editDirectory = try temporary(); defer { try? FileManager.default.removeItem(at: editDirectory) }
            let altered = try rewrite(bytes, actual: { zip in
                try changeZIP(zip, in: editDirectory) { db in
                    try db.execute(sql)
                    // Last case also makes a malformed split, forcing a failure after the target was allocated.
                    if sql.hasPrefix("UPDATE") { try db.execute("UPDATE transactions SET isParent=1 WHERE id='e9098745-2f4a-4bda-a534-1ca975c40c72'") }
                }
            })
            let file = directory.appendingPathComponent("bad-actual.kmb"); try altered.write(to: file)
            let directoriesBefore = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
            await #expect(throws: (any Error).self) { try await store.importBackup(from: file) }
            #expect(try store.profile().current == id)
            #expect(try await store.transaction(id: row.id) == row)
            #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted() == directoriesBefore)
        }
    }
}

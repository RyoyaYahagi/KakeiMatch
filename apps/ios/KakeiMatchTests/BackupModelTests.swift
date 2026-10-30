import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct BackupModelTests {
    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func seed(_ store: KMSQLiteStore, payee: String, amountYen: Int) async throws {
        try await store.saveAccount(.init(id: "backup-cash", name: "合成現金", accountType: .cash))
        try await store.saveCategory(.init(id: "backup-food", name: "食費"))
        _ = try await store.saveManual(.init(kind: .expense, amountYen: amountYen, date: KMDate("2026-10-14"),
            payeeName: payee, categoryId: "backup-food", accountId: "backup-cash", memo: nil,
            importedId: "backup-\(payee)"))
    }

    @Test func exportCreatesKMIBAndRecordsTimestamp() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        try await seed(store, payee: "合成書き出し店", amountYen: 321)
        let repositories = KMRepositories(persistent: store)
        let model = KMBackupModel()

        await model.load(repositories)
        #expect(model.lastExportAt == nil)
        #expect(!model.canRestorePrevious)

        await model.export(repositories)
        #expect(model.exportStatus == KMBackupPresentation.exported)
        let output = try #require(model.exportedFileURL)
        #expect(output.pathExtension == "kmib")
        #expect(output.lastPathComponent.hasPrefix("KakeiMatch-"))
        #expect(FileManager.default.fileExists(atPath: output.path))
        #expect(try KMNativeBackup.read(url: output).exportedAt <= Date())
        #expect(model.lastExportAt != nil)
        #expect(try await repositories.settings.settings().lastExportAt != nil)
    }

    @Test func restoreWithoutConfirmationDoesNotReplaceCurrentHousehold() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = try KMSQLiteStore(directory: directory.appendingPathComponent("source"))
        try await seed(source, payee: "合成未確認復元店", amountYen: 900)
        let backup = try await source.exportNativeBackup()

        let target = try KMSQLiteStore(directory: directory.appendingPathComponent("target"))
        try await seed(target, payee: "合成未確認保持店", amountYen: 456)
        let before = try await target.transactions(matching: .init(limit: nil))
        let profileBefore = try target.profile()
        let restored = await KMBackupModel().restore(from: backup,
            repositories: KMRepositories(persistent: target), confirmed: false)

        #expect(!restored)
        #expect(try target.profile().current == profileBefore.current)
        #expect(try await target.transactions(matching: .init(limit: nil)) == before)
    }

    @Test func failedRestoreKeepsCurrentHouseholdAndProfile() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = try KMSQLiteStore(directory: directory.appendingPathComponent("source"))
        try await seed(source, payee: "合成復元元店", amountYen: 900)
        let good = try await source.exportNativeBackup()
        var damaged = try Data(contentsOf: good)
        damaged[damaged.count - 1] ^= 1
        let damagedURL = directory.appendingPathComponent("damaged.kmib")
        try damaged.write(to: damagedURL)
        #expect(throws: (any Error).self) { _ = try KMNativeBackup.read(url: damagedURL) }

        let target = try KMSQLiteStore(directory: directory.appendingPathComponent("target"))
        try await seed(target, payee: "合成保持店", amountYen: 456)
        let repositories = KMRepositories(persistent: target)
        let before = try await target.transactions(matching: .init(limit: nil))
        let profileBefore = try target.profile()
        let model = KMBackupModel()

        let restored = await model.restore(from: damagedURL, repositories: repositories, confirmed: true)

        #expect(!restored)
        #expect(model.importStatus?.contains("チェックサム") == true)
        #expect(try target.profile().current == profileBefore.current)
        #expect(try await target.transactions(matching: .init(limit: nil)) == before)
    }

    @Test func failedRestoreAfterStagingKeepsCurrentHouseholdAndRemovesPartialProfile() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }

        let source = try KMSQLiteStore(directory: directory.appendingPathComponent("source"))
        try await seed(source, payee: "合成ステージ店", amountYen: 900)
        let validURL = try await source.exportNativeBackup()
        let valid = try KMNativeBackup.read(url: validURL)
        // The archive is structurally valid, but claims an artifact absent from its SQLite DB.
        // Import writes the new profile before detecting the mismatch, exercising stage cleanup.
        let invalidArchive = try KMNativeBackup.package(database: valid.database,
            artifacts: [("missing-artifact", Data("合成原本".utf8))], exportedAt: Date())
        let invalidURL = directory.appendingPathComponent("valid-container-invalid-artifacts.kmib")
        try invalidArchive.write(to: invalidURL)

        let targetDirectory = directory.appendingPathComponent("target")
        let target = try KMSQLiteStore(directory: targetDirectory)
        try await seed(target, payee: "合成現行店", amountYen: 456)
        let repositories = KMRepositories(persistent: target)
        let before = try await target.transactions(matching: .init(limit: nil))
        let profileBefore = try target.profile()
        let profileDirectoriesBefore = try FileManager.default.contentsOfDirectory(at: targetDirectory,
            includingPropertiesForKeys: nil).filter { $0.hasDirectoryPath }.map(\.lastPathComponent).sorted()

        let restored = await KMBackupModel().restore(from: invalidURL, repositories: repositories, confirmed: true)

        #expect(!restored)
        #expect(try target.profile().current == profileBefore.current)
        #expect(try target.profile().previous == profileBefore.previous)
        #expect(try await target.transactions(matching: .init(limit: nil)) == before)
        let profileDirectoriesAfter = try FileManager.default.contentsOfDirectory(at: targetDirectory,
            includingPropertiesForKeys: nil).filter { $0.hasDirectoryPath }.map(\.lastPathComponent).sorted()
        #expect(profileDirectoriesAfter == profileDirectoriesBefore)
    }

    @Test func restoreNativeBackupSwitchesAndCanReturnToPreviousData() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = try KMSQLiteStore(directory: directory.appendingPathComponent("source"))
        try await seed(source, payee: "合成復元先店", amountYen: 1200)
        let backup = try await source.exportNativeBackup()
        let importedTransactions = try await source.transactions(matching: .init(limit: nil))

        let target = try KMSQLiteStore(directory: directory.appendingPathComponent("target"))
        try await seed(target, payee: "合成現在店", amountYen: 700)
        let repositories = KMRepositories(persistent: target)
        let originalTransactions = try await target.transactions(matching: .init(limit: nil))
        let model = KMBackupModel()

        let restored = await model.restore(from: backup, repositories: repositories, confirmed: true)
        #expect(restored)
        #expect(model.importStatus == KMBackupPresentation.restored)
        #expect(try await target.transactions(matching: .init(limit: nil)) == importedTransactions)
        #expect(model.canRestorePrevious)

        let returned = await model.restorePrevious(repositories)
        #expect(returned)
        #expect(model.previousStatus == KMBackupPresentation.previousRestored)
        #expect(try await target.transactions(matching: .init(limit: nil)) == originalTransactions)
    }

    @Test func missingLocalStoreReportsWithoutTouchingData() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let model = KMBackupModel()
        await model.load(repositories)
        await model.export(repositories)
        #expect(model.exportedFileURL == nil)
        #expect(model.exportStatus == KMBackupPresentation.storeUnavailable)
        let restored = await model.restore(from: URL(fileURLWithPath: "/nonexistent.kmb"), repositories: repositories, confirmed: true)
        #expect(!restored)
        #expect(model.importStatus == KMBackupPresentation.storeUnavailable)
    }
}

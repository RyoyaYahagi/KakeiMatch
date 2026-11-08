import Foundation
import Testing
@testable import KakeiMatch

@MainActor
struct MuseSnapshotRestoreRejectionTests {
    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func existingRestoreRejectsSnapshotAndKeepsCurrentHousehold() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        try await store.saveAccount(.init(id: "snapshot-cash", name: "合成現金", accountType: .cash))
        try await store.saveCategory(.init(id: "snapshot-food", name: "食費"))
        _ = try await store.saveManual(.init(kind: .expense, amountYen: 640, date: KMDate("2026-10-03"),
            payeeName: "合成コンビニ", categoryId: "snapshot-food", accountId: "snapshot-cash",
            memo: nil, importedId: "snapshot-reject-1"))

        let snapshot = try MuseSnapshotTestFiles.sampleURL("snapshot-sample-normal.json")
        let before = try await store.transactions(matching: .init(limit: nil))
        let profileBefore = try store.profile()

        await #expect(throws: KMDataError.self) {
            try await store.importBackup(from: snapshot)
        }

        #expect(try store.profile().current == profileBefore.current)
        #expect(try store.profile().previous == profileBefore.previous)
        #expect(try await store.transactions(matching: .init(limit: nil)) == before)
        #expect(try await store.accounts(includeClosed: true).map(\.id) == ["snapshot-cash"])
    }

    @Test func backupModelReportsJapaneseFailureWithoutSwitchingProfile() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        let repositories = KMRepositories(persistent: store)
        let profileBefore = try store.profile()
        let model = KMBackupModel()

        let restored = await model.restore(
            from: try MuseSnapshotTestFiles.sampleURL("snapshot-sample-normal.json"),
            repositories: repositories, confirmed: true)

        #expect(!restored)
        #expect(model.importStatus?.contains("バックアップの形式") == true)
        #expect(try store.profile().current == profileBefore.current)
        #expect(try store.profile().previous == profileBefore.previous)
    }
}

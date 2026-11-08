import Foundation
import Testing
@testable import KakeiMatch

@MainActor
struct MuseExportModelTests {
    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func instant(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return try #require(formatter.date(from: value))
    }

    private func store() -> KMInMemoryStore {
        KMInMemoryStore(
            transactions: [
                KMTransaction(id: "tx-export-1", date: KMDate(rawValue: "2026-10-05"), amountYen: -1280,
                    kind: .expense, payeeName: "合成ベーカリー", categoryName: "食費", accountId: "acc-export",
                    excludedFromSpending: false, categoryId: "cat-export-food", memo: "合成メモ"),
                KMTransaction(id: "tx-export-2", date: KMDate(rawValue: "2026-09-20"), amountYen: 250000,
                    kind: .income, payeeName: "合成株式会社", categoryName: "給与", accountId: "acc-export",
                    excludedFromSpending: false, categoryId: "cat-export-salary"),
            ],
            accounts: [
                KMAccount(id: "acc-export", name: "合成銀行", accountType: .bank, balanceYen: 248720),
            ],
            categories: [
                KMCategory(id: "cat-export-food", name: "食費"),
                KMCategory(id: "cat-export-salary", name: "給与", isIncome: true),
            ])
    }

    private func repositories(transactions: any TransactionRepository, accounts: any AccountRepository,
                              categories: any CategoryRepository, base: KMInMemoryStore) -> KMRepositories {
        KMRepositories(transactions: transactions, accounts: accounts, categories: categories,
            payees: base, receipts: base, statements: base, reconciliation: base, budgets: base,
            recurring: base, payroll: base, categoryLearning: base, settings: base)
    }

    @Test func defaultRangeIsTwoMonthsBeforeThroughCurrentMonth() throws {
        let model = KMMuseExportModel(today: try instant("2026-11-15T03:00:00Z"))
        #expect(model.fromMonth == (try KMYearMonth("2026-09")))
        #expect(model.toMonth == (try KMYearMonth("2026-11")))
        #expect(model.rangeError == nil)
        #expect(model.canExport)
        #expect(model.rangeSummary == "2026年9月〜2026年11月（3か月）")
    }

    @Test func currentMonthUsesAsiaTokyoAtTheUtcBoundary() throws {
        // 2026-01-31T15:30:00Z is already 2026-02-01 in Asia/Tokyo.
        let model = KMMuseExportModel(today: try instant("2026-01-31T15:30:00Z"))
        #expect(model.toMonth == (try KMYearMonth("2026-02")))
        #expect(model.fromMonth == (try KMYearMonth("2025-12")))
    }

    @Test func rangeValidationRejectsReversedFutureAndLongRanges() throws {
        let current = try KMYearMonth("2026-11")
        #expect(KMMuseExportPresentation.validationMessage(
            from: try KMYearMonth("2026-10"), to: try KMYearMonth("2026-09"), currentMonth: current)
            == KMMuseExportPresentation.reversedRange)
        #expect(KMMuseExportPresentation.validationMessage(
            from: try KMYearMonth("2026-09"), to: try KMYearMonth("2026-12"), currentMonth: current)
            == KMMuseExportPresentation.futureMonth)
        #expect(KMMuseExportPresentation.validationMessage(
            from: try KMYearMonth("2021-01"), to: try KMYearMonth("2026-01"), currentMonth: current)
            == KMMuseExportPresentation.longRange)
        #expect(KMMuseExportPresentation.validationMessage(
            from: try KMYearMonth("2021-12"), to: current, currentMonth: current) == nil)
    }

    @Test func invalidRangeDisablesExportAndShowsJapaneseReason() async throws {
        let base = store()
        let repositories = repositories(transactions: base, accounts: base, categories: base, base: base)
        let model = KMMuseExportModel(today: try instant("2026-11-15T03:00:00Z"))
        model.setToMonth(try KMYearMonth("2026-08"))

        #expect(model.rangeError == KMMuseExportPresentation.reversedRange)
        #expect(!model.canExport)
        await model.export(repositories)
        #expect(model.exportedFileURL == nil)
        #expect(model.isFailure)
        #expect(model.status == KMMuseExportPresentation.reversedRange)
    }

    @Test func missingRepositoriesShowsJapaneseReason() async throws {
        let model = KMMuseExportModel(today: try instant("2026-11-15T03:00:00Z"))
        await model.export(nil)
        #expect(model.exportedFileURL == nil)
        #expect(model.isFailure)
        #expect(model.status == KMMuseExportPresentation.storeUnavailable)
    }

    @Test func exportWritesFormatV1FileWithSelectedRangeAndCounts() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let base = store()
        let repositories = repositories(transactions: base, accounts: base, categories: base, base: base)
        let now = try instant("2026-11-15T00:30:00Z")
        let model = KMMuseExportModel(today: try instant("2026-11-15T03:00:00Z"), now: { now },
            appVersion: { "1.2.3 (45)" }, directory: directory)

        await model.export(repositories)

        #expect(!model.isFailure)
        #expect(model.status == KMMuseExportPresentation.exported)
        let url = try #require(model.exportedFileURL)
        #expect(url.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL)
        #expect(url.lastPathComponent == "kakeimatch-snapshot-20261115-093000.json")
        #expect(FileManager.default.fileExists(atPath: url.path))

        let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        #expect(json["schemaVersion"] as? Int == 1)
        #expect(json["kind"] as? String == "kakeimatch-snapshot")
        #expect(json["timeZone"] as? String == "Asia/Tokyo")
        #expect(json["currency"] as? String == "JPY")
        #expect(json["appVersion"] as? String == "1.2.3 (45)")
        #expect(json["generatedAt"] as? String == "2026-11-15T09:30:00+09:00")
        let range = try #require(json["range"] as? [String: Any])
        #expect(range["fromMonth"] as? String == "2026-09")
        #expect(range["toMonth"] as? String == "2026-11")
        #expect((json["accounts"] as? [Any])?.count == 1)
        #expect((json["transactions"] as? [Any])?.count == 2)
        #expect((json["monthly"] as? [Any])?.count == 3)
        let months = (json["monthly"] as? [[String: Any]])?.compactMap { $0["month"] as? String }
        #expect(months == ["2026-09", "2026-10", "2026-11"])
    }

    @Test func newExportRemovesThePreviousTemporaryFile() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let base = store()
        let repositories = repositories(transactions: base, accounts: base, categories: base, base: base)
        var clock = try instant("2026-11-15T00:00:00Z")
        let model = KMMuseExportModel(today: try instant("2026-11-15T03:00:00Z"), now: { clock },
            appVersion: { nil }, directory: directory)

        await model.export(repositories)
        let first = try #require(model.exportedFileURL)
        #expect(FileManager.default.fileExists(atPath: first.path))

        clock = try instant("2026-11-15T01:00:00Z")
        await model.export(repositories)
        let second = try #require(model.exportedFileURL)

        #expect(first != second)
        #expect(!FileManager.default.fileExists(atPath: first.path))
        #expect(FileManager.default.fileExists(atPath: second.path))
        #expect(second.lastPathComponent == "kakeimatch-snapshot-20261115-100000.json")
    }

    @Test func changingTheRangeClearsThePreviousResult() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let base = store()
        let repositories = repositories(transactions: base, accounts: base, categories: base, base: base)
        var clock = try instant("2026-11-15T00:00:00Z")
        let model = KMMuseExportModel(today: try instant("2026-11-15T03:00:00Z"),
            now: { clock }, appVersion: { nil }, directory: directory)

        await model.export(repositories)
        let first = try #require(model.exportedFileURL)
        model.setFromMonth(try KMYearMonth("2026-10"))
        #expect(model.exportedFileURL == nil)
        #expect(model.status == nil)

        clock = try instant("2026-11-15T01:00:00Z")
        await model.export(repositories)
        let second = try #require(model.exportedFileURL)
        #expect(second != first)
        #expect(!FileManager.default.fileExists(atPath: first.path))
        #expect(FileManager.default.fileExists(atPath: second.path))
    }

    @Test func exportNeverCallsRepositoryWrites() async throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let base = store()
        let readOnly = MuseSnapshotReadOnlyStore(base: base)
        let repositories = repositories(transactions: readOnly, accounts: readOnly, categories: readOnly, base: base)
        let before = try await base.transactions(matching: .init(limit: nil))
        let now = try instant("2026-11-15T00:00:00Z")
        let model = KMMuseExportModel(today: try instant("2026-11-15T03:00:00Z"),
            now: { now }, appVersion: { nil }, directory: directory)

        await model.export(repositories)

        #expect(!model.isFailure)
        #expect(readOnly.writeCalls.isEmpty)
        #expect(try await base.transactions(matching: .init(limit: nil)) == before)
    }

    @Test func failureMessagesAreJapanese() {
        let asciiError = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "disk full"])
        #expect(KMMuseExportPresentation.failure(asciiError)
            == "書き出しに失敗しました。もう一度お試しください。")
        #expect(KMMuseExportPresentation.failure(KMDataError.invalidData("家計データを読み込めません。"))
            == "家計データを読み込めません。")
    }

    @Test func fileNameAndAppVersionFollowTheSpecifiedFormat() throws {
        // 2026-11-07T15:30:00Z is 2026-11-08 00:30 in Asia/Tokyo.
        #expect(KMMuseExportPresentation.fileName(now: try instant("2026-11-07T15:30:00Z"))
            == "kakeimatch-snapshot-20261108-003000.json")
        #expect(KMMuseExportPresentation.appVersion(shortVersion: "0.1.0", build: "202611080000")
            == "0.1.0 (202611080000)")
        #expect(KMMuseExportPresentation.appVersion(shortVersion: "0.1.0", build: nil) == nil)
        #expect(KMMuseExportPresentation.appVersion(shortVersion: nil, build: "1") == nil)
    }
}

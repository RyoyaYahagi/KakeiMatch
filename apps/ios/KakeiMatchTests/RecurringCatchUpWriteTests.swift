import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct RecurringCatchUpWriteTests {
    private let now = ISO8601DateFormatter().date(from: "2026-10-14T03:30:00Z")!

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func database(_ store: KMSQLiteStore) throws -> KMStoreDatabase {
        try KMStoreDatabase(url: store.directory.appendingPathComponent(try store.profile().current.uuidString)
            .appendingPathComponent("household.sqlite"))
    }

    private func repository(durable: Bool, directory: URL) throws -> KMRepositories {
        let memory = KMInMemoryStore(accounts: [
            .init(id: "bank", name: "銀行", accountType: .bank)
        ], categories: [
            .init(id: "food", name: "食費")
        ])
        guard durable else { return KMRepositories(inMemory: memory) }
        let store = try KMSQLiteStore(directory: directory)
        try database(store).save(memory)
        return KMRepositories(persistent: store)
    }

    @Test(arguments: [false, true]) func previewsAndSavesWithoutGeneratingBeforeSelectedCatchUp(durable: Bool) async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repo = try repository(durable: durable, directory: directory)
        let value = KMRecurringTransaction(id: "synthetic-schedule", name: "合成定期", kind: .expense, amountYen: 1_700,
            categoryId: "food", accountId: "bank", frequency: .monthly, startDate: KMDate(rawValue: "2026-08-01"),
            postsTransaction: true, nextDate: nil, completed: false, editable: true)
        let today = KMDate(instant: now)

        let preview = try await repo.recurring.previewRecurringCatchUp(value, through: today)
        #expect(preview.dates.map(\.rawValue) == ["2026-08-01", "2026-09-01", "2026-10-01"])
        let selected = KMRecurringScheduleService.currentMonthDates(in: preview, month: today.yearMonth)
        #expect(selected.map(\.rawValue) == ["2026-10-01"])

        try await repo.recurring.saveRecurringForCatchUp(value, at: now)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).isEmpty)
        #expect(try await repo.recurring.recurringTransactions().first?.nextDate == KMDate(rawValue: "2026-11-01"))

        try await repo.recurring.catchUpRecurring(id: value.id, dates: selected, through: today, at: now)
        let rows = try await repo.transactions.transactions(matching: .init(limit: nil))
        #expect(rows.map(\.date) == [KMDate(rawValue: "2026-10-01")])
        let generation = try #require(await repo.recurring.recurringGenerations(scheduleId: value.id).first)
        #expect(generation.occurrences.map(\.date) == selected)

        try await repo.recurring.undoRecurringGeneration(id: generation.id, dates: nil, at: now)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).isEmpty)
        let undone = try #require(await repo.recurring.recurringGenerations(scheduleId: value.id).first)
        #expect(undone.undoneAt == now)
        #expect(undone.occurrences.map(\.status) == [.deleted])
    }

    @Test(arguments: [false, true]) func currentMonthCatchUpIsNotFollowedBySkippedAutomaticOccurrences(durable: Bool) async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repo = try repository(durable: durable, directory: directory)
        let value = KMRecurringTransaction(id: "synthetic-schedule", name: "合成定期", kind: .expense, amountYen: 1_700,
            categoryId: "food", accountId: "bank", frequency: .monthly, startDate: KMDate(rawValue: "2026-08-01"),
            postsTransaction: true, nextDate: nil, completed: false, editable: true)
        let today = KMDate(instant: now)
        let preview = try await repo.recurring.previewRecurringCatchUp(value, through: today)
        let selected = KMRecurringScheduleService.currentMonthDates(in: preview, month: today.yearMonth)

        try await repo.recurring.saveRecurringForCatchUp(value, at: now)
        try await repo.recurring.catchUpRecurring(id: value.id, dates: selected, through: today, at: now)
        try await repo.recurring.runRecurring(through: today, at: now)

        let rows = try await repo.transactions.transactions(matching: .init(limit: nil))
        #expect(rows.map(\.date) == [KMDate(rawValue: "2026-10-01")])
        #expect(try await repo.recurring.recurringTransactions().first?.nextDate == KMDate(rawValue: "2026-11-01"))
    }
}

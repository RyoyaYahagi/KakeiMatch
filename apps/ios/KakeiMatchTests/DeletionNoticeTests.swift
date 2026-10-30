import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct DeletionNoticeTests {
    private let deletedAt = Date(timeIntervalSince1970: 1_790_000_000)

    private func repositories() -> KMRepositories {
        KMRepositories(inMemory: KMInMemoryStore(
            transactions: [.init(id: "synthetic-expense", date: KMDate(rawValue: "2026-10-13"),
                amountYen: -100, kind: .expense, accountId: "cash")],
            accounts: [.init(id: "cash", name: "合成現金")]))
    }

    private func delete(_ repositories: KMRepositories, at date: Date) async throws -> KMTransactionDeletion {
        try await repositories.transactions.deleteTransaction(id: "synthetic-expense", expected: nil, at: date)
    }

    @Test func expiredAuditIsNeitherRestoredNorShown() async throws {
        let repo = repositories()
        let audit = try await delete(repo, at: deletedAt)
        var now = deletedAt.addingTimeInterval(10)
        let notice = KMDeletionNoticeModel(now: { now })
        await notice.configure(repo)
        // 10 seconds exactly is expired, matching PWA's `now >= undoUntil`.
        #expect(notice.deletion == nil)
        notice.show(audit)
        #expect(notice.deletion == nil)
        #expect(!(await notice.undo()))

        now = deletedAt.addingTimeInterval(9.999)
        notice.show(audit)
        #expect(notice.deletion?.id == audit.id)
    }

    @Test func startupRestoresLatestDeletionAndUndoReturnsTheRecord() async throws {
        let repo = repositories()
        let audit = try await delete(repo, at: deletedAt)
        let notice = KMDeletionNoticeModel(now: { deletedAt.addingTimeInterval(1) })
        await notice.configure(repo)
        #expect(notice.deletion?.id == audit.id)
        #expect(try await repo.transactions.transaction(id: "synthetic-expense") == nil)

        #expect(await notice.undo())
        #expect(notice.deletion == nil)
        #expect(notice.status == KMDeletionNoticeText.restored)
        #expect(try await repo.transactions.transaction(id: "synthetic-expense") != nil)
        // PWA keeps the restored text in `.deletion-toast`, which a tab switch does not clear.
        notice.clearTransientStatus()
        #expect(notice.status == KMDeletionNoticeText.restored)
        // A second tap must not call the repository again or replace the restored status.
        #expect(!(await notice.undo()))
        #expect(notice.status == KMDeletionNoticeText.restored)
    }

    @Test func simultaneousUndoTapsRestoreOnce() async throws {
        let repo = repositories()
        _ = try await delete(repo, at: deletedAt)
        let notice = KMDeletionNoticeModel(now: { deletedAt.addingTimeInterval(1) })
        await notice.configure(repo)
        #expect(notice.deletion != nil)

        let first = Task { await notice.undo() }
        let second = Task { await notice.undo() }
        let results = await [first.value, second.value]
        #expect(results.filter { $0 }.count == 1)
        #expect(notice.deletion == nil)
        #expect(notice.status == KMDeletionNoticeText.restored)
    }

    @Test func failedUndoKeepsToastForRetryAndReportsTheReason() async throws {
        let repo = repositories()
        let audit = try await delete(repo, at: deletedAt)
        var now = deletedAt.addingTimeInterval(1)
        let notice = KMDeletionNoticeModel(now: { now })
        await notice.configure(repo)
        #expect(notice.deletion?.id == audit.id)

        // Another surface consumes the undo before this toast is tapped.
        try await repo.transactions.undoTransactionDeletion(id: audit.id, at: now)
        now = now.addingTimeInterval(1)
        #expect(!(await notice.undo()))
        #expect(notice.deletion?.id == audit.id)
        #expect(notice.status?.hasPrefix("削除を取り消せませんでした。") == true)
        // PWA's failure line lives in `#message`, so a tab switch hides it but keeps the undo toast.
        notice.clearTransientStatus()
        #expect(notice.status == nil)
        #expect(notice.deletion?.id == audit.id)
    }

    @Test func toastDisappearsAtTheDeadline() async throws {
        let repo = repositories()
        let audit = try await delete(repo, at: deletedAt)
        let now = deletedAt.addingTimeInterval(9.9)
        let notice = KMDeletionNoticeModel(now: { now })
        notice.show(audit)
        #expect(notice.deletion?.id == audit.id)
        try await Task.sleep(for: .milliseconds(300))
        #expect(notice.deletion == nil)
        #expect(notice.status == nil)
    }
}

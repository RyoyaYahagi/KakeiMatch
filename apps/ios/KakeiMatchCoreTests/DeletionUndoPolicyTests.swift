import Foundation
import Testing
@testable import KakeiMatchCore

struct DeletionUndoPolicyTests {
    private let deletedAt = Date(timeIntervalSince1970: 1_790_000_000)

    @Test func windowIsTenSecondsFromDeletion() {
        #expect(KMDeletionUndoPolicy.window == 10)
        #expect(KMDeletionUndoPolicy.undoUntil(deletedAt: deletedAt) == deletedAt.addingTimeInterval(10))
    }

    @Test func deadlineIsExclusiveLikePWA() {
        let deadline = deletedAt.addingTimeInterval(10)
        #expect(KMDeletionUndoPolicy.remaining(undoUntil: deadline, now: deletedAt) == 10)
        #expect(KMDeletionUndoPolicy.isAvailable(undoUntil: deadline, now: deletedAt.addingTimeInterval(9.999)))
        // PWA: undo() rejects `now >= undoUntil`; exactly 10 seconds is already expired.
        #expect(!KMDeletionUndoPolicy.isAvailable(undoUntil: deadline, now: deadline))
        #expect(!KMDeletionUndoPolicy.isAvailable(undoUntil: deadline, now: deadline.addingTimeInterval(1)))
        #expect(KMDeletionUndoPolicy.remaining(undoUntil: deadline, now: deadline) == 0)
        #expect(KMDeletionUndoPolicy.remaining(undoUntil: deadline, now: deadline.addingTimeInterval(1)) == 0)
    }
}

import Foundation

/// PWA `LocalTransactionDeletionService`: the undo window is 10 seconds from the deletion.
/// The deadline is exclusive, so `now == undoUntil` is already expired.
enum KMDeletionUndoPolicy {
    static let window: TimeInterval = 10

    static func undoUntil(deletedAt: Date) -> Date {
        deletedAt.addingTimeInterval(window)
    }

    static func remaining(undoUntil: Date, now: Date) -> TimeInterval {
        max(0, undoUntil.timeIntervalSince(now))
    }

    static func isAvailable(undoUntil: Date, now: Date) -> Bool {
        now < undoUntil
    }
}

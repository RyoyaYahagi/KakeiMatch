import Foundation
import Observation

/// PWA keeps the deletion toast outside the tab content (`#message` + `.deletion-toast`),
/// so it survives tab changes and is shown again for the latest unexpired deletion after a reload.
/// This shell-owned model keeps the 10-second deadline and the repository call out of the view.
@MainActor @Observable
final class KMDeletionNoticeModel {
    private(set) var deletion: KMTransactionDeletion?
    /// PWA replaces the toast text with this after a successful undo. It has no timer,
    /// so it stays across tabs until the next deletion like `.deletion-toast`.
    private(set) var restored = false
    /// PWA reports undo failures in `#message`, which a tab switch clears.
    private(set) var failure: String?
    private(set) var busy = false

    var status: String? { failure ?? (restored ? KMDeletionNoticeText.restored : nil) }
    @ObservationIgnored private var repositories: KMRepositories?
    @ObservationIgnored private var expiryTask: Task<Void, Never>?
    @ObservationIgnored private var clock: () -> Date

    init(now: @escaping () -> Date = Date.init) {
        clock = now
    }

    func configure(_ repositories: KMRepositories?) async {
        self.repositories = repositories
        guard let repositories else { return }
        // One clock origin across screens keeps the 10-second window in fixture runs.
        if repositories.fixtureName != nil {
            let reference = repositories.referenceDate
            clock = { KMFixtureClock.now(reference: reference) }
        }
        await restoreLatest()
    }

    /// Shows the newest deletion that can still be undone, matching PWA's startup recovery.
    func restoreLatest() async {
        guard let repositories else { return }
        do {
            let now = clock()
            let latest = try await repositories.transactions.transactionDeletions()
                .filter { $0.restoredAt == nil && KMDeletionUndoPolicy.isAvailable(undoUntil: $0.undoUntil, now: now) }
                .max { $0.deletedAt < $1.deletedAt }
            guard let latest else { return }
            show(latest)
        } catch {
            failure = "削除の取り消し情報を読み込めませんでした。\(error.localizedDescription)"
        }
    }

    func show(_ audit: KMTransactionDeletion) {
        expiryTask?.cancel()
        expiryTask = nil
        restored = false
        failure = nil
        let remaining = KMDeletionUndoPolicy.remaining(undoUntil: audit.undoUntil, now: clock())
        guard remaining > 0 else {
            deletion = nil
            return
        }
        deletion = audit
        let id = audit.id
        expiryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
            guard let self, self.deletion?.id == id else { return }
            // PWA's timer only empties `.deletion-toast`; `#message` stays.
            self.deletion = nil
            self.expiryTask = nil
        }
    }

    /// Returns true only when this call restored the record. Repeated taps and expired audits do nothing.
    func undo() async -> Bool {
        guard let repositories, let deletion, !busy else { return false }
        busy = true
        failure = nil
        do {
            try await repositories.transactions.undoTransactionDeletion(id: deletion.id, at: clock())
            expiryTask?.cancel()
            expiryTask = nil
            self.deletion = nil
            restored = true
            busy = false
            return true
        } catch {
            failure = "削除を取り消せませんでした。\(error.localizedDescription)"
            busy = false
            return false
        }
    }

    /// A tab switch clears PWA's `#message` but leaves `.deletion-toast` alone.
    func clearTransientStatus() {
        failure = nil
    }
}

enum KMDeletionNoticeText {
    static let deleted = "削除しました。"
    static let undo = "元に戻す"
    static let hint = "10秒以内なら元に戻せます。"
    static let restored = "削除を取り消しました。"
}

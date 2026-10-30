import Foundation
import Observation

/// PWA keeps the deletion toast outside the tab content (`#message` + `.deletion-toast`),
/// so it survives tab changes and is shown again for the latest unexpired deletion after a reload.
/// This shell-owned model keeps the 10-second deadline and the repository call out of the view.
@MainActor @Observable
final class KMDeletionNoticeModel {
    private(set) var deletion: KMTransactionDeletion?
    private(set) var status: String?
    private(set) var busy = false
    @ObservationIgnored private var repositories: KMRepositories?
    @ObservationIgnored private var expiryTask: Task<Void, Never>?
    @ObservationIgnored private var clock: () -> Date

    init(now: @escaping () -> Date = Date.init) {
        clock = now
    }

    func configure(_ repositories: KMRepositories?) async {
        self.repositories = repositories
        guard let repositories else { return }
        if let fixtureClock = makeFixtureClock(repositories) {
            clock = fixtureClock
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
            status = "削除の取り消し情報を読み込めませんでした。\(error.localizedDescription)"
        }
    }

    func show(_ audit: KMTransactionDeletion) {
        expiryTask?.cancel()
        expiryTask = nil
        let remaining = KMDeletionUndoPolicy.remaining(undoUntil: audit.undoUntil, now: clock())
        guard remaining > 0 else {
            deletion = nil
            return
        }
        deletion = audit
        status = nil
        let id = audit.id
        expiryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
            guard let self, self.deletion?.id == id else { return }
            self.deletion = nil
            self.status = nil
            self.expiryTask = nil
        }
    }

    /// Returns true only when this call restored the record. Repeated taps and expired audits do nothing.
    func undo() async -> Bool {
        guard let repositories, let deletion, !busy else { return false }
        busy = true
        status = nil
        do {
            try await repositories.transactions.undoTransactionDeletion(id: deletion.id, at: clock())
            expiryTask?.cancel()
            expiryTask = nil
            self.deletion = nil
            status = KMDeletionNoticeText.restored
            busy = false
            return true
        } catch {
            status = "削除を取り消せませんでした。\(error.localizedDescription)"
            busy = false
            return false
        }
    }

    func clearStatus() {
        status = nil
    }

    private func makeFixtureClock(_ repositories: KMRepositories) -> (() -> Date)? {
        guard repositories.fixtureName != nil else { return nil }
        let started = ProcessInfo.processInfo.systemUptime
        let reference = repositories.referenceDate
        return { reference.addingTimeInterval(ProcessInfo.processInfo.systemUptime - started) }
    }
}

enum KMDeletionNoticeText {
    static let deleted = "削除しました。"
    static let undo = "元に戻す"
    static let hint = "10秒以内なら元に戻せます。"
    static let restored = "削除を取り消しました。"
}

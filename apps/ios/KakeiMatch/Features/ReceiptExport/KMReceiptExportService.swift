import Foundation

/// Sends new or changed food receipts to the user's receiver. One attempt per call: no retry
/// loop and no background scheduling. Unsent receipts stay pending for the next manual send or
/// the next foreground return. Never writes household data.
@MainActor final class KMReceiptExportService {
    static let batchSize = 50
    static let tokenKey = "token"
    static let credentialService = "jp.kakeimatch.ios.receipt-export"

    static let live = KMReceiptExportService(
        stateStore: KMUserDefaultsReceiptExportStateStore(),
        credentials: KMKeychainCredentials(service: credentialService),
        sender: KMReceiptExportHTTPClient()
    )

    private let stateStore: any KMReceiptExportStateStore
    private let credentials: any KMCloudCredentialStore
    private let sender: any KMReceiptExportSending
    private let now: () -> Date
    private(set) var isRunning = false

    init(stateStore: any KMReceiptExportStateStore, credentials: any KMCloudCredentialStore,
         sender: any KMReceiptExportSending, now: @escaping () -> Date = { Date() }) {
        self.stateStore = stateStore
        self.credentials = credentials
        self.sender = sender
        self.now = now
    }

    func state() throws -> KMReceiptExportState { try stateStore.load() }

    func updateSettings(_ change: (inout KMReceiptExportSettings) -> Void) throws -> KMReceiptExportState {
        var state = try stateStore.load()
        change(&state.settings)
        try stateStore.save(state)
        return state
    }

    func hasToken() throws -> Bool { try credentials.read(Self.tokenKey) != nil }

    /// Nil or blank removes the token.
    func saveToken(_ token: String?) throws {
        let trimmed = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        try credentials.write(trimmed.isEmpty ? nil : Data(trimmed.utf8), key: Self.tokenKey)
    }

    /// Returns nil without touching the network when disabled, already running, or when the
    /// stored state cannot be read (the settings page reports that read error itself).
    /// Every other path records and returns a status for the settings page.
    @discardableResult
    func run(receipts: any ReceiptRepository, categories: any CategoryRepository) async -> KMReceiptExportStatus? {
        guard !isRunning else { return nil }
        guard var state = try? stateStore.load(), state.settings.isEnabled else { return nil }
        isRunning = true
        defer { isRunning = false }

        let attemptedAt = now()
        func finish(_ status: KMReceiptExportStatus) -> KMReceiptExportStatus {
            state.lastStatus = status
            do {
                try stateStore.save(state)
                return status
            } catch {
                var failed = status
                failed.outcome = .stateSaveFailed
                return failed
            }
        }

        let tokenData: Data?
        do { tokenData = try credentials.read(Self.tokenKey) } catch {
            return finish(.init(outcome: .readFailed, attemptedAt: attemptedAt))
        }
        guard let url = try? KMReceiptExportEndpoint.importURL(baseURL: state.settings.baseURL),
              let tokenData, let token = String(data: tokenData, encoding: .utf8), !token.isEmpty else {
            return finish(.init(outcome: .notConfigured, attemptedAt: attemptedAt))
        }

        let allReceipts: [KMReceipt]
        let allCategories: [KMCategory]
        do {
            allReceipts = try await receipts.receipts()
            allCategories = try await categories.categories(includeHidden: true)
        } catch {
            return finish(.init(outcome: .readFailed, attemptedAt: attemptedAt))
        }

        let categoryIds = state.settings.effectiveCategoryIds(allCategories)
        guard !categoryIds.isEmpty else { return finish(.init(outcome: .noCategories, attemptedAt: attemptedAt)) }

        let plan: KMReceiptExportPlan
        do {
            plan = try KMReceiptExportPlan.make(receipts: allReceipts, categoryIds: categoryIds, sentHashes: state.sentHashes)
        } catch {
            return finish(.init(outcome: .readFailed, attemptedAt: attemptedAt))
        }
        for id in plan.noLongerEligible { state.sentHashes[id] = nil }
        guard !plan.pending.isEmpty else { return finish(.init(outcome: .nothingToSend, attemptedAt: attemptedAt)) }

        var sent = 0
        var offset = 0
        while offset < plan.pending.count {
            let batch = Array(plan.pending[offset..<min(offset + Self.batchSize, plan.pending.count)])
            let remaining = plan.pending.count - sent
            let status: Int
            do {
                let payload = KMReceiptExportPayload(sentAt: now(), categories: allCategories,
                                                     categoryIds: categoryIds, receipts: batch)
                status = try await sender.send(try payload.encoded(), to: url, token: token)
            } catch {
                return finish(.init(outcome: .networkFailed, attemptedAt: attemptedAt, sentCount: sent, pendingCount: remaining))
            }
            switch status {
            case 200..<300:
                for receipt in batch { state.sentHashes[receipt.id] = plan.hashes[receipt.id] }
                sent += batch.count
                offset += batch.count
                // Persist each accepted batch so a later failure does not resend it.
                do { try stateStore.save(state) } catch {
                    return finish(.init(outcome: .stateSaveFailed, attemptedAt: attemptedAt, sentCount: sent,
                                        pendingCount: plan.pending.count - sent))
                }
            case 401, 403:
                return finish(.init(outcome: .authenticationFailed, attemptedAt: attemptedAt, sentCount: sent,
                                    pendingCount: remaining, httpStatus: status))
            default:
                return finish(.init(outcome: .serverFailed, attemptedAt: attemptedAt, sentCount: sent,
                                    pendingCount: remaining, httpStatus: status))
            }
        }
        return finish(.init(outcome: .succeeded, attemptedAt: attemptedAt, sentCount: sent))
    }
}

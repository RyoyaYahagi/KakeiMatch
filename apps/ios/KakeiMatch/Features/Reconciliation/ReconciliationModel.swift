import Foundation
import Observation

@MainActor @Observable final class KMReconciliationModel {
    var run: KMReconciliationRun?
    var statements: [KMStatementTransaction] = []
    var imports: [KMLocalRecord<KMStatementImport>] = []
    var receipts: [KMReceipt] = []
    var accounts: [KMAccount] = []
    var categories: [KMCategory] = []
    var transactions: [String: KMTransaction] = [:]
    var presentation = KMReconciliationPresentation()
    var attention: [KMStatementAttention] = []
    var isLoading = true
    var isBusy = false
    var errorMessage: String?
    var message: String?
    var runFeedback: String?
    // This acknowledgement intentionally lasts only for this screen. Repository has no persistence API.
    var acknowledgedAttention: Set<String> = []
    var categoryRules: [KMCategoryLearningRule] = []
    @ObservationIgnored private let started = ProcessInfo.processInfo.systemUptime
    private func now(_ repositories: KMRepositories) -> Date {
        repositories.fixtureName == nil ? Date() : repositories.referenceDate.addingTimeInterval(ProcessInfo.processInfo.systemUptime - started)
    }

    enum Action {
        case confirm(statement: String, receipt: String)
        case reject(statement: String, receipt: String)
        case ignore(String)
        case register(statement: String, category: String?, destination: String?, excluded: Bool)
        case suspect(String), clearSuspected(String), retry(KMReconciliationResolution), undo(String)
    }

    func load(_ repositories: KMRepositories?) async {
        guard let repositories else {
            errorMessage = "家計簿を読み込めません。アプリを開き直してください。"; isLoading = false; return
        }
        do { try await reload(repositories); errorMessage = nil }
        catch { errorMessage = Self.errorText(error) }
        isLoading = false
    }
    private func reload(_ repositories: KMRepositories) async throws {
        let run = try await repositories.reconciliation.latestRun()
        let resolutions = try await repositories.reconciliation.resolutions()
        let suspected = try await repositories.reconciliation.suspectedStatements()
        let statements = try await repositories.statements.statementTransactions()
        let imports = try await repositories.statements.statementImports()
        let receipts = try await repositories.receipts.receipts()
        let accounts = try await repositories.accounts.accounts(includeClosed: true)
        let categories = try await repositories.categories.categories(includeHidden: false)
        let groups = try await repositories.categories.categoryGroups()
        let categoryRules = try await repositories.categoryLearning.categoryRules()
        // Load exactly the candidate IDs, not the recent-100-record window.
        var transactions: [String: KMTransaction] = [:]
        for candidate in run?.candidates ?? [] {
            let id = receipts.first { $0.id == candidate.receiptId }?.registration.actualTransactionId
                ?? (candidate.receiptId.hasPrefix("actual:") ? String(candidate.receiptId.dropFirst(7)) : nil)
            if let id, let value = try await repositories.transactions.transaction(id: id) { transactions[id] = value }
        }
        let projection = KMReconciliationPresentation.make(run: run, resolutions: resolutions, suspected: suspected,
                                                          statements: statements, receipts: receipts, transactions: transactions)
        let attention = try KMReconciliationReview.attention(statements: statements,
            unresolvedIds: Set(projection.pending.map(\.id) + suspected.map(\.statementId)))
        self.run = run; self.statements = statements; self.imports = imports; self.receipts = receipts
        self.accounts = accounts; self.transactions = transactions
        self.categories = KMReconciliationPresentation.categoryChoices(categories, groups: groups)
        self.categoryRules = categoryRules
        self.presentation = projection; self.attention = attention
    }

    func rerun(_ repositories: KMRepositories?) async {
        guard let repositories, !isBusy else { return }
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        do {
            let before = presentation.matched.count
            _ = try await repositories.reconciliation.runReconciliation(id: UUID().uuidString, at: now(repositories))
            try await reload(repositories)
            runFeedback = KMReconciliationPresentation.runFeedback(before: before, after: presentation.matched.count)
        } catch { errorMessage = Self.errorText(error) }
    }
    func perform(_ action: Action, repositories: KMRepositories?) async {
        guard let repositories, !isBusy, let run else { return }
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        do {
            let repo = repositories.reconciliation, at = now(repositories)
            switch action {
            case let .confirm(statement, receipt):
                _ = try await repo.confirmSameExpense(runId: run.runId, statementId: statement, receiptId: receipt, at: at)
            case let .reject(statement, receipt):
                try await repo.rejectCandidate(runId: run.runId, statementId: statement, receiptId: receipt)
            case .ignore(let id): _ = try await repo.ignoreStatement(runId: run.runId, statementId: id, at: at)
            case let .register(statement, category, destination, excluded):
                guard destination != nil || category?.isEmpty == false else { throw KMDataError.invalidData("カテゴリを選択してください。") }
                _ = try await repo.registerStatement(runId: run.runId, statementId: statement, categoryId: category,
                    destinationAccountId: destination, excludedFromSpending: excluded, newAccountId: UUID().uuidString, at: at)
            case .suspect(let id): try await repo.setSuspected(statementId: id, markedAt: at)
            case .clearSuspected(let id): try await repo.setSuspected(statementId: id, markedAt: nil)
            case .retry(let resolution):
                if resolution.undoRequestedAt != nil { try await repo.undoSameExpense(id: resolution.id, at: at) }
                else { try await repo.retryResolution(id: resolution.id, at: at) }
            case .undo(let id): try await repo.undoSameExpense(id: id, at: at)
            }
            // Decisions invalidate the prepared input; always rerun before offering another decision.
            _ = try await repo.runReconciliation(id: UUID().uuidString, at: at)
            try await reload(repositories)
            runFeedback = nil
        } catch {
            let message = Self.errorText(error)
            // A write can succeed before the follow-up run fails. Read saved failures/decisions back.
            do { try await reload(repositories) }
            catch { errorMessage = message + " 照合情報の再取得にも失敗しました。もう一度読み込んでください。"; return }
            errorMessage = message
        }
    }
    func importCSV(_ data: Data, provider: KMStatementProvider, repositories: KMRepositories?) async {
        guard let repositories, !isBusy else { return }
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        var saved = false
        do {
            let result = try await repositories.statements.importStatement(data: data, provider: provider, at: now(repositories))
            saved = true
            // Including duplicate-only reimports. Import alone does not update the run.
            _ = try await repositories.reconciliation.runReconciliation(id: UUID().uuidString, at: now(repositories))
            try await reload(repositories)
            message = KMReconciliationPresentation.importFeedback(result); runFeedback = nil
        } catch {
            errorMessage = (saved ? "明細は保存しましたが、照合結果を更新できませんでした。「もう一度照合する」を押してください。 " : "") + Self.errorText(error)
        }
    }
    static func errorText(_ error: Error) -> String {
        guard let error = error as? KMReconciliationError else { return error.localizedDescription }
        switch error.code {
        case "stale_run": return "照合の後に記録が変更されました。もう一度照合してから確認してください。"
        case "account_mapping_ambiguous": return "同じ明細サービスに複数の支払元が対応しています。設定を確認してください。"
        case "split_amount_adjustment_unsupported": return "分割された記録の金額差は反映できません。別の候補を選ぶか、明細を確認してください。"
        case "category_unavailable": return "カテゴリを選択し直してください。"
        case "destination_unavailable": return "振替先を選択し直してください。"
        case "duplicate_external_id_conflict": return "同じ取引番号に異なる明細が見つかりました。"
        default: return "照合の判断を反映できませんでした。もう一度照合して、内容を確認してください。"
        }
    }
}

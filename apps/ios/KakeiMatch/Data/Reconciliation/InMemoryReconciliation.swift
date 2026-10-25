import Foundation

@MainActor extension KMInMemoryStore {
    func recordManualReview(statementId: String) {
        var state = currentReconciliation(); state.manualStatementIds.insert(statementId)
        reconciliationState = state
    }
    private func currentReconciliation() -> KMLocalReconciliation {
        var state = reconciliationState ?? KMLocalReconciliation(statements: statementValues, imports: importValues,
            transactions: transactionValues, accounts: accountValues, categories: categoryValues)
        state.statements = statementValues; state.imports = importValues; state.transactions = transactionValues
        state.accounts = accountValues; state.categories = categoryValues; state.receipts = receiptValues
        state.resolutions = resolutionValues; state.suspected = suspectedValues
        return state
    }
    private func storeReconciliation(_ state: KMLocalReconciliation) {
        reconciliationState = state; transactionValues = state.transactions; accountValues = state.accounts
        resolutionValues = state.resolutions; suspectedValues = state.suspected
    }
    func runReconciliation(id: String, at timestamp: Date) async throws -> KMReconciliationRun {
        var state = currentReconciliation()
        let run = try state.run(id: id, at: timestamp)
        storeReconciliation(state); runValues.append(run); return run
    }
    func confirmSameExpense(runId: String, statementId: String, receiptId: String, at timestamp: Date) async throws -> KMReconciliationResolution {
        var state = currentReconciliation()
        defer { storeReconciliation(state) }
        return try state.sameExpense(runId: runId, statementId: statementId, receiptId: receiptId, at: timestamp)
    }
    func rejectCandidate(runId: String, statementId: String, receiptId: String) async throws {
        var state = currentReconciliation(); defer { storeReconciliation(state) }
        try state.rejectPair(runId: runId, statementId: statementId, receiptId: receiptId)
    }
    func ignoreStatement(runId: String, statementId: String, at timestamp: Date) async throws -> KMReconciliationResolution {
        var state = currentReconciliation(); defer { storeReconciliation(state) }
        return try state.ignore(runId: runId, statementId: statementId, at: timestamp)
    }
    func registerStatement(runId: String, statementId: String, categoryId: String?, destinationAccountId: String?, excludedFromSpending: Bool?, newAccountId: String, at timestamp: Date) async throws -> KMReconciliationResolution {
        var state = currentReconciliation(); defer { storeReconciliation(state) }
        return try state.noReceipt(runId: runId, statementId: statementId, categoryId: categoryId, destinationAccountId: destinationAccountId,
            excludedFromSpending: excludedFromSpending, newAccountId: newAccountId, at: timestamp)
    }
    func retryResolution(id: String, at timestamp: Date) async throws {
        var state = currentReconciliation(); defer { storeReconciliation(state) }
        try state.retry(id, at: timestamp)
    }
    func undoSameExpense(id: String, at timestamp: Date) async throws {
        var state = currentReconciliation(); defer { storeReconciliation(state) }
        try state.undoSameExpense(id, at: timestamp)
    }
}

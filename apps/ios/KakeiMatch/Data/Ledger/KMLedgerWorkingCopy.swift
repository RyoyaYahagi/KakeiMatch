import Foundation

@MainActor extension KMInMemoryStore {
    /// Multi-step operations must also be atomic in previews/tests, not only in SQLite.
    func withLedgerCopy<T>(_ action: (KMInMemoryStore) async throws -> T) async throws -> T {
        let copy = KMInMemoryStore(transactions: transactionValues, accounts: accountValues, categories: categoryValues,
            groups: groupValues, receipts: receiptValues, budgetId: monthlySettings.budgetId)
        copy.payeeValues = payeeValues; copy.ledgerWriteState = ledgerWriteState; copy.masterWriteState = masterWriteState
        copy.serviceState = serviceState; copy.resolutionValues = resolutionValues; copy.suspectedValues = suspectedValues
        copy.statementValues = statementValues; copy.importValues = importValues; copy.runValues = runValues
        copy.imageValues = imageValues; copy.pendingArtifacts = pendingArtifacts
        copy.recurringValues = recurringValues
        copy.nativeBudgets = nativeBudgets; copy.monthlySettings = monthlySettings
        let result = try await action(copy)
        transactionValues = copy.transactionValues; accountValues = copy.accountValues; categoryValues = copy.categoryValues
        groupValues = copy.groupValues; receiptValues = copy.receiptValues; payeeValues = copy.payeeValues
        ledgerWriteState = copy.ledgerWriteState; masterWriteState = copy.masterWriteState; serviceState = copy.serviceState
        resolutionValues = copy.resolutionValues; suspectedValues = copy.suspectedValues
        statementValues = copy.statementValues; importValues = copy.importValues; runValues = copy.runValues
        imageValues = copy.imageValues; pendingArtifacts = copy.pendingArtifacts
        recurringValues = copy.recurringValues
        nativeBudgets = copy.nativeBudgets; monthlySettings = copy.monthlySettings
        return result
    }
}

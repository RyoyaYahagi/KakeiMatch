import Foundation

@MainActor extension KMInMemoryStore {
    /// Copy every repository projection for one operation. Arrays and dictionaries are
    /// copy-on-write, so a read can use this without touching the published snapshot.
    func operationCopy() -> KMInMemoryStore {
        let copy = KMInMemoryStore(transactions: transactionValues, accounts: accountValues, categories: categoryValues,
            groups: groupValues, receipts: receiptValues, budgetId: monthlySettings.budgetId)
        copy.adoptState(from: self)
        return copy
    }
    /// Replace this store's published state with a committed working copy.
    func adoptState(from copy: KMInMemoryStore) {
        transactionValues = copy.transactionValues; accountValues = copy.accountValues; categoryValues = copy.categoryValues
        groupValues = copy.groupValues; receiptValues = copy.receiptValues; payeeValues = copy.payeeValues
        imageValues = copy.imageValues; artifactIds = copy.artifactIds; pendingArtifacts = copy.pendingArtifacts
        ledgerWriteState = copy.ledgerWriteState; masterWriteState = copy.masterWriteState; serviceState = copy.serviceState
        resolutionValues = copy.resolutionValues; suspectedValues = copy.suspectedValues
        statementValues = copy.statementValues; importValues = copy.importValues; runValues = copy.runValues
        receiptDraftValues = copy.receiptDraftValues; recurringValues = copy.recurringValues
        payrollValues = copy.payrollValues; payrollWriteFailureForTesting = copy.payrollWriteFailureForTesting
        ruleValues = copy.ruleValues; ruleOverrides = copy.ruleOverrides; settingsValue = copy.settingsValue
        nativeBudgets = copy.nativeBudgets; monthlySettings = copy.monthlySettings
    }
    /// Multi-step operations must also be atomic in previews/tests, not only in SQLite.
    func withLedgerCopy<T>(_ action: (KMInMemoryStore) async throws -> T) async throws -> T {
        let copy = operationCopy()
        let result = try await action(copy)
        adoptState(from: copy)
        return result
    }
}

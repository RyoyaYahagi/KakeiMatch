import Foundation

/// Screen boundaries are MainActor-isolated. Adapters can perform disk/CPU work on another actor.
/// Every operation is async throws, including fixture reads, so views do not rely on synchronous storage.
@MainActor protocol TransactionRepository {
    func transactions(matching query: KMTransactionQuery) async throws -> [KMTransaction]
    func transaction(id: String) async throws -> KMTransaction?
    func recordDays(matching query: KMTransactionQuery) async throws -> [KMRecordDay]
    func home(month: KMYearMonth) async throws -> KMHomeSnapshot
    func saveManual(_ input: KMManualTransactionInput, id: String?) async throws -> KMTransaction
    func saveTransfer(_ input: KMTransferInput, id: String?) async throws -> KMTransaction
    func setSpendingExclusion(id: String, excluded: Bool) async throws
    func deleteTransaction(id: String) async throws
}

@MainActor protocol AccountRepository {
    func accounts(includeClosed: Bool) async throws -> [KMAccount]
    func saveAccount(_ account: KMAccount) async throws
    func deleteAccount(id: String) async throws
}

@MainActor protocol CategoryRepository {
    func categories(includeHidden: Bool) async throws -> [KMCategory]
    func categoryGroups() async throws -> [KMCategoryGroup]
    func saveCategory(_ category: KMCategory) async throws
    func deleteCategory(id: String) async throws
}

@MainActor protocol PayeeRepository {
    func payees() async throws -> [KMPayee]
}

@MainActor protocol ReceiptRepository {
    func receipts() async throws -> [KMReceipt]
    func receipt(id: String) async throws -> KMReceipt?
    /// Draft/confirmed snapshot storage only; this does not extract, classify or post to the ledger.
    func saveReceipt(_ receipt: KMReceipt) async throws
    func receiptImage(blobId: String) async throws -> Data?
    func deleteReceipt(id: String) async throws
}

@MainActor protocol StatementRepository {
    func statementImports() async throws -> [KMLocalRecord<KMStatementImport>]
    func statementTransactions() async throws -> [KMStatementTransaction]
}

@MainActor protocol ReconciliationRepository {
    func latestRun() async throws -> KMReconciliationRun?
    func runReconciliation(id: String, at timestamp: Date) async throws -> KMReconciliationRun
    func confirmSameExpense(runId: String, statementId: String, receiptId: String, at timestamp: Date) async throws -> KMReconciliationResolution
    func rejectCandidate(runId: String, statementId: String, receiptId: String) async throws
    func ignoreStatement(runId: String, statementId: String, at timestamp: Date) async throws -> KMReconciliationResolution
    func registerStatement(runId: String, statementId: String, categoryId: String?, destinationAccountId: String?, excludedFromSpending: Bool?, newAccountId: String, at timestamp: Date) async throws -> KMReconciliationResolution
    func retryResolution(id: String, at timestamp: Date) async throws
    func undoSameExpense(id: String, at timestamp: Date) async throws
    func resolutions() async throws -> [KMReconciliationResolution]
    /// Store a service-produced decision; no matching or ledger mutation belongs in this repository.
    func saveResolution(_ resolution: KMReconciliationResolution) async throws
    func suspectedStatements() async throws -> [KMSuspectedStatement]
    func setSuspected(statementId: String, markedAt: Date?) async throws
}

@MainActor protocol BudgetRepository {
    func budgetSummary(month: KMYearMonth) async throws -> KMMonthlyBudgetSummary
    func budgetSettings() async throws -> KMMonthlyBudgetSettings
    func saveBudgetSettings(_ settings: KMMonthlyBudgetSettings) async throws
}

@MainActor protocol RecurringRepository {
    func recurringTransactions() async throws -> [KMRecurringTransaction]
    func recurringOccurrences(scheduleId: String) async throws -> [KMRecurringProcessedOccurrence]
    /// Native catch-up commits generated transactions and consumed dates together.
    func catchUpRecurring(id: String, dates: [KMDate], through: KMDate, at timestamp: Date) async throws
    func saveRecurring(_ value: KMRecurringTransaction) async throws
    func deleteRecurring(id: String) async throws
}

@MainActor protocol PayrollRepository {
    func payrollRecords() async throws -> [KMPayrollRecord]
    func savePayrollRecord(_ record: KMPayrollRecord) async throws
}

@MainActor protocol CategoryLearningRepository {
    func categoryObservations() async throws -> [KMCategoryLearningObservation]
    /// Replaces the receipt's observation only when its confirmation is not older.
    func saveCategoryObservation(_ value: KMCategoryLearningObservation) async throws
    func categoryRules() async throws -> [KMCategoryLearningRule]
    func setCategoryRuleOverride(_ value: KMCategoryRuleOverride) async throws
    func resetCategoryRuleOverride(targetType: KMCategoryRuleStats.TargetType, normalizedName: String) async throws
    func resetCategoryRuleOverrides() async throws
}

@MainActor protocol SettingsRepository {
    func settings() async throws -> KMAppSettings
    func saveSettings(_ settings: KMAppSettings) async throws
}

// TS: src/lib/local-data.ts LocalDataRecord<T>; IDs may live in the envelope, not the value (statement import).
struct KMLocalRecord<Value: Codable & Equatable & Sendable>: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var kind: KMLocalDataKind
    var value: Value
    var updatedAt: Date
}

// TS: src/lib/local-data.ts LocalDataKind. No untyped JSON payload or backup importer is introduced here.
enum KMLocalDataKind: String, Codable, Sendable {
    case payrollRecord = "payroll-record", receiptMetadata = "receipt-metadata", receiptExtraction = "receipt-extraction"
    case categoryState = "category-state", merchantMapping = "merchant-mapping", statementImport = "statement-import"
    case statementTransaction = "statement-transaction", reconciliationRun = "reconciliation-run"
    case reconciliationResult = "reconciliation-result", reconciliationResolution = "reconciliation-resolution"
    case correctionAudit = "correction-audit", accountMetadata = "account-metadata", appSettings = "app-settings"
}

// TS: src/lib/local-backup-format.ts settings:reconciliation-suspected:*.
struct KMSuspectedStatement: Codable, Equatable, Sendable {
    var statementId: String
    var markedAt: Date
}

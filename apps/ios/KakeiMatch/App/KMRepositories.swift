import SwiftUI

/// The only app composition root. Every protocol points at the same household/profile.
/// Re-read after awaited mutations; repository values are snapshots, not live SwiftUI bindings.
@MainActor final class KMRepositories {
    let transactions: any TransactionRepository
    let accounts: any AccountRepository
    let categories: any CategoryRepository
    let payees: any PayeeRepository
    let receipts: any ReceiptRepository
    let statements: any StatementRepository
    let reconciliation: any ReconciliationRepository
    let budgets: any BudgetRepository
    let recurring: any RecurringRepository
    let payroll: any PayrollRepository
    let categoryLearning: any CategoryLearningRepository
    let settings: any SettingsRepository
    /// UI uses this instant for fixture month/day labels instead of Date.now.
    let referenceDate: Date
    let fixtureName: String?

    init(transactions: any TransactionRepository, accounts: any AccountRepository, categories: any CategoryRepository,
         payees: any PayeeRepository, receipts: any ReceiptRepository, statements: any StatementRepository,
         reconciliation: any ReconciliationRepository, budgets: any BudgetRepository, recurring: any RecurringRepository,
         payroll: any PayrollRepository, categoryLearning: any CategoryLearningRepository, settings: any SettingsRepository,
         referenceDate: Date = Date(), fixtureName: String? = nil) {
        self.transactions = transactions; self.accounts = accounts; self.categories = categories; self.payees = payees
        self.receipts = receipts; self.statements = statements; self.reconciliation = reconciliation
        self.budgets = budgets; self.recurring = recurring; self.payroll = payroll
        self.categoryLearning = categoryLearning; self.settings = settings
        self.referenceDate = referenceDate; self.fixtureName = fixtureName
    }
    convenience init(inMemory store: KMInMemoryStore, referenceDate: Date = Date(), fixtureName: String? = nil) {
        self.init(transactions: store, accounts: store, categories: store, payees: store, receipts: store, statements: store,
            reconciliation: store, budgets: store, recurring: store, payroll: store, categoryLearning: store, settings: store,
            referenceDate: referenceDate, fixtureName: fixtureName)
    }
}

private struct KMRepositoriesKey: EnvironmentKey {
    static let defaultValue: KMRepositories? = nil
}
extension EnvironmentValues {
    /// No implicit sample data: preview/app hosts must explicitly inject a container.
    var repositories: KMRepositories? {
        get { self[KMRepositoriesKey.self] }
        set { self[KMRepositoriesKey.self] = newValue }
    }
}

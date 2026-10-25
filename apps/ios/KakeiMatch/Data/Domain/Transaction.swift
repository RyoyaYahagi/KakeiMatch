import Foundation

// TS: src/lib/actual-ledger.ts ActualTransaction.kind.
enum KMTransactionKind: String, Codable, CaseIterable, Sendable { case expense, income, transfer }

// TS: src/lib/actual-ledger.ts ActualTransaction (signed integer yen).
struct KMTransaction: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var date: KMDate
    /// Negative outflow / positive inflow, including each side of a linked transfer.
    var amountYen: Int
    var kind: KMTransactionKind
    var payeeName: String? = nil
    var categoryName: String? = nil
    var accountId: String
    var cleared: Bool = false
    var excludedFromSpending: Bool? = nil
    var categoryId: String? = nil
    var memo: String? = nil
    var importedId: String? = nil
    var isSplit: Bool? = nil
    var transferAccountId: String? = nil
    var transferId: String? = nil
    /// Projection of Actual's split children, not extra serialized ActualTransaction fields.
    var splits: [KMTransactionSplit]? = nil
}

// TS: src/lib/actual-browser-ledger.ts readBackSplitSet / actualTransactionSchema.subtransactions.
struct KMTransactionSplit: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var categoryId: String?
    var amountYen: Int
}

// TS: src/lib/actual-ledger.ts ManualTransactionInput; amountYen is positive here (unlike a ledger row).
struct KMManualTransactionInput: Codable, Equatable, Sendable {
    var kind: KMTransactionKind
    var amountYen: Int
    var date: KMDate
    var payeeName: String
    var categoryId: String
    var accountId: String
    var memo: String?
    var importedId: String
    var excludedFromSpending: Bool = false
}

// TS: src/lib/actual-ledger.ts TransferInput.
struct KMTransferInput: Codable, Equatable, Sendable {
    var amountYen: Int
    var date: KMDate
    var sourceAccountId: String
    var destinationAccountId: String
    var memo: String?
    var importedId: String
}

// TS: apps/pwa/src/local-transaction-search.ts TransactionSearchFilters.
struct KMTransactionQuery: Equatable, Sendable {
    var kind: KMTransactionKind? = nil
    var startDate: KMDate? = nil
    var endDate: KMDate? = nil
    var accountId: String? = nil
    var categoryId: String? = nil
    var keyword: String = ""
    var minimumAmountYen: Int? = nil
    var maximumAmountYen: Int? = nil
    /// PWA records fetch 100 before the kind filter; search callers may use nil.
    var limit: Int? = 100
}

import Foundation

// TS: src/lib/local-backup-format.ts — statementImport schema
struct KMStatementImport: Codable, Equatable, Sendable {
    struct NeedsReviewRow: Codable, Equatable, Sendable {
        var rowNumber: Int
        var reason: String
    }

    var provider: KMStatementProvider
    var fileHash: String
    var encoding: String
    var accountId: String?
    var headerSignature: String
    var totalRows: Int
    var excludedRows: Int
    var duplicateRowsInFile: Int
    var needsReviewRows: [NeedsReviewRow]?
    var createdAt: Date
}

// TS: src/lib/local-backup-format.ts — statement schema
struct KMStatementTransaction: Codable, Equatable, Sendable, Identifiable {
    enum Kind: String, Codable, Equatable, Sendable { case purchase, refund }

    var id: String
    var importId: String
    var provider: KMStatementProvider
    var externalId: String?
    var kind: Kind
    var usedDate: KMDate
    var usedTime: String?
    var postedDate: KMDate?
    var merchant: String
    var amountYen: Int
    var paymentMethod: String?
    var sourceFingerprint: String
    var duplicateOrdinal: Int
}

// TS: src/lib/local-backup-format.ts — reconciliationRun schema
struct KMReconciliationRun: Codable, Equatable, Sendable, Identifiable {
    var id: String { runId }

    var runId: String
    var createdAt: Date
    var completedAt: Date
    var inputFingerprint: String?
    var ruleVersion: String
    var candidates: [KMReconciliationCandidate]
    var statementResults: [KMReconciliationStatementResult]
    var receiptResults: [KMReconciliationReceiptResult]
}

// TS: src/lib/local-backup-format.ts — runResult schema
struct KMReconciliationResult: Codable, Equatable, Sendable {
    var ruleVersion: String
    var candidates: [KMReconciliationCandidate]
    var statementResults: [KMReconciliationStatementResult]
    var receiptResults: [KMReconciliationReceiptResult]
}

// TS: src/lib/local-backup-format.ts — candidate schema
struct KMReconciliationCandidate: Codable, Equatable, Sendable {
    var statementTransactionId: String
    var receiptId: String
    var rank: Int
    var score: Decimal
    var amountDeltaYen: Int
    var dateDistanceDays: Int
    var merchantSimilarity: Decimal
    var reasons: [String]
}

// TS: src/lib/local-backup-format.ts — runResult.statementResults element
struct KMReconciliationStatementResult: Codable, Equatable, Sendable {
    enum Status: String, Codable, Equatable, Sendable {
        case matched, needsReview = "needs_review", unmatchedStatement = "unmatched_statement"
    }

    var statementTransactionId: String
    var status: Status
    var matchedReceiptId: String?
    var reasonCodes: [String]
}

// TS: src/lib/local-backup-format.ts — runResult.receiptResults element
struct KMReconciliationReceiptResult: Codable, Equatable, Sendable {
    enum Status: String, Codable, Equatable, Sendable {
        case matched, needsReview = "needs_review", unmatchedReceipt = "unmatched_receipt"
    }

    var receiptId: String
    var status: Status
    var matchedStatementTransactionId: String?
    var reasonCodes: [String]
}

// TS: src/lib/local-backup-format.ts — resolution schema
struct KMReconciliationResolution: Codable, Equatable, Sendable, Identifiable {
    enum Resolution: String, Codable, Equatable, Sendable { case sameExpense = "same_expense", noReceipt = "no_receipt", transfer, ignored }
    enum Source: String, Codable, Equatable, Sendable { case automatic, user }
    enum Status: String, Codable, Equatable, Sendable { case pending, processing, applied, failed }

    struct ActualSnapshot: Codable, Equatable, Sendable {
        var date: KMDate
        var amountYen: Int
        var payeeName: String?
        var accountId: String
        var isSplit: Bool?
        var cleared: Bool?
    }

    struct StatementSnapshot: Codable, Equatable, Sendable {
        var usedDate: KMDate
        var merchant: String
        var kind: KMStatementTransaction.Kind
    }

    var id: String
    var runId: String
    var statementId: String
    var resolution: Resolution
    var source: Source
    var receiptId: String?
    var categoryId: String?
    var accountId: String?
    var statementAmountYen: Int
    var importedId: String?
    var status: Status
    var actualTransactionId: String?
    var actualSnapshot: ActualSnapshot?
    var statementSnapshot: StatementSnapshot?
    var destinationAccountId: String?
    var excludedFromSpending: Bool?
    var undoRequestedAt: Date?
    var errorCode: String?
    var createdAt: Date
    var updatedAt: Date
}

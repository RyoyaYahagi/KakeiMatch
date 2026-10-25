import Foundation

// TS: apps/pwa/src/local-receipts.ts — ReceiptItem
struct KMReceiptItem: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var amountYen: Int?
    var quantity: Decimal?
    var unitPriceYen: Int?
    var categoryId: String?
}

// TS: apps/pwa/src/local-receipts.ts — ReceiptAdjustment
struct KMReceiptAdjustment: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String
    var amountYen: Int
    var targetItemId: String?
}

// TS: apps/pwa/src/local-receipts.ts — ConfirmedReceiptValue
struct KMConfirmedReceipt: Codable, Equatable, Sendable {
    var merchant: String
    var purchasedDate: KMDate
    var purchasedTime: String?
    var totalAmountYen: Int
    var categoryId: String
    var accountId: String
    var excludedFromSpending: Bool?
    var memo: String?
    var taxAmountYen: Int?
    var items: [KMReceiptItem]?
    var adjustments: [KMReceiptAdjustment]?
}

// TS: src/lib/receipt-extraction.ts — ReceiptExtractionResult
struct KMReceiptExtraction: Codable, Equatable, Sendable {
    enum DocumentKind: String, Codable, Equatable, Sendable {
        case receipt
        case notReceipt = "not_receipt"
        case unknown
    }

    enum WarningField: String, Codable, Equatable, Sendable {
        case merchant, purchasedDate, purchasedTime, totalAmountYen, taxAmountYen, items, adjustments
    }

    struct Item: Codable, Equatable, Sendable {
        var name: String
        var amountYen: Int?
        var quantity: Decimal?
        var unitPriceYen: Int?
    }

    struct Adjustment: Codable, Equatable, Sendable {
        var label: String
        var amountYen: Int
        var targetItemIndex: Int?
    }

    struct Warning: Codable, Equatable, Sendable {
        var field: WarningField?
        var code: String
        var message: String
        var index: Int?
    }

    var documentKind: DocumentKind
    var merchant: String?
    var purchasedDate: KMDate?
    var purchasedTime: String?
    var totalAmountYen: Int?
    var taxAmountYen: Int?
    var items: [Item]
    var adjustments: [Adjustment]?
    var warnings: [Warning]
}

// TS: apps/pwa/src/local-receipts.ts — LocalReceipt
struct KMReceipt: Codable, Equatable, Sendable, Identifiable {
    enum SuggestionSource: String, Codable, Equatable, Sendable {
        case merchantMapping = "merchant_mapping"
        case learnedRule = "learned_rule"
        case jev
        case unclassified
    }

    enum RegistrationStatus: String, Codable, Equatable, Sendable {
        case pending, processing, applied, failed, deleted
    }

    struct Image: Codable, Equatable, Sendable {
        var blobId: String
        var contentType: String
        var sizeBytes: Int
    }

    struct ClassificationAttempt: Codable, Equatable, Sendable {
        var flowId: String?
        var model: String
        var attemptedAt: Date
        var itemCategories: [String?]?
        var categoryId: String?
    }

    struct CategoryRuleApplication: Codable, Equatable, Sendable {
        enum TargetType: String, Codable, Equatable, Sendable { case merchant, item }

        var targetType: TargetType
        var normalizedName: String
        var categoryId: String
        var categoryName: String
        var receipts: Int
        var matchingReceipts: Int
        var agreementPercent: Int
    }

    struct AISuggestion: Codable, Equatable, Sendable {
        var categoryId: String?
        var source: SuggestionSource
        var probabilities: [String: Decimal]?
        var model: String?
        var attemptedAt: Date?
        var flowId: String?
        var categoryRules: [CategoryRuleApplication]?
    }

    struct Registration: Codable, Equatable, Sendable {
        var status: RegistrationStatus
        var actualTransactionId: String?
        var lastError: String?
    }

    var id: String
    var createdAt: Date
    var updatedAt: Date
    var image: Image?
    var extraction: KMReceiptExtraction?
    var aiFlowId: String?
    var itemCategories: [String?]?
    var reviewedWarnings: [Int]?
    var classificationAttempt: ClassificationAttempt?
    var aiSuggestion: AISuggestion
    var confirmedValue: KMConfirmedReceipt?
    var registration: Registration
}

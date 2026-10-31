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

// TS: apps/pwa/src/local-ui.ts — ReceiptDraft
/// Unfinished editor input. Kept separate from `KMConfirmedReceipt`; empty or malformed
/// amount text stays as typed so a partially filled form can be reopened unchanged.
struct KMReceiptDraft: Codable, Equatable, Sendable {
    var merchant: String
    var purchasedDate: String
    var purchasedTime: String?
    var totalAmountText: String
    var categoryId: String
    var accountId: String
    var items: [KMReceiptItem]
    var adjustments: [KMReceiptAdjustment]
    var taxAmountText: String
    var memo: String?
    var excludedFromSpending: Bool

    /// PWA local-ui.ts: an empty form is saved but not restored over confirmed/extracted values.
    var isUseful: Bool {
        !merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || (Int(totalAmountText) ?? 0) > 0 || !items.isEmpty
    }
}

// TS: src/lib/receipt-validation.ts — detectContentType / validateReceiptImage
enum KMReceiptImageValidation {
    static let maxBytes = 10 * 1024 * 1024
    static let contentTypes = ["image/jpeg", "image/png", "image/webp"]

    static func validate(_ data: Data, declaredContentType: String) throws -> KMReceipt.Image {
        guard !data.isEmpty else { throw KMDataError.invalidData("画像ファイルを選択してください。") }
        guard data.count <= maxBytes else { throw KMDataError.invalidData("画像のサイズは10 MiB以下にしてください。") }
        guard contentTypes.contains(declaredContentType) else {
            throw KMDataError.invalidData("JPEG、PNG、WebP形式の画像を選択してください。")
        }
        guard let detected = detect(data) else {
            throw KMDataError.invalidData("画像形式を確認できませんでした。JPEG、PNG、WebP形式の画像を選択してください。")
        }
        guard detected == declaredContentType else {
            throw KMDataError.invalidData("画像の形式がファイル情報と一致しません。画像を選び直してください。")
        }
        return .init(blobId: "", contentType: detected, sizeBytes: data.count)
    }

    static func detect(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.count >= 3, bytes[0] == 0xff, bytes[1] == 0xd8, bytes[2] == 0xff { return "image/jpeg" }
        if bytes.count >= 8, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].enumerated().allSatisfy({ $1 == bytes[$0] }) {
            return "image/png"
        }
        if bytes.count >= 12, String(decoding: bytes[0..<4], as: UTF8.self) == "RIFF",
           String(decoding: bytes[8..<12], as: UTF8.self) == "WEBP" { return "image/webp" }
        return nil
    }
}

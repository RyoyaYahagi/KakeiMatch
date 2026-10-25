import Foundation

// TS: src/lib/category-learning.ts — CategoryLearningObservation
struct KMCategoryLearningObservation: Codable, Equatable, Sendable {
    enum TargetType: String, Codable, Equatable, Sendable { case categoryLearning = "category-learning" }

    struct Item: Codable, Equatable, Sendable {
        var normalizedName: String
        var categoryId: String?
    }

    var targetType: TargetType
    var receiptId: String
    var normalizedMerchant: String
    var merchantCategoryId: String?
    var items: [Item]
    var confirmedAt: Date
}

// TS: apps/pwa/src/local-category-learning.ts — LocalCategoryRule (read-only derived screen projection).
struct KMCategoryLearningRule: Codable, Equatable, Sendable, Identifiable {
    var id: String { targetType.rawValue + ":" + normalizedName }
    var targetType: KMCategoryRuleStats.TargetType
    var normalizedName: String
    var categoryId: String
    var receipts: Int
    var matchingReceipts: Int
    var agreementPercent: Int
    var enabled: Bool
    var deleted: Bool
}

// TS: apps/pwa/src/local-category-learning.ts — RuleOverride.
struct KMCategoryRuleOverride: Codable, Equatable, Sendable {
    var targetType: KMCategoryRuleStats.TargetType
    var normalizedName: String
    var disabled: Bool?
    var deleted: Bool?
    var categoryId: String?
}

// TS: src/lib/category-learning.ts — CategoryRuleStats
struct KMCategoryRuleStats: Codable, Equatable, Sendable {
    enum TargetType: String, Codable, Equatable, Sendable { case merchant, item }

    var targetType: TargetType
    var normalizedName: String
    var categoryId: String
    var receipts: Int
    var matchingReceipts: Int
    var agreementPercent: Int
}

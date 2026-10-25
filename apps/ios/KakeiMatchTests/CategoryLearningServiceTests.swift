import Foundation
import Testing
@testable import KakeiMatch

struct CategoryLearningServiceTests {
    private func observation(_ id: String, category: String? = "food-custom", at time: TimeInterval = 0,
                             merchantCategory: String? = "food-custom", items: [KMCategoryLearningObservation.Item]? = nil) -> KMCategoryLearningObservation {
        KMCategoryLearningObservation(targetType: .categoryLearning, receiptId: id, normalizedMerchant: "synthetic market",
            merchantCategoryId: merchantCategory,
            items: items ?? [.init(normalizedName: "synthetic milk", categoryId: category)],
            confirmedAt: Date(timeIntervalSince1970: time))
    }

    @Test func requiresThreeIndependentReceiptsAndEightyPercentAgreement() {
        #expect(KMCategoryLearningService.deriveRules(observations: [observation("a"), observation("b")], availableCategoryIds: ["food-custom"]).items.isEmpty)
        let unanimous = [observation("a"), observation("b"), observation("c")]
        #expect(KMCategoryLearningService.deriveRules(observations: unanimous, availableCategoryIds: ["food-custom"]).items["synthetic milk"] == "food-custom")
        let four = unanimous + [observation("d", category: "home-custom")]
        #expect(KMCategoryLearningService.deriveRules(observations: four, availableCategoryIds: ["food-custom", "home-custom"]).items.isEmpty)
        let five = four + [observation("e")]
        #expect(KMCategoryLearningService.deriveStats(observations: five, availableCategoryIds: ["food-custom", "home-custom"]).first?.agreementPercent == 80)
    }

    @Test func replacesReceiptEditsAndDeduplicatesRepeatedItems() {
        let repeated = observation("a", items: [.init(normalizedName: "synthetic milk", categoryId: "food-custom"), .init(normalizedName: "synthetic milk", categoryId: "food-custom")])
        #expect(KMCategoryLearningService.deriveRules(observations: [repeated, repeated, repeated], availableCategoryIds: ["food-custom"]).items.isEmpty)
        let newer = observation("a", category: "home-custom", at: 2)
        let replaced = [observation("a"), observation("b"), observation("c"), newer]
        #expect(KMCategoryLearningService.deriveRules(observations: replaced, availableCategoryIds: ["food-custom", "home-custom"]).items.isEmpty)
    }

    @Test func excludesUnavailableVotesButKeepsThemInDenominatorAndRejectsMixedMerchants() {
        let history = [observation("a"), observation("b"), observation("c"), observation("d", category: "removed"), observation("e", category: "removed", merchantCategory: nil)]
        let stats = KMCategoryLearningService.deriveStats(observations: history, availableCategoryIds: ["food-custom"])
        #expect(stats.contains { $0.targetType == .item && $0.matchingReceipts == 3 && $0.receipts == 5 })
        #expect(!stats.contains { $0.targetType == .merchant })
        #expect(KMCategoryLearningService.deriveRules(observations: [observation("x"), observation("y"), observation("z")], availableCategoryIds: ["home-custom"]).items.isEmpty)
    }

    @Test func confirmationCreatesOneNormalizedObservationAndOmitsEmptyMerchant() {
        let timestamp = Date(timeIntervalSince1970: 0)
        let mixed = KMCategoryLearningService.observation(receiptId: "receipt", merchant: " Synthetic ＭＡＲＫＥＴ ",
            defaultCategoryId: "food-custom", items: [("Milk", "food-custom"), ("Soap", "home-custom"), ("   ", nil)],
            availableCategoryIds: ["food-custom", "home-custom"], confirmedAt: timestamp)
        #expect(mixed?.normalizedMerchant == "synthetic market")
        #expect(mixed?.merchantCategoryId == nil)
        #expect(mixed?.items.count == 2)
        #expect(KMCategoryLearningService.observation(receiptId: "receipt", merchant: "  ", defaultCategoryId: nil,
            items: [], availableCategoryIds: [], confirmedAt: timestamp) == nil)
    }

    @Test func normalizesConservativelyAndAppliesOverrides() {
        #expect(KMCategoryLearningService.normalizeName("  Synthetic ＭＩＬＫ  ") == "synthetic milk")
        #expect(KMCategoryLearningService.normalizeName(String(repeating: "x", count: 1_001)).isEmpty)
        #expect(KMCategoryLearningService.normalizeName("Synthetic Milk 2") != KMCategoryLearningService.normalizeName("Synthetic Milk"))
        let stats = KMCategoryLearningService.deriveStats(observations: [observation("a"), observation("b"), observation("c")], availableCategoryIds: ["food-custom"])
        let overridden = KMCategoryLearningService.applyingOverrides(stats, overrides: [.init(targetType: .item, normalizedName: "synthetic milk", disabled: true, deleted: nil, categoryId: "home-custom")], availableCategoryIds: ["food-custom", "home-custom"])
        #expect(overridden.first?.categoryId == "home-custom")
        #expect(overridden.first?.enabled == false)
        let deleted = KMCategoryLearningService.applyingOverrides(stats, overrides: [.init(targetType: .item, normalizedName: "synthetic milk", disabled: nil, deleted: true, categoryId: nil)], availableCategoryIds: ["food-custom"])
        #expect(deleted.first?.deleted == true)
        let suggestion = KMCategoryLearningService.suggest(merchant: "Synthetic Market", itemNames: ["Synthetic ＭＩＬＫ", "unknown"],
            categories: [.init(id: "food-custom", name: "Synthetic Food")], observations: [observation("a"), observation("b"), observation("c")], overrides: [])
        #expect(suggestion.merchantCategoryId == "food-custom")
        #expect(suggestion.itemCategories == ["food-custom", nil])
        #expect(suggestion.hasMerchantHistory)
    }
}

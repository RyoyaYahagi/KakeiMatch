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

    @Test func javascriptWhitespaceAndCombiningCharactersMatchNodeOracle() {
        // Expected values from /tmp/ios-282-oracle.ts running the unchanged TS.
        #expect(KMCategoryLearningService.normalizeName("\u{FEFF}Ａ\u{FEFF}Ｂ\u{FEFF}") == "a b")
        #expect(KMCategoryLearningService.normalizeName("\u{0085}Ａ\u{0085}Ｂ\u{0085}") == "\u{0085}a\u{0085}b\u{0085}")
        #expect(KMCategoryLearningService.normalizeName("A\u{0301} B") == "Á b")
        #expect(KMReconciliationEngine.normalizeMerchant("\u{FEFF}Ａ\u{FEFF}Ｂ\u{FEFF}") == "ab")
        #expect(KMReconciliationEngine.normalizeMerchant("\u{0085}Ａ\u{0085}Ｂ\u{0085}") == "\u{0085}a\u{0085}b\u{0085}")
    }

    @Test func confirmationResolvesLegacyCategoryLabelsAndPreservesInvalidVotes() throws {
        let categories: [KMCategoryLearningCandidate] = [.init(id: "actual-food", name: "食費"), .init(id: "custom", name: "Custom")]
        let timestamp = Date(timeIntervalSince1970: 0)
        let cases: [[(name: String, categoryId: String?)]] = [[], [("Milk", "food")]]
        for items in cases {
            let value = try #require(KMCategoryLearningService.observation(receiptId: "r", merchant: "Store", defaultCategoryId: "food",
                items: items, categories: categories, confirmedAt: timestamp))
            #expect(value.merchantCategoryId == "actual-food")
            #expect(value.items.allSatisfy { $0.categoryId == "actual-food" })
        }
        let invalid = KMCategoryLearningService.observation(receiptId: "r", merchant: "Store", defaultCategoryId: "food",
            items: [("Milk", "removed")], categories: categories, confirmedAt: timestamp)
        #expect(invalid?.merchantCategoryId == nil)
        #expect(invalid?.items.first?.categoryId == nil)
    }

    @Test func appliedRulesCarryImmutableCategoryNameEvidence() throws {
        let history = [observation("a"), observation("b"), observation("c")]
        let suggestion = KMCategoryLearningService.suggest(merchant: "Synthetic Market", itemNames: ["Synthetic Milk"],
            categories: [.init(id: "food-custom", name: "Food")], observations: history, overrides: [])
        let rule = try #require(suggestion.itemRules.first ?? nil)
        #expect(rule.categoryName == "Food" && rule.receipts == 3 && rule.agreementPercent == 100)
        let unnamed = KMCategoryLearningService.suggest(merchant: nil, itemNames: ["Synthetic Milk"],
            categories: [.init(id: "food-custom", name: "")], observations: history, overrides: [])
        #expect(unnamed.itemCategories == [nil])
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
        #expect(!stats.contains { $0.targetType == .item })
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

    @Test func merchantCategoryIncludesCategoriesFromItemsWithoutLearnableNames() {
        let timestamp = Date(timeIntervalSince1970: 0)
        let blankOnly = KMCategoryLearningService.observation(receiptId: "receipt", merchant: "Synthetic Market",
            defaultCategoryId: "home-custom", items: [("   ", "food-custom")],
            availableCategoryIds: ["food-custom", "home-custom"], confirmedAt: timestamp)
        #expect(blankOnly?.items.isEmpty == true)
        #expect(blankOnly?.merchantCategoryId == "food-custom")

        let mixed = KMCategoryLearningService.observation(receiptId: "receipt-2", merchant: "Synthetic Market",
            defaultCategoryId: "home-custom", items: [("Milk", "food-custom"), ("   ", nil)],
            availableCategoryIds: ["food-custom", "home-custom"], confirmedAt: timestamp)
        #expect(mixed?.merchantCategoryId == nil)
        #expect(mixed?.items.map(\.categoryId) == ["food-custom"])
    }

    @Test func rulesPreserveFirstSeenMapOrder() {
        let observations = ["zebra", "apple"].flatMap { name in
            (1...3).map { index in
                KMCategoryLearningObservation(targetType: .categoryLearning, receiptId: "\(name)-\(index)",
                    normalizedMerchant: "merchant-\(name)", merchantCategoryId: "food-custom",
                    items: [.init(normalizedName: name, categoryId: "food-custom")],
                    confirmedAt: Date(timeIntervalSince1970: TimeInterval(index)))
            }
        }
        let stats = KMCategoryLearningService.deriveStats(observations: observations, availableCategoryIds: ["food-custom"])
        #expect(stats.filter { $0.targetType == .item }.map(\.normalizedName) == ["zebra", "apple"])
        #expect(stats.filter { $0.targetType == .merchant }.map(\.normalizedName) == ["merchant-zebra", "merchant-apple"])
    }

    @Test func normalizesConservativelyAndAppliesOverrides() {
        #expect(KMCategoryLearningService.normalizeName("  Synthetic ＭＩＬＫ  ") == "synthetic milk")
        #expect(KMCategoryLearningService.normalizeName(String(repeating: "x", count: 1_001)).isEmpty)
        #expect(KMCategoryLearningService.normalizeName(String(repeating: "😀", count: 501)).isEmpty)
        #expect(KMCategoryLearningService.normalizeName(String(repeating: "😀", count: 500)).utf16.count == 1_000)
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

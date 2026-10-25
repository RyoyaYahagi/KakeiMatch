import Foundation

struct KMCategoryLearningCandidate: Equatable, Sendable {
    var id: String
    var name: String
}

struct KMCategoryLearningSuggestion: Equatable, Sendable {
    var merchantCategoryId: String?
    var itemCategories: [String?]
    var hasMerchantHistory: Bool
    var merchantRule: KMReceipt.CategoryRuleApplication?
    var itemRules: [KMReceipt.CategoryRuleApplication?]
}

/// Deterministic port of src/lib/category-learning.ts and the pure learning
/// portions of apps/pwa/src/local-category-learning.ts.
enum KMCategoryLearningService {
    static let minimumReceipts = 3
    static let minimumAgreementPercent = 80

    static func normalizeName(_ value: String) -> String {
        KMJSString.normalizedLearningName(value)
    }

    /// Creates the replacement observation for one confirmed receipt. Empty normalized
    /// merchant names are intentionally not learned, matching LocalCategoryLearning.
    static func observation(receiptId: String, merchant: String, defaultCategoryId: String?,
                            items: [(name: String, categoryId: String?)], availableCategoryIds: Set<String>, confirmedAt: Date) -> KMCategoryLearningObservation? {
        let merchantName = normalizeName(merchant)
        guard !merchantName.isEmpty, !receiptId.isEmpty else { return nil }
        let itemCategories = items.map { item -> String? in
            let selected = item.categoryId ?? defaultCategoryId
            return selected.flatMap { availableCategoryIds.contains($0) ? $0 : nil }
        }
        let normalizedItems = items.compactMap { item -> KMCategoryLearningObservation.Item? in
            let name = normalizeName(item.name)
            guard !name.isEmpty else { return nil }
            let selected = item.categoryId ?? defaultCategoryId
            let categoryId = selected.flatMap { availableCategoryIds.contains($0) ? $0 : nil }
            return .init(normalizedName: name, categoryId: categoryId)
        }
        let fallback = defaultCategoryId.flatMap { availableCategoryIds.contains($0) ? $0 : nil }
        let effectiveCategories = Set(items.isEmpty ? [fallback] : itemCategories)
        return KMCategoryLearningObservation(targetType: .categoryLearning, receiptId: receiptId,
            normalizedMerchant: merchantName, merchantCategoryId: effectiveCategories.count == 1 ? effectiveCategories.first! : nil,
            items: normalizedItems, confirmedAt: confirmedAt)
    }

    /// Resolve legacy category names only after checking for a current exact ID.
    static func observation(receiptId: String, merchant: String, defaultCategoryId: String?,
                            items: [(name: String, categoryId: String?)], categories: [KMCategoryLearningCandidate],
                            confirmedAt: Date) -> KMCategoryLearningObservation? {
        let labels = ["food": "食費", "household": "日用品", "transport": "交通", "medical": "医療・健康",
                      "clothing": "衣服・美容", "entertainment": "趣味・娯楽", "utilities": "水道・光熱",
                      "communications": "通信", "other": "その他"]
        func resolve(_ id: String?) -> String? {
            guard let id else { return nil }
            if categories.contains(where: { $0.id == id }) { return id }
            guard let name = labels[id] else { return nil }
            return categories.first { $0.name == name }?.id
        }
        // Resolve after applying the default: an invalid explicit item category must
        // remain nil, not silently fall back to the receipt's category.
        let resolvedItems = items.map { (name: $0.name, categoryId: resolve($0.categoryId ?? defaultCategoryId)) }
        let value = observation(receiptId: receiptId, merchant: merchant, defaultCategoryId: nil,
            items: resolvedItems, availableCategoryIds: Set(categories.map(\.id)), confirmedAt: confirmedAt)
        guard items.isEmpty else { return value }
        var result = value
        result?.merchantCategoryId = resolve(defaultCategoryId)
        return result
    }

    static func deriveStats(observations: [KMCategoryLearningObservation], availableCategoryIds: Set<String>) -> [KMCategoryRuleStats] {
        var current: [String: KMCategoryLearningObservation] = [:]
        var receiptOrder: [String] = []
        for observation in observations {
            if let existing = current[observation.receiptId], existing.confirmedAt > observation.confirmedAt { continue }
            if current[observation.receiptId] == nil { receiptOrder.append(observation.receiptId) }
            current[observation.receiptId] = observation
        }
        var merchants: [String: [String?]] = [:]
        var merchantOrder: [String] = []
        var items: [String: [String?]] = [:]
        var itemOrder: [String] = []
        for receiptId in receiptOrder {
            guard let observation = current[receiptId] else { continue }
            if merchants[observation.normalizedMerchant] == nil { merchantOrder.append(observation.normalizedMerchant) }
            merchants[observation.normalizedMerchant, default: []].append(observation.merchantCategoryId)
            var receiptItems: [String: String?] = [:]
            var receiptItemOrder: [String] = []
            for item in observation.items {
                if let prior = receiptItems[item.normalizedName] {
                    if prior != item.categoryId { receiptItems[item.normalizedName] = .some(nil) }
                } else {
                    receiptItemOrder.append(item.normalizedName)
                    receiptItems[item.normalizedName] = .some(item.categoryId)
                }
            }
            for name in receiptItemOrder {
                guard let category = receiptItems[name] else { continue }
                if items[name] == nil { itemOrder.append(name) }
                items[name, default: []].append(category)
            }
        }
        return stableRules(items, order: itemOrder, type: .item, available: availableCategoryIds) +
            stableRules(merchants, order: merchantOrder, type: .merchant, available: availableCategoryIds, rejectAmbiguous: true)
    }

    static func deriveRules(observations: [KMCategoryLearningObservation], availableCategoryIds: Set<String>) -> (merchants: [String: String], items: [String: String]) {
        var merchants: [String: String] = [:], items: [String: String] = [:]
        for rule in deriveStats(observations: observations, availableCategoryIds: availableCategoryIds) {
            if rule.targetType == .item { items[rule.normalizedName] = rule.categoryId }
            else { merchants[rule.normalizedName] = rule.categoryId }
        }
        return (merchants, items)
    }

    static func applyingOverrides(_ stats: [KMCategoryRuleStats], overrides: [KMCategoryRuleOverride], availableCategoryIds: Set<String>) -> [KMCategoryLearningRule] {
        let byKey = Dictionary(overrides.map { (key($0.targetType, $0.normalizedName), $0) }, uniquingKeysWith: { _, last in last })
        return stats.map { rule in
            let override = byKey[key(rule.targetType, rule.normalizedName)]
            let replacement = override?.categoryId.flatMap { availableCategoryIds.contains($0) ? $0 : nil } ?? rule.categoryId
            return KMCategoryLearningRule(targetType: rule.targetType, normalizedName: rule.normalizedName,
                categoryId: replacement, receipts: rule.receipts, matchingReceipts: rule.matchingReceipts,
                agreementPercent: rule.agreementPercent, enabled: override?.disabled != true && override?.deleted != true,
                deleted: override?.deleted == true)
        }
    }

    static func suggest(merchant: String?, itemNames: [String], categories: [KMCategoryLearningCandidate],
                        observations: [KMCategoryLearningObservation], overrides: [KMCategoryRuleOverride]) -> KMCategoryLearningSuggestion {
        let available = Set(categories.map(\.id))
        let stats = deriveStats(observations: observations, availableCategoryIds: available)
        let rules = applyingOverrides(stats, overrides: overrides, availableCategoryIds: available)
        let active: (KMCategoryRuleStats.TargetType, String) -> KMReceipt.CategoryRuleApplication? = { type, name in
            guard let rule = rules.first(where: { $0.targetType == type && $0.normalizedName == name }), rule.enabled,
                  let category = categories.first(where: { $0.id == rule.categoryId }), !category.name.isEmpty else { return nil }
            return KMReceipt.CategoryRuleApplication(targetType: rule.targetType == .item ? .item : .merchant,
                normalizedName: rule.normalizedName, categoryId: rule.categoryId, categoryName: category.name,
                receipts: rule.receipts, matchingReceipts: rule.matchingReceipts, agreementPercent: rule.agreementPercent)
        }
        let merchantKey = normalizeName(merchant ?? "")
        let merchantRule = active(.merchant, merchantKey)
        let itemRules = itemNames.map { active(.item, normalizeName($0)) }
        return KMCategoryLearningSuggestion(merchantCategoryId: merchantRule?.categoryId,
            itemCategories: itemRules.map { $0?.categoryId },
            hasMerchantHistory: observations.contains { $0.normalizedMerchant == merchantKey },
            merchantRule: merchantRule, itemRules: itemRules)
    }

    private static func key(_ type: KMCategoryRuleStats.TargetType, _ name: String) -> String { "\(type.rawValue):\(name)" }

    private static func stableRules(_ groups: [String: [String?]], order: [String], type: KMCategoryRuleStats.TargetType,
                                    available: Set<String>, rejectAmbiguous: Bool = false) -> [KMCategoryRuleStats] {
        order.compactMap { name in
            guard let votes = groups[name], votes.count >= minimumReceipts,
                  !(rejectAmbiguous && votes.contains(where: { $0 == nil })) else { return nil }
            var counts: [String: Int] = [:]
            for vote in votes { if let vote, available.contains(vote) { counts[vote, default: 0] += 1 } }
            guard let winner = counts.keys.sorted(by: { lhs, rhs in
                let left = counts[lhs, default: 0], right = counts[rhs, default: 0]
                return left == right ? localeLess(lhs, rhs) : left > right
            }).first, let matching = counts[winner], matching >= minimumReceipts,
                matching * 100 >= votes.count * minimumAgreementPercent else { return nil }
            return KMCategoryRuleStats(targetType: type, normalizedName: name, categoryId: winner,
                receipts: votes.count, matchingReceipts: matching,
                agreementPercent: (matching * 100 + votes.count / 2) / votes.count)
        }
    }
    private static func localeLess(_ lhs: String, _ rhs: String) -> Bool {
        lhs.compare(rhs, options: [], range: nil, locale: Locale(identifier: "en_US")) == .orderedAscending
    }
}

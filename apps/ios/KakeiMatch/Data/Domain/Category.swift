import Foundation

// TS: apps/pwa/src/category-tone.ts CategoryTone.tone (render-only projection, not persisted in Actual).
enum KMCategoryColorTone: String, Codable, CaseIterable, Sendable { case food, daily, transport, fun, util, comm, other }

// TS: src/lib/actual-browser-ledger.ts ManagedCategory; groupId/tone/usageCount are screen projections.
struct KMCategory: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var isIncome: Bool = false
    var hidden: Bool = false
    var groupName: String = "支出"
    var groupId: String? = nil
    var tone: KMCategoryColorTone? = nil
    var usageCount: Int = 0
}

// TS: Actual API getCategoryGroups() / src/lib/actual-browser-ledger.ts createCategoryGroup.
struct KMCategoryGroup: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var isIncome: Bool = false
    var hidden: Bool = false
    var categoryIds: [String] = []
}

import Foundation

// TS: apps/pwa/src/local-monthly-budget-service.ts — native categories passed to getSummary
struct KMBudgetAggregation: Sendable {
    struct NativeCategory: Equatable, Sendable {
        var categoryId: String
        var categoryName: String
        var nativeBudgetYen: Int
        var spentYen: Int
    }

    static func summarize(
        categories nativeCategories: [NativeCategory],
        settings: KMMonthlyBudgetSettings,
        yearMonth: KMYearMonth
    ) throws -> KMMonthlyBudgetSummary {
        let inputs = try nativeCategories.map { native -> KMMonthlyBudgetCategory in
            guard KMMonthlyBudgetSettings.validIdentifier(native.categoryId),
                  KMMonthlyBudgetSettings.validSafeInteger(native.nativeBudgetYen),
                  KMMonthlyBudgetSettings.validSafeInteger(native.spentYen) else {
                throw KMDataError.invalidData("予算と支出の金額を確認してください。")
            }
            return KMMonthlyBudgetCategory(categoryId: native.categoryId, categoryName: native.categoryName,
                budgetYen: native.nativeBudgetYen, spentYen: native.spentYen, remainingYen: 0, usageRatio: nil)
        }
        return try KMMonthlyBudgetService.summary(yearMonth: yearMonth, settings: settings, nativeCategories: inputs)
    }
}

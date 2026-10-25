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
        let settings = try settings.validated(for: settings.budgetId)
        let rawCategories = try nativeCategories.map { native -> KMMonthlyBudgetCategory in
            guard KMMonthlyBudgetSettings.validIdentifier(native.categoryId),
                  KMMonthlyBudgetSettings.validSafeInteger(native.nativeBudgetYen),
                  KMMonthlyBudgetSettings.validSafeInteger(native.spentYen) else {
                throw KMDataError.invalidData("予算と支出の金額を確認してください。")
            }
            let budget = try settings.effectiveMonthlyBudget(
                yearMonth: yearMonth,
                categoryId: native.categoryId,
                nativeBudgetYen: native.nativeBudgetYen
            )
            let remaining = try budget.map { try subtract($0, native.spentYen) } ?? 0
            return KMMonthlyBudgetCategory(
                categoryId: native.categoryId,
                categoryName: native.categoryName,
                budgetYen: budget,
                spentYen: native.spentYen,
                remainingYen: remaining,
                usageRatio: ratio(spent: native.spentYen, budget: budget)
            )
        }
        let legacyTargeted = rawCategories.filter { $0.budgetYen != nil && $0.budgetYen! >= 0 }
        let explicitOverall = settings.effectiveOverallBudget(yearMonth: yearMonth)
        let breakdownEnabled = settings.effectiveBreakdownEnabled(
            yearMonth: yearMonth,
            legacyHasCategoryBudgets: !legacyTargeted.isEmpty
        )
        let categories = breakdownEnabled ? rawCategories : rawCategories.map {
            KMMonthlyBudgetCategory(categoryId: $0.categoryId, categoryName: $0.categoryName,
                                    budgetYen: nil, spentYen: $0.spentYen, remainingYen: 0, usageRatio: nil)
        }
        let budgetConfigured = explicitOverall != nil || !legacyTargeted.isEmpty
        let budgetYen = try explicitOverall ?? sum(legacyTargeted.compactMap(\.budgetYen))
        let spentYen = try sum((explicitOverall != nil ? rawCategories : legacyTargeted).map(\.spentYen))
        let remainingYen = try subtract(budgetYen, spentYen)
        return KMMonthlyBudgetSummary(
            yearMonth: yearMonth,
            categories: categories,
            budgetYen: budgetYen,
            spentYen: spentYen,
            remainingYen: remainingYen,
            usageRatio: budgetConfigured ? ratio(spent: spentYen, budget: budgetYen) : nil,
            budgetConfigured: budgetConfigured,
            overallBudgetConfigured: explicitOverall != nil,
            breakdownEnabled: breakdownEnabled
        )
    }

    private static func ratio(spent: Int, budget: Int?) -> Decimal? {
        guard let budget, budget != 0 else { return nil }
        return Decimal(spent) / Decimal(budget)
    }

    private static func sum<S: Sequence>(_ values: S) throws -> Int where S.Element == Int {
        var total = 0
        for value in values {
            let (next, overflow) = total.addingReportingOverflow(value)
            guard !overflow, KMMonthlyBudgetSettings.validSafeInteger(next) else { throw KMDataError.amountOverflow }
            total = next
        }
        return total
    }

    private static func subtract(_ lhs: Int, _ rhs: Int) throws -> Int {
        let (result, overflow) = lhs.subtractingReportingOverflow(rhs)
        guard !overflow, result >= -KMYen.maxSafe,
              result <= KMYen.maxSafe else { throw KMDataError.amountOverflow }
        return result
    }
}

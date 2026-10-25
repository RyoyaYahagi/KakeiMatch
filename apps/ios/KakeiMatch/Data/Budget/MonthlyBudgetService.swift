import Foundation

/// Pure calculations ported from apps/pwa/src/local-monthly-budget-service.ts.
enum KMMonthlyBudgetService {
    static func summary(yearMonth: KMYearMonth, settings: KMMonthlyBudgetSettings,
                        nativeCategories: [KMMonthlyBudgetCategory]) throws -> KMMonthlyBudgetSummary {
        let settings = try settings.validated(for: settings.budgetId)
        let raw = try nativeCategories.map { native -> KMMonthlyBudgetCategory in
            let budget = try settings.effectiveMonthlyBudget(yearMonth: yearMonth, categoryId: native.categoryId,
                                                              nativeBudgetYen: native.budgetYen ?? 0)
            let remaining: Int
            if let budget {
                let (difference, overflow) = budget.subtractingReportingOverflow(native.spentYen)
                guard !overflow else { throw KMDataError.amountOverflow }
                remaining = try KMYen.checked(difference)
            } else { remaining = 0 }
            return KMMonthlyBudgetCategory(categoryId: native.categoryId, categoryName: native.categoryName,
                budgetYen: budget, spentYen: native.spentYen, remainingYen: remaining,
                usageRatio: budget.flatMap { ratio(spent: native.spentYen, budget: $0) })
        }
        let targeted = raw.filter { $0.budgetYen != nil && $0.budgetYen! >= 0 }
        let explicit = settings.effectiveOverallBudget(yearMonth: yearMonth)
        let breakdown = settings.effectiveBreakdownEnabled(yearMonth: yearMonth, legacyHasCategoryBudgets: !targeted.isEmpty)
        let categories = breakdown ? raw : raw.map {
            KMMonthlyBudgetCategory(categoryId: $0.categoryId, categoryName: $0.categoryName, budgetYen: nil,
                                    spentYen: $0.spentYen, remainingYen: 0, usageRatio: nil)
        }
        let budget = try explicit ?? targeted.reduce(0) { try KMYen.add($0, $1.budgetYen!) }
        let spent = try (explicit != nil ? raw : targeted).reduce(0) { try KMYen.add($0, $1.spentYen) }
        let remaining = try KMYen.add(budget, -spent)
        let configured = explicit != nil || !targeted.isEmpty
        return KMMonthlyBudgetSummary(yearMonth: yearMonth, categories: categories, budgetYen: budget,
            spentYen: spent, remainingYen: remaining,
            usageRatio: !configured ? nil : ratio(spent: spent, budget: budget),
            budgetConfigured: configured, overallBudgetConfigured: explicit != nil, breakdownEnabled: breakdown)
    }

    static func defaultPlan(settings: KMMonthlyBudgetSettings) throws -> KMMonthlyBudgetPlan {
        let allocations = settings.defaults
        let legacyConfigured = !allocations.isEmpty
        let total = try settings.defaultTotal ?? (legacyConfigured ? allocations.values.reduce(0) { try KMYen.add($0, $1) } : nil)
        return KMMonthlyBudgetPlan(totalYen: total, breakdownEnabled: settings.defaultBreakdown ?? legacyConfigured,
                                   allocations: allocations)
    }

    static func checkedSum(_ amounts: some Sequence<Int>) throws -> Int {
        try amounts.reduce(0) { try KMYen.add($0, $1) }
    }

    private static func ratio(spent: Int, budget: Int) -> Decimal? {
        guard budget != 0 else { return nil }
        return Decimal(spent) / Decimal(budget)
    }
}

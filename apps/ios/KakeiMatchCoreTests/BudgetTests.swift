import Foundation
import Testing
@testable import KakeiMatchCore

struct BudgetTests {
    private func month(_ value: String = "2026-10") -> KMYearMonth { KMYearMonth(rawValue: value) }

    @Test func inheritedDefaultsAndMonthlyOverrides() throws {
        var settings = KMMonthlyBudgetSettings.empty(budgetId: "budget-a")
        settings = try settings.settingDefaultBudget(categoryId: "food", amount: 30_000)
        #expect(try settings.effectiveMonthlyBudget(yearMonth: month(), categoryId: "food", nativeBudgetYen: 0) == 30_000)
        #expect(try settings.effectiveMonthlyBudget(yearMonth: month("2026-11"), categoryId: "food", nativeBudgetYen: 0) == 30_000)
        settings = try settings.settingMonthlyBudget(yearMonth: month("2026-12"), categoryId: "food", value: .amount(40_000))
        #expect(try settings.effectiveMonthlyBudget(yearMonth: month("2026-12"), categoryId: "food", nativeBudgetYen: 0) == 40_000)
        #expect(try settings.effectiveMonthlyBudget(yearMonth: month("2027-01"), categoryId: "food", nativeBudgetYen: 0) == 30_000)
    }

    @Test func distinguishesUnsetZeroAndInherit() throws {
        var settings = KMMonthlyBudgetSettings.empty(budgetId: "budget-a")
        settings = try settings.settingDefaultBudget(categoryId: "food", amount: 30_000)
        let defaults = settings
        settings = try settings.settingMonthlyBudget(yearMonth: month(), categoryId: "food", value: .amount(0))
        #expect(try settings.effectiveMonthlyBudget(yearMonth: month(), categoryId: "food", nativeBudgetYen: 0) == 0)
        #expect(try defaults.effectiveMonthlyBudget(yearMonth: month(), categoryId: "food", nativeBudgetYen: 0) == 30_000)
        settings = try settings.settingMonthlyBudget(yearMonth: month(), categoryId: "food", value: .inherit)
        #expect(try settings.effectiveMonthlyBudget(yearMonth: month(), categoryId: "food", nativeBudgetYen: 80_000) == 30_000)
        settings = try settings.settingMonthlyBudget(yearMonth: month(), categoryId: "food", value: nil)
        #expect(try settings.effectiveMonthlyBudget(yearMonth: month(), categoryId: "food", nativeBudgetYen: 80_000) == 80_000)
    }

    @Test func usesUntouchedNativeBudgetAsLegacyFallback() throws {
        let settings = KMMonthlyBudgetSettings.empty(budgetId: "budget-a")
        #expect(try settings.effectiveMonthlyBudget(yearMonth: month(), categoryId: "food", nativeBudgetYen: 25_000) == 25_000)
        #expect(try settings.effectiveMonthlyBudget(yearMonth: month("2026-11"), categoryId: "food", nativeBudgetYen: 0) == nil)
    }

    @Test func validatesPlansAndPromotesLegacyMonthBudget() throws {
        let legacy = try KMMonthlyBudgetSettings.empty(budgetId: "budget-a")
            .settingDefaultBudget(categoryId: "food", amount: 2_500)
            .settingDefaultBudget(categoryId: "home", amount: 1_000)
            .settingMonthlyBudget(yearMonth: month(), categoryId: "food", value: .amount(4_000))
        #expect(throws: (any Error).self) {
            try legacy.applyingDefaultPlan(totalYen: 5_000, breakdownEnabled: true, allocations: ["food": 3_000, "home": 1_000])
        }
        let migrated = try legacy.applyingDefaultPlan(totalYen: 5_000, breakdownEnabled: true, allocations: ["food": 3_000, "home": 2_000])
        #expect(migrated.effectiveOverallBudget(yearMonth: month()) == 6_000)
        #expect(try migrated.effectiveMonthlyBudget(yearMonth: month(), categoryId: "food", nativeBudgetYen: 0) == 4_000)
        #expect(try migrated.effectiveMonthlyBudget(yearMonth: month(), categoryId: "home", nativeBudgetYen: 0) == 2_000)
    }

    @Test func overallOnlyAndMonthlyPlanReset() throws {
        var settings = KMMonthlyBudgetSettings.empty(budgetId: "budget-a")
        settings = try settings.applyingDefaultPlan(totalYen: 50_000, breakdownEnabled: false, allocations: [:])
        #expect(settings.effectiveOverallBudget(yearMonth: month()) == 50_000)
        #expect(settings.effectiveBreakdownEnabled(yearMonth: month(), legacyHasCategoryBudgets: false) == false)
        #expect(settings.defaults.isEmpty)
        settings = try settings.applyingMonthlyPlan(yearMonth: month(), totalYen: 60_000, breakdownEnabled: true,
                                                   allocations: ["food": 40_000, "home": 20_000])
        #expect(settings.hasExplicitMonthlyPlan(yearMonth: month()))
        settings = try settings.resettingMonthlyPlan(yearMonth: month(), categoryIds: ["food", "home"])
        #expect(!settings.hasExplicitMonthlyPlan(yearMonth: month()))
        #expect(settings.effectiveOverallBudget(yearMonth: month()) == 50_000)
        settings = try settings.clearingDefaultPlan()
        #expect(settings.effectiveOverallBudget(yearMonth: month()) == nil)
    }

    @Test func aggregationCountsAllExpensesForOverallAndOnlyBudgetedLegacyCategories() throws {
        let native = [
            KMBudgetAggregation.NativeCategory(categoryId: "food", categoryName: "Synthetic Food", nativeBudgetYen: 3_000, spentYen: 1_200),
            KMBudgetAggregation.NativeCategory(categoryId: "home", categoryName: "Synthetic Home", nativeBudgetYen: 1_000, spentYen: 700),
            KMBudgetAggregation.NativeCategory(categoryId: "other", categoryName: "Synthetic Other", nativeBudgetYen: 0, spentYen: 500),
        ]
        let legacy = try KMBudgetAggregation.summarize(categories: native, settings: .empty(budgetId: "budget-a"), yearMonth: month())
        #expect(legacy.budgetConfigured)
        #expect(!legacy.overallBudgetConfigured)
        #expect(legacy.budgetYen == 4_000)
        #expect(legacy.spentYen == 1_900)
        #expect(legacy.categories[2].budgetYen == nil)
        #expect(legacy.usageRatio == Decimal(1_900) / Decimal(4_000))

        let settings = try KMMonthlyBudgetSettings.empty(budgetId: "budget-a")
            .applyingDefaultPlan(totalYen: 5_000, breakdownEnabled: false, allocations: [:])
        let overall = try KMBudgetAggregation.summarize(categories: native, settings: settings, yearMonth: month())
        #expect(overall.overallBudgetConfigured)
        #expect(!overall.breakdownEnabled)
        #expect(overall.budgetYen == 5_000)
        #expect(overall.spentYen == 2_400)
        #expect(overall.remainingYen == 2_600)
        #expect(overall.categories.allSatisfy { $0.budgetYen == nil })
    }

    @Test func supportsLegacyCodableShapeAndRejectsInvalidValues() throws {
        let legacyJSON = #"{"budgetId":"budget-a","defaults":{"food":1000},"monthlyOverrides":{}}"#.data(using: .utf8)!
        let settings = try JSONDecoder().decode(KMMonthlyBudgetSettings.self, from: legacyJSON)
        #expect(try settings.validated(for: "budget-a").defaults["food"] == 1_000)
        let encoded = try JSONEncoder().encode(settings)
        #expect(try JSONDecoder().decode(KMMonthlyBudgetSettings.self, from: encoded) == settings)
        #expect(throws: (any Error).self) { try KMYearMonth("2026-13") }
        #expect(throws: (any Error).self) { try settings.settingDefaultBudget(categoryId: "food", amount: -1) }
        #expect(throws: (any Error).self) {
            try settings.validated(for: "different-budget")
        }
    }
}

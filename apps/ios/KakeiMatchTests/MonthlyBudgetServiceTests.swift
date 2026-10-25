import Testing
@testable import KakeiMatch

struct MonthlyBudgetServiceTests {
    private let month = KMYearMonth(rawValue: "2026-10")
    private func categories() -> [KMMonthlyBudgetCategory] {
        [
            KMMonthlyBudgetCategory(categoryId: "food", categoryName: "Synthetic Food", budgetYen: 3_000, spentYen: 1_200, remainingYen: 1_800, usageRatio: Decimal(2) / Decimal(5)),
            KMMonthlyBudgetCategory(categoryId: "home", categoryName: "Synthetic Home", budgetYen: 1_000, spentYen: 700, remainingYen: 300, usageRatio: Decimal(7) / Decimal(10)),
            KMMonthlyBudgetCategory(categoryId: "other", categoryName: "Synthetic Other", budgetYen: 0, spentYen: 500, remainingYen: -500, usageRatio: nil),
        ]
    }

    @Test func legacyBudgetSummaryCountsOnlyTargetedCategories() throws {
        let summary = try KMMonthlyBudgetService.summary(yearMonth: month, settings: .empty(budgetId: "budget"), nativeCategories: categories())
        #expect(summary.budgetConfigured)
        #expect(!summary.overallBudgetConfigured)
        #expect(summary.budgetYen == 4_000)
        #expect(summary.spentYen == 1_900)
        #expect(summary.remainingYen == 2_100)
        #expect(summary.categories[2].budgetYen == nil)
    }

    @Test func explicitOverallBudgetIncludesAllSpendingAndCanHideBreakdown() throws {
        let settings = try KMMonthlyBudgetSettings.empty(budgetId: "budget")
            .applyingDefaultPlan(totalYen: 5_000, breakdownEnabled: false, allocations: [:])
        let summary = try KMMonthlyBudgetService.summary(yearMonth: month, settings: settings, nativeCategories: categories())
        #expect(summary.budgetConfigured && summary.overallBudgetConfigured)
        #expect(!summary.breakdownEnabled)
        #expect(summary.budgetYen == 5_000)
        #expect(summary.spentYen == 2_400)
        #expect(summary.remainingYen == 2_600)
        #expect(summary.usageRatio == Decimal(2_400) / Decimal(5_000))
        #expect(summary.categories.allSatisfy { $0.budgetYen == nil })
    }

    @Test func explicitZeroAndBreakdownArePreservedAndCategoryAllocationMustBalance() throws {
        let zero = try KMMonthlyBudgetSettings.empty(budgetId: "budget")
            .applyingMonthlyPlan(yearMonth: month, totalYen: 0, breakdownEnabled: false, allocations: [:])
        let zeroSummary = try KMMonthlyBudgetService.summary(yearMonth: month, settings: zero, nativeCategories: categories())
        #expect(zeroSummary.budgetConfigured)
        #expect(zeroSummary.budgetYen == 0)
        #expect(zeroSummary.usageRatio == nil)

        #expect(throws: (any Error).self) {
            try KMMonthlyBudgetSettings.empty(budgetId: "budget")
                .applyingMonthlyPlan(yearMonth: month, totalYen: 5_000, breakdownEnabled: true, allocations: ["food": 3_000, "home": 1_000])
        }
        let plan = try KMMonthlyBudgetSettings.empty(budgetId: "budget")
            .applyingMonthlyPlan(yearMonth: month, totalYen: 5_000, breakdownEnabled: true, allocations: ["food": 3_000, "home": 2_000])
        let summary = try KMMonthlyBudgetService.summary(yearMonth: month, settings: plan, nativeCategories: categories())
        #expect(summary.breakdownEnabled && summary.overallBudgetConfigured)
        #expect(summary.categories.first(where: { $0.categoryId == "food" })?.budgetYen == 3_000)
    }

    @Test func safelySumsAndRejectsOverflow() throws {
        #expect(try KMMonthlyBudgetService.checkedSum([1_000, 2_000]) == 3_000)
        #expect(throws: (any Error).self) { try KMMonthlyBudgetService.checkedSum([KMYen.maxSafe, 1]) }
        let unsafe = categories().map { row in
            KMMonthlyBudgetCategory(categoryId: row.categoryId, categoryName: row.categoryName, budgetYen: row.budgetYen,
                                    spentYen: KMYen.maxSafe, remainingYen: 0, usageRatio: nil)
        }
        let overall = try KMMonthlyBudgetSettings.empty(budgetId: "budget").applyingDefaultPlan(totalYen: 1, breakdownEnabled: false, allocations: [:])
        #expect(throws: (any Error).self) { try KMMonthlyBudgetService.summary(yearMonth: month, settings: overall, nativeCategories: unsafe) }
    }
}

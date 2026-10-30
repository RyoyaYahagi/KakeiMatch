import Foundation
import Testing
@testable import KakeiMatchCore

struct BudgetPresentationTests {
    @Test func amountParsingMatchesPwaNumberIntegerBoundary() throws {
        #expect(try KMBudgetPresentation.parseYen("0", label: "予算") == 0)
        #expect(try KMBudgetPresentation.parseYen(" 1200 ", label: "予算") == 1_200)
        #expect(try KMBudgetPresentation.parseYen("1e3", label: "予算") == 1_000)
        #expect(throws: (any Error).self) { try KMBudgetPresentation.parseYen("", label: "予算") }
        #expect(throws: (any Error).self) { try KMBudgetPresentation.parseYen("-1", label: "予算") }
        #expect(throws: (any Error).self) { try KMBudgetPresentation.parseYen("1.5", label: "予算") }
        #expect(throws: (any Error).self) { try KMBudgetPresentation.parseYen("9007199254740992", label: "予算") }
    }

    @Test func monthPresentationUsesExplicitGregorianYearMonth() throws {
        let month = try KMYearMonth("2026-01")
        #expect(KMBudgetPresentation.monthLabel(month) == "2026年1月")
        #expect(month.shifted(by: -1).rawValue == "2025-12")
        #expect(month.daysInMonth == 31)
        #expect(try KMYearMonth("2024-02").daysInMonth == 29)
    }

    @Test func categorySumRejectsUnsafeOverflow() throws {
        #expect(try KMBudgetPresentation.checkedSum([20_000, 30_000]) == 50_000)
        #expect(throws: (any Error).self) { try KMBudgetPresentation.checkedSum([KMYen.maxSafe, 1]) }
    }

    @Test func budgetAmountLineShowsRemainingAndUsageRatio() {
        #expect(KMBudgetPresentation.amountLine(budget: 10_000, spent: 12_500, remaining: -2_500, usageRatio: Decimal(1.25)) == "¥12,500 / ¥10,000 · 超過 ¥2,500 · 125.0%")
        #expect(KMBudgetPresentation.amountLine(budget: 10_000, spent: -500, remaining: 10_500, usageRatio: Decimal(-0.05)) == "−¥500 / ¥10,000 · 残り ¥10,500 · −5.0%")
    }
}

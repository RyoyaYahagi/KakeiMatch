import Foundation
import Testing
@testable import KakeiMatchCore

struct HomeAggregationTests {
    @Test func oneSnapshotProducesAttentionCategoriesAndDayScale() {
        let month = KMYearMonth(rawValue: "2026-10")
        let summary = KMMonthlySummary(yearMonth: month, incomeYen: 0, expenseYen: 1_000, balanceYen: -1_000,
            categories: [category("食費", 400), category("日用品", 300), category("通信", 150),
                         category("交通", 100), category("調整", -50)])
        let budget = KMMonthlyBudgetSummary(yearMonth: month, categories: [], budgetYen: 80_000, spentYen: 24_730,
            remainingYen: 55_270, usageRatio: nil, budgetConfigured: true, overallBudgetConfigured: true,
            breakdownEnabled: false)
        let run = KMReconciliationRun(runId: "run", createdAt: .distantPast, completedAt: .distantPast,
            inputFingerprint: nil, ruleVersion: "test",
            candidates: [], statementResults: [
                .init(statementTransactionId: "review", status: .needsReview, matchedReceiptId: nil, reasonCodes: []),
                .init(statementTransactionId: "matched", status: .matched, matchedReceiptId: nil, reasonCodes: [])
            ], receiptResults: [])

        let dashboard = KMHomeAggregation.make(
            snapshot: .init(summary: summary, budget: budget, recentRecords: []),
            run: run, resolutions: [], suspected: [],
            statements: [statement("review"), statement("matched")],
            today: KMDate(rawValue: "2026-10-14"))

        #expect(dashboard.snapshot.summary == summary)
        #expect(dashboard.attention.count == 1)
        #expect(dashboard.attention.matchedCount == 0)
        #expect(!dashboard.attention.showsImportHint)
        #expect(dashboard.attention.items.map(\.merchant) == ["review"])
        #expect(dashboard.attention.items.map(\.severity) == [.warning])
        #expect(dashboard.categorySlices.map(\.name) == ["食費", "日用品", "通信", "その他"])
        #expect(dashboard.categorySlices.map(\.percentage) == ["40.0%", "30.0%", "15.0%", "10.0%"])
        #expect(dashboard.categoryRows.map(\.name) == ["食費", "日用品", "通信", "交通", "調整"])
        #expect(dashboard.categoryRows.map(\.percentage) == ["40.0%", "30.0%", "15.0%", "10.0%", "-5.0%"])
        #expect(dashboard.budgetScale.dayCount == 31)
        #expect(dashboard.budgetScale.filledDayCount == 10)
        #expect(dashboard.budgetScale.elapsedDayCount == 14)
        #expect(dashboard.budgetScale.paceDifferenceYen == -11_399)
        #expect(!dashboard.budgetScale.isOverBudget)
    }

    @Test func noRunKeepsImportHintAndEmptyAttention() {
        let month = KMYearMonth(rawValue: "2026-10")
        let summary = KMMonthlySummary(yearMonth: month, incomeYen: 0, expenseYen: 0, balanceYen: 0, categories: [])
        let budget = KMMonthlyBudgetSummary(yearMonth: month, categories: [], budgetYen: 0, spentYen: 0,
            remainingYen: 0, usageRatio: nil, budgetConfigured: false, overallBudgetConfigured: false,
            breakdownEnabled: false)
        let dashboard = KMHomeAggregation.make(
            snapshot: .init(summary: summary, budget: budget, recentRecords: []),
            run: nil, resolutions: [], suspected: [], statements: [],
            today: KMDate(rawValue: "2026-10-14"))
        #expect(dashboard.attention == .init(count: 0, matchedCount: 0, showsImportHint: true, items: []))
        #expect(dashboard.categorySlices.isEmpty)
        #expect(dashboard.categoryRows.isEmpty)
        #expect(dashboard.budgetScale.elapsedDayCount == 14)
    }

    private func category(_ name: String, _ yen: Int) -> KMMonthlyCategory {
        .init(categoryId: name, categoryName: name, amountYen: yen)
    }

    private func statement(_ id: String) -> KMStatementTransaction {
        .init(id: id, importId: "import", provider: .paypayCard, kind: .purchase,
              usedDate: KMDate(rawValue: "2026-10-14"), merchant: id, amountYen: 100,
              sourceFingerprint: id, duplicateOrdinal: 0)
    }
}

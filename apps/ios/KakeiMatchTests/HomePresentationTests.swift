import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct HomePresentationTests {
    @Test func budgetDayScaleMatchesPWAForNormalAndOverBudgetMonths() async throws {
        let repositories = try KMFixtureLoader.load(named: "populated")
        let today = KMDate(instant: repositories.referenceDate)
        let normal = try await repositories.budgets.budgetSummary(month: KMYearMonth("2026-10"))
        let scale = KMHomeBudgetScale.make(summary: normal, today: today)
        #expect(scale.dayCount == 31)
        #expect(scale.filledDayCount == 10)
        #expect(scale.elapsedDayCount == 14)
        #expect(scale.paceDifferenceYen == -11_399)
        #expect(!scale.isOverBudget)

        let warningRepositories = try KMFixtureLoader.load(named: "budget-warning")
        let warning = try await warningRepositories.budgets.budgetSummary(month: KMYearMonth("2026-10"))
        let warningScale = KMHomeBudgetScale.make(summary: warning, today: today)
        #expect(warningScale.filledDayCount == 31)
        #expect(warningScale.paceDifferenceYen == nil)
        #expect(warningScale.isOverBudget)
    }

    @Test func dayScaleHandlesMonthBoundariesLeapYearZeroAndRounding() {
        func scale(_ month: String, budget: Int = 62, spent: Int = 1) -> KMHomeBudgetScale {
            KMHomeBudgetScale.make(summary: .init(yearMonth: KMYearMonth(rawValue: month), categories: [],
                budgetYen: budget, spentYen: spent, remainingYen: budget - spent, usageRatio: nil,
                budgetConfigured: true, overallBudgetConfigured: true, breakdownEnabled: false), today: KMDate(rawValue: "2026-10-14"))
        }
        // .5 ticks round up; derive from yen rather than a stale/pre-rounded usageRatio.
        #expect(scale("2026-10").filledDayCount == 1)
        #expect(scale("2026-09").elapsedDayCount == 30)
        #expect(scale("2026-11").elapsedDayCount == 0)
        #expect(scale("2026-09").paceDifferenceYen == nil)
        #expect(scale("2028-02").dayCount == 29)
        #expect(scale("2026-02").dayCount == 28)
        #expect(scale("2026-10", budget: 0, spent: 0).filledDayCount == 0)
        #expect(scale("2026-10", budget: 0, spent: 1).isOverBudget)
        #expect(scale("2026-10", budget: 62, spent: 62).filledDayCount == 31)
        #expect(!scale("2026-10", budget: 62, spent: 62).isOverBudget)
    }

    @Test func categoriesSortStablyAvoidDuplicateTonesAndGroupRemainder() {
        let summary = KMMonthlySummary(yearMonth: KMYearMonth(rawValue: "2026-10"), incomeYen: 0, expenseYen: 1_000, balanceYen: -1_000,
            categories: [category("日用品", 100), category("食費", 400), category("外食", 300), category("交通", 100), category("調整", -50), category("通信", 150)])
        let slices = KMHomeCategoryBreakdown.make(summary)
        #expect(slices.map(\.name) == ["食費", "外食", "通信", "その他"])
        #expect(slices.map(\.amountYen) == [400, 300, 150, 200])
        #expect(slices.map(\.tone) == [.food, .daily, .comm, nil])
        #expect(slices.map(\.percentage) == ["40.0%", "30.0%", "15.0%", "20.0%"])
        #expect(slices[0].share == Decimal(400) / Decimal(1050))
        var ties = summary
        ties.categories = [category("交通", 10), category("日用品", 10), category("食費", 10)]
        #expect(KMHomeCategoryBreakdown.make(ties).map(\.name) == ["交通", "日用品", "食費"])
        ties.expenseYen = 0
        #expect(KMHomeCategoryBreakdown.make(ties).isEmpty)
        ties.expenseYen = -50
        ties.categories = [category("返金", -50)]
        #expect(KMHomeCategoryBreakdown.make(ties).isEmpty)
    }

    @Test func percentagesKeepOneDecimalAndIntegerYenPrecision() {
        #expect(KMHomeCategoryBreakdown.percentage(1, total: 3) == "33.3%")
        #expect(KMHomeCategoryBreakdown.percentage(2, total: 3) == "66.7%")
        #expect(KMHomeCategoryBreakdown.percentage(1, total: 16) == "6.3%")
        #expect(KMHomeCategoryBreakdown.percentage(0, total: 1) == "0.0%")
        #expect(KMHomeCategoryBreakdown.percentage(-1, total: 4) == "-25.0%")
        #expect(KMHomeCategoryBreakdown.percentage(-1, total: 100_000) == "-0.0%")
        #expect(KMHomeCategoryBreakdown.percentage(9_000_000_000_001, total: 9_000_000_000_001) == "100.0%")
    }

    @Test func attentionFixtureMatchesPWAThreeRowsAndFourMatches() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let result = KMHomeAttention.make(run: try await repositories.reconciliation.latestRun(),
            resolutions: try await repositories.reconciliation.resolutions(), suspected: [],
            statements: try await repositories.statements.statementTransactions())
        #expect(result.count == 3)
        #expect(result.matchedCount == 4)
        #expect(!result.showsImportHint)
        #expect(result.items.map(\.reason) == ["金額が¥20違います", "記録が見つかりません", "記録が見つかりません"])
    }

    @Test func attentionPriorityCountsAndMissingStatementFallbackMatchPWA() {
        let statements = [statement("review"), statement("unmatched"), statement("flagged"), statement("matched")]
        let resolutions = [decision("missing", status: .failed), decision("matched", status: .applied)]
        let flags = [KMSuspectedStatement(statementId: "flagged", markedAt: .distantPast)]
        let run = run([result("unmatched", .unmatchedStatement), result("flagged", .needsReview), result("review", .needsReview), result("matched", .matched)])
        let attention = KMHomeAttention.make(run: run, resolutions: resolutions, suspected: flags, statements: statements)
        #expect(attention.count == 4)
        #expect(attention.matchedCount == 1)
        #expect(attention.items.map(\.merchant) == ["保存済みの照合", "flagged", "review"])
        #expect(attention.items.map(\.reason) == ["反映できませんでした", "不正利用？として確認待ち", "内容を確認してください"])
        #expect(attention.items.first?.amountYen == 123)
        let noRun = KMHomeAttention.make(run: nil, resolutions: resolutions, suspected: flags, statements: statements)
        #expect(noRun == .init(count: 0, matchedCount: 0, showsImportHint: true, items: []))
        var undone = resolutions[1]
        undone.undoRequestedAt = .distantPast
        let empty = KMHomeAttention.make(run: self.run([]), resolutions: [undone], suspected: [], statements: [])
        #expect(empty.count == 0 && empty.matchedCount == 0 && !empty.showsImportHint)
    }

    @Test(arguments: ["amount", "date", "multiple", "none"])
    func attentionReasonsFollowPWAPriority(_ mode: String) {
        var candidates: [KMReconciliationCandidate] = []
        if mode != "none" {
            candidates = [.init(statementTransactionId: "r", receiptId: "receipt", rank: 1, score: 1,
                amountDeltaYen: mode == "date" ? 0 : -50, dateDistanceDays: 2, merchantSimilarity: 1, reasons: [])]
            if mode == "multiple" { candidates.append(candidates[0]) }
        }
        let result = KMHomeAttention.make(run: run([result("r", .needsReview)], candidates: candidates),
            resolutions: [], suspected: [], statements: [statement("r")])
        let expected = ["amount": "金額が¥50違います", "date": "日付が2日ずれています", "multiple": "候補が2件あります", "none": "内容を確認してください"]
        #expect(result.items.first?.reason == expected[mode])
    }

    private func category(_ name: String, _ yen: Int) -> KMMonthlyCategory {
        .init(categoryId: name, categoryName: name, amountYen: yen)
    }
    private func statement(_ id: String) -> KMStatementTransaction {
        .init(id: id, importId: "import", provider: .paypayCard, kind: .purchase, usedDate: KMDate(rawValue: "2026-10-14"),
              merchant: id, amountYen: 100, sourceFingerprint: id, duplicateOrdinal: 0)
    }
    private func result(_ id: String, _ status: KMReconciliationStatementResult.Status) -> KMReconciliationStatementResult {
        .init(statementTransactionId: id, status: status, reasonCodes: [])
    }
    private func run(_ results: [KMReconciliationStatementResult], candidates: [KMReconciliationCandidate] = []) -> KMReconciliationRun {
        .init(runId: "run", createdAt: .distantPast, completedAt: .distantPast, ruleVersion: "test",
              candidates: candidates, statementResults: results, receiptResults: [])
    }
    private func decision(_ id: String, status: KMReconciliationResolution.Status) -> KMReconciliationResolution {
        .init(id: id, runId: "run", statementId: id, resolution: .sameExpense, source: .user,
              statementAmountYen: 123, status: status, createdAt: .distantPast, updatedAt: .distantPast)
    }
}

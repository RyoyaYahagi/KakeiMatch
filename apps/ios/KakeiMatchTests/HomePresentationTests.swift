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
}

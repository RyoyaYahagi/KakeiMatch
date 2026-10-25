import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct RepositoryTests {
    @Test func loadsSharedFixtureAndIsolatesStores() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let home = try await repositories.transactions.home(month: KMYearMonth("2026-10"))
        #expect(home.summary.expenseYen == 24730) // PWA migration-screenshots.mjs asserts this exact value.
        #expect(home.summary.incomeYen == 248000)
        #expect(home.summary.balanceYen == 223270)
        #expect(home.budget.budgetYen == 80000)
        #expect(home.budget.remainingYen == 55270)
        #expect(home.recentRecords.map(\.payeeName) == ["携帯料金", "青果てらだ", "スーパーみどり"])
        #expect(KMDate(instant: repositories.referenceDate).rawValue == "2026-10-14")
        #expect(try await repositories.transactions.transactions(matching: .init()).count == 11)
        let category = try #require(try await repositories.categories.categories(includeHidden: false).first { $0.name == "食費" })
        #expect(category.usageCount == 3)
        #expect(try await repositories.transactions.transactions(matching: .init(keyword: "スーパーみどり", limit: nil)).count == 2)
        let warning = try KMFixtureLoader.load(named: "budget-warning")
        #expect(try await warning.budgets.budgetSummary(month: KMYearMonth("2026-10")).remainingYen == -4730)
        let empty = try KMFixtureLoader.load(named: "empty")
        #expect(try await empty.transactions.transactions(matching: .init()).isEmpty)
        #expect(try await repositories.transactions.transactions(matching: .init()).count == 11)
    }

    @Test func fixtureScenariosAndInvalidNames() async throws {
        for scenario in KMFixtureLoader.Scenario.allCases {
            let repositories = try KMFixtureLoader.load(named: scenario.rawValue)
            #expect(repositories.fixtureName == scenario.rawValue)
        }
        let receipt = try KMFixtureLoader.load(named: "receipt")
        let receipts = try await receipt.receipts.receipts()
        #expect(receipts.first?.registration.status == .pending)
        #expect(receipts.first?.extraction?.items.count == 7)
        let payroll = try KMFixtureLoader.load(named: "payroll")
        #expect(try await payroll.payroll.payrollRecords().first?.confirmed.netPayYen == 260000)
        #expect(throws: (any Error).self) { try KMFixtureLoader.load(named: "does-not-exist") }
        #expect(throws: (any Error).self) { try KMFixtureLoader.launch(arguments: ["app", "-UITestFixture"]) }
        let launch = try KMFixtureLoader.launch(arguments: ["app", "-UITestFixture", "migration"])
        #expect(try await launch.transactions.transactions(matching: .init()).count == 11)
    }

    @Test func readsFrozenPWAReconciliationWithoutRunningMatching() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let run = try #require(try await repositories.reconciliation.latestRun())
        #expect(run.statementResults.filter { $0.status == .matched }.count == 4)
        #expect(run.statementResults.filter { $0.status == .needsReview }.count == 1)
        #expect(run.statementResults.filter { $0.status == .unmatchedStatement }.count == 2)
        #expect(try await repositories.reconciliation.resolutions().filter { $0.status == .applied }.count == 4)
        #expect(try await repositories.transactions.transactions(matching: .init()).filter(\.cleared).count == 4)
        #expect(try await repositories.statements.statementImports().count == 1)
        let statement = try #require(try await repositories.statements.statementTransactions().first)
        try await repositories.reconciliation.setSuspected(statementId: statement.id, markedAt: repositories.referenceDate)
        #expect(try await repositories.reconciliation.suspectedStatements().count == 1)
        try await repositories.reconciliation.setSuspected(statementId: statement.id, markedAt: nil)
        #expect(try await repositories.reconciliation.suspectedStatements().isEmpty)
    }

    @Test func manualWritesShareBalancesExclusionAndRecords() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let account = try #require(try await repositories.accounts.accounts(includeClosed: false).first)
        let category = try #require(try await repositories.categories.categories(includeHidden: false).first { !$0.isIncome })
        let date = try KMDate("2026-10-14")
        let input = KMManualTransactionInput(kind: .expense, amountYen: 1000, date: date, payeeName: "合成テスト店",
            categoryId: category.id, accountId: account.id, memo: "試験", importedId: "fixture-test-manual")
        let saved = try await repositories.transactions.saveManual(input, id: nil)
        #expect(saved.amountYen == -1000)
        #expect(try await repositories.transactions.saveManual(input, id: nil).id == saved.id) // stable import ID retry.
        #expect(try await repositories.accounts.accounts(includeClosed: false).first?.balanceYen == account.balanceYen - 1000)
        try await repositories.transactions.setSpendingExclusion(id: saved.id, excluded: true)
        let home = try await repositories.transactions.home(month: KMYearMonth("2026-10"))
        #expect(home.summary.expenseYen == 24730)
        #expect(home.recentRecords.first?.id == saved.id)
        #expect(try await repositories.transactions.recordDays(matching: .init()).first?.balanceYen == 0)
        try await repositories.transactions.deleteTransaction(id: saved.id)
        #expect(try await repositories.transactions.transaction(id: saved.id) == nil)
        var renamed = account; renamed.name = "合成カード改名"
        try await repositories.accounts.saveAccount(renamed)
        #expect(try await repositories.accounts.accounts(includeClosed: false).first { $0.id == account.id }?.balanceYen == account.balanceYen)
    }

    @Test func transferHasTwoBalanceSidesAndOneVisibleRow() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let accounts = try await repositories.accounts.accounts(includeClosed: false)
        let input = KMTransferInput(amountYen: 10000, date: try KMDate("2026-10-14"), sourceAccountId: accounts[1].id,
            destinationAccountId: accounts[2].id, memo: "合成の引き出し", importedId: "fixture-transfer")
        let row = try await repositories.transactions.saveTransfer(input, id: nil)
        #expect(try await repositories.transactions.transactions(matching: .init(kind: .transfer)).count == 1)
        let balances = try await repositories.accounts.accounts(includeClosed: false)
        #expect(balances[1].balanceYen == accounts[1].balanceYen - 10000)
        #expect(balances[2].balanceYen == accounts[2].balanceYen + 10000)
        #expect(try await repositories.transactions.home(month: KMYearMonth("2026-10")).summary.expenseYen == 24730)
        #expect(try await repositories.transactions.recordDays(matching: .init(kind: .transfer)).first?.balanceYen == 0)
        try await repositories.transactions.deleteTransaction(id: row.id)
        #expect(try await repositories.accounts.accounts(includeClosed: false)[1].balanceYen == accounts[1].balanceYen)
    }

    @Test func usageCountsSplitCategoryOnceAndIgnoresTransfers() async throws {
        let date = try KMDate("2026-10-01")
        let store = KMInMemoryStore(transactions: [
            KMTransaction(id: "parent", date: date, amountYen: -300, kind: .expense, accountId: "cash", isSplit: true,
                splits: [.init(id: "a", categoryId: "food", amountYen: -100), .init(id: "b", categoryId: "food", amountYen: -200)]),
            KMTransaction(id: "transfer", date: date, amountYen: -1000, kind: .transfer, accountId: "cash", categoryId: "food")
        ], categories: [KMCategory(id: "daily", name: "日用品"), KMCategory(id: "food", name: "食費"), KMCategory(id: "out", name: "外食")])
        let values = try await store.categories()
        #expect(values.map(\.id) == ["food", "out", "daily"])
        #expect(values.first?.usageCount == 1)
        let repositories = KMRepositories(inMemory: store)
        var settings = try await repositories.settings.settings(); settings.theme = .dark
        try await repositories.settings.saveSettings(settings)
        #expect(try await repositories.settings.settings().theme == .dark)
    }
}

import Foundation
import Testing
@testable import KakeiMatch

struct TransactionAggregationTests {
    private let month = KMYearMonth(rawValue: "2026-09")
    private let categories = [KMCategory(id: "food", name: "食費"), KMCategory(id: "home", name: "住居費"),
                              KMCategory(id: "income-category", name: "給与", isIncome: true)]
    private func row(_ id: String, _ amount: Int, category: String? = nil) -> KMMonthlyLedgerRow {
        KMMonthlyLedgerRow(id: id, date: KMDate(rawValue: "2026-09-15"), amountYen: amount, categoryId: category)
    }
    private func baseRows() -> [KMMonthlyLedgerRow] {
        var parent = row("parent", -1000); parent.isParent = true
        var a = row("split-a", -600, category: "food"); a.parentId = "parent"; a.isChild = true
        var b = row("split-b", -400, category: "home"); b.parentId = "parent"; b.isChild = true
        var outgoing = row("transfer-out", -700); outgoing.transferId = "transfer-in"
        var incoming = row("transfer-in", 700); incoming.transferId = "transfer-out"
        return [row("expense", -3284, category: "food"), row("income", 5000), parent, a, b, outgoing, incoming]
    }

    // Same inputs/expected values: src/lib/actual-browser-ledger.test.ts "aggregates by amount sign...".
    @Test func pwaMonthlySignAndNativeFilters() throws {
        var offbudget = row("offbudget-spend", -500, category: "food"); offbudget.offbudget = true
        var tombstone = row("tombstone-spend", -900, category: "food"); tombstone.tombstone = true
        var opening = row("opening-balance", 100000); opening.startingBalance = true
        var failed = row("failed-import", -800, category: "food"); failed.hasError = true
        let rows = baseRows() + [row("refund", 250, category: "food"), row("negative-income", -100, category: "income-category"),
                                row("uncategorized", -200), offbudget, tombstone, opening, failed]
        let result = try KMTransactionAggregation.monthly(rows: rows, categories: categories, month: month)
        #expect(result.incomeYen == 5250)
        #expect(result.expenseYen == 4584)
        #expect(result.balanceYen == 666)
        #expect(result.categories == [
            KMMonthlyCategory(categoryId: "food", categoryName: "食費", amountYen: 3884),
            KMMonthlyCategory(categoryId: "home", categoryName: "住居費", amountYen: 400),
            KMMonthlyCategory(categoryId: nil, categoryName: "未分類", amountYen: 200),
            KMMonthlyCategory(categoryId: "income-category", categoryName: "給与", amountYen: 100)
        ])
    }

    // Same values: actual-browser-ledger.test.ts "keeps ledger amounts while removing parent and split expense...".
    @Test func spendingExclusionKeepsIncomeAndChildrenOutOfTotals() throws {
        var rows = baseRows()
        rows[0].excludedFromSpending = true; rows[2].excludedFromSpending = true
        let result = try KMTransactionAggregation.monthly(rows: rows, categories: categories, month: month)
        #expect(result.expenseYen == 0)
        #expect(result.incomeYen == 5000)
        #expect(result.categories.isEmpty)
        rows[1].excludedFromSpending = true // PWA monthly filter excludes only negative rows.
        #expect(try KMTransactionAggregation.monthly(rows: rows, categories: categories, month: month).incomeYen == 5000)
    }

    // Exact split inputs: actual-browser-ledger.test.ts "nets positive refund splits against spending...".
    @Test func pwaSplitRefundsNetByCategory() throws {
        var parent = row("net-split", -300); parent.isParent = true
        let values: [(String, Int)] = [("food", -700), ("food", 700), ("home", -700), ("home", 200), ("transport", -100), ("transport", 300)]
        let splits = values.enumerated().map { index, value in
            var child = row("child-\(index)", value.1, category: value.0); child.parentId = "net-split"; child.isChild = true; return child
        }
        let result = try KMTransactionAggregation.monthly(rows: [parent] + splits, categories: categories, month: month)
        #expect(result.expenseYen == 300)
        #expect(result.incomeYen == 0)
        #expect(result.categories == [KMMonthlyCategory(categoryId: "home", categoryName: "住居費", amountYen: 500),
                                      KMMonthlyCategory(categoryId: "transport", categoryName: "カテゴリ名不明", amountYen: -200)])
        let settings = try KMMonthlyBudgetSettings.empty(budgetId: "fixture").applyingDefaultPlan(totalYen: 1000, breakdownEnabled: false, allocations: [:])
        let budget = try KMBudgetAggregation.summarize(categories: result.categories.map {
            .init(categoryId: $0.categoryId!, categoryName: $0.categoryName, nativeBudgetYen: 0, spentYen: $0.amountYen)
        }, settings: settings, yearMonth: month)
        #expect(budget.spentYen == 300) // Negative category amounts must not be rejected or clamped.
    }

    @Test func rejectsUnsafeArithmeticAndMalformedSplits() throws {
        #expect(throws: KMDataError.amountOverflow) {
            try KMTransactionAggregation.monthly(rows: baseRows() + [row("overflow", -KMYen.maxSafe)], categories: categories, month: month)
        }
        var parent = row("large", -KMYen.maxSafe); parent.isParent = true
        let values = [("food", -KMYen.maxSafe), ("transport", KMYen.maxSafe), ("home", -KMYen.maxSafe)]
        let children = values.enumerated().map { index, value in
            var child = row("c\(index)", value.1, category: value.0); child.parentId = "large"; child.isChild = true; return child
        }
        #expect(throws: KMDataError.amountOverflow) {
            try KMTransactionAggregation.monthly(rows: [parent] + children, categories: categories, month: month)
        }
        #expect(throws: (any Error).self) { try KMTransactionAggregation.monthly(rows: [parent], categories: categories, month: month) }
        var mismatch = baseRows(); mismatch[3].amountYen = -500
        #expect(throws: (any Error).self) { try KMTransactionAggregation.monthly(rows: mismatch, categories: categories, month: month) }
        #expect(try KMTransactionAggregation.monthly(rows: baseRows(), categories: categories, month: KMYearMonth("2026-10")).expenseYen == 0)
    }

    // records-list.ts dayTotal: keep excluded/transfer rows visible, but omit both from the heading total.
    @Test func recordDaysApplyKindFilterBeforeSum() throws {
        let date = KMDate(rawValue: "2026-10-01")
        var expense = KMTransaction(id: "expense", date: date, amountYen: -3284, kind: .expense, accountId: "cash")
        var excluded = expense; excluded.id = "excluded"; excluded.amountYen = -100; excluded.excludedFromSpending = true
        let income = KMTransaction(id: "income", date: date, amountYen: 5000, kind: .income, accountId: "cash")
        let transfer = KMTransaction(id: "transfer", date: date, amountYen: -10000, kind: .transfer, accountId: "cash")
        let rows = [expense, excluded, income, transfer]
        #expect(try KMTransactionAggregation.recordDays(rows).first?.balanceYen == 1716)
        #expect(try KMTransactionAggregation.recordDays(rows).first?.records.count == 4)
        #expect(try KMTransactionAggregation.recordDays(rows, kind: .expense).first?.balanceYen == -3284)
        expense.amountYen = 0
        #expect(try KMTransactionAggregation.recordDays([expense]).first?.balanceYen == 0)
    }

    // Exact calendar cases from src/lib/local-monthly-dashboard.test.ts.
    @Test func pwaGregorianCalendarAndTokyoInstants() throws {
        #expect(try KMYearMonth("2026-01").shifted(by: -1).rawValue == "2025-12")
        #expect(try KMYearMonth("2026-12").shifted(by: 1).rawValue == "2027-01")
        #expect(try KMYearMonth("2024-02").lastDay.rawValue == "2024-02-29")
        #expect(try KMYearMonth("2100-02").lastDay.rawValue == "2100-02-28")
        #expect(try KMYearMonth("2000-02").lastDay.rawValue == "2000-02-29")
        #expect(try KMYearMonth("0001-01").shifted(by: -1).rawValue == "0001-01")
        #expect(try KMYearMonth("9999-12").shifted(by: 1).rawValue == "9999-12")
        #expect(throws: (any Error).self) { try KMDate("2026-02-29") }
        #expect(throws: (any Error).self) { try KMYearMonth("0000-01") }
        #expect(throws: (any Error).self) { try KMYearMonth("2026-01\n") }
        let instant = try KMJSON.decoder().decode(Date.self, from: Data("\"2026-09-30T15:00:00Z\"".utf8))
        #expect(KMDate(instant: instant).rawValue == "2026-10-01")
    }
}

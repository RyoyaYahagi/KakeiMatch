import Foundation

// TS: src/lib/actual-ledger.ts ActualMonthlyCategory.
struct KMMonthlyCategory: Codable, Equatable, Sendable {
    var categoryId: String?
    var categoryName: String
    var amountYen: Int
}

// TS: src/lib/actual-ledger.ts ActualMonthlySummary.
struct KMMonthlySummary: Codable, Equatable, Sendable {
    var yearMonth: KMYearMonth
    var incomeYen: Int
    var expenseYen: Int
    var balanceYen: Int
    var categories: [KMMonthlyCategory]
}

// TS: apps/pwa/src/records-list.ts renderRecordGroups / dayTotal.
struct KMRecordDay: Equatable, Identifiable, Sendable {
    var id: KMDate { date }
    var date: KMDate
    var records: [KMTransaction]
    /// Zero is rendered without a total by the PWA. Transfers / excluded rows remain visible.
    var balanceYen: Int
}

// TS: apps/pwa/src/local-ui.ts refreshRecords (month summary, budgets and the latest three rows).
struct KMHomeSnapshot: Equatable, Sendable {
    var summary: KMMonthlySummary
    var budget: KMMonthlyBudgetSummary
    var recentRecords: [KMTransaction]
}

// TS: src/lib/actual-browser-ledger.ts summarizeMonth NativeTransaction subset (already expanded split rows).
/// Adapter input, not a .kmb record. Flags mirror native Actual filtering before the UI projection.
struct KMMonthlyLedgerRow: Equatable, Sendable {
    var id: String
    var date: KMDate
    var amountYen: Int
    var categoryId: String? = nil
    var parentId: String? = nil
    var isChild: Bool = false
    var isParent: Bool = false
    var transferId: String? = nil
    var offbudget: Bool = false
    var tombstone: Bool = false
    var startingBalance: Bool = false
    var hasError: Bool = false
    var excludedFromSpending: Bool = false
}

enum KMTransactionAggregation {
    /// Port of summarizeMonth + monthlySummary's off-budget / spending-exclusion filter.
    static func monthly(rows: [KMMonthlyLedgerRow], categories: [KMCategory], month: KMYearMonth) throws -> KMMonthlySummary {
        let names = Dictionary(uniqueKeysWithValues: categories.map { ($0.id, $0.name) })
        let eligible = rows.filter { !$0.offbudget && !($0.excludedFromSpending && $0.amountYen < 0) }
        let children = Dictionary(grouping: eligible.filter { $0.parentId != nil && $0.isChild }, by: { $0.parentId! })
        var income = 0, expense = 0
        // Optional keys retain the uncategorized bucket, rather than silently dropping it.
        var amounts: [String?: Int] = [:]
        func addCategory(_ id: String?, _ amount: Int) throws {
            if amount != 0 { amounts[id] = try KMYen.add(amounts[id] ?? 0, amount) }
        }
        for row in eligible {
            if row.tombstone || row.startingBalance || row.hasError { continue }
            if row.isChild || row.parentId != nil || row.transferId != nil || row.date.yearMonth != month { continue }
            _ = try KMYen.checked(row.amountYen)
            if row.amountYen > 0 { income = try KMYen.add(income, row.amountYen) }
            else if row.amountYen < 0 { expense = try KMYen.add(expense, -row.amountYen) }
            guard row.amountYen < 0 else { continue }
            let splits = children[row.id] ?? []
            if !row.isParent && splits.isEmpty { try addCategory(row.categoryId, -row.amountYen); continue }
            guard !splits.isEmpty else { throw KMDataError.invalidData("分割取引の品目がありません。") }
            var total = 0
            for child in splits {
                guard !child.tombstone, !child.hasError else { throw KMDataError.invalidData("分割取引の品目が不正です。") }
                _ = try KMYen.checked(child.amountYen)
                total = try KMYen.add(total, child.amountYen)
                try addCategory(child.categoryId, -child.amountYen)
            }
            guard total == row.amountYen else { throw KMDataError.invalidData("分割取引の合計が一致しません。") }
        }
        let result = amounts.filter { $0.value != 0 }.map { id, amount in
            KMMonthlyCategory(categoryId: id, categoryName: id.map { names[$0] ?? "カテゴリ名不明" } ?? "未分類", amountYen: amount)
        }.sorted {
            if $0.amountYen != $1.amountYen { return $0.amountYen > $1.amountYen }
            let order = $0.categoryName.compare($1.categoryName, locale: Locale(identifier: "ja_JP"))
            return order == .orderedSame ? ($0.categoryId ?? "") < ($1.categoryId ?? "") : order == .orderedAscending
        }
        _ = try result.filter { $0.amountYen > 0 }.reduce(0) { try KMYen.add($0, $1.amountYen) }
        return KMMonthlySummary(yearMonth: month, incomeYen: income, expenseYen: expense,
                                balanceYen: try KMYen.add(income, -expense), categories: result)
    }

    static func monthly(transactions: [KMTransaction], accounts: [KMAccount], categories: [KMCategory], month: KMYearMonth) throws -> KMMonthlySummary {
        let offbudget = Set(accounts.filter { $0.offbudget == true }.map(\.id))
        let rows = transactions.flatMap { transaction -> [KMMonthlyLedgerRow] in
            let parent = KMMonthlyLedgerRow(id: transaction.id, date: transaction.date, amountYen: transaction.amountYen,
                categoryId: transaction.categoryId, isParent: transaction.isSplit == true, transferId: transaction.kind == .transfer ? (transaction.transferId ?? "transfer") : nil,
                offbudget: offbudget.contains(transaction.accountId), excludedFromSpending: transaction.excludedFromSpending == true)
            return [parent] + (transaction.splits ?? []).map {
                KMMonthlyLedgerRow(id: $0.id, date: transaction.date, amountYen: $0.amountYen, categoryId: $0.categoryId,
                    parentId: transaction.id, isChild: true, offbudget: parent.offbudget)
            }
        }
        return try monthly(rows: rows, categories: categories, month: month)
    }

    /// Input order is preserved, like the PWA Map; repositories supply date-descending rows first.
    static func recordDays(_ rows: [KMTransaction], kind: KMTransactionKind? = nil) throws -> [KMRecordDay] {
        var result: [KMRecordDay] = []
        for row in rows where kind == nil || row.kind == kind {
            let index: Int
            if let existing = result.firstIndex(where: { $0.date == row.date }) { index = existing }
            else { result.append(KMRecordDay(date: row.date, records: [], balanceYen: 0)); index = result.count - 1 }
            result[index].records.append(row)
            if row.kind != .transfer && row.excludedFromSpending != true {
                result[index].balanceYen = try KMYen.add(result[index].balanceYen, row.amountYen)
            }
        }
        return result
    }
}

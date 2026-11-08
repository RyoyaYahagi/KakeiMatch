import Foundation

/// Assembles the Muse snapshot from Repository reads only. Screens and the export/share action
/// live elsewhere; this type never writes to the household.
@MainActor
struct KMMuseSnapshotBuilder {
    private let transactions: any TransactionRepository
    private let accounts: any AccountRepository
    private let categories: any CategoryRepository

    init(transactions: any TransactionRepository, accounts: any AccountRepository, categories: any CategoryRepository) {
        self.transactions = transactions
        self.accounts = accounts
        self.categories = categories
    }

    /// `generatedAt` is an instant; it is formatted in Asia/Tokyo for the snapshot.
    func build(fromMonth: KMYearMonth, toMonth: KMYearMonth, generatedAt: Date, appVersion: String?) async throws -> KMMuseSnapshot {
        let months = try Self.months(from: fromMonth, to: toMonth)
        let accountValues = try await accounts.accounts(includeClosed: true)
        let categoryValues = try await categories.categories(includeHidden: true)
        let categoryNames = Dictionary(uniqueKeysWithValues: categoryValues.map { ($0.id, $0.name) })

        let start = fromMonth.firstDay
        let end = toMonth.lastDay
        let rows = try await transactionRows(from: start, to: end)

        var monthly: [KMMuseSnapshotMonthly] = []
        monthly.reserveCapacity(months.count)
        for month in months {
            // The home screen value is the source of truth; do not recompute totals here.
            let summary = try await transactions.home(month: month).summary
            monthly.append(KMMuseSnapshotMonthly(
                month: summary.yearMonth.rawValue,
                incomeYen: summary.incomeYen,
                expenseYen: summary.expenseYen,
                balanceYen: summary.balanceYen,
                byCategory: summary.categories.map {
                    KMMuseSnapshotCategory(categoryId: $0.categoryId, categoryName: $0.categoryName, amountYen: $0.amountYen)
                }))
        }

        return KMMuseSnapshot(
            generatedAt: KMMuseSnapshotFormat.timestamp(generatedAt),
            appVersion: appVersion,
            range: KMMuseSnapshotRange(fromMonth: fromMonth.rawValue, toMonth: toMonth.rawValue),
            accounts: accountValues.map {
                KMMuseSnapshotAccount(id: $0.id, name: $0.name, type: $0.accountType.rawValue,
                    closed: $0.closed, offBudget: $0.offbudget == true, balanceYen: $0.balanceYen)
            },
            transactions: rows.map { row in
                KMMuseSnapshotTransaction(
                    id: row.id,
                    date: row.date.rawValue,
                    amountYen: row.amountYen,
                    kind: row.kind.rawValue,
                    accountId: row.accountId,
                    categoryId: row.categoryId,
                    categoryName: categoryName(row.categoryId, explicit: row.categoryName, names: categoryNames),
                    payeeName: row.payeeName,
                    memo: row.memo,
                    transferAccountId: row.transferAccountId,
                    excludedFromSpending: row.excludedFromSpending == true,
                    splits: (row.splits ?? []).map { split in
                        KMMuseSnapshotSplit(
                            id: split.id,
                            categoryId: split.categoryId,
                            categoryName: categoryName(split.categoryId, explicit: nil, names: categoryNames),
                            amountYen: split.amountYen,
                            payeeName: split.payeeName,
                            memo: split.memo)
                    })
            },
            monthly: monthly)
    }

    static func months(from fromMonth: KMYearMonth, to toMonth: KMYearMonth) throws -> [KMYearMonth] {
        let start = fromMonth.year * 12 + fromMonth.month - 1
        let end = toMonth.year * 12 + toMonth.month - 1
        guard start <= end else { throw KMDataError.invalidData("開始月は終了月以前にしてください。") }
        let count = end - start + 1
        guard count <= 60 else { throw KMDataError.invalidData("期間は1〜60か月で指定してください。") }
        return (0..<count).map { fromMonth.shifted(by: $0) }
    }

    /// Both sides of a transfer are rows in the snapshot, each kept or dropped by its own date, so a
    /// pair that straddles the range boundary contributes only the side inside it.
    private func transactionRows(from start: KMDate, to end: KMDate) async throws -> [KMTransaction] {
        let query = KMTransactionQuery(startDate: start, endDate: end, limit: nil, includeIncomingTransfers: true)
        return try await transactions.transactions(matching: query)
    }

    private func categoryName(_ id: String?, explicit: String?, names: [String: String]) -> String? {
        if let explicit { return explicit }
        guard let id else { return nil }
        return names[id]
    }
}

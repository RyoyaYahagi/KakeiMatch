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

    /// Repository search hides the incoming side of transfers because the records list shows one
    /// row per transfer. The snapshot documents both sides, so fetch the linked peer by ID.
    private func transactionRows(from start: KMDate, to end: KMDate) async throws -> [KMTransaction] {
        let query = KMTransactionQuery(startDate: start, endDate: end, limit: nil)
        let listed = try await transactions.transactions(matching: query)
        var seen = Set<String>()
        var rows: [KMTransaction] = []
        for row in listed where seen.insert(row.id).inserted {
            rows.append(row)
            guard row.kind == .transfer, let peerId = row.transferId, !seen.contains(peerId),
                  let peer = try await transactions.transaction(id: peerId),
                  peer.kind == .transfer, peer.date >= start, peer.date <= end else { continue }
            seen.insert(peer.id)
            rows.append(peer)
        }
        return rows
    }

    private func categoryName(_ id: String?, explicit: String?, names: [String: String]) -> String? {
        if let explicit { return explicit }
        guard let id else { return nil }
        return names[id]
    }
}

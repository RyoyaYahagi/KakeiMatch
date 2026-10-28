import Foundation

/// Presentation only. Filtering, grouping, matching and ledger writes stay in repositories.
enum KMRecordsFilter: String, CaseIterable {
    case all, expense, income, transfer
    var label: String {
        switch self { case .all: "すべて"; case .expense: "支出"; case .income: "収入"; case .transfer: "振替" }
    }
    var kind: KMTransactionKind? { KMTransactionKind(rawValue: rawValue) }
}

struct KMRecordsSearchDraft: Equatable {
    var keyword = ""
    var startDate = ""
    var endDate = ""
    var kind = ""
    var categoryId = ""
    var accountId = ""
    var minimum = ""
    var maximum = ""

    func query() throws -> KMTransactionQuery {
        func amount(_ value: String) throws -> Int? {
            let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if value.isEmpty { return nil }
            guard value.allSatisfy({ $0.isASCII && $0.isNumber }), let amount = Int(value), amount <= KMYen.maxSafe else {
                throw KMDataError.invalidData("金額は0以上の整数で入力してください。")
            }
            return amount
        }
        let start = startDate.isEmpty ? nil : try KMDate(startDate)
        let end = endDate.isEmpty ? nil : try KMDate(endDate)
        let min = try amount(minimum), max = try amount(maximum)
        guard start == nil || end == nil || start! <= end! else { throw KMDataError.invalidData("開始日は終了日以前にしてください。") }
        guard min == nil || max == nil || min! <= max! else { throw KMDataError.invalidData("最低金額は最高金額以下にしてください。") }
        guard keyword.count <= 200 else { throw KMDataError.invalidData("キーワードは200文字以内で入力してください。") }
        return KMTransactionQuery(kind: KMTransactionKind(rawValue: kind), startDate: start, endDate: end,
            accountId: accountId.isEmpty ? nil : accountId, categoryId: categoryId.isEmpty ? nil : categoryId,
            keyword: keyword, minAmountYen: min, maxAmountYen: max, limit: nil)
    }
}

enum KMRecordsPresentation {
    static func dayLabel(_ date: KMDate) -> String {
        let parts = date.rawValue.split(separator: "-").compactMap { Int($0) }
        let instant = KMDate.calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))!
        let weekday = ["日", "月", "火", "水", "木", "金", "土"][KMDate.calendar.component(.weekday, from: instant) - 1]
        return "\(parts[1])月\(parts[2])日（\(weekday)）"
    }

    static func summary(_ row: KMTransaction, accounts: [KMAccount], receipt: KMReceipt?,
                        filter: KMRecordsFilter = .all, search: Bool = false, needsReview: Bool = false) -> KMRecordSummary {
        var account = accounts.first { $0.id == row.accountId }?.name
        if search, row.kind == .transfer, let destination = row.transferAccountId {
            account = "振替先 " + (accounts.first { $0.id == destination }?.name ?? "利用不可")
        }
        return KMRecordSummary(kind: KMRecordKind(rawValue: row.kind.rawValue)!, amountYen: row.amountYen,
            date: row.date.rawValue, payeeName: row.payeeName, categoryName: row.categoryName, categoryID: row.categoryId,
            accountName: account, memo: row.memo, excludedFromSpending: row.excludedFromSpending == true,
            // PWA search does not show receipt / review annotations.
            hasReceipt: !search && receipt?.image != nil, needsReview: !search && needsReview,
            showDate: search, expenseMemoTitle: !search && filter == .expense)
    }

    static func pendingTitle(_ receipt: KMReceipt) -> String {
        [receipt.confirmedValue?.merchant, receipt.extraction?.merchant].compactMap { $0 }.first { !$0.isEmpty }
            ?? (receipt.image == nil ? "未入力の支出" : "未入力のレシート")
    }

    /// The PWA's record annotation, not a new reconciliation decision.
    static func reviewIDs(run: KMReconciliationRun?, resolutions: [KMReconciliationResolution],
                          suspected: [KMSuspectedStatement], receipts: [KMReceipt]) -> Set<String> {
        guard let run else { return [] }
        let decided = Set(resolutions.map(\.statementId) + suspected.map(\.statementId))
        let pending = Set(run.statementResults.filter { $0.status == .needsReview && !decided.contains($0.statementTransactionId) }.map(\.statementTransactionId))
        return Set(run.candidates.filter { pending.contains($0.statementTransactionId) }.compactMap { candidate in
            if let receipt = receipts.first(where: { $0.id == candidate.receiptId }) { return receipt.registration.actualTransactionId }
            return candidate.receiptId.hasPrefix("actual:") ? String(candidate.receiptId.dropFirst(7)) : nil
        })
    }

    static func total(_ rows: [KMTransaction]) throws -> Int {
        try rows.filter { $0.kind != .transfer && $0.excludedFromSpending != true }.reduce(0) { try KMYen.add($0, $1.amountYen) }
    }
}

struct KMRecordEditDraft: Equatable {
    var amount: String
    var date: String
    var payee: String
    var categoryId: String
    var accountId: String
    var destinationId: String
    var memo: String

    init(_ row: KMTransaction, receipt: KMReceipt?) {
        let value = receipt?.confirmedValue
        amount = String(value?.totalAmountYen ?? abs(row.amountYen))
        date = (value?.purchasedDate ?? row.date).rawValue
        payee = value?.merchant ?? row.payeeName ?? ""
        categoryId = value?.categoryId ?? row.categoryId ?? ""
        accountId = value?.accountId ?? row.accountId
        destinationId = row.transferAccountId ?? ""
        memo = value?.memo ?? row.memo ?? ""
    }

    func amountYen(allowsZero: Bool = false) throws -> Int {
        guard !amount.isEmpty, amount.allSatisfy({ $0.isASCII && $0.isNumber }), let value = Int(amount),
              value <= KMYen.maxSafe, value >= (allowsZero ? 0 : 1) else {
            throw KMDataError.invalidData(allowsZero ? "金額は0円以上の整数で入力してください。" : "金額は1円以上の整数で入力してください。")
        }
        return value
    }
}

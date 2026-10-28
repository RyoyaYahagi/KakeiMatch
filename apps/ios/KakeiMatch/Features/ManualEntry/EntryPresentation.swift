import Foundation

/// Deterministic presentation and validation rules ported from entry-form.ts,
/// entry-recurrence.ts, category-picker.ts, and local-transaction-ui.ts.
enum KMEntryKind: String, Equatable, Sendable {
    case expense, income, transfer

    var transactionKind: KMTransactionKind {
        switch self {
        case .expense: .expense
        case .income: .income
        case .transfer: .transfer
        }
    }

    var title: String {
        switch self {
        case .expense: "支出を入力"
        case .income: "収入を入力"
        case .transfer: "口座間振替"
        }
    }

    var payeeLabel: String {
        switch self {
        case .expense: "店名"
        case .income: "内容"
        case .transfer: ""
        }
    }

    var categoryIsIncome: Bool { self == .income }
}

enum KMEntryFrequency: String, CaseIterable, Equatable, Sendable {
    case none = ""
    case monthly, weekly, yearly

    var label: String {
        switch self {
        case .none: "しない"
        case .monthly: "毎月"
        case .weekly: "毎週"
        case .yearly: "毎年"
        }
    }

    var scheduleFrequency: KMRecurringTransaction.Frequency? {
        switch self {
        case .none: nil
        case .monthly: .monthly
        case .weekly: .weekly
        case .yearly: .yearly
        }
    }
}

struct KMEntryDraft: Sendable {
    var kind: KMEntryKind
    var amount: String
    var payee: String
    var date: String
    var categoryId: String
    var accountId: String
    var destinationAccountId: String
    var memo: String
    var time: String?
    var excludedFromSpending: Bool
}

struct KMValidatedEntry: Sendable {
    var kind: KMEntryKind
    var amountYen: Int
    var payee: String
    var date: KMDate
    var categoryId: String?
    var accountId: String
    var destinationAccountId: String?
    var memo: String?
    var time: String?
    var excludedFromSpending: Bool
}

enum KMEntryPresentation {
    static func parseAmountYen(_ input: String, allowsZero: Bool = false) throws -> Int {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.unicodeScalars.allSatisfy({ (48...57).contains($0.value) }),
              let amount = Int(value), amount <= KMYen.maxSafe,
              amount >= (allowsZero ? 0 : 1) else {
            throw KMDataError.invalidData(allowsZero ? "金額は0円以上の整数で入力してください。" : "金額は1円以上の整数で入力してください。")
        }
        return amount
    }

    static func validate(_ draft: KMEntryDraft, categories: [KMCategory], accounts: [KMAccount]) throws -> KMValidatedEntry {
        let amount = try parseAmountYen(draft.amount)
        let date = try KMDate(draft.date)
        let memoText = draft.memo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard memoText.utf16.count <= 2_000 else { throw KMDataError.invalidData("メモは2000文字以内で入力してください。") }
        let memo = memoText.isEmpty ? nil : memoText

        guard accounts.contains(where: { $0.id == draft.accountId && !$0.closed }) else {
            throw KMDataError.invalidData(draft.kind == .transfer ? "振替元口座を選んでください。" : draft.kind == .income ? "入金先口座を選んでください。" : "支払元を選んでください。")
        }

        if draft.kind == .transfer {
            guard let destination = accounts.first(where: { $0.id == draft.destinationAccountId && !$0.closed }) else {
                throw KMDataError.invalidData("振替先口座を選んでください。")
            }
            guard destination.id != draft.accountId else { throw KMDataError.invalidData("異なる口座を選んでください。") }
            return KMValidatedEntry(kind: .transfer, amountYen: amount, payee: "", date: date,
                categoryId: nil, accountId: draft.accountId, destinationAccountId: destination.id,
                memo: memo, time: nil, excludedFromSpending: false)
        }

        let payee = draft.payee.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !payee.isEmpty else {
            throw KMDataError.invalidData(draft.kind == .income ? "入金元・内容を入力してください。" : "店名・支払先を入力してください。")
        }
        guard payee.utf16.count <= 200 else { throw KMDataError.invalidData("店名・内容は200文字以内で入力してください。") }
        guard categories.contains(where: { $0.id == draft.categoryId && !$0.hidden && $0.isIncome == draft.kind.categoryIsIncome }) else {
            throw KMDataError.invalidData(draft.kind == .income ? "収入カテゴリを選んでください。" : "支出カテゴリを選んでください。")
        }
        let time: String?
        if draft.kind == .expense, let value = draft.time, !value.isEmpty {
            guard value.range(of: #"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$"#, options: .regularExpression) != nil else {
                throw KMDataError.invalidData("時刻を確認してください。")
            }
            time = value
        } else {
            time = nil
        }
        return KMValidatedEntry(kind: draft.kind, amountYen: amount, payee: payee, date: date,
            categoryId: draft.categoryId, accountId: draft.accountId, destinationAccountId: nil,
            memo: memo, time: time, excludedFromSpending: draft.kind == .expense && draft.excludedFromSpending)
    }

    /// PWA's category choices count every expense/income record over the full history,
    /// count each split category once per record, and retain baseline order for ties.
    static func sortedCategories(_ categories: [KMCategory]) -> [KMCategory] {
        categories.enumerated().sorted { left, right in
            if left.element.usageCount != right.element.usageCount {
                return left.element.usageCount > right.element.usageCount
            }
            let leftRank = KMCategoryOrdering.rank(left.element.name)
            let rightRank = KMCategoryOrdering.rank(right.element.name)
            return leftRank == rightRank ? left.offset < right.offset : leftRank < rightRank
        }.map(\.element)
    }

    /// PWA's first category comes from the latest 100 records of the same kind.
    static func lastUsedCategory(kind: KMEntryKind, recent: [KMTransaction], availableIds: Set<String>) -> String? {
        guard kind != .transfer else { return nil }
        return recent.first(where: { $0.kind == kind.transactionKind && $0.categoryId.map(availableIds.contains) == true })?.categoryId
    }

    static func orderedAccounts(_ accounts: [KMAccount], for kind: KMEntryKind) -> [KMAccount] {
        let order: [KMAccountType] = kind == .expense
            ? [.creditCard, .bank, .cash, .other]
            : [.bank, .cash, .other, .creditCard]
        return order.flatMap { type in accounts.filter { $0.accountType == type } }
    }

    static func shiftedDate(_ date: KMDate, by days: Int) -> KMDate? {
        let parts = date.rawValue.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let start = KMDate.calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])),
              let shifted = KMDate.calendar.date(byAdding: .day, value: days, to: start) else { return nil }
        return KMDate(instant: shifted)
    }

    static func nextOccurrence(after date: KMDate, frequency: KMRecurringTransaction.Frequency) -> KMDate? {
        let throughYear = min(date.yearMonth.year + 4, 9_999)
        guard let through = try? KMDate(String(format: "%04d-12-31", throughYear)) else { return nil }
        let input = KMRecurringScheduleInput(name: "entry", kind: .expense, amountYen: 1,
            categoryId: "entry", accountId: "entry", frequency: frequency, startDate: date, postsTransaction: true)
        return KMRecurringScheduleService.occurrenceDates(input: input, through: through).dropFirst().first
    }

    static func recurringInput(for entry: KMValidatedEntry, frequency: KMEntryFrequency) -> KMRecurringScheduleInput? {
        guard let scheduleFrequency = frequency.scheduleFrequency,
              entry.kind != .transfer,
              let categoryId = entry.categoryId,
              let startDate = nextOccurrence(after: entry.date, frequency: scheduleFrequency) else { return nil }
        return KMRecurringScheduleInput(name: entry.payee, kind: entry.kind == .income ? .income : .expense,
            amountYen: entry.amountYen, categoryId: categoryId, accountId: entry.accountId,
            frequency: scheduleFrequency, startDate: startDate, postsTransaction: true)
    }

    static func dateValue(_ date: KMDate) -> Date {
        let parts = date.rawValue.split(separator: "-").compactMap { Int($0) }
        return KMDate.calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) ?? Date(timeIntervalSince1970: 0)
    }

    static func timeValue(_ value: String?, on date: KMDate) -> Date {
        let parts = (value ?? "").split(separator: ":").compactMap { Int($0) }
        var components = DateComponents()
        components.year = date.yearMonth.year
        components.month = date.yearMonth.month
        components.day = Int(date.rawValue.suffix(2))
        components.hour = parts.count == 2 ? parts[0] : 12
        components.minute = parts.count == 2 ? parts[1] : 0
        return KMDate.calendar.date(from: components) ?? Date(timeIntervalSince1970: 0)
    }

    static func timeString(from value: Date) -> String {
        let hour = KMDate.calendar.component(.hour, from: value)
        let minute = KMDate.calendar.component(.minute, from: value)
        return String(format: "%02d:%02d", hour, minute)
    }
}

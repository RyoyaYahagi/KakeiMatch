import Foundation
import Testing
@testable import KakeiMatchCore

struct EntryPresentationTests {
    @Test func acceptsOnlyPositiveSafeIntegerYen() throws {
        #expect(try KMEntryPresentation.parseAmountYen("1234") == 1_234)
        #expect(try KMEntryPresentation.parseAmountYen("0", allowsZero: true) == 0)
        for invalid in ["", "0", "-1", "1.5", "１", "9,000", "9007199254740992"] {
            #expect(throws: (any Error).self) { try KMEntryPresentation.parseAmountYen(invalid) }
        }
    }

    @Test func validatesExpenseIncomeAndTransferRequirements() throws {
        let categories = [KMCategory(id: "food", name: "食費"), KMCategory(id: "salary", name: "給与", isIncome: true)]
        let accounts = [KMAccount(id: "card", name: "カード", accountType: .creditCard),
                        KMAccount(id: "bank", name: "銀行", accountType: .bank)]
        let expense = try KMEntryPresentation.validate(.init(kind: .expense, amount: "1250", payee: " 店 ",
            date: "2026-10-14", categoryId: "food", accountId: "card", destinationAccountId: "",
            memo: "  買い物  ", time: "09:05", excludedFromSpending: true), categories: categories, accounts: accounts)
        #expect(expense.payee == "店")
        #expect(expense.memo == "買い物")
        #expect(expense.time == "09:05")
        #expect(expense.excludedFromSpending)

        let income = try KMEntryPresentation.validate(.init(kind: .income, amount: "50000", payee: "給与",
            date: "2026-10-14", categoryId: "salary", accountId: "bank", destinationAccountId: "",
            memo: "", time: "22:15", excludedFromSpending: true), categories: categories, accounts: accounts)
        #expect(income.kind == .income)
        #expect(income.time == nil)
        #expect(!income.excludedFromSpending)

        let transfer = try KMEntryPresentation.validate(.init(kind: .transfer, amount: "10000", payee: "",
            date: "2026-10-14", categoryId: "", accountId: "card", destinationAccountId: "bank",
            memo: "", time: nil, excludedFromSpending: false), categories: categories, accounts: accounts)
        #expect(transfer.categoryId == nil)
        #expect(transfer.destinationAccountId == "bank")
        #expect(throws: (any Error).self) {
            try KMEntryPresentation.validate(.init(kind: .transfer, amount: "10000", payee: "",
                date: "2026-10-14", categoryId: "", accountId: "bank", destinationAccountId: "bank",
                memo: "", time: nil, excludedFromSpending: false), categories: categories, accounts: accounts)
        }
    }

    @Test func rejectsInvalidCalendarDateCategoryAccountTimeAndTextLengths() {
        let categories = [KMCategory(id: "food", name: "食費")]
        let accounts = [KMAccount(id: "cash", name: "現金", accountType: .cash)]
        func draft(date: String = "2026-10-14", category: String = "food", account: String = "cash",
                   payee: String = "店", time: String? = nil, memo: String = "") -> KMEntryDraft {
            KMEntryDraft(kind: .expense, amount: "100", payee: payee, date: date, categoryId: category,
                accountId: account, destinationAccountId: "", memo: memo, time: time, excludedFromSpending: false)
        }
        for value in [draft(date: "2026-02-29"), draft(category: "missing"), draft(account: "missing"),
                      draft(payee: "  "), draft(time: "24:00"), draft(memo: String(repeating: "あ", count: 2_001))] {
            #expect(throws: (any Error).self) { try KMEntryPresentation.validate(value, categories: categories, accounts: accounts) }
        }
    }

    @Test func ordersCategoriesByUsageThenPwaRankAndKeepsStableFallbackOrder() {
        let input = [KMCategory(id: "other-a", name: "独自A", usageCount: 4),
                     KMCategory(id: "daily", name: "日用品", usageCount: 1),
                     KMCategory(id: "food", name: "食費", usageCount: 1),
                     KMCategory(id: "other-b", name: "独自B", usageCount: 4)]
        #expect(KMEntryPresentation.sortedCategories(input).map(\.id) == ["other-a", "other-b", "food", "daily"])
    }

    @Test func picksLatestAvailableCategoryOfSameKindAndGroupsAccountsLikePwa() {
        let recent = [transaction("new-income", kind: .income, category: "salary"),
                      transaction("new-expense", kind: .expense, category: "food"),
                      transaction("old-expense", kind: .expense, category: "hidden")]
        #expect(KMEntryPresentation.lastUsedCategory(kind: .expense, recent: recent, availableIds: ["food"]) == "food")
        #expect(KMEntryPresentation.lastUsedCategory(kind: .income, recent: recent, availableIds: ["salary"]) == "salary")
        #expect(KMEntryPresentation.lastUsedCategory(kind: .expense, recent: recent, availableIds: ["different"]) == nil)
        let accounts = [KMAccount(id: "cash", name: "現金", accountType: .cash),
                        KMAccount(id: "card", name: "カード", accountType: .creditCard),
                        KMAccount(id: "bank", name: "銀行", accountType: .bank)]
        #expect(KMEntryPresentation.orderedAccounts(accounts, for: .expense).map(\.id) == ["card", "bank", "cash"])
        #expect(KMEntryPresentation.orderedAccounts(accounts, for: .income).map(\.id) == ["bank", "cash", "card"])
    }

    @Test func usesTokyoCalendarAndCreatesScheduleFromTheNextOccurrence() throws {
        let today = KMDate(rawValue: "2026-10-14")
        #expect(KMEntryPresentation.shiftedDate(today, by: -1)?.rawValue == "2026-10-13")
        let endOfMonth = KMDate(rawValue: "2026-01-31")
        #expect(KMEntryPresentation.nextOccurrence(after: endOfMonth, frequency: .monthly)?.rawValue == "2026-03-31")
        #expect(KMEntryPresentation.nextOccurrence(after: KMDate(rawValue: "2024-02-29"), frequency: .yearly)?.rawValue == "2028-02-29")
        #expect(KMEntryPresentation.nextOccurrence(after: today, frequency: .weekly)?.rawValue == "2026-10-21")

        let entry = KMValidatedEntry(kind: .expense, amountYen: 1_200, payee: "家賃", date: endOfMonth,
            categoryId: "housing", accountId: "bank", destinationAccountId: nil, memo: nil,
            time: nil, excludedFromSpending: false)
        let schedule = KMEntryPresentation.recurringInput(for: entry, frequency: .monthly)
        #expect(schedule?.startDate.rawValue == "2026-03-31")
        #expect(schedule?.amountYen == 1_200)
        #expect(KMEntryPresentation.recurringInput(for: entry, frequency: .none) == nil)
    }

    private func transaction(_ id: String, kind: KMTransactionKind, category: String) -> KMTransaction {
        KMTransaction(id: id, date: KMDate(rawValue: "2026-10-14"), amountYen: kind == .expense ? -100 : 100,
            kind: kind, payeeName: id, accountId: "account", categoryId: category)
    }
}

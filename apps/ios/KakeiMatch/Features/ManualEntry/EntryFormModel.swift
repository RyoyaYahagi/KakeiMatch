import Foundation
import Observation

@MainActor @Observable
final class KMEntryFormModel {
    enum AccountField: Equatable { case source, destination }

    let kind: KMEntryKind
    var amount = ""
    var payee = ""
    var date = ""
    var time: String?
    var categoryId = ""
    var accountId = ""
    var destinationAccountId = ""
    var memo = ""
    var excludedFromSpending = false
    var isMemoExpanded = false
    var frequency = KMEntryFrequency.none
    var categories: [KMCategory] = []
    var accounts: [KMAccount] = []
    var lastUsedCategoryId: String?
    var today = KMDate(rawValue: "2026-10-14")
    var loading = true
    var busy = false
    var didSave = false
    var error: String?
    var status: String?
    var sheetError: String?
    var newCategoryName = ""
    var newAccountName = ""
    var newAccountType: KMAccountType = .bank
    var accountFieldForCreation: AccountField = .source

    @ObservationIgnored private var repositories: KMRepositories?
    @ObservationIgnored private let started = ProcessInfo.processInfo.systemUptime

    init(kind: KMEntryKind) { self.kind = kind }

    var now: Date {
        guard let repositories, repositories.fixtureName != nil else { return Date() }
        return repositories.referenceDate.addingTimeInterval(ProcessInfo.processInfo.systemUptime - started)
    }

    var selectedCategory: KMCategory? { categories.first { $0.id == categoryId } }
    var selectedAccount: KMAccount? { accounts.first { $0.id == accountId } }
    var selectedDestinationAccount: KMAccount? { accounts.first { $0.id == destinationAccountId } }
    var eligibleCategories: [KMCategory] { categories.filter { $0.isIncome == kind.categoryIsIncome && !$0.hidden } }

    func load(_ repositories: KMRepositories?) async {
        guard let repositories else {
            loading = false
            error = "家計簿を開けませんでした。アプリを開き直してください。"
            return
        }
        self.repositories = repositories
        loading = true
        error = nil
        do {
            let today = KMDate(instant: repositories.referenceDate)
            let categories = try await repositories.categories.categories(includeHidden: false)
            let accounts = try await repositories.accounts.accounts(asOf: today, includeClosed: false)
            let recent = try await repositories.transactions.recordDays(matching: KMTransactionQuery(limit: 100)).flatMap(\.records)
            self.today = today
            self.categories = KMEntryPresentation.sortedCategories(categories.filter { $0.isIncome == kind.categoryIsIncome })
            self.accounts = KMEntryPresentation.orderedAccounts(accounts, for: kind)
            self.date = today.rawValue
            self.lastUsedCategoryId = KMEntryPresentation.lastUsedCategory(kind: kind, recent: recent,
                availableIds: Set(self.categories.map(\.id)))
            self.categoryId = self.lastUsedCategoryId ?? ""
            if self.accounts.count == 1 { self.accountId = self.accounts[0].id }
            loading = false
        } catch {
            self.error = error.localizedDescription
            loading = false
        }
    }

    func validate() throws -> KMValidatedEntry {
        let draft = KMEntryDraft(kind: kind, amount: amount, payee: payee, date: date,
            categoryId: categoryId, accountId: accountId, destinationAccountId: destinationAccountId,
            memo: memo, time: time, excludedFromSpending: excludedFromSpending)
        return try KMEntryPresentation.validate(draft, categories: categories, accounts: accounts)
    }

    func createCategory() async -> String? {
        guard let repositories else { sheetError = "家計簿を開けませんでした。"; return nil }
        let name = newCategoryName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 100 else {
            sheetError = "カテゴリ名を1〜100文字で入力してください。"
            return nil
        }
        do {
            let groups = try await repositories.categories.categoryGroups()
            let group = groups.first { $0.isIncome == kind.categoryIsIncome && !$0.hidden }
            let category = KMCategory(id: UUID().uuidString, name: name, isIncome: kind.categoryIsIncome,
                hidden: false, groupName: group?.name ?? (kind.categoryIsIncome ? "収入" : "支出"),
                groupId: group?.id, tone: nil, usageCount: 0)
            try await repositories.categories.saveCategory(category)
            categories = KMEntryPresentation.sortedCategories(try await repositories.categories.categories(includeHidden: false)
                .filter { $0.isIncome == kind.categoryIsIncome })
            categoryId = category.id
            newCategoryName = ""
            sheetError = nil
            return category.id
        } catch {
            sheetError = error.localizedDescription
            return nil
        }
    }

    func createAccount() async -> String? {
        guard let repositories else { sheetError = "家計簿を開けませんでした。"; return nil }
        let name = newAccountName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 100 else {
            sheetError = "口座名を1〜100文字で入力してください。"
            return nil
        }
        do {
            let account = KMAccount(id: UUID().uuidString, name: name, closed: false,
                accountType: newAccountType, balanceYen: 0)
            try await repositories.accounts.createAccount(account, startingBalanceYen: 0, startingDate: today)
            accounts = KMEntryPresentation.orderedAccounts(try await repositories.accounts.accounts(asOf: today, includeClosed: false), for: kind)
            if accountFieldForCreation == .destination { destinationAccountId = account.id }
            else { accountId = account.id }
            newAccountName = ""
            newAccountType = .bank
            sheetError = nil
            return account.id
        } catch {
            sheetError = error.localizedDescription
            return nil
        }
    }

    func save() async {
        guard let repositories, !busy, !didSave else { return }
        busy = true
        error = nil
        status = nil
        do {
            let entry = try validate()
            let scheduleInput = KMEntryPresentation.recurringInput(for: entry, frequency: frequency)
            if let scheduleInput {
                let existing = try await repositories.recurring.recurringTransactions()
                if existing.contains(where: { $0.name.trimmingCharacters(in: .whitespacesAndNewlines) == scheduleInput.name }) {
                    throw KMDataError.invalidData("同じ名前の定期登録があります。内容を変えるか、「くり返し」を「しない」にしてください。")
                }
            }

            switch entry.kind {
            case .expense:
                try await saveManualExpense(entry, using: repositories)
            case .income:
                _ = try await repositories.transactions.saveManual(KMManualTransactionInput(
                    kind: .income, amountYen: entry.amountYen, date: entry.date, payeeName: entry.payee,
                    categoryId: entry.categoryId!, accountId: entry.accountId, memo: entry.memo,
                    importedId: "kakeimatch:manual:\(UUID().uuidString)"), id: nil)
            case .transfer:
                _ = try await repositories.transactions.saveTransfer(KMTransferInput(
                    amountYen: entry.amountYen, date: entry.date, sourceAccountId: entry.accountId,
                    destinationAccountId: entry.destinationAccountId!, memo: entry.memo,
                    importedId: "kakeimatch:transfer:\(UUID().uuidString)"), id: nil)
            }
            didSave = true
            status = "登録しました。"

            if let scheduleInput {
                let schedule = KMRecurringTransaction(id: UUID().uuidString, name: scheduleInput.name,
                    kind: scheduleInput.kind, amountYen: scheduleInput.amountYen, categoryId: scheduleInput.categoryId,
                    accountId: scheduleInput.accountId, frequency: scheduleInput.frequency,
                    startDate: scheduleInput.startDate, postsTransaction: scheduleInput.postsTransaction,
                    nextDate: nil, completed: false, editable: true)
                do {
                    try await repositories.recurring.saveRecurring(schedule, at: now)
                    status = "登録しました。\(scheduleInput.startDate.rawValue)から定期登録も作りました。"
                } catch {
                    status = "登録しました。定期登録は作れませんでした（\(error.localizedDescription)）。設定の「定期登録」から作ってください。"
                }
            }
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    private func saveManualExpense(_ entry: KMValidatedEntry, using repositories: KMRepositories) async throws {
        // The PWA routes a hand-entered expense through its image-free receipt editor.
        // The existing ReceiptRepository preserves optional purchase time without changing Data/API.
        let receiptId = UUID().uuidString
        let timestamp = now
        let value = KMConfirmedReceipt(merchant: entry.payee, purchasedDate: entry.date, purchasedTime: entry.time,
            totalAmountYen: entry.amountYen, categoryId: entry.categoryId!, accountId: entry.accountId,
            excludedFromSpending: entry.excludedFromSpending, memo: entry.memo, taxAmountYen: nil,
            items: nil, adjustments: nil)
        let receipt = KMReceipt(id: receiptId, createdAt: timestamp, updatedAt: timestamp, image: nil,
            extraction: nil, aiFlowId: nil, itemCategories: nil, reviewedWarnings: nil, classificationAttempt: nil,
            aiSuggestion: .init(categoryId: nil, source: .unclassified, probabilities: nil, model: nil,
                attemptedAt: nil, flowId: nil, categoryRules: nil), confirmedValue: value,
            registration: .init(status: .pending, actualTransactionId: nil, lastError: nil))
        try await repositories.receipts.saveReceipt(receipt)
        _ = try await repositories.receipts.registerReceipt(id: receiptId, at: timestamp)
    }
}

import Foundation

@MainActor extension KMInMemoryStore {
    func masterName(_ name: String) throws -> String {
        let value = KMJSString.trim(name)
        guard !value.isEmpty, value.utf16.count <= 100 else { throw KMDataError.invalidData("名前を1〜100文字で入力してください。") }
        return value
    }
    /// Display uses today's cutoff; close additionally checks all dates because Actual close does too.
    func accountBalance(id: String, through date: KMDate? = nil) throws -> Int {
        guard let account = accountValues.first(where: { $0.id == id }) else { throw KMDataError.notFound("口座がありません。") }
        var balance = try KMYen.checked(account.balanceYen)
        for entry in masterWriteState.balanceEntries where entry.accountId == id && (date == nil || entry.date <= date!) {
            balance = try KMYen.add(balance, entry.amountYen)
        }
        for row in transactionValues where row.accountId == id && (date == nil || row.date <= date!) {
            balance = try KMYen.add(balance, row.amountYen)
        }
        return balance
    }
    func accounts(asOf date: KMDate, includeClosed: Bool = true) async throws -> [KMAccount] {
        try accountValues.filter { includeClosed || !$0.closed }.map { account in
            var value = account; value.balanceYen = try accountBalance(id: account.id, through: date); return value
        }
    }
    func createAccount(_ account: KMAccount, startingBalanceYen: Int = 0, startingDate: KMDate) async throws {
        guard !account.id.isEmpty, !account.closed, !accountValues.contains(where: { $0.id == account.id }) else {
            throw KMDataError.invalidData("口座の識別子と状態を確認してください。")
        }
        let name = try masterName(account.name), amount = try KMYen.checked(startingBalanceYen)
        var value = account; value.name = name; value.balanceYen = 0
        accountValues.append(value)
        payeeValues.append(.init(id: UUID().uuidString, name: name, transferAccountId: value.id))
        if amount != 0 { masterWriteState.balanceEntries.append(.init(id: UUID().uuidString, accountId: value.id, date: startingDate, amountYen: amount)) }
    }
    func saveAccount(_ account: KMAccount) async throws {
        let name = try masterName(account.name)
        guard !account.id.isEmpty else { throw KMDataError.invalidData("口座を確認してください。") }
        guard let index = accountValues.firstIndex(where: { $0.id == account.id }) else {
            try await createAccount(account, startingDate: KMDate(instant: Date())); return
        }
        if account.closed && !accountValues[index].closed {
            guard try accountBalance(id: account.id, through: KMDate(instant: Date())) == 0,
                  try accountBalance(id: account.id) == 0 else {
                throw KMDataError.invalidData("残高がある支払元は利用終了にできません。残高を移動して0円にしてから再度お試しください。")
            }
        }
        var value = account; value.name = name; value.balanceYen = accountValues[index].balanceYen
        accountValues[index] = value
        for i in payeeValues.indices where payeeValues[i].transferAccountId == account.id { payeeValues[i].name = name }
        for i in transactionValues.indices where transactionValues[i].transferAccountId == account.id { transactionValues[i].payeeName = name }
    }
    func deleteAccount(id: String) async throws {
        let balance = try accountBalance(id: id)
        guard balance == 0, !transactionValues.contains(where: { $0.accountId == id || $0.transferAccountId == id }),
              !masterWriteState.balanceEntries.contains(where: { $0.accountId == id }) else {
            throw KMDataError.invalidData("取引または残高がある支払元は完全削除できません。履歴を残すため、利用終了を選んでください。")
        }
        accountValues.removeAll { $0.id == id }; payeeValues.removeAll { $0.transferAccountId == id }
    }
    func saveCategory(_ category: KMCategory) async throws {
        var value = category; value.name = try masterName(value.name); value.usageCount = 0
        guard !value.id.isEmpty else { throw KMDataError.invalidData("カテゴリを確認してください。") }
        if let groupId = value.groupId {
            guard let group = groupValues.first(where: { $0.id == groupId }), group.isIncome == value.isIncome else { throw KMDataError.invalidData("種類に合うグループを選んでください。") }
            value.groupName = group.name
        } else if let group = groupValues.first(where: { $0.isIncome == value.isIncome && !$0.hidden }) {
            value.groupId = group.id; value.groupName = group.name
        } else {
            let group = KMCategoryGroup(id: UUID().uuidString, name: value.isIncome ? "収入" : "支出", isIncome: value.isIncome)
            groupValues.append(group); value.groupId = group.id; value.groupName = group.name
        }
        if let index = categoryValues.firstIndex(where: { $0.id == value.id }) { categoryValues[index] = value }
        else { categoryValues.append(value) }
        syncCategoryGroups()
        for i in transactionValues.indices where transactionValues[i].categoryId == value.id { transactionValues[i].categoryName = value.name }
    }
    func deleteCategory(id: String) async throws {
        guard categoryValues.contains(where: { $0.id == id }) else { throw KMDataError.notFound("カテゴリがありません。") }
        guard !transactionValues.contains(where: { $0.categoryId == id || ($0.splits ?? []).contains { $0.categoryId == id } }) else {
            throw KMDataError.invalidData("既存の取引で使われているカテゴリは削除できません。利用をやめる場合は非表示にしてください。")
        }
        categoryValues.removeAll { $0.id == id }; syncCategoryGroups()
        // Preserve historical budget cells; deleted categories are no longer projected by budgetSummary.
    }
    func syncCategoryGroups() {
        for i in groupValues.indices { groupValues[i].categoryIds = categoryValues.filter { $0.groupId == groupValues[i].id }.map(\.id) }
    }
    func saveCategoryGroup(_ group: KMCategoryGroup) async throws {
        var value = group; value.name = try masterName(value.name)
        guard !value.id.isEmpty, !categoryValues.contains(where: { $0.groupId == value.id && $0.isIncome != value.isIncome }) else { throw KMDataError.invalidData("グループの種類を確認してください。") }
        value.categoryIds = categoryValues.filter { $0.groupId == value.id }.map(\.id)
        if let index = groupValues.firstIndex(where: { $0.id == value.id }) { groupValues[index] = value }
        else { groupValues.append(value) }
        for i in categoryValues.indices where categoryValues[i].groupId == value.id { categoryValues[i].groupName = value.name }
    }
    func deleteCategoryGroup(id: String) async throws {
        guard groupValues.contains(where: { $0.id == id }) else { throw KMDataError.notFound("グループがありません。") }
        guard !categoryValues.contains(where: { $0.groupId == id }) else { throw KMDataError.invalidData("カテゴリのあるグループは削除できません。非表示にしてください。") }
        groupValues.removeAll { $0.id == id }
    }
    func reorderCategoryGroups(ids: [String]) async throws {
        guard ids.count == groupValues.count, Set(ids).count == ids.count, Set(ids) == Set(groupValues.map(\.id)) else { throw KMDataError.invalidData("グループの順序を確認してください。") }
        groupValues = ids.map { id in groupValues.first { $0.id == id }! }
    }
    func reorderCategories(groupId: String, ids: [String]) async throws {
        guard groupValues.contains(where: { $0.id == groupId }), Set(ids).count == ids.count,
              ids.count == categoryValues.filter({ $0.groupId == groupId }).count,
              Set(ids) == Set(categoryValues.filter { $0.groupId == groupId }.map(\.id)) else { throw KMDataError.invalidData("カテゴリの順序を確認してください。") }
        let sorted = ids.map { id in categoryValues.first { $0.id == id }! }
        var offset = 0
        for i in categoryValues.indices where categoryValues[i].groupId == groupId { categoryValues[i] = sorted[offset]; offset += 1 }
        syncCategoryGroups()
    }
}

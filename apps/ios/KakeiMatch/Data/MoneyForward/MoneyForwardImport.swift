import Foundation

@MainActor extension KMInMemoryStore {
    private func moneyForwardKey(_ row: KMMoneyForwardRow) -> String {
        KMMoneyForwardParser.categoryKey(kind: row.kind, major: row.majorCategory, minor: row.minorCategory)
    }
    private func mergedMoneyForwardMappings(_ mappings: KMMoneyForwardMappings) -> KMMoneyForwardMappings {
        .init(categories: masterWriteState.moneyForwardRules.categories.merging(mappings.categories) { _, new in new },
            accounts: masterWriteState.moneyForwardRules.accounts.merging(mappings.accounts) { _, new in new })
    }
    private func moneyForwardCandidates(_ row: KMMoneyForwardRow, choice: KMMoneyForwardCategoryChoice, today: KMDate) -> [KMTransaction] {
        transactionValues.filter { value in
            guard value.kind.rawValue == row.kind.rawValue, value.isSplit != true, value.kind != .transfer,
                  value.amountYen == row.amountYen, value.date <= today,
                  value.date >= KMLocalReconciliation.shift(row.date, days: -3), value.date <= KMLocalReconciliation.shift(row.date, days: 3) else { return false }
            switch choice {
            case .existing(let id): return value.categoryId == id
            case .new(let name): return value.categoryName == KMJSString.trim(name)
            case .unclassified: return value.categoryId == nil
            default: return false
            }
        }.sorted {
            func distance(_ date: KMDate) -> Int { abs(KMDate.calendar.dateComponents([.day], from: instant(date), to: instant(row.date)).day!) }
            let left = distance($0.date), right = distance($1.date)
            return left == right ? $0.id < $1.id : left < right
        }
    }
    private nonisolated func instant(_ day: KMDate) -> Date {
        KMDate.calendar.date(from: DateComponents(year: day.yearMonth.year, month: day.yearMonth.month, day: Int(day.rawValue.suffix(2))!))!
    }
    func previewMoneyForward(rows: [KMMoneyForwardRow], mappings: KMMoneyForwardMappings, choices: [String: KMMoneyForwardRecordChoice] = [:], at timestamp: Date) async throws -> [KMMoneyForwardPreview] {
        guard rows.count <= 20_000 else { throw KMDataError.invalidData("Money Forwardの取引データを確認できません。") }
        let mappings = mergedMoneyForwardMappings(mappings), today = KMDate(instant: timestamp)
        let knownIds = Set(transactionValues.compactMap(\.importedId)); var seen = Set<String>()
        return try rows.map { row in
            _ = try KMYen.checked(row.amountYen)
            let id = "moneyforward:\(row.sourceKey)"
            guard row.rowNumber > 0, !row.sourceKey.isEmpty, id.utf16.count <= 200, row.amountYen != 0,
                  (row.amountYen < 0) == (row.kind == .expense), row.description.utf16.count <= 200,
                  row.memo.utf16.count <= 2000 else { throw KMDataError.invalidData("Money Forwardの取引データを確認できません。") }
            let category = mappings.categories[moneyForwardKey(row)] ?? .unresolved
            var status: KMMoneyForwardPreview.Status = .ready
            if row.date > today || row.isTransfer || !row.isIncludedInCalculation || category == .exclude { status = .excluded }
            else if category == .unresolved { status = .unresolved }
            let duplicate = status != .excluded && (knownIds.contains(id) || seen.contains(id))
            if status == .ready { seen.insert(id) }
            let candidates = status == .ready && !duplicate ? moneyForwardCandidates(row, choice: category, today: today) : []
            let choice = status == .ready && !duplicate ? choices[id] : nil
            if case .keep(let transactionId) = choice, !candidates.contains(where: { $0.id == transactionId }) {
                throw KMDataError.invalidData("統一先の記録が変更されています。候補を確認し直してください。")
            }
            if duplicate { status = .duplicate }
            else if case .keep = choice { status = .duplicate }
            else if !candidates.isEmpty && choice == nil { status = .review }
            return .init(row: row, importedId: id, status: status, candidates: candidates, recordChoice: choice)
        }
    }
    func importMoneyForward(id: String, rows: [KMMoneyForwardRow], mappings: KMMoneyForwardMappings, choices: [String: KMMoneyForwardRecordChoice] = [:], rememberMappings: Bool = true, at timestamp: Date) async throws -> KMMoneyForwardBatch {
        if let old = masterWriteState.moneyForward.first(where: { $0.id == id }) {
            guard old.rows.map(\.row) == rows, old.status != .undone else { throw KMDataError.invalidData("同じ移行IDの内容が異なるか、取り消し済みです。") }
            return old
        }
        guard !id.isEmpty, masterWriteState.moneyForward.count < 100 else { throw KMDataError.invalidData("移行IDまたは履歴件数を確認してください。") }
        return try await withLedgerCopy { working in
            var resolved = working.mergedMoneyForwardMappings(mappings)
            // Recheck candidates and global imported IDs immediately before the atomic commit.
            let preview = try await working.previewMoneyForward(rows: rows, mappings: resolved, choices: choices, at: timestamp)
            guard !preview.contains(where: { $0.status == .review || $0.status == .unresolved }) else {
                throw KMDataError.invalidData("未解決のカテゴリまたは似ている既存記録があります。取り込み前に確認してください。")
            }
            var imported: [KMMoneyForwardBatch.Row] = []
            for item in preview {
                if item.status == .excluded || item.status == .duplicate {
                    imported.append(.init(row: item.row, importedId: item.importedId, status: item.status == .excluded ? .excluded : .duplicate,
                        recordChoice: item.recordChoice, transaction: nil)); continue
                }
                let row = item.row, source = row.accountName ?? "", key = working.moneyForwardKey(row)
                let accountId: String
                switch resolved.accounts[source] ?? .unset {
                case .existing(let id): try working.openAccount(id); accountId = id
                case .new(let name): accountId = try await working.moneyForwardAccount(name: name, at: timestamp)
                case .unset: accountId = try await working.moneyForwardAccount(name: "移行元未設定", at: timestamp)
                }
                resolved.accounts[source] = .existing(id: accountId)
                let categoryId: String?
                switch resolved.categories[key] ?? .unresolved {
                case .existing(let id):
                    guard working.categoryValues.contains(where: { $0.id == id && $0.isIncome == (row.kind == .income) }) else { throw KMDataError.invalidData("選択したカテゴリの収支区分が取引と一致しません。") }
                    categoryId = id
                case .new(let name):
                    let name = try working.masterName(name)
                    if let existing = working.categoryValues.first(where: { $0.name == name && $0.isIncome == (row.kind == .income) }) { categoryId = existing.id }
                    else {
                        let id = UUID().uuidString
                        try await working.saveCategory(.init(id: id, name: name, isIncome: row.kind == .income)); categoryId = id
                    }
                    resolved.categories[key] = .existing(id: categoryId!)
                case .unclassified: categoryId = nil
                default: throw KMDataError.invalidData("カテゴリを決めてから移行してください。")
                }
                let result = try await working.importExternalTransaction(.init(accountId: accountId, date: row.date, amountYen: abs(row.amountYen),
                    kind: row.kind == .expense ? .expense : .income, payeeName: KMMoneyForwardParser.description(row), memo: row.memo,
                    categoryId: categoryId, importedId: item.importedId))
                imported.append(.init(row: row, importedId: item.importedId, status: result.alreadyExisted ? .duplicate : .created,
                    recordChoice: item.recordChoice, transaction: result.alreadyExisted ? nil : result.transaction))
            }
            let batch = KMMoneyForwardBatch(id: id, createdAt: timestamp, updatedAt: timestamp, status: .completed, mappings: resolved, rows: imported)
            working.masterWriteState.moneyForward.append(batch)
            if rememberMappings { working.masterWriteState.moneyForwardRules = resolved }
            return batch
        }
    }
    private func moneyForwardAccount(name: String, at timestamp: Date) async throws -> String {
        let name = try masterName(name)
        if let existing = accountValues.first(where: { $0.name == name && !$0.closed }) { return existing.id }
        let id = UUID().uuidString
        try await createAccount(.init(id: id, name: name), startingDate: KMDate(instant: timestamp)); return id
    }
    func moneyForwardHistory() async throws -> [KMMoneyForwardBatch] { masterWriteState.moneyForward }
    func moneyForwardRules() async throws -> KMMoneyForwardMappings { masterWriteState.moneyForwardRules }
    func undoMoneyForward(id: String, at timestamp: Date) async throws {
        try await withLedgerCopy { working in
            guard let index = working.masterWriteState.moneyForward.firstIndex(where: { $0.id == id }) else { throw KMDataError.notFound("移行履歴がありません。") }
            if working.masterWriteState.moneyForward[index].status == .undone { return }
            for i in working.masterWriteState.moneyForward[index].rows.indices.reversed() {
                let item = working.masterWriteState.moneyForward[index].rows[i]
                guard item.status == .created, let saved = item.transaction else { continue }
                if let current = working.transactionValues.first(where: { $0.id == saved.id }) {
                    guard current.importedId == item.importedId else { throw KMDataError.invalidData("移行元の識別子が変更されています。取引一覧で内容を確認してください。") }
                    // PWA explicitly removes later edits too, but never a skipped/kept existing row.
                    _ = try await working.deleteTransaction(id: current.id, expected: nil, at: timestamp)
                }
                working.masterWriteState.moneyForward[index].rows[i].status = .undone
            }
            working.masterWriteState.moneyForward[index].status = .undone
            working.masterWriteState.moneyForward[index].updatedAt = timestamp
        }
    }
}

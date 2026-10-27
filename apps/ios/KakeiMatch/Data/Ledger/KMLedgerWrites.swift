import Foundation

/// Shared domain write service. Validate/prepare first; publish no mutation before the last fallible step.
/// KMSQLiteStore commits this working copy, masters and history in one revision-checked transaction.
@MainActor extension KMInMemoryStore {
    private enum PayeeLookup { case imported, manualEdit, exact }
    private func payee(_ name: String, lookup: PayeeLookup) throws -> KMPayee {
        let trimmed = KMPayeeNormalization.trimmed(name)
        let normalized = lookup == .imported ? try KMPayeeNormalization.importedName(trimmed) : trimmed
        if lookup == .manualEdit, let existing = payeeValues.first(where: {
            KMPayeeNormalization.merchantKey($0.name) == KMPayeeNormalization.merchantKey(normalized)
        }) { return existing }
        // Actual createPayee/getPayeeByName use Unicode lowercase exact equality, not NFKC.
        return payeeValues.first { $0.name.lowercased() == normalized.lowercased() }
            ?? KMPayee(id: UUID().uuidString, name: normalized)
    }
    private func commitPayee(_ value: KMPayee) {
        if let index = payeeValues.firstIndex(where: { $0.id == value.id }) {
            if value.transferAccountId != nil { payeeValues[index] = value }
        } else { payeeValues.append(value) }
    }
    private func replace(_ rows: [KMTransaction]) {
        for row in rows {
            if let index = transactionValues.firstIndex(where: { $0.id == row.id }) { transactionValues[index] = row }
            else { transactionValues.append(row) }
        }
    }
    private func validateText(name: String, memo: String?, importedId: String) throws {
        guard !KMPayeeNormalization.trimmed(name).isEmpty, KMPayeeNormalization.trimmed(name).utf16.count <= 200,
              (memo?.utf16.count ?? 0) <= 2000, !importedId.isEmpty, importedId.utf16.count <= 200 else {
            throw KMDataError.invalidData("入力内容を確認してください。")
        }
    }
    private func sameWrite(_ row: KMTransaction, _ expected: KMTransaction) -> Bool {
        row.date == expected.date && row.amountYen == expected.amountYen && row.kind == expected.kind && row.accountId == expected.accountId
            && KMPayeeNormalization.merchantKey(row.payeeName ?? "") == KMPayeeNormalization.merchantKey(expected.payeeName ?? "")
            && row.categoryId == expected.categoryId && (row.memo ?? "") == (expected.memo ?? "") && row.importedId == expected.importedId
            && (row.isSplit == true) == (expected.isSplit == true) && row.transferId == expected.transferId
            && (row.splits ?? []).map { [$0.categoryId ?? "", String($0.amountYen)] }.sorted { $0.lexicographicallyPrecedes($1) }
                == (expected.splits ?? []).map { [$0.categoryId ?? "", String($0.amountYen)] }.sorted { $0.lexicographicallyPrecedes($1) }
    }
    private func conflict() -> KMDataError { .invalidData("同じ登録IDで異なる記録があります。登録済みの内容を確認してください。") }
    private func validateManualMasters(_ input: KMManualTransactionInput) throws {
        try openAccount(input.accountId); try validCategory(input.categoryId, income: input.kind == .income)
    }
    func saveManual(_ input: KMManualTransactionInput, id: String? = nil) async throws -> KMTransaction {
        guard input.kind != .transfer else { throw KMDataError.invalidData("振替専用の入力を使ってください。") }
        try validAmount(input.amountYen)
        try validateText(name: input.payeeName, memo: input.memo, importedId: input.importedId)
        guard !input.importedId.hasPrefix("kakeimatch:receipt:") || id != nil else { throw conflict() }
        if id == nil && input.importedId.hasPrefix("kakeimatch:payroll:") && input.importedId.range(of: "^kakeimatch:payroll:[0-9a-f-]{36}$", options: [.regularExpression, .caseInsensitive]) == nil { throw conflict() }
        if id == nil && input.importedId.hasPrefix("kakeimatch:schedule:") && input.importedId.range(of: "^kakeimatch:schedule:[A-Za-z0-9_-]{1,128}:[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) == nil { throw conflict() }
        let old = id.flatMap { key in transactionValues.first { $0.id == key } }
        if id != nil {
            guard let old, old.kind == input.kind, old.amountYen != 0, old.isSplit != true, old.splits?.isEmpty != false, old.transferId == nil,
                  old.importedId?.hasPrefix("kakeimatch:receipt:") != true,
                  !receiptValues.contains(where: { $0.registration.actualTransactionId == id }) else {
                throw KMDataError.unsupported("この取引は専用の編集サービスで変更してください。")
            }
        }
        var result = KMTransaction(id: old?.id ?? UUID().uuidString, date: input.date,
            amountYen: input.kind == .expense ? -input.amountYen : input.amountYen, kind: input.kind,
            payeeName: KMPayeeNormalization.trimmed(input.payeeName), categoryName: categoryValues.first { $0.id == input.categoryId }?.name,
            accountId: input.accountId, cleared: old?.cleared ?? false, excludedFromSpending: input.excludedFromSpending,
            categoryId: input.categoryId, memo: input.memo ?? "", importedId: id == nil ? input.importedId : old?.importedId,
            reconciled: old?.reconciled)
        // PWA retries verify the saved fields BEFORE checking whether a master has since been closed/hidden.
        if id == nil, let existing = transactionValues.first(where: { $0.importedId == input.importedId }) {
            guard sameWrite(existing, result) else { throw conflict() }
            var updated = existing; updated.excludedFromSpending = input.excludedFromSpending
            replace([updated]); return updated
        }
        try validateManualMasters(input)
        let explicit = input.importedId.hasPrefix("kakeimatch:payroll:") || input.importedId.hasPrefix("kakeimatch:schedule:")
        let resolved = try payee(input.payeeName, lookup: id != nil ? .manualEdit : explicit ? .exact : .imported)
        guard id != nil || explicit || resolved.transferAccountId == nil else { throw KMDataError.invalidData("振替専用の入力を使ってください。") }
        result.payeeName = resolved.name; result.payeeId = resolved.id
        guard KMPayeeNormalization.merchantKey(result.payeeName ?? "") == KMPayeeNormalization.merchantKey(input.payeeName) else { throw conflict() }
        if id == nil && !explicit { result = try importMatch(result) }
        if result.payeeName == resolved.name { commitPayee(resolved) }
        replace([result])
        if let old { ledgerWriteState.edits.append(.init(id: UUID().uuidString, before: [old], after: [result], appliedAt: Date())) }
        return result
    }
    /// Actual strictIdChecking: only ID-less rows within ±7 days and of the same amount/account can match.
    /// Existing values win. A readback mismatch rejects the atomic write rather than adding a duplicate.
    private func importMatch(_ expected: KMTransaction, matchImportedId: Bool = false) throws -> KMTransaction {
        let candidates = transactionValues.enumerated().filter {
            $0.element.importedId == nil && $0.element.accountId == expected.accountId && $0.element.amountYen == expected.amountYen
                && abs(ledgerInstant($0.element.date).timeIntervalSince(ledgerInstant(expected.date))) <= 7 * 86400
        }.sorted {
            let left = abs(ledgerInstant($0.element.date).timeIntervalSince(ledgerInstant(expected.date)))
            let right = abs(ledgerInstant($1.element.date).timeIntervalSince(ledgerInstant(expected.date)))
            return left == right ? $0.offset > $1.offset : left < right
        }.map(\.element)
        let exact = matchImportedId ? transactionValues.first { $0.importedId == expected.importedId && $0.accountId == expected.accountId } : nil
        guard var row = exact ?? candidates.first(where: { $0.payeeName?.lowercased() == expected.payeeName?.lowercased() }) ?? candidates.first else { return expected }
        if row.reconciled == true {
            guard sameWrite(row, expected) else { throw conflict() }
            if let excluded = expected.excludedFromSpending { row.excludedFromSpending = excluded }
            return row
        }
        row.importedId = expected.importedId
        if row.payeeName == nil { row.payeeName = expected.payeeName; row.payeeId = expected.payeeId }
        if row.categoryId == nil { row.categoryId = expected.categoryId; row.categoryName = expected.categoryName }
        if (row.memo ?? "").isEmpty { row.memo = expected.memo }
        guard sameWrite(row, expected) else { throw conflict() }
        if let excluded = expected.excludedFromSpending { row.excludedFromSpending = excluded }
        return row
    }
    private func ledgerInstant(_ day: KMDate) -> Date {
        KMDate.calendar.date(from: DateComponents(year: day.yearMonth.year, month: day.yearMonth.month, day: Int(day.rawValue.suffix(2))!))!
    }
    private func transferPair(_ selected: KMTransaction) throws -> (KMTransaction, KMTransaction) {
        _ = try KMYen.checked(selected.amountYen)
        guard selected.kind == .transfer, selected.isSplit != true, selected.splits?.isEmpty != false,
              let peer = transactionValues.first(where: { $0.id == selected.transferId }), peer.kind == .transfer,
              peer.transferId == selected.id, peer.accountId != selected.accountId, peer.amountYen == -selected.amountYen,
              peer.date == selected.date, peer.isSplit != true, peer.splits?.isEmpty != false,
              selected.transferAccountId == nil || selected.transferAccountId == peer.accountId,
              peer.transferAccountId == nil || peer.transferAccountId == selected.accountId else {
            throw KMDataError.invalidData("振替の両取引を確認できませんでした。")
        }
        return (selected, peer)
    }
    private func transferPayee(accountId: String) throws -> KMPayee {
        guard let account = accountValues.first(where: { $0.id == accountId }) else { throw conflict() }
        var value = payeeValues.first { $0.transferAccountId == accountId }
            ?? KMPayee(id: UUID().uuidString, name: account.name, transferAccountId: accountId)
        value.name = account.name
        return value
    }
    func saveTransfer(_ input: KMTransferInput, id: String? = nil) async throws -> KMTransaction {
        try validAmount(input.amountYen)
        guard input.sourceAccountId != input.destinationAccountId, !input.importedId.isEmpty, input.importedId.utf16.count <= 200,
              (input.memo?.utf16.count ?? 0) <= 2000 else { throw KMDataError.invalidData("振替先・メモを確認してください。") }
        if id == nil && (input.importedId.hasPrefix("kakeimatch:receipt:") || input.importedId.hasPrefix("kakeimatch:manual:")) { throw conflict() }
        var previous: KMTransaction?, peerBefore: KMTransaction?
        if let id {
            guard let selected = transactionValues.first(where: { $0.id == id }) else { throw conflict() }
            let pair = try transferPair(selected)
            previous = pair.0.importedId != nil ? pair.0 : pair.1
            peerBefore = pair.0.importedId != nil ? pair.1 : pair.0
            guard previous?.importedId != nil, peerBefore?.importedId == nil,
                  previous?.categoryId == nil, peerBefore?.categoryId == nil,
                  previous?.importedId?.hasPrefix("kakeimatch:receipt:") != true else { throw conflict() }
        } else if let existing = transactionValues.first(where: { $0.importedId == input.importedId }) {
            let pair = try transferPair(existing)
            guard transactionValues.filter({ $0.importedId == input.importedId }).count == 1,
                  pair.0.accountId == input.sourceAccountId, pair.1.accountId == input.destinationAccountId,
                  pair.0.amountYen == -input.amountYen, pair.0.date == input.date,
                  (pair.0.memo ?? "") == (input.memo ?? ""), (pair.1.memo ?? "") == (input.memo ?? ""),
                  pair.0.categoryId == nil, pair.1.categoryId == nil else { throw conflict() }
            return pair.0
        }
        try openAccount(input.sourceAccountId); try openAccount(input.destinationAccountId)
        let destinationPayee = try transferPayee(accountId: input.destinationAccountId)
        let sourcePayee = try transferPayee(accountId: input.sourceAccountId)
        let outgoingId = previous?.id ?? UUID().uuidString, incomingId = peerBefore?.id ?? UUID().uuidString
        let outgoing = KMTransaction(id: outgoingId, date: input.date, amountYen: -input.amountYen, kind: .transfer,
            payeeName: destinationPayee.name, accountId: input.sourceAccountId, cleared: previous?.cleared ?? false,
            memo: input.memo ?? "", importedId: previous?.importedId ?? input.importedId,
            transferAccountId: input.destinationAccountId, transferId: incomingId, reconciled: previous?.reconciled, payeeId: destinationPayee.id)
        let incoming = KMTransaction(id: incomingId, date: input.date, amountYen: input.amountYen, kind: .transfer,
            payeeName: sourcePayee.name, accountId: input.destinationAccountId, cleared: peerBefore?.cleared ?? false,
            memo: input.memo ?? "", transferAccountId: input.sourceAccountId, transferId: outgoingId, reconciled: peerBefore?.reconciled, payeeId: sourcePayee.id)
        commitPayee(destinationPayee); commitPayee(sourcePayee); replace([outgoing, incoming])
        if let previous, let peerBefore {
            ledgerWriteState.edits.append(.init(id: UUID().uuidString, before: [previous, peerBefore], after: [outgoing, incoming], appliedAt: Date()))
        }
        return outgoing
    }
    private func receiptCategoryId(_ id: String) throws -> String {
        let aliases = ["food": "食費", "household": "日用品", "transport": "交通", "medical": "医療・健康", "clothing": "衣服・美容",
                       "entertainment": "趣味・娯楽", "utilities": "水道・光熱", "communications": "通信", "other": "その他"]
        guard let category = categoryValues.first(where: { category in
            !category.hidden && !category.isIncome && !groupValues.contains { $0.id == category.groupId && $0.hidden }
                && (category.id == id || aliases[id] == category.name)
        }) else { throw KMDataError.invalidData("カテゴリを選び直してください。") }
        return category.id
    }
    private func receiptTransaction(_ value: KMConfirmedReceipt, receipt: KMReceipt, previous: KMTransaction?) throws -> (KMTransaction, KMPayee) {
        try KMReceiptAllocation.validate(value, allowZero: receipt.image != nil)
        try openAccount(value.accountId); _ = try receiptCategoryId(value.categoryId)
        for item in value.items ?? [] { if let category = item.categoryId { _ = try receiptCategoryId(category) } }
        var allocations: [KMReceiptAllocation.Allocation] = []
        for allocation in try KMReceiptAllocation.allocations(value) {
            let categoryId = try receiptCategoryId(allocation.categoryId)
            if let index = allocations.firstIndex(where: { $0.categoryId == categoryId }) {
                allocations[index].amountYen = try KMYen.add(allocations[index].amountYen, allocation.amountYen)
            } else { allocations.append(.init(categoryId: categoryId, amountYen: allocation.amountYen)) }
        }
        guard let first = allocations.first else { throw conflict() }
        let resolved = try payee(value.merchant, lookup: previous == nil ? .imported : .exact)
        guard previous != nil || resolved.transferAccountId == nil,
              KMPayeeNormalization.merchantKey(resolved.name) == KMPayeeNormalization.merchantKey(value.merchant) else { throw conflict() }
        let split = allocations.count > 1
        let children: [KMTransactionSplit]? = split ? allocations.enumerated().map { index, allocation in
            let old = previous?.splits?.indices.contains(index) == true ? previous!.splits![index] : nil
            return KMTransactionSplit(id: old?.id ?? UUID().uuidString,
                categoryId: allocation.categoryId, amountYen: -allocation.amountYen, memo: old?.memo, payeeName: resolved.name,
                cleared: previous?.cleared ?? false, reconciled: previous?.reconciled, payeeId: resolved.id)
        } : nil
        let row = KMTransaction(id: previous?.id ?? UUID().uuidString, date: value.purchasedDate, amountYen: -value.totalAmountYen,
            kind: .expense, payeeName: resolved.name, categoryName: split ? nil : categoryValues.first { $0.id == first.categoryId }?.name,
            accountId: value.accountId, cleared: previous?.cleared ?? false,
            excludedFromSpending: value.totalAmountYen > 0 ? value.excludedFromSpending ?? previous?.excludedFromSpending : previous?.excludedFromSpending,
            categoryId: split ? nil : first.categoryId, memo: value.memo ?? "", importedId: previous?.importedId ?? "kakeimatch:\(receipt.id)",
            isSplit: split, splits: children, reconciled: previous?.reconciled, payeeId: resolved.id)
        return (row, resolved)
    }
    func registerReceipt(id: String, at timestamp: Date) async throws -> KMReceipt {
        guard var receipt = receiptValues.first(where: { $0.id == id }) else { throw KMDataError.notFound("レシートがありません。") }
        if receipt.registration.status == .applied { return receipt }
        guard receipt.registration.status != .deleted, let value = receipt.confirmedValue else {
            throw KMDataError.invalidData("登録内容を確認してください。削除済みの支出は元に戻してください。")
        }
        let prepared = try receiptTransaction(value, receipt: receipt, previous: nil)
        let resolved = prepared.1
        if transactionValues.contains(where: { $0.importedId == prepared.0.importedId && $0.accountId != prepared.0.accountId }) { throw conflict() }
        let row = try importMatch(prepared.0, matchImportedId: true)
        receipt.registration = .init(status: .applied, actualTransactionId: row.id, lastError: nil)
        receipt.updatedAt = timestamp
        if row.payeeName == resolved.name { commitPayee(resolved) }
        replace([row]); receiptValues[receiptValues.firstIndex { $0.id == id }!] = receipt
        return receipt
    }
    func editReceipt(id: String, value: KMConfirmedReceipt, expectedUpdatedAt: Date, at timestamp: Date) async throws -> KMReceipt {
        guard let index = receiptValues.firstIndex(where: { $0.id == id }) else { throw KMDataError.notFound("レシートがありません。") }
        let oldReceipt = receiptValues[index]
        guard oldReceipt.updatedAt == expectedUpdatedAt else { throw KMDataError.invalidData("別の画面で内容が変更されています。最新の内容を開き直してください。") }
        guard oldReceipt.registration.status == .applied, let previous = transactionValues.first(where: { $0.id == oldReceipt.registration.actualTransactionId }),
              previous.importedId == "kakeimatch:\(id)", previous.transferId == nil else { throw conflict() }
        let (row, resolved) = try receiptTransaction(value, receipt: oldReceipt, previous: previous)
        var receipt = oldReceipt; receipt.confirmedValue = value; receipt.confirmedValue?.merchant = KMPayeeNormalization.trimmed(value.merchant)
        receipt.updatedAt = timestamp
        let retained = Set((row.splits ?? []).map(\.id))
        let retired = (previous.splits ?? []).filter { !retained.contains($0.id) }
        commitPayee(resolved); replace([row]); receiptValues[index] = receipt
        ledgerWriteState.splitTombstones += retired.map { .init(parentId: row.id, split: $0) }
        ledgerWriteState.edits.append(.init(id: UUID().uuidString, before: [previous], after: [row], receiptBefore: oldReceipt, receiptAfter: receipt, appliedAt: timestamp))
        return receipt
    }
    private func deletionTree(_ id: String) throws -> [KMTransaction] {
        guard let row = transactionValues.first(where: { $0.id == id }) else { throw KMDataError.notFound("記録がありません。") }
        _ = try KMYen.checked(row.amountYen)
        if row.kind == .transfer { let pair = try transferPair(row); return [pair.0, pair.1] }
        guard row.transferId == nil else { throw conflict() }
        if row.isSplit == true {
            let children = row.splits ?? []
            guard !children.isEmpty, children.count <= 101, Set([row.id] + children.map(\.id)).count == children.count + 1,
                  try children.reduce(0, { try KMYen.add($0, $1.amountYen) }) == row.amountYen else { throw conflict() }
        } else if row.splits?.isEmpty == false { throw conflict() }
        return [row]
    }
    func deleteTransaction(id: String, expected: [KMTransaction]?, at timestamp: Date) async throws -> KMTransactionDeletion {
        let rows = try deletionTree(id), ids = Set(rows.map(\.id))
        if let expected { guard expected == rows else { throw KMDataError.invalidData("取引が変更されています。最新の内容を確認してください。") } }
        let linked = receiptValues.filter { receipt in
            receipt.registration.actualTransactionId.map { ids.contains($0) } == true || rows.contains { $0.importedId == "kakeimatch:\(receipt.id)" }
        }
        guard linked.allSatisfy({ $0.registration.status == .applied }), !resolutionValues.contains(where: { resolution in
            resolution.status != .applied && (resolution.actualTransactionId.map { ids.contains($0) } == true
                || resolution.receiptId.map { key in linked.contains { $0.id == key } } == true)
        }) else { throw KMDataError.invalidData("登録や照合の変更結果を先に確認してください。") }
        let audit = KMTransactionDeletion(id: UUID().uuidString, transactions: rows, receipts: linked,
            deletedAt: timestamp, undoUntil: timestamp.addingTimeInterval(10))
        ledgerWriteState.tombstones += rows.map { .init(transaction: $0) }
        ledgerWriteState.deletions.append(audit)
        transactionValues.removeAll { ids.contains($0.id) }
        for receipt in linked {
            let index = receiptValues.firstIndex { $0.id == receipt.id }!
            receiptValues[index].registration.status = .deleted; receiptValues[index].registration.lastError = nil; receiptValues[index].updatedAt = timestamp
        }
        return audit
    }
    func transactionDeletions() async throws -> [KMTransactionDeletion] { ledgerWriteState.deletions }
    func undoTransactionDeletion(id: String, at timestamp: Date) async throws {
        guard let index = ledgerWriteState.deletions.firstIndex(where: { $0.id == id }), ledgerWriteState.deletions[index].restoredAt == nil else {
            throw KMDataError.invalidData("元に戻せる削除記録がありません。")
        }
        let audit = ledgerWriteState.deletions[index]
        guard timestamp < audit.undoUntil else { throw KMDataError.invalidData("取り消し時間を過ぎています。") }
        let activeIds = Set(transactionValues.flatMap { [$0.id] + ($0.splits ?? []).map(\.id) })
        for row in audit.transactions {
            guard activeIds.isDisjoint(with: Set([row.id] + (row.splits ?? []).map(\.id))),
                  !transactionValues.contains(where: { row.importedId != nil && $0.importedId == row.importedId }),
                  ledgerWriteState.tombstones.contains(where: { $0.tombstone && $0.transaction == row }),
                  accountValues.contains(where: { $0.id == row.accountId }) else { throw conflict() }
            for payeeId in ([row.payeeId] + (row.splits ?? []).map(\.payeeId)).compactMap({ $0 }) {
                guard payeeValues.contains(where: { $0.id == payeeId }) else { throw conflict() }
            }
            for category in ([row.categoryId] + (row.splits ?? []).map(\.categoryId)).compactMap({ $0 }) {
                guard categoryValues.contains(where: { $0.id == category }) else { throw conflict() }
            }
        }
        for receipt in audit.receipts {
            guard receiptValues.contains(where: { $0.id == receipt.id && $0.registration.status == .deleted }) else { throw conflict() }
        }
        replace(audit.transactions)
        let ids = Set(audit.transactions.map(\.id))
        for i in ledgerWriteState.tombstones.indices where ids.contains(ledgerWriteState.tombstones[i].transaction.id) { ledgerWriteState.tombstones[i].tombstone = false }
        for receipt in audit.receipts { receiptValues[receiptValues.firstIndex { $0.id == receipt.id }!] = receipt }
        ledgerWriteState.deletions[index].restoredAt = timestamp
    }
}

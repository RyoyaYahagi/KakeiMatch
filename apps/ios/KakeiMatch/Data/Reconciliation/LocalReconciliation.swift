import Foundation

struct KMReconciliationError: Error, Equatable, Sendable {
    var code: String
    init(_ code: String) { self.code = code }
}

struct KMReconciliationAlias: Codable, Equatable, Sendable {
    var merchant: String
    var aliasMerchant: String
    var learnedBy: String?
}
struct KMReconciliationPairRejection: Codable, Equatable, Sendable {
    var runId: String
    var statementId: String
    var receiptId: String
}
struct KMReconciliationUndo: Codable, Equatable, Sendable {
    var resolution: KMReconciliationResolution
    var undoneAt: Date
}

/// Pure device-local state machine. A durable adapter must reserve decisions before ledger I/O,
/// persist processing/failed states and read back the ledger (see local-reconciliation.ts).
/// The in-memory adapter applies these transitions atomically to value snapshots.
struct KMLocalReconciliation: Codable, Equatable, Sendable {
    var statements: [KMStatementTransaction]
    var imports: [KMLocalRecord<KMStatementImport>]
    var transactions: [KMTransaction]
    var accounts: [KMAccount]
    var categories: [KMCategory]
    var receipts: [KMReceipt]
    var resolutions: [KMReconciliationResolution] = []
    var aliases: [KMReconciliationAlias] = []
    var rejections: [KMReconciliationPairRejection] = []
    var suspected: [KMSuspectedStatement] = []
    var manualStatementIds: Set<String> = []
    var undoHistory: [KMReconciliationUndo] = []
    var latest: KMReconciliationRun?
    private var preparedAtRun: Prepared?

    struct Prepared: Codable, Equatable, Sendable {
        var statements: [KMStatementTransaction]
        var receipts: [KMReceipt]
        var imports: [KMLocalRecord<KMStatementImport>]
        var transactions: [KMTransaction]
        var accounts: [KMAccount]
        var resolutions: [KMReconciliationResolution]
        var aliases: [KMReconciliationAlias]
        var rejections: [KMReconciliationPairRejection]
        var suspected: [KMSuspectedStatement]
        var manual: Set<String>
    }
    init(statements: [KMStatementTransaction], imports: [KMLocalRecord<KMStatementImport>], transactions: [KMTransaction],
         accounts: [KMAccount], categories: [KMCategory], receipts: [KMReceipt] = [], resolutions: [KMReconciliationResolution] = []) {
        self.statements = statements; self.imports = imports; self.transactions = transactions
        self.accounts = accounts; self.categories = categories; self.receipts = receipts; self.resolutions = resolutions
    }

    private func window(_ importId: String, includes date: KMDate) -> Bool {
        let dates = statements.filter { $0.importId == importId }.map(\.usedDate)
        guard let first = dates.min(), let last = dates.max() else { return false }
        return date >= Self.shift(first, days: -7) && date <= Self.shift(last, days: 7)
    }
    static func shift(_ date: KMDate, days: Int) -> KMDate {
        let parts = date.rawValue.split(separator: "-").map { Int($0)! }
        let calendar = KMDate.calendar
        let instant = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))!
        return KMDate(instant: calendar.date(byAdding: .day, value: days, to: instant)!)
    }
    private func scopedTransactions() -> [KMTransaction] {
        transactions.filter { row in statements.contains { window($0.importId, includes: row.date) } }
    }
    private func snapshot() -> Prepared {
        let rows = scopedTransactions()
        let accountIds = Set(rows.map(\.accountId))
        // An unused account added during registration must not invalidate an existing run.
        let receiptInputs = receipts.map { receipt -> KMReceipt in
            let confirmed = receipt.confirmedValue.map { KMConfirmedReceipt(merchant: $0.merchant, purchasedDate: $0.purchasedDate,
                totalAmountYen: $0.totalAmountYen, categoryId: "", accountId: $0.accountId) }
            return KMReceipt(id: receipt.id, createdAt: .distantPast, updatedAt: .distantPast, aiSuggestion: .init(source: .unclassified),
                confirmedValue: confirmed, registration: .init(status: receipt.registration.status, actualTransactionId: receipt.registration.actualTransactionId))
        }
        let transactionInputs = rows.filter { $0.kind == .expense && $0.amountYen < 0 }.map { row in
            KMTransaction(id: row.id, date: row.date, amountYen: row.amountYen, kind: row.kind, payeeName: row.payeeName,
                accountId: row.accountId, cleared: row.cleared, isSplit: row.isSplit ?? false)
        }
        let accountInputs = accounts.filter { accountIds.contains($0.id) }.map { row in
            KMAccount(id: row.id, name: row.name, closed: row.closed, accountType: row.accountType, statementProvider: row.statementProvider)
        }
        return Prepared(statements: statements.sorted { $0.id < $1.id }, receipts: receiptInputs.sorted { $0.id < $1.id },
            imports: imports.sorted { $0.id < $1.id }, transactions: transactionInputs.sorted { $0.id < $1.id },
            accounts: accountInputs.sorted { $0.id < $1.id },
            resolutions: resolutions.sorted { $0.statementId < $1.statementId }, aliases: aliases,
            rejections: rejections, suspected: suspected, manual: manualStatementIds)
    }
    private func receiptId(for transaction: KMTransaction) -> String {
        receipts.first { $0.confirmedValue != nil && $0.registration.status == .applied && $0.registration.actualTransactionId == transaction.id }?.id ?? "actual:\(transaction.id)"
    }
    private func source(_ candidateId: String) -> KMTransaction? {
        transactions.first { receiptId(for: $0) == candidateId }
    }
    func calculate() -> KMReconciliationResult {
        let usedActual = Set(resolutions.compactMap(\.actualTransactionId))
        let usedImported = Set(resolutions.compactMap(\.importedId))
        let excludedStatements = Set(resolutions.map(\.statementId) + suspected.map(\.statementId))
        let rows = scopedTransactions().filter { row in
            row.kind == .expense && row.amountYen < 0 && row.amountYen >= -9_007_199_254_740_991 && !row.cleared &&
            !usedActual.contains(row.id) && !(row.importedId.map { usedImported.contains($0) } ?? false) &&
            accounts.contains { $0.id == row.accountId && !$0.closed && $0.accountType != .cash }
        }
        let inputs = rows.map { row in KMReconciliationReceipt(receiptId: receiptId(for: row), actualTransactionId: row.id,
            merchant: row.payeeName ?? "", purchasedDate: row.date, amountYen: -row.amountYen, actualAccountId: row.accountId) }
        var preferred: [String: Set<String>] = [:]
        for statement in statements {
            preferred[statement.id] = Set(accounts.filter { !$0.closed && $0.accountType != .cash && $0.statementProvider == statement.provider }.map(\.id))
        }
        var result = KMReconciliationEngine.run(statements: statements, receipts: inputs, preferredAccountIds: preferred,
            aliases: Set(aliases.map { KMReconciliationEngine.aliasKey($0.merchant, $0.aliasMerchant) }),
            excludedStatementIds: excludedStatements,
            excludedReceiptIds: Set(resolutions.filter { $0.resolution == .sameExpense }.compactMap(\.receiptId)),
            rejectedPairs: Set(rejections.map { KMReconciliationEngine.pairKey($0.statementId, $0.receiptId) }), manualStatementIds: manualStatementIds)
        let waiting = Set(rows.filter { row in
            statements.contains { statement in
                guard window(statement.importId, includes: row.date), let account = accounts.first(where: { $0.id == row.accountId }) else { return false }
                let metadata = imports.first { $0.id == statement.importId }?.value
                return account.statementProvider == (metadata?.provider ?? statement.provider) || account.id == metadata?.accountId
            }
        }.map { receiptId(for: $0) })
        result.receiptResults.removeAll { !waiting.contains($0.receiptId) }
        return result
    }
    @discardableResult mutating func run(id: String, at timestamp: Date) throws -> KMReconciliationRun {
        let result = calculate()
        let run = KMReconciliationRun(runId: id, createdAt: timestamp, completedAt: timestamp, ruleVersion: result.ruleVersion,
            candidates: result.candidates, statementResults: result.statementResults, receiptResults: result.receiptResults)
        latest = run
        for match in result.statementResults where match.status == .matched {
            guard let receiptId = match.matchedReceiptId, let statement = statements.first(where: { $0.id == match.statementTransactionId }),
                  let transaction = source(receiptId) else { throw KMReconciliationError("record_unavailable") }
            var resolution = decision(run: run, statement: statement, kind: .sameExpense, at: timestamp)
            resolution.source = .automatic; resolution.receiptId = receiptId
            resolution.actualTransactionId = transaction.id; resolution.actualSnapshot = Self.actualSnapshot(transaction)
            resolutions.append(resolution)
            try apply(resolution.id, at: timestamp)
        }
        preparedAtRun = snapshot()
        return run
    }
    private func requireLatest(_ id: String) throws -> KMReconciliationRun {
        guard let latest, latest.runId == id, preparedAtRun == snapshot() else { throw KMReconciliationError("stale_run") }
        return latest
    }
    // Like PWA inputFingerprint, preparedAtRun is captured only by run().
    // Every decision changes the inputs and requires a new run before further review.
    mutating func recordManualReview(statementId: String) {
        manualStatementIds.insert(statementId)
    }
    private func decision(run: KMReconciliationRun, statement: KMStatementTransaction, kind: KMReconciliationResolution.Resolution, at timestamp: Date) -> KMReconciliationResolution {
        .init(id: "reconciliation-resolution:\(statement.id)", runId: run.runId, statementId: statement.id, resolution: kind, source: .user,
            statementAmountYen: statement.amountYen, status: .pending,
            statementSnapshot: .init(usedDate: statement.usedDate, merchant: statement.merchant, kind: statement.kind), createdAt: timestamp, updatedAt: timestamp)
    }
    private func requireUndecided(_ id: String) throws {
        guard !resolutions.contains(where: { $0.statementId == id }) else { throw KMReconciliationError("decision_conflict") }
    }
    @discardableResult mutating func sameExpense(runId: String, statementId: String, receiptId: String, at timestamp: Date) throws -> KMReconciliationResolution {
        try requireUndecided(statementId)
        let run = try requireLatest(runId)
        guard !suspected.contains(where: { $0.statementId == statementId }) else { throw KMReconciliationError("decision_conflict") }
        guard run.candidates.contains(where: { $0.statementTransactionId == statementId && $0.receiptId == receiptId }) else { throw KMReconciliationError("candidate_unavailable") }
        guard !resolutions.contains(where: { $0.resolution == .sameExpense && $0.receiptId == receiptId }) else { throw KMReconciliationError("receipt_already_used") }
        guard let statement = statements.first(where: { $0.id == statementId }), statement.kind == .purchase,
              let row = source(receiptId), row.kind == .expense else { throw KMReconciliationError("record_unavailable") }
        guard row.isSplit != true || row.amountYen == -statement.amountYen else { throw KMReconciliationError("split_amount_adjustment_unsupported") }
        var value = decision(run: run, statement: statement, kind: .sameExpense, at: timestamp)
        value.receiptId = receiptId; value.actualTransactionId = row.id; value.actualSnapshot = Self.actualSnapshot(row)
        resolutions.append(value); try apply(value.id, at: timestamp)
        return resolutions.first { $0.id == value.id }!
    }
    mutating func rejectPair(runId: String, statementId: String, receiptId: String) throws {
        let run = try requireLatest(runId)
        guard run.candidates.contains(where: { $0.statementTransactionId == statementId && $0.receiptId == receiptId }) else { throw KMReconciliationError("candidate_unavailable") }
        try requireUndecided(statementId)
        guard !rejections.contains(where: { $0.runId == runId && $0.statementId == statementId && $0.receiptId == receiptId }) else { throw KMReconciliationError("decision_conflict") }
        rejections.append(.init(runId: runId, statementId: statementId, receiptId: receiptId))
    }
    @discardableResult mutating func ignore(runId: String, statementId: String, at timestamp: Date) throws -> KMReconciliationResolution {
        let run = try requireLatest(runId); try requireUndecided(statementId)
        guard run.statementResults.contains(where: { $0.statementTransactionId == statementId && $0.status != .matched }),
              let statement = statements.first(where: { $0.id == statementId }) else { throw KMReconciliationError("decision_unavailable") }
        var value = decision(run: run, statement: statement, kind: .ignored, at: timestamp)
        value.status = .applied; resolutions.append(value)
        return value
    }
    /// Resolves current provider mapping. Callers provide a deterministic ID only when creation is needed.
    mutating func registrationAccount(provider: KMStatementProvider, newAccountId: String) throws -> String {
        let open = accounts.filter { !$0.closed && $0.accountType != .cash }
        let mapped = open.filter { $0.statementProvider == provider }
        guard mapped.count <= 1 else { throw KMReconciliationError("account_mapping_ambiguous") }
        if let account = mapped.first { return account.id }
        let names: [KMStatementProvider: String] = [.rakutenCard: "楽天カード", .smbcCard: "三井住友カード", .paypayCard: "PayPayカード", .paypay: "PayPay", .aeonCard: "イオンカード"]
        let named = open.filter { $0.name == names[provider] }
        guard named.count <= 1, named.first?.statementProvider == nil else { throw KMReconciliationError("account_mapping_ambiguous") }
        if let account = named.first {
            accounts[accounts.firstIndex { $0.id == account.id }!].statementProvider = provider; return account.id
        }
        guard !newAccountId.isEmpty, !accounts.contains(where: { $0.id == newAccountId }) else { throw KMReconciliationError("account_mapping_ambiguous") }
        accounts.append(.init(id: newAccountId, name: names[provider]!, accountType: .creditCard, statementProvider: provider))
        return newAccountId
    }
    @discardableResult mutating func noReceipt(runId: String, statementId: String, categoryId: String?, destinationAccountId: String? = nil,
        excludedFromSpending: Bool? = nil, newAccountId: String, at timestamp: Date) throws -> KMReconciliationResolution {
        let run = try requireLatest(runId)
        guard run.statementResults.contains(where: { $0.statementTransactionId == statementId && $0.status != .matched }),
              let statement = statements.first(where: { $0.id == statementId }), statement.kind == .purchase else { throw KMReconciliationError("decision_unavailable") }
        let rejected = Set(rejections.map { KMReconciliationEngine.pairKey($0.statementId, $0.receiptId) })
        guard !run.candidates.contains(where: { $0.statementTransactionId == statementId && !rejected.contains(KMReconciliationEngine.pairKey(statementId, $0.receiptId)) }) else { throw KMReconciliationError("candidates_remaining") }
        try requireUndecided(statementId)
        let previousOpen = accounts.filter { !$0.closed }
        let account = try registrationAccount(provider: statement.provider, newAccountId: newAccountId)
        if let destinationAccountId {
            guard destinationAccountId != account, previousOpen.contains(where: { $0.id == destinationAccountId }) else { throw KMReconciliationError("destination_unavailable") }
        } else {
            guard categories.contains(where: { $0.id == categoryId && !$0.hidden && !$0.isIncome }) else { throw KMReconciliationError("category_unavailable") }
        }
        var value = decision(run: run, statement: statement, kind: destinationAccountId == nil ? .noReceipt : .transfer, at: timestamp)
        value.accountId = account; value.categoryId = destinationAccountId == nil ? categoryId : nil
        value.destinationAccountId = destinationAccountId; value.excludedFromSpending = excludedFromSpending
        value.importedId = "kakeimatch:statement:\(statement.id)"
        resolutions.append(value); try apply(value.id, at: timestamp)
        return resolutions.first { $0.id == value.id }!
    }
    static func actualSnapshot(_ row: KMTransaction) -> KMReconciliationResolution.ActualSnapshot {
        .init(date: row.date, amountYen: row.amountYen, payeeName: row.payeeName, accountId: row.accountId, isSplit: row.isSplit, cleared: row.cleared)
    }
    private static func matchesFields(_ row: KMTransaction, _ snapshot: KMReconciliationResolution.ActualSnapshot) -> Bool {
        row.kind == .expense && row.date == snapshot.date && row.accountId == snapshot.accountId && row.payeeName == snapshot.payeeName && (row.isSplit ?? false) == (snapshot.isSplit ?? false)
    }
    /// Retry is idempotent by imported ID. Failures retain the reserved decision, excluding it from new runs.
    mutating func retry(_ id: String, at timestamp: Date) throws {
        guard let value = resolutions.first(where: { $0.id == id }), value.status != .applied else { throw KMReconciliationError("retry_unavailable") }
        guard value.undoRequestedAt == nil else { throw KMReconciliationError("undo_unavailable") }
        try apply(id, at: timestamp)
    }
    /// Older decisions did not store an Actual snapshot. Reconstruct it only from
    /// the confirmed receipt and a matching ledger row; never permit undo of this snapshot.
    private func hydrateLegacySnapshot(_ input: KMReconciliationResolution) throws -> KMReconciliationResolution {
        guard input.resolution == .sameExpense, input.actualSnapshot == nil else { return input }
        guard let receiptId = input.receiptId, let actualId = input.actualTransactionId,
              let receipt = receipts.first(where: { $0.id == receiptId }), let confirmed = receipt.confirmedValue,
              receipt.registration.actualTransactionId == actualId else { throw KMReconciliationError("resolution_snapshot_invalid") }
        guard let row = transactions.first(where: { $0.id == actualId }), row.kind == .expense,
              row.date == confirmed.purchasedDate, row.accountId == confirmed.accountId, let payee = row.payeeName,
              KMReconciliationEngine.normalizeMerchant(payee) == KMReconciliationEngine.normalizeMerchant(confirmed.merchant),
              row.amountYen == -confirmed.totalAmountYen || (input.source == .user && row.cleared && row.amountYen == -input.statementAmountYen),
              input.source != .automatic || row.amountYen == -input.statementAmountYen,
              row.isSplit != true || row.amountYen == -input.statementAmountYen else { throw KMReconciliationError("actual_readback_mismatch") }
        var value = input
        value.actualSnapshot = Self.actualSnapshot(row)
        value.actualSnapshot?.cleared = nil
        return value
    }
    private mutating func apply(_ id: String, at timestamp: Date) throws {
        guard let index = resolutions.firstIndex(where: { $0.id == id }) else { throw KMReconciliationError("retry_unavailable") }
        var value = resolutions[index]; value.status = .processing; value.updatedAt = timestamp; value.errorCode = nil
        resolutions[index] = value
        do {
            value = try hydrateLegacySnapshot(value)
            if value.resolution == .sameExpense {
                guard value.receiptId != nil, let actualId = value.actualTransactionId, let snapshot = value.actualSnapshot,
                      let rowIndex = transactions.firstIndex(where: { $0.id == actualId }) else { throw KMReconciliationError("resolution_snapshot_invalid") }
                let row = transactions[rowIndex], target = -value.statementAmountYen
                let alreadyApplied = value.source == .user && row.isSplit != true && row.amountYen == target && row.cleared
                guard Self.matchesFields(row, snapshot), row.amountYen == snapshot.amountYen || alreadyApplied,
                      value.source != .automatic || row.amountYen == target else { throw KMReconciliationError("actual_readback_mismatch") }
                guard row.isSplit != true || row.amountYen == target else { throw KMReconciliationError("split_amount_adjustment_unsupported") }
                transactions[rowIndex] = try KMLedgerReconciliation.updated(row, amountYen: value.source == .user ? target : nil, cleared: true)
                if value.source == .user, let merchant = value.statementSnapshot?.merchant, let payee = snapshot.payeeName, merchant != payee {
                    let key = KMReconciliationEngine.aliasKey(merchant, payee)
                    if !aliases.contains(where: { KMReconciliationEngine.aliasKey($0.merchant, $0.aliasMerchant) == key }) {
                        let formatter = ISO8601DateFormatter()
                        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                        aliases.append(.init(merchant: merchant, aliasMerchant: payee,
                            learnedBy: value.id + ":" + formatter.string(from: value.createdAt)))
                    }
                }
            } else if value.resolution != .ignored {
                guard let account = value.accountId, let importedId = value.importedId,
                      let statement = value.statementSnapshot, statement.kind == .purchase,
                      value.resolution == .transfer ? value.destinationAccountId != nil : value.categoryId != nil else { throw KMReconciliationError("resolution_snapshot_invalid") }
                let kind: KMTransactionKind = value.resolution == .transfer ? .transfer : .expense
                let actualId = transactions.first { $0.importedId == importedId && $0.accountId == account }?.id ?? importedId
                if let existing = transactions.first(where: { $0.id == actualId }) {
                    guard existing.kind == kind, existing.accountId == account, existing.date == statement.usedDate,
                          existing.amountYen == -value.statementAmountYen,
                          kind == .transfer ? existing.transferAccountId == value.destinationAccountId : KMReconciliationEngine.normalizeMerchant(existing.payeeName ?? "") == KMReconciliationEngine.normalizeMerchant(statement.merchant)
                    else { throw KMReconciliationError("actual_readback_mismatch") }
                } else {
                    let incomingId = kind == .transfer ? "\(actualId):incoming" : nil
                    transactions.append(.init(id: actualId, date: statement.usedDate, amountYen: -value.statementAmountYen, kind: kind,
                        payeeName: kind == .expense ? statement.merchant : nil, accountId: account, cleared: true,
                        excludedFromSpending: kind == .expense ? value.excludedFromSpending : nil, categoryId: value.categoryId,
                        memo: kind == .transfer ? statement.merchant : nil, importedId: importedId,
                        transferAccountId: value.destinationAccountId, transferId: incomingId))
                    if let destination = value.destinationAccountId, let incomingId {
                        transactions.append(.init(id: incomingId, date: statement.usedDate, amountYen: value.statementAmountYen, kind: .transfer,
                            accountId: destination, memo: statement.merchant, transferAccountId: account, transferId: actualId))
                    }
                }
                let rowIndex = transactions.firstIndex { $0.id == actualId }!
                transactions[rowIndex].cleared = true
                if kind == .expense, let excluded = value.excludedFromSpending { transactions[rowIndex].excludedFromSpending = excluded }
                value.actualTransactionId = actualId
            }
            value.status = .applied; value.errorCode = nil
        } catch {
            value.status = .failed; value.errorCode = (error as? KMReconciliationError)?.code ?? "actual_apply_failed"
        }
        resolutions[index] = value
    }
    mutating func markSuspected(runId: String, statementId: String, at timestamp: Date) throws {
        let run = try requireLatest(runId)
        guard run.statementResults.contains(where: { $0.statementTransactionId == statementId && $0.status != .matched }) else { throw KMReconciliationError("decision_conflict") }
        try requireUndecided(statementId)
        if suspected.contains(where: { $0.statementId == statementId }) { return }
        manualStatementIds.insert(statementId); suspected.append(.init(statementId: statementId, markedAt: timestamp))
    }
    mutating func clearSuspected(statementId: String) {
        suspected.removeAll { $0.statementId == statementId }
    }
    mutating func undoSameExpense(_ id: String, at timestamp: Date) throws {
        guard let index = resolutions.firstIndex(where: { $0.id == id }), resolutions[index].source == .user,
              resolutions[index].resolution == .sameExpense, let snapshot = resolutions[index].actualSnapshot,
              let cleared = snapshot.cleared, let actualId = resolutions[index].actualTransactionId,
              resolutions[index].status == .applied || resolutions[index].undoRequestedAt != nil else { throw KMReconciliationError("undo_unavailable") }
        let value = resolutions[index]
        guard let rowIndex = transactions.firstIndex(where: { $0.id == actualId }) else { throw KMReconciliationError("undo_record_changed") }
        let row = transactions[rowIndex]
        let restored = Self.matchesFields(row, snapshot) && row.amountYen == snapshot.amountYen && row.cleared == cleared
        let applied = Self.matchesFields(row, snapshot) && row.amountYen == -value.statementAmountYen && row.cleared
        guard applied || value.undoRequestedAt != nil && restored else { throw KMReconciliationError("undo_record_changed") }
        manualStatementIds.insert(value.statementId)
        transactions[rowIndex] = try KMLedgerReconciliation.updated(row, amountYen: snapshot.amountYen, cleared: cleared)
        if let merchant = value.statementSnapshot?.merchant, let payee = snapshot.payeeName {
            let key = KMReconciliationEngine.aliasKey(merchant, payee)
            let supported = resolutions.contains { other in
                other.id != id && other.source == .user && other.undoRequestedAt == nil && other.resolution == .sameExpense &&
                other.statementSnapshot.map { s in other.actualSnapshot?.payeeName.map { KMReconciliationEngine.aliasKey(s.merchant, $0) == key } ?? false } == true
            }
            if !supported { aliases.removeAll { KMReconciliationEngine.aliasKey($0.merchant, $0.aliasMerchant) == key && ($0.learnedBy == nil || $0.learnedBy!.hasPrefix("reconciliation-resolution:")) } }
        }
        undoHistory.append(.init(resolution: value, undoneAt: value.undoRequestedAt ?? timestamp)); resolutions.remove(at: index)
    }
}

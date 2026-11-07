import Foundation

@MainActor extension KMInMemoryStore {
    func recordManualReview(statementId: String) {
        var state = currentReconciliation(); state.recordManualReview(statementId: statementId)
        reconciliationState = state
    }
    func clearSuspectedReview(statementId: String) {
        var state = currentReconciliation(); state.clearSuspected(statementId: statementId)
        reconciliationState = state; suspectedValues = state.suspected
    }
    private func currentReconciliation() -> KMLocalReconciliation {
        var state = reconciliationState ?? KMLocalReconciliation(statements: statementValues, imports: importValues,
            transactions: transactionValues, accounts: accountValues, categories: categoryValues)
        state.statements = statementValues; state.imports = importValues; state.transactions = transactionValues
        state.accounts = accountValues; state.categories = categoryValues.map { category in
            var value = category; value.hidden = value.hidden || groupValues.contains { $0.id == value.groupId && $0.hidden }; return value
        }; state.receipts = receiptValues
        state.resolutions = resolutionValues; state.suspected = suspectedValues
        return state
    }
    /// The pure decision engine proposes changes; all actual repository writes pass through Ledger.
    /// In particular a statement registration must create payees/transfer peers exactly like manual entry.
    private func storeReconciliation(_ proposed: KMLocalReconciliation, at timestamp: Date) async throws {
        try await withLedgerCopy { working in
            var state = proposed
            for account in state.accounts {
                if working.accountValues.contains(where: { $0.id == account.id }) { try await working.saveAccount(account) }
                else { try await working.createAccount(account, startingDate: KMDate(instant: timestamp)) }
            }
            var mapped: [String: String] = [:]
            let originalIds = Set(working.transactionValues.map(\.id))
            for row in state.transactions {
                if originalIds.contains(row.id) {
                    let old = working.transactionValues.first { $0.id == row.id }!
                    if old.amountYen != row.amountYen || old.cleared != row.cleared {
                        try working.applyReconciliationUpdate(id: row.id, amountYen: row.kind == .expense ? row.amountYen : nil, cleared: row.cleared, at: timestamp)
                    }
                    continue
                }
                guard let importedId = row.importedId else { continue } // incoming peer is created with its root
                let saved: KMTransaction
                if row.kind == .transfer {
                    guard let destination = row.transferAccountId else { throw KMReconciliationError("destination_unavailable") }
                    saved = try await working.saveTransfer(.init(amountYen: -row.amountYen, date: row.date,
                        sourceAccountId: row.accountId, destinationAccountId: destination, memo: row.memo, importedId: importedId))
                } else {
                    guard let category = row.categoryId else { throw KMReconciliationError("category_unavailable") }
                    saved = try await working.saveManual(.init(kind: .expense, amountYen: -row.amountYen, date: row.date,
                        payeeName: row.payeeName ?? "", categoryId: category, accountId: row.accountId, memo: row.memo,
                        importedId: importedId, excludedFromSpending: row.excludedFromSpending ?? false))
                }
                try working.applyReconciliationUpdate(id: saved.id, amountYen: nil, cleared: true, at: timestamp)
                mapped[row.id] = saved.id
            }
            for i in state.resolutions.indices {
                if let id = state.resolutions[i].actualTransactionId, let mapped = mapped[id] { state.resolutions[i].actualTransactionId = mapped }
            }
            state.transactions = working.transactionValues; state.accounts = working.accountValues
            if let latest = state.latest, !working.runValues.contains(where: { $0.runId == latest.runId }) { working.runValues.append(latest) }
            @MainActor func append(_ event: KMReconciliationAnalysis.Event, runId: String) {
                guard let index = working.runValues.firstIndex(where: { $0.runId == runId }), working.runValues[index].analysis != nil else { return }
                working.runValues[index].analysis?.events.append(event)
            }
            for resolution in state.resolutions where !working.resolutionValues.contains(resolution) {
                append(.init(at: timestamp, statementId: resolution.statementId, receiptId: resolution.receiptId, kind: "decision", source: resolution.source.rawValue,
                    resolution: resolution.resolution.rawValue, status: resolution.status.rawValue, errorCode: resolution.errorCode), runId: resolution.runId)
            }
            for rejection in state.rejections where !(working.reconciliationState?.rejections.contains(rejection) ?? false) {
                append(.init(at: timestamp, statementId: rejection.statementId, receiptId: rejection.receiptId, kind: "rejected", source: "user"), runId: rejection.runId)
            }
            for undo in state.undoHistory where !(working.reconciliationState?.undoHistory.contains(undo) ?? false) {
                append(.init(at: undo.undoneAt, statementId: undo.resolution.statementId, receiptId: undo.resolution.receiptId, kind: "undo", source: "user",
                    resolution: undo.resolution.resolution.rawValue, status: "applied"), runId: undo.resolution.runId)
            }
            if let id = state.latest?.runId { state.latest = working.runValues.first { $0.runId == id } }
            working.reconciliationState = state; working.resolutionValues = state.resolutions; working.suspectedValues = state.suspected
        }
    }
    func runTestReconciliation(id: String, at timestamp: Date) async throws -> KMReconciliationRun {
        var sandbox = currentReconciliation()
        let run = try sandbox.run(id: id, at: timestamp, testMode: true)
        runValues.append(run)
        return run
    }
    func analysisRuns() async throws -> [KMReconciliationRun] { runValues }

    func runReconciliation(id: String, at timestamp: Date) async throws -> KMReconciliationRun {
        var state = currentReconciliation()
        let run = try state.run(id: id, at: timestamp)
        try await storeReconciliation(state, at: timestamp); return runValues.first { $0.runId == run.runId } ?? run
    }
    func confirmSameExpense(runId: String, statementId: String, receiptId: String, at timestamp: Date) async throws -> KMReconciliationResolution {
        var state = currentReconciliation()
        let resolution = try state.sameExpense(runId: runId, statementId: statementId, receiptId: receiptId, at: timestamp)
        try await storeReconciliation(state, at: timestamp)
        return resolutionValues.first { $0.id == resolution.id }!
    }
    func rejectCandidate(runId: String, statementId: String, receiptId: String) async throws {
        var state = currentReconciliation()
        try state.rejectPair(runId: runId, statementId: statementId, receiptId: receiptId)
        try await storeReconciliation(state, at: Date())
    }
    func ignoreStatement(runId: String, statementId: String, at timestamp: Date) async throws -> KMReconciliationResolution {
        var state = currentReconciliation()
        let value = try state.ignore(runId: runId, statementId: statementId, at: timestamp)
        try await storeReconciliation(state, at: timestamp); return value
    }
    func registerStatement(runId: String, statementId: String, categoryId: String?, destinationAccountId: String?, excludedFromSpending: Bool?, newAccountId: String, at timestamp: Date) async throws -> KMReconciliationResolution {
        var state = currentReconciliation()
        let resolution = try state.noReceipt(runId: runId, statementId: statementId, categoryId: categoryId, destinationAccountId: destinationAccountId,
            excludedFromSpending: excludedFromSpending, newAccountId: newAccountId, at: timestamp)
        try await storeReconciliation(state, at: timestamp)
        return resolutionValues.first { $0.id == resolution.id }!
    }
    func retryResolution(id: String, at timestamp: Date) async throws {
        var state = currentReconciliation(); try state.retry(id, at: timestamp)
        try await storeReconciliation(state, at: timestamp)
    }
    func undoSameExpense(id: String, at timestamp: Date) async throws {
        var state = currentReconciliation(); try state.undoSameExpense(id, at: timestamp)
        try await storeReconciliation(state, at: timestamp)
    }
}

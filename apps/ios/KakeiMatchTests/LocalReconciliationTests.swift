import Foundation
import Testing
@testable import KakeiMatch

struct LocalReconciliationTests {
    private let now = Date(timeIntervalSince1970: 1_792_000_000)
    private func statement(_ id: String = "s", amount: Int = 1000, merchant: String = "人工ストア", kind: KMStatementTransaction.Kind = .purchase) -> KMStatementTransaction {
        .init(id: id, importId: "import", provider: .paypayCard, kind: kind, usedDate: KMDate(rawValue: "2026-10-01"), merchant: merchant,
            amountYen: amount, sourceFingerprint: "fingerprint", duplicateOrdinal: 1)
    }
    private func service(amount: Int = 980, split: Bool = false) -> KMLocalReconciliation {
        KMLocalReconciliation(statements: [statement()], imports: [],
            transactions: [.init(id: "t", date: KMDate(rawValue: "2026-10-01"), amountYen: -amount, kind: .expense,
                payeeName: "人工ストア", accountId: "card", isSplit: split)],
            accounts: [.init(id: "card", name: "PayPayカード", accountType: .creditCard, statementProvider: .paypayCard),
                .init(id: "cash", name: "現金", accountType: .cash)], categories: [.init(id: "food", name: "食費")])
    }
    @Test @MainActor func fixtureIsComputedAndEqualsPWAGolden() async throws {
        struct Golden: Decodable { var run: KMReconciliationRun; var resolutions: [KMReconciliationResolution] }
        let url = try #require(Bundle.main.url(forResource: "reconciliation", withExtension: "json"))
        let golden = try KMJSON.decoder().decode(Golden.self, from: Data(contentsOf: url))
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        #expect(try await repositories.reconciliation.latestRun() == golden.run)
        #expect(try await repositories.reconciliation.resolutions() == golden.resolutions)
    }
    @Test func manualCorrectionUndoAndAutoSuppression() throws {
        var state = service()
        let run = try state.run(id: "one", at: now)
        #expect(run.statementResults.first?.status == .needsReview)
        let decision = try state.sameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        #expect(decision.status == .applied)
        #expect(state.transactions[0].amountYen == -1000 && state.transactions[0].cleared)
        try state.undoSameExpense(decision.id, at: now)
        #expect(state.transactions[0].amountYen == -980 && !state.transactions[0].cleared)
        #expect(state.resolutions.isEmpty && state.undoHistory.count == 1)
        state.transactions[0].amountYen = -1000
        let rerun = try state.run(id: "two", at: now)
        #expect(rerun.statementResults.first?.status == .needsReview)
    }
    @Test func splitAmountGuardAndExactAutomatic() throws {
        var split = service(split: true)
        _ = try split.run(id: "one", at: now)
        #expect(throws: KMReconciliationError("split_amount_adjustment_unsupported")) {
            try split.sameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        }
        #expect(split.resolutions.isEmpty && split.transactions[0].amountYen == -980)
        var exact = service(amount: 1000, split: true)
        _ = try exact.run(id: "exact", at: now)
        #expect(exact.resolutions.first?.source == .automatic)
        #expect(exact.transactions[0].cleared && exact.transactions[0].amountYen == -1000)
        #expect(throws: KMReconciliationError("undo_unavailable")) { try exact.undoSameExpense(exact.resolutions[0].id, at: now) }
    }
    @Test func manualDecisionInvalidatesRunLikePWAFingerprint() throws {
        let transactions = ["t1", "t2"].map { id in
            KMTransaction(id: id, date: KMDate(rawValue: "2026-10-01"), amountYen: -1000, kind: .expense,
                payeeName: "人工ストア", accountId: "card", cleared: false)
        }
        var state = KMLocalReconciliation(statements: [statement("s1"), statement("s2")], imports: [], transactions: transactions,
            accounts: [.init(id: "card", name: "PayPayカード", accountType: .creditCard, statementProvider: .paypayCard)],
            categories: [.init(id: "food", name: "食費")])
        let run = try state.run(id: "one", at: now)
        #expect(run.statementResults.allSatisfy { $0.status == .needsReview })
        let first = try state.sameExpense(runId: "one", statementId: "s1", receiptId: "actual:t1", at: now)
        #expect(throws: KMReconciliationError("stale_run")) {
            try state.sameExpense(runId: "one", statementId: "s2", receiptId: "actual:t2", at: now)
        }
        _ = try state.run(id: "two", at: now)
        // The remaining exact unique pair was automatically applied by the new run.
        let second = try #require(state.resolutions.first { $0.statementId == "s2" })
        #expect(first.status == .applied && second.status == .applied)
        #expect(state.resolutions.map(\.statementId) == ["s1", "s2"])
    }

    @Test func legacySnapshotRetryRequiresConfirmedReceiptAndCannotUndo() throws {
        for alreadyApplied in [false, true] {
            var state = service()
            state.receipts = [KMReceipt(id: "receipt", createdAt: now, updatedAt: now,
                confirmedValue: .init(merchant: "人工ストア", purchasedDate: KMDate(rawValue: "2026-10-01"),
                    totalAmountYen: 980, categoryId: "food", accountId: "card"),
                aiSuggestion: .init(source: .unclassified), registration: .init(status: .applied, actualTransactionId: "t"))]
            _ = try state.run(id: "one", at: now)
            let decision = try state.sameExpense(runId: "one", statementId: "s", receiptId: "receipt", at: now)
            state.resolutions[0].actualSnapshot = nil
            state.resolutions[0].status = .failed
            if !alreadyApplied { state.transactions[0].amountYen = -980; state.transactions[0].cleared = false }
            try state.retry(decision.id, at: now)
            #expect(state.resolutions[0].status == .applied)
            #expect(state.transactions[0].amountYen == -1000 && state.transactions[0].cleared)
            #expect(state.resolutions[0].actualSnapshot?.cleared == nil)
            #expect(throws: KMReconciliationError("undo_unavailable")) { try state.undoSameExpense(decision.id, at: now) }
        }
        var unsafe = service()
        _ = try unsafe.run(id: "one", at: now)
        let decision = try unsafe.sameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        unsafe.resolutions[0].actualSnapshot = nil; unsafe.resolutions[0].status = .failed
        try unsafe.retry(decision.id, at: now)
        #expect(unsafe.resolutions[0].status == .failed)
        #expect(unsafe.resolutions[0].errorCode == "resolution_snapshot_invalid")

        var automatic = service(amount: 1000)
        automatic.receipts = [KMReceipt(id: "receipt", createdAt: now, updatedAt: now,
            confirmedValue: .init(merchant: "人工ストア", purchasedDate: KMDate(rawValue: "2026-10-01"),
                totalAmountYen: 1000, categoryId: "food", accountId: "card"),
            aiSuggestion: .init(source: .unclassified), registration: .init(status: .applied, actualTransactionId: "t"))]
        _ = try automatic.run(id: "one", at: now)
        automatic.resolutions[0].actualSnapshot = nil; automatic.resolutions[0].status = .failed
        automatic.transactions[0].amountYen = -980; automatic.transactions[0].cleared = false
        try automatic.retry(automatic.resolutions[0].id, at: now)
        #expect(automatic.resolutions[0].errorCode == "actual_readback_mismatch")
        #expect(!automatic.transactions[0].cleared && automatic.transactions[0].amountYen == -980)
    }

    @Test func cashClearedAndFailedDecisionsAreExcluded() throws {
        var state = service()
        state.transactions[0].accountId = "cash"
        #expect(state.calculate().candidates.isEmpty)
        state.transactions[0].accountId = "card"; state.transactions[0].cleared = true
        #expect(state.calculate().candidates.isEmpty)
        state.transactions[0].cleared = false
        _ = try state.run(id: "one", at: now)
        _ = try state.sameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        state.resolutions[0].status = .failed
        state.statements.append(statement("second"))
        #expect(state.calculate().candidates.isEmpty)
        #expect(state.calculate().statementResults.map(\.statementTransactionId) == ["second"])
    }
    @Test func rejectionSurvivesRerunAndAllowsRegistration() throws {
        var state = service()
        _ = try state.run(id: "one", at: now)
        #expect(throws: KMReconciliationError("candidates_remaining")) {
            try state.noReceipt(runId: "one", statementId: "s", categoryId: "food", newAccountId: "new", at: now)
        }
        try state.rejectPair(runId: "one", statementId: "s", receiptId: "actual:t")
        #expect(throws: KMReconciliationError("stale_run")) {
            try state.noReceipt(runId: "one", statementId: "s", categoryId: "food", newAccountId: "new", at: now)
        }
        _ = try state.run(id: "after-rejection", at: now)
        let value = try state.noReceipt(runId: "after-rejection", statementId: "s", categoryId: "food", excludedFromSpending: true, newAccountId: "new", at: now)
        #expect(value.resolution == .noReceipt && value.status == .applied)
        #expect(state.transactions.count == 2 && state.transactions.last?.excludedFromSpending == true)
        _ = try state.run(id: "two", at: now)
        #expect(state.latest?.statementResults.isEmpty == true)
    }
    @Test func ignoreRefundAndCandidateDoesNotMutateLedger() throws {
        var state = service()
        state.statements.append(statement("refund", kind: .refund))
        _ = try state.run(id: "one", at: now)
        #expect(throws: KMReconciliationError("decision_unavailable")) {
            try state.noReceipt(runId: "one", statementId: "refund", categoryId: "food", newAccountId: "new", at: now)
        }
        _ = try state.ignore(runId: "one", statementId: "refund", at: now)
        _ = try state.run(id: "two", at: now)
        _ = try state.ignore(runId: "two", statementId: "s", at: now)
        #expect(state.transactions.count == 1 && !state.transactions[0].cleared)
        #expect(state.calculate().statementResults.isEmpty)
    }
    @Test func transferRegistrationAndCurrentProviderMapping() throws {
        var state = service()
        state.transactions = []
        _ = try state.run(id: "one", at: now)
        let value = try state.noReceipt(runId: "one", statementId: "s", categoryId: nil, destinationAccountId: "cash", newAccountId: "new", at: now)
        #expect(value.status == .applied && value.accountId == "card")
        #expect(state.transactions.map(\.amountYen) == [-1000, 1000])
        #expect(state.transactions[0].transferId == state.transactions[1].id)
        #expect(state.transactions[1].transferId == state.transactions[0].id)
    }
    @Test func staleRunAndUndoOfChangedRecordAreRejected() throws {
        var state = service()
        _ = try state.run(id: "one", at: now)
        state.transactions[0].payeeName = "変更後"
        #expect(throws: KMReconciliationError("stale_run")) {
            try state.sameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        }
        _ = try state.run(id: "two", at: now)
        let decision = try state.sameExpense(runId: "two", statementId: "s", receiptId: "actual:t", at: now)
        state.transactions[0].date = KMDate(rawValue: "2026-10-02")
        #expect(throws: KMReconciliationError("undo_record_changed")) { try state.undoSameExpense(decision.id, at: now) }
    }
    @Test func unusedAccountDoesNotInvalidateRunAndProviderChangeDoes() throws {
        var state = service()
        _ = try state.run(id: "one", at: now)
        state.accounts.append(.init(id: "unused", name: "未使用"))
        _ = try state.sameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        var changed = service()
        _ = try changed.run(id: "one", at: now)
        changed.accounts[0].statementProvider = .rakutenCard
        #expect(throws: KMReconciliationError("stale_run")) { try changed.ignore(runId: "one", statementId: "s", at: now) }
    }
    @Test func suspectedClearingStillRequiresManualReview() throws {
        var state = service()
        _ = try state.run(id: "one", at: now)
        try state.markSuspected(runId: "one", statementId: "s", at: now)
        #expect(state.calculate().statementResults.isEmpty)
        state.clearSuspected(statementId: "s")
        state.transactions[0].amountYen = -1000
        let run = try state.run(id: "two", at: now)
        #expect(run.statementResults.first?.status == .needsReview)
    }
    @Test func crossImportDuplicateIdentityAndConflict() throws {
        var first = statement(), repeatRow = first
        first.id = "legacy-account-scoped"; repeatRow.id = "new"; repeatRow.importId = "another"
        #expect(try KMStatementDeduplication.newRows([repeatRow], existing: [first]).duplicates == 1)
        repeatRow.duplicateOrdinal = 2
        #expect(try KMStatementDeduplication.newRows([repeatRow], existing: [first]).added.count == 1)
        first.externalId = "external"; repeatRow.externalId = "external"; repeatRow.amountYen += 1
        #expect(throws: KMReconciliationError("duplicate_external_id_conflict")) { try KMStatementDeduplication.newRows([repeatRow], existing: [first]) }
    }
    @Test func allConditionalAttentionBranchesMatchTS() throws {
        let normal = statement("normal", amount: 1200)
        let refund = statement("refund", amount: 200, kind: .refund)
        let small = statement("small", amount: 500, merchant: "New Store")
        #expect(try KMReconciliationReview.attention(statements: [normal, refund], unresolvedIds: ["normal", "refund"]).isEmpty)
        #expect(try KMReconciliationReview.attention(statements: [small], unresolvedIds: ["small"]).isEmpty)
        var old = statement("old", amount: 1000, merchant: "Old Store")
        old.usedDate = KMDate(rawValue: "2026-09-01")
        #expect(try KMReconciliationReview.attention(statements: [old, small], unresolvedIds: ["small"]).first?.reasons == ["過去の明細にない加盟店で500円以下の決済"])
        old.provider = .rakutenCard
        #expect(try KMReconciliationReview.attention(statements: [old, small], unresolvedIds: ["small"]).isEmpty)
        old.provider = .paypayCard; old.merchant = "New Store"
        #expect(try KMReconciliationReview.attention(statements: [old, small], unresolvedIds: ["small"]).isEmpty)
        var large = statement("large", amount: 10000)
        large.usedDate = KMDate(rawValue: "2026-10-04")
        #expect(try KMReconciliationReview.attention(statements: [small, large], unresolvedIds: ["large"]).isEmpty)
        large.usedDate = KMDate(rawValue: "2026-10-03"); large.provider = .smbcCard
        #expect(try KMReconciliationReview.attention(statements: [small, large], unresolvedIds: ["small", "large"]).isEmpty)
        let burst = ["a", "b", "c"].map { statement($0, amount: 1200) }
        let attention = try KMReconciliationReview.attention(statements: burst, unresolvedIds: ["b"])
        #expect(attention.first?.reasons == ["同じカードで同日に3件以上の決済"])
        #expect(attention.first?.key == "[\"b\",[\"同じカードで同日に3件以上の決済\"]]")
        #expect(try KMReconciliationReview.attention(statements: Array(burst.reversed()), unresolvedIds: ["b"]) == attention)
        #expect(try KMReconciliationReview.attention(statements: Array(burst.prefix(2)), unresolvedIds: ["b"]).isEmpty)
        #expect(try KMReconciliationReview.attention(statements: burst, unresolvedIds: []).isEmpty)
    }

    @Test func sharedAliasRemainsUntilLastSupportingManualDecisionIsUndone() throws {
        var state = service()
        state.transactions[0].payeeName = "Ledger Store"
        var other = state.transactions[0]; other.id = "t2"
        state.transactions.append(other); state.statements.append(statement("s2"))
        _ = try state.run(id: "one", at: now)
        let first = try state.sameExpense(runId: "one", statementId: "s", receiptId: "actual:t", at: now)
        _ = try state.run(id: "two", at: now)
        let second = try state.sameExpense(runId: "two", statementId: "s2", receiptId: "actual:t2", at: now)
        #expect(state.aliases.count == 1)
        #expect(state.aliases.first?.learnedBy?.hasPrefix(first.id + ":") == true)
        try state.undoSameExpense(first.id, at: now)
        #expect(state.aliases.count == 1)
        try state.undoSameExpense(second.id, at: now)
        #expect(state.aliases.isEmpty)
    }

    @Test func attentionUsesProviderHistoryAndOnlyUnresolvedPurchases() throws {
        var old = statement("old", amount: 1000, merchant: "既存店舗")
        old.usedDate = KMDate(rawValue: "2026-09-01")
        var small = statement("small", amount: 500, merchant: "新規店舗")
        small.provider = .paypay
        var large = statement("large", amount: 10_000)
        large.usedDate = KMDate(rawValue: "2026-10-03")
        let result = try KMReconciliationReview.attention(statements: [old, small, large], unresolvedIds: ["small", "large"])
        #expect(result[0].reasons == ["過去の明細にない加盟店で500円以下の決済", "500円以下の決済の後、2日以内に1万円以上の決済"])
        #expect(result[1].reasons == ["500円以下の決済の後、2日以内に1万円以上の決済"])
    }
}

import Foundation
import Testing
@testable import KakeiMatch

struct ReconciliationPresentationTests {
    private let day = KMDate(rawValue: "2026-10-01")
    private func statement(_ id: String = "s", kind: KMStatementTransaction.Kind = .purchase) -> KMStatementTransaction {
        .init(id: id, importId: "import", provider: .paypayCard, kind: kind, usedDate: day,
              merchant: "合成食堂", amountYen: 880, sourceFingerprint: id, duplicateOrdinal: 1)
    }
    private func run(_ ids: [(String, KMReconciliationStatementResult.Status)]) -> KMReconciliationRun {
        .init(runId: "run", createdAt: .distantPast, completedAt: .distantPast, ruleVersion: "test",
              candidates: [], statementResults: ids.map { .init(statementTransactionId: $0.0, status: $0.1, reasonCodes: []) }, receiptResults: [])
    }
    private func decision(_ id: String, kind: KMReconciliationResolution.Resolution = .sameExpense,
                          status: KMReconciliationResolution.Status = .applied) -> KMReconciliationResolution {
        .init(id: "decision-" + id, runId: "run", statementId: id, resolution: kind, source: .user,
              statementAmountYen: 880, status: status, createdAt: .distantPast, updatedAt: .distantPast)
    }
    @Test func emptyHasNoInventedResults() {
        let value = KMReconciliationPresentation.make(run: nil, resolutions: [], suspected: [], statements: [], receipts: [], transactions: [:])
        #expect(value.pending.isEmpty && value.matched.isEmpty && value.waiting == 0)
    }
    @Test func priorityAndIDOrderingMirrorPWALocalUI() {
        let statements = [statement("z"), statement("b"), statement("a"), statement("y")]
        let value = KMReconciliationPresentation.make(run: run([("z", .unmatchedStatement), ("b", .needsReview), ("a", .needsReview), ("y", .unmatchedStatement)]),
            resolutions: [], suspected: [], statements: statements, receipts: [], transactions: [:])
        #expect(value.pending.map(\.id) == ["a", "b", "y", "z"])
        #expect(value.needsReview == 2 && value.unmatched == 2)
    }
    @Test func decisionsAndFlagsAreExcludedRegardlessOfApplyStatus() {
        let rows = [statement("failed"), statement("ignored"), statement("suspected"), statement("new"), statement("registered")]
        let decisions = [decision("failed", status: .processing), decision("ignored", kind: .ignored), decision("registered", kind: .noReceipt)]
        let value = KMReconciliationPresentation.make(run: run(rows.map { ($0.id, .unmatchedStatement) }), resolutions: decisions,
            suspected: [.init(statementId: "suspected", markedAt: .distantPast)], statements: rows, receipts: [], transactions: [:])
        #expect(value.pending.map(\.id) == ["new"])
        #expect(value.failures.count == 1 && value.ignored.count == 1 && value.suspected.count == 1)
        // Unlike Data summary(), PWA counts only same_expense as matched, not newly registered expenses/transfers.
        #expect(value.matched.isEmpty)
        #expect(!value.isClear)
    }
    @Test func comparisonUsesCurrentActualValuesAndIntegerYen() {
        let s = statement()
        var t = KMTransaction(id: "t", date: KMDate(rawValue: "2026-09-29"), amountYen: -860, kind: .expense, accountId: "card")
        #expect(KMReconciliationPresentation.candidateReason(statement: s, transaction: t) == "金額が¥20違います")
        t.amountYen = -880
        #expect(KMReconciliationPresentation.candidateReason(statement: s, transaction: t) == "日付が2日ずれています")
        t.date = day
        #expect(KMReconciliationPresentation.candidateReason(statement: s, transaction: t) == "内容を確認してください")
    }
    @Test func refundOverridesCandidateReasonAndSplitCannotChangeAmount() {
        let t = KMTransaction(id: "t", date: day, amountYen: -860, kind: .expense, accountId: "card", isSplit: true)
        var r = run([("s", .needsReview)])
        r.candidates = [.init(statementTransactionId: "s", receiptId: "actual:t", rank: 1, score: 90,
                              amountDeltaYen: 20, dateDistanceDays: 0, merchantSimilarity: 1, reasons: [])]
        let split = KMReconciliationPresentation.make(run: r, resolutions: [], suspected: [], statements: [statement()], receipts: [], transactions: ["t": t])
        #expect(split.pending[0].reason == "金額が¥20違います")
        #expect(!split.pending[0].candidates[0].canConfirm)
        let refund = KMReconciliationPresentation.make(run: r, resolutions: [], suspected: [], statements: [statement(kind: .refund)], receipts: [], transactions: ["t": t])
        #expect(refund.pending[0].reason == "返金のため自動で処理できません")
    }
    @Test func historyOnlyOffersUndoWithSavedClearedState() {
        var d = decision("s")
        #expect(!KMReconciliationPresentation.canUndo(d))
        d.actualSnapshot = .init(date: day, amountYen: -860, accountId: "card", cleared: false)
        #expect(KMReconciliationPresentation.canUndo(d))
        #expect(KMReconciliationPresentation.method(d, receipt: nil) == "判定：手動で一致。記録の金額を¥880に合わせました")
        d.source = .automatic
        #expect(!KMReconciliationPresentation.canUndo(d))
        #expect(KMReconciliationPresentation.method(d, receipt: nil) == "判定：自動で一致")
    }
    @Test func clockAndFeedbackMatchPWAWithExplicitTokyoTime() {
        let instant = Date(timeIntervalSince1970: 1_792_121_400) // 2026-10-16 04:50 UTC
        let formatter = ISO8601DateFormatter()
        let tokyoMidnight = formatter.date(from: "2026-10-13T15:30:00Z")!
        #expect(KMReconciliationPresentation.timestamp(tokyoMidnight) == "10/14 00:30")
        #expect(!KMReconciliationPresentation.timestamp(instant).isEmpty)
        #expect(KMReconciliationPresentation.shortDay(day) == "10/1")
        #expect(KMReconciliationPresentation.runFeedback(before: 4, after: 6) == "照合しました。新しく2件が一致しました。")
        #expect(KMReconciliationPresentation.runFeedback(before: 4, after: 4) == "照合しました。新しく一致したものはありません。")
        #expect(KMReconciliationPresentation.importFeedback(.init(id: "i", added: 7, duplicates: 1, excluded: 2, duplicateRowsInFile: 0,
            needsReviewRows: [.init(rowNumber: 3, reason: "支払方法を確認してください")])) == "7件を取り込み、照合しました。重複 1件。対象外 2件、要確認 1件。3行目: 支払方法を確認してください")
    }
    @Test func categoryFrequencyStableRankAndHiddenGroups() {
        let rows = [KMCategory(id: "custom", name: "合成", usageCount: 3), .init(id: "fun", name: "趣味・娯楽"),
                    .init(id: "food", name: "食費"), .init(id: "hidden", name: "非表示", groupId: "hidden")]
        #expect(KMReconciliationPresentation.categoryChoices(rows, groups: [.init(id: "hidden", name: "非表示", hidden: true)]).map(\.id) == ["custom", "food", "fun"])
    }
}

@MainActor struct ReconciliationModelTests {
    @Test func fixtureSummaryMatchesPWAGoldenAndManualMatchUndo() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        #expect(model.errorMessage == nil)
        #expect(model.presentation.needsReview == 1 && model.presentation.unmatched == 2 && model.presentation.matched.count == 4 && model.presentation.waiting == 2)
        let row = try #require(model.presentation.pending.first)
        #expect(row.statement.merchant == "青空食堂" && row.reason == "金額が¥20違います")
        let candidate = try #require(row.candidates.first)
        await model.perform(.confirm(statement: row.id, receipt: candidate.receiptId), repositories: repositories)
        #expect(model.errorMessage == nil)
        #expect(model.presentation.needsReview == 0 && model.presentation.matched.count == 5)
        let manual = try #require(model.presentation.matched.first { $0.source == .user })
        #expect(try await repositories.transactions.transaction(id: candidate.transaction.id)?.amountYen == -880)
        await model.perform(.undo(manual.id), repositories: repositories)
        #expect(model.errorMessage == nil)
        #expect(model.presentation.needsReview == 1 && model.presentation.matched.count == 4)
        #expect(try await repositories.transactions.transaction(id: candidate.transaction.id)?.amountYen == -860)
    }
    @Test func rejectRerunsBeforeIgnoreAndNeverMutatesCandidate() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        let row = try #require(model.presentation.pending.first), candidate = try #require(row.candidates.first)
        await model.perform(.reject(statement: row.id, receipt: candidate.receiptId), repositories: repositories)
        #expect(model.errorMessage == nil)
        #expect(model.presentation.pending.first { $0.id == row.id }?.hasCandidates == false)
        await model.perform(.ignore(row.id), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.ignored.count == 1)
        #expect(try await repositories.transactions.transaction(id: candidate.transaction.id)?.amountYen == -860)
    }
    @Test func markAndClearReturnsToPendingWithoutAutomaticRegistration() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        let row = try #require(model.presentation.pending.first { $0.status == .unmatchedStatement })
        await model.perform(.suspect(row.id), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.suspected.count == 1 && model.presentation.unmatched == 1)
        await model.perform(.clearSuspected(row.id), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.suspected.isEmpty && model.presentation.unmatched == 2)
        #expect(try await repositories.reconciliation.resolutions().count == 4)
    }
    @Test func registerNoReceiptAndMissingCategoryDoesNotWrite() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        let row = try #require(model.presentation.pending.first { $0.status == .unmatchedStatement })
        await model.perform(.register(statement: row.id, category: "", destination: nil, excluded: false), repositories: repositories)
        #expect(model.errorMessage == "カテゴリを選択してください。")
        #expect(try await repositories.reconciliation.resolutions().count == 4)
        let category = try #require(model.categories.first)
        await model.perform(.register(statement: row.id, category: category.id, destination: nil, excluded: true), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.unmatched == 1)
        let resolution = try #require(try await repositories.reconciliation.resolutions().first { $0.statementId == row.id })
        let id = try #require(resolution.actualTransactionId)
        #expect(try await repositories.transactions.transaction(id: id)?.excludedFromSpending == true)
        // PWA does not add no_receipt decisions to the same_expense history.
        #expect(model.presentation.matched.count == 4)
    }
    @Test func staleCandidateCannotOverwriteEditedRecordAndRetryIsVisible() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        let row = try #require(model.presentation.pending.first), candidate = try #require(row.candidates.first)
        let original = candidate.transaction
        _ = try await repositories.transactions.saveManual(.init(kind: .expense, amountYen: 900, date: original.date,
            payeeName: original.payeeName ?? "", categoryId: try #require(original.categoryId), accountId: original.accountId,
            importedId: original.importedId ?? "test-edit"), id: original.id)
        await model.perform(.confirm(statement: row.id, receipt: candidate.receiptId), repositories: repositories)
        #expect(model.errorMessage == "照合の後に記録が変更されました。もう一度照合してから確認してください。")
        #expect(try await repositories.transactions.transaction(id: original.id)?.amountYen == -900)
        var decision = try #require(try await repositories.reconciliation.resolutions().first)
        decision.status = .failed
        try await repositories.reconciliation.saveResolution(decision)
        await model.load(repositories)
        #expect(model.presentation.failures.count == 1 && model.presentation.matched.count == 3)
        await model.perform(.retry(decision), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.failures.isEmpty && model.presentation.matched.count == 4)
    }
    @Test func csvImportExplicitlyRunsAndDuplicateReimportStillRuns() async throws {
        let repositories = try KMFixtureLoader.load(named: "empty")
        let model = KMReconciliationModel(); await model.load(repositories)
        let csv = Data(("利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日\n"
            + "2026/10/01,合成店,本人,PayPayクレジット,1回,1000,0,1000,1000,0,0,2026/11/27\n").utf8)
        await model.importCSV(csv, provider: .paypayCard, repositories: repositories)
        #expect(model.errorMessage == nil)
        #expect(model.statements.count == 1 && model.presentation.unmatched == 1)
        #expect(model.message == "1件を取り込み、照合しました。重複 0件。対象外 0件、要確認 0件。")
        let first = try #require(model.run?.runId)
        await model.importCSV(csv, provider: .paypayCard, repositories: repositories)
        #expect(model.errorMessage == nil && model.run?.runId != first)
        #expect(model.statements.count == 1 && model.imports.count == 1)
        #expect(model.message == "0件を取り込み、照合しました。重複 1件。対象外 0件、要確認 0件。")
        await model.importCSV(Data("不正なCSV".utf8), provider: .paypayCard, repositories: repositories)
        #expect(model.errorMessage != nil)
        #expect(model.statements.count == 1 && model.imports.count == 1)
    }
    @Test func rerunAndConfigurationFailureAreVisible() async throws {
        let model = KMReconciliationModel(); await model.load(nil)
        #expect(model.errorMessage != nil && !model.isLoading)
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        await model.load(repositories); await model.rerun(repositories)
        #expect(model.errorMessage == nil)
        #expect(model.runFeedback == "照合しました。新しく一致したものはありません。")
    }
}

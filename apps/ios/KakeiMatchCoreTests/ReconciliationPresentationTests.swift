import Foundation
import Testing
@testable import KakeiMatchCore

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


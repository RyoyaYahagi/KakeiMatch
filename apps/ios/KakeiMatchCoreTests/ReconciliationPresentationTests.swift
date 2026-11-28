import Foundation
import Testing
@testable import KakeiMatchCore

struct ReconciliationPresentationTests {
    private let day = KMDate(rawValue: "2026-10-01")
    private func statement(_ id: String = "s", kind: KMStatementTransaction.Kind = .purchase,
                           importId: String = "import", provider: KMStatementProvider = .paypayCard) -> KMStatementTransaction {
        .init(id: id, importId: importId, provider: provider, kind: kind, usedDate: day,
              merchant: "合成食堂", amountYen: 880, sourceFingerprint: id, duplicateOrdinal: 1)
    }
    private func run(_ ids: [(String, KMReconciliationStatementResult.Status)]) -> KMReconciliationRun {
        .init(runId: "run", createdAt: .distantPast, completedAt: .distantPast, ruleVersion: "test",
              candidates: [], statementResults: ids.map { .init(statementTransactionId: $0.0, status: $0.1, reasonCodes: []) }, receiptResults: [])
    }
    private func decision(_ id: String, kind: KMReconciliationResolution.Resolution = .sameExpense,
                          status: KMReconciliationResolution.Status = .applied,
                          undoRequestedAt: Date? = nil) -> KMReconciliationResolution {
        .init(id: "decision-" + id, runId: "run", statementId: id, resolution: kind, source: .user,
              statementAmountYen: 880, status: status, undoRequestedAt: undoRequestedAt,
              createdAt: .distantPast, updatedAt: .distantPast)
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
    @Test func importSummariesCountBreakdownAndTotalPerImport() throws {
        let earlier = Date(timeIntervalSince1970: 1_792_000_000)
        let later = Date(timeIntervalSince1970: 1_792_100_000)
        let imports: [KMReconciliationPresentation.ImportMetadata] = [
            .init(id: "imp-paypay", provider: .paypayCard, createdAt: earlier, csvNeedsReviewCount: 2),
            .init(id: "imp-rakuten", provider: .rakutenCard, createdAt: later, csvNeedsReviewCount: 0),
        ]
        let statements = [
            // PayPay import: 2 sameExpense, 1 noReceipt, 1 transfer, 1 ignored, 1 needsReview, 2 unmatchedStatement -> total 8
            statement("pp-match-1", importId: "imp-paypay", provider: .paypayCard),
            statement("pp-match-2", importId: "imp-paypay", provider: .paypayCard),
            statement("pp-norec", importId: "imp-paypay", provider: .paypayCard),
            statement("pp-xfer", importId: "imp-paypay", provider: .paypayCard),
            statement("pp-ign", importId: "imp-paypay", provider: .paypayCard),
            statement("pp-rev", importId: "imp-paypay", provider: .paypayCard),
            statement("pp-unm-1", importId: "imp-paypay", provider: .paypayCard),
            statement("pp-unm-2", importId: "imp-paypay", provider: .paypayCard),
            // Rakuten import: 1 sameExpense, 1 noReceipt, 0 unprocessed -> total 2
            statement("rk-match", importId: "imp-rakuten", provider: .rakutenCard),
            statement("rk-norec", importId: "imp-rakuten", provider: .rakutenCard),
        ]
        let decisions = [
            decision("pp-match-1", kind: .sameExpense),
            decision("pp-match-2", kind: .sameExpense),
            decision("pp-norec", kind: .noReceipt),
            decision("pp-xfer", kind: .transfer),
            decision("pp-ign", kind: .ignored),
            decision("rk-match", kind: .sameExpense),
            decision("rk-norec", kind: .noReceipt),
        ]
        let r = run([
            ("pp-rev", .needsReview),
            ("pp-unm-1", .unmatchedStatement),
            ("pp-unm-2", .unmatchedStatement),
        ])
        let presentation = KMReconciliationPresentation.make(
            run: r, resolutions: decisions, suspected: [], statements: statements,
            receipts: [], transactions: [:], imports: imports
        )

        // Unprocessed imports are ordered before fully processed imports.
        #expect(presentation.importSummaries.map(\.id) == ["imp-paypay", "imp-rakuten"])

        let paypay = try #require(presentation.importSummaries.first)
        #expect(paypay.provider == .paypayCard)
        #expect(paypay.total == 8)
        #expect(paypay.sameExpense == 2)
        #expect(paypay.noReceipt == 1)
        #expect(paypay.transfer == 1)
        #expect(paypay.ignored == 1)
        #expect(paypay.unprocessed == 3)
        #expect(paypay.processed == 5)
        #expect(paypay.sameExpense + paypay.noReceipt + paypay.transfer + paypay.ignored + paypay.unprocessed == paypay.total)
        #expect(paypay.processed + paypay.unprocessed == paypay.total)
        // CSV parse-time needsReviewRows are tracked separately without inflating unprocessed or total.
        #expect(paypay.csvNeedsReviewCount == 2)

        let rakuten = try #require(presentation.importSummaries.last)
        #expect(rakuten.provider == .rakutenCard)
        #expect(rakuten.total == 2)
        #expect(rakuten.sameExpense == 1)
        #expect(rakuten.noReceipt == 1)
        #expect(rakuten.transfer == 0)
        #expect(rakuten.ignored == 0)
        #expect(rakuten.unprocessed == 0)
        #expect(rakuten.processed == 2)
        #expect(rakuten.sameExpense + rakuten.noReceipt + rakuten.transfer + rakuten.ignored + rakuten.unprocessed == rakuten.total)
    }
    @Test func importSummariesTreatSuspectedFailedAndUndoPendingAsUnprocessedWithoutDoubleCounting() throws {
        let imports: [KMReconciliationPresentation.ImportMetadata] = [
            .init(id: "imp-smbc", provider: .smbcCard, createdAt: .distantPast, csvNeedsReviewCount: 1),
        ]
        let statements = [
            statement("s-applied", importId: "imp-smbc", provider: .smbcCard),
            statement("s-failed", importId: "imp-smbc", provider: .smbcCard),
            statement("s-undo", importId: "imp-smbc", provider: .smbcCard),
            statement("s-suspected", importId: "imp-smbc", provider: .smbcCard),
            statement("s-pending", importId: "imp-smbc", provider: .smbcCard),
        ]
        let decisions = [
            decision("s-applied", kind: .sameExpense, status: .applied),
            decision("s-failed", kind: .noReceipt, status: .failed),
            decision("s-undo", kind: .sameExpense, status: .applied, undoRequestedAt: Date(timeIntervalSince1970: 1_792_000_000)),
        ]
        let presentation = KMReconciliationPresentation.make(
            run: run([("s-pending", .unmatchedStatement)]),
            resolutions: decisions,
            suspected: [.init(statementId: "s-suspected", markedAt: .distantPast)],
            statements: statements, receipts: [], transactions: [:], imports: imports
        )
        let summary = try #require(presentation.importSummaries.first)
        #expect(summary.total == 5)
        #expect(summary.sameExpense == 1)
        #expect(summary.noReceipt == 0)
        #expect(summary.transfer == 0)
        #expect(summary.ignored == 0)
        #expect(summary.unprocessed == 4)
        #expect(summary.processed == 1)
        #expect(summary.sameExpense + summary.noReceipt + summary.transfer + summary.ignored + summary.unprocessed == summary.total)
        #expect(summary.csvNeedsReviewCount == 1)
    }
}

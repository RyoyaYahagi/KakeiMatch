import Foundation
import Testing
@testable import KakeiMatch

struct ReconciliationBadgeCountTests {
    private let now = Date(timeIntervalSince1970: 1_792_000_000)

    private func run(_ statuses: [(String, KMReconciliationStatementResult.Status)]) -> KMReconciliationRun {
        .init(runId: "run", createdAt: now, completedAt: now, ruleVersion: "1", candidates: [],
              statementResults: statuses.map { .init(statementTransactionId: $0.0, status: $0.1, matchedReceiptId: nil, reasonCodes: []) },
              receiptResults: [])
    }

    private func resolution(_ id: String, status: KMReconciliationResolution.Status) -> KMReconciliationResolution {
        .init(id: id, runId: "run", statementId: id, resolution: .noReceipt, source: .user, receiptId: nil,
              categoryId: nil, accountId: nil, statementAmountYen: 100, importedId: nil, status: status,
              actualTransactionId: nil, actualSnapshot: nil, statementSnapshot: nil, destinationAccountId: nil,
              excludedFromSpending: nil, undoRequestedAt: nil, errorCode: nil, createdAt: now, updatedAt: now)
    }

    @Test func countsNeedsReviewUnmatchedSuspectedAndEveryUnappliedStatus() {
        let fixture = run([("review", .needsReview), ("missing", .unmatchedStatement), ("matched", .matched)])
        let resolutions = [resolution("pending", status: .pending), resolution("processing", status: .processing),
                           resolution("failed", status: .failed), resolution("done", status: .applied)]
        let suspected = [KMSuspectedStatement(statementId: "suspected", markedAt: now)]
        #expect(KMReconciliationBadgeCount.calculate(run: fixture, resolutions: resolutions, suspected: suspected) == 6)
    }

    @Test func resolvedAndSuspectedStatementsAreNotCountedTwice() {
        let fixture = run([("review", .needsReview), ("missing", .unmatchedStatement)])
        let resolutions = [resolution("review", status: .pending)]
        let suspected = [KMSuspectedStatement(statementId: "missing", markedAt: now)]
        #expect(KMReconciliationBadgeCount.calculate(run: fixture, resolutions: resolutions, suspected: suspected) == 2)
    }

    @Test func missingRunAlwaysHasZeroBadge() {
        #expect(KMReconciliationBadgeCount.calculate(run: nil, resolutions: [resolution("failed", status: .failed)],
            suspected: [KMSuspectedStatement(statementId: "suspected", markedAt: now)]) == 0)
    }
}

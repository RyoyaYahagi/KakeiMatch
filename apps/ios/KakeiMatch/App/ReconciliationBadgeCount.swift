import Foundation

enum KMReconciliationBadgeCount {
    /// Mirrors PWA reconciliationState: pending statements, suspected statements, and unapplied decisions.
    static func calculate(run: KMReconciliationRun?, resolutions: [KMReconciliationResolution], suspected: [KMSuspectedStatement]) -> Int {
        guard let run else { return 0 }
        let resolvedStatementIds = Set(resolutions.map(\.statementId))
        let suspectedStatementIds = Set(suspected.map(\.statementId))
        let remaining = run.statementResults.filter {
            $0.status != .matched && !resolvedStatementIds.contains($0.statementTransactionId)
                && !suspectedStatementIds.contains($0.statementTransactionId)
        }
        let reviewCount = remaining.filter { $0.status == .needsReview }.count + suspected.count
        let unmatchedCount = remaining.filter { $0.status == .unmatchedStatement }.count
        let unappliedCount = resolutions.filter { $0.status != .applied }.count
        return reviewCount + unmatchedCount + unappliedCount
    }
}

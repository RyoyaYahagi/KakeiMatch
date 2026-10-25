import Foundation
import CryptoKit

/// Cross-import identity from local-statements.ts. Import account IDs never participate.
enum KMStatementDeduplication {
    struct Key: Hashable, Sendable {
        var provider: KMStatementProvider
        var identity: String
        var ordinal: Int?
    }
    static func key(_ row: KMStatementTransaction) -> Key {
        Key(provider: row.provider, identity: row.externalId ?? row.sourceFingerprint,
            ordinal: row.externalId?.isEmpty == false ? nil : row.duplicateOrdinal)
    }
    static func statementId(_ row: KMStatementTransaction) throws -> String {
        let key = key(row)
        let fields: [Any] = [key.provider.rawValue, key.identity, key.ordinal.map { $0 as Any } ?? NSNull()]
        let data = try JSONSerialization.data(withJSONObject: fields, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    static func sameExternalTransaction(_ lhs: KMStatementTransaction, _ rhs: KMStatementTransaction) -> Bool {
        lhs.kind == rhs.kind && lhs.usedDate == rhs.usedDate && lhs.usedTime == rhs.usedTime && lhs.merchant == rhs.merchant && lhs.amountYen == rhs.amountYen
    }
    /// Preserves the first (including legacy account-scoped) record and its ID/decisions.
    static func newRows(_ rows: [KMStatementTransaction], existing: [KMStatementTransaction]) throws -> (added: [KMStatementTransaction], duplicates: Int) {
        var known: [Key: KMStatementTransaction] = [:]
        for row in existing where known[key(row)] == nil { known[key(row)] = row }
        var added: [KMStatementTransaction] = [], duplicates = 0
        for row in rows {
            if let previous = known[key(row)] {
                if row.externalId?.isEmpty == false && !sameExternalTransaction(previous, row) {
                    throw KMReconciliationError("duplicate_external_id_conflict")
                }
                duplicates += 1
            } else { known[key(row)] = row; added.append(row) }
        }
        return (added, duplicates)
    }
}

struct KMStatementAttention: Equatable, Sendable {
    var statementId: String
    var reasons: [String]
    var key: String
}
struct KMReconciliationReviewSummary: Equatable, Sendable {
    var needsReview: Int
    var unmatchedStatement: Int
    var matched: Int
    var unmatchedReceipt: Int
    var failed: Int
    var suspected: Int
    var pendingCount: Int { needsReview + unmatchedStatement + failed + suspected }
}
enum KMReconciliationReview {
    /// PWA review summary: pending/processing/failed decisions are never counted as matched.
    static func summary(run: KMReconciliationRun, resolutions: [KMReconciliationResolution], rejections: [KMReconciliationPairRejection] = [], suspected: [KMSuspectedStatement] = []) -> KMReconciliationReviewSummary {
        let decided = Set(resolutions.map(\.statementId)), flagged = Set(suspected.map(\.statementId))
        let rejected = Set(rejections.map { KMReconciliationEngine.pairKey($0.statementId, $0.receiptId) })
        let remaining = run.statementResults.filter { !decided.contains($0.statementTransactionId) && !flagged.contains($0.statementTransactionId) }
        let review = remaining.filter { result in result.status == .needsReview && run.candidates.contains { $0.statementTransactionId == result.statementTransactionId && !rejected.contains(KMReconciliationEngine.pairKey($0.statementTransactionId, $0.receiptId)) } }.count
        let unmatched = remaining.filter { result in result.status == .unmatchedStatement || result.status == .needsReview && !run.candidates.contains { $0.statementTransactionId == result.statementTransactionId && !rejected.contains(KMReconciliationEngine.pairKey($0.statementTransactionId, $0.receiptId)) } }.count
        return .init(needsReview: review, unmatchedStatement: unmatched,
            matched: resolutions.filter { $0.status == .applied && $0.undoRequestedAt == nil && $0.resolution != .ignored }.count,
            unmatchedReceipt: run.receiptResults.filter { $0.status == .unmatchedReceipt }.count,
            failed: resolutions.filter { $0.status == .failed }.count, suspected: flagged.count)
    }
    // apps/pwa/src/reconciliation-review.ts — conservative CSV-only explanations, not fraud inference.
    static func attention(statements: [KMStatementTransaction], unresolvedIds: Set<String>) throws -> [KMStatementAttention] {
        let purchases = statements.filter { $0.kind == .purchase && $0.amountYen > 0 }
        return try purchases.filter { unresolvedIds.contains($0.id) }.compactMap { row in
            let history = purchases.filter { provider($0.provider) == provider(row.provider) }
            var reasons: [String] = []
            let small = row.amountYen <= 500
            if small && history.contains(where: { $0.usedDate < row.usedDate }) && !history.contains(where: {
                $0.usedDate < row.usedDate && KMReconciliationEngine.normalizeMerchant($0.merchant) == KMReconciliationEngine.normalizeMerchant(row.merchant)
            }) { reasons.append("過去の明細にない加盟店で500円以下の決済") }
            if [1, 2].contains(where: { days in history.contains { other in
                small ? other.amountYen >= 10_000 && other.usedDate == KMLocalReconciliation.shift(row.usedDate, days: days)
                : row.amountYen >= 10_000 && other.amountYen <= 500 && other.usedDate == KMLocalReconciliation.shift(row.usedDate, days: -days)
            } }) { reasons.append("500円以下の決済の後、2日以内に1万円以上の決済") }
            if history.filter({ $0.usedDate == row.usedDate }).count >= 3 { reasons.append("同じカードで同日に3件以上の決済") }
            guard !reasons.isEmpty else { return nil }
            let data = try JSONSerialization.data(withJSONObject: [row.id, reasons], options: [.withoutEscapingSlashes])
            return KMStatementAttention(statementId: row.id, reasons: reasons, key: String(decoding: data, as: UTF8.self))
        }
    }
    private static func provider(_ value: KMStatementProvider) -> KMStatementProvider { value == .paypay ? .paypayCard : value }
}

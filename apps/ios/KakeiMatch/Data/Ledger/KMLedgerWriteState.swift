import Foundation

/// Native tombstones retain the complete row (including projected split children), not just its ID.
/// Active repository projections never contain these rows. Restoring clears this marker with the same IDs.
struct KMTransactionTombstone: Codable, Equatable, Sendable {
    var transaction: KMTransaction
    var tombstone: Bool = true
}
struct KMSplitTombstone: Codable, Equatable, Sendable {
    var parentId: String
    var split: KMTransactionSplit
    var tombstone: Bool = true
}
struct KMTransactionDeletion: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var transactions: [KMTransaction]
    var receipts: [KMReceipt]
    var deletedAt: Date
    var undoUntil: Date
    var restoredAt: Date? = nil
}
struct KMLedgerEdit: Codable, Equatable, Sendable {
    var id: String
    var before: [KMTransaction]
    var after: [KMTransaction]
    var receiptBefore: KMReceipt? = nil
    var receiptAfter: KMReceipt? = nil
    var appliedAt: Date
}
/// Separate v3 singleton so v1/v2 service-state decoding remains unchanged.
struct KMLedgerWriteState: Codable, Equatable, Sendable {
    var tombstones: [KMTransactionTombstone] = []
    var splitTombstones: [KMSplitTombstone] = []
    var deletions: [KMTransactionDeletion] = []
    var edits: [KMLedgerEdit] = []
}

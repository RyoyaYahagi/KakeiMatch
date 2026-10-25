import Foundation

/// Schema v2 service-owned state, committed with the ledger snapshot, never with Cloud credentials.
struct KMServiceState: Codable, Equatable, Sendable {
    var reconciliation: KMLocalReconciliation?
    var observations: [KMCategoryLearningObservation] = []
    var occurrences: [KMRecurringProcessedOccurrence] = []
}

struct KMRecurringProcessedOccurrence: Codable, Equatable, Sendable {
    var scheduleId: String
    var date: KMDate
    var importedId: String
    var processedAt: Date
}

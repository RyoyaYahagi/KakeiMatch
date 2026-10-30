import Foundation

/// v4 state. These histories and dated non-display balance rows share the ledger's revision.
struct KMMasterWriteState: Codable, Equatable, Sendable {
    var balanceEntries: [KMBalanceEntry] = []
    var scheduleAudits: [KMRecurringScheduleAudit] = []
    var catchUps: [KMRecurringGeneration] = []
    var moneyForward: [KMMoneyForwardBatch] = []
    var moneyForwardRules = KMMoneyForwardMappings()
}
struct KMBalanceEntry: Codable, Equatable, Sendable {
    var id: String
    var accountId: String
    var date: KMDate
    var amountYen: Int
}
struct KMExternalTransactionInput: Equatable, Sendable {
    var accountId: String
    var date: KMDate
    var amountYen: Int
    var kind: KMTransactionKind
    var payeeName: String
    var memo: String? = nil
    var categoryId: String?
    var importedId: String
}
struct KMExternalTransactionResult: Equatable, Sendable {
    var transaction: KMTransaction
    var alreadyExisted: Bool
}
struct KMRecurringGeneration: Codable, Equatable, Sendable, Identifiable {
    enum Status: String, Codable, Sendable { case created, deleted, retained }
    struct Occurrence: Codable, Equatable, Sendable {
        var date: KMDate
        var transaction: KMTransaction
        var status: Status
    }
    var id: String
    var scheduleId: String
    var input: KMRecurringScheduleInput
    var occurrences: [Occurrence]
    var createdAt: Date
    var undoneAt: Date?
}

enum KMMoneyForwardAccountChoice: Codable, Equatable, Sendable { case existing(id: String), new(name: String), unset }
enum KMMoneyForwardRecordChoice: Codable, Equatable, Sendable { case separate, keep(transactionId: String) }
struct KMMoneyForwardMappings: Codable, Equatable, Sendable {
    var categories: [String: KMMoneyForwardCategoryChoice] = [:]
    var accounts: [String: KMMoneyForwardAccountChoice] = [:]
}
struct KMMoneyForwardPreview: Equatable, Sendable {
    enum Status: String, Sendable { case ready, duplicate, excluded, unresolved, review }
    var row: KMMoneyForwardRow
    var importedId: String
    var status: Status
    var candidates: [KMTransaction]
    var recordChoice: KMMoneyForwardRecordChoice?
}
struct KMMoneyForwardBatch: Codable, Equatable, Sendable, Identifiable {
    enum Status: String, Codable, Sendable { case completed, undone }
    enum RowStatus: String, Codable, Sendable { case created, duplicate, excluded, undone }
    struct Row: Codable, Equatable, Sendable {
        var row: KMMoneyForwardRow
        var importedId: String
        var status: RowStatus
        var recordChoice: KMMoneyForwardRecordChoice?
        var transaction: KMTransaction?
    }
    var id: String
    var createdAt: Date
    var updatedAt: Date
    var status: Status
    var mappings: KMMoneyForwardMappings
    var rows: [Row]
}

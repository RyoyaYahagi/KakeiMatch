import Foundation

// TS: src/lib/actual-browser-ledger.ts — RecurringSchedule
struct KMRecurringTransaction: Codable, Equatable, Sendable, Identifiable {
    enum Kind: String, Codable, Equatable, Sendable { case expense, income }
    enum Frequency: String, Codable, Equatable, Sendable { case monthly, weekly, yearly }

    var id: String
    var name: String
    var kind: Kind
    var amountYen: Int
    var categoryId: String
    var accountId: String
    var frequency: Frequency
    var startDate: KMDate
    var postsTransaction: Bool
    var nextDate: KMDate?
    var completed: Bool
    var editable: Bool
}

// TS: src/lib/recurring-schedule.ts — RecurringScheduleInput
struct KMRecurringScheduleInput: Codable, Equatable, Sendable {
    var name: String
    var kind: KMRecurringTransaction.Kind
    var amountYen: Int
    var categoryId: String
    var accountId: String
    var frequency: KMRecurringTransaction.Frequency
    var startDate: KMDate
    var postsTransaction: Bool
}

// TS: src/lib/recurring-schedule.ts — ScheduleAudit
struct KMRecurringScheduleAudit: Codable, Equatable, Sendable {
    enum TargetType: String, Codable, Equatable, Sendable { case schedule }
    enum Operation: String, Codable, Equatable, Sendable { case create, update, delete }
    enum Status: String, Codable, Equatable, Sendable { case pending, applied }

    var targetType: TargetType
    var operationId: String
    var operation: Operation
    var scheduleId: String?
    var input: KMRecurringScheduleInput?
    var status: Status
    var createdAt: Date
    var appliedAt: Date?
}

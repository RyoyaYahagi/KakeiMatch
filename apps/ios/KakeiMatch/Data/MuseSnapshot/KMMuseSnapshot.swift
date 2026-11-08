import Foundation

/// JSON written for Muse. The format is fixed by docs/MUSE_SNAPSHOT_SCHEMA_V1.md.
/// Optional values are encoded as JSON null instead of being omitted; use `encode`, not
/// `encodeIfPresent`, so readers can tell "no value" from a missing v1 field.
enum KMMuseSnapshotFormat {
    static let schemaVersion = 1
    static let kind = "kakeimatch-snapshot"
    static let timeZone = "Asia/Tokyo"
    static let currency = "JPY"

    /// ISO 8601 with the Asia/Tokyo offset, e.g. `2026-11-08T09:00:00+09:00`.
    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(identifier: timeZone)!
        return formatter.string(from: date)
    }
}

struct KMMuseSnapshot: Encodable, Equatable, Sendable {
    var schemaVersion = KMMuseSnapshotFormat.schemaVersion
    var kind = KMMuseSnapshotFormat.kind
    var generatedAt: String
    var timeZone = KMMuseSnapshotFormat.timeZone
    var currency = KMMuseSnapshotFormat.currency
    var appVersion: String?
    var range: KMMuseSnapshotRange
    var accounts: [KMMuseSnapshotAccount]
    var transactions: [KMMuseSnapshotTransaction]
    var monthly: [KMMuseSnapshotMonthly]

    enum CodingKeys: String, CodingKey {
        case schemaVersion, kind, generatedAt, timeZone, currency, appVersion, range, accounts, transactions, monthly
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(kind, forKey: .kind)
        try container.encode(generatedAt, forKey: .generatedAt)
        try container.encode(timeZone, forKey: .timeZone)
        try container.encode(currency, forKey: .currency)
        try container.encode(appVersion, forKey: .appVersion)
        try container.encode(range, forKey: .range)
        try container.encode(accounts, forKey: .accounts)
        try container.encode(transactions, forKey: .transactions)
        try container.encode(monthly, forKey: .monthly)
    }
}

extension KMMuseSnapshot {
    /// Sorted keys are not required by the format; they keep test and diff output stable.
    func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

struct KMMuseSnapshotRange: Encodable, Equatable, Sendable {
    var fromMonth: String
    var toMonth: String

    enum CodingKeys: String, CodingKey { case fromMonth, toMonth }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(fromMonth, forKey: .fromMonth)
        try container.encode(toMonth, forKey: .toMonth)
    }
}

struct KMMuseSnapshotAccount: Encodable, Equatable, Sendable {
    var id: String
    var name: String
    var type: String
    var closed: Bool
    var offBudget: Bool
    var balanceYen: Int

    enum CodingKeys: String, CodingKey { case id, name, type, closed, offBudget, balanceYen }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(type, forKey: .type)
        try container.encode(closed, forKey: .closed)
        try container.encode(offBudget, forKey: .offBudget)
        try container.encode(balanceYen, forKey: .balanceYen)
    }
}

struct KMMuseSnapshotTransaction: Encodable, Equatable, Sendable {
    var id: String
    var date: String
    var amountYen: Int
    var kind: String
    var accountId: String
    var categoryId: String?
    var categoryName: String?
    var payeeName: String?
    var memo: String?
    var transferAccountId: String?
    var excludedFromSpending: Bool
    var splits: [KMMuseSnapshotSplit]

    enum CodingKeys: String, CodingKey {
        case id, date, amountYen, kind, accountId, categoryId, categoryName, payeeName, memo
        case transferAccountId, excludedFromSpending, splits
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(date, forKey: .date)
        try container.encode(amountYen, forKey: .amountYen)
        try container.encode(kind, forKey: .kind)
        try container.encode(accountId, forKey: .accountId)
        try container.encode(categoryId, forKey: .categoryId)
        try container.encode(categoryName, forKey: .categoryName)
        try container.encode(payeeName, forKey: .payeeName)
        try container.encode(memo, forKey: .memo)
        try container.encode(transferAccountId, forKey: .transferAccountId)
        try container.encode(excludedFromSpending, forKey: .excludedFromSpending)
        try container.encode(splits, forKey: .splits)
    }
}

struct KMMuseSnapshotSplit: Encodable, Equatable, Sendable {
    var id: String
    var categoryId: String?
    var categoryName: String?
    var amountYen: Int
    var payeeName: String?
    var memo: String?

    enum CodingKeys: String, CodingKey { case id, categoryId, categoryName, amountYen, payeeName, memo }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(categoryId, forKey: .categoryId)
        try container.encode(categoryName, forKey: .categoryName)
        try container.encode(amountYen, forKey: .amountYen)
        try container.encode(payeeName, forKey: .payeeName)
        try container.encode(memo, forKey: .memo)
    }
}

struct KMMuseSnapshotMonthly: Encodable, Equatable, Sendable {
    var month: String
    var incomeYen: Int
    var expenseYen: Int
    var balanceYen: Int
    var byCategory: [KMMuseSnapshotCategory]

    enum CodingKeys: String, CodingKey { case month, incomeYen, expenseYen, balanceYen, byCategory }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(month, forKey: .month)
        try container.encode(incomeYen, forKey: .incomeYen)
        try container.encode(expenseYen, forKey: .expenseYen)
        try container.encode(balanceYen, forKey: .balanceYen)
        try container.encode(byCategory, forKey: .byCategory)
    }
}

struct KMMuseSnapshotCategory: Encodable, Equatable, Sendable {
    var categoryId: String?
    var categoryName: String
    var amountYen: Int

    enum CodingKeys: String, CodingKey { case categoryId, categoryName, amountYen }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(categoryId, forKey: .categoryId)
        try container.encode(categoryName, forKey: .categoryName)
        try container.encode(amountYen, forKey: .amountYen)
    }
}

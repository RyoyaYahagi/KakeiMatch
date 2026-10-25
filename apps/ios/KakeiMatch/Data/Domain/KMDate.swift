import Foundation

// TS: src/lib/local-backup-format.ts date / apps/pwa/src/local-monthly-dashboard.ts monthEnd.
/// A Gregorian calendar day in Asia/Tokyo, never an instant or a device-local Date.
struct KMDate: RawRepresentable, Codable, Hashable, Comparable, Sendable, CustomStringConvertible {
    let rawValue: String
    init(rawValue: String) { precondition(Self.isValid(rawValue), "Invalid calendar day"); self.rawValue = rawValue }
    init(_ value: String) throws {
        guard Self.isValid(value) else { throw KMDataError.invalidData("日付が不正です。") }
        rawValue = value
    }
    init(instant: Date) {
        let parts = Self.calendar.dateComponents([.year, .month, .day], from: instant)
        rawValue = String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }
    var yearMonth: KMYearMonth { KMYearMonth(rawValue: String(rawValue.prefix(7))) }
    var description: String { rawValue }
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
    init(from decoder: any Decoder) throws { try self.init(decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: any Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
    private static func isValid(_ value: String) -> Bool {
        guard value.utf8.count == 10, value.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil,
              let month = try? KMYearMonth(String(value.prefix(7))), let day = Int(value.suffix(2)) else { return false }
        return (1...month.daysInMonth).contains(day)
    }
}

// TS: src/lib/actual-ledger.ts ActualMonthlySummary.yearMonth / local-monthly-dashboard.ts shiftMonth.
struct KMYearMonth: RawRepresentable, Codable, Hashable, Comparable, Sendable, CustomStringConvertible {
    let rawValue: String
    init(rawValue: String) { precondition(Self.isValid(rawValue), "Invalid year-month"); self.rawValue = rawValue }
    init(_ value: String) throws {
        guard Self.isValid(value) else { throw KMDataError.invalidData("年月が不正です。") }
        rawValue = value
    }
    var year: Int { Int(rawValue.prefix(4))! }
    var month: Int { Int(rawValue.suffix(2))! }
    var daysInMonth: Int {
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    }
    var firstDay: KMDate { KMDate(rawValue: rawValue + "-01") }
    var lastDay: KMDate { KMDate(rawValue: rawValue + String(format: "-%02d", daysInMonth)) }
    func shifted(by offset: Int) -> Self {
        let (total, overflow) = (year * 12 + month - 1).addingReportingOverflow(offset)
        guard !overflow, total >= 12, total < 120000 else { return self }
        return Self(rawValue: String(format: "%04d-%02d", total / 12, total % 12 + 1))
    }
    var description: String { rawValue }
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
    init(from decoder: any Decoder) throws { try self.init(decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: any Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
    private static func isValid(_ value: String) -> Bool {
        value.range(of: #"^[0-9]{4}-(0[1-9]|1[0-2])$"#, options: .regularExpression) != nil && value.prefix(4) != "0000"
    }
}

// Swift boundary errors; no TS serialized equivalent (repository/service failures).
enum KMDataError: Error, Equatable, LocalizedError, Sendable {
    case invalidData(String), amountOverflow, notFound(String), unsupported(String)
    var errorDescription: String? {
        switch self {
        case .invalidData(let message), .notFound(let message), .unsupported(let message): message
        case .amountOverflow: "金額を安全に計算できません。"
        }
    }
}

/// Preserve the PWA Number.isSafeInteger boundary even on 64-bit Swift Int.
enum KMYen {
    static let maxSafe = 9_007_199_254_740_991
    static func checked(_ amount: Int) throws -> Int {
        guard amount >= -maxSafe, amount <= maxSafe else { throw KMDataError.amountOverflow }
        return amount
    }
    static func add(_ lhs: Int, _ rhs: Int) throws -> Int {
        _ = try checked(lhs); _ = try checked(rhs)
        let (sum, overflow) = lhs.addingReportingOverflow(rhs)
        guard !overflow else { throw KMDataError.amountOverflow }
        return try checked(sum)
    }
}

/// PWA timestamps accept ISO8601 offsets, with or without fractional seconds. Never use JSONDecoder's numeric Date default.
enum KMJSON {
    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: value) else { throw KMDataError.invalidData("日時が不正です。") }
            return date
        }
        return decoder
    }
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { value, encoder in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: value))
        }
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

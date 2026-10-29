import Foundation

/// Recurring schedule labels shared by the list, detail, and editor.
enum KMRecurringPresentation {
    static func frequency(_ value: KMRecurringTransaction.Frequency) -> String {
        switch value {
        case .monthly: "毎月"
        case .weekly: "毎週"
        case .yearly: "毎年"
        }
    }

    static func timing(_ schedule: KMRecurringTransaction) -> String {
        let components = schedule.startDate.rawValue.split(separator: "-").compactMap { Int($0) }
        guard components.count == 3 else { return frequency(schedule.frequency) }
        switch schedule.frequency {
        case .monthly: return "毎月\(components[2])日"
        case .yearly: return "毎年\(components[1])月\(components[2])日"
        case .weekly:
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(secondsFromGMT: 0)!
            let date = calendar.date(from: DateComponents(year: components[0], month: components[1], day: components[2]))
            let weekday = date.map { ["日", "月", "火", "水", "木", "金", "土"][calendar.component(.weekday, from: $0) - 1] } ?? ""
            return "毎週\(weekday)曜日"
        }
    }

    static func amount(_ yen: Int, kind: KMRecurringTransaction.Kind) -> String {
        "\(kind == .income ? "+" : "−")\(KMAmountFormatter.yen(yen))"
    }
}

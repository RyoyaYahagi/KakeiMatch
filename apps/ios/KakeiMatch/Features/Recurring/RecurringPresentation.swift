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

    static func catchUpPrompt(_ plan: KMRecurringCatchUpPlan) -> String {
        guard let first = plan.startDate, let last = plan.endDate else { return "" }
        return "\(first.rawValue)〜\(last.rawValue)の未登録分があります。\n\(grouped(plan.dates.count))件 · 合計 \(yen(plan.totalAmountYen))"
    }

    static func historySummary(_ generation: KMRecurringGeneration) -> String {
        guard let first = generation.occurrences.first?.date, let last = generation.occurrences.last?.date else { return "" }
        let total = Decimal(generation.input.amountYen) * Decimal(generation.occurrences.count)
        return "\(first.rawValue)〜\(last.rawValue) · \(grouped(generation.occurrences.count))件 · \(yen(total))"
    }

    static func activeOccurrences(_ generation: KMRecurringGeneration) -> [KMRecurringGeneration.Occurrence] {
        generation.occurrences.filter { $0.status == .created }
    }

    static func undoLabel(_ generation: KMRecurringGeneration) -> String? {
        let remaining = activeOccurrences(generation).count
        guard remaining > 0 else { return nil }
        return remaining == generation.occurrences.count ? "この回を一括で取り消す" : "残りを一括で取り消す"
    }

    static func occurrenceStatus(_ status: KMRecurringGeneration.Status) -> String? {
        switch status {
        case .created: nil
        case .deleted: "削除済み"
        case .retained: "編集済みのため残しました"
        }
    }

    static func selectedDeletionMessage(dates: [KMDate], amountYen: Int) -> String {
        guard let first = dates.first, let last = dates.last else { return "" }
        return "\(first.rawValue)〜\(last.rawValue)の\(grouped(dates.count))件（\(yen(Decimal(amountYen) * Decimal(dates.count)))）を削除しますか？編集済みの取引は削除できません。"
    }

    private static func yen(_ amount: Decimal) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.numberStyle = .decimal
        return "¥\(formatter.string(from: NSDecimalNumber(decimal: amount)) ?? NSDecimalNumber(decimal: amount).stringValue)"
    }

    private static func grouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}

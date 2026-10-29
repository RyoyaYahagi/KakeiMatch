import Foundation

struct KMRecurringCatchUpPlan: Equatable, Sendable {
    var dates: [KMDate]
    var startDate: KMDate? { dates.first }
    var endDate: KMDate? { dates.last }
    /// Catch-up totals mirror TS BigInt and may exceed Number's safe-integer range.
    var totalAmountYen: Decimal
}

/// Calendar-date recurrence and catch-up planning. Persistence, locking, and
/// native ledger writes remain the caller's responsibility.
enum KMRecurringScheduleService {
    static let maximumBatchOccurrences = 5_000

    static func occurrenceDates(input: KMRecurringScheduleInput, through: KMDate) -> [KMDate] {
        guard input.startDate <= through else { return [] }
        let start = input.startDate
        let year = Int(start.rawValue.prefix(4))!, month = Int(start.rawValue.dropFirst(5).prefix(2))!, day = Int(start.rawValue.suffix(2))!
        switch input.frequency {
        case .weekly:
            var dates: [KMDate] = []
            var dayOffset = 0
            while true {
                let (offset, overflow) = dayOffset.addingReportingOverflow(7)
                guard !overflow, let candidate = shifting(start, days: dayOffset), candidate <= through else { break }
                dates.append(candidate)
                dayOffset = offset
            }
            return dates
        case .monthly:
            var dates: [KMDate] = []
            var monthOffset = 0
            while true {
                let absolute = year * 12 + month - 1 + monthOffset
                guard absolute >= 12, absolute < 120_000 else { break }
                let currentYear = absolute / 12, currentMonth = absolute % 12 + 1
                if day <= daysInMonth(year: currentYear, month: currentMonth),
                   let candidate = try? KMDate(String(format: "%04d-%02d-%02d", currentYear, currentMonth, day)) {
                    if candidate > through { break }
                    dates.append(candidate)
                }
                monthOffset += 1
            }
            return dates
        case .yearly:
            var dates: [KMDate] = []
            var currentYear = year
            while currentYear <= 9999 {
                if day <= daysInMonth(year: currentYear, month: month),
                   let candidate = try? KMDate(String(format: "%04d-%02d-%02d", currentYear, month, day)) {
                    if candidate > through { break }
                    dates.append(candidate)
                }
                guard currentYear < 9999 else { break }
                currentYear += 1
            }
            return dates
        }
    }

    static func currentMonthDates(in plan: KMRecurringCatchUpPlan, month: KMYearMonth) -> [KMDate] {
        plan.dates.filter { $0.yearMonth == month }
    }

    static func nextOccurrence(input: KMRecurringScheduleInput, onOrAfter today: KMDate) -> KMDate? {
        let year = min(today.yearMonth.year + 8, 9999)
        guard let through = try? KMDate(String(format: "%04d-12-31", year)) else { return nil }
        return occurrenceDates(input: input, through: through).first { $0 >= today }
    }

    /// Dates already consumed by an audit, stable imported ID, or native schedule row are never recreated.
    static func missingOccurrences(input: KMRecurringScheduleInput, scheduleId: String, through: KMDate,
                                   auditedDates: Set<KMDate> = [], importedIds: Set<String> = [],
                                   nativeScheduleDates: Set<KMDate> = []) -> [KMDate] {
        occurrenceDates(input: input, through: through).filter { date in
            !auditedDates.contains(date) && !nativeScheduleDates.contains(date) &&
                !importedIds.contains(importedId(scheduleId: scheduleId, date: date))
        }
    }

    static func validatedInput(_ input: KMRecurringScheduleInput) throws -> KMRecurringScheduleInput {
        let name = KMJSString.trim(input.name)
        guard !name.isEmpty, name.utf16.count <= 200, input.amountYen > 0, KMMonthlyBudgetSettings.validAmount(input.amountYen),
              KMMonthlyBudgetSettings.validIdentifier(input.categoryId), KMMonthlyBudgetSettings.validIdentifier(input.accountId) else {
            throw KMDataError.invalidData("名前・金額・日付・カテゴリ・口座を確認してください。")
        }
        return KMRecurringScheduleInput(name: name, kind: input.kind, amountYen: input.amountYen,
            categoryId: input.categoryId, accountId: input.accountId, frequency: input.frequency,
            startDate: input.startDate, postsTransaction: input.postsTransaction)
    }

    static func validateMastersAndUniqueness(input: KMRecurringScheduleInput, editingId: String? = nil,
                                            categories: [KMCategory], accounts: [KMAccount],
                                            schedules: [KMRecurringTransaction]) throws {
        let value = try validatedInput(input)
        guard categories.contains(where: { $0.id == value.categoryId && !$0.hidden && $0.isIncome == (value.kind == .income) }) else {
            throw KMDataError.invalidData("種類に合う利用中のカテゴリを選んでください。")
        }
        guard accounts.contains(where: { $0.id == value.accountId && !$0.closed }) else {
            throw KMDataError.invalidData("利用中の口座を選んでください。")
        }
        guard !schedules.contains(where: { $0.id != editingId && KMJSString.trim($0.name) == value.name }) else {
            throw KMDataError.invalidData("同じ名前の定期登録があります。既存の定期登録を編集してください。")
        }
    }

    static func preview(input: KMRecurringScheduleInput, scheduleId: String, through: KMDate,
                        auditedDates: Set<KMDate> = [], importedIds: Set<String> = [],
                        nativeScheduleDates: Set<KMDate> = []) throws -> KMRecurringCatchUpPlan {
        let validated = try validatedInput(input)
        let dates = missingOccurrences(input: validated, scheduleId: scheduleId, through: through,
            auditedDates: auditedDates, importedIds: importedIds, nativeScheduleDates: nativeScheduleDates)
        let total = Decimal(validated.amountYen) * Decimal(dates.count)
        return KMRecurringCatchUpPlan(dates: dates, totalAmountYen: total)
    }

    /// Validates a UI-selected catch-up subset against the latest due occurrence list.
    static func selectedOccurrences(_ selected: [KMDate], input: KMRecurringScheduleInput, through: KMDate,
                                    alreadyConsumed: Set<KMDate> = []) throws -> [KMDate] {
        let validated = try validatedInput(input)
        let allowed = Set(occurrenceDates(input: validated, through: through))
        guard Set(selected).count == selected.count, selected.allSatisfy(allowed.contains) else {
            throw KMDataError.invalidData("定期登録の対象日が変わりました。画面を更新してください。")
        }
        // PWA validates against due dates first, then skips consumed dates idempotently.
        // findMissingOccurrences preserves the selected order, including chunk boundaries.
        return selected.filter { !alreadyConsumed.contains($0) }
    }

    static func importedId(scheduleId: String, date: KMDate) -> String {
        "kakeimatch:schedule:\(scheduleId):\(date.rawValue)"
    }

    static func batches(_ dates: [KMDate]) -> [[KMDate]] {
        stride(from: 0, to: dates.count, by: maximumBatchOccurrences).map {
            Array(dates[$0..<min($0 + maximumBatchOccurrences, dates.count)])
        }
    }

    private static func daysInMonth(year: Int, month: Int) -> Int {
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    }

    private static func shifting(_ date: KMDate, days: Int) -> KMDate? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let parts = date.rawValue.split(separator: "-").compactMap { Int($0) }
        var components = DateComponents(); components.calendar = calendar; components.timeZone = calendar.timeZone
        components.year = parts[0]; components.month = parts[1]; components.day = parts[2]
        guard let start = calendar.date(from: components), let shifted = calendar.date(byAdding: .day, value: days, to: start) else { return nil }
        let result = calendar.dateComponents([.year, .month, .day], from: shifted)
        guard let year = result.year, (1...9999).contains(year), let month = result.month, let day = result.day else { return nil }
        return try? KMDate(String(format: "%04d-%02d-%02d", year, month, day))
    }
}

import Foundation
import Testing
@testable import KakeiMatch

struct RecurringScheduleServiceTests {
    private func date(_ value: String) -> KMDate { KMDate(rawValue: value) }
    private func input(_ frequency: KMRecurringTransaction.Frequency, start: String, amount: Int = 50_000) -> KMRecurringScheduleInput {
        KMRecurringScheduleInput(name: "Synthetic recurring", kind: .expense, amountYen: amount, categoryId: "rent", accountId: "bank",
                                 frequency: frequency, startDate: date(start), postsTransaction: true)
    }

    @Test func followsWeeklyMonthlyAndYearlyCalendarSemantics() {
        #expect(KMRecurringScheduleService.occurrenceDates(input: input(.monthly, start: "2026-01-31"), through: date("2026-05-31")).map(\.rawValue) == ["2026-01-31", "2026-03-31", "2026-05-31"])
        #expect(KMRecurringScheduleService.occurrenceDates(input: input(.yearly, start: "2024-02-29"), through: date("2032-03-01")).map(\.rawValue) == ["2024-02-29", "2028-02-29", "2032-02-29"])
        #expect(KMRecurringScheduleService.occurrenceDates(input: input(.weekly, start: "2026-10-02"), through: date("2026-10-23")).map(\.rawValue) == ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23"])
        #expect(KMRecurringScheduleService.occurrenceDates(input: input(.weekly, start: "1900-01-06"), through: date("2026-10-01")).count == 6_613)
    }

    @Test func plansOnlyMissingOccurrencesAndStableImportedIds() throws {
        let schedule = input(.weekly, start: "2026-10-01")
        let plan = try KMRecurringScheduleService.preview(input: schedule, scheduleId: "rent-id", through: date("2026-10-15"),
            auditedDates: [date("2026-10-01")], importedIds: ["kakeimatch:schedule:rent-id:2026-10-08"])
        #expect(plan.dates.map(\.rawValue) == ["2026-10-15"])
        #expect(plan.startDate == date("2026-10-15"))
        #expect(plan.endDate == date("2026-10-15"))
        #expect(plan.totalAmountYen == 50_000)
        #expect(KMRecurringScheduleService.importedId(scheduleId: "rent-id", date: date("2026-10-15")) == "kakeimatch:schedule:rent-id:2026-10-15")
    }

    @Test func validatesSelectedDatesAndChunksAtAuditLimit() throws {
        let schedule = input(.weekly, start: "2026-10-01")
        #expect(try KMRecurringScheduleService.selectedOccurrences([date("2026-10-15"), date("2026-10-08")], input: schedule, through: date("2026-10-15")).map(\.rawValue) == ["2026-10-15", "2026-10-08"])
        #expect(try KMRecurringScheduleService.selectedOccurrences([date("2026-10-08")], input: schedule,
            through: date("2026-10-15"), alreadyConsumed: [date("2026-10-08")]).isEmpty)
        #expect(throws: (any Error).self) { try KMRecurringScheduleService.selectedOccurrences([date("2026-10-08"), date("2026-10-08")], input: schedule, through: date("2026-10-15")) }
        #expect(throws: (any Error).self) { try KMRecurringScheduleService.selectedOccurrences([date("2026-10-22")], input: schedule, through: date("2026-10-15")) }
        let dates = KMRecurringScheduleService.occurrenceDates(input: input(.weekly, start: "1900-01-06"), through: date("1996-01-01"))
        #expect(dates.count > 5_000)
        #expect(KMRecurringScheduleService.batches(Array(dates.prefix(5_001))).map(\.count) == [5_000, 1])
    }

    @Test func trimsScheduleNamesAndRejectsInvalidAmounts() throws {
        var schedule = input(.monthly, start: "2026-10-01")
        schedule.name = "  Synthetic rent  "
        #expect(try KMRecurringScheduleService.validatedInput(schedule).name == "Synthetic rent")
        schedule.name = "\u{FEFF}Rent\u{FEFF}"
        #expect(try KMRecurringScheduleService.validatedInput(schedule).name == "Rent")
        schedule.name = "\u{0085}Rent\u{0085}"
        #expect(try KMRecurringScheduleService.validatedInput(schedule).name == "\u{0085}Rent\u{0085}")
        schedule.amountYen = 0
        #expect(throws: (any Error).self) { try KMRecurringScheduleService.validatedInput(schedule) }
    }

    @Test func masterValidationRejectsHiddenWrongKindClosedAndDuplicateNames() throws {
        let value = input(.monthly, start: "2026-10-01")
        let categories = [KMCategory(id: "rent", name: "Rent")]
        let accounts = [KMAccount(id: "bank", name: "Bank")]
        let existing = KMRecurringTransaction(id: "existing", name: " Synthetic recurring ", kind: .expense,
            amountYen: 1, categoryId: "rent", accountId: "bank", frequency: .monthly, startDate: value.startDate,
            postsTransaction: true, completed: false, editable: true)
        try KMRecurringScheduleService.validateMastersAndUniqueness(input: value, categories: categories, accounts: accounts, schedules: [])
        try KMRecurringScheduleService.validateMastersAndUniqueness(input: value, editingId: "existing", categories: categories, accounts: accounts, schedules: [existing])
        #expect(throws: (any Error).self) { try KMRecurringScheduleService.validateMastersAndUniqueness(input: value,
            categories: categories, accounts: accounts, schedules: [existing]) }
        #expect(throws: (any Error).self) { try KMRecurringScheduleService.validateMastersAndUniqueness(input: value,
            categories: [.init(id: "rent", name: "Rent", hidden: true)], accounts: accounts, schedules: []) }
        #expect(throws: (any Error).self) { try KMRecurringScheduleService.validateMastersAndUniqueness(input: value,
            categories: [.init(id: "rent", name: "Rent", isIncome: true)], accounts: accounts, schedules: []) }
        #expect(throws: (any Error).self) { try KMRecurringScheduleService.validateMastersAndUniqueness(input: value,
            categories: categories, accounts: [.init(id: "bank", name: "Bank", closed: true)], schedules: []) }
    }

    @Test func validatesNameLengthInJavaScriptUtf16Units() throws {
        var schedule = input(.monthly, start: "2026-10-01")
        schedule.name = String(repeating: "😀", count: 100)
        #expect(try KMRecurringScheduleService.validatedInput(schedule).name.utf16.count == 200)
        schedule.name = String(repeating: "😀", count: 101)
        #expect(throws: (any Error).self) { try KMRecurringScheduleService.validatedInput(schedule) }
    }

    @Test func keepsCatchUpBigIntegerTotalExactAndIncludesTokyoDayFromInstant() throws {
        let maximum = input(.weekly, start: "2026-10-01", amount: KMYen.maxSafe)
        let plan = try KMRecurringScheduleService.preview(input: maximum, scheduleId: "rent", through: date("2026-10-08"))
        #expect(plan.totalAmountYen == Decimal(KMYen.maxSafe) * Decimal(2))
        #expect(KMDate(instant: ISO8601DateFormatter().date(from: "2026-10-04T12:00:00+09:00")!).rawValue == "2026-10-04")
    }
}

import Testing
@testable import KakeiMatch

struct RecurringPresentationTests {
    @Test func labelsFrequencyAndAmountByScheduleKind() {
        #expect(KMRecurringPresentation.frequency(.monthly) == "毎月")
        #expect(KMRecurringPresentation.frequency(.weekly) == "毎週")
        #expect(KMRecurringPresentation.frequency(.yearly) == "毎年")
        #expect(KMRecurringPresentation.amount(12_300, kind: .expense) == "−¥12,300")
        #expect(KMRecurringPresentation.amount(12_300, kind: .income) == "+¥12,300")
    }

    @Test func derivesCalendarTimingFromTokyoDateOnlyValue() {
        func schedule(_ frequency: KMRecurringTransaction.Frequency, _ date: String) -> KMRecurringTransaction {
            KMRecurringTransaction(id: "synthetic", name: "合成予定", kind: .expense, amountYen: 100,
                categoryId: "category", accountId: "account", frequency: frequency, startDate: KMDate(rawValue: date),
                postsTransaction: true, nextDate: nil, completed: false, editable: true)
        }
        #expect(KMRecurringPresentation.timing(schedule(.monthly, "2026-10-14")) == "毎月14日")
        #expect(KMRecurringPresentation.timing(schedule(.yearly, "2026-10-14")) == "毎年10月14日")
        #expect(KMRecurringPresentation.timing(schedule(.weekly, "2026-10-14")) == "毎週水曜日")
    }
}

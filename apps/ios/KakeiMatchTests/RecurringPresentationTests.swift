import Foundation
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

    @Test func describesCatchUpHistoryAndRemainingUndoState() {
        let input = KMRecurringScheduleInput(name: "合成予定", kind: .expense, amountYen: 1_700, categoryId: "food", accountId: "cash",
            frequency: .monthly, startDate: KMDate(rawValue: "2026-07-01"), postsTransaction: true)
        let first = KMRecurringGeneration.Occurrence(date: KMDate(rawValue: "2026-07-01"), transaction: transaction("one"), status: .deleted)
        let second = KMRecurringGeneration.Occurrence(date: KMDate(rawValue: "2026-10-01"), transaction: transaction("two"), status: .created)
        let generation = KMRecurringGeneration(id: "generation", scheduleId: "schedule", input: input,
            occurrences: [first, second], createdAt: Date(timeIntervalSince1970: 0), undoneAt: nil)

        #expect(KMRecurringPresentation.historySummary(generation) == "2026-07-01〜2026-10-01 · 2件 · ¥3,400")
        #expect(KMRecurringPresentation.occurrenceStatus(.deleted) == "削除済み")
        #expect(KMRecurringPresentation.undoLabel(generation) == "残りを一括で取り消す")
    }

    private func transaction(_ id: String) -> KMTransaction {
        KMTransaction(id: id, date: KMDate(rawValue: "2026-10-01"), amountYen: -1_700, kind: .expense,
            payeeName: "合成予定", accountId: "cash", categoryId: "food")
    }
}

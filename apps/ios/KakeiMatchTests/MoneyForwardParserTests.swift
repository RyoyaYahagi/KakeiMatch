import Foundation
import Testing
@testable import KakeiMatch

struct MoneyForwardParserTests {
    private let now = ISO8601DateFormatter().date(from: "2026-10-08T15:00:00Z")!

    @Test func recognizesFlexibleHeadersBomAndStableIdlessKeys() {
        let text = "\u{feff}内容,日付,金額(円),大項目,中項目,計算対象,保有金融機関,メモ,振替\n架空店舗,2025/1/2,-1,200,食費,食料品,1,合成口座,fixture,0\n"
        // Keep the amount column quoted because its comma is part of the integer.
        let fixed = text.replacingOccurrences(of: "-1,200,食費", with: "\"-1,200\",食費")
        let parsed = KMMoneyForwardParser.parse(data: Data(fixed.utf8), now: now)
        #expect(parsed.fatalErrors.isEmpty)
        #expect(parsed.encoding == "utf-8-bom")
        #expect(parsed.transactions.count == 1)
        #expect(parsed.transactions[0].date.rawValue == "2025-01-02")
        #expect(parsed.transactions[0].amountYen == -1200)
        #expect(parsed.transactions[0].sourceKey.count == 64)
    }

    @Test func mapsNegativeAmountsFlagsAndFutureDates() {
        let csv = "日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,計算対象\n2026/10/08,合成過去,-100,口座,食費,食料品,,0,1\n2026/10/10,合成未来,-300,口座,食費,食料品,,0,1\n2026/10/08,移動,-400,口座,振替,振替,,1,1\n2026/10/08,無効,-500,口座,食費,食料品,,unknown,1"
        let result = KMMoneyForwardParser.parse(data: Data(csv.utf8), now: now)
        #expect(result.transactions.map(\.amountYen) == [-100])
        #expect(result.excludedRows.map(\.reason) == ["future_date", "transfer"])
        #expect(result.rowErrors.map(\.reason) == ["振替の値を確認できません"])
    }

    @Test func reportsHeaderErrorsEmptyRowsAndInvalidCsv() {
        let duplicate = KMMoneyForwardParser.parse(data: Data("日付,日付,内容,金額（円）,大項目\n".utf8), now: now)
        #expect(duplicate.fatalErrors.first?.code == "header_mismatch")
        #expect(duplicate.duplicateHeaders == ["日付"])
        #expect(KMMoneyForwardParser.parse(data: Data("\"unfinished".utf8), now: now).fatalErrors.first?.code == "malformed_csv")
        #expect(KMMoneyForwardParser.parse(data: Data("".utf8), now: now).fatalErrors.first?.code == "empty_file")
    }

    @Test func resolvesKnownCustomAndCashCategories() {
        let food = KMMoneyForwardCategory(id: "food", name: "食費", isIncome: false, hidden: false)
        #expect(KMMoneyForwardParser.resolveCategory(kind: .expense, majorCategory: "食費", minorCategory: "食料品", available: [food]) == .init(categoryId: "food", suggestedName: "食費", reason: ""))
        let cash = KMMoneyForwardParser.resolveCategory(kind: .expense, majorCategory: "現金・カード", minorCategory: "現金", available: [food])
        #expect(cash.reason == "現金・カードの分類を確認してください")
        let custom = KMMoneyForwardParser.resolveCategory(kind: .expense, majorCategory: "独自", minorCategory: "試験", available: [.init(id: "custom", name: "独自", isIncome: false, hidden: false)])
        #expect(custom.categoryId == "custom")
    }

    @Test func findsSimilarRowsWithinThreeCalendarDaysAndSortsStableIds() throws {
        let day = try KMDate("2026-09-21")
        let row = KMMoneyForwardRow(rowNumber: 2, date: day, description: "店舗", amountYen: -1200, kind: .expense, accountName: nil, majorCategory: "食費", minorCategory: "食料品", memo: "", sourceTransactionId: nil, sourceKey: "a", isTransfer: false, isIncludedInCalculation: true, categoryNeedsReviewReason: nil)
        let account = "account"
        let candidates = [
            KMTransaction(id: "z", date: try KMDate("2026-09-22"), amountYen: -1200, kind: .expense, categoryName: "食費", accountId: account, categoryId: "food"),
            KMTransaction(id: "a", date: try KMDate("2026-09-18"), amountYen: -1200, kind: .expense, categoryName: "食費", accountId: account, categoryId: "food"),
            KMTransaction(id: "far", date: try KMDate("2026-09-25"), amountYen: -1200, kind: .expense, categoryName: "食費", accountId: account, categoryId: "food"),
            KMTransaction(id: "split", date: day, amountYen: -1200, kind: .expense, categoryName: "食費", accountId: account, categoryId: "food", isSplit: true),
        ]
        #expect(KMMoneyForwardParser.similarRecords(row: row, choice: .existing(id: "food"), transactions: candidates).map(\\.id) == ["z", "a"])
    }

    @Test func moneyForwardTodayUsesTokyoCalendarDay() {
        #expect(KMMoneyForwardParser.today(now).rawValue == "2026-10-09")
    }
}

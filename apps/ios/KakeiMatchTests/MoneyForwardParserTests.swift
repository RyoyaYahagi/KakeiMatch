import Foundation
import Testing
@testable import KakeiMatch

struct MoneyForwardParserTests {
    private let now = ISO8601DateFormatter().date(from: "2026-10-08T15:00:00Z")!
    private func csv(_ rows: [[String]]) -> Data {
        let body = rows.map { row in
            row.map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"" }.joined(separator: ",")
        }.joined(separator: "\r\n")
        return Data((body + "\r\n").utf8)
    }

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
        let csv = "日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,計算対象\n2026/10/08,合成過去,-100,口座,食費,食料品,,0,1\n2026/10/09,合成今日,-200,口座,食費,食料品,,0,1\n2026/10/10,合成未来,-300,口座,食費,食料品,,0,1\n2026/10/08,移動,-400,口座,振替,振替,,1,1\n2026/10/08,無効,-500,口座,食費,食料品,,unknown,1"
        let result = KMMoneyForwardParser.parse(data: Data(csv.utf8), now: now)
        #expect(result.transactions.map(\.amountYen) == [-100, -200])
        #expect(result.excludedRows.map(\.reason) == ["future_date", "transfer"])
        #expect(result.rowErrors.map(\.reason) == ["振替の値を確認できません"])
    }

    @Test func reportsHeaderErrorsEmptyRowsAndInvalidCsv() {
        let duplicate = KMMoneyForwardParser.parse(data: Data("日付,日付,内容,金額（円）,大項目\n2025/1/2,2025/1/2,test,-1,食費".utf8), now: now)
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
        #expect(KMMoneyForwardParser.similarRecords(row: row, choice: .existing(id: "food"), transactions: candidates).map(\.id) == ["z", "a"])
    }

    @Test func moneyForwardTodayUsesTokyoCalendarDay() {
        #expect(KMMoneyForwardParser.today(now).rawValue == "2026-10-09")
    }

    @Test func readsYearSpanningRowsAndSkipsEmptyRecords() {
        let header = ["日付", "内容", "金額（円）", "保有金融機関", "大項目", "中項目", "メモ", "振替", "計算対象", "ID"]
        let first = ["2026/1/2", "", "-1200", "合成口座", "食費", "食料品", "", "0", "1", "id-jan"]
        let second = ["2026/12/31", "   ", "-900", "合成口座", "食費", "食料品", "", "0", "1", ""]
        let badDate = ["2026/2/30", "", "-100", "合成口座", "食費", "食料品", "", "0", "1", ""]
        let input = csv([header, first, [], second, second, Array(repeating: " ", count: 10), badDate])
        let result = KMMoneyForwardParser.parse(data: input, now: ISO8601DateFormatter().date(from: "2026-12-31T03:00:00Z")!)
        #expect(result.fatalErrors.isEmpty)
        #expect(result.totalRows == 4)
        #expect(result.transactions.map { [$0.date.rawValue, $0.description, $0.sourceTransactionId ?? ""] } == [
            ["2026-01-02", "", "id-jan"], ["2026-12-31", "", ""], ["2026-12-31", "", ""],
        ])
        #expect(result.transactions.first.map { KMMoneyForwardParser.description($0) } == "内容なし")
        #expect(result.transactions.dropFirst().first?.sourceKey == result.transactions.dropFirst(2).first?.sourceKey)
        #expect(result.rowErrors == [.init(rowNumber: 7, reason: "日付を確認できません")])
    }

    @Test func validatesPartialRowsAndExcludesTransfersAndDisabledCalculation() {
        let header = "日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,計算対象"
        let text = "\(header)\n2026/1/2,,-300,合成口座,食費,食料品,,1,1\n2026/1/2,,-400,合成口座,食費,食料品,,0,0\n,,-100,合成口座,食費,食料品,,0,1\n2026/1/2,,,合成口座,食費,食料品,,0,1"
        let result = KMMoneyForwardParser.parse(data: Data(text.utf8), now: now)
        #expect(result.transactions.isEmpty)
        #expect(result.excludedRows == [.init(rowNumber: 2, reason: "transfer"), .init(rowNumber: 3, reason: "excluded_from_calculation")])
        #expect(result.rowErrors == [.init(rowNumber: 4, reason: "日付を確認できません"), .init(rowNumber: 5, reason: "金額を確認できません")])
    }

    @Test func decodesShiftJisAndReportsRowReasons() {
        let bytes: [UInt8] = [
            0x93,0xfa,0x95,0x74,0x2c,0x93,0xe0,0x97,0x65,0x2c,0x8b,0xe0,0x8a,0x7a,0x28,0x89,0x7e,0x29,0x2c,
            0x95,0xdb,0x97,0x4c,0x8b,0xe0,0x97,0x5a,0x8b,0x40,0x8a,0xd6,0x2c,0x91,0xe5,0x8d,0x80,0x96,0xda,0x2c,
            0x92,0x86,0x8d,0x80,0x96,0xda,0x2c,0x83,0x81,0x83,0x82,0x2c,0x90,0x55,0x91,0xd6,0x2c,0x8c,0x76,
            0x8e,0x5a,0x91,0xce,0x8f,0xdb,0x0a,0x32,0x30,0x32,0x35,0x2f,0x31,0x2f,0x32,0x2c,0x89,0xcb,0x8b,
            0xf3,0x83,0x58,0x81,0x5b,0x83,0x70,0x81,0x5b,0x2c,0x2d,0x31,0x32,0x30,0x30,0x2c,0x8d,0x87,0x90,
            0xac,0x8c,0xfb,0x8d,0xc0,0x2c,0x90,0x48,0x94,0xef,0x2c,0x90,0x48,0x97,0xbf,0x95,0x69,0x2c,0x2c,
            0x30,0x2c,0x31,0x0a,
        ]
        let parsed = KMMoneyForwardParser.parse(data: Data(bytes), now: now)
        #expect(parsed.encoding == "shift_jis")
        #expect(parsed.transactions.first?.description == "架空スーパー")
        let header = "日付,内容,金額(円),保有金融機関,大項目,中項目,メモ,振替,計算対象"
        let text = "\(header)\n2025/1/2,振替,-300,合成口座,食費,食料品,,1,1\n2025/1/2,対象外,-400,合成口座,食費,食料品,,0,0\n不正な日付,壊れた行,-5,合成口座,食費,食料品,,0,1"
        let excluded = KMMoneyForwardParser.parse(data: Data(text.utf8), now: now)
        #expect(excluded.excludedRows == [.init(rowNumber: 2, reason: "transfer"), .init(rowNumber: 3, reason: "excluded_from_calculation")])
        #expect(excluded.rowErrors == [.init(rowNumber: 4, reason: "日付を確認できません")])
    }

    @Test func resolvesKnownMinorMappingsCashReviewAndCustomCategories() {
        let food = KMMoneyForwardCategory(id: "food-id", name: "食費", isIncome: false, hidden: false)
        #expect(KMMoneyForwardParser.categoryKey(kind: .expense, major: " 食費 ", minor: " 食料品 ") == "[\"expense\",\"食費\",\"食料品\"]")
        #expect(KMMoneyForwardParser.resolveCategory(kind: .expense, majorCategory: "食費", minorCategory: "食料品", available: [food]) == .init(categoryId: "food-id", suggestedName: "食費", reason: ""))
        let medical = KMMoneyForwardCategory(id: "medical-id", name: "医療・健康", isIncome: false, hidden: false)
        #expect(KMMoneyForwardParser.resolveCategory(kind: .expense, majorCategory: "健康・医療", minorCategory: "薬", available: [medical]) == .init(categoryId: "medical-id", suggestedName: "医療・健康", reason: ""))
        #expect(KMMoneyForwardParser.resolveCategory(kind: .expense, majorCategory: "現金・カード", minorCategory: "現金", available: [food]) == .init(categoryId: nil, suggestedName: "現金・カード", reason: "現金・カードの分類を確認してください"))
        let custom = KMMoneyForwardCategory(id: "custom", name: "独自用途", isIncome: false, hidden: false)
        #expect(KMMoneyForwardParser.resolveCategory(kind: .expense, majorCategory: "独自用途", minorCategory: "試験", available: [custom]).categoryId == "custom")
        #expect(KMMoneyForwardParser.resolveCategory(kind: .expense, majorCategory: "未知", minorCategory: "試験", available: []).reason == "対応表にないカテゴリです。分類を確認してください")
    }

    @Test func preservesPhysicalLineNumbersForMultilineFields() {
        let header = "日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,計算対象"
        let text = "\(header)\n\n2025/1/2,架空店舗,-100,合成口座,食費,食料品,\"複数\n行メモ\",0,1\n不正日付,架空店舗,-100,合成口座,食費,食料品,,0,1"
        let result = KMMoneyForwardParser.parse(data: Data(text.utf8), now: now)
        #expect(result.transactions.first?.rowNumber == 4)
        #expect(result.rowErrors.first?.rowNumber == 5)
    }

    @Test func reportsDuplicateAndMissingRequiredHeaders() {
        let duplicate = KMMoneyForwardParser.parse(data: Data("日付,日付,内容,金額（円）,大項目\n2025/1/2,2025/1/2,test,-1,食費".utf8), now: now)
        #expect(duplicate.fatalErrors == [.init(rowNumber: nil, code: "header_mismatch")])
        #expect(duplicate.missingHeaders == [])
        #expect(duplicate.duplicateHeaders == ["日付"])
        let missing = KMMoneyForwardParser.parse(data: Data("日付,内容,大項目\n2025/1/2,test,食費".utf8), now: now)
        #expect(missing.missingHeaders == ["金額（円）"])
    }

    @Test func leavesUnknownFlagsAsRowErrorsAndParsesFullWidthYen() {
        let header = "日付,内容,金額(円),保有金融機関,大項目,中項目,メモ,振替,計算対象"
        let unknown = KMMoneyForwardParser.parse(data: Data("\(header)\n2025/1/2,架空スーパー,-1200,合成口座,食費,食料品,,不明,1".utf8), now: now)
        #expect(unknown.transactions.isEmpty)
        #expect(unknown.rowErrors == [.init(rowNumber: 2, reason: "振替の値を確認できません")])
        let currency = KMMoneyForwardParser.parse(data: Data("日付,内容,金額（円）,大項目\n2025/1/2,合成店舗,￥１，２００円,食費".utf8), now: now)
        #expect(currency.transactions.first?.amountYen == 1200)
    }

    @Test func findsSimilarRowsAcrossAccountsAndWithinThreeDaysOnly() throws {
        let day = try KMDate("2026-09-21")
        let row = KMMoneyForwardRow(rowNumber: 2, date: day, description: "Synthetic Store", amountYen: -1200, kind: .expense, accountName: "カードA", majorCategory: "食費", minorCategory: "食料品", memo: "", sourceTransactionId: "mf-1", sourceKey: String(repeating: "a", count: 64), isTransfer: false, isIncludedInCalculation: true, categoryNeedsReviewReason: nil)
        let candidates = [
            KMTransaction(id: "manual", date: day, amountYen: -1200, kind: .expense, payeeName: "Synthetic Store", categoryName: "食費", accountId: "acct", categoryId: "food"),
            KMTransaction(id: "other-account", date: day, amountYen: -1200, kind: .expense, categoryName: "食費", accountId: "another", categoryId: "food"),
            KMTransaction(id: "amount", date: day, amountYen: -1201, kind: .expense, categoryName: "食費", accountId: "acct", categoryId: "food"),
            KMTransaction(id: "category", date: day, amountYen: -1200, kind: .expense, categoryName: "その他", accountId: "acct", categoryId: "other"),
            KMTransaction(id: "income", date: day, amountYen: 1200, kind: .income, categoryName: "食費", accountId: "acct", categoryId: "food"),
            KMTransaction(id: "split", date: day, amountYen: -1200, kind: .expense, categoryName: "食費", accountId: "acct", categoryId: "food", isSplit: true),
            KMTransaction(id: "transfer", date: day, amountYen: -1200, kind: .transfer, categoryName: "食費", accountId: "acct", categoryId: "food"),
            KMTransaction(id: "far", date: try KMDate("2026-09-25"), amountYen: -1200, kind: .expense, categoryName: "食費", accountId: "acct", categoryId: "food"),
            KMTransaction(id: "boundary", date: try KMDate("2026-09-18"), amountYen: -1200, kind: .expense, categoryName: "食費", accountId: "acct", categoryId: "food"),
        ]
        let found = KMMoneyForwardParser.similarRecords(row: row, choice: .existing(id: "food"), transactions: candidates)
        #expect(found.map(\.id) == ["manual", "other-account", "boundary"])
    }

    @Test func matchesTypeScriptNullAccountSourceKeyAndRejectsUnsafeMinimumInteger() {
        let missingAccount = KMMoneyForwardParser.parse(data: Data("日付,内容,金額（円）,大項目\n2025/1/2,架空店舗,-100,食費".utf8), now: now)
        #expect(missingAccount.transactions.first?.accountName == nil)
        #expect(missingAccount.transactions.first?.sourceKey == "7358a86a8e57fb965266eb471d161e2ac5ef40917bfb603e8c8126cce4f98c32")
        let minimum = KMMoneyForwardParser.parse(data: Data("日付,内容,金額（円）,大項目\n2025/1/2,架空店舗,-9223372036854775808,食費".utf8), now: now)
        #expect(minimum.transactions.isEmpty)
        #expect(minimum.rowErrors == [.init(rowNumber: 2, reason: "金額を確認できません")])
    }
}

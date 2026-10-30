import Foundation
import Testing
@testable import KakeiMatchCore

struct MoneyForwardPresentationTests {
    private func row(
        _ amount: Int,
        major: String,
        minor: String = "",
        account: String? = "合成口座",
        sourceKey: String = "source",
        rowNumber: Int = 2,
        kind: KMMoneyForwardRow.Kind? = nil
    ) -> KMMoneyForwardRow {
        .init(rowNumber: rowNumber, date: KMDate(rawValue: "2026-10-01"), description: "合成\(major)",
            amountYen: amount, kind: kind ?? (amount < 0 ? .expense : .income), accountName: account,
            majorCategory: major, minorCategory: minor, memo: "", sourceTransactionId: nil,
            sourceKey: sourceKey, isTransfer: false, isIncludedInCalculation: true, categoryNeedsReviewReason: nil)
    }

    private func categories() -> [KMMoneyForwardCategory] {
        [
            .init(id: "food", name: "食費", isIncome: false, hidden: false),
            .init(id: "salary", name: "給与", isIncome: true, hidden: false),
            .init(id: "hidden-food", name: "隠し食費", isIncome: false, hidden: true),
        ]
    }

    @Test func groupsRowsByCategoryAndKindInFirstSeenOrder() {
        let rows = [row(-1200, major: "食費", minor: "食料品", sourceKey: "a"),
                    row(-300, major: "食費", minor: "食料品", sourceKey: "b", rowNumber: 3),
                    row(200_000, major: "給与", minor: "給与", sourceKey: "c", rowNumber: 4)]
        let groups = KMMoneyForwardPresentation.categoryGroups(rows)
        #expect(groups.count == 2)
        #expect(groups[0].count == 2)
        #expect(groups[0].row.minorCategory == "食料品")
        #expect(KMMoneyForwardPresentation.categoryLabel(groups[0]) == "食費 / 食料品（支出） 2件")
        #expect(KMMoneyForwardPresentation.categoryLabel(groups[1]) == "給与 / 給与（収入） 1件")
    }

    @Test func labelsAndStableIdentifiersDoNotEmbedDisplayOrder() {
        #expect(KMMoneyForwardPresentation.accountLabel("") == "移行元に口座名なし")
        #expect(KMMoneyForwardPresentation.accountLabel("合成口座") == "合成口座")
        let first = KMMoneyForwardPresentation.stableIdentifier("category", "[\"expense\",\"食費\",\"\"]")
        let second = KMMoneyForwardPresentation.stableIdentifier("category", "[\"expense\",\"食費\",\"\"]")
        let other = KMMoneyForwardPresentation.stableIdentifier("category", "[\"expense\",\"日用品\",\"\"]")
        #expect(first == second)
        #expect(first != other)
        #expect(first.hasPrefix("moneyforward.category."))
        #expect(!first.contains("食費"))
    }

    @Test func defaultCategoryMappingsMirrorPwaFallbacks() throws {
        let rows = [
            row(-1200, major: "食費", minor: "食料品", sourceKey: "food"),
            row(-500, major: "未分類", sourceKey: "unclassified"),
            row(-400, major: "独自用途", minor: "試験", sourceKey: "unknown"),
            row(-700, major: "水道・光熱費", minor: "電気", sourceKey: "new"),
            row(100_000, major: "給与", minor: "給与", sourceKey: "salary"),
        ]
        let defaults = KMMoneyForwardPresentation.defaultCategoryMappings(rows: rows, categories: categories(), saved: [:])
        #expect(defaults[key(rows[0])] == .existing(id: "food"))
        #expect(defaults[key(rows[1])] == .unclassified)
        #expect(defaults[key(rows[2])] == .unresolved)
        #expect(defaults[key(rows[3])] == .new(name: "水道・光熱"))
        #expect(defaults[key(rows[4])] == .existing(id: "salary"))

        let saved: [String: KMMoneyForwardPresentation.CategoryChoice] = [
            key(rows[0]): .new(name: "自作の食費"),
            key(rows[2]): .existing(id: "salary"), // income category for an expense row is invalid
        ]
        let reused = KMMoneyForwardPresentation.defaultCategoryMappings(rows: rows, categories: categories(), saved: saved)
        #expect(reused[key(rows[0])] == .new(name: "自作の食費"))
        #expect(reused[key(rows[2])] == .unresolved)
    }

    @Test func cashCardAlwaysNeedsReviewUnlessSavedRuleIsUsable() {
        var value = row(-1000, major: "現金・カード", minor: "ATM引出")
        value.categoryNeedsReviewReason = "現金・カードの分類を確認してください"
        let defaults = KMMoneyForwardPresentation.defaultCategoryMappings(rows: [value], categories: categories(), saved: [:])
        #expect(defaults[key(value)] == .unresolved)
    }

    @Test func defaultAccountMappingsPreferOpenAccountThenSavedRuleThenNewOrUnset() {
        let accounts = [KMAccount(id: "open", name: "合成口座"), KMAccount(id: "closed", name: "閉じた口座", closed: true)]
        let rows = [row(-100, major: "食費", account: "合成口座", sourceKey: "open"),
                    row(-100, major: "食費", account: "保存済み口座", sourceKey: "saved"),
                    row(-100, major: "食費", account: "新しい口座", sourceKey: "new"),
                    row(-100, major: "食費", account: nil, sourceKey: "unset")]
        let saved: [String: KMMoneyForwardPresentation.AccountChoice] = [
            "合成口座": .new(name: "無視される"),
            "保存済み口座": .existing(id: "saved-id"),
        ]
        let defaults = KMMoneyForwardPresentation.defaultAccountMappings(rows: rows, accounts: accounts, saved: saved)
        #expect(defaults["合成口座"] == .existing(id: "open"))
        #expect(defaults["保存済み口座"] == .existing(id: "saved-id"))
        #expect(defaults["新しい口座"] == .new(name: "新しい口座"))
        #expect(defaults[""] == .unset)
        #expect(KMMoneyForwardPresentation.accountSources(rows) == ["合成口座", "保存済み口座", "新しい口座", ""])
    }

    @Test func previewSummaryCountsAndBlocksImportUntilReviewIsResolved() {
        let readyExpense = KMMoneyForwardPresentation.PreviewInput(
            row: row(-1200, major: "食費", minor: "食料品", sourceKey: "a"),
            importedId: "moneyforward:a", status: .ready, candidates: [], recordChoice: nil)
        let readyIncome = KMMoneyForwardPresentation.PreviewInput(
            row: row(200_000, major: "給与", minor: "給与", sourceKey: "b"),
            importedId: "moneyforward:b", status: .ready, candidates: [], recordChoice: nil)
        let duplicate = KMMoneyForwardPresentation.PreviewInput(
            row: row(-300, major: "日用品", sourceKey: "c"), importedId: "moneyforward:c",
            status: .duplicate, candidates: [], recordChoice: nil)
        let unresolved = KMMoneyForwardPresentation.PreviewInput(
            row: row(-400, major: "独自用途", minor: "試験", sourceKey: "d"), importedId: "moneyforward:d",
            status: .unresolved, candidates: [], recordChoice: nil)
        let candidate = KMTransaction(id: "existing", date: KMDate(rawValue: "2026-10-02"), amountYen: -400,
            kind: .expense, payeeName: "合成カフェ", categoryName: "食費", accountId: "open")
        let review = KMMoneyForwardPresentation.PreviewInput(
            row: row(-400, major: "食費", sourceKey: "e"), importedId: "moneyforward:e",
            status: .review, candidates: [candidate], recordChoice: nil)
        let mappings = KMMoneyForwardPresentation.Mappings(
            categories: [
                key(readyExpense.row): .new(name: "新規の食費"),
                key(readyIncome.row): .existing(id: "salary"),
                key(duplicate.row): .existing(id: "food"),
                key(unresolved.row): .unresolved,
                key(review.row): .existing(id: "food"),
            ],
            accounts: ["合成口座": .new(name: "合成口座")])
        let summary = KMMoneyForwardPresentation.previewSummary(
            excluded: [.init(rowNumber: 9, reason: "future_date"), .init(rowNumber: 10, reason: "transfer")],
            rowErrorCount: 1, previews: [readyExpense, readyIncome, duplicate, unresolved, review],
            categories: categories(), accounts: [KMAccount(id: "open", name: "別口座")], mappings: mappings)

        #expect(summary.lines.first { $0.key == "period" }?.value == "2026-10-01 〜 2026-10-01")
        #expect(summary.lines.first { $0.key == "count" }?.value == "2件")
        #expect(summary.lines.first { $0.key == "income" }?.value == "1件 / ¥200,000")
        #expect(summary.lines.first { $0.key == "expense" }?.value == "1件 / ¥1,200")
        #expect(summary.lines.first { $0.key == "future" }?.value == "1件")
        #expect(summary.lines.first { $0.key == "review" }?.value == "1件")
        #expect(summary.lines.first { $0.key == "transfer" }?.value == "1件")
        #expect(summary.lines.first { $0.key == "excluded" }?.value == "2件")
        #expect(summary.lines.first { $0.key == "duplicates" }?.value == "1件")
        #expect(summary.lines.first { $0.key == "errors" }?.value == "1件")
        #expect(summary.lines.first { $0.key == "unresolved" }?.value == "1件")
        #expect(summary.lines.first { $0.key == "newCategories" }?.value == "1件")
        #expect(summary.lines.first { $0.key == "newAccounts" }?.value == "1件")
        #expect(summary.canImport == false)
        #expect(summary.notice == KMMoneyForwardPresentation.unresolvedNotice)
        #expect(summary.similarRows.count == 1)
    }

    @Test func previewAllowsKeepingExistingRecordWhenNothingElseNeedsReview() {
        let candidate = KMTransaction(id: "existing", date: KMDate(rawValue: "2026-10-01"), amountYen: -400,
            kind: .expense, payeeName: "合成カフェ", categoryName: "食費", accountId: "open")
        let item = KMMoneyForwardPresentation.PreviewInput(
            row: row(-400, major: "食費", sourceKey: "a"), importedId: "moneyforward:a",
            status: .review, candidates: [candidate], recordChoice: nil)
        let summary = KMMoneyForwardPresentation.previewSummary(
            excluded: [], rowErrorCount: 0, previews: [item], categories: categories(),
            accounts: [], mappings: .init(categories: [key(item.row): .existing(id: "food")]))
        #expect(summary.canImport == false)

        let kept = KMMoneyForwardPresentation.PreviewInput(
            row: item.row, importedId: item.importedId, status: .duplicate,
            candidates: [candidate], recordChoice: .keep)
        let ready = KMMoneyForwardPresentation.previewSummary(
            excluded: [], rowErrorCount: 0, previews: [kept], categories: categories(),
            accounts: [], mappings: .init(categories: [key(kept.row): .existing(id: "food")]))
        #expect(ready.canImport == true)
        #expect(ready.importTitle == "既存記録への統一を確定する")
        #expect(ready.notice == nil)
    }

    @Test func resultSummarySeparatesSkippedAndErrorRows() {
        let result = KMMoneyForwardPresentation.resultSummary(
            statuses: [.created, .created, .duplicate, .excluded, .other],
            excludedRowCount: 2, rowErrorCount: 1)
        #expect(result.lines.first { $0.key == "created" }?.value == "2件")
        #expect(result.lines.first { $0.key == "duplicates" }?.value == "1件")
        #expect(result.lines.first { $0.key == "skipped" }?.value == "3件")
        #expect(result.lines.first { $0.key == "errors" }?.value == "2件")
    }

    @Test func fatalDetailsListMissingAndUnknownColumns() {
        let result = KMMoneyForwardParseResult(
            totalRows: 0, encoding: "utf-8", fatalErrors: [.init(rowNumber: nil, code: "header_mismatch")],
            headerSignature: "[]", foundHeaders: ["日付", "内容"], missingHeaders: ["金額（円）", "大項目"],
            unknownHeaders: ["合成列"], duplicateHeaders: ["日付"])
        let lines = KMMoneyForwardPresentation.fatalDetails(result)
        #expect(lines[0] == "必須の列が不足または重複しています")
        #expect(lines[1] == "見つかった列: 日付、内容")
        #expect(lines[2] == "不足している必須列: 金額（円）、大項目")
        #expect(lines[3] == "重複している列: 日付")
        #expect(lines[4] == "認識できない列: 合成列")
        #expect(KMMoneyForwardPresentation.fatalDetails(.init(fatalErrors: [.init(rowNumber: nil, code: "empty_file")])).first == "ファイルが空です")
    }

    @Test func reviewLinesKeepPwaSignedYenAndDraftNames() {
        let csv = row(-1200, major: "食費", minor: "食料品", sourceKey: "a")
        let item = KMMoneyForwardPresentation.PreviewInput(
            row: csv, importedId: "moneyforward:a", status: .review, candidates: [], recordChoice: nil)
        #expect(KMMoneyForwardPresentation.similarLine(item) == "CSV 2行: 2026-10-01 · 合成食費 · ¥-1,200")

        let candidate = KMTransaction(id: "existing", date: KMDate(rawValue: "2026-10-02"), amountYen: -1200,
            kind: .expense, payeeName: nil, categoryName: nil, accountId: "missing")
        #expect(KMMoneyForwardPresentation.candidateLine(candidate, accounts: []) == "既存: 2026-10-02 · 内容なし · ¥-1,200 · 未分類 · 支払元未設定")
        #expect(KMMoneyForwardPresentation.candidateTitle(candidate, accounts: []) == "既存記録に統一: 2026-10-02 · 内容なし · ¥-1,200 · 未分類 · 支払元未設定")

        #expect(KMMoneyForwardPresentation.newCategoryName(csv) == "食料品")
        #expect(KMMoneyForwardPresentation.newCategoryName(row(-1200, major: "食費")) == "食費")
    }

    @Test func historyAndExclusionLabelsMatchPwa() {
        #expect(KMMoneyForwardPresentation.historyLabel(day: "2026-10-14", created: 3, undone: false) == "2026-10-14 · 登録 3件")
        #expect(KMMoneyForwardPresentation.historyLabel(day: "2026-10-14", created: 3, undone: true) == "2026-10-14 · 登録 3件 · 取り消し済み")
        #expect(KMMoneyForwardPresentation.exclusionReason("future_date") == "将来日付のため除外")
        #expect(KMMoneyForwardPresentation.exclusionReason("transfer") == "振替のため除外")
        #expect(KMMoneyForwardPresentation.exclusionReason("excluded_from_calculation") == "計算対象外のため除外")
    }

    private func key(_ row: KMMoneyForwardRow) -> String {
        KMMoneyForwardParser.categoryKey(kind: row.kind, major: row.majorCategory, minor: row.minorCategory)
    }
}

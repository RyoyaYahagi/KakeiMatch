import Foundation
import Testing
@testable import KakeiMatchCore

struct ReceiptPresentationTests {
    private func extraction() -> KMReceiptExtraction {
        .init(documentKind: .receipt, merchant: "合成店舗", purchasedDate: KMDate(rawValue: "2026-10-14"),
            totalAmountYen: 110, taxAmountYen: 10, items: [.init(name: "合成品目", amountYen: 100)], warnings: [])
    }
    private func item(_ amount: Int?) -> KMReceiptItem { .init(id: "synthetic-item", name: "合成品目", amountYen: amount) }

    @Test func totalsMatchDiscountsAndExternalTaxWithoutChangingInput() throws {
        let items = [item(100), item(100)]
        let discount = KMReceiptAdjustment(id: "synthetic-discount", label: "値引き", amountYen: -20)
        let matched = try #require(try KMReceiptPresentation.totalCheck(total: 180, items: items, adjustments: [discount], tax: nil))
        #expect(matched.matches && !matched.taxMatches)
        let tax = try #require(try KMReceiptPresentation.totalCheck(total: 198, items: items, adjustments: [discount], tax: 18))
        #expect(tax.matches && tax.taxMatches)
        #expect(tax.accessibleLabel == "品目と値引きと税額の合計と一致")
        let mismatch = try #require(try KMReceiptPresentation.totalCheck(total: 210, items: items, adjustments: [discount], tax: 18))
        #expect(!mismatch.matches && mismatch.difference == 30)
        #expect(mismatch.label == "△ 差額あり")
        #expect(items.map(\.amountYen) == [100, 100])
    }

    @Test func missingAmountsAndZeroAndOverflow() throws {
        #expect(try KMReceiptPresentation.totalCheck(total: 100, items: [item(nil)], adjustments: [], tax: nil) == nil)
        #expect(try KMReceiptPresentation.totalCheck(total: nil, items: [item(100)], adjustments: [], tax: nil) == nil)
        #expect(try KMReceiptPresentation.totalCheck(total: 0, items: [item(0)], adjustments: [], tax: nil)?.matches == true)
        #expect(throws: KMDataError.amountOverflow) {
            try KMReceiptPresentation.totalCheck(total: 1, items: [item(KMYen.maxSafe), item(1)], adjustments: [], tax: nil)
        }
    }

    @Test func categoryTotalsUseItemOverridesFallbackAndDescendingAmounts() throws {
        let categories = [KMCategory(id: "food", name: "食費"), KMCategory(id: "daily", name: "日用品")]
        let items = [
            KMReceiptItem(id: "a", name: "合成食品", amountYen: 200, categoryId: "food"),
            KMReceiptItem(id: "b", name: "合成日用品", amountYen: 100, categoryId: nil),
            KMReceiptItem(id: "c", name: "合成小物", amountYen: 50, categoryId: "daily"),
        ]
        let totals = try KMReceiptPresentation.categoryTotals(items: items, defaultCategoryId: "daily", categories: categories)
        #expect(totals.map(\.categoryId) == ["food", "daily"])
        #expect(totals.map(\.amountYen) == [200, 150])
        #expect(totals.map(\.name) == ["食費", "日用品"])
        #expect(throws: KMDataError.amountOverflow) {
            try KMReceiptPresentation.categoryTotals(
                items: [item(KMYen.maxSafe), item(1)], defaultCategoryId: "food", categories: categories
            )
        }
    }
    @Test func categoryChoicesCountEachCategoryOnceAndIgnoreTransfers() {
        let categories = [KMCategory(id: "daily", name: "日用品"), KMCategory(id: "food", name: "食費")]
        let date = KMDate(rawValue: "2026-10-14")
        let split = KMTransaction(id: "split", date: date, amountYen: -20, kind: .expense, accountId: "account",
            categoryId: "daily", splits: [
                .init(id: "child-daily", categoryId: "daily", amountYen: -10),
                .init(id: "child-food", categoryId: "food", amountYen: -10),
            ])
        let transfer = KMTransaction(id: "transfer", date: date, amountYen: -5, kind: .transfer, accountId: "account", categoryId: "food")
        let tie = KMReceiptPresentation.categoryChoices(categories: categories, transactions: [split, transfer])
        #expect(tie.map(\.id) == ["food", "daily"])
        let frequent = KMTransaction(id: "income", date: date, amountYen: 5, kind: .income, accountId: "account", categoryId: "daily")
        let ordered = KMReceiptPresentation.categoryChoices(categories: categories, transactions: [split, transfer, frequent])
        #expect(ordered.map(\.id) == ["daily", "food"])
    }
    @Test func warningLabelsTargetsFallbackAndReviewFiltering() {
        var value = extraction()
        value.adjustments = [.init(label: "合成値引き", amountYen: -10)]
        value.warnings = [
            .init(field: .items, code: "uncertain", message: "  数量を確認してください。  ", index: 0),
            .init(field: .adjustments, code: "new-code", message: "uncertain", index: 0),
            .init(field: nil, code: "unknown", message: "unreadable"),
            .init(field: .totalAmountYen, code: "uncertain", message: "金額を確認してください。")
        ]
        let warnings = KMReceiptPresentation.warnings(value, reviewed: [3])
        #expect(warnings.count == 3)
        #expect(warnings[0].label == "品目1「合成品目」")
        #expect(warnings[0].index == 0 && warnings[0].message == "数量を確認してください。")
        #expect(warnings[1].message == "画像の値引き・調整「合成値引き」と照らし合わせてください。")
        #expect(warnings[2].message == "画像の内容と照らし合わせてください。")
        #expect(KMReceiptPresentation.warnings(value, reviewed: [0, 1, 2, 3]).isEmpty)
    }
}

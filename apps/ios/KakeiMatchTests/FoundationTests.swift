import Testing
@testable import KakeiMatch

struct FoundationTests {
    @Test func baselineMeasurements() {
        #expect([KMSpacing.space1, KMSpacing.space2, KMSpacing.space3, KMSpacing.space4,
                 KMSpacing.space5, KMSpacing.space6, KMSpacing.space8] == [4, 8, 12, 16, 20, 24, 32])
        #expect([KMRadius.sm, KMRadius.md, KMRadius.lg, KMRadius.xl, KMRadius.sheet, KMRadius.full] == [10, 12, 16, 18, 24, 999])
        #expect(KMLayout.navHeight == 64)
        #expect(KMLayout.recordHeight == 60)
        #expect(KMLayout.recordIcon == 36)
        #expect(KMLayout.entryKeyWidth == 72)
        #expect(KMTypography.headingSize == 22)
        #expect(KMTypography.bodySize == 16)
        #expect(KMTypography.noteSize == 13)
        #expect(KMTypography.navSize == 12)
        #expect(KMTypography.inputAmountSize == 30)
    }

    @Test func categoryVisualMatchesReference() {
        #expect(KMCategoryTone.visual(name: "食費").tone == .food)
        #expect(KMCategoryTone.visual(name: "医療・健康").icon == "medical")
        #expect(KMCategoryTone.visual(name: "衣服・美容").tone == .fun)
        #expect(KMCategoryTone.visual(name: "水道・光熱").tone == .util)
        #expect(KMCategoryTone.visual(name: "その他", id: "abc").tone == .food) // JS hash 96354 % 6
        #expect(KMCategoryTone.visual(name: "", id: "😀").tone == .util) // scalar, not UTF16 code unit
    }

    @Test func recordPresentationMatchesReference() {
        var row = KMRecordSummary(kind: .expense, amountYen: -3284, date: "2026-10-02",
                                  payeeName: "スーパーみどり", categoryName: "食費",
                                  accountName: "楽天カード", memo: " 牛乳とパン ", hasReceipt: true, showDate: false)
        #expect(row.title == "スーパーみどり")
        #expect(row.note == "食費 · 牛乳とパン · レシート")
        #expect(row.accessibilityLabel == "スーパーみどり · 10/2 · 食費 · 牛乳とパン · レシート · −¥3,284")
        row.expenseMemoTitle = true
        #expect(row.title == "牛乳とパン")
        #expect(row.note == "スーパーみどり · 楽天カード · レシート")
        row.memo = "  "
        #expect(row.title == "食費")
        row.needsReview = true
        #expect(row.accessibilityLabel.contains("要確認"))
    }
}

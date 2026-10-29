import Testing
@testable import KakeiMatchCore

struct AmountFormatterTests {
    @Test func yenFormattingMatchesPWA() {
        #expect(KMAmountFormatter.yen(0) == "¥0")
        #expect(KMAmountFormatter.yen(123) == "¥123")
        #expect(KMAmountFormatter.yen(-3284) == "¥3,284")
        #expect(KMAmountFormatter.yen(123456789) == "¥123,456,789")
        #expect(KMAmountFormatter.yen(Int.min) == "¥9,223,372,036,854,775,808")
        #expect(KMAmountFormatter.yen(Int.max) == "¥9,223,372,036,854,775,807")
    }

    @Test func signUsesAmountExceptTransfers() {
        #expect(KMAmountFormatter.signed(-3284, kind: .expense) == "−¥3,284")
        #expect(KMAmountFormatter.signed(3284, kind: .expense) == "+¥3,284") // refund
        #expect(KMAmountFormatter.signed(250000, kind: .income) == "+¥250,000")
        #expect(KMAmountFormatter.signed(-10, kind: .income) == "−¥10")
        #expect(KMAmountFormatter.signed(0, kind: .expense) == "+¥0")
        #expect(KMAmountFormatter.signed(-10000, kind: .transfer) == "¥10,000")
    }
}

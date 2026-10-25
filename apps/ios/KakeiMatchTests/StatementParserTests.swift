import Foundation
import Testing
@testable import KakeiMatch

struct StatementParserTests {
    private let paypayHeader = "利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日"
    private let rakutenHeader = "利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,9月支払金額,当月請求額,10月繰越残高,新規サイン"
    private func data(_ text: String) -> Data { Data(text.utf8) }

    @Test func parsesPayPayBOMQuotedCommaAndStableDuplicates() {
        let line = "2026/9/28,\"食堂,駅前店\",本人,PayPayクレジット,1回,1,000,0,1,000,1,000,0,0,2026/10/27"
        let result = KMStatementParser.parse(data: data("\u{feff}\(paypayHeader)\r\n\(line)\r\n\(line)\r\n"), provider: .paypayCard)
        #expect(result.fatalErrors.isEmpty)
        #expect(result.encoding == "utf-8-bom")
        #expect(result.transactions.map(\.duplicateOrdinal) == [1, 2])
        #expect(result.transactions[0].merchant == "食堂,駅前店")
        #expect(result.transactions[0].amountYen == 1000)
        #expect(result.transactions[0].sourceFingerprint == result.transactions[1].sourceFingerprint)
    }

    @Test func reviewsCancellationsAndUnsupportedPaymentRows() {
        let purchase = "2026/09/28,架空店舗,本人,PayPayクレジット,1回,100,0,100,100,0,0,2026/10/27"
        let cancel = "2026/09/28,架空店舗,本人,PayPayクレジット,1回,-100,0,-100,-100,0,0,2026/10/27"
        let result = KMStatementParser.parse(data: data("\(paypayHeader)\n\(purchase)\n\(cancel)"), provider: .paypayCard)
        #expect(result.transactions.isEmpty)
        #expect(result.needsReviewRows.map(\.rowNumber) == [2, 3])
        let invalid = KMStatementParser.parse(data: data("\(paypayHeader)\n2026/02/30,店舗,本人,PayPay残高,分割,1.5,0,1,1,0,0,2026/10/27"), provider: .paypayCard)
        #expect(invalid.needsReviewRows.count == 1)
    }

    @Test func parsesBothRakutenLayoutsAndExclusions() {
        let body = "2026/09/01,人工店舗,本人,1回払い,1,200,0,1,200,10月,1,200,1,200,0,"
        let h12 = "利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,支払月,10月支払金額,当月請求額,11月繰越残高,11月以降請求額"
        let result = KMStatementParser.parse(data: data("\(h12)\n\(body)\n,,,,,,,,,,,\n"), provider: .rakutenCard)
        #expect(result.fatalErrors.isEmpty)
        #expect(result.transactions.first?.amountYen == 1200)
        #expect(result.excludedRows.map(\.rowNumber) == [3])
        let old = KMStatementParser.parse(data: data("\(rakutenHeader)\n2026/09/01,人工店舗,本人,1回払い,100,0,100,100,80,0,"), provider: .rakutenCard)
        #expect(old.transactions.first?.usedDate.rawValue == "2026-09-01")
        #expect(old.transactions.first?.amountYen == 100)
    }

    @Test func rejectsUnsupportedLayoutsAndRecognizesUnsupportedProviders() {
        #expect(KMStatementParser.parse(data: Data(), provider: .paypayCard).fatalErrors.first?.code == "empty_file")
        #expect(KMStatementParser.parse(data: data("\(paypayHeader)"), provider: .paypayCard).fatalErrors.first?.code == "header_only")
        #expect(KMStatementParser.parse(data: data("x,y\n1,2"), provider: .rakutenCard).fatalErrors.first?.code == "header_mismatch")
        #expect(KMStatementParser.parse(data: data("a,b\n1,2"), provider: .aeonCard).fatalErrors.first?.code == "unsupported_provider")
        #expect(KMStatementParser.parse(data: data("\"broken"), provider: .rakutenCard).fatalErrors.first?.code == "malformed_csv")
    }

    @Test func vpassOnlyReturnsSafeReviewReasonsAndStrictPurchases() {
        let text = "SYNTHETIC MEMBER,SYNTHETIC CARD,SYNTHETIC STATEMENT\n2026/09/28,架空店舗,1200,１,１,1200,\n2026/09/29,年会費,500,１,１,500,\n,,,,,1200,"
        let result = KMStatementParser.parse(text: text, provider: .smbcCard, encoding: "cp932")
        #expect(result.fatalErrors.isEmpty)
        #expect(result.transactions.count == 1)
        #expect(result.transactions[0].sourceFingerprint.count == 64)
        #expect(result.needsReviewRows == [.init(rowNumber: 3, reason: "特殊な利用の可能性があります")])
        #expect(!String(describing: result).contains("SYNTHETIC MEMBER"))
    }
}

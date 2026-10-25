import Foundation
import Testing
@testable import KakeiMatch

struct StatementParserTests {
    private let paypayHeader = "利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日"
    private let rakutenHeader = "利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,9月支払金額,当月請求額,10月繰越残高,新規サイン"
    private func data(_ text: String) -> Data { Data(text.utf8) }
    private func csv(_ rows: [[String]]) -> Data {
        let body = rows.map { row in
            row.map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"" }.joined(separator: ",")
        }.joined(separator: "\r\n")
        return Data((body + "\r\n").utf8)
    }

    @Test func parsesPayPayBOMQuotedCommaAndStableDuplicates() {
        let line = "2026/9/28,\"食堂,駅前店\",本人,PayPayクレジット,1回,\"1,000\",0,\"1,000\",\"1,000\",0,0,2026/10/27"
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
        let body = "2026/09/01,人工店舗,本人,1回払い,\"1,200\",0,\"1,200\",10月,\"1,200\",\"1,200\",0,"
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

    @Test func parsesEscapedQuotesAndLFDelimitedPayPayRows() {
        let headers = paypayHeader.split(separator: ",").map(String.init)
        let row = ["2026/09/28", "人工\"商店", "本人", "PayPayクレジット", "1回", "1200", "0", "1200", "1200", "0", "0", "2026/10/27"]
        let crlf = String(decoding: csv([headers, row]), as: UTF8.self)
        let result = KMStatementParser.parse(data: data(crlf.replacingOccurrences(of: "\r\n", with: "\n")), provider: .paypayCard)
        #expect(result.fatalErrors.isEmpty)
        #expect(result.transactions.map(\.merchant) == ["人工\"商店"])
    }

    @Test func reviewsUnsupportedPayPayMethodsAndTypes() {
        let headers = paypayHeader.split(separator: ",").map(String.init)
        for (method, kind) in [("クレジットカード", "1回"), ("PayPay残高", "1回"), ("PayPayクレジット", "分割払い")] {
            var row = ["2026/09/28", "人工商店", "本人", "PayPayクレジット", "1回", "1000", "0", "1000", "1000", "0", "0", "2026/10/27"]
            row[3] = method
            row[4] = kind
            let result = KMStatementParser.parse(data: csv([headers, row]), provider: .paypayCard)
            #expect(result.fatalErrors.isEmpty)
            #expect(result.transactions.isEmpty)
            #expect(result.needsReviewRows.count == 1)
        }
    }

    @Test func rejectsInvalidPayPayRowsAndUnsafeFiles() {
        let headers = paypayHeader.split(separator: ",").map(String.init)
        let row = ["2026/09/28", "人工商店", "本人", "PayPayクレジット", "1回", "1000", "0", "1000", "1000", "0", "0", "2026/10/27"]
        let shortRow = KMStatementParser.parse(data: csv([headers, Array(row.dropLast())]), provider: .paypayCard)
        #expect(shortRow.fatalErrors == [.init(rowNumber: 2, code: "invalid_row")])
        #expect(shortRow.transactions.isEmpty)
        #expect(KMStatementParser.parse(data: Data([0xff, 0xfe, 0x00, 0x00]), provider: .paypayCard).fatalErrors.first?.code == "invalid_file")
        #expect(KMStatementParser.parse(data: Data([0xef, 0xbb, 0xbf, 0xc3, 0x28]), provider: .rakutenCard).fatalErrors.first?.code == "invalid_file")
        #expect(KMStatementParser.parse(data: data("a\u{0}b"), provider: .paypayCard).fatalErrors.first?.code == "invalid_file")
        let longRow = row.enumerated().map { index, value in index == 1 ? String(repeating: "x", count: 2_001) : value }
        #expect(KMStatementParser.parse(data: csv([headers, longRow]), provider: .paypayCard).fatalErrors.first?.code == "limit_exceeded")
        #expect(KMStatementParser.parse(data: Data(repeating: 0x61, count: KMStatementParser.maxBytes + 1), provider: .paypayCard).fatalErrors.first?.code == "limit_exceeded")
        let manyRows = String(repeating: "2026/09/28,人工商店,本人,PayPayクレジット,1回,1000,0,1000,1000,0,0,2026/10/27\n", count: 20_001)
        #expect(KMStatementParser.parse(data: data("\(paypayHeader)\n\(manyRows)"), provider: .paypayCard).fatalErrors.first?.code == "limit_exceeded")
    }

    @Test func validatesRakutenTwelveColumnHeadersAndContinuationRows() {
        let headers = ["利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額", "支払月", "10月支払金額", "当月請求額", "11月繰越残高", "11月以降請求額"]
        let normal = ["2026/09/01", "人工商店", "本人", "1回払い", "1200", "0", "1200", "10月", "1200", "1200", "0", ""]
        for index in [7, 8, 9, 10, 11] {
            var changed = headers
            changed[index] = (index == 7 || index == 9) ? "未知列" : changed[index].replacingOccurrences(of: #"\d+月"#, with: "13月", options: .regularExpression)
            #expect(KMStatementParser.parse(data: csv([changed, normal]), provider: .rakutenCard).fatalErrors.first?.code == "header_mismatch")
        }
        var december = headers
        december[8] = "12月支払金額"
        december[10] = "1月繰越残高"
        december[11] = "1月以降請求額"
        #expect(KMStatementParser.parse(data: csv([december, normal]), provider: .rakutenCard).fatalErrors.isEmpty)
        #expect(KMStatementParser.parse(data: csv([headers, Array(normal.dropLast())]), provider: .rakutenCard).fatalErrors.first?.code == "unsupported_layout")

        let deferred = ["2026/09/02", "人工翌月店", "本人", "1回払い", "900", "0", "900", "翌月", "", "", "", "900"]
        let section = ["人工セクション"] + Array(repeating: "", count: 11)
        let result = KMStatementParser.parse(data: csv([headers, normal, deferred, Array(repeating: "", count: 12), section]), provider: .rakutenCard)
        #expect(result.transactions.map(\.merchant) == ["人工商店"])
        #expect(result.excludedRows == [.init(rowNumber: 4, reason: "non_expense")])
        #expect(result.needsReviewRows.map(\.rowNumber) == [3, 5])
        let continuation = ["", "人工商品内訳"] + Array(repeating: "", count: 10)
        #expect(KMStatementParser.parse(data: csv([headers, normal, continuation]), provider: .rakutenCard).transactions.isEmpty)
    }

    @Test func keepsUnsupportedRakutenPaymentsAndRefundsForReview() {
        let headers = rakutenHeader.split(separator: ",").map(String.init)
        let normal = ["2026/09/01", "人工市場", "本人", "1回払い", "100", "0", "100", "100", "80", "0", ""]
        let split = ["2026/09/02", "人工分割", "本人", "分割払い", "900", "0", "900", "300", "300", "0", ""]
        let revolving = ["2026/09/03", "人工リボ", "本人", "リボ払い", "800", "0", "800", "200", "200", "0", ""]
        let bonus = ["2026/09/04", "人工ボーナス", "本人", "ボーナス払い", "700", "0", "700", "700", "700", "0", ""]
        let refund = ["2026/09/05", "人工返金", "本人", "1回払い", "-100", "0", "-100", "-100", "-100", "0", ""]
        let cancel = ["2026/09/06", "人工取消", "本人", "1回払い", "100", "0", "100", "100", "100", "0", ""]
        let continuation = ["", "人工商品内訳"] + Array(repeating: "", count: 9)
        let result = KMStatementParser.parse(data: csv([headers, normal, split, revolving, bonus, refund, cancel, normal, continuation]), provider: .rakutenCard)
        #expect(result.fatalErrors.isEmpty)
        #expect(result.transactions.map(\.merchant) == ["人工市場"])
        #expect(result.needsReviewRows.map(\.rowNumber) == [3, 4, 5, 6, 7, 8, 9])
        #expect(result.needsReviewRows.first(where: { $0.rowNumber == 8 })?.reason.contains("複数行明細") == true)
        #expect(result.needsReviewRows.first(where: { $0.rowNumber == 9 })?.reason.contains("継続行") == true)
        let duplicate = KMStatementParser.parse(data: csv([headers, normal, normal]), provider: .rakutenCard)
        #expect(duplicate.transactions.map(\.duplicateOrdinal) == [1, 2])
        let partial = ["2026/09/01", "人工親行", "本人", "1回払い", "500", "0", "500", "", "", "", ""]
        #expect(KMStatementParser.parse(data: csv([headers, partial]), provider: .rakutenCard).transactions.isEmpty)
    }

    @Test func decodesCp932VpassBytesAndRejectsUnsafeTotals() {
        var bytes = Data("SYNTHETIC MEMBER,SYNTHETIC CARD,SYNTHETIC STATEMENT\r\n2026/09/28,".utf8)
        bytes.append(contentsOf: [0x82, 0xa0]) // あ
        bytes.append(Data(",1200,".utf8))
        bytes.append(contentsOf: [0x82, 0x50, 0x2c, 0x82, 0x50, 0x2c]) // １,１
        bytes.append(Data("1200,\r\n,,,,,1200,\r\n".utf8))
        let parsed = KMStatementParser.parse(data: bytes, provider: .smbcCard)
        #expect(parsed.encoding == "cp932")
        #expect(parsed.fatalErrors.isEmpty)
        #expect(parsed.transactions.first?.merchant == "あ")
        let invalidMetadata = KMStatementParser.parse(text: "private,metadata\n2026/09/28,人工店舗,1200,１,１,1200,\n,,,,,1200,", provider: .smbcCard, encoding: "cp932")
        #expect(invalidMetadata.fatalErrors.first?.code == "unsupported_layout")
        let wrongTotal = KMStatementParser.parse(text: "SYNTHETIC MEMBER,SYNTHETIC CARD,SYNTHETIC STATEMENT\n2026/09/28,人工店舗,1200,１,１,1200,\n,,,,,1300,", provider: .smbcCard, encoding: "cp932")
        #expect(wrongTotal.fatalErrors.first?.code == "unsupported_layout")
        let wrongDetailWidth = KMStatementParser.parse(text: "SYNTHETIC MEMBER,SYNTHETIC CARD,SYNTHETIC STATEMENT\n2026/09/28,人工店舗,1200,１,１,1200\n,,,,,1200,", provider: .smbcCard, encoding: "cp932")
        #expect(wrongDetailWidth.fatalErrors.first?.code == "unsupported_layout")
    }
}

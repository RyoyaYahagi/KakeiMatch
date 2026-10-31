import Foundation
import Testing
@testable import KakeiMatchCore

/// TS: src/lib/receipt-validation.ts and apps/pwa/src/local-ui.ts:ReceiptDraft.
struct ReceiptImageDraftTests {
    private let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    private let jpeg = Data([0xff, 0xd8, 0xff, 0xe0, 0x00])
    private var webp: Data { Data("RIFF".utf8) + Data([0, 0, 0, 0]) + Data("WEBP".utf8) }

    @Test func validatesTheSameFormatsAndMessagesAsPWA() throws {
        #expect(try KMReceiptImageValidation.validate(png, declaredContentType: "image/png").contentType == "image/png")
        #expect(try KMReceiptImageValidation.validate(jpeg, declaredContentType: "image/jpeg").contentType == "image/jpeg")
        #expect(try KMReceiptImageValidation.validate(webp, declaredContentType: "image/webp").contentType == "image/webp")

        func message(_ data: Data, _ type: String) -> String? {
            do { _ = try KMReceiptImageValidation.validate(data, declaredContentType: type); return nil }
            catch { return error.localizedDescription }
        }
        #expect(message(Data(), "image/png") == "画像ファイルを選択してください。")
        #expect(message(Data(repeating: 0, count: KMReceiptImageValidation.maxBytes + 1), "image/png")
            == "画像のサイズは10 MiB以下にしてください。")
        #expect(message(png, "image/heic") == "JPEG、PNG、WebP形式の画像を選択してください。")
        #expect(message(Data([0x00, 0x01]), "image/png")
            == "画像形式を確認できませんでした。JPEG、PNG、WebP形式の画像を選択してください。")
        #expect(message(png, "image/jpeg") == "画像の形式がファイル情報と一致しません。画像を選び直してください。")
    }

    @Test func draftKeepsIncompleteInputAndMatchesPWAUsefulness() throws {
        let empty = KMReceiptDraft(merchant: "  ", purchasedDate: "", purchasedTime: nil,
            totalAmountText: "", categoryId: "", accountId: "", items: [], adjustments: [],
            taxAmountText: "", memo: nil, excludedFromSpending: false)
        #expect(!empty.isUseful)
        var merchantOnly = empty; merchantOnly.merchant = "合成店舗"
        #expect(merchantOnly.isUseful)
        var amountOnly = empty; amountOnly.totalAmountText = "12"
        #expect(amountOnly.isUseful)
        var itemsOnly = empty
        itemsOnly.items = [.init(id: "synthetic-item", name: "", amountYen: nil)]
        #expect(itemsOnly.isUseful)

        let draft = KMReceiptDraft(merchant: "合成店舗", purchasedDate: "", purchasedTime: "12:3",
            totalAmountText: "12x", categoryId: "", accountId: "", items: itemsOnly.items,
            adjustments: [.init(id: "synthetic-adjustment", label: "", amountYen: -50)],
            taxAmountText: "", memo: "", excludedFromSpending: true)
        let decoded = try KMJSON.decoder().decode(KMReceiptDraft.self, from: KMJSON.encoder().encode(draft))
        #expect(decoded == draft)
    }
}

import Foundation
import Synchronization
import Testing
@testable import KakeiMatch

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
    @Test func rejectsMalformedExtractionBeforeItCanBeSaved() throws {
        var value = extraction()
        try KMReceiptPresentation.validateExtraction(value)
        value.items[0].amountYen = -1
        #expect(throws: (any Error).self) { try KMReceiptPresentation.validateExtraction(value) }
        value = extraction(); value.purchasedTime = "25:01"
        #expect(throws: (any Error).self) { try KMReceiptPresentation.validateExtraction(value) }
        value = extraction(); value.items[0].quantity = 0
        #expect(throws: (any Error).self) { try KMReceiptPresentation.validateExtraction(value) }
        value = extraction(); value.warnings = [.init(field: .items, code: "unknown", message: "確認", index: 1)]
        #expect(throws: (any Error).self) { try KMReceiptPresentation.validateExtraction(value) }
    }
    @Test func waitingAndRetryCopyMatchesPWA() {
        #expect(KMReceiptPresentation.readingNote(elapsed: 9) == "数秒かかります")
        #expect(KMReceiptPresentation.readingNote(elapsed: 10) == "品目が多いレシートは時間がかかります")
        #expect(!KMReceiptPresentation.retryable(.nativeUnsupported))
        #expect(!KMReceiptPresentation.retryable(.quotaExceeded))
        #expect(KMReceiptPresentation.retryable(.network))
        #expect(!KMReceiptPresentation.retryable(.aiTemporarilyPaused))
        #expect(!KMReceiptPresentation.retryable(.notConfigured))
        #expect(!KMReceiptPresentation.retryable(.rateLimited))
        #expect(!KMReceiptPresentation.retryable(.invalidRequest))
        #expect(KMReceiptPresentation.failureMessage(.nativeUnsupported).contains("手で入力"))
    }
}

@Suite(.serialized) @MainActor struct ReceiptModelTests {
    @Test func reviewedWarningAndCorrectedReceiptArePersistedAndRegisteredOnce() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        var value = try #require(try await repositories.receipts.receipts().first)
        value.extraction?.warnings = [.init(field: .totalAmountYen, code: "uncertain", message: "金額を確認してください。")]
        try await repositories.receipts.saveReceipt(value)
        let model = KMReceiptModel()
        await model.load(repositories, receiptID: value.id)
        #expect(model.warnings.count == 1)
        await model.reviewField(.totalAmountYen)
        #expect(model.warnings.isEmpty)
        model.accountId = try #require(model.accounts.first?.id)
        await model.save()
        #expect(model.error == nil)
        #expect(model.didSave)
        #expect(try await repositories.receipts.receipt(id: value.id)?.reviewedWarnings == [0])
        let before = try await repositories.transactions.transactions(matching: .init())
        await model.save()
        #expect(try await repositories.transactions.transactions(matching: .init()).count == before.count)
        #expect(before.contains { $0.payeeName == model.merchant && $0.amountYen == -2138 })
    }
    @Test func registrationFailureKeepsPendingIdAndInputForRetry() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        let id = try #require(try await repositories.receipts.receipts().first?.id)
        let model = KMReceiptModel(); await model.load(repositories, receiptID: id)
        model.accountId = try #require(model.accounts.first?.id)
        model.items[0].amountYen = nil
        await model.save()
        #expect(!model.didSave && model.error != nil)
        #expect(model.receipt?.id == id)
        #expect(model.merchant == "スーパーみどり")
        model.items[0].amountYen = 238
        await model.save()
        #expect(model.didSave && model.error == nil)
        #expect(try await repositories.receipts.receipts().count == 1)
    }
    @Test func unsavedImageCannotBeSentAndStopPreservesManualInput() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let model = KMReceiptModel(); await model.load(repositories, receiptID: nil)
        model.merchant = "合成手入力"; model.amount = "100"
        model.phase = .reading; model.stopWaiting()
        model.startReading()
        #expect(model.phase == .idle)
        #expect(model.merchant == "合成手入力" && model.amount == "100")
        #expect(model.error?.contains("保存できない") == true)
    }
}


/// The receipt screen uses the real typed API against this synthetic transport.
private final class ReceiptHTTPStub: URLProtocol, @unchecked Sendable {
    static let body = Mutex("")
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let json: String
        switch request.url?.path {
        case "/api/ai/token": json = #"{"token":"header.payload.signature","expiresAt":1800000600}"#
        case "/api/native/config": json = #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#
        default: json = Self.body.withLock { $0 }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private final class ReceiptCredentials: KMCloudCredentialStore, Sendable {
    private let values = Mutex<[String: Data]>([:])
    func read(_ key: String) -> Data? { values.withLock { $0[key] } }
    func write(_ data: Data?, key: String) { values.withLock { $0[key] = data } }
}

extension ReceiptModelTests {
    private func readingModel(response: String, native: Bool = false) async throws -> (KMReceiptModel, KMRepositories) {
        ReceiptHTTPStub.body.withLock { $0 = response }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReceiptHTTPStub.self]
        let credentials = ReceiptCredentials()
        if native {
            let guest = "{\"sessionToken\":\"" + String(repeating: "a", count: 43) + "\",\"expiresAt\":1800000600}"
            credentials.write(Data(guest.utf8), key: "guest")
        }
        let api = KMWorkerAPI(configuration: try KMAPIConfiguration(baseURL: URL(string: "https://synthetic.example.test")!, originPolicy: native ? .native : .existingWorkerCompatibility),
                              session: URLSession(configuration: configuration), credentials: credentials, appAttest: ReceiptUnsupportedAttest(),
                              now: { Date(timeIntervalSince1970: 1_800_000_000) })
        let repositories = try KMFixtureLoader.load(named: "receipt")
        var receipt = try #require(try await repositories.receipts.receipts().first)
        let bytes = Data([0xff, 0xd8, 0xff])
        receipt.image = .init(blobId: "synthetic-image", contentType: "image/jpeg", sizeBytes: bytes.count)
        let store = try #require(repositories.receipts as? KMInMemoryStore)
        store.imageValues["synthetic-image"] = bytes
        try await store.saveReceipt(receipt)
        let model = KMReceiptModel(api: api)
        await model.load(repositories, receiptID: receipt.id)
        return (model, repositories)
    }

    @Test func invalidAndNonReceiptResponsesDoNotReplaceManualInput() async throws {
        for kind in ["unknown", "not_receipt", "malformed"] {
            let response = kind == "malformed" ? #"{"documentKind":"receipt","totalAmountYen":-1}"#
                : "{\"documentKind\":\"\(kind)\",\"merchant\":null,\"purchasedDate\":null,\"purchasedTime\":null,\"totalAmountYen\":null,\"taxAmountYen\":null,\"items\":[],\"warnings\":[]}"
            let (model, repositories) = try await readingModel(response: response)
            let original = model.receipt?.extraction
            model.merchant = "合成手入力"; model.amount = "321"
            await model.startReading()?.value
            #expect(model.merchant == "合成手入力" && model.amount == "321")
            let id = try #require(model.receipt?.id)
            let saved = try #require(try await repositories.receipts.receipt(id: id))
            if kind == "malformed" {
                #expect(model.phase == .failed(.invalidResponse))
                #expect(saved.extraction == original)
            } else {
                #expect(model.phase == .idle)
                #expect(saved.extraction?.documentKind.rawValue == kind)
            }
        }
    }

    @Test func cancellingReadKeepsInputAndSavedExtraction() async throws {
        let (model, repositories) = try await readingModel(response: "{}")
        let original = model.receipt?.extraction
        let task = model.startReading()
        model.stopWaiting(); model.merchant = "合成の修正"; model.amount = "456"
        await task?.value
        #expect(model.phase == .idle)
        #expect(model.merchant == "合成の修正" && model.amount == "456")
        let id = try #require(model.receipt?.id)
        #expect(try await repositories.receipts.receipt(id: id)?.extraction == original)
    }
}

private struct ReceiptUnsupportedAttest: KMAppAttesting {
    var isSupported: Bool { false }
    func generateKey() async throws -> String { throw KMAPIError.nativeUnsupported }
    func attest(keyID: String, clientDataHash: Data) async throws -> Data { throw KMAPIError.nativeUnsupported }
    func assertion(keyID: String, clientDataHash: Data) async throws -> Data { throw KMAPIError.nativeUnsupported }
}

extension ReceiptModelTests {
    @Test func unsupportedCloudStillAllowsManualRegistration() async throws {
        let (model, repositories) = try await readingModel(response: "{}", native: true)
        await model.startReading()?.value
        #expect(model.phase == .failed(.nativeUnsupported))
        #expect(model.error?.contains("手で入力") == true)
        model.stopWaiting()
        model.merchant = "合成手入力"; model.amount = "321"; model.items = []; model.adjustments = []
        model.categoryId = try #require(model.categories.first?.id)
        model.accountId = try #require(model.accounts.first?.id)
        await model.save()
        #expect(model.didSave && model.error == nil)
        let id = try #require(model.receipt?.id)
        #expect(try await repositories.receipts.receipt(id: id)?.registration.status == .applied)
    }
}

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import Synchronization
import Testing
@testable import KakeiMatch

struct ReceiptPresentationTests {
    private func extraction() -> KMReceiptExtraction {
        .init(documentKind: .receipt, merchant: "合成店舗", purchasedDate: KMDate(rawValue: "2026-10-14"),
            totalAmountYen: 110, taxAmountYen: 10, items: [.init(name: "合成品目", amountYen: 100)], warnings: [])
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
        #expect(KMReceiptPresentation.failureMessage(.guestLimitReached).contains("ログイン"))
    }

    @Test func failureViewMapsAPIErrorsToThePWACodes() {
        let guestQuota = KMReceiptPresentation.readingFailure(.quotaExceeded, guest: true)
        #expect(guestQuota.title == "! AIの読み取り回数の上限です")
        #expect(guestQuota.message.contains("手で入力して続けられます。"))
        #expect(guestQuota.message.contains("ログインすると回数の制限なく使えることがあります。設定からログインできます。"))
        #expect(guestQuota.accountAction && !guestQuota.photoProblem)
        #expect(!guestQuota.message.contains("ぼやけや反射"))

        let accountQuota = KMReceiptPresentation.readingFailure(.quotaExceeded)
        #expect(accountQuota.message == "AI利用上限に達しました。手動で入力できます。")
        #expect(!accountQuota.accountAction)

        // The photo is blamed only for failures the photo can cause: two iOS codes
        // stand in for PWA's invalid_image / image_too_large.
        #expect(KMReceiptPresentation.readingFailure(.invalidResponse).photoProblem)
        #expect(KMReceiptPresentation.readingFailure(.invalidResponse).title == "! 写真から読み取れませんでした")
        #expect(KMReceiptPresentation.readingFailure(.invalidRequest).photoProblem)

        #expect(KMReceiptPresentation.readingFailure(.authenticationRequired).title == "! ログインが必要です")
        #expect(KMReceiptPresentation.readingFailure(.nativeAuthenticationRequired).title == "! ログインが必要です")
        for failure in [KMAPIError.rateLimited, .network, .providerUnavailable, .providerTimeout,
                        .aiTemporarilyPaused, .notConfigured] {
            let view = KMReceiptPresentation.readingFailure(failure)
            #expect(view.title == "! 今はAIで読み取れません")
            #expect(!view.photoProblem)
        }
        // PWA safeError maps the guest-creation limit to quota.
        #expect(KMReceiptPresentation.readingFailure(.guestLimitReached).title == "! AIの読み取り回数の上限です")
        #expect(KMReceiptPresentation.readingFailure(.guestLimitReached).accountAction)
        #expect(KMReceiptPresentation.readingFailure(.nativeUnsupported).title == "! 読み取れませんでした")
        #expect(!KMReceiptPresentation.readingFailure(.nativeUnsupported).accountAction)
    }
}

@Suite(.serialized) @MainActor struct ReceiptModelTests {
    @Test func itemWarningStaysWithOriginalItemAfterDeletion() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        var receipt = try #require(try await repositories.receipts.receipts().first)
        receipt.extraction?.warnings = [.init(field: .items, code: "uncertain", message: "品目を確認してください。", index: 0)]
        try await repositories.receipts.saveReceipt(receipt)
        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id)
        let first = try #require(model.items.first)
        let next = try #require(model.items.dropFirst().first)
        #expect(model.hasUnreviewedItemWarning(first.id))
        model.removeItem(first.id)
        #expect(!model.hasUnreviewedItemWarning(next.id))
    }

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
        let correctedCategory = try #require(model.categories.first { $0.id != model.categoryId })
        model.setAllItemCategories(correctedCategory.id)
        await model.save()
        #expect(model.error == nil)
        #expect(model.didSave)
        #expect(try await repositories.receipts.receipt(id: value.id)?.reviewedWarnings == [0])
        let learning = try #require(try await repositories.categoryLearning.categoryObservations().first { $0.receiptId == value.id })
        #expect(learning.items.first?.categoryId == correctedCategory.id)
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
    private static let syntheticPNG = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!

    @Test func photoLessReadIsRefusedAndStopPreservesManualInput() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let model = KMReceiptModel(); await model.load(repositories, receiptID: nil)
        model.merchant = "合成手入力"; model.amount = "100"
        model.phase = .reading; model.stopWaiting()
        model.startReading()
        #expect(model.phase == .idle)
        #expect(model.merchant == "合成手入力" && model.amount == "100")
        #expect(model.error?.contains("先にレシートの写真") == true)
    }

    @Test func selectingPhotoSavesTheOriginalAndRejectsInvalidImages() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let model = KMReceiptModel(); await model.load(repositories, receiptID: nil)
        await model.selectImage(Data([0x00]), contentType: "image/heic")
        #expect(model.receipt == nil)
        #expect(model.error == "JPEG、PNG、WebP形式の画像を選択してください。")

        await model.selectImage(Self.syntheticPNG, contentType: "image/png")
        let receipt = try #require(model.receipt)
        #expect(model.error == nil && model.imageIsSaved)
        #expect(receipt.registration.status == .pending)
        #expect(receipt.image?.contentType == "image/png")
        #expect(receipt.image?.sizeBytes == Self.syntheticPNG.count)
        #expect(try await repositories.receipts.receiptImage(blobId: try #require(receipt.image?.blobId)) == Self.syntheticPNG)
    }

    @Test func imageOverAILimitIsSavedButNotSent() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let model = KMReceiptModel(); await model.load(repositories, receiptID: nil)
        let large = Self.syntheticPNG + Data(repeating: 0, count: 7 * 1024 * 1024)
        await model.selectImage(large, contentType: "image/png")
        #expect(model.imageIsSaved)
        #expect(model.receipt?.image?.sizeBytes == large.count)
        #expect(model.startReading() == nil)
        #expect(model.phase == .failed(.invalidRequest))
        #expect(model.error?.contains("6 MiB以下") == true)
        let id = try #require(model.receipt?.id)
        #expect(try await repositories.receipts.receipt(id: id)?.extraction == nil)
    }

    @Test func unfinishedDraftRestoresAndIsRemovedAfterRegistration() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let model = KMReceiptModel(); await model.load(repositories, receiptID: nil)
        await model.selectImage(Self.syntheticPNG, contentType: "image/png")
        let id = try #require(model.receipt?.id)
        model.merchant = "合成の下書き"; model.amount = "12x"; model.memo = "途中"
        _ = model.addItem()
        await model.flushDraft()
        #expect(try await repositories.receipts.receiptDraft(receiptId: id)?.totalAmountText == "12x")
        #expect(try await repositories.receipts.receiptDraft(receiptId: id)?.items.count == 1)

        let reopened = KMReceiptModel(); await reopened.load(repositories, receiptID: id)
        #expect(reopened.merchant == "合成の下書き")
        #expect(reopened.amount == "12x" && reopened.memo == "途中")
        #expect(reopened.items.count == 1 && reopened.items[0].name.isEmpty)

        reopened.amount = "100"
        reopened.removeItem(try #require(reopened.items.first?.id))
        reopened.categoryId = try #require(reopened.categories.first?.id)
        reopened.accountId = try #require(reopened.accounts.first?.id)
        await reopened.save()
        #expect(reopened.didSave && reopened.error == nil)
        #expect(try await repositories.receipts.receiptDraft(receiptId: id) == nil)
        #expect(try await repositories.receipts.receipt(id: id)?.registration.status == .applied)
    }

    @Test func failedRegistrationKeepsTheDraftForRetry() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        let id = try #require(try await repositories.receipts.receipts().first?.id)
        let model = KMReceiptModel(); await model.load(repositories, receiptID: id)
        model.accountId = try #require(model.accounts.first?.id)
        model.items[0].amountYen = nil
        model.merchant = "合成の修正"
        await model.save()
        #expect(!model.didSave && model.error != nil)
        #expect(try await repositories.receipts.receiptDraft(receiptId: id)?.merchant == "合成の修正")
    }

    @Test func appliedReceiptItemCategoryEditUsesEditReceiptAndSavesLearning() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt-applied")
        let receipt = try #require(try await repositories.receipts.receipts().first)
        let model = KMReceiptModel(); await model.load(repositories, receiptID: receipt.id, editing: true)
        #expect(model.editing && model.error == nil)
        let first = try #require(model.items.first)
        let food = try #require(model.categories.first { $0.name == "食費" })
        let household = try #require(model.categories.first { $0.name == "日用品" })
        #expect(first.categoryId == food.id)
        model.setItemCategory(first.id, categoryId: household.id)
        await model.save()
        #expect(model.error == nil && model.didSave)
        let saved = try #require(try await repositories.receipts.receipt(id: receipt.id))
        #expect(saved.confirmedValue?.items?.first?.categoryId == household.id)
        let transaction = try #require(try await repositories.transactions.transaction(id: "fixture-transaction-receipt"))
        #expect(transaction.splits?.contains { $0.categoryId == household.id } == true)
        let learning = try #require(try await repositories.categoryLearning.categoryObservations().first { $0.receiptId == receipt.id })
        #expect(learning.items.first?.categoryId == household.id)
    }

    @Test func appliedReceiptEditRejectsStaleSnapshotAndKeepsInputForRetry() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt-applied")
        let receipt = try #require(try await repositories.receipts.receipts().first)
        let model = KMReceiptModel(); await model.load(repositories, receiptID: receipt.id, editing: true)
        let first = try #require(model.items.first)
        let household = try #require(model.categories.first { $0.name == "日用品" })
        // Simulate another screen saving first; the loaded updatedAt is now stale.
        var other = try #require(receipt.confirmedValue)
        other.memo = "別の画面で変更"
        _ = try await repositories.receipts.editReceipt(id: receipt.id, value: other,
            expectedUpdatedAt: receipt.updatedAt, at: repositories.referenceDate.addingTimeInterval(10))
        model.setItemCategory(first.id, categoryId: household.id)
        await model.save()
        #expect(!model.didSave && model.error != nil)
        // The rejected edit left the ledger alone and kept the unsaved input in the model.
        let current = try #require(try await repositories.receipts.receipt(id: receipt.id))
        #expect(current.confirmedValue?.memo == "別の画面で変更")
        #expect(current.confirmedValue?.items?.first?.categoryId == receipt.confirmedValue?.items?.first?.categoryId)
        #expect(model.items.first?.categoryId == household.id)
    }
}


/// The receipt screen uses the real typed API against this synthetic transport.
private final class ReceiptHTTPStub: URLProtocol, @unchecked Sendable {
    static let body = Mutex("")
    /// Path-specific responses; a path not listed here falls back to `body`.
    static let responses = Mutex<[String: String]>([:])
    static let requests = Mutex<[URLRequest]>([])
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private static func materializedRequest(_ request: URLRequest) throws -> URLRequest {
        guard request.httpBody == nil, let stream = request.httpBodyStream else { return request }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        var copy = request
        copy.httpBodyStream = nil
        copy.httpBody = data
        return copy
    }
    override func startLoading() {
        if let captured = try? Self.materializedRequest(request) {
            Self.requests.withLock { $0.append(captured) }
        }
        let json: String
        switch request.url?.path {
        case "/api/ai/token": json = #"{"token":"header.payload.signature","expiresAt":1800000600}"#
        case "/api/native/config": json = #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#
        default: json = Self.responses.withLock { $0[request.url?.path ?? ""] } ?? Self.body.withLock { $0 }
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
    private static func syntheticJPEG(width: Int = 4, height: Int = 4, properties: [CFString: Any] = [:]) throws -> Data {
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let context = try #require(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, properties.isEmpty ? nil : properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }

    /// A receipt-like picture whose text Vision can read. Photos without readable text are refused
    /// before sending, so the 4x4 blank fixture can no longer stand in for a receipt that is read.
    /// With `orientation6` the pixels are stored sideways and tagged like a camera photo, so the
    /// upright result still has readable text.
    private static func readableReceiptImage(
        format: String = "public.jpeg", orientation6: Bool = false, properties: [CFString: Any] = [:]
    ) throws -> Data {
        let width = 640, height = 240
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue
        let upright = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: 0, space: colorSpace, bitmapInfo: bitmapInfo))
        upright.setFillColor(gray: 1, alpha: 1)
        upright.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let font = CTFontCreateWithName("Helvetica" as CFString, 40, nil)
        for (index, text) in ["Synthetic Market", "2026/11/24", "TOTAL 1200"].enumerated() {
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
            ]))
            upright.textPosition = CGPoint(x: 30, y: CGFloat(180 - index * 65))
            CTLineDraw(line, upright)
        }
        var image = try #require(upright.makeImage())
        var imageProperties = properties
        if orientation6 {
            // Orientation 6 displays the stored pixels rotated 90 degrees clockwise.
            let sideways = try #require(CGContext(data: nil, width: height, height: width, bitsPerComponent: 8,
                bytesPerRow: 0, space: colorSpace, bitmapInfo: bitmapInfo))
            sideways.translateBy(x: CGFloat(height), y: 0)
            sideways.rotate(by: .pi / 2)
            sideways.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            image = try #require(sideways.makeImage())
            imageProperties[kCGImagePropertyOrientation] = 6
        }
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, format as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, imageProperties.isEmpty ? nil : imageProperties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func readingModel(response: String, native: Bool = false, guest: Bool = true,
                              attest: any KMAppAttesting = ReceiptUnsupportedAttest(),
                              imageData: Data? = nil, contentType: String = "image/jpeg") async throws -> (KMReceiptModel, KMRepositories) {
        ReceiptHTTPStub.body.withLock { $0 = response }
        ReceiptHTTPStub.responses.withLock { $0 = [:] }
        ReceiptHTTPStub.requests.withLock { $0 = [] }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReceiptHTTPStub.self]
        let credentials = ReceiptCredentials()
        if native && guest {
            let value = "{\"sessionToken\":\"" + String(repeating: "a", count: 43) + "\",\"expiresAt\":1800000600}"
            credentials.write(Data(value.utf8), key: "guest")
        }
        let api = KMWorkerAPI(configuration: try KMAPIConfiguration(baseURL: URL(string: "https://synthetic.example.test")!, originPolicy: native ? .native : .existingWorkerCompatibility),
                              session: URLSession(configuration: configuration), credentials: credentials, appAttest: attest,
                              now: { Date(timeIntervalSince1970: 1_800_000_000) })
        let repositories = try KMFixtureLoader.load(named: "receipt")
        var receipt = try #require(try await repositories.receipts.receipts().first)
        let bytes = try imageData ?? Self.readableReceiptImage()
        receipt.image = .init(blobId: "synthetic-image", contentType: contentType, sizeBytes: bytes.count)
        let store = try #require(repositories.receipts as? KMInMemoryStore)
        store.imageValues["synthetic-image"] = bytes
        try await store.saveReceipt(receipt)
        let model = KMReceiptModel(api: api)
        await model.load(repositories, receiptID: receipt.id)
        return (model, repositories)
    }

    @Test func startReadingSendsRedrawnMetadataFreeJPEGWithoutModifyingSavedOriginal() async throws {
        let extraction = #"{"documentKind":"unknown","merchant":null,"purchasedDate":null,"purchasedTime":null,"totalAmountYen":null,"taxAmountYen":null,"items":[],"warnings":[]}"#
        let originalBytes = try Self.readableReceiptImage(orientation6: true, properties: [
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "SYNTHETIC_RECEIPT_EXIF"],
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 35.68, kCGImagePropertyGPSLatitudeRef: "N"]
        ])
        let (model, repositories) = try await readingModel(response: extraction, imageData: originalBytes, contentType: "image/jpeg")
        await model.startReading()?.value
        #expect(model.error == nil)

        let geminiRequest = try #require(ReceiptHTTPStub.requests.withLock { $0.first { $0.url?.path == "/api/ai/gemini" } })
        let bodyData = try #require(geminiRequest.httpBody)
        let payload = try #require(try JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        #expect(payload["contentType"] as? String == "image/jpeg")
        let encoded = try #require(payload["imageBase64"] as? String)
        let uploadedData = try #require(Data(base64Encoded: encoded))
        #expect(uploadedData != originalBytes)
        #expect(uploadedData.range(of: Data("SYNTHETIC_RECEIPT_EXIF".utf8)) == nil)
        let decoded = try #require(CGImageSourceCreateWithData(uploadedData as CFData, nil))
        let props = try #require(CGImageSourceCopyPropertiesAtIndex(decoded, 0, nil) as? [String: Any])
        #expect(props[kCGImagePropertyPixelWidth as String] as? Int == 640)
        #expect(props[kCGImagePropertyPixelHeight as String] as? Int == 240)
        #expect(props[kCGImagePropertyGPSDictionary as String] == nil)
        #expect(props[kCGImagePropertyExifDictionary as String] == nil)
        #expect(props[kCGImagePropertyTIFFDictionary as String] == nil)
        #expect(props[kCGImagePropertyOrientation as String] == nil)
        #expect(try await repositories.receipts.receiptImage(blobId: "synthetic-image") == originalBytes)

        let originalPNG = try Self.readableReceiptImage(format: "public.png")
        let (pngModel, pngRepositories) = try await readingModel(response: extraction, imageData: originalPNG, contentType: "image/png")
        await pngModel.startReading()?.value
        #expect(pngModel.error == nil)
        let pngRequest = try #require(ReceiptHTTPStub.requests.withLock { $0.first { $0.url?.path == "/api/ai/gemini" } })
        let pngBodyData = try #require(pngRequest.httpBody)
        let pngPayload = try #require(try JSONSerialization.jsonObject(with: pngBodyData) as? [String: Any])
        #expect(pngPayload["contentType"] as? String == "image/jpeg")
        let pngEncoded = try #require(pngPayload["imageBase64"] as? String)
        let uploadedPNG = try #require(Data(base64Encoded: pngEncoded))
        #expect(KMUploadImage.matches(uploadedPNG, contentType: "image/jpeg"))
        #expect(try await pngRepositories.receipts.receiptImage(blobId: "synthetic-image") == originalPNG)
    }

    @Test func photoWithoutReadableTextIsNotSentAndShowsTheMaskedPreview() async throws {
        let (model, _) = try await readingModel(response: "{}", imageData: try Self.syntheticJPEG())
        await model.startReading()?.value
        #expect(model.phase == .idle)
        #expect(model.error == "隠した内容を確認できなかったため、写真の送信を止めました。写真を撮り直すか、手で入力してください。")
        #expect(model.redactionPreview != nil)
        #expect(ReceiptHTTPStub.requests.withLock { $0.contains { $0.url?.path == "/api/ai/gemini" } } == false)
    }

    @Test func jevItemAnswersBecomeTheReceiptCategories() async throws {
        let extraction = #"{"documentKind":"receipt","merchant":"合成店","purchasedDate":"2026-10-14","purchasedTime":null,"totalAmountYen":3284,"taxAmountYen":null,"items":[{"name":"合成りんご","amountYen":2000},{"name":"合成石けん","amountYen":1284}],"warnings":[]}"#
        let (model, _) = try await readingModel(response: extraction)
        let food = try #require(model.categories.first { $0.name == "食費" })
        let household = try #require(model.categories.first { $0.name == "日用品" })
        let answer = { (choice: String) in
            let other = 0.1 / Double(max(model.categories.count - 1, 1))
            let probabilities = model.categories.map { category in
                "\"\(category.id)\":\(category.id == choice ? "0.9" : String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), other))"
            }.joined(separator: ",")
            return "{\"type\":\"choice\",\"choice\":\"\(choice)\",\"confidence\":0.9,\"probabilities\":{\(probabilities)}}"
        }
        ReceiptHTTPStub.responses.withLock {
            $0["/api/ai/jev"] = "{\"model\":\"synthetic-model\",\"answers\":{\"item_0\":\(answer(food.id)),\"item_1\":\(answer(household.id))}}"
        }
        await model.startReading()?.value
        #expect(model.phase == .idle)
        #expect(model.error == nil)
        #expect(model.items.map(\.categoryId) == [food.id, household.id])
        #expect(model.receipt?.aiSuggestion.source == .jev)
    }

    @Test func jevOnlySendsTheFirstThirtyItems() async throws {
        let items = (0..<31).map { "{\"name\":\"合成品目\($0)\",\"amountYen\":100}" }.joined(separator: ",")
        let extraction = "{\"documentKind\":\"receipt\",\"merchant\":\"合成店\",\"purchasedDate\":\"2026-10-14\",\"purchasedTime\":null,\"totalAmountYen\":3100,\"taxAmountYen\":null,\"items\":[\(items)],\"warnings\":[]}"
        let (model, _) = try await readingModel(response: extraction)
        let food = try #require(model.categories.first { $0.name == "食費" })
        let other = 0.1 / Double(max(model.categories.count - 1, 1))
        let probabilities = model.categories.map { category in
            "\"\(category.id)\":\(category.id == food.id ? "0.9" : String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), other))"
        }.joined(separator: ",")
        let answer = "{\"type\":\"choice\",\"choice\":\"\(food.id)\",\"confidence\":0.9,\"probabilities\":{\(probabilities)}}"
        let answers = (0..<30).map { "\"item_\($0)\":\(answer)" }.joined(separator: ",")
        ReceiptHTTPStub.responses.withLock {
            $0["/api/ai/jev"] = "{\"model\":\"synthetic-model\",\"answers\":{\(answers)}}"
        }
        await model.startReading()?.value
        #expect(model.phase == .idle)
        #expect(model.error == nil)
        #expect(model.items.prefix(30).allSatisfy { $0.categoryId == food.id })
        #expect(model.items[30].categoryId == nil)
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

private struct ReceiptSupportedAttest: KMAppAttesting {
    var isSupported: Bool { true }
    func generateKey() async throws -> String { "c3ludGhldGlj" }
    func attest(keyID: String, clientDataHash: Data) async throws -> Data { Data([0x01]) }
    func assertion(keyID: String, clientDataHash: Data) async throws -> Data { Data([0x02]) }
}

private struct ReceiptUnsupportedAttest: KMAppAttesting {
    var isSupported: Bool { false }
    func generateKey() async throws -> String { throw KMAPIError.nativeUnsupported }
    func attest(keyID: String, clientDataHash: Data) async throws -> Data { throw KMAPIError.nativeUnsupported }
    func assertion(keyID: String, clientDataHash: Data) async throws -> Data { throw KMAPIError.nativeUnsupported }
}

extension ReceiptModelTests {
    @Test func firstGuestReadingWaitsForTheNativeCheckDialog() async throws {
        let (model, _) = try await readingModel(response: "{}", native: true, guest: false, attest: ReceiptSupportedAttest())
        await model.startReading()?.value
        // Same gate as the PWA bot-check dialog: no guest exists yet, so the
        // reading stops and asks before anything is sent.
        #expect(model.needsGuestStart)
        #expect(model.phase == .idle)
        #expect(model.error == nil)
        #expect(model.receipt != nil)
        model.cancelGuestStart()
        #expect(!model.needsGuestStart)
        #expect(model.status == KMNativeAuthPresentation.guestStartCancelled)
        #expect(model.receipt != nil)
    }

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


extension ReceiptModelTests {
    @Test func changedReceiptIsNotOverwrittenOrReportedAsNetworkFailure() async throws {
        let response = #"{"documentKind":"unknown","merchant":null,"purchasedDate":null,"purchasedTime":null,"totalAmountYen":null,"taxAmountYen":null,"items":[],"warnings":[]}"#
        let (model, repositories) = try await readingModel(response: response)
        var changed = try #require(model.receipt)
        let extraction = changed.extraction
        changed.updatedAt = changed.updatedAt.addingTimeInterval(1)
        try await repositories.receipts.saveReceipt(changed)
        await model.startReading()?.value
        #expect(model.phase == .idle)
        #expect(model.error?.contains("レシートが変更されています") == true)
        #expect(try await repositories.receipts.receipt(id: changed.id)?.extraction == extraction)
    }
}


extension ReceiptModelTests {
    @Test func missingPendingReceiptCannotCreateAnUnrelatedNewReceipt() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        let before = try await repositories.receipts.receipts().count
        let model = KMReceiptModel()
        await model.load(repositories, receiptID: "missing-synthetic-receipt")
        model.merchant = "合成手入力"; model.amount = "123"
        model.categoryId = try #require(model.categories.first?.id)
        model.accountId = try #require(model.accounts.first?.id)
        #expect(!model.canSave)
        await model.save()
        #expect(!model.didSave)
        #expect(try await repositories.receipts.receipts().count == before)
    }

    @Test func multiRateReceiptTaxEditReconcilesTaxesAndRegistersSuccessfully() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        var receipt = try #require(try await repositories.receipts.receipts().first)
        let categories = try await repositories.categories.categories(includeHidden: false).filter { !$0.isIncome }
        let food = try #require(categories.first { $0.name == "食費" })
        let household = try #require(categories.first { $0.name == "日用品" })

        receipt.extraction = KMReceiptExtraction(
            documentKind: .receipt,
            merchant: "合成マルチ税率スーパー",
            purchasedDate: try KMDate("2026-11-28"),
            purchasedTime: nil,
            totalAmountYen: 2331,
            taxAmountYen: 120,
            items: [
                .init(name: "合成弁当", amountYen: 1000, taxRatePercent: 8),
                .init(name: "合成果物", amountYen: 620, taxRatePercent: 8),
                .init(name: "合成洗剤", amountYen: 598, taxRatePercent: 10),
            ],
            adjustments: [
                .init(label: "値引き", amountYen: -70, targetItemIndex: 0),
            ],
            warnings: [],
            taxes: [
                .init(ratePercent: 8, taxableAmountYen: 1550, taxAmountYen: 120),
                .init(ratePercent: 10, taxableAmountYen: 598, taxAmountYen: 59),
            ]
        )
        receipt.itemCategories = [food.id, food.id, household.id]
        receipt.confirmedValue = nil
        try await repositories.receipts.saveReceipt(receipt)

        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id)
        model.accountId = try #require(model.accounts.first?.id)

        #expect(model.hasMultipleTaxRates)
        #expect(model.tax == "179")
        #expect(model.taxAmountText(at: 0) == "120")
        #expect(model.taxAmountText(at: 1) == "59")
        #expect(model.totalCheck?.matches == false)

        await model.save()
        #expect(!model.didSave && model.error != nil)

        model.setTaxAmount(at: 0, value: "124")
        #expect(model.taxes == [
            .init(ratePercent: 8, taxableAmountYen: 1550, taxAmountYen: 124),
            .init(ratePercent: 10, taxableAmountYen: 598, taxAmountYen: 59),
        ])
        #expect(model.tax == "183")
        #expect(model.totalCheck?.matches == true)

        await model.save()
        #expect(model.error == nil && model.didSave)

        let saved = try #require(try await repositories.receipts.receipt(id: receipt.id))
        #expect(saved.registration.status == .applied)
        #expect(saved.confirmedValue?.taxAmountYen == 183)
        #expect(saved.confirmedValue?.taxes == [
            .init(ratePercent: 8, taxableAmountYen: 1550, taxAmountYen: 124),
            .init(ratePercent: 10, taxableAmountYen: 598, taxAmountYen: 59),
        ])
        let transactionId = try #require(saved.registration.actualTransactionId)
        let transaction = try #require(try await repositories.transactions.transaction(id: transactionId))
        let splits = try #require(transaction.splits)
        #expect(splits.first { $0.categoryId == food.id }?.amountYen == -1674)
        #expect(splits.first { $0.categoryId == household.id }?.amountYen == -657)
    }

    @Test func singleRateReceiptKeepsSingleTaxBehaviorAndReconcilesTaxes() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        var receipt = try #require(try await repositories.receipts.receipts().first)
        let categories = try await repositories.categories.categories(includeHidden: false).filter { !$0.isIncome }
        let food = try #require(categories.first { $0.name == "食費" })
        let household = try #require(categories.first { $0.name == "日用品" })

        receipt.extraction = KMReceiptExtraction(
            documentKind: .receipt,
            merchant: "合成単一税率ストア",
            purchasedDate: try KMDate("2026-11-28"),
            purchasedTime: nil,
            totalAmountYen: 1100,
            taxAmountYen: 90,
            items: [
                .init(name: "合成日用品", amountYen: 600, taxRatePercent: 10),
                .init(name: "合成食品", amountYen: 400, taxRatePercent: 10),
            ],
            adjustments: [],
            warnings: [],
            taxes: [
                .init(ratePercent: 10, taxableAmountYen: 1000, taxAmountYen: 90),
            ]
        )
        receipt.itemCategories = [household.id, food.id]
        receipt.confirmedValue = nil
        try await repositories.receipts.saveReceipt(receipt)

        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id)
        model.accountId = try #require(model.accounts.first?.id)

        #expect(!model.hasMultipleTaxRates)
        #expect(model.tax == "90")

        model.setSingleTax("100")
        #expect(model.tax == "100")
        #expect(model.taxes == [.init(ratePercent: 10, taxableAmountYen: 1000, taxAmountYen: 100)])
        #expect(model.totalCheck?.matches == true)

        await model.save()
        #expect(model.error == nil && model.didSave)

        let saved = try #require(try await repositories.receipts.receipt(id: receipt.id))
        #expect(saved.registration.status == .applied)
        #expect(saved.confirmedValue?.taxAmountYen == 100)
        #expect(saved.confirmedValue?.taxes == [.init(ratePercent: 10, taxableAmountYen: 1000, taxAmountYen: 100)])
    }

    @Test func confirmedReceiptWithoutTaxesKeepsSavedTaxOverExtractionTaxes() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt-applied")
        var receipt = try #require(try await repositories.receipts.receipts().first)
        let categories = try await repositories.categories.categories(includeHidden: false).filter { !$0.isIncome }
        let food = try #require(categories.first { $0.name == "食費" })
        let household = try #require(categories.first { $0.name == "日用品" })
        let existingConfirmed = try #require(receipt.confirmedValue)

        receipt.extraction = KMReceiptExtraction(
            documentKind: .receipt,
            merchant: "合成保存済みストア",
            purchasedDate: existingConfirmed.purchasedDate,
            purchasedTime: nil,
            totalAmountYen: 2331,
            taxAmountYen: 179,
            items: [
                .init(name: "合成弁当", amountYen: 1550, taxRatePercent: 8),
                .init(name: "合成洗剤", amountYen: 598, taxRatePercent: 10),
            ],
            adjustments: [],
            warnings: [],
            taxes: [
                .init(ratePercent: 8, taxableAmountYen: 1550, taxAmountYen: 120),
                .init(ratePercent: 10, taxableAmountYen: 598, taxAmountYen: 59),
            ]
        )
        receipt.confirmedValue = KMConfirmedReceipt(
            merchant: "合成保存済みストア",
            purchasedDate: existingConfirmed.purchasedDate,
            purchasedTime: nil,
            totalAmountYen: 2331,
            categoryId: food.id,
            accountId: existingConfirmed.accountId,
            excludedFromSpending: false,
            memo: nil,
            taxAmountYen: 183,
            items: [
                .init(id: "saved-item-1", name: "合成弁当", amountYen: 1550, categoryId: food.id, taxRatePercent: 8),
                .init(id: "saved-item-2", name: "合成洗剤", amountYen: 598, categoryId: household.id, taxRatePercent: 10),
            ],
            adjustments: [],
            taxes: nil
        )
        try await repositories.receipts.saveReceipt(receipt)

        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id, editing: true)

        #expect(!model.hasMultipleTaxRates)
        #expect(model.taxes.isEmpty)
        #expect(model.tax == "183")
        #expect(model.totalCheck?.matches == true)

        model.memo = "再保存確認"
        await model.save()
        #expect(model.error == nil && model.didSave)

        let saved = try #require(try await repositories.receipts.receipt(id: receipt.id))
        #expect(saved.confirmedValue?.taxAmountYen == 183)
        #expect(saved.confirmedValue?.taxes == nil)
        #expect(saved.confirmedValue?.memo == "再保存確認")
    }
}


extension ReceiptModelTests {
    @Test func unclassifiedItemCreatesLeadingUnselectedBucketAndIsNotFoldedIntoFirstCategory() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        var receipt = try #require(try await repositories.receipts.receipts().first)
        let food = try #require(try await repositories.categories.categories(includeHidden: false).first { $0.name == "食費" })
        receipt.aiSuggestion = .init(categoryId: food.id, source: .jev)
        var categoriesByItem = Array(repeating: Optional(food.id), count: receipt.extraction?.items.count ?? 0)
        categoriesByItem[1] = nil
        receipt.itemCategories = categoriesByItem
        try await repositories.receipts.saveReceipt(receipt)

        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id)
        #expect(model.unclassifiedItemCount == 1)
        #expect(model.hasUnclassifiedItems)
        let totals = try model.categorySummary.get()
        #expect(totals.first?.categoryId == nil)
        #expect(totals.first?.name == "未選択")
        #expect(totals.first?.amountYen == model.items[1].amountYen)
        #expect(totals.dropFirst().first?.categoryId == food.id)
    }

    @Test func unclassifiedItemBlocksRegistrationUntilAllItemsAreCategorized() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        var receipt = try #require(try await repositories.receipts.receipts().first)
        let categories = try await repositories.categories.categories(includeHidden: false)
        let food = try #require(categories.first { $0.name == "食費" })
        let daily = try #require(categories.first { $0.name == "日用品" })
        receipt.aiSuggestion = .init(categoryId: food.id, source: .jev)
        var categoriesByItem = Array(repeating: Optional(food.id), count: receipt.extraction?.items.count ?? 0)
        categoriesByItem[1] = nil
        receipt.itemCategories = categoriesByItem
        try await repositories.receipts.saveReceipt(receipt)

        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id)
        model.accountId = try #require(model.accounts.first?.id)
        let beforeCount = try await repositories.transactions.transactions(matching: .init()).count

        await model.save()
        #expect(!model.didSave)
        #expect(model.blockedByUnclassifiedItems)
        #expect(model.error?.contains("未選択") == true)
        #expect(try await repositories.transactions.transactions(matching: .init()).count == beforeCount)

        model.setItemCategory(model.items[1].id, categoryId: daily.id)
        #expect(!model.hasUnclassifiedItems)
        #expect(!model.blockedByUnclassifiedItems)
        #expect(model.error == nil)

        await model.save()
        #expect(model.didSave)
        #expect(model.error == nil)
        #expect(try await repositories.transactions.transactions(matching: .init()).count == beforeCount + 1)
    }

    @Test func legacyAppliedReceiptWithNilItemCategoryDisplaysAndSavesWithoutUnselectedError() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt-applied")
        var receipt = try #require(try await repositories.receipts.receipts().first)
        var confirmed = try #require(receipt.confirmedValue)
        let fallbackCategoryId = confirmed.categoryId
        var legacyItems = try #require(confirmed.items)
        legacyItems[0].categoryId = nil
        confirmed.items = legacyItems
        receipt.confirmedValue = confirmed
        try await repositories.receipts.saveReceipt(receipt)

        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id, editing: true)
        #expect(model.editing && model.error == nil)
        #expect(model.unclassifiedItemCount == 0)
        #expect(model.items[0].categoryId == fallbackCategoryId)
        let totals = try model.categorySummary.get()
        #expect(!totals.contains { $0.categoryId == nil })

        model.memo = "旧レシート互換確認"
        await model.save()
        #expect(model.didSave && model.error == nil)
    }
}


extension ReceiptModelTests {
    @Test func manualItemCategoryRegistersInstantRuleAndAutoAppliesOnNextReceipt() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        let receipt = try #require(try await repositories.receipts.receipts().first)
        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id)
        model.accountId = try #require(model.accounts.first?.id)
        let targetItem = try #require(model.items.first)
        let daily = try #require(model.categories.first { $0.name == "日用品" })

        model.setItemCategory(targetItem.id, categoryId: daily.id)
        await model.save()
        #expect(model.didSave && model.error == nil)

        let rules = try await repositories.categoryLearning.categoryRules()
        let normalizedName = KMCategoryLearningService.normalizeName(targetItem.name)
        let registered = try #require(rules.first { $0.targetType == .item && $0.normalizedName == normalizedName })
        #expect(registered.categoryId == daily.id)
        #expect(registered.enabled && !registered.deleted)

        let nextLearning = KMReceiptPresentation.categoryLearning(
            merchant: "別の合成店舗",
            itemNames: [targetItem.name],
            rules: rules,
            categories: model.categories
        )
        #expect(nextLearning.itemCategoryIds == [daily.id])
        #expect(nextLearning.itemIndexesToClassify.isEmpty)
    }

    @Test func reassigningSameItemCategoryUpdatesInstantRuleForNextReceipt() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        let receipt = try #require(try await repositories.receipts.receipts().first)
        let firstModel = KMReceiptModel()
        await firstModel.load(repositories, receiptID: receipt.id)
        firstModel.accountId = try #require(firstModel.accounts.first?.id)
        let targetItem = try #require(firstModel.items.first)
        let food = try #require(firstModel.categories.first { $0.name == "食費" })
        let daily = try #require(firstModel.categories.first { $0.name == "日用品" })

        firstModel.setItemCategory(targetItem.id, categoryId: daily.id)
        await firstModel.save()
        #expect(firstModel.didSave && firstModel.error == nil)

        let editModel = KMReceiptModel()
        await editModel.load(repositories, receiptID: receipt.id, editing: true)
        let editedItem = try #require(editModel.items.first { $0.id == targetItem.id })
        editModel.setItemCategory(editedItem.id, categoryId: food.id)
        await editModel.save()
        #expect(editModel.didSave && editModel.error == nil)

        let rules = try await repositories.categoryLearning.categoryRules()
        let normalizedName = KMCategoryLearningService.normalizeName(targetItem.name)
        let updated = try #require(rules.first { $0.targetType == .item && $0.normalizedName == normalizedName })
        #expect(updated.categoryId == food.id)

        let nextLearning = KMReceiptPresentation.categoryLearning(
            merchant: "別の合成店舗",
            itemNames: [targetItem.name],
            rules: rules,
            categories: editModel.categories
        )
        #expect(nextLearning.itemCategoryIds == [food.id])
    }

    @Test func unsavedOrFailedManualItemCategoryDoesNotRegisterRule() async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        let receipt = try #require(try await repositories.receipts.receipts().first)
        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id)
        let targetItem = try #require(model.items.first)
        let daily = try #require(model.categories.first { $0.name == "日用品" })
        let normalizedName = KMCategoryLearningService.normalizeName(targetItem.name)

        // Manual edit without saving must not register a rule.
        model.setItemCategory(targetItem.id, categoryId: daily.id)
        let rulesBeforeSave = try await repositories.categoryLearning.categoryRules()
        #expect(!rulesBeforeSave.contains { $0.targetType == .item && $0.normalizedName == normalizedName })

        // Failed save (missing accountId) must not leave a rule behind either.
        model.accountId = ""
        await model.save()
        #expect(!model.didSave && model.error != nil)
        let rulesAfterFailedSave = try await repositories.categoryLearning.categoryRules()
        #expect(!rulesAfterFailedSave.contains { $0.targetType == .item && $0.normalizedName == normalizedName })
    }

    @Test func manualItemCategoryDoesNotReviveDisabledRule() async throws {
        try await expectSwitchedOffRuleStaysOff(disabled: true, deleted: nil)
    }

    @Test func manualItemCategoryDoesNotReviveDeletedRule() async throws {
        try await expectSwitchedOffRuleStaysOff(disabled: nil, deleted: true)
    }

    private func expectSwitchedOffRuleStaysOff(disabled: Bool?, deleted: Bool?) async throws {
        let repositories = try KMFixtureLoader.load(named: "receipt")
        let receipt = try #require(try await repositories.receipts.receipts().first)
        let model = KMReceiptModel()
        await model.load(repositories, receiptID: receipt.id)
        model.accountId = try #require(model.accounts.first?.id)
        let targetItem = try #require(model.items.first)
        let food = try #require(model.categories.first { $0.name == "食費" })
        let daily = try #require(model.categories.first { $0.name == "日用品" })
        let normalizedName = KMCategoryLearningService.normalizeName(targetItem.name)

        // The user switched this item rule off in settings before classifying by hand.
        try await repositories.categoryLearning.setCategoryRuleOverride(.init(
            targetType: .item, normalizedName: normalizedName, disabled: disabled, deleted: deleted, categoryId: food.id
        ))

        model.setItemCategory(targetItem.id, categoryId: daily.id)
        await model.save()
        #expect(model.didSave && model.error == nil)
        // The manual category still applies to this receipt.
        #expect(model.items.first { $0.id == targetItem.id }?.categoryId == daily.id)

        let rules = try await repositories.categoryLearning.categoryRules()
        let rule = try #require(rules.first { $0.targetType == .item && $0.normalizedName == normalizedName })
        #expect(rule.categoryId == food.id)
        #expect(!rule.enabled || rule.deleted)
        #expect(rule.deleted == (deleted == true))

        let nextLearning = KMReceiptPresentation.categoryLearning(
            merchant: "別の合成店舗", itemNames: [targetItem.name], rules: rules, categories: model.categories
        )
        #expect(nextLearning.itemCategoryIds == [nil])
    }
}

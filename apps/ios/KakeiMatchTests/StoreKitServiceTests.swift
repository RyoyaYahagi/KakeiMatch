import Foundation
import StoreKit
import StoreKitTest
import Synchronization
import Testing
@testable import KakeiMatch

private final class StoreKitTestBundleToken {}

private final class StoreKitAPIStub: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable {
        var status = 200
        var body: String
        var contentType = "application/json; charset=utf-8"
    }

    struct State: Sendable {
        var handler: @Sendable (URLRequest) throws -> Reply = { _ in throw URLError(.notConnectedToInternet) }
        var requests: [URLRequest] = []
    }

    static let state = Mutex(State())

    static func reset(_ handler: @escaping @Sendable (URLRequest) throws -> Reply) {
        state.withLock { $0 = State(handler: handler) }
    }

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
        do {
            let captured = try Self.materializedRequest(request)
            let handler = Self.state.withLock { state in
                state.requests.append(captured)
                return state.handler
            }
            let reply = try handler(captured)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: reply.status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": reply.contentType]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class StoreKitTestCredentials: KMCloudCredentialStore, Sendable {
    let values = Mutex<[String: Data]>([:])
    func read(_ key: String) -> Data? { values.withLock { $0[key] } }
    func write(_ data: Data?, key: String) { values.withLock { $0[key] = data } }
}

private final class StoreKitFakeAppAttest: KMAppAttesting {
    let isSupported: Bool
    init(isSupported: Bool = true) { self.isSupported = isSupported }
    func generateKey() async throws -> String { Data(repeating: 0x33, count: 32).base64EncodedString() }
    func attest(keyID _: String, clientDataHash _: Data) async throws -> Data { Data("attest".utf8) }
    func assertion(keyID _: String, clientDataHash _: Data) async throws -> Data { Data("assert".utf8) }
}

private actor FakeStoreKitService: KMStoreKitServicing {
    let sandbox: Bool
    var products: [KMStoreKitProduct]
    var purchaseOutcome: KMStoreKitPurchaseOutcome
    var entitlements: [KMStoreKitVerifiedTransaction]

    private(set) var isSandboxChecked = false
    private(set) var fetchCount = 0
    private(set) var finishedTransactionIDs: [UInt64] = []
    private(set) var observerStarted = false

    init(
        sandbox: Bool = true,
        products: [KMStoreKitProduct] = [
            KMStoreKitProduct(
                id: KMStoreKitConfiguration.proMonthlyProductID,
                displayName: "Pro プラン（月額）",
                description: "AI読み取りの月間上限を増やす月額プランです。",
                displayPrice: "¥480"
            )
        ],
        purchaseOutcome: KMStoreKitPurchaseOutcome = .purchased(
            KMStoreKitVerifiedTransaction(
                transactionID: 1001,
                productID: KMStoreKitConfiguration.proMonthlyProductID,
                jwsRepresentation: "header.payload.signature",
                isSandboxOrXcode: true
            )
        ),
        entitlements: [KMStoreKitVerifiedTransaction] = []
    ) {
        self.sandbox = sandbox
        self.products = products
        self.purchaseOutcome = purchaseOutcome
        self.entitlements = entitlements
    }

    func isSandboxEnvironment() async -> Bool {
        isSandboxChecked = true
        return sandbox
    }

    func fetchProducts() async throws -> [KMStoreKitProduct] {
        fetchCount += 1
        return products
    }

    func purchase(productID _: String) async throws -> KMStoreKitPurchaseOutcome {
        purchaseOutcome
    }

    func syncAndCollectEntitlements() async throws -> [KMStoreKitVerifiedTransaction] {
        entitlements
    }

    func currentEntitlements() async -> [KMStoreKitVerifiedTransaction] {
        entitlements
    }

    func finishTransaction(id: UInt64) async {
        finishedTransactionIDs.append(id)
    }

    func startObservingUpdates(onTransaction _: @escaping @Sendable (KMStoreKitVerifiedTransaction) async -> Void) {
        observerStarted = true
    }

    func stopObservingUpdates() {
        observerStarted = false
    }
}

@Suite(.serialized)
struct StoreKitAPIClientTests {
    private static let fixedNow = Date(timeIntervalSince1970: 1_764_000_000)
    private static let validGuestToken = String(repeating: "g", count: 43)
    private static let validAccountToken = String(repeating: "a", count: 43)

    private func makeAPI(
        credentials: StoreKitTestCredentials = StoreKitTestCredentials(),
        appAttestSupported: Bool = true
    ) throws -> KMWorkerAPI {
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [StoreKitAPIStub.self]
        let session = URLSession(configuration: sessionConfig)
        let config = try KMAPIConfiguration(baseURL: URL(string: "https://native.example.test")!)
        return KMWorkerAPI(
            configuration: config,
            session: session,
            credentials: credentials,
            appAttest: StoreKitFakeAppAttest(isSupported: appAttestSupported),
            now: { Self.fixedNow }
        )
    }

    private func seedSession(_ credentials: StoreKitTestCredentials, key: String, token: String) {
        let expiresAt = Int(Self.fixedNow.timeIntervalSince1970) + 3600
        let payload = Data(#"{"sessionToken":"\#(token)","expiresAt":\#(expiresAt)}"#.utf8)
        credentials.write(payload, key: key)
    }

    @Test func submitStoreKitTransactionPostsSignedTransactionInfoAndDecodesActiveResponse() async throws {
        let credentials = StoreKitTestCredentials()
        seedSession(credentials, key: "guest", token: Self.validGuestToken)
        let api = try makeAPI(credentials: credentials)
        StoreKitAPIStub.reset { request in
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/api/native/storekit/transactions")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Native \(Self.validGuestToken)")
            let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String]
            #expect(body == ["signedTransactionInfo": "aaa.bbb.ccc"])
            return .init(body: #"{"synced":true,"status":"active","expiresAt":1767225600,"productId":"jp.kakeimatch.pro.monthly"}"#)
        }

        let response = try await api.submitStoreKitTransaction(jws: "aaa.bbb.ccc")
        #expect(response == KMStoreKitTransactionResponse(
            synced: true,
            status: .active,
            expiresAt: 1_767_225_600,
            productId: KMStoreKitConfiguration.proMonthlyProductID
        ))
    }

    @Test(arguments: [
        ("stale_owner_transfer", KMStoreKitTransactionResponse.SkipReason.staleOwnerTransfer),
        ("owner_change_rate_limited", KMStoreKitTransactionResponse.SkipReason.ownerChangeRateLimited),
        ("stale_transaction", KMStoreKitTransactionResponse.SkipReason.staleTransaction),
    ])
    func submitStoreKitTransactionDecodesSkipReasons(rawReason: String, expected: KMStoreKitTransactionResponse.SkipReason) async throws {
        let credentials = StoreKitTestCredentials()
        seedSession(credentials, key: "guest", token: Self.validGuestToken)
        let api = try makeAPI(credentials: credentials)
        StoreKitAPIStub.reset { _ in
            .init(body: #"{"synced":false,"reason":"\#(rawReason)"}"#)
        }

        let response = try await api.submitStoreKitTransaction(jws: "aaa.bbb.ccc")
        #expect(response == KMStoreKitTransactionResponse(synced: false, reason: expected))
    }

    @Test func submitStoreKitTransactionRejectsInconsistentSyncedTrueWithReason() async throws {
        let credentials = StoreKitTestCredentials()
        seedSession(credentials, key: "guest", token: Self.validGuestToken)
        let api = try makeAPI(credentials: credentials)
        StoreKitAPIStub.reset { _ in
            .init(body: #"{"synced":true,"reason":"stale_transaction"}"#)
        }

        await #expect(throws: KMAPIError.invalidResponse) {
            _ = try await api.submitStoreKitTransaction(jws: "aaa.bbb.ccc")
        }
    }

    @Test(arguments: [
        (403, "invalid_jws", KMAPIError.storeKitInvalidJWS),
        (403, "environment_not_allowed", KMAPIError.storeKitEnvironmentNotAllowed),
        (403, "unsupported_ownership_type", KMAPIError.storeKitUnsupportedOwnershipType),
        (422, "unknown_product", KMAPIError.storeKitUnknownProduct),
        (503, "not_configured", KMAPIError.notConfigured),
    ])
    func submitStoreKitTransactionMapsWorkerErrorCodes(status: Int, code: String, expected: KMAPIError) async throws {
        let credentials = StoreKitTestCredentials()
        seedSession(credentials, key: "guest", token: Self.validGuestToken)
        let api = try makeAPI(credentials: credentials)
        StoreKitAPIStub.reset { _ in
            .init(status: status, body: #"{"error":"\#(code)"}"#)
        }

        await #expect(throws: expected) {
            _ = try await api.submitStoreKitTransaction(jws: "aaa.bbb.ccc")
        }
    }

    @Test func submitStoreKitTransactionRejectsEmptyAndOversizedJWSWithoutNetworkCall() async throws {
        let credentials = StoreKitTestCredentials()
        seedSession(credentials, key: "guest", token: Self.validGuestToken)
        let api = try makeAPI(credentials: credentials)
        StoreKitAPIStub.reset { _ in
            Issue.record("Network request should not be sent for invalid JWS")
            return .init(status: 500, body: #"{"error":"unexpected"}"#)
        }

        await #expect(throws: KMAPIError.invalidRequest) {
            _ = try await api.submitStoreKitTransaction(jws: "   ")
        }
        let oversized = String(repeating: "x", count: 48 * 1024 + 1)
        await #expect(throws: KMAPIError.invalidRequest) {
            _ = try await api.submitStoreKitTransaction(jws: oversized)
        }
    }

    @Test func submitStoreKitTransactionRequiresSessionAndFallsBackFromExpiredAccountToGuest() async throws {
        let emptyCredentials = StoreKitTestCredentials()
        let unauthenticatedAPI = try makeAPI(credentials: emptyCredentials)
        await #expect(throws: KMAPIError.nativeAuthenticationRequired) {
            _ = try await unauthenticatedAPI.submitStoreKitTransaction(jws: "aaa.bbb.ccc")
        }

        let credentials = StoreKitTestCredentials()
        seedSession(credentials, key: "session", token: Self.validAccountToken)
        seedSession(credentials, key: "guest", token: Self.validGuestToken)
        let api = try makeAPI(credentials: credentials)
        StoreKitAPIStub.reset { request in
            if request.value(forHTTPHeaderField: "Authorization") == "Native \(Self.validAccountToken)" {
                return .init(status: 401, body: #"{"error":"unauthorized"}"#)
            }
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Native \(Self.validGuestToken)")
            return .init(body: #"{"synced":true,"status":"active","expiresAt":null,"productId":"jp.kakeimatch.pro.monthly"}"#)
        }

        let response = try await api.submitStoreKitTransaction(jws: "aaa.bbb.ccc")
        #expect(response.synced == true)
        #expect(credentials.read("session") == nil)
    }
}

@MainActor
@Suite
struct StoreKitNativeAuthModelTests {
    @Test func featureFlagOffNeverShowsSectionOrTouchesStoreKit() async {
        let storeKit = FakeStoreKitService(sandbox: true)
        let model = KMNativeAuthModel(
            service: KMFakeNativeAuthService(initial: .guest),
            storeKit: storeKit,
            storeKitSandboxFlagEnabled: false
        )

        await model.loadStoreKitSandboxIfNeeded()

        #expect(model.showStoreKitSandboxSection == false)
        #expect(await storeKit.isSandboxChecked == false)
        #expect(await storeKit.fetchCount == 0)
        #expect(await storeKit.observerStarted == false)
    }

    @Test func featureFlagOnStillHidesSectionOutsideSandboxEnvironment() async {
        let storeKit = FakeStoreKitService(sandbox: false)
        let model = KMNativeAuthModel(
            service: KMFakeNativeAuthService(initial: .guest),
            storeKit: storeKit,
            storeKitSandboxFlagEnabled: true
        )

        await model.loadStoreKitSandboxIfNeeded()

        #expect(model.showStoreKitSandboxSection == false)
        #expect(await storeKit.isSandboxChecked == true)
        #expect(await storeKit.fetchCount == 0)
    }

    @Test func purchaseSubmitsJWSFinishesTransactionAndRefreshesUsage() async {
        let apiService = KMFakeNativeAuthService(initial: .guest)
        let storeKit = FakeStoreKitService(sandbox: true)
        let model = KMNativeAuthModel(
            service: apiService,
            storeKit: storeKit,
            storeKitSandboxFlagEnabled: true
        )

        await model.loadStoreKitSandboxIfNeeded()
        #expect(model.showStoreKitSandboxSection == true)
        #expect(model.storeKitProducts.map(\.id) == [KMStoreKitConfiguration.proMonthlyProductID])

        await model.purchaseStoreKitProduct(id: KMStoreKitConfiguration.proMonthlyProductID)

        #expect(await apiService.submittedStoreKitJWS == ["header.payload.signature"])
        #expect(await storeKit.finishedTransactionIDs == [1001])
        #expect(model.hasLoaded == true)
        #expect(model.storeKitErrorMessage == nil)
        #expect(model.storeKitStatusMessage != nil)
    }

    @Test func restoreSubmitsCurrentEntitlementsAndStartsGuestIfUnauthenticated() async {
        let apiService = KMFakeNativeAuthService(initial: .signedOut)
        let tx = KMStoreKitVerifiedTransaction(
            transactionID: 2002,
            productID: KMStoreKitConfiguration.proMonthlyProductID,
            jwsRepresentation: "restored.jws.token",
            isSandboxOrXcode: true
        )
        let storeKit = FakeStoreKitService(sandbox: true, entitlements: [tx])
        let model = KMNativeAuthModel(
            service: apiService,
            storeKit: storeKit,
            storeKitSandboxFlagEnabled: true
        )

        await model.loadStoreKitSandboxIfNeeded()
        await model.restoreStoreKitPurchases()

        #expect(await apiService.submittedStoreKitJWS == ["restored.jws.token"])
        #expect(await storeKit.finishedTransactionIDs == [2002])
        #expect(model.hasLoaded == true)
        #expect(model.storeKitErrorMessage == nil)
    }
}

@Suite(.serialized)
struct StoreKitLocalConfigurationTests {
    @Test func environmentGuardAllowsOnlySandboxAndXcode() {
        #expect(KMStoreKitEnvironmentGuard.isAllowed(.sandbox) == true)
        #expect(KMStoreKitEnvironmentGuard.isAllowed(.xcode) == true)
        #expect(KMStoreKitEnvironmentGuard.isAllowed(.production) == false)
    }

    @Test func localStoreKitSessionLoadsAndPurchasesProMonthlyProduct() async throws {
        let configURL = try #require(
            Bundle(for: StoreKitTestBundleToken.self)
                .url(forResource: "KakeiMatchSandbox", withExtension: "storekit")
        )
        let session = try SKTestSession(contentsOf: configURL)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()

        let service = KMStoreKitService()
        let products = try await service.fetchProducts()
        #expect(products.map(\.id) == [KMStoreKitConfiguration.proMonthlyProductID])

        let outcome = try await service.purchase(productID: KMStoreKitConfiguration.proMonthlyProductID)
        guard case .purchased(let transaction) = outcome else {
            Issue.record("Expected purchased outcome, got \(outcome)")
            return
        }
        #expect(transaction.productID == KMStoreKitConfiguration.proMonthlyProductID)
        #expect(!transaction.jwsRepresentation.isEmpty)
        #expect(transaction.isSandboxOrXcode == true)

        await service.finishTransaction(id: transaction.transactionID)

        let entitlements = await service.currentEntitlements()
        #expect(entitlements.contains(where: { $0.productID == KMStoreKitConfiguration.proMonthlyProductID }))
    }
}

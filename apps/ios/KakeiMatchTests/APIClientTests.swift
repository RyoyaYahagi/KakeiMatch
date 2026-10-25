import Foundation
import ImageIO
import Security
import Synchronization
import Testing
import UIKit
@testable import KakeiMatch

private final class APIStub: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable {
        var status = 200
        var body: String
        var contentType = "application/json; charset=utf-8"
        var headers: [String: String] = [:]
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
    override func startLoading() {
        do {
            let handler = Self.state.withLock { state in state.requests.append(request); return state.handler }
            let reply = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
                                           headerFields: reply.headers.merging(["Content-Type": reply.contentType], uniquingKeysWith: { _, new in new }))!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class APITestCredentials: KMCloudCredentialStore, Sendable {
    let values = Mutex<[String: Data]>([:])
    func read(_ key: String) -> Data? { values.withLock { $0[key] } }
    func write(_ data: Data?, key: String) { values.withLock { $0[key] = data } }
}

private final class FakeAppAttest: KMAppAttesting {
    let isSupported: Bool
    init(isSupported: Bool) { self.isSupported = isSupported }
    static let syntheticKeyID = Data(repeating: 0xa5, count: 32).base64EncodedString()
    let generatedKeyID = Data(repeating: 0xa5, count: 32).base64EncodedString()
    let hashes = Mutex<[Data]>([])
    func generateKey() async throws -> String { generatedKeyID }
    func attest(keyID: String, clientDataHash: Data) async throws -> Data {
        hashes.withLock { $0.append(clientDataHash) }; return Data("synthetic-attestation".utf8)
    }
    func assertion(keyID: String, clientDataHash: Data) async throws -> Data {
        hashes.withLock { $0.append(clientDataHash) }; return Data("synthetic-assertion".utf8)
    }
}

@MainActor
private final class StubPasskeyAuthorizer: KMPasskeyAuthorizing {
    let received = Mutex<(KMPasskeyKind, String, Data, Data?, String?, [Data]?)?>(nil)
    func perform(kind: KMPasskeyKind, relyingPartyID: String, challenge: Data, userID: Data?, username: String?, allowedCredentialIDs: [Data]?) async throws -> Data {
        received.withLock { $0 = (kind, relyingPartyID, challenge, userID, username, allowedCredentialIDs) }
        let response: [String: Any] = kind == .authenticate
            ? ["clientDataJSON": "Y2xpZW50", "authenticatorData": "YXV0aC", "signature": "c2ln", "userHandle": NSNull()]
            : ["clientDataJSON": "Y2xpZW50", "attestationObject": "YXR0ZXN0", "transports": ["internal"]]
        return try JSONSerialization.data(withJSONObject: ["id": "Y3JlZGVudGlhbA", "rawId": "Y3JlZGVudGlhbA", "type": "public-key",
            "response": response, "clientExtensionResults": [:]])
    }
}

private actor AsyncTestGate {
    private var entered = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var continuation: CheckedContinuation<Void, Never>?

    func suspend() async {
        entered = true
        entryWaiters.forEach { $0.resume() }
        entryWaiters.removeAll()
        await withCheckedContinuation { continuation = $0 }
    }

    func waitForEntry() async {
        if entered { return }
        await withCheckedContinuation { entryWaiters.append($0) }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private struct AttestCallCounts: Sendable {
    var generated = 0
    var attestations = 0
    var assertions = 0
}

private final class ControlledAppAttest: KMAppAttesting {
    let isSupported = true
    let generateGate: AsyncTestGate?
    let assertionGate: AsyncTestGate?
    init(generateGate: AsyncTestGate?, assertionGate: AsyncTestGate?) {
        self.generateGate = generateGate
        self.assertionGate = assertionGate
    }
    let counts = Mutex(AttestCallCounts())
    let hashes = Mutex<[Data]>([])
    let generatedKeyID = FakeAppAttest.syntheticKeyID

    func generateKey() async throws -> String {
        counts.withLock { $0.generated += 1 }
        if let generateGate { await generateGate.suspend() }
        return generatedKeyID
    }

    func attest(keyID: String, clientDataHash: Data) async throws -> Data {
        counts.withLock { $0.attestations += 1 }
        hashes.withLock { $0.append(clientDataHash) }
        return Data("synthetic-attestation".utf8)
    }

    func assertion(keyID: String, clientDataHash: Data) async throws -> Data {
        counts.withLock { $0.assertions += 1 }
        hashes.withLock { $0.append(clientDataHash) }
        if let assertionGate { await assertionGate.suspend() }
        return Data("synthetic-assertion".utf8)
    }
}

@MainActor
private final class DelayedPasskeyAuthorizer: KMPasskeyAuthorizing {
    let gate: AsyncTestGate
    init(gate: AsyncTestGate) { self.gate = gate }

    func perform(kind: KMPasskeyKind, relyingPartyID: String, challenge: Data, userID: Data?, username: String?, allowedCredentialIDs: [Data]?) async throws -> Data {
        await gate.suspend()
        return Data(#"{"id":"Y3JlZGVudGlhbA","rawId":"Y3JlZGVudGlhbA","type":"public-key","response":{"clientDataJSON":"Y2xpZW50","authenticatorData":"YXV0aC","signature":"c2ln","userHandle":null},"clientExtensionResults":{}}"#.utf8)
    }
}

@Suite(.serialized)
struct APIClientTests {
    private static let now = Date(timeIntervalSince1970: 1_800_000_000)
    private static let token = #"{"token":"header.payload.signature","expiresAt":1800000600}"#
    private static let receipt = #"{"documentKind":"receipt","merchant":null,"purchasedDate":null,"purchasedTime":null,"totalAmountYen":100,"taxAmountYen":null,"items":[],"warnings":[]}"#
    private static let payroll = #"{"extraction":{"documentKind":"pay_slip","employerName":null,"paymentDate":null,"payPeriod":null,"payType":"salary","grossPayYen":null,"netPayYen":null,"deductions":{"incomeTaxYen":null,"residentTaxYen":null,"healthInsuranceYen":null,"pensionYen":null,"employmentInsuranceYen":null,"otherYen":null,"totalYen":null},"allowances":[],"warnings":[]},"model":"synthetic-model","promptVersion":"payroll-v1"}"#
    private static let flow = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
    private static let options = [KMCategoryOption(id: "food", name: "合成カテゴリ")]

    enum Endpoint: String, CaseIterable, Sendable {
        case guestConfig, guestCreate, token, usage, costs, receipt, payroll, jev, suggestion, contact, transcribe, accountSession, passkeys, deletePasskey, signOut, delete
        var path: String {
            switch self {
            case .guestConfig, .guestCreate: "/api/ai/guest"
            case .token: "/api/ai/token"
            case .usage: "/api/ai/usage"
            case .costs: "/api/ai/costs"
            case .receipt: "/api/ai/gemini"
            case .payroll: "/api/ai/payroll"
            case .jev: "/api/ai/jev"
            case .suggestion: "/api/ai/category-suggestion"
            case .contact: "/api/contact"
            case .transcribe: "/api/contact/transcribe"
            case .accountSession: "/api/auth/get-session"
            case .passkeys: "/api/auth/passkey/list-user-passkeys"
            case .deletePasskey: "/api/auth/passkey/delete-passkey"
            case .signOut: "/api/auth/sign-out"
            case .delete: "/api/account/delete"
            }
        }
        var method: String {
            switch self { case .guestConfig, .usage, .costs, .accountSession, .passkeys: "GET"; case .delete: "DELETE"; default: "POST" }
        }
        var body: String {
            switch self {
            case .guestConfig: #"{"guestAvailable":true,"turnstileSiteKey":"public-site-key"}"#
            case .guestCreate: #"{"guestSecret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#
            case .token: APIClientTests.token
            case .usage: #"{"plan":"free","period":"month","month":"2027-01","used":1,"limit":30,"remaining":29}"#
            case .costs: #"{"month":"2027-01","currency":"USD","totalUsdMicros":0,"unknownRequests":0,"providers":{"gemini":{"requests":0,"inputTokens":0,"outputTokens":0,"costUsdMicros":0,"unknownRequests":0},"jev":{"requests":0,"inputTokens":0,"outputTokens":0,"costUsdMicros":0,"unknownRequests":0}}}"#
            case .receipt: APIClientTests.receipt
            case .payroll: APIClientTests.payroll
            case .jev: #"{"model":"synthetic-model","answers":{"category":{"type":"choice","choice":"food","confidence":1,"probabilities":{"food":1}}}}"#
            case .suggestion: #"{"categoryId":"food"}"#
            case .contact: #"{"feedbackId":"synthetic-feedback","kind":"bug","reply":"受け付けました。","issueUrl":null}"#
            case .transcribe: #"{"text":"合成の問い合わせです。"}"#
            case .accountSession: #"{"user":{"id":"synthetic-user","name":"合成利用者","email":"synthetic@example.test","emailVerified":false,"image":null,"createdAt":"2027-01-01T00:00:00Z","updatedAt":"2027-01-01T00:00:00Z"},"session":{"id":"synthetic-session","userId":"synthetic-user","token":"synthetic-token","expiresAt":"2027-01-25T00:00:00Z","createdAt":"2027-01-01T00:00:00Z","updatedAt":"2027-01-01T00:00:00Z","ipAddress":null,"userAgent":null}}"#
            case .passkeys: #"[{"id":"synthetic-key","name":"合成端末","publicKey":"synthetic-public-key","userId":"synthetic-user","credentialID":"synthetic-credential","counter":0,"deviceType":"multiDevice","backedUp":true,"transports":"internal","createdAt":"2027-01-01T00:00:00Z","aaguid":null}]"#
            case .deletePasskey: #"{"status":true}"#
            case .signOut: #"{"success":true}"#
            case .delete: #"{"deleted":true,"localHouseholdDataPreserved":true}"#
            }
        }
    }

    private func client(credentials: APITestCredentials = APITestCredentials(), native: Bool = false,
                        appAttest: (any KMAppAttesting)? = nil,
                        passkeyAuthorizer: (any KMPasskeyAuthorizing)? = nil,
                        clock: @escaping @Sendable () -> Date = { APIClientTests.now }) throws -> KMWorkerAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [APIStub.self]; config.httpCookieStorage = nil; config.urlCache = nil
        return KMWorkerAPI(configuration: try KMAPIConfiguration(baseURL: URL(string: "https://synthetic.example.test")!, originPolicy: native ? .native : .existingWorkerCompatibility),
                           session: URLSession(configuration: config), credentials: credentials, appAttest: appAttest, passkeyAuthorizer: passkeyAuthorizer, now: clock)
    }

    @MainActor
    private func perform(_ endpoint: Endpoint, client: KMWorkerAPI) async throws {
        switch endpoint {
        case .guestConfig: _ = try await client.guestConfiguration()
        case .guestCreate: try await client.createGuest(turnstileToken: "synthetic-single-use-check")
        case .token: _ = try await client.accessToken(allowGuest: false)
        case .usage: _ = try await client.usage()
        case .costs: _ = try await client.costs(month: KMYearMonth("2027-01"))
        case .receipt: _ = try await client.readReceipt(image: KMUploadImage(data: Data([0xff, 0xd8, 0xff]), contentType: "image/jpeg"), flowID: Self.flow)
        case .payroll:
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let image = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10), format: format).pngData { context in
                UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
            }
            let masked = try KMMaskedPayrollImage.prepare(data: image, contentType: "image/png", masks: [.init(x: 0, y: 0, width: 0.5, height: 0.5)], maskingConfirmed: true)
            _ = try await client.readPayroll(image: masked, flowID: Self.flow)
        case .jev:
            let extraction = try KMAPIValidation.decode(KMReceiptExtraction.self, data: Data(Self.receipt.replacingOccurrences(of: "\"merchant\":null", with: "\"merchant\":\"合成店\"").utf8), shape: KMAPIShapes.receipt)
            _ = try await client.classify(extraction: extraction, flowID: Self.flow, categories: Self.options)
        case .suggestion: _ = try await client.suggestCategory(sourceCategoryName: "合成分類", categories: Self.options, flowID: Self.flow)
        case .contact: _ = try await client.submitContact(kind: .bug, message: "合成の問い合わせです。", flowID: Self.flow)
        case .transcribe: _ = try await client.transcribe(audio: KMUploadAudio(data: Data([0, 0, 0, 0] + Array("ftyp".utf8)), contentType: "audio/mp4"), flowID: Self.flow)
        case .accountSession: _ = try await client.accountSession()
        case .passkeys: _ = try await client.listPasskeys()
        case .deletePasskey: try await client.deletePasskey(id: "synthetic-key")
        case .signOut: try await client.signOut()
        case .delete: _ = try await client.deleteAccount()
        }
    }

    @Test(arguments: Endpoint.allCases)
    @MainActor
    func endpointsAcceptValidWireResponses(endpoint: Endpoint) async throws {
        APIStub.reset { request in
            if request.url?.path == endpoint.path {
                #expect(request.httpMethod == endpoint.method)
                #expect(request.value(forHTTPHeaderField: "Origin") == "https://synthetic.example.test")
                #expect(request.httpShouldHandleCookies == false)
                return .init(status: endpoint == .guestCreate ? 201 : 200, body: endpoint.body)
            }
            #expect(request.url?.path == "/api/ai/token")
            return .init(body: Self.token)
        }
        try await perform(endpoint, client: client())
    }

    @Test(arguments: Endpoint.allCases)
    @MainActor
    func allEndpointsRejectMalformedResponses(endpoint: Endpoint) async throws {
        var invalidBodies = ["{}", "null", "[]", "not-json", String(endpoint.body.dropLast()) + ",\"unknown\":true}"]
        if endpoint == .accountSession { invalidBodies.removeAll { $0 == "null" } }
        if endpoint == .passkeys { invalidBodies.removeAll { $0 == "[]" } }
        for invalid in invalidBodies {
            APIStub.reset { request in .init(body: request.url?.path == endpoint.path ? String(invalid) : Self.token) }
            await #expect(throws: KMAPIError.invalidResponse) { try await perform(endpoint, client: client()) }
        }
    }

    @Test(arguments: Endpoint.allCases)
    @MainActor
    func errorsKeepPWACategories(endpoint: Endpoint) async throws {
        let failures: [(Int, String, KMAPIError)] = [
            (401, "unauthorized", .authenticationRequired), (429, "ai_quota_exceeded", .quotaExceeded),
            (503, "ai_temporarily_paused", .aiTemporarilyPaused), (429, "rate_limited", .rateLimited),
            (502, "invalid_provider_response", .invalidResponse), (409, "invalid_flow", .invalidFlow),
            (403, "forbidden_origin", .forbiddenOrigin), (504, "provider_timeout", .providerTimeout),
            (503, "not_configured", .notConfigured)
        ]
        for (status, code, expected) in failures {
            APIStub.reset { request in
                request.url?.path == endpoint.path ? .init(status: status, body: "{\"error\":\"\(code)\"}") : .init(body: Self.token)
            }
            await #expect(throws: expected) { try await perform(endpoint, client: client()) }
        }
    }

    @Test
    func betterAuthFailuresAndUnknownErrorsDoNotExposeMessages() async throws {
        let api = try client()
        APIStub.reset { _ in .init(status: 401, body: #"{"code":"UNAUTHORIZED","message":"synthetic private detail"}"#) }
        await #expect(throws: KMAPIError.authenticationRequired) { _ = try await api.accountSession() }
        APIStub.reset { _ in .init(status: 503, body: #"{"error":"synthetic_private_detail"}"#) }
        await #expect(throws: KMAPIError.server(status: 503, code: nil)) { _ = try await api.guestConfiguration() }
        APIStub.reset { _ in .init(status: 503, body: #"{"error":"not_configured","unknown":true}"#) }
        await #expect(throws: KMAPIError.invalidResponse) { _ = try await api.guestConfiguration() }
    }

    @Test
    func nativeConfigurationSendsNeitherOriginNorCookies() async throws {
        APIStub.reset { request in
            #expect(request.url?.path == "/api/native/config")
            #expect(request.value(forHTTPHeaderField: "Origin") == nil)
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
        }
        let api = try client(native: true)
        let configuration = try await api.nativeConfiguration()
        #expect(configuration.available)
        #expect(configuration.rpId == "synthetic.example.test")
    }

    @Test
    func nativeNeverFallsBackToTurnstileOrFakeCredentials() async throws {
        let api = try client(native: true)
        await #expect(throws: KMAPIError.nativeUnsupported) { _ = try await api.guestConfiguration() }
        await #expect(throws: KMAPIError.nativeUnsupported) { try await api.createGuest(turnstileToken: "fake") }
        #expect(APIStub.state.withLock { $0.requests.isEmpty })
    }

    @Test
    func nativeSignOutAndAccountDeletionClearAccountButPreserveGuestCredential() async throws {
        let store = APITestCredentials()
        let session = #"{"sessionToken":""# + String(repeating: "A", count: 43) + #"","expiresAt":1800001000}"#
        let guest = #"{"sessionToken":""# + String(repeating: "G", count: 43) + #"","expiresAt":1800001000}"#
        store.write(Data(session.utf8), key: "session")
        store.write(Data(guest.utf8), key: "guest")
        APIStub.reset { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Native " + String(repeating: "A", count: 43))
            #expect(request.value(forHTTPHeaderField: "Origin") == nil)
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            if request.url?.path == "/api/native/auth/sign-out" { return .init(body: #"{"success":true}"#) }
            if request.url?.path == "/api/native/account/delete" { return .init(body: #"{"deleted":true,"localHouseholdDataPreserved":true}"#) }
            throw URLError(.badServerResponse)
        }
        let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: true))
        try await api.signOut()
        #expect(store.read("session") == nil)
        #expect(store.read("guest") == Data(guest.utf8))
        store.write(Data(session.utf8), key: "session")
        let deletion = try await api.deleteAccount()
        #expect(deletion.localHouseholdDataPreserved)
        #expect(store.read("session") == nil)
        #expect(store.read("guest") == Data(guest.utf8))
    }

    @Test
    func nativeContactRequiresAccountSessionAndKeepsOpaqueTokenBearer() async throws {
        let store = APITestCredentials()
        let accountSession = #"{"sessionToken":""# + String(repeating: "A", count: 43) + #"","expiresAt":1800001000}"#
        store.write(Data(accountSession.utf8), key: "session")
        store.write(Data(FakeAppAttest.syntheticKeyID.utf8), key: "app-attest-key-id")
        store.write(Data([1]), key: "app-attest-registered")
        let challenge = KMNativeCrypto.base64URL(Data(repeating: 3, count: 32))
        APIStub.reset { request in
            #expect(request.value(forHTTPHeaderField: "Origin") == nil)
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            switch request.url?.path {
            case "/api/native/config":
                return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
            case "/api/native/challenge":
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Native " + String(repeating: "A", count: 43))
                #expect(try JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any] != nil)
                return .init(body: #"{"challengeId":"00000000-0000-4000-8000-000000000005","challenge":""# + challenge + #"","expiresAt":1800000060}"#)
            case "/api/native/ai/token":
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Native " + String(repeating: "A", count: 43))
                return .init(body: #"{"token":""# + String(repeating: "T", count: 43) + #"","expiresAt":1800000500}"#)
            case "/api/native/contact":
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer " + String(repeating: "T", count: 43))
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                #expect(body["message"] as? String == "synthetic contact")
                return .init(body: #"{"feedbackId":"synthetic-feedback","kind":"bug","reply":"受け付けました。","issueUrl":null}"#)
            default: throw URLError(.badServerResponse)
            }
        }
        let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: true))
        let result = try await api.submitContact(kind: .bug, message: "synthetic contact", flowID: Self.flow)
        #expect(result.kind == .bug)
        #expect(APIStub.state.withLock { $0.requests.map { $0.url!.path } } == [
            "/api/native/config", "/api/native/challenge", "/api/native/ai/token", "/api/native/contact"
        ])
    }

    @Test
    func guestSessionCannotUseAccountOnlyContactAPI() async throws {
        let store = APITestCredentials()
        let guestSession = #"{"sessionToken":""# + String(repeating: "G", count: 43) + #"","expiresAt":1800001000}"#
        store.write(Data(guestSession.utf8), key: "guest")
        APIStub.reset { _ in throw URLError(.badServerResponse) }
        let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: true))
        await #expect(throws: KMAPIError.nativeAuthenticationRequired) {
            _ = try await api.submitContact(kind: .question, message: "synthetic", flowID: Self.flow)
        }
        #expect(APIStub.state.withLock { $0.requests.isEmpty })
    }

    @Test
    func nativeAccountChallenge401UsesOnlyExplicitSavedGuestFallback() async throws {
        let accountSession = #"{"sessionToken":""# + String(repeating: "A", count: 43) + #"","expiresAt":1800001000}"#
        let guestSession = #"{"sessionToken":""# + String(repeating: "G", count: 43) + #"","expiresAt":1800001000}"#
        let challenge = KMNativeCrypto.base64URL(Data(repeating: 4, count: 32))

        for allowGuest in [true, false] {
            let store = APITestCredentials()
            store.write(Data(accountSession.utf8), key: "session")
            store.write(Data(guestSession.utf8), key: "guest")
            store.write(Data(FakeAppAttest.syntheticKeyID.utf8), key: "app-attest-key-id")
            store.write(Data([1]), key: "app-attest-registered")
            APIStub.reset { request in
                switch request.url?.path {
                case "/api/native/config":
                    return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
                case "/api/native/challenge":
                    if request.value(forHTTPHeaderField: "Authorization") == "Native " + String(repeating: "A", count: 43) {
                        return .init(status: 401, body: #"{"error":"unauthorized"}"#)
                    }
                    #expect(request.value(forHTTPHeaderField: "Authorization") == "Native " + String(repeating: "G", count: 43))
                    return .init(body: #"{"challengeId":"00000000-0000-4000-8000-000000000006","challenge":""# + challenge + #"","expiresAt":1800000060}"#)
                case "/api/native/ai/token":
                    #expect(request.value(forHTTPHeaderField: "Authorization") == "Native " + String(repeating: "G", count: 43))
                    return .init(body: #"{"token":""# + String(repeating: "T", count: 43) + #"","expiresAt":1800000500}"#)
                default: throw URLError(.badServerResponse)
                }
            }
            let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: true))
            if allowGuest {
                #expect(try await api.accessToken(allowGuest: true) == String(repeating: "T", count: 43))
                #expect(store.read("guest") == Data(guestSession.utf8))
                #expect(APIStub.state.withLock { $0.requests.filter { $0.url?.path == "/api/native/challenge" }.count } == 2)
            } else {
                await #expect(throws: KMAPIError.nativeAuthenticationRequired) {
                    _ = try await api.accessToken(allowGuest: false)
                }
                #expect(APIStub.state.withLock { $0.requests.filter { $0.url?.path == "/api/native/challenge" }.count } == 1)
            }
            #expect(store.read("session") == nil)
        }
    }

    @Test
    func nativeGuestUsageReadsOnlyOpaqueNativeSessionFormat() async throws {
        let store = APITestCredentials()
        let guestSession = #"{"sessionToken":""# + String(repeating: "G", count: 43) + #"","expiresAt":1800001000}"#
        store.write(Data(guestSession.utf8), key: "guest")
        APIStub.reset { request in
            #expect(request.url?.path == "/api/native/ai/usage")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Native " + String(repeating: "G", count: 43))
            #expect(request.value(forHTTPHeaderField: "Origin") == nil)
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            return .init(body: #"{"plan":"guest","period":"day","day":"2027-01-15","used":1,"limit":5,"remaining":4}"#)
        }
        let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: true))
        #expect(try await api.usage(as: .guest).remaining == 4)

        store.write(Data(String(repeating: "R", count: 43).utf8), key: "guest")
        APIStub.reset { _ in Issue.record("Legacy raw guest secret must not reach a native endpoint"); throw URLError(.badServerResponse) }
        await #expect(throws: KMAPIError.credentialStorage) { _ = try await api.usage(as: .guest) }
        #expect(APIStub.state.withLock { $0.requests.isEmpty })
    }

    @Test
    func nativeConfigurationRejectsUnknownFieldsAndInconsistentUnavailableState() async throws {
        let api = try client(native: true)
        for response in [
            #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development","unexpected":true}"#,
            #"{"available":false,"rpId":"synthetic.example.test","appAttestEnvironment":null}"#
        ] {
            APIStub.reset { _ in .init(body: response) }
            await #expect(throws: KMAPIError.invalidResponse) { _ = try await api.nativeConfiguration() }
        }
    }

    @Test
    func expiredNativeChallengeStopsBeforeAttestation() async throws {
        let appAttest = FakeAppAttest(isSupported: true)
        APIStub.reset { request in
            if request.url?.path == "/api/native/config" {
                return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
            }
            return .init(body: #"{"challengeId":"00000000-0000-4000-8000-000000000004","challenge":""# + KMNativeCrypto.base64URL(Data(repeating: 1, count: 32)) + #"","expiresAt":1799999999}"#)
        }
        let api = try client(native: true, appAttest: appAttest)
        await #expect(throws: KMAPIError.invalidResponse) { try await api.createNativeGuest() }
        #expect(appAttest.hashes.withLock { $0.isEmpty })
        #expect(APIStub.state.withLock { $0.requests.map { $0.url!.path } } == ["/api/native/config", "/api/native/challenge"])
    }

    @Test
    func unsupportedAppAttestStopsBeforeCreatingGuestCredentials() async throws {
        APIStub.reset { request in
            #expect(request.url?.path == "/api/native/config")
            return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
        }
        let store = APITestCredentials()
        let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: false))
        await #expect(throws: KMAPIError.nativeUnsupported) { try await api.createNativeGuest() }
        #expect(APIStub.state.withLock { $0.requests.count } == 1)
        #expect(store.read("guest") == nil)
        #expect(store.read("app-attest-key-id") == nil)
    }

    @Test
    func invalidPersistedAppAttestKeyIDIsRejectedAsCredentialCorruption() async throws {
        let store = APITestCredentials()
        store.write(Data("AQID".utf8), key: "app-attest-key-id")
        store.write(Data([1]), key: "app-attest-registered")
        APIStub.reset { request in
            #expect(request.url?.path == "/api/native/config")
            return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
        }
        let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: true))
        await #expect(throws: KMAPIError.credentialStorage) { _ = try await api.ensureNativeAttested() }
        #expect(APIStub.state.withLock { $0.requests.map { $0.url!.path } } == ["/api/native/config"])
    }

    @Test
    func concurrentNativeAttestationEnsuresShareOneEnrollment() async throws {
        let gate = AsyncTestGate()
        let appAttest = ControlledAppAttest(generateGate: gate, assertionGate: nil)
        let challenge = KMNativeCrypto.base64URL(Data(repeating: 2, count: 32))
        APIStub.reset { request in
            switch request.url?.path {
            case "/api/native/config":
                return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
            case "/api/native/challenge":
                return .init(body: #"{"challengeId":"00000000-0000-4000-8000-000000000008","challenge":""# + challenge + #"","expiresAt":1800000060}"#)
            case "/api/native/attest":
                return .init(body: #"{"registered":true}"#)
            default: throw URLError(.badServerResponse)
            }
        }
        let api = try client(native: true, appAttest: appAttest)
        let first = Task { try await api.ensureNativeAttested() }
        await gate.waitForEntry()
        let second = Task { try await api.ensureNativeAttested() }
        for _ in 0..<10 { await Task.yield() }
        await gate.release()
        #expect(try await first.value == FakeAppAttest.syntheticKeyID)
        #expect(try await second.value == FakeAppAttest.syntheticKeyID)
        #expect(appAttest.counts.withLock { $0.generated } == 1)
        #expect(appAttest.counts.withLock { $0.attestations } == 1)
        #expect(APIStub.state.withLock { $0.requests.filter { $0.url?.path == "/api/native/config" }.count } == 1)
    }

    @Test
    func logoutRevisionPreventsLateAppAttestKeyPersistence() async throws {
        let gate = AsyncTestGate()
        let appAttest = ControlledAppAttest(generateGate: gate, assertionGate: nil)
        APIStub.reset { _ in
            .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
        }
        let store = APITestCredentials()
        let api = try client(credentials: store, native: true, appAttest: appAttest)
        let enrollment = Task { try await api.ensureNativeAttested() }
        await gate.waitForEntry()
        try await api.clearAccessToken()
        await gate.release()
        await #expect(throws: CancellationError.self) { _ = try await enrollment.value }
        #expect(store.read("app-attest-key-id") == nil)
        #expect(store.read("app-attest-registered") == nil)
        #expect(appAttest.counts.withLock { $0.attestations } == 0)
    }

    @Test
    func logoutRevisionPreventsLateNativeGuestCreation() async throws {
        let gate = AsyncTestGate()
        let appAttest = ControlledAppAttest(generateGate: nil, assertionGate: gate)
        let challenge = KMNativeCrypto.base64URL(Data(repeating: 6, count: 32))
        let store = APITestCredentials()
        store.write(Data(FakeAppAttest.syntheticKeyID.utf8), key: "app-attest-key-id")
        store.write(Data([1]), key: "app-attest-registered")
        APIStub.reset { request in
            if request.url?.path == "/api/native/config" {
                return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
            }
            #expect(request.url?.path == "/api/native/challenge")
            return .init(body: #"{"challengeId":"00000000-0000-4000-8000-000000000009","challenge":""# + challenge + #"","expiresAt":1800000060}"#)
        }
        let api = try client(credentials: store, native: true, appAttest: appAttest)
        let creation = Task { try await api.createNativeGuest() }
        await gate.waitForEntry()
        try await api.clearAccessToken()
        await gate.release()
        await #expect(throws: CancellationError.self) { try await creation.value }
        #expect(store.read("guest") == nil)
        #expect(APIStub.state.withLock { $0.requests.map { $0.url!.path } } == ["/api/native/config", "/api/native/challenge"])
    }

    @Test
    @MainActor
    func logoutRevisionPreventsLatePasskeySessionPersistence() async throws {
        let gate = AsyncTestGate()
        let challenge = KMNativeCrypto.base64URL(Data(repeating: 10, count: 32))
        let store = APITestCredentials()
        store.write(Data(FakeAppAttest.syntheticKeyID.utf8), key: "app-attest-key-id")
        store.write(Data([1]), key: "app-attest-registered")
        let passkey = DelayedPasskeyAuthorizer(gate: gate)
        APIStub.reset { request in
            switch request.url?.path {
            case "/api/native/config":
                return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
            case "/api/native/passkey/options":
                return .init(body: #"{"ceremonyId":"00000000-0000-4000-8000-000000000010","options":{"challenge":""# + challenge + #"","rpId":"synthetic.example.test"}}"#)
            default: throw URLError(.badServerResponse)
            }
        }
        let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: true), passkeyAuthorizer: passkey)
        let authentication = Task { try await api.performNativePasskey(kind: .authenticate) }
        await gate.waitForEntry()
        try await api.clearAccessToken()
        await gate.release()
        await #expect(throws: CancellationError.self) { try await authentication.value }
        #expect(store.read("session") == nil)
        #expect(APIStub.state.withLock { $0.requests.map { $0.url!.path } } == ["/api/native/config", "/api/native/passkey/options"])
    }

    @Test
    @MainActor
    func nativePasskeyAuthenticationUsesDecodedChallengeAndStoresOnlyNativeSession() async throws {
        let challenge = Data(repeating: 9, count: 32)
        let challengeText = KMNativeCrypto.base64URL(challenge)
        let attest = FakeAppAttest(isSupported: true)
        let store = APITestCredentials()
        store.write(Data(FakeAppAttest.syntheticKeyID.utf8), key: "app-attest-key-id")
        store.write(Data([1]), key: "app-attest-registered")
        let passkey = StubPasskeyAuthorizer()
        APIStub.reset { request in
            #expect(request.value(forHTTPHeaderField: "Origin") == nil)
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            switch request.url?.path {
            case "/api/native/config":
                return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
            case "/api/native/passkey/options":
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                return .init(body: #"{"ceremonyId":"00000000-0000-4000-8000-000000000002","options":{"challenge":""# + challengeText + #"","rpId":"synthetic.example.test","allowCredentials":[{"id":"AQID","type":"public-key"}]}}"#)
            case "/api/native/passkey/verify":
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                #expect(body["ceremonyId"] as? String == "00000000-0000-4000-8000-000000000002")
                #expect(body["assertion"] as? String == Data("synthetic-assertion".utf8).base64EncodedString())
                return .init(body: #"{"sessionToken":""# + String(repeating: "A", count: 43) + #"","expiresAt":1800001000}"#)
            default: throw URLError(.badServerResponse)
            }
        }
        let api = try client(credentials: store, native: true, appAttest: attest, passkeyAuthorizer: passkey)
        try await api.performNativePasskey(kind: .authenticate)
        let captured = try #require(passkey.received.withLock { $0 })
        #expect(captured.0 == .authenticate)
        #expect(captured.1 == "synthetic.example.test")
        #expect(captured.2 == challenge)
        #expect(captured.3 == nil)
        #expect(captured.4 == nil)
        #expect(captured.5 == [Data([1, 2, 3])])
        #expect(try store.read("session") != nil)
        #expect(try store.read("guest") == nil)
        #expect(attest.hashes.withLock { $0 } == [Data(SHA256.hash(data: challenge))])
    }

    @Test
    @MainActor
    func nativePasskeyAuthenticationPreservesAnExplicitEmptyAllowList() async throws {
        let challenge = KMNativeCrypto.base64URL(Data(repeating: 11, count: 32))
        let store = APITestCredentials()
        store.write(Data(FakeAppAttest.syntheticKeyID.utf8), key: "app-attest-key-id")
        store.write(Data([1]), key: "app-attest-registered")
        let passkey = StubPasskeyAuthorizer()
        APIStub.reset { request in
            switch request.url?.path {
            case "/api/native/config":
                return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
            case "/api/native/passkey/options":
                return .init(body: #"{"ceremonyId":"00000000-0000-4000-8000-000000000011","options":{"challenge":""# + challenge + #"","rpId":"synthetic.example.test","allowCredentials":[]}}"#)
            case "/api/native/passkey/verify":
                return .init(body: #"{"sessionToken":""# + String(repeating: "A", count: 43) + #"","expiresAt":1800001000}"#)
            default: throw URLError(.badServerResponse)
            }
        }
        let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: true), passkeyAuthorizer: passkey)
        try await api.performNativePasskey(kind: .authenticate)
        let captured = try #require(passkey.received.withLock { $0 })
        #expect(captured.5 == [])
    }

    @Test
    @MainActor
    func nativePasskeyOptionsRequireCanonical32ByteChallengeAndExplicitRelyingParty() async throws {
        let validChallenge = KMNativeCrypto.base64URL(Data(repeating: 8, count: 32))
        let shortChallenge = KMNativeCrypto.base64URL(Data(repeating: 8, count: 31))
        let invalidOptions = [
            #"{"challenge":""# + validChallenge + #""}"#,
            #"{"challenge":""# + shortChallenge + #"","rpId":"synthetic.example.test"}"#,
            #"{"challenge":"AB","rpId":"synthetic.example.test"}"#,
            #"{"challenge":""# + validChallenge + #"","rp":{}}"#,
            #"{"challenge":""# + validChallenge + #"","rpId":"synthetic.example.test","rp":{"id":"other.example.test"}}"#
        ]
        let store = APITestCredentials()
        store.write(Data(FakeAppAttest.syntheticKeyID.utf8), key: "app-attest-key-id")
        store.write(Data([1]), key: "app-attest-registered")
        let passkey = StubPasskeyAuthorizer()
        let api = try client(credentials: store, native: true, appAttest: FakeAppAttest(isSupported: true), passkeyAuthorizer: passkey)
        for options in invalidOptions {
            let response = #"{"ceremonyId":"00000000-0000-4000-8000-000000000007","options":"# + options + "}"
            APIStub.reset { request in
                request.url?.path == "/api/native/config"
                    ? .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
                    : .init(body: response)
            }
            await #expect(throws: KMAPIError.invalidResponse) {
                try await api.performNativePasskey(kind: .authenticate)
            }
        }
        #expect(passkey.received.withLock { $0 } == nil)
    }

    @Test
    @MainActor
    func nativeInvitationPasskeyRegistrationUsesDecodedUserIDAndNoCookieJar() async throws {
        let challenge = KMNativeCrypto.base64URL(Data(repeating: 5, count: 32))
        let attest = FakeAppAttest(isSupported: true)
        let store = APITestCredentials()
        store.write(Data(FakeAppAttest.syntheticKeyID.utf8), key: "app-attest-key-id")
        store.write(Data([1]), key: "app-attest-registered")
        let passkey = StubPasskeyAuthorizer()
        APIStub.reset { request in
            #expect(request.value(forHTTPHeaderField: "Origin") == nil)
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            switch request.url?.path {
            case "/api/native/config":
                return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
            case "/api/native/passkey/options":
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                #expect(body["kind"] as? String == "register")
                #expect(body["context"] as? String == "synthetic-invite")
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                return .init(body: #"{"ceremonyId":"00000000-0000-4000-8000-000000000003","options":{"challenge":""# + challenge + #"","rp":{"id":"synthetic.example.test","name":"KakeiMatch"},"user":{"id":"AQID","name":"synthetic-user","displayName":"合成利用者"},"pubKeyCredParams":[]}}"#)
            case "/api/native/passkey/verify":
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                return .init(body: #"{"sessionToken":""# + String(repeating: "R", count: 43) + #"","expiresAt":1800001000}"#)
            default: throw URLError(.badServerResponse)
            }
        }
        let api = try client(credentials: store, native: true, appAttest: attest, passkeyAuthorizer: passkey)
        try await api.performNativePasskey(kind: .register, context: "synthetic-invite", name: "合成Passkey")
        let captured = try #require(passkey.received.withLock { $0 })
        #expect(captured.0 == .register)
        #expect(captured.2 == Data(repeating: 5, count: 32))
        #expect(captured.3 == Data([1, 2, 3]))
        #expect(captured.4 == "synthetic-user")
        #expect(captured.5 == nil)
        #expect(try store.read("session") != nil)
        #expect(attest.hashes.withLock { $0 } == [Data(SHA256.hash(data: Data(repeating: 5, count: 32)))])
    }

    @Test
    @MainActor
    func nativeGuestAndAITokenUseAppAttestAndKeepCredentialsBoundToHost() async throws {
        let appAttest = FakeAppAttest(isSupported: true)
        let challengeText = KMNativeCrypto.base64URL(Data(repeating: 7, count: 32))
        APIStub.reset { request in
            #expect(request.value(forHTTPHeaderField: "Origin") == nil)
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            switch request.url?.path {
            case "/api/native/config":
                return .init(body: #"{"available":true,"rpId":"synthetic.example.test","appAttestEnvironment":"development"}"#)
            case "/api/native/challenge":
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                let purpose = body["purpose"] as! String
                if purpose == "token" { #expect(request.value(forHTTPHeaderField: "Authorization") == "Native " + String(repeating: "S", count: 43)) }
                else { #expect(request.value(forHTTPHeaderField: "Authorization") == nil) }
                return .init(body: #"{"challengeId":"00000000-0000-4000-8000-000000000001","challenge":""# + challengeText + #"","expiresAt":1800000060}"#)
            case "/api/native/attest":
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                #expect(body["keyId"] as? String == appAttest.generatedKeyID)
                return .init(body: #"{"registered":true}"#)
            case "/api/native/guest":
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                return .init(status: 201, body: #"{"sessionToken":""# + String(repeating: "S", count: 43) + #"","expiresAt":1800001000}"#)
            case "/api/native/ai/token":
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Native " + String(repeating: "S", count: 43))
                return .init(body: #"{"token":""# + String(repeating: "T", count: 43) + #"","expiresAt":1800000500}"#)
            case "/api/native/ai/gemini":
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer " + String(repeating: "T", count: 43))
                return .init(body: Self.receipt)
            default: throw URLError(.badServerResponse)
            }
        }
        let api = try client(native: true, appAttest: appAttest)
        try await api.createNativeGuest()
        #expect(try await api.accessToken() == String(repeating: "T", count: 43))
        #expect(store.read("ai-token") == nil)
        _ = try await api.readReceipt(image: KMUploadImage(data: Data([0xff, 0xd8, 0xff]), contentType: "image/jpeg"), flowID: Self.flow)
        #expect(appAttest.hashes.withLock { $0.count } == 3)
        #expect(APIStub.state.withLock { $0.requests.map { $0.url!.path } } == [
            "/api/native/config", "/api/native/challenge", "/api/native/attest",
            "/api/native/challenge", "/api/native/guest", "/api/native/config", "/api/native/challenge",
            "/api/native/ai/token", "/api/native/ai/gemini"
        ])
    }

    @Test
    func networkAndInvalidContentTypesStayDistinct() async throws {
        APIStub.reset { _ in throw URLError(.notConnectedToInternet) }
        let api = try client()
        await #expect(throws: KMAPIError.network) { _ = try await api.guestConfiguration() }
        APIStub.reset { _ in .init(body: Endpoint.guestConfig.body, contentType: "text/html") }
        await #expect(throws: KMAPIError.invalidResponse) { _ = try await api.guestConfiguration() }
    }

    @Test
    func tokenRefreshesAtThirtySecondsAndNeverRestoresFromDisk() async throws {
        let clock = Mutex(Self.now)
        let store = APITestCredentials()
        APIStub.reset { _ in .init(body: Self.token) }
        let api = try client(credentials: store, clock: { clock.withLock { $0 } })
        _ = try await api.accessToken(allowGuest: false)
        _ = try await api.accessToken(allowGuest: false)
        #expect(APIStub.state.withLock { $0.requests.count } == 1)
        #expect(store.read("ai-token") != nil)
        clock.withLock { $0 = Self.now.addingTimeInterval(570) }
        _ = try await api.accessToken(allowGuest: false)
        #expect(APIStub.state.withLock { $0.requests.count } == 2)
        let relaunched = try client(credentials: store)
        _ = try await relaunched.accessToken(allowGuest: false)
        #expect(APIStub.state.withLock { $0.requests.count } == 3)
        try await api.clearAccessToken()
        #expect(store.read("ai-token") == nil)
    }

    @Test
    func guestFallbackIsExplicitAndAccountOnlyDoesNotReuseIt() async throws {
        let store = APITestCredentials()
        store.write(Data(String(repeating: "A", count: 43).utf8), key: "guest")
        APIStub.reset { request in
            if request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Guest ") == true { return .init(body: Self.token) }
            return .init(status: 401, body: #"{"error":"unauthorized"}"#)
        }
        let api = try client(credentials: store)
        _ = try await api.accessToken()
        #expect(await api.currentIdentity() == .guest)
        await #expect(throws: KMAPIError.authenticationRequired) { _ = try await api.accessToken(allowGuest: false) }
    }

    @Test
    func sessionCookiesAreOriginScopedAndClearedWithoutGuestOrHouseholdDeletion() async throws {
        let store = APITestCredentials()
        store.write(Data("guest-is-not-an-account".utf8), key: "guest")
        let api = try client(credentials: store)
        try await api.installAccountSession(value: "synthetic.session", expiresAt: Self.now.addingTimeInterval(600))
        APIStub.reset { request in
            #expect(request.value(forHTTPHeaderField: "Cookie") == "__Secure-better-auth.session_token=synthetic.session")
            return .init(body: Endpoint.delete.body)
        }
        _ = try await api.deleteAccount()
        #expect(store.read("session") == nil)
        #expect(store.read("guest") != nil)
        #expect(try KMAPIConfiguration(baseURL: KMAPIConfiguration.productionURL).credentialService != KMAPIConfiguration(baseURL: URL(string: "https://preview.example.test")!).credentialService)
    }

    @Test
    func rejectsRangesMissingNullsAndUnknownEnums() async throws {
        let invalid = [
            Self.receipt.replacingOccurrences(of: "\"merchant\":null,", with: ""),
            Self.receipt.replacingOccurrences(of: "\"receipt\"", with: "\"invoice\""),
            Self.receipt.replacingOccurrences(of: "\"totalAmountYen\":100", with: "\"totalAmountYen\":-1"),
            Self.receipt.replacingOccurrences(of: "\"totalAmountYen\":100", with: "\"totalAmountYen\":1.5"),
            Self.receipt.replacingOccurrences(of: "\"totalAmountYen\":100", with: "\"totalAmountYen\":9007199254740992"),
            Self.receipt.replacingOccurrences(of: "\"purchasedDate\":null", with: "\"purchasedDate\":\"2026-02-30\""),
            Self.receipt.replacingOccurrences(of: "\"purchasedTime\":null", with: "\"purchasedTime\":\"24:00\"")
        ]
        for body in invalid {
            APIStub.reset { request in .init(body: request.url?.path == "/api/ai/token" ? Self.token : body) }
            await #expect(throws: KMAPIError.invalidResponse) { try await perform(.receipt, client: client()) }
        }
        for body in [Self.payroll.replacingOccurrences(of: "\"employerName\":null", with: "\"employerName\":\"社員番号1234567\""), Self.payroll.replacingOccurrences(of: "payroll-v1", with: "payroll-v2")] {
            #expect(throws: KMAPIError.invalidResponse) { _ = try KMAPIValidation.decode(KMPayrollResponse.self, data: Data(body.utf8), shape: KMAPIShapes.payroll) }
        }
    }

    @Test
    @MainActor
    func refusesUnlistedCategoryAndNonUnitDistribution() async throws {
        for body in [Endpoint.jev.body.replacingOccurrences(of: "\"choice\":\"food\"", with: "\"choice\":\"unknown\""), Endpoint.jev.body.replacingOccurrences(of: "\"food\":1", with: "\"food\":0.2")] {
            APIStub.reset { request in .init(body: request.url?.path == "/api/ai/token" ? Self.token : body) }
            await #expect(throws: KMAPIError.invalidResponse) { try await perform(.jev, client: client()) }
        }
    }

    @Test
    func keychainRoundTripUsesSeparateOriginServices() throws {
        // Do not require a signed Keychain host in CODE_SIGNING_ALLOWED=NO CI.
        // Exercise the real query/status logic through a stub of only the Security calls.
        let values = Mutex<[String: Data]>([:])
        let operations = KMKeychainCredentials.Operations(
            copy: { query in
                #expect(query[kSecClass as String] as? String == kSecClassGenericPassword as String)
                #expect(query[kSecReturnData as String] as? Bool == true)
                #expect(query[kSecMatchLimit as String] as? String == kSecMatchLimitOne as String)
                let value = values.withLock { $0[Self.keychainKey(query)] }
                return (value == nil ? errSecItemNotFound : errSecSuccess, value)
            },
            update: { query, attributes in
                Self.expectDeviceOnly(attributes)
                return values.withLock { items in
                    let key = Self.keychainKey(query)
                    guard items[key] != nil else { return errSecItemNotFound }
                    items[key] = attributes[kSecValueData as String] as? Data
                    return errSecSuccess
                }
            },
            add: { query in
                Self.expectDeviceOnly(query)
                values.withLock { $0[Self.keychainKey(query)] = query[kSecValueData as String] as? Data }
                return errSecSuccess
            },
            delete: { query in
                let removed = values.withLock { $0.removeValue(forKey: Self.keychainKey(query)) }
                return removed == nil ? errSecItemNotFound : errSecSuccess
            }
        )
        let production = KMKeychainCredentials(service: "jp.kakeimatch.tests.production", operations: operations)
        let preview = KMKeychainCredentials(service: "jp.kakeimatch.tests.preview", operations: operations)
        let synthetic = Data("synthetic-only".utf8)
        try production.write(synthetic, key: "guest")
        #expect(try production.read("guest") == synthetic)
        #expect(try preview.read("guest") == nil)
        try production.write(Data("updated-synthetic".utf8), key: "guest")
        #expect(try production.read("guest") == Data("updated-synthetic".utf8))
        try production.write(nil, key: "guest")
        #expect(try production.read("guest") == nil)
    }

    private static func keychainKey(_ query: [String: Any]) -> String {
        #expect(query[kSecClass as String] as? String == kSecClassGenericPassword as String)
        #expect(query[kSecAttrSynchronizable as String] as? Bool != true)
        return "\(query[kSecAttrService as String] as! String)/\(query[kSecAttrAccount as String] as! String)"
    }

    private static func expectDeviceOnly(_ attributes: [String: Any]) {
        #expect(attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        #expect(attributes[kSecAttrSynchronizable as String] as? Bool != true)
    }

    @Test
    func keychainErrorsNeverBecomeMissingCredentials() throws {
        let denied = KMKeychainCredentials(service: "synthetic", operations: .init(
            copy: { _ in (errSecMissingEntitlement, nil) },
            update: { _, _ in errSecMissingEntitlement },
            add: { _ in Issue.record("Must not add after a denied update"); return errSecSuccess },
            delete: { _ in errSecMissingEntitlement }
        ))
        #expect(throws: KMAPIError.credentialStorage) { _ = try denied.read("guest") }
        #expect(throws: KMAPIError.credentialStorage) { try denied.write(Data(), key: "guest") }
        #expect(throws: KMAPIError.credentialStorage) { try denied.write(nil, key: "guest") }
    }

    @Test
    @MainActor
    func payrollIsResizedMaskedAndDoesNotCopyGPS() throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let source = UIGraphicsImageRenderer(size: CGSize(width: 2400, height: 1200), format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2400, height: 1200))
        }
        let encoded = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(encoded, "public.jpeg" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try #require(source.cgImage), [
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 0, kCGImagePropertyGPSLatitudeRef: "N"]
        ] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let input = encoded as Data
        #expect(throws: KMAPIError.invalidRequest) {
            _ = try KMMaskedPayrollImage.prepare(data: input, contentType: "image/jpeg", masks: [], maskingConfirmed: false)
        }
        let masked = try KMMaskedPayrollImage.prepare(data: input, contentType: "image/jpeg",
            masks: [CGRect(x: 0, y: 0, width: 0.5, height: 1)], maskingConfirmed: true)
        let reversed = try KMMaskedPayrollImage.prepare(data: input, contentType: "image/jpeg",
            masks: [CGRect(x: 0.5, y: 1, width: -0.5, height: -1)], maskingConfirmed: true)
        #expect(reversed.upload.data == masked.upload.data)
        let decoded = try #require(CGImageSourceCreateWithData(masked.upload.data as CFData, nil))
        let props = try #require(CGImageSourceCopyPropertiesAtIndex(decoded, 0, nil) as? [String: Any])
        #expect(props[kCGImagePropertyPixelWidth as String] as? Int == 1800)
        #expect(props[kCGImagePropertyPixelHeight as String] as? Int == 900)
        #expect(props[kCGImagePropertyGPSDictionary as String] == nil)
        let image = try #require(CGImageSourceCreateImageAtIndex(decoded, 0, nil))
        var pixels = [UInt8](repeating: 0, count: 8)
        let context = try #require(CGContext(data: &pixels, width: 2, height: 1, bitsPerComponent: 8, bytesPerRow: 8,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: 2, height: 1))
        #expect(pixels[0] < 10 && pixels[1] < 10 && pixels[2] < 10)
        #expect(pixels[4] > 240 && pixels[5] > 240 && pixels[6] > 240)
    }

    @Test
    func guestDailyUsageAndCookieRefreshFollowServerValues() async throws {
        let store = APITestCredentials()
        store.write(Data(String(repeating: "A", count: 43).utf8), key: "guest")
        APIStub.reset { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Guest " + String(repeating: "A", count: 43))
            return .init(body: #"{"plan":"guest","period":"day","day":"2027-01-15","used":5,"limit":5,"remaining":0}"#)
        }
        let api = try client(credentials: store)
        #expect(try await api.usage(as: .guest).remaining == 0)
        APIStub.reset { _ in .init(body: Endpoint.usage.body, headers: ["Set-Cookie": "__Secure-better-auth.session_token=refreshed.synthetic; Path=/; Expires=Fri, 29 Jan 2027 08:00:00 GMT; Secure; HttpOnly; SameSite=Lax"]) }
        _ = try await api.usage()
        let saved = try #require(store.read("session"))
        #expect(try KMJSON.decoder().decode(KMStoredSession.self, from: saved).value == "refreshed.synthetic")
    }

    @Test
    func bearer401DropsTokenAndDoesNotRetryPaidRequest() async throws {
        let store = APITestCredentials()
        APIStub.reset { request in
            request.url?.path == "/api/ai/token" ? .init(body: Self.token) : .init(status: 401, body: #"{"error":"unauthorized"}"#)
        }
        await #expect(throws: KMAPIError.authenticationRequired) { try await perform(.receipt, client: client(credentials: store)) }
        #expect(store.read("ai-token") == nil)
        #expect(APIStub.state.withLock { $0.requests.filter { $0.url?.path == "/api/ai/gemini" }.count } == 1)
    }

    @Test
    func cancellationIsNotConvertedToNetworkFailure() async throws {
        APIStub.reset { _ in throw URLError(.cancelled) }
        let api = try client()
        await #expect(throws: CancellationError.self) { _ = try await api.guestConfiguration() }
    }

    @Test
    func mediaAndConfigurationRejectUnsafeInputsBeforeNetwork() throws {
        #expect(throws: KMAPIError.invalidRequest) { _ = try KMUploadImage(data: Data([0xff, 0xd8, 0xff]), contentType: "image/png") }
        #expect(throws: KMAPIError.invalidRequest) { _ = try KMUploadImage(data: Data(repeating: 0, count: 6 * 1024 * 1024 + 1), contentType: "image/jpeg") }
        #expect(throws: KMAPIError.invalidRequest) { _ = try KMUploadAudio(data: Data("not audio".utf8), contentType: "audio/mp4") }
        for url in ["http://example.test", "https://secret@example.test", "https://example.test/api", "https://example.test/?token=secret"] {
            #expect(throws: KMAPIError.invalidRequest) { _ = try KMAPIConfiguration(baseURL: URL(string: url)!) }
        }
    }
}

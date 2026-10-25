import Foundation
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
                        clock: @escaping @Sendable () -> Date = { APIClientTests.now }) throws -> KMWorkerAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [APIStub.self]; config.httpCookieStorage = nil; config.urlCache = nil
        return KMWorkerAPI(configuration: try KMAPIConfiguration(baseURL: URL(string: "https://synthetic.example.test")!, originPolicy: native ? .native : .existingWorkerCompatibility),
                           session: URLSession(configuration: config), credentials: credentials, now: clock)
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
    func nativeDoesNotPretendToHaveAWebOrigin() async throws {
        APIStub.reset { request in
            #expect(request.value(forHTTPHeaderField: "Origin") == nil)
            return .init(status: 403, body: #"{"error":"forbidden_origin"}"#)
        }
        let api = try client(native: true)
        await #expect(throws: KMAPIError.forbiddenOrigin) { _ = try await api.accessToken() }
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
        #expect(try KMAPIConfiguration().credentialService != KMAPIConfiguration(baseURL: URL(string: "https://preview.example.test")!).credentialService)
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
    func mediaAndConfigurationRejectUnsafeInputsBeforeNetwork() throws {
        #expect(throws: KMAPIError.invalidRequest) { _ = try KMUploadImage(data: Data([0xff, 0xd8, 0xff]), contentType: "image/png") }
        #expect(throws: KMAPIError.invalidRequest) { _ = try KMUploadImage(data: Data(repeating: 0, count: 6 * 1024 * 1024 + 1), contentType: "image/jpeg") }
        #expect(throws: KMAPIError.invalidRequest) { _ = try KMUploadAudio(data: Data("not audio".utf8), contentType: "audio/mp4") }
        for url in ["http://example.test", "https://secret@example.test", "https://example.test/api", "https://example.test/?token=secret"] {
            #expect(throws: KMAPIError.invalidRequest) { _ = try KMAPIConfiguration(baseURL: URL(string: url)!) }
        }
    }
}

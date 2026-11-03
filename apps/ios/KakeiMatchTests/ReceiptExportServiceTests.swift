import Foundation
import Synchronization
import Testing
@testable import KakeiMatch

// Synthetic data only. The sender is a protocol stub, so no request leaves the test process.
private final class ExportSenderStub: KMReceiptExportSending, Sendable {
    struct Call: Sendable { var body: Data; var url: URL; var token: String }
    private let replies: Mutex<[Result<Int, URLError>]>
    private let recorded = Mutex<[Call]>([])

    init(_ replies: [Result<Int, URLError>]) { self.replies = Mutex(replies) }

    var calls: [Call] { recorded.withLock { $0 } }

    func send(_ body: Data, to url: URL, token: String) async throws -> Int {
        recorded.withLock { $0.append(.init(body: body, url: url, token: token)) }
        let reply = replies.withLock { $0.isEmpty ? .success(200) : $0.removeFirst() }
        return try reply.get()
    }
}

private final class ExportStateMemory: KMReceiptExportStateStore {
    var state = KMReceiptExportState()
    func load() throws -> KMReceiptExportState { state }
    func save(_ state: KMReceiptExportState) throws { self.state = state }
}

private final class ExportCredentials: KMCloudCredentialStore, Sendable {
    private let values = Mutex<[String: Data]>([:])
    func read(_ key: String) -> Data? { values.withLock { $0[key] } }
    func write(_ data: Data?, key: String) { values.withLock { $0[key] = data } }
}

private final class ExportHTTPStub: URLProtocol, @unchecked Sendable {
    static let captured = Mutex<[URLRequest]>([])
    static let status = Mutex(200)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.captured.withLock { $0.append(request) }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status.withLock { $0 }, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private let exportFood = KMCategory(id: "cat-food", name: "食費")
private let exportDaily = KMCategory(id: "cat-daily", name: "日用品")

@MainActor
@Suite(.serialized)
struct ReceiptExportServiceTests {
    private static func receipt(_ id: String, itemCategory: String = exportFood.id) -> KMReceipt {
        let instant = Date(timeIntervalSince1970: 1_800_000_000)
        return KMReceipt(
            id: id, createdAt: instant, updatedAt: instant, aiSuggestion: .init(source: .unclassified),
            confirmedValue: .init(merchant: "合成スーパー", purchasedDate: KMDate(rawValue: "2026-10-20"), purchasedTime: nil,
                                  totalAmountYen: 300, categoryId: exportFood.id, accountId: "account-1", excludedFromSpending: false,
                                  memo: nil, taxAmountYen: nil,
                                  items: [.init(id: "\(id)-item", name: "合成野菜", amountYen: 300, categoryId: itemCategory)],
                                  adjustments: []),
            registration: .init(status: .applied, actualTransactionId: nil, lastError: nil))
    }

    private struct Harness {
        let service: KMReceiptExportService
        let state: ExportStateMemory
        let sender: ExportSenderStub
        let store: KMInMemoryStore
    }

    private func harness(enabled: Bool = true, token: String? = "synthetic-token", receipts: [KMReceipt],
                         replies: [Result<Int, URLError>] = []) throws -> Harness {
        let state = ExportStateMemory()
        state.state.settings = .init(isEnabled: enabled, baseURL: "https://example-host:8443")
        let credentials = ExportCredentials()
        if let token { credentials.write(Data(token.utf8), key: KMReceiptExportService.tokenKey) }
        let sender = ExportSenderStub(replies)
        let service = KMReceiptExportService(stateStore: state, credentials: credentials, sender: sender,
                                             now: { Date(timeIntervalSince1970: 1_793_534_400) })
        let store = KMInMemoryStore(categories: [exportFood, exportDaily], receipts: receipts)
        return Harness(service: service, state: state, sender: sender, store: store)
    }

    @Test func disabledExportNeverSendsOrRecordsStatus() async throws {
        let h = try harness(enabled: false, receipts: [Self.receipt("r1")])
        #expect(await h.service.run(receipts: h.store, categories: h.store) == nil)
        #expect(h.sender.calls.isEmpty)
        #expect(h.state.state.lastStatus == nil)
        #expect(h.state.state.sentHashes.isEmpty)
    }

    @Test func missingTokenIsReportedWithoutSending() async throws {
        let h = try harness(token: nil, receipts: [Self.receipt("r1")])
        let status = await h.service.run(receipts: h.store, categories: h.store)
        #expect(status?.outcome == .notConfigured)
        #expect(h.sender.calls.isEmpty)
    }

    @Test func successSendsOnlyFoodReceiptsAndDoesNotResendUnchanged() async throws {
        let h = try harness(receipts: [Self.receipt("r1"), Self.receipt("r2", itemCategory: exportDaily.id)])
        let status = await h.service.run(receipts: h.store, categories: h.store)
        #expect(status?.outcome == .succeeded)
        #expect(status?.sentCount == 1)
        #expect(h.sender.calls.count == 1)
        let call = try #require(h.sender.calls.first)
        #expect(call.url.absoluteString == "https://example-host:8443/api/v1/receipts/import")
        #expect(call.token == "synthetic-token")
        let body = String(decoding: call.body, as: UTF8.self)
        #expect(body.contains("\"r1\""))
        #expect(!body.contains("\"r2\""))
        #expect(!body.contains("account-1"))
        #expect(Set(h.state.state.sentHashes.keys) == ["r1"])
        #expect(h.state.state.lastStatus == status)

        let again = await h.service.run(receipts: h.store, categories: h.store)
        #expect(again?.outcome == .nothingToSend)
        #expect(h.sender.calls.count == 1)
    }

    @Test func networkFailureKeepsReceiptsPendingForTheNextAttempt() async throws {
        let h = try harness(receipts: [Self.receipt("r1")], replies: [.failure(URLError(.notConnectedToInternet))])
        let failed = await h.service.run(receipts: h.store, categories: h.store)
        #expect(failed?.outcome == .networkFailed)
        #expect(failed?.pendingCount == 1)
        #expect(failed?.sentCount == 0)
        #expect(h.state.state.sentHashes.isEmpty)
        #expect(KMReceiptExportPresentation.statusText(failed).hasPrefix("! "))

        let retried = await h.service.run(receipts: h.store, categories: h.store)
        #expect(retried?.outcome == .succeeded)
        #expect(h.sender.calls.count == 2)
        #expect(Set(h.state.state.sentHashes.keys) == ["r1"])
    }

    @Test func unauthorizedIsDistinguishedFromOtherServerErrors() async throws {
        let unauthorized = try harness(receipts: [Self.receipt("r1")], replies: [.success(401)])
        let auth = await unauthorized.service.run(receipts: unauthorized.store, categories: unauthorized.store)
        #expect(auth?.outcome == .authenticationFailed)
        #expect(auth?.httpStatus == 401)
        #expect(auth?.pendingCount == 1)
        #expect(unauthorized.state.state.sentHashes.isEmpty)

        let forbidden = try harness(receipts: [Self.receipt("r1")], replies: [.success(403)])
        #expect(await forbidden.service.run(receipts: forbidden.store, categories: forbidden.store)?.outcome == .authenticationFailed)

        let broken = try harness(receipts: [Self.receipt("r1")], replies: [.success(500)])
        let server = await broken.service.run(receipts: broken.store, categories: broken.store)
        #expect(server?.outcome == .serverFailed)
        #expect(server?.httpStatus == 500)
        #expect(broken.state.state.sentHashes.isEmpty)
    }

    @Test func acceptedBatchesAreKeptWhenALaterBatchFails() async throws {
        let receipts = (0..<(KMReceiptExportService.batchSize + 3)).map { Self.receipt(String(format: "r%03d", $0)) }
        let h = try harness(receipts: receipts, replies: [.success(200), .failure(URLError(.timedOut))])
        let status = await h.service.run(receipts: h.store, categories: h.store)
        #expect(status?.outcome == .networkFailed)
        #expect(status?.sentCount == KMReceiptExportService.batchSize)
        #expect(status?.pendingCount == 3)
        #expect(h.state.state.sentHashes.count == KMReceiptExportService.batchSize)

        let rest = await h.service.run(receipts: h.store, categories: h.store)
        #expect(rest?.outcome == .succeeded)
        #expect(rest?.sentCount == 3)
    }

    @Test func emptyCategorySelectionIsReportedWithoutSending() async throws {
        let h = try harness(receipts: [Self.receipt("r1")])
        h.state.state.settings.categoryIds = []
        #expect(await h.service.run(receipts: h.store, categories: h.store)?.outcome == .noCategories)
        #expect(h.sender.calls.isEmpty)
    }

    @Test func httpClientPostsJSONWithBearerTokenAndNoCookies() async throws {
        ExportHTTPStub.captured.withLock { $0 = [] }
        ExportHTTPStub.status.withLock { $0 = 202 }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ExportHTTPStub.self]
        let client = KMReceiptExportHTTPClient(session: URLSession(configuration: configuration))
        let url = try KMReceiptExportEndpoint.importURL(baseURL: "https://example-host:8443")
        #expect(try await client.send(Data("{}".utf8), to: url, token: "synthetic-token") == 202)
        let request = try #require(ExportHTTPStub.captured.withLock { $0.first })
        #expect(request.httpMethod == "POST")
        #expect(request.url == url)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(request.value(forHTTPHeaderField: "Origin") == nil)

        await #expect(throws: KMReceiptExportError.invalidEndpoint) {
            _ = try await client.send(Data(), to: URL(string: "http://example-host")!, token: "synthetic-token")
        }
    }
}

import Foundation

/// Transport to the user's own receipt receiver. Independent of `KMWorkerAPI`: different
/// endpoint rules, credentials and session. Returns the HTTP status; throws on transport failure.
protocol KMReceiptExportSending: Sendable {
    func send(_ body: Data, to url: URL, token: String) async throws -> Int
}

struct KMReceiptExportHTTPClient: KMReceiptExportSending {
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            // No cookies, cache or redirects: a redirect could forward the bearer token elsewhere.
            let config = URLSessionConfiguration.ephemeral
            config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.httpCookieStorage = nil; config.httpShouldSetCookies = false
            config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: config, delegate: KMNoRedirects(), delegateQueue: nil)
        }
    }

    func send(_ body: Data, to url: URL, token: String) async throws -> Int {
        guard url.scheme == "https" else { throw KMReceiptExportError.invalidEndpoint }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = body
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return http.statusCode
    }
}

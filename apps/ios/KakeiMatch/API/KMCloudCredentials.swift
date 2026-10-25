import Foundation
import Security

protocol KMCloudCredentialStore: Sendable {
    func read(_ key: String) throws -> Data?
    func write(_ data: Data?, key: String) throws
}

/// No synchronizable keys and no backup migration to another device.
struct KMKeychainCredentials: KMCloudCredentialStore {
    let service: String

    func read(_ key: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: key,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KMAPIError.credentialStorage }
        return data
    }

    func write(_ data: Data?, key: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: key]
        guard let data else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw KMAPIError.credentialStorage }
            return
        }
        let attributes: [String: Any] = [kSecValueData as String: data,
                                        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw KMAPIError.credentialStorage }
        guard SecItemAdd(query.merging(attributes, uniquingKeysWith: { _, new in new }) as CFDictionary, nil) == errSecSuccess else {
            throw KMAPIError.credentialStorage
        }
    }
}

struct KMStoredSession: Codable, Sendable {
    let value: String
    let expiresAt: Date
}

struct KMAPIConfiguration: Sendable {
    enum OriginPolicy: Sendable {
        /// Native has no web origin. POST is rejected by the current Worker.
        case native
        /// Explicit compatibility choice, not proof that this request is from the app.
        case existingWorkerCompatibility
    }
    let baseURL: URL
    let originPolicy: OriginPolicy

    static let productionURL = URL(string: "https://kakeimatch.yhgry.workers.dev")!

    init(baseURL: URL = Self.productionURL, originPolicy: OriginPolicy = .native) throws {
        guard baseURL.scheme == "https", baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil, baseURL.port == nil,
              baseURL.path.isEmpty || baseURL.path == "/" else { throw KMAPIError.invalidRequest }
        self.baseURL = baseURL
        self.originPolicy = originPolicy
    }

    var origin: String { "https://\(baseURL.host!)" }
    var credentialService: String { "jp.kakeimatch.ios.cloud.\(baseURL.host!)" }
}

final class KMNoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

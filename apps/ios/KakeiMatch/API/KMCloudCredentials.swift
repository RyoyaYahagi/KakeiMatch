import Foundation
import Security

protocol KMCloudCredentialStore: Sendable {
    func read(_ key: String) throws -> Data?
    func write(_ data: Data?, key: String) throws
}

/// No synchronizable keys and no backup migration to another device.
struct KMKeychainCredentials: KMCloudCredentialStore {
    let service: String
    private let operations: Operations

    /// Security framework seam for deterministic tests without a signed Keychain host.
    struct Operations: Sendable {
        var copy: @Sendable ([String: Any]) -> (OSStatus, Data?)
        var update: @Sendable ([String: Any], [String: Any]) -> OSStatus
        var add: @Sendable ([String: Any]) -> OSStatus
        var delete: @Sendable ([String: Any]) -> OSStatus

        static let live = Self(
            copy: { query in
                var result: CFTypeRef?
                let status = SecItemCopyMatching(query as CFDictionary, &result)
                return (status, result as? Data)
            },
            update: { SecItemUpdate($0 as CFDictionary, $1 as CFDictionary) },
            add: { SecItemAdd($0 as CFDictionary, nil) },
            delete: { SecItemDelete($0 as CFDictionary) }
        )
    }

    init(service: String, operations: Operations = .live) {
        self.service = service
        self.operations = operations
    }

    func read(_ key: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: key,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        let (status, result) = operations.copy(query)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result else { throw KMAPIError.credentialStorage }
        return data
    }

    func write(_ data: Data?, key: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: key]
        guard let data else {
            let status = operations.delete(query)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw KMAPIError.credentialStorage }
            return
        }
        let attributes: [String: Any] = [kSecValueData as String: data,
                                        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updated = operations.update(query, attributes)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw KMAPIError.credentialStorage }
        guard operations.add(query.merging(attributes, uniquingKeysWith: { _, new in new })) == errSecSuccess else {
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

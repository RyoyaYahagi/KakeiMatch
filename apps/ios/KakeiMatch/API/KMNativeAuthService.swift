import Foundation

/// Narrow seam between the native account screens and the cloud adapter.
///
/// The implementation must not read household repositories. `KMWorkerAPI`
/// provides the production conformance; tests inject a deterministic stub so
/// no real Worker, Passkey, or App Attest host is needed.
protocol KMNativeAuthService: Sendable {
    var appAttestSupported: Bool { get }

    func nativeConfiguration() async throws -> KMNativeConfiguration
    func signInWithPasskey() async throws
    func registerPasskey(context: String, name: String) async throws
    func addPasskey(name: String) async throws
    func startGuest() async throws

    func accountSession() async throws -> KMCloudSession?
    func accountUsage() async throws -> KMAIUsage
    func guestUsage() async throws -> KMAIUsage
    func listPasskeys() async throws -> [KMCloudPasskey]
    func deletePasskey(id: String) async throws

    func issueAccountAIToken() async throws
    func signOut() async throws
    func deleteAccount() async throws -> KMAccountDeletion
}

extension KMWorkerAPI: KMNativeAuthService {
    func signInWithPasskey() async throws {
        try await performNativePasskey(kind: .authenticate)
    }

    func registerPasskey(context: String, name: String) async throws {
        try await performNativePasskey(kind: .register, context: context, name: name)
    }

    func addPasskey(name: String) async throws {
        try await performNativePasskey(kind: .register, name: name)
    }

    func startGuest() async throws {
        try await createNativeGuest()
    }

    func accountUsage() async throws -> KMAIUsage {
        try await usage(as: .account)
    }

    func guestUsage() async throws -> KMAIUsage {
        try await usage(as: .guest)
    }

    func issueAccountAIToken() async throws {
        _ = try await accessToken(allowGuest: false)
    }
}

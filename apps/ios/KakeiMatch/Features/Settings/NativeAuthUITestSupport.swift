#if DEBUG
import Foundation

/// Deterministic account states for XCUITest. Only compiled in Debug and only
/// selected when `KM_UI_TEST_NATIVE_AUTH_STATE` is explicitly set.
actor KMFakeNativeAuthService: KMNativeAuthService {
    enum Initial { case signedOut, signedIn, guest, unsupported, notConfigured }

    nonisolated let appAttestSupported: Bool
    private var signedIn: Bool
    private var guest: Bool
    private var passkeys: [KMCloudPasskey]
    private let clock = Date(timeIntervalSince1970: 1_792_000_000)
    private let initial: Initial

    init(initial: Initial) {
        self.initial = initial
        appAttestSupported = initial != .unsupported
        signedIn = initial == .signedIn
        guest = initial == .guest
        let base = Date(timeIntervalSince1970: 1_792_000_000)
        passkeys = initial == .signedIn ? [.init(
            id: "ui-passkey-1", name: "この端末", publicKey: "synthetic", userId: "ui-user",
            credentialID: "c3ludGhldGlj", counter: 0, deviceType: "singleDevice", backedUp: false,
            transports: "internal", createdAt: base, aaguid: nil
        )] : []
    }

    func nativeConfiguration() async throws -> KMNativeConfiguration {
        if case .notConfigured = initial { return .init(available: false, rpId: nil, appAttestEnvironment: nil) }
        return .init(available: true, rpId: "preview.example.test", appAttestEnvironment: "development")
    }

    func signInWithPasskey() async throws { signedIn = true }
    func registerPasskey(context _: String, name _: String) async throws { signedIn = true }

    func addPasskey(name: String) async throws {
        guard signedIn else { throw KMAPIError.nativeAuthenticationRequired }
        passkeys.append(.init(
            id: "ui-passkey-\(passkeys.count + 1)", name: name, publicKey: "synthetic", userId: "ui-user",
            credentialID: "c3ludGhldGlj", counter: 0, deviceType: "singleDevice", backedUp: false,
            transports: "internal", createdAt: clock, aaguid: nil
        ))
    }

    func startGuest() async throws { guest = true }

    func accountSession() async throws -> KMCloudSession? {
        guard signedIn else { return nil }
        return .init(
            user: .init(id: "ui-user", name: "テスト利用者", email: "ui@example.test", emailVerified: true,
                        image: nil, createdAt: clock, updatedAt: clock),
            session: .init(id: "ui-session", userId: "ui-user", token: "ui-session-token",
                           expiresAt: clock.addingTimeInterval(3_600), createdAt: clock, updatedAt: clock,
                           ipAddress: nil, userAgent: nil)
        )
    }

    func accountUsage() async throws -> KMAIUsage {
        guard signedIn else { throw KMAPIError.nativeAuthenticationRequired }
        return .init(plan: .free, period: .month, month: try KMYearMonth("2026-10"), day: nil,
                     used: 3, limit: 10, remaining: 7)
    }

    func guestUsage() async throws -> KMAIUsage {
        guard guest else { throw KMAPIError.nativeAuthenticationRequired }
        return .init(plan: .guest, period: .day, month: nil, day: try KMDate("2026-10-14"),
                     used: 2, limit: 5, remaining: 3)
    }

    func listPasskeys() async throws -> [KMCloudPasskey] {
        guard signedIn else { throw KMAPIError.nativeAuthenticationRequired }
        return passkeys
    }

    func deletePasskey(id: String) async throws {
        guard signedIn else { throw KMAPIError.nativeAuthenticationRequired }
        passkeys.removeAll { $0.id == id }
    }

    func issueAccountAIToken() async throws {
        guard signedIn else { throw KMAPIError.nativeAuthenticationRequired }
    }

    func signOut() async throws { signedIn = false }

    func deleteAccount() async throws -> KMAccountDeletion {
        signedIn = false
        return .init(deleted: true, localHouseholdDataPreserved: true)
    }
}
#endif

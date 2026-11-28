#if DEBUG
import Foundation

/// Deterministic account states for XCUITest. Only compiled in Debug and only
/// selected when `KM_UI_TEST_NATIVE_AUTH_STATE` is explicitly set.
actor KMFakeNativeAuthService: KMNativeAuthService {
    enum Initial { case signedOut, signedIn, signedInDaily, guest, unsupported, notConfigured }

    nonisolated let appAttestSupported: Bool
    private var signedIn: Bool
    private var guest: Bool
    private let initial: Initial
    private let supportId: String?
    private(set) var submittedStoreKitJWS: [String] = []

    init(initial: Initial, supportId: String? = nil) {
        self.initial = initial
        self.supportId = supportId
        appAttestSupported = initial != .unsupported
        signedIn = initial == .signedIn || initial == .signedInDaily
        guest = initial == .guest
    }

    func nativeConfiguration() async throws -> KMNativeConfiguration {
        if case .notConfigured = initial { return .init(available: false, rpId: nil, appAttestEnvironment: nil) }
        return .init(available: true, rpId: "preview.example.test", appAttestEnvironment: "development")
    }

    func signInWithPasskey() async throws { signedIn = true }
    func registerPasskey(context _: String, name _: String) async throws { signedIn = true }

    func addPasskey(name _: String) async throws {
        guard signedIn else { throw KMAPIError.nativeAuthenticationRequired }
    }

    func startGuest() async throws { guest = true }

    func accountUsage() async throws -> KMAIUsage {
        guard signedIn else { throw KMAPIError.nativeAuthenticationRequired }
        if case .signedInDaily = initial {
            return .init(plan: .free, period: .day, month: nil, day: try KMDate("2026-10-14"),
                         used: 2, limit: 5, remaining: 3, supportId: supportId)
        }
        return .init(plan: .free, period: .month, month: try KMYearMonth("2026-10"), day: nil,
                     used: 3, limit: 10, remaining: 7, supportId: supportId)
    }

    func guestUsage() async throws -> KMAIUsage {
        guard guest else { throw KMAPIError.nativeAuthenticationRequired }
        return .init(plan: .guest, period: .day, month: nil, day: try KMDate("2026-10-14"),
                     used: 2, limit: 5, remaining: 3, supportId: supportId)
    }

    func issueAccountAIToken() async throws {
        guard signedIn else { throw KMAPIError.nativeAuthenticationRequired }
    }

    func submitStoreKitTransaction(jws: String) async throws -> KMStoreKitTransactionResponse {
        guard signedIn || guest else { throw KMAPIError.nativeAuthenticationRequired }
        submittedStoreKitJWS.append(jws)
        return KMStoreKitTransactionResponse(
            synced: true,
            status: .active,
            expiresAt: nil,
            productId: KMStoreKitConfiguration.proMonthlyProductID
        )
    }

}
#endif

import Foundation

/// XCUITest entry point. `KM_UI_TEST_DRIVE_STATE` is read only in Debug and only
/// selects a stand-in, so Release always uses the real Google Sign-In manager.
enum KMDriveLinkTestSupport {
    @MainActor
    static func make() -> (any KMDriveLinking)? {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["KM_UI_TEST_DRIVE_STATE"] {
        case "signedIn":
            return KMFakeDriveLinking(signedIn: true)
        case "signedOut":
            return KMFakeDriveLinking(signedIn: false)
        default:
            return nil
        }
        #else
        return nil
        #endif
    }
}

#if DEBUG
/// Deterministic Drive account for XCUITest. It never opens Google's UI and
/// never contacts the network.
@MainActor
final class KMFakeDriveLinking: KMDriveLinking {
    private(set) var isSignedIn: Bool
    private(set) var hasDriveScope: Bool
    private(set) var accountID: String?
    private(set) var accountEmail: String?
    private(set) var restoreCount = 0
    private(set) var signInCount = 0
    private(set) var signOutCount = 0

    init(signedIn: Bool) {
        isSignedIn = signedIn
        hasDriveScope = signedIn
        accountID = signedIn ? "ui-account" : nil
        accountEmail = signedIn ? "ui@example.test" : nil
    }

    func restoreIfNeeded() async {
        restoreCount += 1
    }

    func signIn() async throws -> Bool {
        signInCount += 1
        isSignedIn = true
        hasDriveScope = true
        accountID = "ui-account"
        accountEmail = "ui@example.test"
        return true
    }

    func signOut() {
        signOutCount += 1
        isSignedIn = false
        hasDriveScope = false
        accountID = nil
        accountEmail = nil
    }

    func accessToken(forceRefresh: Bool) async throws -> String {
        guard isSignedIn else { throw KMDriveUploadError.notSignedIn }
        return forceRefresh ? "ui-test-forced-token" : "ui-test-token"
    }
}
#endif

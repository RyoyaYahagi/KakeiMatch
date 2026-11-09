import AppAuthCore
import Foundation
import GoogleSignIn
import GTMAppAuth
import Observation
import UIKit

/// The sign-in surface the sync model needs. Keeping it a protocol lets tests
/// and XCUITests use a deterministic stand-in instead of Google's SDK.
@MainActor
protocol KMDriveLinking: AnyObject {
    var isSignedIn: Bool { get }
    var hasDriveScope: Bool { get }
    var accountID: String? { get }
    var accountEmail: String? { get }
    func restoreIfNeeded() async
    func signIn() async throws -> Bool
    func signOut()
    func accessToken(forceRefresh: Bool) async throws -> String
}

/// Google Sign-In wrapper for the Drive snapshot writer. Only the connection is
/// handled here; the actual upload lives in `KMDriveSyncModel`.
///
/// The requested scope is `drive.file` only (files this app created). Signing
/// out is app-local `GIDSignIn.signOut()`; `disconnect` is never called because
/// it would change the user's Google account state.
///
/// Constructing this type does not touch GoogleSignIn. Restoring a previous
/// sign-in is explicit (`restoreIfNeeded()`), so a user who never enabled the
/// feature and never opened the page runs no Google code beyond `onOpenURL`.
@MainActor
@Observable
final class KMDriveLinkManager: KMDriveLinking {
    static let shared = KMDriveLinkManager()

    static let driveScope = "https://www.googleapis.com/auth/drive.file"

    typealias Restore = @MainActor (@escaping (GIDGoogleUser?, (any Error)?) -> Void) -> Void
    typealias RefreshTokens = @MainActor (GIDGoogleUser) async throws
        -> (user: GIDGoogleUser, token: String)

    private(set) var currentUser: GIDGoogleUser?
    @ObservationIgnored private let restore: Restore
    @ObservationIgnored private let refreshTokens: RefreshTokens
    @ObservationIgnored private var restoreTask: Task<Void, Never>?
    @ObservationIgnored private var didRestore = false
    @ObservationIgnored private var authGeneration = 0

    var isSignedIn: Bool { currentUser != nil }
    var accountID: String? { currentUser?.userID }
    var accountEmail: String? { currentUser?.profile?.email }

    var hasDriveScope: Bool {
        currentUser?.grantedScopes?.contains(Self.driveScope) == true
    }

    init(restore: @escaping Restore = { completion in
        GIDSignIn.sharedInstance.restorePreviousSignIn(completion: completion)
    }, refreshTokens: @escaping RefreshTokens = { user in
        let refreshed = try await user.refreshTokensIfNeeded()
        return (refreshed, refreshed.accessToken.tokenString)
    }, currentUser: GIDGoogleUser? = nil) {
        self.restore = restore
        self.refreshTokens = refreshTokens
        self.currentUser = currentUser
    }

    /// Called only when the toggle is ON or the settings page is opened. A
    /// transient failure leaves the attempt retryable; concurrent callers wait
    /// for the same attempt instead of starting another one.
    func restoreIfNeeded() async {
        if didRestore { return }
        if let restoreTask {
            await restoreTask.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.restoreOnce()
        }
        restoreTask = task
        await task.value
        restoreTask = nil
    }

    private func restoreOnce() async {
        let generation = authGeneration
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            restore { [weak self] user, error in
                // The SDK documents that this callback runs on the main queue.
                // GIDGoogleUser is not Sendable, so hand it to the main actor
                // explicitly instead of crossing the boundary as a checked value.
                nonisolated(unsafe) let restoredUser = user
                Task { @MainActor [weak self] in
                    guard let self, !self.didRestore,
                          generation == self.authGeneration else {
                        continuation.resume()
                        return
                    }
                    if let error {
                        // A missing keychain entry is permanent; network and other
                        // errors keep didRestore false so a later foreground call
                        // can try again.
                        let nsError = error as NSError
                        if nsError.domain == kGIDSignInErrorDomain,
                           nsError.code == GIDSignInError.hasNoAuthInKeychain.rawValue {
                            self.didRestore = true
                        }
                    } else {
                        self.currentUser = restoredUser
                        self.didRestore = true
                        self.authGeneration += 1
                    }
                    continuation.resume()
                }
            }
        }
    }

    /// Returns false when the user cancels, so the caller can stay silent
    /// instead of showing an authentication error.
    func signIn() async throws -> Bool {
        guard let presenter = Self.topViewController() else {
            throw KMDriveLinkError.noPresenter
        }
        do {
            let result = try await GIDSignIn.sharedInstance.signIn(
                withPresenting: presenter,
                hint: nil,
                additionalScopes: [Self.driveScope])
            currentUser = result.user
            authGeneration += 1
            didRestore = true
            return true
        } catch {
            if (error as NSError).code == GIDSignInError.canceled.rawValue {
                return false
            }
            throw error
        }
    }

    func signOut() {
        authGeneration += 1
        GIDSignIn.sharedInstance.signOut()
        currentUser = nil
        didRestore = true
    }

    /// The closure handed to the writer. `refreshTokensIfNeeded()` runs on the
    /// main actor and the user object never leaves it.
    ///
    /// `forceRefresh` is set only for the single 401 retry. Google Sign-In
    /// returns the cached token while it still looks unexpired, so the retry
    /// goes through AppAuth's forced-refresh flag instead.
    func accessToken(forceRefresh: Bool = false) async throws -> String {
        let generation = authGeneration
        guard let currentUser else { throw KMDriveUploadError.notSignedIn }
        if forceRefresh {
            return try await forceRefreshAccessToken(for: currentUser, generation: generation)
        }
        // A refresh failure is reported as-is; the presentation layer keeps
        // English diagnostics off the screen and shows a Japanese reason.
        let result = try await refreshTokens(currentUser)
        // Sign-out or sign-in may have completed while the refresh was waiting.
        // Discard the result instead of reviving the old account.
        guard generation == authGeneration else { throw KMDriveUploadError.cancelled }
        self.currentUser = result.user
        return result.token
    }

    /// Forces the next AppAuth refresh even when the cached access token has not
    /// reached its expiry. `GIDGoogleUser.refreshTokensIfNeeded()` does not do
    /// this by itself, so a 401 shortly before expiry would otherwise retry with
    /// the same token.
    private func forceRefreshAccessToken(for user: GIDGoogleUser,
                                         generation: Int) async throws -> String {
        guard let session = user.fetcherAuthorizer as? AuthSession else {
            throw KMDriveUploadError.unauthorized
        }
        let previousToken = user.accessToken.tokenString
        session.authState.setNeedsTokenRefresh()
        let refreshedToken: String? = try await withCheckedThrowingContinuation { continuation in
            session.authState.performAction { accessToken, _, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: accessToken)
                }
            }
        }
        guard generation == authGeneration else { throw KMDriveUploadError.cancelled }
        // The retry must send a different credential; the same token would only
        // repeat the 401 that triggered this path.
        let token = try KMDriveForcedToken.validate(refreshedToken, previous: previousToken)
        if let updated = GIDSignIn.sharedInstance.currentUser {
            currentUser = updated
        }
        return token
    }

    private static func topViewController() -> UIViewController? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
        var top = window?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}

enum KMDriveLinkError: Error, LocalizedError {
    case noPresenter

    var errorDescription: String? {
        switch self {
        case .noPresenter:
            return "サインイン画面を表示できませんでした。もう一度お試しください。"
        }
    }
}

/// The forced-refresh retry may only continue with a token that is present,
/// non-empty, and different from the one that just received a 401.
enum KMDriveForcedToken {
    static func validate(_ token: String?, previous: String) throws -> String {
        guard let token, !token.isEmpty, token != previous else {
            throw KMDriveUploadError.unauthorized
        }
        return token
    }
}

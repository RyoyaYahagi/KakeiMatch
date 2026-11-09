import Foundation
import GoogleSignIn
import Testing
@testable import KakeiMatch

@MainActor
private final class RefreshGate {
    private var started: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?
    private var hasStarted = false

    func wait() async {
        hasStarted = true
        started?.resume()
        started = nil
        await withCheckedContinuation { release = $0 }
    }

    func waitUntilStarted() async {
        if hasStarted { return }
        await withCheckedContinuation { started = $0 }
    }

    func open() {
        release?.resume()
        release = nil
    }
}

@MainActor
struct KMDriveLinkManagerTests {
    @Test func restoreRetriesAfterTransientFailureAndStopsAfterSuccess() async {
        var calls = 0
        var errors: [(any Error)?] = [
            NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet),
            nil,
        ]
        let manager = KMDriveLinkManager(restore: { completion in
            calls += 1
            completion(nil, errors.removeFirst())
        })

        await manager.restoreIfNeeded()
        #expect(calls == 1)

        await manager.restoreIfNeeded()
        #expect(calls == 2)

        await manager.restoreIfNeeded()
        #expect(calls == 2)
    }

    @Test func concurrentRestoreCallsWaitForTheSameAttempt() async {
        var calls = 0
        let manager = KMDriveLinkManager(restore: { completion in
            calls += 1
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(50))
                completion(nil, nil)
            }
        })

        async let first: Void = manager.restoreIfNeeded()
        async let second: Void = manager.restoreIfNeeded()
        _ = await (first, second)

        #expect(calls == 1)
    }

    @Test func signOutDuringTokenRefreshDoesNotRestoreTheUser() async throws {
        let gate = RefreshGate()
        let manager = KMDriveLinkManager(
            restore: { completion in completion(nil, nil) },
            refreshTokens: { current in
                await gate.wait()
                return (current, "refreshed-token")
            },
            currentUser: GIDGoogleUser())
        #expect(manager.isSignedIn)

        let refresh = Task { try await manager.accessToken(forceRefresh: false) }
        await gate.waitUntilStarted()
        manager.signOut()
        gate.open()

        do {
            _ = try await refresh.value
            Issue.record("refresh after sign-out should be discarded")
        } catch let error as KMDriveUploadError {
            guard case .cancelled = error else {
                Issue.record("expected .cancelled, got \(error)")
                return
            }
        }

        #expect(!manager.isSignedIn)
        #expect(manager.currentUser == nil)
    }

    @Test func noAuthInKeychainMustMatchTheGoogleSignInDomain() async {
        var calls = 0
        var errors: [(any Error)?] = [
            NSError(domain: "example.test", code: GIDSignInError.hasNoAuthInKeychain.rawValue),
            NSError(domain: kGIDSignInErrorDomain,
                    code: GIDSignInError.hasNoAuthInKeychain.rawValue),
        ]
        let manager = KMDriveLinkManager(restore: { completion in
            calls += 1
            completion(nil, errors.removeFirst())
        })

        await manager.restoreIfNeeded()
        #expect(calls == 1)

        await manager.restoreIfNeeded()
        #expect(calls == 2)

        await manager.restoreIfNeeded()
        #expect(calls == 2)
    }
}

struct KMDriveForcedTokenTests {
    @Test func forcedTokenMustBePresentNonEmptyAndNew() throws {
        #expect(throws: KMDriveUploadError.self) {
            try KMDriveForcedToken.validate(nil, previous: "old")
        }
        #expect(throws: KMDriveUploadError.self) {
            try KMDriveForcedToken.validate("", previous: "old")
        }
        #expect(throws: KMDriveUploadError.self) {
            try KMDriveForcedToken.validate("old", previous: "old")
        }
        #expect(try KMDriveForcedToken.validate("new", previous: "old") == "new")
    }
}

import Foundation
import Testing
@testable import KakeiMatch

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

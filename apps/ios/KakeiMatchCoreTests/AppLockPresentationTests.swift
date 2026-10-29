import Foundation
import Testing
@testable import KakeiMatchCore

struct AppLockPresentationTests {
    @Test func explicitEnableAndSixtySecondBackgroundThresholdControlRelock() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(!KMAppLockPresentation.shouldLock(isEnabled: false, backgroundedAt: nil, now: now))
        #expect(KMAppLockPresentation.shouldLock(isEnabled: true, backgroundedAt: nil, now: now))
        #expect(!KMAppLockPresentation.shouldLock(
            isEnabled: true, backgroundedAt: now.addingTimeInterval(-59.999), now: now))
        #expect(KMAppLockPresentation.shouldLock(
            isEnabled: true, backgroundedAt: now.addingTimeInterval(-60), now: now))
        #expect(!KMAppLockPresentation.shouldLock(
            isEnabled: true, backgroundedAt: now.addingTimeInterval(1), now: now))
    }
}

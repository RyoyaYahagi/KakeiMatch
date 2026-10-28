import Foundation

enum KMAppLockPresentation {
    static let backgroundLockInterval: TimeInterval = 60

    static func shouldLock(isEnabled: Bool, backgroundedAt: Date?, now: Date) -> Bool {
        guard isEnabled else { return false }
        guard let backgroundedAt else { return true }
        return now.timeIntervalSince(backgroundedAt) >= backgroundLockInterval
    }
}

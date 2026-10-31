import Foundation

/// Fixture screens show a fixed reference date. Advancing it with wall time keeps timed
/// windows such as the 10-second deletion undo meaningful, and one origin for every screen
/// keeps the window computed by a model and by the shell's notice aligned.
enum KMFixtureClock {
    static let startedAt = ProcessInfo.processInfo.systemUptime

    static func now(reference: Date) -> Date {
        reference.addingTimeInterval(ProcessInfo.processInfo.systemUptime - startedAt)
    }
}

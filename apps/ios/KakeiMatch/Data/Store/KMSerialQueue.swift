import Foundation

/// FIFO gate for MainActor work that may suspend. The app shares one store across scenes, so
/// operation order must be the order the scenes requested, not the order their awaits resume.
/// Not reentrant: an operation must not enter the same queue from inside its body.
@MainActor final class KMSerialQueue {
    private var isRunning = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func run<T>(_ operation: @MainActor () async throws -> T) async throws -> T {
        await acquire()
        defer { release() }
        return try await operation()
    }

    private func acquire() async {
        guard isRunning else { isRunning = true; return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiting.append(continuation)
        }
    }

    private func release() {
        if waiting.isEmpty { isRunning = false }
        else { waiting.removeFirst().resume() } // Ownership passes to the resumed operation.
    }
}

import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct KMSerialQueueTests {
    @MainActor final class OrderRecorder {
        var values: [String] = []
    }

    @Test func secondOperationWaitsUntilFirstOperationFinishes() async {
        let queue = KMSerialQueue()
        let recorder = OrderRecorder()
        let first = Task { @MainActor in
            try? await queue.run {
                recorder.values.append("first-start")
                try? await Task.sleep(nanoseconds: 40_000_000)
                recorder.values.append("first-end")
            }
        }
        // Let the first operation enter and suspend before the second scene requests its turn.
        for _ in 0..<1_000 where recorder.values.isEmpty { await Task.yield() }
        #expect(recorder.values == ["first-start"])
        let second = Task { @MainActor in
            try? await queue.run { recorder.values.append("second") }
        }
        await first.value
        await second.value
        #expect(recorder.values == ["first-start", "first-end", "second"])
    }

    @Test func failureReleasesTheNextOperation() async throws {
        let queue = KMSerialQueue()
        await #expect(throws: KMDataError.staleProfile) {
            try await queue.run { throw KMDataError.staleProfile }
        }
        var ran = false
        try await queue.run { ran = true }
        #expect(ran)
    }
}

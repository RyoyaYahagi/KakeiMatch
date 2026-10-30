import Foundation

/// Memory-only Flight Recorder for the contact diagnostic attachment. It mirrors PWA's
/// `contact-diagnostics.ts`: at most 40 events for 15 minutes, no persistence, and no
/// free-form text. Contact screen events are filtered again when the attachment is built.
@MainActor
final class KMContactDiagnosticRecorder {
    static let shared = KMContactDiagnosticRecorder()

    private struct RecordedEvent {
        let at: Date
        let screen: KMContactPresentation.DiagnosticScreen?
        let kind: KMContactPresentation.DiagnosticEventKind
    }

    private let now: () -> Date
    private var events: [RecordedEvent] = []
    private var currentScreen: KMContactPresentation.DiagnosticScreen = .home
    private(set) var isOnline = true

    init(now: @escaping () -> Date = Date.init) {
        self.now = now
    }

    func recordScreen(_ screen: KMContactPresentation.DiagnosticScreen) {
        currentScreen = screen
        push(.init(at: now(), screen: screen, kind: .screenOpen))
    }

    func recordAction(_ action: KMContactPresentation.DiagnosticAction,
                      screen: KMContactPresentation.DiagnosticScreen? = nil) {
        push(.init(at: now(), screen: screen ?? currentScreen, kind: .action(action.rawValue)))
    }

    func recordError(_ code: String, screen: KMContactPresentation.DiagnosticScreen? = nil) {
        let safeCode = KMContactPresentation.safeDiagnosticErrorCode(code)
        push(.init(at: now(), screen: screen ?? currentScreen, kind: .error(safeCode)))
    }

    func recordNetwork(_ online: Bool) {
        isOnline = online
        push(.init(at: now(), screen: nil, kind: .network(online)))
    }

    func snapshot(now point: Date? = nil) -> KMContactDiagnosticContext {
        let point = point ?? now()
        let cutoff = point.addingTimeInterval(-TimeInterval(KMContactPresentation.maximumDiagnosticAgeSeconds))
        let visible = events.filter { $0.at >= cutoff }.map { event -> KMContactPresentation.DiagnosticEvent in
            let rawSeconds = point.timeIntervalSince(event.at).rounded()
            let seconds = min(KMContactPresentation.maximumDiagnosticAgeSeconds, max(0, Int(rawSeconds)))
            return .init(secondsAgo: seconds, screen: event.screen, kind: event.kind)
        }
        return KMContactPresentation.diagnostics(currentScreen: currentScreen, isOnline: isOnline, events: visible)
    }

    func resetForTest() {
        events = []
        currentScreen = .home
        isOnline = true
    }

    private func push(_ event: RecordedEvent) {
        let cutoff = now().addingTimeInterval(-TimeInterval(KMContactPresentation.maximumDiagnosticAgeSeconds))
        events = events.filter { $0.at >= cutoff }
        events.append(event)
        if events.count > KMContactPresentation.maximumRecordedDiagnosticEvents {
            events.removeFirst(events.count - KMContactPresentation.maximumRecordedDiagnosticEvents)
        }
    }
}

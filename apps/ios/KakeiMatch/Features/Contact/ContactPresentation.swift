import Foundation

struct KMContactDiagnosticContext: Equatable, Sendable {
    struct Event: Equatable, Sendable {
        let type: String
        let secondsAgo: Int
        let screen: String?
        let action: String?
        let errorCode: String?
        let online: Bool?
    }

    let version: Int
    let currentScreen: String
    let network: String
    let events: [Event]
}

enum KMContactKind: String, CaseIterable, Identifiable, Sendable {
    case bug
    case improvement
    case question

    var id: String { rawValue }

    var title: String {
        switch self {
        case .bug: "不具合"
        case .improvement: "改善の要望"
        case .question: "質問"
        }
    }

    var resultTitle: String {
        switch self {
        case .bug: "不具合のご連絡"
        case .improvement: "改善のご要望"
        case .question: "お問い合わせ"
        }
    }

    var apiKind: KMContactResult.Kind {
        switch self {
        case .bug: .bug
        case .improvement: .improvement
        case .question: .question
        }
    }
}

enum KMContactPresentation {
    static let maximumMessageLength = 4_000
    static let maximumDiagnosticEvents = 20
    static let maximumDiagnosticAgeSeconds = 900

    enum Validation: Equatable {
        case valid
        case kindRequired
        case messageRequired
        case tooLong
    }

    enum DiagnosticScreen: String, Sendable {
        case home, records, statements, reconciliation, settings, contact
    }

    enum DiagnosticEventKind: Sendable {
        case screenOpen
        case action(String)
        case error(String)
        case network(Bool)
    }

    struct DiagnosticEvent: Sendable {
        let secondsAgo: Int
        let screen: DiagnosticScreen?
        let kind: DiagnosticEventKind
    }

    static func messageLength(_ message: String) -> Int { message.utf16.count }

    static func limitedMessage(_ message: String) -> String {
        var result = ""
        for scalar in message.unicodeScalars {
            guard result.utf16.count + scalar.utf16.count <= maximumMessageLength else { break }
            result.unicodeScalars.append(scalar)
        }
        return result
    }

    static func validation(kind: KMContactKind?, message: String) -> Validation {
        guard kind != nil else { return .kindRequired }
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .messageRequired }
        guard messageLength(message) <= maximumMessageLength else { return .tooLong }
        return .valid
    }

    /// Builds the PWA-compatible allowlisted payload. User-entered text is never an input.
    static func diagnostics(
        currentScreen: DiagnosticScreen,
        isOnline: Bool,
        events: [DiagnosticEvent]
    ) -> KMContactDiagnosticContext {
        let safeActions: Set<String> = [
            "navigate_home", "navigate_records", "navigate_statements", "navigate_reconciliation",
            "navigate_settings", "receipt_ai_started", "receipt_save_started", "statement_import_started",
            "reconciliation_run_started", "open_contact", "contact_recording_started",
            "contact_recording_finished", "contact_interview_started", "contact_submit_started",
        ]
        let safeErrors: Set<String> = [
            "storage", "offline_or_unavailable", "auth_required", "quota", "invalid_flow", "invalid_image",
            "invalid_ai_response", "invalid_confirmation", "unavailable", "already_processing",
            "actual_write_uncertain", "actual_apply_failed", "invalid_input", "not_found", "request_failed",
            "provider_unavailable", "rate_limited", "ai_quota_exceeded", "invalid_request",
            "temporarily_unavailable", "issue_submission_failed", "issue_submission_unknown", "operation_failed",
        ]
        let recentEvents = events.filter { $0.secondsAgo <= maximumDiagnosticAgeSeconds }
        let safe = recentEvents.compactMap { event -> KMContactDiagnosticContext.Event? in
            let age = max(0, event.secondsAgo)
            switch event.kind {
            case .screenOpen:
                guard let screen = event.screen, screen != .contact else { return nil }
                return .init(type: "screen_open", secondsAgo: age, screen: screen.rawValue, action: nil, errorCode: nil, online: nil)
            case .action(let action):
                guard let screen = event.screen, screen != .contact, safeActions.contains(action), !action.hasPrefix("contact_") else { return nil }
                return .init(type: "action", secondsAgo: age, screen: screen.rawValue, action: action, errorCode: nil, online: nil)
            case .error(let code):
                guard let screen = event.screen, screen != .contact, safeErrors.contains(code) else { return nil }
                return .init(type: "error", secondsAgo: age, screen: screen.rawValue, action: nil, errorCode: code, online: nil)
            case .network(let online):
                return .init(type: "network", secondsAgo: age, screen: nil, action: nil, errorCode: nil, online: online)
            }
        }
        let visibleEvents = Array(safe.suffix(maximumDiagnosticEvents))
        let latestScreen = visibleEvents.reversed().first { $0.type == "screen_open" }?.screen
        return KMContactDiagnosticContext(
            version: 1,
            currentScreen: latestScreen ?? (currentScreen == .contact ? "settings" : currentScreen.rawValue),
            network: isOnline ? "online" : "offline",
            events: visibleEvents
        )
    }

    static func failureMessage(for error: Error) -> String {
        guard let error = error as? KMAPIError else {
            return "送信できませんでした。文章はこの画面内に残っています。接続を確認して再度お試しください。"
        }
        switch error {
        case .authenticationRequired, .nativeAuthenticationRequired:
            return "送信にはログインが必要です。設定からログインしてください。"
        case .invalidFlow, .invalidRequest:
            return "送信内容を確認できませんでした。文章を編集して再度お試しください。"
        case .notConfigured:
            return "お問い合わせを現在利用できません。文章はこの画面内に下書きとして残っています。"
        case .quotaExceeded, .guestLimitReached:
            return "今日はこの接続からの送信が多いため、これ以上送れません。文章はこの画面内に残っています。明日もう一度お試しください。"
        case .rateLimited:
            return "短時間に利用が続いています。文章はこの画面内に残っています。少し待ってから再度お試しください。"
        case .aiTemporarilyPaused, .network, .providerUnavailable, .providerTimeout, .nativeUnsupported, .forbiddenOrigin,
             .invalidResponse, .botCheckFailed, .credentialStorage, .server:
            return "送信できませんでした。文章はこの画面内に残っています。接続を確認して再度お試しください。"
        }
    }
}

import Foundation

struct KMContactDiagnosticContext: Equatable, Sendable, Codable {
    struct Event: Equatable, Sendable, Codable {
        let type: String
        let secondsAgo: Int
        let screen: String?
        let action: String?
        let errorCode: String?
        let online: Bool?

        init(type: String, secondsAgo: Int, screen: String? = nil, action: String? = nil,
             errorCode: String? = nil, online: Bool? = nil) {
            self.type = type
            self.secondsAgo = secondsAgo
            self.screen = screen
            self.action = action
            self.errorCode = errorCode
            self.online = online
        }

        private enum CodingKeys: String, CodingKey {
            case type, secondsAgo, screen, action, errorCode, online
        }

        /// The Worker rejects a diagnostic event with unknown or missing keys, so encode only
        /// the keys that belong to this event type.
        func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(type, forKey: .type)
            try container.encode(secondsAgo, forKey: .secondsAgo)
            switch type {
            case "screen_open":
                try container.encodeIfPresent(screen, forKey: .screen)
            case "action":
                try container.encodeIfPresent(screen, forKey: .screen)
                try container.encodeIfPresent(action, forKey: .action)
            case "error":
                try container.encodeIfPresent(screen, forKey: .screen)
                try container.encodeIfPresent(errorCode, forKey: .errorCode)
            case "network":
                try container.encodeIfPresent(online, forKey: .online)
            default:
                break
            }
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            type = try container.decode(String.self, forKey: .type)
            secondsAgo = try container.decode(Int.self, forKey: .secondsAgo)
            screen = try container.decodeIfPresent(String.self, forKey: .screen)
            action = try container.decodeIfPresent(String.self, forKey: .action)
            errorCode = try container.decodeIfPresent(String.self, forKey: .errorCode)
            online = try container.decodeIfPresent(Bool.self, forKey: .online)
        }
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

}

enum KMContactPresentation {
    static let maximumMessageLength = 4_000
    static let maximumDiagnosticEvents = 20
    static let maximumRecordedDiagnosticEvents = 40
    static let maximumDiagnosticAgeSeconds = 900

    enum Validation: Equatable {
        case valid
        case kindRequired
        case messageRequired
        case tooLong
    }

    enum DiagnosticScreen: String, Sendable, CaseIterable {
        case home, records, statements, reconciliation, settings, contact
    }

    enum DiagnosticAction: String, Sendable, CaseIterable {
        case navigateHome = "navigate_home"
        case navigateRecords = "navigate_records"
        case navigateStatements = "navigate_statements"
        case navigateReconciliation = "navigate_reconciliation"
        case navigateSettings = "navigate_settings"
        case receiptAIStarted = "receipt_ai_started"
        case receiptSaveStarted = "receipt_save_started"
        case statementImportStarted = "statement_import_started"
        case reconciliationRunStarted = "reconciliation_run_started"
        case openContact = "open_contact"
        case contactRecordingStarted = "contact_recording_started"
        case contactRecordingFinished = "contact_recording_finished"
        case contactInterviewStarted = "contact_interview_started"
        case contactSubmitStarted = "contact_submit_started"
    }

    enum DiagnosticErrorCode: String, Sendable, CaseIterable {
        case storage
        case offlineOrUnavailable = "offline_or_unavailable"
        case authRequired = "auth_required"
        case quota
        case invalidFlow = "invalid_flow"
        case invalidImage = "invalid_image"
        case invalidAIResponse = "invalid_ai_response"
        case invalidConfirmation = "invalid_confirmation"
        case unavailable
        case alreadyProcessing = "already_processing"
        case actualWriteUncertain = "actual_write_uncertain"
        case actualApplyFailed = "actual_apply_failed"
        case invalidInput = "invalid_input"
        case notFound = "not_found"
        case requestFailed = "request_failed"
        case providerUnavailable = "provider_unavailable"
        case rateLimited = "rate_limited"
        case aiQuotaExceeded = "ai_quota_exceeded"
        case invalidRequest = "invalid_request"
        case temporarilyUnavailable = "temporarily_unavailable"
        case issueSubmissionFailed = "issue_submission_failed"
        case issueSubmissionUnknown = "issue_submission_unknown"
        case operationFailed = "operation_failed"
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

    /// PWA's `SUPPORT_ACTIONS` are removed from the attachment because they describe the
    /// contact flow itself rather than the behaviour leading up to it.
    static let supportActions: Set<String> = [
        "open_contact", "contact_recording_started", "contact_recording_finished",
        "contact_interview_started", "contact_submit_started",
    ]

    static let safeActions: Set<String> = Set(DiagnosticAction.allCases.map(\.rawValue))
    static let safeErrorCodes: Set<String> = Set(DiagnosticErrorCode.allCases.map(\.rawValue))
    static let diagnosticScreens: Set<String> = Set(DiagnosticScreen.allCases.map(\.rawValue))

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

    /// Unknown or unsafe error text collapses to the same generic code as PWA.
    static func safeDiagnosticErrorCode(_ code: String) -> String {
        safeErrorCodes.contains(code) ? code : DiagnosticErrorCode.operationFailed.rawValue
    }

    /// Builds the PWA-compatible allowlisted payload. User-entered text is never an input.
    static func diagnostics(
        currentScreen: DiagnosticScreen,
        isOnline: Bool,
        events: [DiagnosticEvent]
    ) -> KMContactDiagnosticContext {
        let recentEvents = events.filter { $0.secondsAgo <= maximumDiagnosticAgeSeconds }
        let safe = recentEvents.compactMap { event -> KMContactDiagnosticContext.Event? in
            let age = max(0, event.secondsAgo)
            switch event.kind {
            case .screenOpen:
                guard let screen = event.screen, screen != .contact else { return nil }
                return .init(type: "screen_open", secondsAgo: age, screen: screen.rawValue)
            case .action(let action):
                guard let screen = event.screen, screen != .contact,
                      safeActions.contains(action), !supportActions.contains(action) else { return nil }
                return .init(type: "action", secondsAgo: age, screen: screen.rawValue, action: action)
            case .error(let code):
                guard let screen = event.screen, screen != .contact, safeErrorCodes.contains(code) else { return nil }
                return .init(type: "error", secondsAgo: age, screen: screen.rawValue, errorCode: code)
            case .network(let online):
                return .init(type: "network", secondsAgo: age, online: online)
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

    /// The attachment is optional, but a present attachment must match the Worker schema
    /// exactly. This check runs before the typed request is encoded.
    static func isValidForWorker(_ context: KMContactDiagnosticContext) -> Bool {
        guard context.version == 1,
              diagnosticScreens.contains(context.currentScreen),
              context.network == "online" || context.network == "offline",
              context.events.count <= maximumDiagnosticEvents else { return false }
        for event in context.events {
            guard (0...maximumDiagnosticAgeSeconds).contains(event.secondsAgo) else { return false }
            switch event.type {
            case "screen_open":
                guard let screen = event.screen, diagnosticScreens.contains(screen),
                      event.action == nil, event.errorCode == nil, event.online == nil else { return false }
            case "action":
                guard let screen = event.screen, diagnosticScreens.contains(screen),
                      let action = event.action, safeActions.contains(action),
                      event.errorCode == nil, event.online == nil else { return false }
            case "error":
                guard let screen = event.screen, diagnosticScreens.contains(screen),
                      let code = event.errorCode, safeErrorCodes.contains(code),
                      event.action == nil, event.online == nil else { return false }
            case "network":
                guard event.online != nil, event.screen == nil,
                      event.action == nil, event.errorCode == nil else { return false }
            default:
                return false
            }
        }
        return true
    }

    /// PWA keeps failures in the draft and distinguishes login, configuration, and network
    /// causes. Keep those classes separate so a Simulator-only failure is not reported as an
    /// offline network problem.
    static func failureMessage(forCode code: String) -> String {
        switch code {
        case "unauthorized", "account_session_required", "auth_required", "guest_unavailable":
            return "送信にはログインが必要です。設定からログインしてください。"
        case "invalid_flow", "invalid_request", "request_too_large", "unsupported_media_type":
            return "送信内容を確認できませんでした。文章を編集して再度お試しください。"
        case "not_configured":
            return "お問い合わせを現在利用できません。文章はこの画面内に下書きとして残っています。"
        case "native_authentication_unavailable":
            return "この端末ではお問い合わせを送信できません。文章はこの画面内に下書きとして残っています。"
        case "ai_quota_exceeded":
            return "今日はこの接続からの送信が多いため、これ以上送れません。文章はこの画面内に残っています。明日もう一度お試しください。"
        case "rate_limited":
            return "短時間に利用が続いています。文章はこの画面内に残っています。少し待ってから再度お試しください。"
        case "invalid_ai_response":
            return "回答を確認できませんでした。文章はこの画面内に残っています。時間をおいて再度お試しください。"
        case "ai_temporarily_paused", "provider_timeout", "provider_unavailable", "temporarily_unavailable":
            return "現在送信できません。文章はこの画面内に残っています。時間をおいて再度お試しください。"
        case "bot_check_cancelled", "bot_check_failed":
            return "確認ができなかったため、送れませんでした。文章はこの画面内に残っています。もう一度お試しください。"
        case "guest_limit_reached":
            return "この接続からの利用が多いため、今日は送れません。文章はこの画面内に残っています。設定からログインすると送れます。"
        default:
            return "送信できませんでした。文章はこの画面内に残っています。接続を確認して再度お試しください。"
        }
    }

}

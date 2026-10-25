import Foundation

/// Codes are intentionally separate from display context (receipt/contact/payroll).
enum KMAPIError: Error, Equatable, Sendable {
    case authenticationRequired, quotaExceeded, aiTemporarilyPaused, rateLimited
    case network, invalidResponse, invalidRequest, invalidFlow, forbiddenOrigin
    case providerUnavailable, providerTimeout, notConfigured, botCheckFailed, guestLimitReached
    case nativeAuthenticationRequired, credentialStorage, server(status: Int, code: String?)

    var pwaCode: String {
        switch self {
        case .authenticationRequired: "auth_required"
        case .quotaExceeded: "quota"
        case .aiTemporarilyPaused, .network, .providerUnavailable, .providerTimeout: "offline_or_unavailable"
        case .rateLimited: "rate_limited"
        case .invalidResponse: "invalid_ai_response"
        case .invalidRequest: "invalid_request"
        case .invalidFlow: "invalid_flow"
        case .forbiddenOrigin: "forbidden_origin"
        case .notConfigured: "not_configured"
        case .botCheckFailed: "bot_check_failed"
        case .guestLimitReached: "guest_limit_reached"
        case .nativeAuthenticationRequired: "account_session_required"
        case .credentialStorage: "storage"
        case .server: "request_failed"
        }
    }

    func receiptMessage(isGuest: Bool = false) -> String {
        switch self {
        case .authenticationRequired, .nativeAuthenticationRequired:
            "AI機能を使うにはアカウントへのサインインが必要です。レシートは端末に保存されています。"
        case .quotaExceeded:
            isGuest ? "今日のAI読み取り（登録なしで1日5回）を使い切りました。明日の0時に戻ります。手で入力して続けられます。" : "AI利用上限に達しました。手動で入力できます。"
        case .rateLimited: "AIへの要求が集中しています。しばらく待つか、手動で入力してください。"
        case .invalidResponse: "AIの応答を確認できませんでした。もう一度お試しください。"
        case .invalidFlow: "この読み取りのカテゴリ提案は終了しました。手動で選ぶか、AIで読み取り直してください。"
        case .notConfigured: "AI機能を現在利用できません。後でもう一度お試しください。"
        case .aiTemporarilyPaused, .providerUnavailable:
            "AI機能は一時的に利用できません。レシート画像と入力内容は端末に残っています。手入力で登録できます。時間をおいて再度お試しください。"
        default: "通信できないか、一時的に処理できませんでした。接続を確認して再試行してください。"
        }
    }

    static func from(status: Int, code: String?) -> Self {
        switch code {
        case "unauthorized": return .authenticationRequired
        case "ai_quota_exceeded": return .quotaExceeded
        case "ai_temporarily_paused": return .aiTemporarilyPaused
        case "rate_limited": return .rateLimited
        case "invalid_provider_response": return .invalidResponse
        case "invalid_request", "request_too_large", "unsupported_media_type": return .invalidRequest
        case "invalid_flow": return .invalidFlow
        case "forbidden_origin", "untrusted_origin": return .forbiddenOrigin
        case "provider_timeout": return .providerTimeout
        case "provider_unavailable", "temporarily_unavailable": return .providerUnavailable
        case "not_configured": return .notConfigured
        case "bot_check_failed": return .botCheckFailed
        case "guest_limit_reached": return .guestLimitReached
        default: return status == 401 ? .authenticationRequired : .server(status: status, code: nil)
        }
    }
}

struct KMAIToken: Codable, Sendable { let token: String; let expiresAt: Int }
struct KMGuestConfiguration: Codable, Sendable { let guestAvailable: Bool; let turnstileSiteKey: String? }
struct KMGuestCreated: Codable, Sendable { let guestSecret: String }
struct KMAIUsage: Codable, Sendable {
    enum Plan: String, Codable, Sendable { case free, pro, family, guest }
    enum Period: String, Codable, Sendable { case month, day }
    let plan: Plan
    let period: Period
    let month: KMYearMonth?
    let day: KMDate?
    let used: Int
    let limit: Int?
    let remaining: Int?
}
struct KMAICosts: Codable, Sendable {
    struct Provider: Codable, Sendable {
        let requests: Int; let inputTokens: Int; let outputTokens: Int
        let costUsdMicros: Int; let unknownRequests: Int
    }
    struct Providers: Codable, Sendable { let gemini: Provider; let jev: Provider }
    let month: KMYearMonth; let currency: String; let totalUsdMicros: Int
    let unknownRequests: Int; let providers: Providers
}
struct KMCategoryOption: Codable, Sendable { let id: String; let name: String }
struct KMCategoryAnswers: Codable, Sendable {
    struct Answer: Codable, Sendable {
        let type: String; let choice: String; let confidence: Decimal; let probabilities: [String: Decimal]
        /// PWA safeCategoryResponse: confidence is not a substitute for the distribution.
        var suggestedCategoryID: String? {
            let ranked = probabilities.values.sorted(by: >)
            guard let first = ranked.first, probabilities[choice] == first,
                  first >= Decimal(string: "0.75")!, first - (ranked.dropFirst().first ?? 0) >= Decimal(string: "0.15")! else { return nil }
            return choice
        }
    }
    let model: String; let answers: [String: Answer]
}
struct KMCategorySuggestion: Codable, Sendable { let categoryId: String? }
struct KMPayrollResponse: Codable, Sendable {
    struct Extraction: Codable, Sendable {
        enum Kind: String, Codable, Sendable { case paySlip = "pay_slip", notPaySlip = "not_pay_slip", unknown }
        let documentKind: Kind; let employerName: String?; let paymentDate: KMDate?; let payPeriod: String?
        let payType: KMPayrollRecord.Confirmed.PayType; let grossPayYen: Int?; let netPayYen: Int?
        let deductions: KMPayrollRecord.Deductions; let allowances: [KMPayrollRecord.Allowance]; let warnings: [KMPayrollRecord.Warning]
    }
    let extraction: Extraction; let model: String; let promptVersion: String
}
struct KMContactResult: Codable, Sendable {
    enum Kind: String, Codable, Sendable { case bug, improvement, question }
    let feedbackId: String; let kind: Kind; let reply: String; let issueUrl: String?
}
struct KMTranscription: Codable, Sendable { let text: String }
struct KMAccountDeletion: Codable, Sendable { let deleted: Bool; let localHouseholdDataPreserved: Bool }
struct KMSignOut: Codable, Sendable { let success: Bool }
struct KMPasskeyDeleted: Codable, Sendable { let status: Bool }
struct KMCloudSession: Codable, Sendable {
    struct User: Codable, Sendable {
        let id: String; let name: String; let email: String; let emailVerified: Bool
        let image: String?; let createdAt: Date; let updatedAt: Date
    }
    struct Session: Codable, Sendable {
        let id: String; let userId: String; let token: String; let expiresAt: Date
        let createdAt: Date; let updatedAt: Date; let ipAddress: String?; let userAgent: String?
    }
    let user: User; let session: Session
}
struct KMCloudPasskey: Codable, Sendable {
    let id: String; let name: String?; let publicKey: String; let userId: String; let credentialID: String
    let counter: Int; let deviceType: String; let backedUp: Bool; let transports: String?
    let createdAt: Date?; let aaguid: String?
}

struct KMImageRequest: Codable, Sendable {
    let flowId: String; let imageBase64: String; let contentType: String; let maskingConfirmed: Bool?
}
struct KMCategoryRequest: Codable, Sendable {
    struct Receipt: Codable, Sendable {
        struct Item: Codable, Sendable {
            let name: String; let amountYen: Int?
            enum CodingKeys: CodingKey { case name, amountYen }
            func encode(to encoder: any Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(name, forKey: .name); try c.encode(amountYen, forKey: .amountYen)
            }
        }
        let merchant: String?; let totalAmountYen: Int?; let items: [Item]
        enum CodingKeys: CodingKey { case merchant, totalAmountYen, items }
        func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(merchant, forKey: .merchant); try c.encode(totalAmountYen, forKey: .totalAmountYen); try c.encode(items, forKey: .items)
        }
    }
    let flowId: String; let receipt: Receipt; let categories: [KMCategoryOption]; let itemIndexes: [Int]?
}
struct KMCategorySuggestionRequest: Codable, Sendable {
    let flowId: String; let sourceCategoryName: String; let categories: [KMCategoryOption]
}
struct KMContactRequest: Codable, Sendable {
    let flowId: String; let kind: KMContactResult.Kind; let message: String
    let originalMessage: String?
    // Diagnostic attachment intentionally deferred until the memory-only recorder is ported.
}
struct KMAudioRequest: Codable, Sendable { let flowId: String; let audioBase64: String; let contentType: String }

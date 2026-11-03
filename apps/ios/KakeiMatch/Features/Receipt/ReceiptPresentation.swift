import Foundation

/// API schema and retry messaging stay in the app target; pure calculations live in Core.
extension KMReceiptPresentation {
    static func validateExtraction(_ value: KMReceiptExtraction) throws {
        _ = try KMAPIValidation.request(value, shape: KMAPIShapes.receipt.encodingShape)
        try KMAPIShapes.validateReceipt(value)
    }

    static func retryable(_ error: KMAPIError) -> Bool {
        switch error {
        case .network, .invalidResponse, .providerUnavailable, .providerTimeout, .server: true
        default: false
        }
    }

    static func failureMessage(_ error: KMAPIError, isGuest: Bool = false) -> String {
        if error == .nativeUnsupported {
            return "この端末ではAI読み取りを利用できません。手で入力して続けられます。"
        }
        if error == .guestLimitReached {
            return "この接続からの登録なしの利用が多いため、今日はこれ以上始められません。手で入力するか、設定からログインしてください。"
        }
        return error.receiptMessage(isGuest: isGuest)
    }

    /// The heading, reason and next steps for a failed read. PWA codes come from
    /// `KMAPIError.pwaCode`; the iOS-only codes map to PWA's quota and
    /// image-too-large failures so the wording stays the same. PWA safeError also
    /// reports account_session_required as auth_required.
    static func readingFailure(_ error: KMAPIError, guest: Bool = false) -> ReadingFailure {
        let code = switch error {
        case .guestLimitReached: "quota"
        case .invalidRequest: "image_too_large"
        case .nativeAuthenticationRequired: "auth_required"
        default: error.pwaCode
        }
        return readingFailure(code: code, message: failureMessage(error, isGuest: guest), guest: guest)
    }
}

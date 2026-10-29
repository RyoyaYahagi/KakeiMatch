import Foundation

extension KMContactKind {
    var apiKind: KMContactResult.Kind {
        switch self {
        case .bug: .bug
        case .improvement: .improvement
        case .question: .question
        }
    }
}

extension KMContactPresentation {
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

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

    static func failureMessage(_ error: KMAPIError) -> String {
        if error == .nativeUnsupported {
            return "この端末ではAI読み取りを利用できません。手で入力して続けられます。"
        }
        return error.receiptMessage()
    }
}

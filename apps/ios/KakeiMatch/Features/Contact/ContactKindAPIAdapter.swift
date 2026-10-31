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
            return failureMessage(forCode: "operation_failed")
        }
        return failureMessage(forCode: error.pwaCode)
    }
}

extension KMContactDiagnosticRecorder {
    func recordFailure(_ error: Error, screen: KMContactPresentation.DiagnosticScreen) {
        let code = (error as? KMAPIError)?.pwaCode ?? KMContactPresentation.DiagnosticErrorCode.operationFailed.rawValue
        recordError(code, screen: screen)
    }
}

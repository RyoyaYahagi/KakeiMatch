import AuthenticationServices
import CryptoKit
import DeviceCheck
import Foundation
import UIKit

/// Device-bound App Attest operations. Tests inject a deterministic implementation.
protocol KMAppAttesting: Sendable {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attest(keyID: String, clientDataHash: Data) async throws -> Data
    func assertion(keyID: String, clientDataHash: Data) async throws -> Data
}

struct KMLiveAppAttest: KMAppAttesting {
    var isSupported: Bool { DCAppAttestService.shared.isSupported }

    func generateKey() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DCAppAttestService.shared.generateKey { keyID, error in
                if let error { continuation.resume(throwing: error) }
                else if let keyID { continuation.resume(returning: keyID) }
                else { continuation.resume(throwing: KMAPIError.invalidResponse) }
            }
        }
    }

    func attest(keyID: String, clientDataHash: Data) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            DCAppAttestService.shared.attestKey(keyID, clientDataHash: clientDataHash) { data, error in
                if let error { continuation.resume(throwing: error) }
                else if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: KMAPIError.invalidResponse) }
            }
        }
    }

    func assertion(keyID: String, clientDataHash: Data) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            DCAppAttestService.shared.generateAssertion(keyID, clientDataHash: clientDataHash) { data, error in
                if let error { continuation.resume(throwing: error) }
                else if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: KMAPIError.invalidResponse) }
            }
        }
    }
}

/// Inputs are the validated Better Auth WebAuthn options. The adapter returns
/// WebAuthn JSON response data; it never manages HTTP cookies.
@MainActor
protocol KMPasskeyAuthorizing: Sendable {
    func perform(kind: KMPasskeyKind, relyingPartyID: String, challenge: Data, userID: Data?, username: String?, allowedCredentialIDs: [Data]?) async throws -> Data
}

enum KMPasskeyKind: Sendable, Equatable { case authenticate, register }

@MainActor
final class KMLivePasskeyAuthorizer: NSObject, KMPasskeyAuthorizing, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<Data, Error>?
    private var activeController: ASAuthorizationController?

    func perform(kind: KMPasskeyKind, relyingPartyID: String, challenge: Data, userID: Data?, username: String?, allowedCredentialIDs: [Data]?) async throws -> Data {
        guard continuation == nil else { throw KMAPIError.invalidRequest }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: relyingPartyID)
        let request: ASAuthorizationRequest
        switch kind {
        case .authenticate:
            let assertionRequest = provider.createCredentialAssertionRequest(challenge: challenge)
            assertionRequest.allowedCredentials = (allowedCredentialIDs ?? []).map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
            assertionRequest.userVerificationPreference = .required
            request = assertionRequest
        case .register:
            guard let userID, !userID.isEmpty else { throw KMAPIError.invalidRequest }
            guard let username, !username.isEmpty else { throw KMAPIError.invalidResponse }
            let registrationRequest = provider.createCredentialRegistrationRequest(challenge: challenge, name: username, userID: userID)
            registrationRequest.userVerificationPreference = .required
            request = registrationRequest
        }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            activeController = controller
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? UIWindow()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let continuation else { return }
        self.continuation = nil
        activeController = nil
        do { continuation.resume(returning: try Self.responseJSON(authorization.credential)) }
        catch { continuation.resume(throwing: error) }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
        activeController = nil
    }

    private static func responseJSON(_ credential: ASAuthorizationCredential) throws -> Data {
        let object: [String: Any]
        if let assertion = credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            let userHandle: Any
            if let userID = assertion.userID { userHandle = KMNativeCrypto.base64URL(userID) }
            else { userHandle = NSNull() }
            object = ["id": KMNativeCrypto.base64URL(assertion.credentialID),
                      "rawId": KMNativeCrypto.base64URL(assertion.credentialID), "type": "public-key",
                      "response": ["clientDataJSON": KMNativeCrypto.base64URL(assertion.rawClientDataJSON),
                                   "authenticatorData": KMNativeCrypto.base64URL(assertion.rawAuthenticatorData),
                                   "signature": KMNativeCrypto.base64URL(assertion.signature),
                                   "userHandle": userHandle],
                      "clientExtensionResults": [:]]
        } else if let registration = credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            guard let rawAttestationObject = registration.rawAttestationObject else { throw KMAPIError.invalidResponse }
            object = ["id": KMNativeCrypto.base64URL(registration.credentialID),
                      "rawId": KMNativeCrypto.base64URL(registration.credentialID), "type": "public-key",
                      "response": ["clientDataJSON": KMNativeCrypto.base64URL(registration.rawClientDataJSON),
                                   "attestationObject": KMNativeCrypto.base64URL(rawAttestationObject),
                                   "transports": ["internal"]], "clientExtensionResults": [:]]
        } else { throw KMAPIError.invalidResponse }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed])
    }
}

/// WebAuthn challenges are base64url decoded before both WebAuthn and App Attest use.
enum KMNativeCrypto {
    static func decodeBase64URL(_ value: String) throws -> Data {
        guard !value.isEmpty,
              value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
            throw KMAPIError.invalidResponse
        }
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), !data.isEmpty,
              base64URL(data) == value else { throw KMAPIError.invalidResponse }
        return data
    }

    static func decodeChallenge(_ value: String) throws -> Data {
        let data = try decodeBase64URL(value)
        guard data.count == 32 else { throw KMAPIError.invalidResponse }
        return data
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func clientDataHash(challenge: String) throws -> Data {
        Data(SHA256.hash(data: try decodeChallenge(challenge)))
    }
}

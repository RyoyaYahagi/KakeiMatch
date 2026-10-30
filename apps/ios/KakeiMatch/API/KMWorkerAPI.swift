import CryptoKit
import Foundation

/// Cloud-only adapter. Does not read/write household repositories or retry paid requests.
actor KMWorkerAPI {
    enum Identity: String, Sendable { case account, guest }
    private struct AuthFailure: Codable { let code: String?; let message: String }
    private struct Failure: Codable { let error: String }
    private let configuration: KMAPIConfiguration
    private let session: URLSession
    private let credentials: any KMCloudCredentialStore
    private let now: @Sendable () -> Date
    private let appAttest: any KMAppAttesting
    private let passkeyAuthorizer: (any KMPasskeyAuthorizing)?
    /// Read once at construction so the account UI can explain an unsupported
    /// device before any network request. App Attest cannot be simulated.
    nonisolated let appAttestSupported: Bool
    private var cachedToken: (value: KMAIToken, identity: Identity)?
    private var credentialRevision = 0
    private var appAttestEnrollment: Task<String, Error>?

    init(configuration: KMAPIConfiguration, session: URLSession? = nil,
         credentials: (any KMCloudCredentialStore)? = nil,
         appAttest: (any KMAppAttesting)? = nil,
         passkeyAuthorizer: (any KMPasskeyAuthorizing)? = nil,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.configuration = configuration
        self.credentials = credentials ?? KMKeychainCredentials(service: configuration.credentialService)
        self.now = now
        let attest = appAttest ?? KMLiveAppAttest()
        self.appAttest = attest
        self.appAttestSupported = attest.isSupported
        self.passkeyAuthorizer = passkeyAuthorizer
        if let session { self.session = session }
        else {
            let config = URLSessionConfiguration.ephemeral
            config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.httpCookieStorage = nil; config.httpShouldSetCookies = false
            config.timeoutIntervalForRequest = 45; config.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: config, delegate: KMNoRedirects(), delegateQueue: nil)
        }
    }

    func currentIdentity() -> Identity? { cachedToken?.identity }

    private struct NativeChallenge: Decodable {
        let challengeId: UUID
        let challenge: String
        let expiresAt: Int
    }
    private struct NativeSessionResponse: Codable { let sessionToken: String; let expiresAt: Int }
    private struct NativeAIResponse: Decodable { let token: String; let expiresAt: Int }

    private func nativeAccessToken(allowGuest: Bool) async throws -> String {
        let seconds = Int(now().timeIntervalSince1970)
        if let cachedToken, cachedToken.value.expiresAt > seconds + 30,
           allowGuest || cachedToken.identity == .account { return cachedToken.value.token }
        try credentials.write(nil, key: "ai-token")
        cachedToken = nil
        let revision = credentialRevision
        if let account = try nativeSessionAuthorization(required: false) {
            do {
                return try await exchangeNativeAIToken(sessionAuthorization: account, identity: .account, revision: revision)
            } catch KMAPIError.authenticationRequired {
                try requireCredentialRevision(revision)
                try credentials.write(nil, key: "session")
                try clearAccessToken()
                guard allowGuest else { throw KMAPIError.nativeAuthenticationRequired }
                return try await nativeAccessToken(allowGuest: true)
            }
        }

        guard allowGuest else { throw KMAPIError.nativeAuthenticationRequired }
        let guest: NativeSessionResponse?
        do { guest = try credentials.read("guest").map { try KMJSON.decoder().decode(NativeSessionResponse.self, from: $0) } }
        catch { throw KMAPIError.credentialStorage }
        guard let guest, guest.expiresAt > Int(now().timeIntervalSince1970),
              guest.sessionToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil else {
            throw KMAPIError.nativeAuthenticationRequired
        }
        do {
            return try await exchangeNativeAIToken(sessionAuthorization: "Native \(guest.sessionToken)", identity: .guest, revision: revision)
        } catch KMAPIError.authenticationRequired {
            try requireCredentialRevision(revision)
            try credentials.write(nil, key: "guest")
            throw KMAPIError.nativeAuthenticationRequired
        }
    }

    private func exchangeNativeAIToken(sessionAuthorization: String, identity: Identity, revision: Int) async throws -> String {
        let keyID = try await ensureNativeAttested()
        try requireCredentialRevision(revision)
        let challenge = try await nativeChallenge(purpose: "token", keyID: keyID, sessionToken: String(sessionAuthorization.dropFirst(7)))
        try requireCredentialRevision(revision)
        let clientDataHash = try KMNativeCrypto.clientDataHash(challenge: challenge.challenge)
        let assertion = try await appAttest.assertion(keyID: keyID, clientDataHash: clientDataHash)
        try requireCredentialRevision(revision)
        let body = try KMAPIValidation.request(NativeAssertionBody(challengeId: challenge.challengeId, keyId: keyID,
                                                                   assertion: assertion.base64EncodedString()),
            shape: .object(["challengeId": .text(max: 36), "keyId": .text(max: 200), "assertion": .text(max: 65536)]))
        let value: NativeAIResponse = try await nativeSend("POST", "/api/native/ai/token", body: body,
            authorization: sessionAuthorization, shape: .object(["token": .text(max: 43), "expiresAt": .integer()]))
        try requireCredentialRevision(revision)
        let seconds = Int(now().timeIntervalSince1970)
        guard value.token.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              value.expiresAt > seconds, value.expiresAt <= seconds + 600 else { throw KMAPIError.invalidResponse }
        return try cache(KMAIToken(token: value.token, expiresAt: value.expiresAt), identity: identity, revision: revision)
    }

    /// Public native configuration is the only native route that permits an unavailable service.
    func nativeConfiguration() async throws -> KMNativeConfiguration {
        let result: KMNativeConfiguration = try await nativeSend("GET", "/api/native/config", shape: .object([
            "available": .boolean, "rpId": .nullable(.text(max: 253)),
            "appAttestEnvironment": .nullable(.values(["development", "production"]))
        ]))
        guard result.available ? (result.rpId == configuration.baseURL.host && result.appAttestEnvironment != nil) : (result.rpId == nil && result.appAttestEnvironment == nil) else {
            throw KMAPIError.invalidResponse
        }
        return result
    }

    /// Generates at most one App Attest key per host. Concurrent calls share the same enrollment.
    func ensureNativeAttested() async throws -> String {
        let revision = credentialRevision
        if let appAttestEnrollment {
            let keyID = try await appAttestEnrollment.value
            try requireCredentialRevision(revision)
            return keyID
        }
        let enrollment = Task { try await self.loadOrEnrollNativeAttestation(revision: revision) }
        appAttestEnrollment = enrollment
        defer { appAttestEnrollment = nil }
        let keyID = try await enrollment.value
        try requireCredentialRevision(revision)
        return keyID
    }

    /// Failed enrollment never silently rotates the persisted App Attest key.
    private func loadOrEnrollNativeAttestation(revision: Int) async throws -> String {
        let config = try await nativeConfiguration()
        try requireCredentialRevision(revision)
        guard config.available else { throw KMAPIError.notConfigured }
        guard appAttest.isSupported else { throw KMAPIError.nativeUnsupported }
        guard let environment = config.appAttestEnvironment else { throw KMAPIError.invalidResponse }
        guard let data = try credentials.read("app-attest-key-id"), let keyID = String(data: data, encoding: .utf8) else {
            let keyID = try await appAttest.generateKey()
            try requireCredentialRevision(revision)
            guard validAppAttestKeyID(keyID) else { throw KMAPIError.invalidResponse }
            try credentials.write(Data(keyID.utf8), key: "app-attest-key-id")
            return try await attestNewKey(keyID, environment: environment, revision: revision)
        }
        guard validAppAttestKeyID(keyID) else { throw KMAPIError.credentialStorage }
        if try credentials.read("app-attest-registered") == Data([1]) { return keyID }
        return try await attestNewKey(keyID, environment: environment, revision: revision)
    }

    private func validAppAttestKeyID(_ value: String) -> Bool {
        guard let decoded = Data(base64Encoded: value) else { return false }
        return decoded.count == 32 && decoded.base64EncodedString() == value
    }

    private func attestNewKey(_ keyID: String, environment _: String, revision: Int) async throws -> String {
        let challenge = try await nativeChallenge(purpose: "attest", keyID: keyID)
        try requireCredentialRevision(revision)
        let clientDataHash = try KMNativeCrypto.clientDataHash(challenge: challenge.challenge)
        let attestation = try await appAttest.attest(keyID: keyID, clientDataHash: clientDataHash)
        try requireCredentialRevision(revision)
        let body = try KMAPIValidation.request(AttestBody(challengeId: challenge.challengeId, keyId: keyID,
                                                          attestation: attestation.base64EncodedString()),
                                               shape: .object(["challengeId": .text(max: 36), "keyId": .text(max: 200), "attestation": .text(max: 65536)]))
        let result: Registered = try await nativeSend("POST", "/api/native/attest", body: body,
                                                       shape: .object(["registered": .boolean]))
        try requireCredentialRevision(revision)
        guard result.registered else { throw KMAPIError.invalidResponse }
        try credentials.write(Data([1]), key: "app-attest-registered")
        return keyID
    }

    private struct AttestBody: Encodable { let challengeId: UUID; let keyId: String; let attestation: String }
    private struct Registered: Decodable { let registered: Bool }
    private struct NativeChallengeBody: Encodable { let purpose: String; let keyId: String }
    private struct NativeAssertionBody: Encodable { let challengeId: UUID; let keyId: String; let assertion: String }

    private func nativeChallenge(purpose: String, keyID: String, sessionToken: String? = nil) async throws -> NativeChallenge {
        let body = try KMAPIValidation.request(NativeChallengeBody(purpose: purpose, keyId: keyID),
                                               shape: .object(["purpose": .values(["attest", "guest", "token"]), "keyId": .text(max: 200)]))
        let auth = sessionToken.map { "Native \($0)" }
        let result: NativeChallenge = try await nativeSend("POST", "/api/native/challenge", body: body, authorization: auth,
            shape: .object(["challengeId": .text(max: 36), "challenge": .text(max: 100), "expiresAt": .integer()]))
        guard result.expiresAt > Int(now().timeIntervalSince1970), result.expiresAt <= Int(now().timeIntervalSince1970) + 120 else {
            throw KMAPIError.invalidResponse
        }
        _ = try KMNativeCrypto.decodeChallenge(result.challenge)
        return result
    }

    /// Creates a native guest session only after App Attest; no Turnstile or web fallback exists.
    func createNativeGuest() async throws {
        let revision = credentialRevision
        let keyID = try await ensureNativeAttested()
        try requireCredentialRevision(revision)
        let challenge = try await nativeChallenge(purpose: "guest", keyID: keyID)
        try requireCredentialRevision(revision)
        let clientDataHash = try KMNativeCrypto.clientDataHash(challenge: challenge.challenge)
        let assertion = try await appAttest.assertion(keyID: keyID, clientDataHash: clientDataHash)
        try requireCredentialRevision(revision)
        let body = try KMAPIValidation.request(NativeAssertionBody(challengeId: challenge.challengeId, keyId: keyID,
                                                                   assertion: assertion.base64EncodedString()),
            shape: .object(["challengeId": .text(max: 36), "keyId": .text(max: 200), "assertion": .text(max: 65536)]))
        let result: NativeSessionResponse = try await nativeSend("POST", "/api/native/guest", body: body,
            shape: .object(["sessionToken": .text(max: 43), "expiresAt": .integer()]))
        try requireCredentialRevision(revision)
        try validateNativeSession(result)
        try requireCredentialRevision(revision)
        try credentials.write(try KMJSON.encoder().encode(result), key: "guest")
        try clearAccessToken()
    }

    /// Authenticates or registers with a platform passkey. Invitation context remains opaque.
    func performNativePasskey(kind: KMPasskeyKind, context: String? = nil, name: String? = nil) async throws {
        let revision = credentialRevision
        let keyID = try await ensureNativeAttested()
        try requireCredentialRevision(revision)
        if let context { guard !context.isEmpty, context.utf8.count <= 4096 else { throw KMAPIError.invalidRequest } }
        if let name { guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.utf16.count <= 100 else { throw KMAPIError.invalidRequest } }
        let body = try KMAPIValidation.request(PasskeyOptionsBody(kind: kind == .register ? "register" : "authenticate", keyId: keyID,
                                                                 context: context, name: name),
            shape: .object(["kind": .values(["authenticate", "register"]), "keyId": .text(max: 200),
                            "context": .text(max: 4096), "name": .text(max: 100)], optional: ["context", "name"]))
        let options = try await nativeSendJSON("POST", "/api/native/passkey/options", body: body,
            authorization: kind == .register && context == nil ? try nativeSessionAuthorization(required: true) : nil)
        try requireCredentialRevision(revision)
        guard case .object(let outer) = options, case .object(let optionObject)? = outer["options"] else {
            throw KMAPIError.invalidResponse
        }
        let (challengeBytes, rpID) = try validatedPasskeyParameters(optionObject)
        let userID: Data?
        let username: String?
        let allowedCredentialIDs: [Data]?
        if kind == .register {
            guard case .object(let user)? = optionObject["user"], case .string(let id)? = user["id"],
                  case .string(let userName)? = user["name"], !userName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  userName.utf16.count <= 100 else { throw KMAPIError.invalidResponse }
            let decodedUserID = try KMNativeCrypto.decodeBase64URL(id)
            guard !decodedUserID.isEmpty, decodedUserID.count <= 64 else { throw KMAPIError.invalidResponse }
            userID = decodedUserID; username = userName; allowedCredentialIDs = nil
        } else {
            userID = nil; username = nil
            if case .array(let credentials)? = optionObject["allowCredentials"] {
                guard credentials.count <= 100 else { throw KMAPIError.invalidResponse }
                allowedCredentialIDs = try credentials.map { credential in
                    guard case .object(let object) = credential, case .string(let id)? = object["id"] else { throw KMAPIError.invalidResponse }
                    let decodedID = try KMNativeCrypto.decodeBase64URL(id)
                    guard decodedID.count <= 1024 else { throw KMAPIError.invalidResponse }
                    return decodedID
                }
            } else if optionObject["allowCredentials"] == nil {
                allowedCredentialIDs = nil
            } else { throw KMAPIError.invalidResponse }
        }
        let configuredAuthorizer = passkeyAuthorizer
        let adapter = await MainActor.run { configuredAuthorizer ?? KMLivePasskeyAuthorizer() }
        let response = try await adapter.perform(kind: kind, relyingPartyID: rpID, challenge: challengeBytes,
                                                 userID: userID, username: username, allowedCredentialIDs: allowedCredentialIDs)
        try requireCredentialRevision(revision)
        let assertionChallenge = Data(SHA256.hash(data: challengeBytes))
        let attestation = try await appAttest.assertion(keyID: keyID, clientDataHash: assertionChallenge)
        try requireCredentialRevision(revision)
        let passkeyResponse = try JSONDecoder().decode(KMAPIJSON.self, from: response)
        guard case .object = passkeyResponse else { throw KMAPIError.invalidResponse }
        let ceremonyID = try optionsValue(outer, "ceremonyId")
        guard UUID(uuidString: ceremonyID) != nil else { throw KMAPIError.invalidResponse }
        let verify = try KMAPIValidation.request(PasskeyVerifyBody(ceremonyId: ceremonyID,
                                                                   response: passkeyResponse,
                                                                   name: name, assertion: attestation.base64EncodedString()),
            shape: .object(["ceremonyId": .text(max: 36), "response": .any, "name": .text(max: 100), "assertion": .text(max: 65536)], optional: ["name"]))
        let result: NativeSessionResponse = try await nativeSend("POST", "/api/native/passkey/verify", body: verify,
            shape: .object(["sessionToken": .text(max: 43), "expiresAt": .integer()]))
        try requireCredentialRevision(revision)
        try validateNativeSession(result)
        try credentials.write(try KMJSON.encoder().encode(result), key: "session")
        try clearAccessToken()
    }

    private struct PasskeyOptionsBody: Encodable { let kind: String; let keyId: String; let context: String?; let name: String? }
    private struct PasskeyVerifyBody: Encodable { let ceremonyId: String; let response: KMAPIJSON; let name: String?; let assertion: String }
    private func optionsValue(_ object: [String: KMAPIJSON], _ key: String) throws -> String {
        guard case .string(let value)? = object[key] else { throw KMAPIError.invalidResponse }; return value
    }

    private func validatedPasskeyParameters(_ options: [String: KMAPIJSON]) throws -> (Data, String) {
        guard case .string(let challenge)? = options["challenge"] else { throw KMAPIError.invalidResponse }
        let challengeBytes = try KMNativeCrypto.decodeChallenge(challenge)
        var relyingPartyID: String?
        if let value = options["rpId"] {
            guard case .string(let id) = value else { throw KMAPIError.invalidResponse }
            relyingPartyID = id
        }
        if let value = options["rp"] {
            guard case .object(let rp) = value, case .string(let id)? = rp["id"] else { throw KMAPIError.invalidResponse }
            if let relyingPartyID, relyingPartyID != id { throw KMAPIError.invalidResponse }
            relyingPartyID = id
        }
        guard let relyingPartyID, relyingPartyID == configuration.baseURL.host else { throw KMAPIError.invalidResponse }
        return (challengeBytes, relyingPartyID)
    }

    private func requireCredentialRevision(_ revision: Int) throws {
        guard revision == credentialRevision else { throw CancellationError() }
    }

    private func validateNativeSession(_ value: NativeSessionResponse) throws {
        let seconds = Int(now().timeIntervalSince1970)
        guard value.sessionToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              value.expiresAt > seconds, value.expiresAt <= seconds + 14 * 86400 + 60 else { throw KMAPIError.invalidResponse }
    }

    private func nativeSessionAuthorization(required: Bool) throws -> String? {
        let stored: NativeSessionResponse?
        do { stored = try credentials.read("session").map { try KMJSON.decoder().decode(NativeSessionResponse.self, from: $0) } }
        catch { throw KMAPIError.credentialStorage }
        guard let stored, stored.expiresAt > Int(now().timeIntervalSince1970),
              stored.sessionToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil else {
            if required { throw KMAPIError.nativeAuthenticationRequired }; return nil
        }
        return "Native \(stored.sessionToken)"
    }

    private func nativeSendJSON(_ method: String, _ path: String, body: Data? = nil,
                                authorization: String? = nil) async throws -> KMAPIJSON {
        try Task.checkCancellation()
        guard appAttest.isSupported else { throw KMAPIError.nativeUnsupported }
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = method; request.httpBody = body; request.httpShouldHandleCookies = false
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        let revision = credentialRevision
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) }
        catch { if Task.isCancelled { throw CancellationError() }; throw KMAPIError.network }
        try Task.checkCancellation()
        guard revision == credentialRevision else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse, http.url == request.url, data.count <= 1024 * 1024,
              http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "application/json" else { throw KMAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let code = try KMAPIValidation.decode(Failure.self, data: data, shape: .object(["error": .text(max: 100)])).error
            throw KMAPIError.from(status: http.statusCode, code: code)
        }
        guard case .object(let object) = try JSONDecoder().decode(KMAPIJSON.self, from: data),
              Set(object.keys) == ["ceremonyId", "options"],
              case .string(let ceremonyID)? = object["ceremonyId"], UUID(uuidString: ceremonyID) != nil,
              case .object(let options)? = object["options"], options.count <= 64 else { throw KMAPIError.invalidResponse }
        _ = try validatedPasskeyParameters(options)
        return .object(object)
    }

    private func nativeSend<T: Decodable>(_ method: String, _ path: String, body: Data? = nil,
        authorization: String? = nil, shape: KMAPIShape) async throws -> T {
        try Task.checkCancellation()
        guard path == "/api/native/config" || appAttest.isSupported else { throw KMAPIError.nativeUnsupported }
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = method; request.httpBody = body; request.httpShouldHandleCookies = false
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        let revision = credentialRevision
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) }
        catch { if Task.isCancelled { throw CancellationError() }; throw KMAPIError.network }
        try Task.checkCancellation()
        guard revision == credentialRevision else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse, http.url == request.url, data.count <= 1024 * 1024,
              http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "application/json" else { throw KMAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let code = try KMAPIValidation.decode(Failure.self, data: data, shape: .object(["error": .text(max: 100)])).error
            throw KMAPIError.from(status: http.statusCode, code: code)
        }
        return try KMAPIValidation.decode(T.self, data: data, shape: shape)
    }

    /// Integration seam for an approved future login adapter, NOT a login implementation.
    func installAccountSession(value: String, expiresAt: Date) throws {
        guard configuration.originPolicy != .native else { throw KMAPIError.nativeUnsupported }
        guard validCookie(value), expiresAt > now(), expiresAt.timeIntervalSince(now()) <= 14 * 86400 + 60 else { throw KMAPIError.invalidRequest }
        try credentials.write(KMJSON.encoder().encode(KMStoredSession(value: value, expiresAt: expiresAt)), key: "session")
        try clearAccessToken()
    }

    func guestConfiguration() async throws -> KMGuestConfiguration {
        guard configuration.originPolicy != .native else { throw KMAPIError.nativeUnsupported }
        let result: KMGuestConfiguration = try await send("GET", "/api/ai/guest", shape: KMAPIShapes.guestConfig)
        guard result.guestAvailable == (result.turnstileSiteKey != nil) else { throw KMAPIError.invalidResponse }
        return result
    }

    /// Requires a real, single-use Turnstile token from an approved web flow.
    /// Never fabricates a robot-check result or installs a guest automatically.
    func createGuest(turnstileToken: String) async throws {
        guard configuration.originPolicy != .native else { throw KMAPIError.nativeUnsupported }
        struct Body: Codable { let turnstileToken: String }
        let body = try KMAPIValidation.request(Body(turnstileToken: turnstileToken), shape: .object(["turnstileToken": .text(max: 2048)]))
        let revision = credentialRevision
        let result: KMGuestCreated = try await send("POST", "/api/ai/guest", body: body, shape: KMAPIShapes.guestCreated)
        guard revision == credentialRevision else { throw CancellationError() }
        guard validGuestSecret(result.guestSecret) else { throw KMAPIError.invalidResponse }
        try credentials.write(Data(result.guestSecret.utf8), key: "guest")
        try clearAccessToken()
    }

    func accessToken(allowGuest: Bool = true) async throws -> String {
        if configuration.originPolicy == .native { return try await nativeAccessToken(allowGuest: allowGuest) }
        let seconds = Int(now().timeIntervalSince1970)
        if let cachedToken, cachedToken.value.expiresAt > seconds + 30,
           allowGuest || cachedToken.identity == .account { return cachedToken.value.token }
        try credentials.write(nil, key: "ai-token")
        cachedToken = nil
        let revision = credentialRevision
        do {
            let token: KMAIToken = try await send("POST", "/api/ai/token", shape: KMAPIShapes.token)
            return try cache(token, identity: .account, revision: revision)
        } catch KMAPIError.authenticationRequired {
            guard allowGuest else { throw KMAPIError.authenticationRequired }
        }
        guard revision == credentialRevision else { throw CancellationError() }
        guard let data = try credentials.read("guest"), let secret = String(data: data, encoding: .utf8), validGuestSecret(secret) else {
            throw KMAPIError.nativeAuthenticationRequired
        }
        do {
            let token: KMAIToken = try await send("POST", "/api/ai/token", authorization: "Guest \(secret)", shape: KMAPIShapes.token)
            return try cache(token, identity: .guest, revision: revision)
        } catch KMAPIError.authenticationRequired {
            if revision == credentialRevision { try credentials.write(nil, key: "guest") }
            throw KMAPIError.nativeAuthenticationRequired
        }
    }

    func usage(as identity: Identity = .account) async throws -> KMAIUsage {
        var authorization: String?
        if identity == .guest {
            if configuration.originPolicy == .native {
                let guest: NativeSessionResponse?
                do { guest = try credentials.read("guest").map { try KMJSON.decoder().decode(NativeSessionResponse.self, from: $0) } }
                catch { throw KMAPIError.credentialStorage }
                guard let guest, guest.expiresAt > Int(now().timeIntervalSince1970),
                      guest.sessionToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil else { throw KMAPIError.nativeAuthenticationRequired }
                authorization = "Native \(guest.sessionToken)"
            } else {
                guard let data = try credentials.read("guest"), let secret = String(data: data, encoding: .utf8), validGuestSecret(secret) else { throw KMAPIError.nativeAuthenticationRequired }
                authorization = "Guest \(secret)"
            }
        } else if configuration.originPolicy == .native {
            authorization = try nativeSessionAuthorization(required: true)
        }
        let periodKey = identity == .guest ? "day" : "month"
        let shape: KMAPIShape = .object([
            "plan": .values(identity == .guest ? ["guest"] : ["free", "pro", "family"]),
            "period": .values([periodKey]), periodKey: identity == .guest ? .date : .month,
            "used": .integer(), "limit": .nullable(.integer()), "remaining": .nullable(.integer())
        ])
        let result: KMAIUsage = try await send("GET", "/api/ai/usage", authorization: authorization, shape: shape)
        if let limit = result.limit {
            guard result.remaining == max(0, limit - result.used) else { throw KMAPIError.invalidResponse }
        } else {
            guard identity == .account, result.remaining == nil else { throw KMAPIError.invalidResponse }
        }
        return result
    }

    func costs(month: KMYearMonth) async throws -> KMAICosts {
        guard month.rawValue >= "2000-01", month.rawValue <= "9998-12" else { throw KMAPIError.invalidRequest }
        let result: KMAICosts = try await send("GET", "/api/ai/costs", query: [URLQueryItem(name: "month", value: month.rawValue)], shape: KMAPIShapes.costs)
        let g = result.providers.gemini, j = result.providers.jev
        guard result.month == month, result.totalUsdMicros == g.costUsdMicros + j.costUsdMicros,
              result.unknownRequests == g.unknownRequests + j.unknownRequests,
              g.unknownRequests <= g.requests, j.unknownRequests <= j.requests else { throw KMAPIError.invalidResponse }
        return result
    }

    func readReceipt(image: KMUploadImage, flowID: UUID = UUID()) async throws -> KMReceiptExtraction {
        let body = try imageBody(image, flowID: flowID, maskingConfirmed: nil)
        let token = try await accessToken()
        let result: KMReceiptExtraction = try await send("POST", "/api/ai/gemini", body: body, authorization: "Bearer \(token)", shape: KMAPIShapes.receipt)
        try KMAPIShapes.validateReceipt(result)
        return result
    }

    func readPayroll(image: KMMaskedPayrollImage, flowID: UUID = UUID()) async throws -> KMPayrollResponse {
        let body = try imageBody(image.upload, flowID: flowID, maskingConfirmed: true)
        let token = try await accessToken()
        return try await send("POST", "/api/ai/payroll", body: body, authorization: "Bearer \(token)", shape: KMAPIShapes.payroll)
    }

    /// The extraction must be the same validated Gemini output bound to this flow.
    /// Local learning runs first; only unresolved first-30 item indexes should be passed.
    func classify(extraction: KMReceiptExtraction, flowID: UUID, categories: [KMCategoryOption], itemIndexes: [Int]? = nil) async throws -> KMCategoryAnswers {
        try KMAPIValidation.flow(flowID); try KMAPIShapes.validateOptions(categories)
        // Do not accept callers' malformed domain values merely because Codable encoded them.
        _ = try KMAPIValidation.request(extraction, shape: KMAPIShapes.receipt.encodingShape)
        try KMAPIShapes.validateReceipt(extraction)
        let items = extraction.items.prefix(30).map { KMCategoryRequest.Receipt.Item(name: String($0.name.trimmingCharacters(in: .whitespacesAndNewlines).utf16Prefix(200)), amountYen: $0.amountYen) }
        let merchant = extraction.merchant.map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).utf16Prefix(200)) }
        guard merchant != nil || !items.isEmpty else { throw KMAPIError.invalidRequest }
        if let indexes = itemIndexes {
            guard !indexes.isEmpty, Set(indexes).count == indexes.count, indexes.allSatisfy({ (0..<items.count).contains($0) }) else { throw KMAPIError.invalidRequest }
        }
        let body = try KMAPIValidation.request(KMCategoryRequest(flowId: flowID.uuidString, receipt: .init(merchant: merchant, totalAmountYen: extraction.totalAmountYen, items: items), categories: categories, itemIndexes: itemIndexes), shape: KMAPIShapes.categoryRequest)
        let token = try await accessToken()
        let result: KMCategoryAnswers = try await send("POST", "/api/ai/jev", body: body, authorization: "Bearer \(token)", shape: KMAPIShapes.categoryAnswers)
        let expected = items.isEmpty ? ["category"] : (itemIndexes ?? Array(items.indices)).map { "item_\($0)" }
        guard Set(result.answers.keys) == Set(expected) else { throw KMAPIError.invalidResponse }
        let ids = Set(categories.map(\.id))
        for answer in result.answers.values {
            guard ids.contains(answer.choice), Set(answer.probabilities.keys) == ids,
                  abs(answer.probabilities.values.reduce(0, +) - 1) <= Decimal(string: "0.02")!,
                  answer.probabilities[answer.choice] == answer.probabilities.values.max() else { throw KMAPIError.invalidResponse }
        }
        return result
    }

    func suggestCategory(sourceCategoryName: String, categories: [KMCategoryOption], flowID: UUID = UUID()) async throws -> KMCategorySuggestion {
        try KMAPIValidation.flow(flowID); try KMAPIShapes.validateOptions(categories)
        let body = try KMAPIValidation.request(KMCategorySuggestionRequest(flowId: flowID.uuidString, sourceCategoryName: sourceCategoryName, categories: categories), shape: .object(["flowId": .text(max: 36), "sourceCategoryName": .text(max: 200), "categories": KMAPIShapes.categoryOptions]))
        let token = try await accessToken()
        let result: KMCategorySuggestion = try await send("POST", "/api/ai/category-suggestion", body: body, authorization: "Bearer \(token)", shape: .object(["categoryId": .nullable(.text(max: 128))]))
        guard result.categoryId == nil || categories.contains(where: { $0.id == result.categoryId }) else { throw KMAPIError.invalidResponse }
        return result
    }

    func submitContact(kind: KMContactResult.Kind, message: String, originalMessage: String? = nil, flowID: UUID) async throws -> KMContactResult {
        try KMAPIValidation.flow(flowID)
        let body = try KMAPIValidation.request(KMContactRequest(flowId: flowID.uuidString, kind: kind, message: message, originalMessage: originalMessage), shape: .object(["flowId": .text(max: 36), "kind": .values(["bug", "improvement", "question"]), "message": .text(max: 4000), "originalMessage": .text(max: 4000)], optional: ["originalMessage"]))
        guard body.count <= 20 * 1024 else { throw KMAPIError.invalidRequest }
        let token = try await accessToken(allowGuest: false)
        let result: KMContactResult = try await send("POST", "/api/contact", body: body, authorization: "Bearer \(token)", shape: KMAPIShapes.contactResult)
        guard result.kind == kind else { throw KMAPIError.invalidResponse }
        return result
    }

    /// The caller retains this flow ID for an explicit retry of the same recording.
    func transcribe(audio: KMUploadAudio, flowID: UUID) async throws -> KMTranscription {
        try KMAPIValidation.flow(flowID)
        let body = try JSONEncoder().encode(KMAudioRequest(flowId: flowID.uuidString, audioBase64: audio.data.base64EncodedString(), contentType: audio.contentType))
        let token = try await accessToken(allowGuest: false)
        return try await send("POST", "/api/contact/transcribe", body: body, authorization: "Bearer \(token)", shape: .object(["text": .text(max: 4000)]))
    }

    func accountSession() async throws -> KMCloudSession? {
        let result: KMCloudSession? = try await send("GET", "/api/auth/get-session", shape: KMAPIShapes.cloudSession)
        if let result {
            guard result.session.userId == result.user.id, result.session.expiresAt > now(),
                  result.session.createdAt <= result.session.updatedAt else { throw KMAPIError.invalidResponse }
        }
        return result
    }

    func listPasskeys() async throws -> [KMCloudPasskey] {
        let result: [KMCloudPasskey] = try await send("GET", "/api/auth/passkey/list-user-passkeys", shape: KMAPIShapes.passkeys)
        guard Set(result.map(\.id)).count == result.count else { throw KMAPIError.invalidResponse }
        return result
    }

    func deletePasskey(id: String) async throws {
        struct Body: Codable { let id: String }
        let body = try KMAPIValidation.request(Body(id: id), shape: .object(["id": .text(max: 128)]))
        let result: KMPasskeyDeleted = try await send("POST", "/api/auth/passkey/delete-passkey", body: body, shape: .object(["status": .boolean]))
        guard result.status else { throw KMAPIError.invalidResponse }
    }

    func signOut() async throws {
        try clearAccessToken()
        let result: KMSignOut = try await send("POST", "/api/auth/sign-out", body: Data("{}".utf8), shape: .object(["success": .boolean]))
        guard result.success else { throw KMAPIError.invalidResponse }
        try credentials.write(nil, key: "session")
        try clearAccessToken()
    }

    func deleteAccount() async throws -> KMAccountDeletion {
        try clearAccessToken()
        let result: KMAccountDeletion = try await send("DELETE", "/api/account/delete", shape: .object(["deleted": .boolean, "localHouseholdDataPreserved": .boolean]))
        guard result.deleted, result.localHouseholdDataPreserved else { throw KMAPIError.invalidResponse }
        try credentials.write(nil, key: "session")
        try clearAccessToken()
        return result
    }

    func clearAccessToken() throws {
        credentialRevision += 1; cachedToken = nil
        try credentials.write(nil, key: "ai-token")
    }

    private func cache(_ token: KMAIToken, identity: Identity, revision: Int) throws -> String {
        guard revision == credentialRevision else { throw CancellationError() }
        let seconds = Int(now().timeIntervalSince1970)
        let tokenPattern = configuration.originPolicy == .native ? #"^[A-Za-z0-9_-]{43}$"# : #"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$"#
        guard token.expiresAt > seconds, token.expiresAt <= seconds + 600,
              token.token.range(of: tokenPattern, options: .regularExpression) != nil else { throw KMAPIError.invalidResponse }
        if configuration.originPolicy != .native { try credentials.write(JSONEncoder().encode(token), key: "ai-token") }
        cachedToken = (token, identity)
        return token.token
    }

    private func imageBody(_ image: KMUploadImage, flowID: UUID, maskingConfirmed: Bool?) throws -> Data {
        try KMAPIValidation.flow(flowID)
        return try JSONEncoder().encode(KMImageRequest(flowId: flowID.uuidString, imageBase64: image.data.base64EncodedString(), contentType: image.contentType, maskingConfirmed: maskingConfirmed))
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: Data? = nil, authorization: String? = nil,
                                    query: [URLQueryItem] = [], shape: KMAPIShape) async throws -> T {
        try Task.checkCancellation()
        if configuration.originPolicy == .native, !appAttest.isSupported { throw KMAPIError.nativeUnsupported }
        var components = URLComponents(url: configuration.baseURL, resolvingAgainstBaseURL: false)!
        let requestPath = configuration.originPolicy == .native ? "/api/native" + String(path.dropFirst(4)) : path
        components.path = String(requestPath); components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method; request.httpBody = body; request.httpShouldHandleCookies = false
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if configuration.originPolicy == .existingWorkerCompatibility { request.setValue(configuration.origin, forHTTPHeaderField: "Origin") }
        var requestAuthorization = authorization
        if configuration.originPolicy == .native, requestAuthorization == nil {
            requestAuthorization = try nativeSessionAuthorization(required: false)
        }
        request.setValue(requestAuthorization, forHTTPHeaderField: "Authorization")
        if configuration.originPolicy != .native, let stored = try credentials.read("session") {
            let cookie: KMStoredSession
            do { cookie = try KMJSON.decoder().decode(KMStoredSession.self, from: stored) }
            catch { throw KMAPIError.credentialStorage }
            guard validCookie(cookie.value) else { throw KMAPIError.credentialStorage }
            if cookie.expiresAt > now() { request.setValue("__Secure-better-auth.session_token=\(cookie.value)", forHTTPHeaderField: "Cookie") }
            else { try credentials.write(nil, key: "session") }
        }
        let revision = credentialRevision
        let data: Data; let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw KMAPIError.network
        }
        try Task.checkCancellation()
        guard revision == credentialRevision else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse, http.url == request.url,
              data.count <= 1024 * 1024,
              http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "application/json" else { throw KMAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let code: String?
            if path.hasPrefix("/api/auth/"), let json = try? JSONDecoder().decode(KMAPIJSON.self, from: data),
               case .object(let object) = json, object["message"] != nil {
                _ = try KMAPIValidation.decode(AuthFailure.self, data: data, shape: .object(["code": .text(max: 100), "message": .text(max: 2000)], optional: ["code"]))
                code = http.statusCode == 401 ? "unauthorized" : nil
            } else {
                code = try KMAPIValidation.decode(Failure.self, data: data, shape: .object(["error": .text(max: 100)])).error
            }
            let error = KMAPIError.from(status: http.statusCode, code: code)
            if http.statusCode == 401, authorization?.hasPrefix("Bearer ") == true { try clearAccessToken() }
            throw error
        }
        let result = try KMAPIValidation.decode(T.self, data: data, shape: shape)
        if configuration.originPolicy != .native, let header = http.value(forHTTPHeaderField: "Set-Cookie") {
            for cookie in HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: request.url!) where cookie.name == "__Secure-better-auth.session_token" {
                guard cookie.domain == configuration.baseURL.host, cookie.path == "/", cookie.isSecure else { throw KMAPIError.invalidResponse }
                if let expiry = cookie.expiresDate, expiry > now() {
                    guard validCookie(cookie.value) else { throw KMAPIError.invalidResponse }
                    guard expiry.timeIntervalSince(now()) <= 14 * 86400 + 60 else { throw KMAPIError.invalidResponse }
                    try credentials.write(KMJSON.encoder().encode(KMStoredSession(value: cookie.value, expiresAt: expiry)), key: "session")
                } else { try credentials.write(nil, key: "session") }
            }
        }
        return result
    }

    private func validGuestSecret(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
    }
    private func validCookie(_ value: String) -> Bool {
        value.utf8.count <= 8192 && value.range(of: #"^[A-Za-z0-9._%+=/-]+$"#, options: .regularExpression) != nil
    }
}

private extension String {
    func utf16Prefix(_ length: Int) -> String {
        // Never split a surrogate pair. JS .slice(0, 200) can; native rejects that edge instead.
        var result = ""
        for scalar in unicodeScalars {
            guard result.utf16.count + scalar.utf16.count <= length else { break }
            result.unicodeScalars.append(scalar)
        }
        return result
    }
}

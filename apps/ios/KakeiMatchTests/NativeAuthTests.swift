import CryptoKit
import Foundation
import Testing
@testable import KakeiMatch

@Suite
struct NativeAuthTests {
    @Test
    func appAttestChallengeHashUsesDecodedBase64URLBytes() throws {
        let challenge = Data(repeating: 0x2a, count: 32)
        let encoded = KMNativeCrypto.base64URL(challenge)
        #expect(try KMNativeCrypto.decodeBase64URL(encoded) == challenge)
        #expect(try KMNativeCrypto.clientDataHash(challenge: encoded) == Data(SHA256.hash(data: challenge)))
    }

    @Test(arguments: ["", "a=b", "+/==", "not base64url!", "AB"])
    func malformedOrNoncanonicalBase64URLIsRejected(_ challenge: String) {
        #expect(throws: KMAPIError.invalidResponse) { try KMNativeCrypto.decodeBase64URL(challenge) }
    }

    @Test
    func challengesMustBeCanonicalBase64URLEncodingOfExactly32Bytes() throws {
        let challenge = KMNativeCrypto.base64URL(Data(repeating: 0x2a, count: 32))
        #expect(try KMNativeCrypto.decodeChallenge(challenge).count == 32)
        #expect(throws: KMAPIError.invalidResponse) {
            try KMNativeCrypto.decodeChallenge(KMNativeCrypto.base64URL(Data(repeating: 0x2a, count: 31)))
        }
        #expect(throws: KMAPIError.invalidResponse) {
            try KMNativeCrypto.decodeChallenge(KMNativeCrypto.base64URL(Data(repeating: 0x2a, count: 33)))
        }
    }
}

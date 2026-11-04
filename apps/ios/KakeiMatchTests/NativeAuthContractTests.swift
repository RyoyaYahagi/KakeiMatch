import Foundation
import Testing
@testable import KakeiMatch

private final class NativeAuthContractBundle {}

/// The Worker contract test writes these files from real Better Auth + local D1
/// responses. Volatile IDs, tokens, and timestamps are normalized there; every
/// field name, type, and nullable/optional position is the server's response.
struct NativeAuthContractTests {
    private func data(_ name: String) throws -> Data {
        let url = try #require(Bundle(for: NativeAuthContractBundle.self)
            .url(forResource: name, withExtension: "json", subdirectory: "Fixtures/native-contract"))
        return try Data(contentsOf: url)
    }

    @Test func cloudSessionFixturePassesTheShapeAndDecodesWithoutNetworkFields() throws {
        let session = try KMAPIValidation.decode(KMCloudSession.self, data: data("get-session"), shape: KMAPIShapes.cloudSession)
        #expect(session.user.id == session.session.userId)
        #expect(session.user.name == "Synthetic invited member")
        #expect(session.user.email == "contract-member@example.invalid")
        #expect(session.user.emailVerified == false)
        #expect(session.user.image == nil)
        #expect(session.session.ipAddress == nil)
        #expect(session.session.userAgent == nil)
        #expect(session.session.createdAt <= session.session.updatedAt)
        #expect(session.session.expiresAt > session.session.createdAt)
    }

    @Test func accountUsageFixtureUsesTheSameShapeAsTheWorkerClient() throws {
        let usage = try KMAPIValidation.decode(KMAIUsage.self, data: data("ai-usage"), shape: KMAPIShapes.accountUsage)
        #expect(usage.plan == .family)
        #expect(usage.period == .month)
        #expect(usage.month?.rawValue == "2026-11")
        #expect(usage.used == 0)
        #expect(usage.limit == nil)
        #expect(usage.remaining == nil)
    }

    @Test func passkeysFixtureUsesTheSameShapeAndDecodesBooleanAndInstantFields() throws {
        let passkeys = try KMAPIValidation.decode([KMCloudPasskey].self, data: data("passkeys"), shape: KMAPIShapes.passkeys)
        #expect(passkeys.count == 1)
        #expect(Set(passkeys.map(\.id)).count == passkeys.count)
        let passkey = try #require(passkeys.first)
        #expect(passkey.name == "契約テスト端末")
        #expect(passkey.userId == "synthetic-account")
        #expect(passkey.counter == 1)
        #expect(passkey.deviceType == "singleDevice")
        #expect(passkey.backedUp == false)
        #expect(passkey.transports == "internal")
        #expect(passkey.createdAt != nil)
        #expect(passkey.aaguid == "00000000-0000-0000-0000-000000000000")
    }
}

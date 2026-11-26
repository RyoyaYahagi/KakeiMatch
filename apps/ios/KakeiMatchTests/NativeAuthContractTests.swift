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
        #expect(usage.supportId == "synthetic-account")
    }

    @Test func dailyCapUsageIsAcceptedForAccountsWithoutAMonthlyPlan() throws {
        let free = Data(#"{"plan":"free","period":"day","day":"2026-11-26","used":2,"limit":5,"remaining":3}"#.utf8)
        let usage = try KMAPIValidation.decode(KMAIUsage.self, data: free, shape: KMAPIShapes.accountUsage)
        #expect(usage.plan == .free)
        #expect(usage.period == .day)
        #expect(usage.day != nil)
        #expect(usage.month == nil)
        #expect(usage.limit == 5)

        let linkedGuest = Data(#"{"plan":"guest","period":"day","day":"2026-11-26","used":0,"limit":5,"remaining":5}"#.utf8)
        #expect(try KMAPIValidation.decode(KMAIUsage.self, data: linkedGuest, shape: KMAPIShapes.accountUsage).plan == .guest)
    }

    @Test func accountUsageRejectsMixedOrUnknownForms() {
        let unknownPlan = Data(#"{"plan":"enterprise","period":"day","day":"2026-11-26","used":0,"limit":5,"remaining":5}"#.utf8)
        let mixed = Data(#"{"plan":"free","period":"day","month":"2026-11","day":"2026-11-26","used":0,"limit":5,"remaining":5}"#.utf8)
        #expect(throws: KMAPIError.self) { try KMAPIValidation.decode(KMAIUsage.self, data: unknownPlan, shape: KMAPIShapes.accountUsage) }
        #expect(throws: KMAPIError.self) { try KMAPIValidation.decode(KMAIUsage.self, data: mixed, shape: KMAPIShapes.accountUsage) }
    }

    @Test func accountUsageAcceptsOptionalAndNullSupportId() throws {
        let withSupportId = Data(#"{"plan":"guest","period":"day","day":"2026-11-26","used":1,"limit":5,"remaining":4,"supportId":"sup_abc123"}"#.utf8)
        let decoded = try KMAPIValidation.decode(KMAIUsage.self, data: withSupportId, shape: KMAPIShapes.accountUsage)
        #expect(decoded.supportId == "sup_abc123")

        let monthlyWithSupportId = Data(#"{"plan":"family","period":"month","month":"2026-11","used":0,"limit":null,"remaining":null,"supportId":"sup_month"}"#.utf8)
        let monthlyDecoded = try KMAPIValidation.decode(KMAIUsage.self, data: monthlyWithSupportId, shape: KMAPIShapes.accountUsage)
        #expect(monthlyDecoded.supportId == "sup_month")

        let withNullSupportId = Data(#"{"plan":"free","period":"day","day":"2026-11-26","used":0,"limit":5,"remaining":5,"supportId":null}"#.utf8)
        #expect(try KMAPIValidation.decode(KMAIUsage.self, data: withNullSupportId, shape: KMAPIShapes.accountUsage).supportId == nil)

        let withoutSupportId = Data(#"{"plan":"free","period":"month","month":"2026-11","used":1,"limit":10,"remaining":9}"#.utf8)
        #expect(try KMAPIValidation.decode(KMAIUsage.self, data: withoutSupportId, shape: KMAPIShapes.accountUsage).supportId == nil)
    }

    @Test func accountUsageRejectsEmptyNonStringAndOverlongSupportId() {
        let empty = Data(#"{"plan":"guest","period":"day","day":"2026-11-26","used":0,"limit":5,"remaining":5,"supportId":""}"#.utf8)
        let blank = Data(#"{"plan":"guest","period":"day","day":"2026-11-26","used":0,"limit":5,"remaining":5,"supportId":"   "}"#.utf8)
        let number = Data(#"{"plan":"guest","period":"day","day":"2026-11-26","used":0,"limit":5,"remaining":5,"supportId":123}"#.utf8)
        let overlong = Data((#"{"plan":"guest","period":"day","day":"2026-11-26","used":0,"limit":5,"remaining":5,"supportId":""# + String(repeating: "a", count: 129) + #""}"#).utf8)
        for payload in [empty, blank, number, overlong] {
            #expect(throws: KMAPIError.self) { try KMAPIValidation.decode(KMAIUsage.self, data: payload, shape: KMAPIShapes.accountUsage) }
        }
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

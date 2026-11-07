import Foundation
import Testing
@testable import KakeiMatchCore

struct ReconciliationAnalyticsTests {
    private let at = Date(timeIntervalSince1970: 1_798_761_600)
    private func run() -> KMReconciliationRun {
        var value = KMReconciliationRun(runId: "private-run", createdAt: at, completedAt: at, ruleVersion: "1.2.0",
            candidates: [.init(statementTransactionId: "private-statement", receiptId: "private-receipt", rank: 1, score: Decimal(string: "0.8")!, amountDeltaYen: 20, dateDistanceDays: 1, merchantSimilarity: Decimal(string: "0.5")!, reasons: ["amount_close"])],
            statementResults: [.init(statementTransactionId: "private-statement", status: .needsReview, reasonCodes: [])], receiptResults: [])
        value.analysis = .init(statements: [.init(id: "private-statement", merchant: "秘密の店舗", date: "2026-11-01", amountYen: 12345, paymentSource: "秘密のカード")],
            candidates: [.init(id: "private-receipt", merchant: "秘密の店舗", date: "2026-10-31", amountYen: 12325, paymentSource: "秘密のカード")])
        return value
    }
    private func event(kind: String = "decision", source: String = "user", status: String = "applied") -> KMReconciliationAnalysis.Event {
        .init(at: at, statementId: "private-statement", receiptId: "private-receipt", kind: kind, source: source, resolution: "same_expense", status: status)
    }
    @Test func testExportsAreSeparateFromNormalMetrics() throws {
        var value = run(); value.mode = "test"
        #expect(KMReconciliationAnalytics.summarize([value]).runs == 0)
        let normal = try #require(try JSONSerialization.jsonObject(with: KMReconciliationAnalytics.export([value], detailed: true, at: at)) as? [String: Any])
        #expect((normal["runs"] as? [Any])?.isEmpty == true)
        let report = try #require(try JSONSerialization.jsonObject(with: KMReconciliationAnalytics.export([value], detailed: true, at: at, test: true)) as? [String: Any])
        #expect(report["scope"] as? String == "test")
        #expect((report["runs"] as? [[String: Any]])?.first?["mode"] as? String == "test")
    }
    @Test func denominatorsUndoAndRetries() {
        var value = run()
        #expect(KMReconciliationAnalytics.summarize([value]).manualMatches == 0)
        value.analysis?.events = [event(status: "failed"), event()]
        #expect(KMReconciliationAnalytics.summarize([value]).firstChoices == 1)
        #expect(KMReconciliationAnalytics.summarize([value]).failed == 0)
        var rerun = run(); rerun.runId = "rerun"
        #expect(KMReconciliationAnalytics.summarize([value, rerun]).statements == 1)
        value.analysis?.events.append(event(kind: "undo"))
        #expect(KMReconciliationAnalytics.summarize([value]).manualMatches == 0)
        #expect(value.analysis?.events.count == 3)
        value.analysis?.events = [event(source: "automatic")]
        #expect(KMReconciliationAnalytics.summarize([value]).manualMatches == 0)
    }
    @Test func exportRemovesTransactionContentsAndIds() throws {
        var value = run(); value.analysis?.events = [event()]
        let anonymous = String(decoding: try KMReconciliationAnalytics.export([value], detailed: false, at: at), as: UTF8.self)
        for secret in ["秘密", "private-", "12345", "12325", "2026-11-01", "2026-10-31"] { #expect(!anonymous.contains(secret)) }
        let detailed = String(decoding: try KMReconciliationAnalytics.export([value], detailed: true, at: at), as: UTF8.self)
        #expect(detailed.contains("秘密の店舗"))
        let decoded = try JSONDecoder().decode(KMReconciliationAnalysis.self, from: JSONEncoder().encode(value.analysis!))
        #expect(decoded == value.analysis)
    }
}

import Foundation
import Testing
@testable import KakeiMatchCore

struct ReconciliationEngineTests {
    @Test func paymentSourceOutweighsDateAndMerchantAtEqualAmounts() {
        let result = KMReconciliationEngine.run(
            statements: [statement("s")],
            receipts: [receipt("correct", merchant: "別の表記", date: "2026-09-03", account: "account-2")] + ["a", "b", "c"].map { receipt($0) },
            preferredAccountIds: ["s": ["account-2"]])
        #expect(result.candidates.count == 3)
        #expect(result.candidates.first?.receiptId == "correct")
        #expect(result.candidates.first?.reasons.contains("payment_source_match") == true)
        #expect(result.statementResults.first?.status == .needsReview)

        let amountDifference = KMReconciliationEngine.run(
            statements: [statement("s")],
            receipts: [receipt("mapped", amount: 1100, account: "account-2"), receipt("exact", merchant: "別の表記", date: "2026-09-03")],
            preferredAccountIds: ["s": ["account-2"]])
        #expect(amountDifference.candidates.map(\.receiptId) == ["exact", "mapped"])
    }

    @Test func kanaVariantsStayInTopThreeWithoutAutomaticIdentity() {
        for (merchant, equivalent) in [("アオゾラストア", "あおぞらストア"), ("ｱｵｿﾞﾗｽﾄｱ", "あおぞらストア"), ("あおぞらストア", "アオゾラストア")] {
            let result = KMReconciliationEngine.run(
                statements: [statement("s", merchant: merchant)],
                receipts: [receipt("correct", merchant: equivalent)] + ["アオゾラカフェ", "アオゾラホテル", "アオゾラ薬局"].enumerated().map { receipt("noise-\($0.offset)", merchant: $0.element) })
            #expect(result.candidates.count == 3)
            #expect(result.candidates.first?.receiptId == "correct")
            #expect(result.candidates.first?.merchantSimilarity == 1)
            #expect(result.candidates.first?.score == Decimal(string: "0.75"))
            #expect(result.candidates.first?.reasons.contains("merchant_similar") == true)
            #expect(result.statementResults.first?.status == .needsReview)
        }
        let single = KMReconciliationEngine.run(statements: [statement("s", merchant: "アオゾラストア")], receipts: [receipt("r", merchant: "あおぞらストア")])
        #expect(single.statementResults.first?.status == .needsReview)
        #expect(single.candidates.first?.reasons.contains("merchant_alias_match") == false)
        #expect(KMReconciliationEngine.aliasKey("アオゾラストア", "別名") != KMReconciliationEngine.aliasKey("あおぞらストア", "別名"))
    }

    private func statement(_ id: String, merchant: String = "架空ストア新宿", amount: Int = 1200, date: String = "2026-09-10", kind: KMStatementTransaction.Kind = .purchase) -> KMStatementTransaction {
        KMStatementTransaction(id: id, importId: "import-\(id)", provider: .paypayCard, externalId: nil, kind: kind,
            usedDate: KMDate(rawValue: date), usedTime: nil, postedDate: nil, merchant: merchant, amountYen: amount,
            paymentMethod: nil, sourceFingerprint: "fingerprint-\(id)", duplicateOrdinal: 0)
    }
    private func receipt(_ id: String, merchant: String = "架空ストア新宿", amount: Int = 1200, date: String = "2026-09-10", account: String = "account-1") -> KMReconciliationReceipt {
        KMReconciliationReceipt(receiptId: id, actualTransactionId: "actual-\(id)", merchant: merchant,
            purchasedDate: KMDate(rawValue: date), amountYen: amount, actualAccountId: account)
    }

    @Test func merchantNormalizationAndSimilarityParity() {
        #expect(KMReconciliationEngine.normalizeMerchant("  ＡＢＣ　 STORE・新宿  ") == "abcstore新宿")
        #expect(KMReconciliationEngine.normalizeMerchant("コーヒー・店") == "コーヒー店")
        #expect(KMReconciliationEngine.merchantSimilarity("", "") == 0)
        #expect(KMReconciliationEngine.merchantSimilarity("架空 ストア", "架空　ストア") == 1)
        #expect(KMReconciliationEngine.merchantSimilarity("セブン－イレブン新宿店", "セブン イレブン新宿店") > Decimal(string: "0.7")!)
        #expect(KMReconciliationEngine.merchantSimilarity("架空ストア新宿", "全く別の薬局") < Decimal(string: "0.2")!)
        #expect(KMReconciliationEngine.aliasKey("ＡＢＣ store", "xyz") == KMReconciliationEngine.aliasKey("xyz", "abc STORE"))
        #expect(KMReconciliationEngine.pairKey("s", "r") == "s\0r")
    }

    @Test func exactUniqueMatchAndDateWindow() {
        let result = KMReconciliationEngine.run(statements: [statement("s1")], receipts: [receipt("r1")])
        #expect(result.ruleVersion == "1.2.4")
        #expect(result.statementResults == [.init(statementTransactionId: "s1", status: .matched, matchedReceiptId: "r1", reasonCodes: ["automatic_high_confidence_match"])])
        #expect(result.candidates.first?.score == Decimal(string: "0.75")!)
        #expect(result.candidates.first?.reasons == ["amount_exact", "date_close", "merchant_similar"])
        for distance in 1...7 {
            let day = String(format: "2026-09-%02d", 10 - distance)
            let candidate = KMReconciliationEngine.run(statements: [statement("s")], receipts: [receipt("r", date: day)])
            #expect(candidate.candidates.count == 1)
            #expect(candidate.statementResults[0].status == (distance <= 2 ? .matched : .needsReview))
        }
        let outside = KMReconciliationEngine.run(statements: [statement("s")], receipts: [receipt("r", date: "2026-09-02")])
        #expect(outside.candidates.isEmpty)
    }

    @Test func merchantNormalizationMatchesConfirmedVpassAndCorporateForms() {
        let f3Merchant = "ﾀﾞｲﾄﾞ-ﾄﾞﾘﾝｺ ｶ"
        #expect(KMReconciliationEngine.normalizeMerchant(f3Merchant)
            == KMReconciliationEngine.normalizeMerchant(KMReconciliationEngine.normalizeMerchant(f3Merchant)))
        for merchant in ["株式会社青空食堂", "（株）青空食堂", "㈱青空食堂", "カブシキガイシャ青空食堂",
                         "青空食堂株式会社", "青空食堂（株）", "青空食堂㈱", "青空食堂カブシキガイシャ"] {
            #expect(KMReconciliationEngine.merchantSimilarity(merchant, "青空食堂") == 1)
        }
        #expect(KMReconciliationEngine.merchantSimilarity("架空株式会社ストア", "架空ストア") < 1)
        let f3 = KMReconciliationEngine.run(
            statements: [statement("s", merchant: "Ｖｉｓａ国内利用 Vs \(f3Merchant)")],
            receipts: [receipt("r", merchant: f3Merchant)])
        #expect(f3.candidates.first?.merchantSimilarity == 1)
        #expect(f3.statementResults.first?.status == .matched)
    }

    @Test func paymentSourceWaiverRequiresExactAmountUniquenessOnBothSides() {
        let preferred: [String: Set<String>] = ["s": ["account-2"]]
        let unique = KMReconciliationEngine.run(
            statements: [statement("s", merchant: "明細不明")],
            receipts: [receipt("r", merchant: "内容なし", account: "account-2")],
            preferredAccountIds: preferred)
        #expect(unique.statementResults.first?.status == .matched)
        #expect(unique.statementResults.first?.matchedReceiptId == "r")
        #expect(unique.candidates.first?.merchantSimilarity == 0)

        let receiptConflict = KMReconciliationEngine.run(
            statements: [statement("s", merchant: "明細不明")],
            receipts: [receipt("r", merchant: "内容なし", account: "account-2"), receipt("competitor", date: "2026-09-17", account: "account-3")],
            preferredAccountIds: preferred)
        #expect(receiptConflict.statementResults.first?.status == .needsReview)

        let statementConflict = KMReconciliationEngine.run(
            statements: [statement("s", merchant: "明細不明"), statement("competitor", merchant: "別の明細", date: "2026-09-17")],
            receipts: [receipt("r", merchant: "内容なし", account: "account-2")],
            preferredAccountIds: preferred)
        #expect(statementConflict.statementResults.first(where: { $0.statementTransactionId == "s" })?.status == .needsReview)

        let excludedConflict = KMReconciliationEngine.run(
            statements: [statement("s", merchant: "明細不明")],
            receipts: [receipt("r", merchant: "内容なし", account: "account-2"), receipt("excluded", date: "2026-09-17", account: "account-3")],
            preferredAccountIds: preferred, excludedReceiptIds: ["excluded"])
        #expect(excludedConflict.statementResults.first?.status == .needsReview)

        let rejectedConflict = KMReconciliationEngine.run(
            statements: [statement("s", merchant: "明細不明")],
            receipts: [receipt("r", merchant: "内容なし", account: "account-2"), receipt("rejected", date: "2026-09-17", account: "account-3")],
            preferredAccountIds: preferred, rejectedPairs: [KMReconciliationEngine.pairKey("s", "rejected")])
        #expect(rejectedConflict.statementResults.first?.status == .needsReview)

        let outsideWindow = KMReconciliationEngine.run(
            statements: [statement("s", merchant: "明細不明")],
            receipts: [receipt("r", merchant: "内容なし", account: "account-2"), receipt("outside", date: "2026-09-18", account: "account-3")],
            preferredAccountIds: preferred)
        #expect(outsideWindow.statementResults.first?.status == .matched)
    }

    @Test func reviewToleranceAliasAndUnrelatedMerchant() {
        let near = KMReconciliationEngine.run(statements: [statement("s")], receipts: [receipt("r", amount: 1160)])
        #expect(near.candidates.first?.amountDeltaYen == 40)
        #expect(near.statementResults[0].status == .needsReview)
        let unrelated = KMReconciliationEngine.run(statements: [statement("s")], receipts: [receipt("r", merchant: "全く別の薬局")])
        #expect(unrelated.statementResults[0].status == .needsReview)
        let pair = KMReconciliationEngine.run(statements: [statement("s", merchant: "青空ストア")], receipts: [receipt("r", merchant: "青空商店")], aliases: [KMReconciliationEngine.aliasKey("青空ストア", "青空商店")])
        #expect(pair.statementResults[0].status == .matched)
        #expect(pair.candidates[0].reasons.contains("merchant_alias_match"))
    }

    @Test func ambiguousPairsAndOneToOneMatching() {
        let result = KMReconciliationEngine.run(statements: [statement("s1"), statement("s2")], receipts: [receipt("r1"), receipt("r2")])
        #expect(result.candidates.count == 4)
        #expect(result.candidates.allSatisfy { $0.reasons.contains("ambiguous_candidates") })
        #expect(result.statementResults.allSatisfy { $0.status == .needsReview && $0.reasonCodes.contains("ambiguous_candidates") })
        #expect(result.receiptResults.allSatisfy { $0.status == .needsReview })
        let unique = KMReconciliationEngine.run(statements: [statement("s1"), statement("s2", merchant: "無関係カフェ", date: "2026-09-11")], receipts: [receipt("r1")])
        #expect(unique.statementResults.filter { $0.status == .matched }.count == 1)
    }

    @Test func refundsPreferencesTopThreeAndFilters() {
        let refund = KMReconciliationEngine.run(statements: [statement("refund", kind: .refund)], receipts: [receipt("r")])
        #expect(refund.statementResults[0].reasonCodes == ["refund_not_supported"])
        let preferred = KMReconciliationEngine.run(statements: [statement("s")], receipts: [receipt("other", amount: 1160), receipt("same", merchant: "別表記", amount: 1160, account: "account-2")], preferredAccountIds: ["s": ["account-2"]])
        #expect(preferred.candidates.map(\.receiptId) == ["same", "other"])
        #expect(preferred.candidates[0].score == Decimal(string: "0.73")!)
        let many = KMReconciliationEngine.run(statements: [statement("s")], receipts: (1...5).map { receipt("r\($0)", date: "2026-09-10") })
        #expect(many.candidates.count == 3)
        #expect(many.candidates.map(\.rank) == [1, 2, 3])
        let filtered = KMReconciliationEngine.run(statements: [statement("resolved"), statement("remaining")], receipts: [receipt("used"), receipt("available")], excludedStatementIds: ["resolved"], excludedReceiptIds: ["used"], rejectedPairs: ["remaining\0available"])
        #expect(filtered.statementResults.map(\.statementTransactionId) == ["remaining"])
        #expect(filtered.receiptResults.map(\.receiptId) == ["available"])
        #expect(filtered.candidates.isEmpty)
    }

    @Test func rankingManualSuppressionAndAutomaticPairRetention() {
        let priority = KMReconciliationEngine.run(statements: [statement("s")], receipts: [
            receipt("merchant", merchant: "架空ストア新宿", amount: 1160, date: "2026-09-09"),
            receipt("date-amount", merchant: "無関係カフェ")
        ])
        #expect(priority.candidates.map(\.receiptId) == ["date-amount", "merchant"])

        let automaticRetained = KMReconciliationEngine.run(statements: [statement("s")], receipts: [
            receipt("automatic"), receipt("other-a", merchant: "別店舗A", date: "2026-09-09"),
            receipt("other-b", merchant: "別店舗B", date: "2026-09-11"), receipt("other-c", merchant: "別店舗C", date: "2026-09-12")
        ])
        #expect(automaticRetained.statementResults[0].status == .matched)
        #expect(automaticRetained.candidates.count == 3)
        #expect(automaticRetained.candidates[0].receiptId == "automatic")

        let manual = KMReconciliationEngine.run(statements: [statement("s")], receipts: [receipt("r")], manualStatementIds: ["s"])
        #expect(manual.statementResults[0].status == .needsReview)
        #expect(manual.candidates.count == 1)
        let unscoped = KMReconciliationEngine.run(statements: [statement("s")], receipts: [receipt("r", account: "other-account")])
        #expect(unscoped.statementResults[0].status == .matched)
    }

    @Test func rankingGuardPromotesAtExactlyPointOneFiveBoundary() {
        // Same inputs as the TS boundary test: 4400 yen gives a 132 yen
        // tolerance. r1 scores exactly 0.3, r2 scores exactly 0.15, so the
        // binary64 gap is exactly 0.15 and the assignment partner must lead.
        let statements = [
            statement("s1", merchant: "架空商店アルファ", amount: 4400),
            statement("s2", merchant: "架空商店アルファ", amount: 4400),
        ]
        let preferred: [String: Set<String>] = ["s2": ["acct-1"]]
        let exact = KMReconciliationEngine.run(statements: statements, receipts: [
            receipt("r1", merchant: "架空商店アルファ", amount: 4292, account: "acct-1"),
            receipt("r2", merchant: "無関係薬局", amount: 4268, account: "acct-2"),
        ], preferredAccountIds: preferred)
        let exactCandidates = exact.candidates.filter { $0.statementTransactionId == "s1" }
        #expect(exactCandidates.map(\.receiptId) == ["r2", "r1"])
        #expect(exactCandidates.first(where: { $0.receiptId == "r1" })?.score == Decimal(string: "0.3")!)
        #expect(exactCandidates.first(where: { $0.receiptId == "r2" })?.score == Decimal(string: "0.15")!)
        #expect(exact.statementResults.allSatisfy { $0.status == .needsReview })

        // One day farther gives r2 a 0.13125 score and a 0.16875 gap.
        let above = KMReconciliationEngine.run(statements: statements, receipts: [
            receipt("r1", merchant: "架空商店アルファ", amount: 4292, account: "acct-1"),
            receipt("r2", merchant: "無関係薬局", amount: 4268, date: "2026-09-09", account: "acct-2"),
        ], preferredAccountIds: preferred)
        let aboveCandidates = above.candidates.filter { $0.statementTransactionId == "s1" }
        #expect(aboveCandidates.map(\.receiptId) == ["r1", "r2"])
        #expect(aboveCandidates.first(where: { $0.receiptId == "r2" })?.score == Decimal(string: "0.13125")!)
        #expect(above.statementResults.allSatisfy { $0.status == .needsReview })
    }

    @Test func autoMatchMarginUsesRoundedJavaScriptBinary64() {
        let result = KMReconciliationEngine.run(statements: [statement("s", merchant: "abcdx")], receipts: [
            receipt("top", merchant: "abcdx"), receipt("runner-up", merchant: "abxyz"),
        ])
        #expect(result.statementResults.first?.status == .matched)
        #expect(result.statementResults.first?.matchedReceiptId == "top")
        #expect(KMReconciliationEngine.merchantSimilarity("abcdx", "abxyz") == Decimal(string: "0.25")!)
    }

    @Test func reconciliationAmountsMustBeSafeIntegers() {
        let maximum = KMReconciliationEngine.run(statements: [statement("safe", amount: KMYen.maxSafe)],
            receipts: [receipt("safe", amount: KMYen.maxSafe)])
        #expect(maximum.statementResults.first?.status == .matched)
        let unsafeStatement = KMReconciliationEngine.run(statements: [statement("unsafe", amount: KMYen.maxSafe + 1)],
            receipts: [receipt("safe", amount: KMYen.maxSafe)])
        #expect(unsafeStatement.candidates.isEmpty)
        #expect(unsafeStatement.statementResults.first?.status == .unmatchedStatement)
        let unsafeReceipt = KMReconciliationEngine.run(statements: [statement("safe", amount: KMYen.maxSafe)],
            receipts: [receipt("unsafe", amount: KMYen.maxSafe + 1)])
        #expect(unsafeReceipt.candidates.isEmpty)
    }

    @Test func tolerancesAndInputOrderingAreDeterministic() {
        for (amount, delta, expected) in [(1200, 100, true), (1200, 101, false), (10000, 300, true), (10000, 301, false)] {
            let result = KMReconciliationEngine.run(statements: [statement("s", amount: amount)], receipts: [receipt("r", merchant: "別の店", amount: amount - delta)])
            #expect(!result.candidates.isEmpty == expected)
        }
        let statements = [statement("s2"), statement("s1")]
        let receipts = [receipt("r5"), receipt("r4"), receipt("r3"), receipt("r2"), receipt("r1")]
        #expect(KMReconciliationEngine.run(statements: statements, receipts: receipts) == KMReconciliationEngine.run(statements: Array(statements.reversed()), receipts: Array(receipts.reversed())))
    }

    @Test func syntheticEvaluationDatasetScenarios() {
        let scenarios: [(String, String, Int, String, Int, String, KMReconciliationStatementResult.Status)] = [
            ("exact", "青空食堂", 1280, "2026-09-29", 1280, "2026-09-29", .matched),
            ("plus3", "青空食堂", 1280, "2026-09-29", 1280, "2026-10-02", .needsReview),
            ("plus7", "青空食堂", 1280, "2026-09-29", 1280, "2026-10-06", .needsReview),
            ("plus8", "青空食堂", 1280, "2026-09-29", 1280, "2026-10-07", .unmatchedStatement),
            ("amountDelta", "青空食堂", 1280, "2026-09-29", 1230, "2026-09-29", .needsReview),
            ("unrelated", "山川電器", 1280, "2026-09-29", 1280, "2026-09-29", .needsReview),
            ("noCandidate", "青空食堂", 1280, "2026-09-01", 3000, "2026-09-29", .unmatchedStatement),
            ("variant", "北口食堂", 1380, "2026-09-29", 1380, "2026-09-29", .matched),
        ]
        for (id, sm, sa, sd, ra, rd, status) in scenarios {
            let result = KMReconciliationEngine.run(statements: [statement("s-\(id)", merchant: sm, amount: sa, date: sd)], receipts: [receipt("r-\(id)", merchant: id == "unrelated" ? "海辺書房" : id == "variant" ? "北口 食堂" : sm, amount: ra, date: rd)])
            #expect(result.statementResults[0].status == status, "synthetic eval: \(id)")
        }
    }

    @Test func globalReviewAssignmentPromotesOnlyExistingCandidates() {
        let result = KMReconciliationEngine.run(
            statements: [
                statement("s1", merchant: "架空商店アルファ", amount: 1000),
                statement("s2", merchant: "無関係カフェ", amount: 1000),
            ],
            receipts: [
                receipt("r1", merchant: "架空商店アルファ", amount: 1000, account: "acct-1"),
                receipt("r2", merchant: "架空商店アルファ", amount: 1000, date: "2026-09-11", account: "acct-2"),
            ],
            preferredAccountIds: ["s2": ["acct-1"]])
        #expect(result.statementResults.map(\.status) == [.needsReview, .needsReview])
        #expect(result.candidates.filter { $0.statementTransactionId == "s1" }.map(\.receiptId) == ["r2", "r1"])
        #expect(result.candidates.filter { $0.statementTransactionId == "s2" }.map(\.receiptId) == ["r1", "r2"])
        #expect(Set(result.candidates.map { "\($0.statementTransactionId)\0\($0.receiptId)" }) == [
            "s1\0r1", "s1\0r2", "s2\0r1", "s2\0r2",
        ])
    }

    @Test func globalReviewAssignmentKeepsOldCandidateSetForAllConflict4x4() {
        let result = KMReconciliationEngine.run(
            statements: [0, 1, 2, 3].map { statement("s\($0)", merchant: "同一商店", amount: 1000, date: "2026-01-01") },
            receipts: [0, 1, 2, 3].map { receipt("r\($0)", merchant: "同一商店", amount: 1000, date: "2026-01-01", account: "acct-\($0)") })
        let receiptIds = { (statementId: String) in
            result.candidates.filter { $0.statementTransactionId == statementId }.map(\.receiptId)
        }
        #expect(receiptIds("s0") == ["r0", "r1", "r2"])
        #expect(Set(receiptIds("s1")) == ["r0", "r1", "r2"])
        #expect(Set(receiptIds("s2")) == ["r0", "r1", "r2"])
        #expect(receiptIds("s3") == ["r0", "r1", "r2"])
        #expect(!result.candidates.contains { $0.receiptId == "r3" })
        #expect(result.statementResults.map(\.status) == [.needsReview, .needsReview, .needsReview, .needsReview])
    }
}

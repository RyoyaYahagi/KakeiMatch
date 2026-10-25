import Testing
@testable import KakeiMatch

struct ReconciliationEngineTests {
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
        #expect(result.ruleVersion == "1.1.0")
        #expect(result.statementResults == [.init(statementTransactionId: "s1", status: .matched, matchedReceiptId: "r1", reasonCodes: ["automatic_high_confidence_match"])])
        #expect(result.candidates.first?.score == Decimal(string: "0.9")!)
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
        #expect(priority.candidates.map(\\.receiptId) == ["date-amount", "merchant"])

        let automaticRetained = KMReconciliationEngine.run(statements: [statement("s")], receipts: [
            receipt("automatic"), receipt("other-a", date: "2026-09-09"),
            receipt("other-b", date: "2026-09-11"), receipt("other-c", date: "2026-09-12")
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

    @Test func tolerancesAndInputOrderingAreDeterministic() {
        for (amount, delta, expected) in [(1200, 100, true), (1200, 101, false), (10000, 300, true), (10000, 301, false)] {
            let result = KMReconciliationEngine.run(statements: [statement("s", amount: amount)], receipts: [receipt("r", amount: amount - delta, merchant: "別の店")])
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
}

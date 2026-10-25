import Foundation

struct KMReconciliationReceipt: Equatable, Sendable {
    var receiptId: String
    var actualTransactionId: String
    var merchant: String
    var purchasedDate: KMDate
    var amountYen: Int
    var actualAccountId: String
}

enum KMReconciliationEngine {
    static let ruleVersion = "1.1.0"
    private static let candidateWindow = 7
    private static let autoWindow = 2
    private static let amountTolerance = 100
    private static let amountRatio = KMJSNumber("0.03")
    private static let candidateMerchantThreshold = KMJSNumber("0.7")
    private static let autoMerchantThreshold = KMJSNumber("0.72")
    private static let autoScoreThreshold = KMJSNumber("0.88")
    private static let marginThreshold = KMJSNumber("0.15")
    private struct Candidate {
        var statementId: String
        var receiptId: String
        var score: Decimal
        var autoScore: KMJSNumber
        var delta: Int
        var days: Int
        var similarity: KMJSNumber
        var aliasMatch: Bool
        var reasons: [String]
    }

    static func normalizeMerchant(_ merchant: String) -> String {
        let normalized = merchant.precomposedStringWithCompatibilityMapping
        let asciiLowercased = String(normalized.unicodeScalars.map { scalar -> Character in
            if scalar.value >= 65 && scalar.value <= 90 { return Character(UnicodeScalar(scalar.value + 32)!) }
            return Character(scalar)
        })
        let noWhitespace = asciiLowercased.unicodeScalars.filter { !KMJSString.isWhitespace($0) }
        let separators = Set("-‐‑‒–—―・,，.．/／\\:：;；|｜_＿()（）[]［］{}｛｝「」『』【】".unicodeScalars)
        return String(String.UnicodeScalarView(noWhitespace.filter { !separators.contains($0) }))
    }

    static func merchantSimilarity(_ left: String, _ right: String) -> Decimal {
        similarityNumber(left, right).decimalApproximation
    }
    private static func similarityNumber(_ left: String, _ right: String) -> KMJSNumber {
        let a = Array(normalizeMerchant(left).unicodeScalars)
        let b = Array(normalizeMerchant(right).unicodeScalars)
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        if a.elementsEqual(b) { return 1 }
        func bigrams(_ chars: [Unicode.Scalar]) -> Set<String> {
            guard chars.count > 1 else { return [] }
            return Set((0..<(chars.count - 1)).map { String(String.UnicodeScalarView([chars[$0], chars[$0 + 1]])) })
        }
        let aa = bigrams(a), bb = bigrams(b)
        guard !aa.isEmpty, !bb.isEmpty else { return 0 }
        return KMJSNumber(2 * aa.intersection(bb).count) / KMJSNumber(aa.count + bb.count)
    }

    static func aliasKey(_ left: String, _ right: String) -> String {
        [normalizeMerchant(left), normalizeMerchant(right)].sorted(by: jsUTF16Less).joined(separator: "\0")
    }

    static func pairKey(_ statementId: String, _ receiptId: String) -> String { statementId + "\0" + receiptId }

    static func run(
        statements: [KMStatementTransaction], receipts: [KMReconciliationReceipt],
        preferredAccountIds: [String: Set<String>] = [:], aliases: Set<String> = [],
        excludedStatementIds: Set<String> = [], excludedReceiptIds: Set<String> = [],
        rejectedPairs: Set<String> = [], manualStatementIds: Set<String> = []
    ) -> KMReconciliationResult {
        let statements = statements.filter { !excludedStatementIds.contains($0.id) }.sorted { less($0.id, $1.id) }
        let receipts = receipts.filter { !excludedReceiptIds.contains($0.receiptId) }.sorted { less($0.receiptId, $1.receiptId) }
        var receiptDays: [Int: [KMReconciliationReceipt]] = [:]
        for receipt in receipts {
            if let day = dayNumber(receipt.purchasedDate.rawValue) { receiptDays[day, default: []].append(receipt) }
        }
        var byStatement: [String: [Candidate]] = [:]
        var byReceipt: [String: [Candidate]] = [:]

        for statement in statements where statement.kind == .purchase {
            guard let sday = dayNumber(statement.usedDate.rawValue), safe(statement.amountYen) else { continue }
            for offset in -candidateWindow...candidateWindow {
                for receipt in receiptDays[sday + offset] ?? [] {
                    guard !rejectedPairs.contains(pairKey(statement.id, receipt.receiptId)), safe(receipt.amountYen),
                          let rday = dayNumber(receipt.purchasedDate.rawValue) else { continue }
                    let distance = abs(sday - rday)
                    let delta = abs(statement.amountYen - receipt.amountYen)
                    let tolerance = max(KMJSNumber(amountTolerance), KMJSNumber(statement.amountYen) * amountRatio)
                    guard KMJSNumber(delta) <= tolerance else { continue }
                    let similarity = similarityNumber(statement.merchant, receipt.merchant)
                    let alias = aliases.contains(aliasKey(statement.merchant, receipt.merchant))
                    let sameSource = preferredAccountIds[statement.id]?.contains(receipt.actualAccountId) ?? false
                    let dateScore = KMJSNumber(1) - KMJSNumber(distance) / 8
                    let amountScore = delta == 0 ? KMJSNumber(1) : max(0, KMJSNumber(1) - KMJSNumber(delta) / tolerance)
                    let merchantScore = alias ? KMJSNumber(1) : similarity
                    let score = (amountScore * KMJSNumber("0.55") + dateScore * KMJSNumber("0.30") + merchantScore * KMJSNumber("0.05") + (sameSource ? KMJSNumber("0.10") : 0)).roundedMillion().decimal
                    let autoScore = (amountScore * KMJSNumber("0.55") + dateScore * KMJSNumber("0.25") + merchantScore * KMJSNumber("0.20")).roundedMillion().binary
                    var reasons = [delta == 0 ? "amount_exact" : "amount_close", distance <= autoWindow ? "date_close" : "date_within_window"]
                    if similarity >= candidateMerchantThreshold { reasons.append("merchant_similar") }
                    if alias { reasons.append("merchant_alias_match") }
                    if sameSource { reasons.append("payment_source_match") }
                    let candidate = Candidate(statementId: statement.id, receiptId: receipt.receiptId, score: score, autoScore: autoScore, delta: delta, days: distance, similarity: similarity, aliasMatch: alias, reasons: reasons)
                    byStatement[statement.id, default: []].append(candidate)
                    byReceipt[receipt.receiptId, default: []].append(candidate)
                }
            }
        }
        for key in byStatement.keys { byStatement[key]!.sort(by: compare) }
        for key in byReceipt.keys { byReceipt[key]!.sort(by: compare) }

        var matchedStatements: [String: String] = [:]
        var matchedReceipts: [String: String] = [:]
        for statement in statements {
            let choices = byStatement[statement.id] ?? []
            guard let top = choices.first, !manualStatementIds.contains(statement.id) else { continue }
            let receiptChoices = byReceipt[top.receiptId] ?? []
            guard let receiptTop = receiptChoices.first else { continue }
            let strong = top.delta == 0 && top.days <= autoWindow && (top.similarity >= autoMerchantThreshold || top.aliasMatch) && top.autoScore >= autoScoreThreshold
            if receiptTop.statementId == statement.id && margin(top, choices.dropFirst().first) >= marginThreshold && margin(receiptTop, receiptChoices.dropFirst().first) >= marginThreshold && strong {
                matchedStatements[statement.id] = top.receiptId
                matchedReceipts[top.receiptId] = statement.id
            }
        }
        func ambiguous(_ candidate: Candidate) -> Bool {
            let s = byStatement[candidate.statementId] ?? [], r = byReceipt[candidate.receiptId] ?? []
            guard let st = s.first, let rt = r.first else { return true }
            return margin(st, s.dropFirst().first) < marginThreshold || margin(rt, r.dropFirst().first) < marginThreshold || st.receiptId != candidate.receiptId || rt.statementId != candidate.statementId
        }
        var output: [KMReconciliationCandidate] = []
        for statement in statements {
            let matched = matchedStatements[statement.id]
            let choices = (byStatement[statement.id] ?? []).sorted {
                if ($0.receiptId == matched) != ($1.receiptId == matched) { return $0.receiptId == matched }
                if $0.score != $1.score { return $0.score > $1.score }
                return compare($0, $1)
            }
            for (index, candidate) in choices.prefix(3).enumerated() {
                output.append(KMReconciliationCandidate(statementTransactionId: candidate.statementId, receiptId: candidate.receiptId, rank: index + 1, score: candidate.score, amountDeltaYen: candidate.delta, dateDistanceDays: candidate.days, merchantSimilarity: candidate.similarity.decimalApproximation, reasons: candidate.reasons + (ambiguous(candidate) ? ["ambiguous_candidates"] : [])))
            }
        }
        let statementResults = statements.map { statement -> KMReconciliationStatementResult in
            if statement.kind == .refund { return .init(statementTransactionId: statement.id, status: .unmatchedStatement, matchedReceiptId: nil, reasonCodes: ["refund_not_supported"]) }
            if let receipt = matchedStatements[statement.id] { return .init(statementTransactionId: statement.id, status: .matched, matchedReceiptId: receipt, reasonCodes: ["automatic_high_confidence_match"]) }
            let choices = byStatement[statement.id] ?? []
            let has = !choices.isEmpty
            return .init(statementTransactionId: statement.id, status: has ? .needsReview : .unmatchedStatement, matchedReceiptId: nil, reasonCodes: has ? ["candidate_requires_review"] + (choices.contains(where: ambiguous) ? ["ambiguous_candidates"] : []) : ["no_candidate"])
        }
        let receiptResults = receipts.map { receipt -> KMReconciliationReceiptResult in
            if let statement = matchedReceipts[receipt.receiptId] { return .init(receiptId: receipt.receiptId, status: .matched, matchedStatementTransactionId: statement, reasonCodes: ["automatic_high_confidence_match"]) }
            let choices = byReceipt[receipt.receiptId] ?? []
            let has = !choices.isEmpty
            return .init(receiptId: receipt.receiptId, status: has ? .needsReview : .unmatchedReceipt, matchedStatementTransactionId: nil, reasonCodes: has ? ["candidate_requires_review"] + (choices.contains(where: ambiguous) ? ["ambiguous_candidates"] : []) : ["no_candidate"])
        }
        return KMReconciliationResult(ruleVersion: ruleVersion, candidates: output, statementResults: statementResults, receiptResults: receiptResults)
    }

    private static func safe(_ amount: Int) -> Bool { amount >= 0 && amount <= KMYen.maxSafe }
    private static func margin(_ top: Candidate, _ second: Candidate?) -> KMJSNumber { top.autoScore - (second?.autoScore ?? 0) }
    private static func compare(_ a: Candidate, _ b: Candidate) -> Bool {
        if a.autoScore != b.autoScore { return a.autoScore > b.autoScore }
        if a.statementId != b.statementId { return less(a.statementId, b.statementId) }
        return less(a.receiptId, b.receiptId)
    }
    // Node's default localeCompare uses the runtime's en-US ICU collation in the supported
    // environment. Keep identifier sorting separate from JS Array.sort's UTF-16 code-unit order.
    private static func less(_ a: String, _ b: String) -> Bool {
        a.compare(b, options: [], range: nil, locale: Locale(identifier: "en_US")) == .orderedAscending
    }
    private static func jsUTF16Less(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }
    private static func dayNumber(_ value: String) -> Int? {
        guard let date = try? KMDate(value) else { return nil }
        let parts = date.rawValue.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard let instant = calendar.date(from: components) else { return nil }
        return calendar.ordinality(of: .day, in: .era, for: instant)
    }
}

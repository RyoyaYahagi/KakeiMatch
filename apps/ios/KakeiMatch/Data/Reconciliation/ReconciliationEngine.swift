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
    // 1.2.4 adds confirmed statement-prefix and corporate-form normalization (Issue #397).
    static let ruleVersion = "1.2.4"
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
        var autoSimilarity: KMJSNumber
        var aliasMatch: Bool
        var reasons: [String]
    }

    static func normalizeMerchant(_ merchant: String) -> String {
        // Compatibility folding may leave half-width voiced kana decomposed;
        // compose canonically so a second normalization pass matches TS NFKC.
        let normalized = merchant.precomposedStringWithCompatibilityMapping.precomposedStringWithCanonicalMapping
        let asciiLowercased = String(normalized.unicodeScalars.map { scalar -> Character in
            if scalar.value >= 65 && scalar.value <= 90 { return Character(UnicodeScalar(scalar.value + 32)!) }
            return Character(scalar)
        })
        let noWhitespace = String(asciiLowercased.unicodeScalars.filter { !KMJSString.isWhitespace($0) })
        let forms = ["株式会社", "(株)", "カブシキガイシャ"]
        var withoutCorporateForm = noWhitespace
        for _ in 0..<2 {
            let previous = withoutCorporateForm
            for form in forms {
                withoutCorporateForm = withoutCorporateForm.replacingOccurrences(of: form, with: "", options: .anchored)
                withoutCorporateForm = withoutCorporateForm.replacingOccurrences(of: form, with: "", options: [.anchored, .backwards])
            }
            if previous == withoutCorporateForm { break }
        }
        let noWhitespaceScalars = withoutCorporateForm.unicodeScalars
        let separators = Set("-‐‑‒–—―・,，.．/／\\:：;；|｜_＿()（）[]［］{}｛｝「」『』【】".unicodeScalars)
        return String(String.UnicodeScalarView(noWhitespaceScalars.filter { !separators.contains($0) }))
    }

    private static func normalizeStatementMerchant(_ merchant: String) -> String {
        normalizeMerchant(merchant).replacingOccurrences(of: "visa国内利用vs", with: "", options: .anchored)
    }

    static func merchantSimilarity(_ left: String, _ right: String) -> Decimal {
        similarityNumber(left, right).decimalApproximation
    }
    private static func similarityNumber(_ left: String, _ right: String, forReview: Bool = false) -> KMJSNumber {
        func scalars(_ value: String) -> [Unicode.Scalar] {
            let normalized = normalizeMerchant(value)
            let composed = normalized
            return composed.unicodeScalars.map { scalar in
                // Review ranking only; keep automatic matching and alias identity unchanged.
                if forReview && ((0x3041...0x3096).contains(scalar.value) || (0x309D...0x309E).contains(scalar.value)) {
                    return UnicodeScalar(scalar.value + 0x60)!
                }
                return scalar
            }
        }
        let a = scalars(left)
        let b = scalars(right)
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
        // Count exact-amount competitors from the full input before exclusions
        // and rejected pairs. Only purchase statements participate. The day /
        // amount indexes limit each count to the existing candidate window.
        var receiptAmountCounts: [Int: [Int: Int]] = [:]
        for receipt in receipts {
            guard let day = dayNumber(receipt.purchasedDate.rawValue), safe(receipt.amountYen) else { continue }
            receiptAmountCounts[day, default: [:]][receipt.amountYen, default: 0] += 1
        }
        var statementAmountCounts: [Int: [Int: Int]] = [:]
        for statement in statements where statement.kind == .purchase {
            guard let day = dayNumber(statement.usedDate.rawValue), safe(statement.amountYen) else { continue }
            statementAmountCounts[day, default: [:]][statement.amountYen, default: 0] += 1
        }
        func exactCount(_ index: [Int: [Int: Int]], day: Int, amount: Int) -> Int {
            (-candidateWindow...candidateWindow).reduce(0) { $0 + (index[day + $1]?[amount] ?? 0) }
        }

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
                    let statementMerchant = normalizeStatementMerchant(statement.merchant)
                    let merchantAutoSimilarity = similarityNumber(statementMerchant, receipt.merchant)
                    let similarity = similarityNumber(statementMerchant, receipt.merchant, forReview: true)
                    let alias = aliases.contains(aliasKey(statement.merchant, receipt.merchant))
                    let sameSource = preferredAccountIds[statement.id]?.contains(receipt.actualAccountId) ?? false
                    let uniqueExactAmountPair = delta == 0
                        && exactCount(receiptAmountCounts, day: sday, amount: statement.amountYen) == 1
                        && exactCount(statementAmountCounts, day: rday, amount: receipt.amountYen) == 1
                    let autoSimilarity = sameSource && uniqueExactAmountPair ? KMJSNumber(1) : merchantAutoSimilarity
                    let dateScore = KMJSNumber(1) - KMJSNumber(distance) / 8
                    let amountScore = delta == 0 ? KMJSNumber(1) : max(0, KMJSNumber(1) - KMJSNumber(delta) / tolerance)
                    let merchantScore = alias ? KMJSNumber(1) : similarity
                    let autoMerchantScore = alias ? KMJSNumber(1) : autoSimilarity
                    let score = (amountScore * KMJSNumber("0.55") + dateScore * KMJSNumber("0.15") + merchantScore * KMJSNumber("0.05") + (sameSource ? KMJSNumber("0.25") : 0)).roundedMillion().decimal
                    let autoScore = (amountScore * KMJSNumber("0.55") + dateScore * KMJSNumber("0.25") + autoMerchantScore * KMJSNumber("0.20")).roundedMillion().binary
                    var reasons = [delta == 0 ? "amount_exact" : "amount_close", distance <= autoWindow ? "date_close" : "date_within_window"]
                    if similarity >= candidateMerchantThreshold { reasons.append("merchant_similar") }
                    if alias { reasons.append("merchant_alias_match") }
                    if sameSource { reasons.append("payment_source_match") }
                    let candidate = Candidate(statementId: statement.id, receiptId: receipt.receiptId, score: score, autoScore: autoScore, delta: delta, days: distance, similarity: similarity, autoSimilarity: autoSimilarity, aliasMatch: alias, reasons: reasons)
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
            let strong = top.delta == 0 && top.days <= autoWindow && (top.autoSimilarity >= autoMerchantThreshold || top.aliasMatch) && top.autoScore >= autoScoreThreshold
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
        // Ranking runs strictly after automatic matching. It receives the
        // automatic pairs as fixed endpoints and cannot change a status.
        let reviewRanking = computeReviewAssignment(
            statements: statements, byStatement: byStatement,
            matchedStatements: matchedStatements, matchedReceipts: matchedReceipts,
            manualStatementIds: manualStatementIds)
        var output: [KMReconciliationCandidate] = []
        for statement in statements {
            let matched = matchedStatements[statement.id]
            let assigned = reviewRanking[statement.id]
            // Fix the 1.2.0 output set first, then reorder only within it.
            var choices = Array((byStatement[statement.id] ?? []).sorted {
                if ($0.receiptId == matched) != ($1.receiptId == matched) { return $0.receiptId == matched }
                if $0.score != $1.score { return $0.score > $1.score }
                return compare($0, $1)
            }.prefix(3))
            // Promote the partner only when it is nearly tied with the score
            // leader; otherwise the predictable score order wins. This 0.15
            // "nearly tied" width deliberately shares marginThreshold's value,
            // but the judgment is a review-score gap, not the automatic-match
            // margin. The gap uses the same binary64 arithmetic as TS.
            if matched == nil, let assigned,
               let assignedIndex = choices.firstIndex(where: { $0.receiptId == assigned }), assignedIndex > 0,
               reviewScoreGap(choices[0], choices[assignedIndex]) <= marginThreshold {
                choices.insert(choices.remove(at: assignedIndex), at: 0)
            }
            for (index, candidate) in choices.enumerated() {
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

    /// Review scores already have six decimal places; keep assignment totals exact.
    private static func reviewWeight(_ score: Decimal) -> Int {
        var scaled = score * 1_000_000
        var rounded = Decimal()
        NSDecimalRound(&rounded, &scaled, 0, .plain)
        return NSDecimalNumber(decimal: rounded).intValue
    }

    /// Review-score gap in the same binary64 arithmetic as TS, so the ranking
    /// guard's "nearly tied" boundary matches the JS engine exactly.
    private static func reviewScoreGap(_ top: Candidate, _ other: Candidate) -> KMJSNumber {
        let topScore = KMJSNumber(reviewWeight(top.score)) / KMJSNumber(1_000_000)
        let otherScore = KMJSNumber(reviewWeight(other.score)) / KMJSNumber(1_000_000)
        return topScore - otherScore
    }

    /// UTF-8 byte order, shared with the TypeScript assignment tie-break.
    private static func utf8Less(_ left: String, _ right: String) -> Bool {
        left.utf8.lexicographicallyPrecedes(right.utf8)
    }

    /// Assign only the still-undecided statements to still-undecided receipts.
    /// Automatic matches and manual statement decisions are fixed endpoints;
    /// callers also remove manually matched receipts through excludedReceiptIds.
    /// Edges are existing review candidates, so no candidate is added and no
    /// receipt is reserved. The result only chooses the first review row.
    private static func computeReviewAssignment(
        statements: [KMStatementTransaction],
        byStatement: [String: [Candidate]],
        matchedStatements: [String: String],
        matchedReceipts: [String: String],
        manualStatementIds: Set<String>
    ) -> [String: String] {
        let rows = statements.filter { statement in
            statement.kind == .purchase
                && matchedStatements[statement.id] == nil
                && !manualStatementIds.contains(statement.id)
                && (byStatement[statement.id] ?? []).contains { matchedReceipts[$0.receiptId] == nil }
        }.map(\.id).sorted(by: utf8Less)
        var columnSet = Set<String>()
        for statementId in rows {
            for candidate in (byStatement[statementId] ?? []) where matchedReceipts[candidate.receiptId] == nil {
                columnSet.insert(candidate.receiptId)
            }
        }
        let columns = columnSet.sorted(by: utf8Less)
        guard !rows.isEmpty, !columns.isEmpty else { return [:] }

        var rowIndex: [String: Int] = [:]
        for (index, id) in rows.enumerated() { rowIndex[id] = index }
        var columnIndex: [String: Int] = [:]
        for (index, id) in columns.enumerated() { columnIndex[id] = index }
        var weights = Array(repeating: Array(repeating: 0, count: columns.count), count: rows.count)
        for statementId in rows {
            for candidate in (byStatement[statementId] ?? []) where matchedReceipts[candidate.receiptId] == nil {
                guard let row = rowIndex[statementId], let column = columnIndex[candidate.receiptId] else { continue }
                weights[row][column] = reviewWeight(candidate.score)
            }
        }

        // Components share no rows or columns, so their lexicographic optima
        // are exactly the monolithic optimum.
        let rowCount = rows.count
        let columnCount = columns.count
        var adjacency = Array(repeating: [Int](), count: rowCount + columnCount)
        for row in 0..<rowCount {
            for column in 0..<columnCount where weights[row][column] > 0 {
                adjacency[row].append(rowCount + column)
                adjacency[rowCount + column].append(row)
            }
        }

        var visited = Array(repeating: false, count: rowCount + columnCount)
        var assignment: [String: String] = [:]
        for start in 0..<(rowCount + columnCount) where !visited[start] && !adjacency[start].isEmpty {
            var componentRows: [Int] = []
            var componentColumns: [Int] = []
            var stack = [start]
            visited[start] = true
            while let node = stack.popLast() {
                if node < rowCount { componentRows.append(node) } else { componentColumns.append(node - rowCount) }
                for next in adjacency[node] where !visited[next] {
                    visited[next] = true
                    stack.append(next)
                }
            }
            componentRows.sort()
            componentColumns.sort()
            guard !componentRows.isEmpty, !componentColumns.isEmpty else { continue }
            let localWeights = componentRows.map { row in componentColumns.map { column in weights[row][column] } }
            let localAssignment = KMReconciliationAssignment.lexicographicAssignment(
                localWeights, rowOrder: Array(0..<componentRows.count), columnOrder: Array(0..<componentColumns.count))
            for localRow in 0..<componentRows.count {
                let localColumn = localAssignment[localRow]
                guard localColumn >= 0 else { continue }
                assignment[rows[componentRows[localRow]]] = columns[componentColumns[localColumn]]
            }
        }
        return assignment
    }
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

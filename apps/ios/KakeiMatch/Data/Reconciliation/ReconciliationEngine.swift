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
    static let ruleVersion = "1.3.0"
    private static let candidateWindow = 7
    private static let autoWindow = 2
    private static let amountTolerance = 100
    private static let amountRatio = KMJSNumber("0.03")
    private static let candidateMerchantThreshold = KMJSNumber("0.7")
    private static let autoMerchantThreshold = KMJSNumber("0.72")
    private static let autoScoreThreshold = KMJSNumber("0.88")
    private static let marginThreshold = KMJSNumber("0.15")
    private static let globalAssignmentThreshold = 150_000
    private static let globalAssignmentReason = "global_assignment_pair"
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
    private static func similarityNumber(_ left: String, _ right: String, forReview: Bool = false) -> KMJSNumber {
        func scalars(_ value: String) -> [Unicode.Scalar] {
            let normalized = normalizeMerchant(value)
            // Foundation can leave half-width voiced kana decomposed after compatibility mapping.
            let composed = forReview ? normalized.precomposedStringWithCanonicalMapping : normalized
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
                    let autoSimilarity = similarityNumber(statement.merchant, receipt.merchant)
                    let similarity = similarityNumber(statement.merchant, receipt.merchant, forReview: true)
                    let alias = aliases.contains(aliasKey(statement.merchant, receipt.merchant))
                    let sameSource = preferredAccountIds[statement.id]?.contains(receipt.actualAccountId) ?? false
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

        // Candidate edges E are the existing candidates that already satisfy every hard
        // automatic-match condition. Manual statements are removed from the matrix.
        var assignmentCandidates: [String: [Candidate]] = [:]
        var assignmentReceiptIds = Set<String>()
        for statement in statements where statement.kind == .purchase && !manualStatementIds.contains(statement.id) {
            let eligible = (byStatement[statement.id] ?? []).filter(isGlobalAssignmentEligible)
            if eligible.isEmpty { continue }
            assignmentCandidates[statement.id] = eligible
            for candidate in eligible { assignmentReceiptIds.insert(candidate.receiptId) }
        }
        let assignmentRowOrder = assignmentCandidates.keys.sorted(by: utf8Less)
        let assignmentReceiptOrder = assignmentReceiptIds.sorted(by: utf8Less)
        let assignmentReceiptIndex = Dictionary(uniqueKeysWithValues: assignmentReceiptOrder.enumerated().map { ($0.element, $0.offset) })
        let assignmentWeights = assignmentRowOrder.map { statementId -> [Int] in
            var row = Array(repeating: 0, count: assignmentReceiptOrder.count)
            for candidate in assignmentCandidates[statementId] ?? [] {
                row[assignmentReceiptIndex[candidate.receiptId]!] = globalAssignmentWeight(candidate)
            }
            return row
        }

        // Assignment, Δ and the lexicographic tie-break are separable over the
        // connected components of E. Components share neither rows nor columns,
        // so summing their optima is exactly the monolithic optimum while keeping
        // each Hungarian matrix small.
        var assignedStatements: [String: Candidate] = [:]
        var assignedReceipts: [String: Candidate] = [:]
        var deltaByPair: [String: Int] = [:]
        for component in assignmentComponents(assignmentWeights) {
            var localWeights = component.rows.map { row in
                component.columns.map { column in assignmentWeights[row][column] }
            }
            let componentOptimum = KMReconciliationAssignment.maximumWeight(localWeights)
            let localAssignment = KMReconciliationAssignment.lexicographicAssignment(
                localWeights, rowOrder: Array(0..<component.rows.count), columnOrder: Array(0..<component.columns.count))

            for localRow in component.rows.indices {
                let localColumn = localAssignment[localRow]
                guard localColumn >= 0, localWeights[localRow][localColumn] > 0 else { continue }
                let statementId = assignmentRowOrder[component.rows[localRow]]
                let receiptId = assignmentReceiptOrder[component.columns[localColumn]]
                guard let candidate = (assignmentCandidates[statementId] ?? []).first(where: { $0.receiptId == receiptId }) else { continue }
                assignedStatements[statementId] = candidate
                assignedReceipts[receiptId] = candidate

                // Δe is evaluated independently against the original E. Removing
                // only e and re-optimizing inside its component keeps every other
                // edge available, so an equal-total alternative produces Δe = 0.
                let original = localWeights[localRow][localColumn]
                localWeights[localRow][localColumn] = 0
                let withoutEdge = KMReconciliationAssignment.maximumWeight(localWeights)
                localWeights[localRow][localColumn] = original
                deltaByPair[pairKey(statementId, receiptId)] = componentOptimum - withoutEdge
            }
        }

        var matchedStatements: [String: String] = [:]
        var matchedReceipts: [String: String] = [:]
        for statementId in assignmentRowOrder {
            guard let candidate = assignedStatements[statementId] else { continue }
            guard let delta = deltaByPair[pairKey(statementId, candidate.receiptId)], delta >= globalAssignmentThreshold else { continue }
            matchedStatements[statementId] = candidate.receiptId
            matchedReceipts[candidate.receiptId] = statementId
        }
        func ambiguous(_ candidate: Candidate) -> Bool {
            let s = byStatement[candidate.statementId] ?? [], r = byReceipt[candidate.receiptId] ?? []
            guard let st = s.first, let rt = r.first else { return true }
            return margin(st, s.dropFirst().first) < marginThreshold || margin(rt, r.dropFirst().first) < marginThreshold || st.receiptId != candidate.receiptId || rt.statementId != candidate.statementId
        }
        var output: [KMReconciliationCandidate] = []
        for statement in statements {
            let matched = matchedStatements[statement.id]
            let assigned = assignedStatements[statement.id]?.receiptId
            let preferred = matched ?? assigned
            let choices = (byStatement[statement.id] ?? []).sorted {
                if ($0.receiptId == preferred) != ($1.receiptId == preferred) { return $0.receiptId == preferred }
                if $0.score != $1.score { return $0.score > $1.score }
                return compare($0, $1)
            }
            for (index, candidate) in choices.prefix(3).enumerated() {
                var reasons = candidate.reasons
                if let assigned, matched == nil, candidate.receiptId == assigned {
                    reasons.append(globalAssignmentReason)
                }
                if matched == nil && ambiguous(candidate) { reasons.append("ambiguous_candidates") }
                output.append(KMReconciliationCandidate(statementTransactionId: candidate.statementId, receiptId: candidate.receiptId, rank: index + 1, score: candidate.score, amountDeltaYen: candidate.delta, dateDistanceDays: candidate.days, merchantSimilarity: candidate.similarity.decimalApproximation, reasons: reasons))
            }
        }
        let statementResults = statements.map { statement -> KMReconciliationStatementResult in
            if statement.kind == .refund { return .init(statementTransactionId: statement.id, status: .unmatchedStatement, matchedReceiptId: nil, reasonCodes: ["refund_not_supported"]) }
            if let receipt = matchedStatements[statement.id] { return .init(statementTransactionId: statement.id, status: .matched, matchedReceiptId: receipt, reasonCodes: ["automatic_high_confidence_match"]) }
            let choices = byStatement[statement.id] ?? []
            let has = !choices.isEmpty
            let assigned = assignedStatements[statement.id] != nil
            return .init(statementTransactionId: statement.id, status: has ? .needsReview : .unmatchedStatement, matchedReceiptId: nil,
                reasonCodes: has ? ["candidate_requires_review"] + (assigned ? [globalAssignmentReason] : []) + (choices.contains(where: ambiguous) ? ["ambiguous_candidates"] : []) : ["no_candidate"])
        }
        let receiptResults = receipts.map { receipt -> KMReconciliationReceiptResult in
            if let statement = matchedReceipts[receipt.receiptId] { return .init(receiptId: receipt.receiptId, status: .matched, matchedStatementTransactionId: statement, reasonCodes: ["automatic_high_confidence_match"]) }
            let choices = byReceipt[receipt.receiptId] ?? []
            let has = !choices.isEmpty
            let assigned = assignedReceipts[receipt.receiptId] != nil
            return .init(receiptId: receipt.receiptId, status: has ? .needsReview : .unmatchedReceipt, matchedStatementTransactionId: nil,
                reasonCodes: has ? ["candidate_requires_review"] + (assigned ? [globalAssignmentReason] : []) + (choices.contains(where: ambiguous) ? ["ambiguous_candidates"] : []) : ["no_candidate"])
        }
        return KMReconciliationResult(ruleVersion: ruleVersion, candidates: output, statementResults: statementResults, receiptResults: receiptResults)
    }

    private struct AssignmentComponent {
        var rows: [Int]
        var columns: [Int]
    }

    /// Connected components of the positive-weight bipartite graph.
    private static func assignmentComponents(_ weights: [[Int]]) -> [AssignmentComponent] {
        let rowCount = weights.count
        let columnCount = weights.first?.count ?? 0
        guard rowCount > 0, columnCount > 0 else { return [] }
        var adjacency = Array(repeating: [Int](), count: rowCount + columnCount)
        for row in 0..<rowCount {
            for column in 0..<columnCount where weights[row][column] > 0 {
                let receiptNode = rowCount + column
                adjacency[row].append(receiptNode)
                adjacency[receiptNode].append(row)
            }
        }
        var visited = Array(repeating: false, count: rowCount + columnCount)
        var components: [AssignmentComponent] = []
        for start in 0..<(rowCount + columnCount) where !visited[start] {
            var stack = [start]
            visited[start] = true
            var rows: [Int] = []
            var columns: [Int] = []
            while let node = stack.popLast() {
                if node < rowCount { rows.append(node) } else { columns.append(node - rowCount) }
                for next in adjacency[node] where !visited[next] {
                    visited[next] = true
                    stack.append(next)
                }
            }
            guard !rows.isEmpty, !columns.isEmpty else { continue }
            components.append(AssignmentComponent(rows: rows.sorted(), columns: columns.sorted()))
        }
        return components
    }

    private static func isGlobalAssignmentEligible(_ candidate: Candidate) -> Bool {
        candidate.delta == 0
            && candidate.days <= autoWindow
            && (candidate.autoSimilarity >= autoMerchantThreshold || candidate.aliasMatch)
            && candidate.autoScore >= autoScoreThreshold
    }
    private static func globalAssignmentWeight(_ candidate: Candidate) -> Int {
        candidate.autoScore.roundedMillionInt()
    }
    private static func utf8Less(_ a: String, _ b: String) -> Bool {
        a.utf8.lexicographicallyPrecedes(b.utf8)
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

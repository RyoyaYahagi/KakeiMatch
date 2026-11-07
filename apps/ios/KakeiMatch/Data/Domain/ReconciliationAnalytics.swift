import Foundation

struct KMReconciliationAnalysis: Codable, Equatable, Sendable {
    struct Item: Codable, Equatable, Sendable {
        var id: String
        var merchant: String
        var date: String
        var amountYen: Int
        var paymentSource: String
    }
    struct Event: Codable, Equatable, Sendable {
        var id: String = UUID().uuidString
        var at: Date
        var statementId: String
        var receiptId: String?
        var kind: String
        var source: String
        var resolution: String?
        var status: String?
        var errorCode: String?
    }
    var statements: [Item]
    var candidates: [Item]
    var events: [Event] = []
}

struct KMReconciliationAnalyticsSummary: Equatable, Sendable {
    var runs = 0, recordedRuns = 0, statements = 0, noCandidates = 0
    var manualMatches = 0, firstChoices = 0, rejected = 0, terminalDecisions = 0, failed = 0
    var lines: [String] {
        func rate(_ part: Int, _ total: Int) -> String {
            total == 0 ? "未集計（対象0件）" : "\(Int((Double(part) / Double(total) * 100).rounded()))%（\(part)/\(total)件）"
        }
        return ["保存した照合：\(recordedRuns)回（内容の記録がない過去の照合：\(runs - recordedRuns)回）", "分析対象の明細：\(statements)件",
                "1位の採用率：\(rate(firstChoices, manualMatches))", "候補なし率：\(rate(noCandidates, statements))",
                "候補の却下：\(rejected)件", "反映の失敗率：\(rate(failed, terminalDecisions))"]
    }
}

enum KMReconciliationAnalytics {
    static func summarize(_ runs: [KMReconciliationRun], includingTests: Bool = false) -> KMReconciliationAnalyticsSummary {
        let runs = runs.filter { includingTests || $0.mode != "test" }
        var summary = KMReconciliationAnalyticsSummary(runs: runs.count, recordedRuns: runs.filter { $0.analysis != nil }.count)
        var observations: [String: KMReconciliationStatementResult] = [:]
        var decisions: [String: (KMReconciliationAnalysis.Event, KMReconciliationRun)] = [:]
        let ordered = runs.sorted { $0.completedAt == $1.completedAt ? $0.runId < $1.runId : $0.completedAt < $1.completedAt }
        for run in ordered { for row in run.statementResults where !row.reasonCodes.contains("refund_not_supported") { observations[row.statementTransactionId] = row } }
        // Preserve insertion order for equal-time transitions.
        var indexedEvents: [(event: KMReconciliationAnalysis.Event, run: KMReconciliationRun, index: Int)] = []
        for run in ordered {
            for event in run.analysis?.events ?? [] { indexedEvents.append((event, run, indexedEvents.count)) }
        }
        indexedEvents.sort { a, b in a.event.at == b.event.at ? a.index < b.index : a.event.at < b.event.at }
        var rejected: Set<String> = []
        for (event, run, _) in indexedEvents {
            if event.kind == "rejected" { rejected.insert("\(run.runId)\0\(event.statementId)\0\(event.receiptId ?? "")") }
            else if event.kind == "undo" { decisions.removeValue(forKey: event.statementId) }
            else { decisions[event.statementId] = (event, run) }
        }
        summary.statements = observations.count
        summary.noCandidates = observations.values.filter { $0.status == .unmatchedStatement }.count
        summary.rejected = rejected.count
        for (event, run) in decisions.values {
            if event.resolution != "ignored" && (event.status == "applied" || event.status == "failed") { summary.terminalDecisions += 1 }
            if event.resolution != "ignored" && event.status == "failed" { summary.failed += 1 }
            guard event.source == "user", event.resolution == "same_expense", event.status == "applied",
                  let candidate = run.candidates.first(where: { $0.statementTransactionId == event.statementId && $0.receiptId == event.receiptId }) else { continue }
            summary.manualMatches += 1
            if candidate.rank == 1 { summary.firstChoices += 1 }
        }
        return summary
    }

    static func export(_ runs: [KMReconciliationRun], detailed: Bool, at: Date, test: Bool = false) throws -> Data {
        let runs = runs.filter { ($0.mode == "test") == test }
        var ids: [String: String] = [:]
        func id(_ value: String?) -> Any {
            guard let value else { return NSNull() }
            if detailed { return value }
            if ids[value] == nil { ids[value] = "item-\(ids.count + 1)" }
            return ids[value]!
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let summary = summarize(runs, includingTests: test)
        let result: [[String: Any]] = try runs.map { run in
            var row: [String: Any] = ["mode": run.mode ?? "normal", "runId": id(run.runId), "completedAt": formatter.string(from: run.completedAt), "ruleVersion": run.ruleVersion,
                "statements": run.statementResults.map { ["statementId": id($0.statementTransactionId), "status": $0.status.rawValue] },
                "candidates": run.candidates.map { c -> [String: Any] in
                    ["statementId": id(c.statementTransactionId), "receiptId": id(c.receiptId), "rank": c.rank, "score": NSDecimalNumber(decimal: c.score),
                     "amountDeltaYen": c.amountDeltaYen, "dateDistanceDays": c.dateDistanceDays, "merchantSimilarity": NSDecimalNumber(decimal: c.merchantSimilarity), "reasons": c.reasons]
                },
                "events": (run.analysis?.events ?? []).map { e -> [String: Any] in
                    ["id": id(e.id), "at": formatter.string(from: e.at), "statementId": id(e.statementId), "receiptId": id(e.receiptId),
                     "kind": e.kind, "source": e.source, "resolution": e.resolution as Any? ?? NSNull(), "status": e.status as Any? ?? NSNull(), "errorCode": e.errorCode as Any? ?? NSNull()]
                }]
            if detailed, let analysis = run.analysis {
                row["contents"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(["statements": analysis.statements, "candidates": analysis.candidates]))
            }
            return row
        }
        return try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "scope": test ? "test" : "normal", "mode": detailed ? "detailed" : "anonymous", "exportedAt": formatter.string(from: at),
            "summary": ["runs": summary.runs, "recordedRuns": summary.recordedRuns, "statements": summary.statements, "noCandidates": summary.noCandidates,
                        "manualMatches": summary.manualMatches, "firstChoices": summary.firstChoices, "rejected": summary.rejected, "terminalDecisions": summary.terminalDecisions, "failed": summary.failed,
                        "noCandidateRate": summary.statements > 0 ? Double(summary.noCandidates) / Double(summary.statements) as Any : NSNull(),
                        "firstChoiceRate": summary.manualMatches > 0 ? Double(summary.firstChoices) / Double(summary.manualMatches) as Any : NSNull(),
                        "failureRate": summary.terminalDecisions > 0 ? Double(summary.failed) / Double(summary.terminalDecisions) as Any : NSNull()], "runs": result], options: [.prettyPrinted, .sortedKeys])
    }
}

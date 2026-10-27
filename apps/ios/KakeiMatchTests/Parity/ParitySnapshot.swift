import Foundation
@testable import KakeiMatch

/// Read only Repository projection. No access to SQLite rows or the PWA golden here.
@MainActor
enum ParitySnapshot {
    static let null = NSNull()
    static func text(_ value: String?) -> Any {
        guard let value else { return null }
        let result = value.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? null : result
    }
    static func key(_ value: Any) -> String {
        // Canonical encoding is also used for structural diagnostics, not byte comparison of pretty JSON.
        String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), encoding: .utf8)!
    }
    static func sorted(_ rows: [[String: Any]], by field: String) -> [[String: Any]] {
        rows.sorted { left, right in
            let lhs = left[field] as? String ?? "", rhs = right[field] as? String ?? ""
            return lhs == rhs ? key(left) < key(right) : lhs < rhs
        }
    }
    static func read(_ store: KMSQLiteStore, scenario: String) async throws -> [String: Any] {
        let accounts = try await store.accounts(includeClosed: true)
        let categories = try await store.categories(includeHidden: true)
        func account(_ id: String?) -> Any { text(accounts.first { $0.id == id }?.name) }
        func category(_ id: String?) -> Any { text(categories.first { $0.id == id }?.name) }
        var transactions = try await store.transactions(matching: .init(limit: nil))
        // The search Repository hides incoming transfer rows; read the peer through its public lookup.
        for row in transactions where row.kind == .transfer {
            if let id = row.transferId, !transactions.contains(where: { $0.id == id }), let peer = try await store.transaction(id: id) { transactions.append(peer) }
        }
        var normalized: [[String: Any]] = transactions.map { row in
            ["date": row.date.rawValue, "amountYen": row.amountYen, "kind": row.kind.rawValue,
             "payee": row.kind == .transfer ? null : text(row.payeeName), "category": text(row.categoryName),
             "memo": text(row.memo), "account": account(row.accountId), "cleared": row.cleared,
             "excludedFromSpending": row.excludedFromSpending ?? false, "transferAccount": account(row.transferAccountId),
             "splits": sorted((row.splits ?? []).map { child in
                 ["category": category(child.categoryId), "amountYen": child.amountYen, "memo": text(child.memo), "payee": text(child.payeeName)]
             }, by: "category")]
        }
        normalized.sort { a, b in
            let dateA = a["date"] as! String, dateB = b["date"] as! String
            if dateA != dateB { return dateA > dateB }
            let payeeA = a["payee"] as? String ?? "", payeeB = b["payee"] as? String ?? ""
            if payeeA != payeeB { return payeeA < payeeB }
            let amountA = a["amountYen"] as! Int, amountB = b["amountYen"] as! Int
            if amountA != amountB { return amountA < amountB }
            for field in ["account", "memo"] {
                let left = a[field] as? String ?? "", right = b[field] as? String ?? ""
                if left != right { return left < right }
            }
            return key(a) < key(b)
        }
        let month = try KMYearMonth("2026-10")
        let home = try await store.home(month: month)
        let budget = try await store.budgetSummary(month: month)
        let statements = try await store.statementTransactions()
        let resolutions = try await store.resolutions()
        let run = try await store.latestRun()
        // UI history is not restricted to the latest run: resolved rows may be absent
        // from that run after PWA refreshes. Merge persisted decisions with pending rows.
        let statusItems: [[String: Any]] = statements.compactMap { statement in
            let result = run?.statementResults.first { $0.statementTransactionId == statement.id }
            let resolution = resolutions.first { $0.statementId == statement.id && $0.undoRequestedAt == nil }
            guard result != nil || resolution != nil else { return nil }
            var status = result?.status == .needsReview ? "needs-review" : result?.status == .matched ? "matched" : "unmatched"
            if resolution?.status == .failed { status = "failed" }
            else if resolution?.status == .applied {
                status = resolution?.resolution == .ignored ? "ignored" : resolution?.resolution == .sameExpense ? "matched" : "registered"
            }
            return ["merchant": text(statement.merchant), "date": statement.usedDate.rawValue, "amountYen": statement.amountYen, "status": status]
        }
        let counts = Dictionary(uniqueKeysWithValues: ["matched", "needs-review", "unmatched", "ignored", "failed"].map { status in
            (status, statusItems.filter { $0["status"] as? String == status }.count)
        })
        let items: [[String: Any]] = resolutions.map { resolution in
            let statement = statements.first { $0.id == resolution.statementId }
            return ["merchant": text(statement?.merchant ?? resolution.statementSnapshot?.merchant),
                    "date": (statement?.usedDate.rawValue ?? resolution.statementSnapshot?.usedDate.rawValue) as Any? ?? null,
                    "amountYen": resolution.statementAmountYen, "resolution": resolution.resolution.rawValue,
                    "status": resolution.status.rawValue, "undone": resolution.undoRequestedAt != nil]
        }
        // Repository categories are already usage/rank ordered; the PWA master UI separates
        // income and expense, and moves hidden categories after visible categories.
        let ordered = categories.enumerated().sorted { a, b in
            if a.element.isIncome != b.element.isIncome { return !a.element.isIncome }
            if a.element.hidden != b.element.hidden { return !a.element.hidden }
            return a.offset < b.offset
        }.map(\.element)
        return ["format": "kakeimatch-ledger-snapshot", "version": 1, "scenario": scenario,
                "accounts": sorted(accounts.map { ["name": text($0.name), "type": $0.accountType.rawValue, "closed": $0.closed, "balanceYen": $0.balanceYen] }, by: "name"),
                "categories": ordered.map { ["name": text($0.name), "group": text($0.groupName), "isIncome": $0.isIncome, "hidden": $0.hidden] },
                "transactions": normalized,
                "monthly": [["month": month.rawValue, "incomeYen": home.summary.incomeYen, "expenseYen": home.summary.expenseYen, "balanceYen": home.summary.balanceYen,
                             "categories": sorted(home.summary.categories.filter { $0.amountYen != 0 }.map { ["category": text($0.categoryName), "amountYen": $0.amountYen] }, by: "category")]],
                "budgets": [["month": month.rawValue, "budgetYen": budget.budgetYen, "spentYen": budget.spentYen, "remainingYen": budget.remainingYen,
                             "budgetConfigured": budget.budgetConfigured, "overallBudgetConfigured": budget.overallBudgetConfigured, "breakdownEnabled": budget.breakdownEnabled,
                             "categories": sorted(budget.categories.map { ["category": text($0.categoryName), "budgetYen": $0.budgetYen as Any? ?? null, "spentYen": $0.spentYen, "remainingYen": $0.remainingYen] }, by: "category")]],
                "reconciliation": ["counts": counts, "statements": sorted(statusItems, by: "merchant"), "items": sorted(items, by: "merchant")]]
    }

    static func differences(_ expected: Any, _ actual: Any, path: String = "$") -> [String] {
        if let lhs = expected as? [String: Any], let rhs = actual as? [String: Any] {
            return Set(lhs.keys).union(rhs.keys).sorted().flatMap { field -> [String] in
                guard let left = lhs[field], let right = rhs[field] else { return ["\(path).\(field): missing field"] }
                return differences(left, right, path: "\(path).\(field)")
            }
        }
        if let lhs = expected as? [Any], let rhs = actual as? [Any] {
            guard lhs.count == rhs.count else { return ["\(path): expected \(lhs.count) items, got \(rhs.count)"] }
            return lhs.indices.flatMap { differences(lhs[$0], rhs[$0], path: "\(path)[\($0)]") }
        }
        return key(expected) == key(actual) ? [] : ["\(path): PWA=\(key(expected)), iOS=\(key(actual))"]
    }
}

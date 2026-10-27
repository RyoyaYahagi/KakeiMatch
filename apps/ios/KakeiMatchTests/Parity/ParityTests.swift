import Foundation
import Testing
@testable import KakeiMatch

struct ParityTests {
    @MainActor
    @Test func pwaUIResultsMatchImportedAndReplayedHouseholds() async throws {
        let fixtures = try #require(Bundle(for: ParityBundleMarker.self).url(forResource: "ios-parity", withExtension: nil))
        let scenarios = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("scenarios.json"))) as! [[String: Any]]
        var results: [[String: Any]] = []
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("parity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }

        func golden(_ id: String, _ checkpoint: String = "ledger-snapshot") throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("\(id)/\(checkpoint).json"))) as! [String: Any]
        }
        func imported(_ id: String, _ checkpoint: String = "ledger-snapshot") async throws -> KMSQLiteStore {
            let store = try KMSQLiteStore(directory: temporary.appendingPathComponent(UUID().uuidString))
            let name = checkpoint == "ledger-snapshot" ? "household" : checkpoint
            try await store.importBackup(from: fixtures.appendingPathComponent("\(id)/\(name).kmb"))
            return store
        }
        for scenario in scenarios {
            let id = scenario["id"] as! String
            let checkpoints = scenario["checkpoints"] as? [String] ?? []
            var importDifferences: [String] = []
            for checkpoint in checkpoints + ["ledger-snapshot"] {
                do {
                    let store = try await imported(id, checkpoint)
                    let actual = try await ParitySnapshot.read(store, scenario: id)
                    let differences = ParitySnapshot.differences(try golden(id, checkpoint), actual)
                    importDifferences += differences.map { "\(checkpoint): \($0)" }
                } catch { importDifferences.append("\(checkpoint): import/read failed: \(error)") }
            }
            // Import differences are real failures, never withKnownIssue.
            #expect(importDifferences.isEmpty, "\(id) import: \(importDifferences.joined(separator: "; "))")
            var operationDifferences: [String] = []
            let gap = scenario["iosGap"] as? String
            if let gap {
                withKnownIssue("\(id): \(gap)") { Issue.record("Operation unavailable: \(gap)") }
            } else {
                do {
                    let store = try await imported("baseline")
                    func compare(_ checkpoint: String = "ledger-snapshot") async throws {
                        let actual = try await ParitySnapshot.read(store, scenario: id)
                        operationDifferences += ParitySnapshot.differences(try golden(id, checkpoint), actual).map { "\(checkpoint): \($0)" }
                    }
                    let accounts = try await store.accounts(includeClosed: true)
                    let categories = try await store.categories(includeHidden: true)
                    func account(_ name: String) throws -> String { try #require(accounts.first { $0.name == name }?.id) }
                    func category(_ name: String) throws -> String { try #require(categories.first { $0.name == name }?.id) }
                    switch id {
                    case "baseline": break
                    case "manual-expense-income-retry":
                        for (kind, payee, amount, categoryName, accountName) in [
                            (KMTransactionKind.expense, "Parity Shop", 1500, "食費", "現金"),
                            (.income, "Parity Employer", 200000, "給与", "メイン口座")
                        ] {
                            let input = try KMManualTransactionInput(kind: kind, amountYen: amount, date: KMDate("2026-10-15"), payeeName: payee,
                                categoryId: category(categoryName), accountId: account(accountName), memo: nil, importedId: "parity-\(payee)")
                            _ = try await store.saveManual(input, id: nil)
                            _ = try await store.saveManual(input, id: nil)
                        }
                    case "transfer-edit-delete":
                        var input = try KMTransferInput(amountYen: 10000, date: KMDate("2026-10-15"), sourceAccountId: account("メイン口座"), destinationAccountId: account("現金"), memo: nil, importedId: "parity-transfer")
                        let transfer = try await store.saveTransfer(input, id: nil)
                        try await compare("created")
                        input.amountYen = 12000
                        _ = try await store.saveTransfer(input, id: transfer.id)
                        try await compare("edited")
                        try await store.deleteTransaction(id: transfer.id)
                    case "account-close-reopen":
                        var value = KMAccount(id: "parity-empty", name: "Parity Empty")
                        try await store.saveAccount(value)
                        value.closed = true; try await store.saveAccount(value)
                        try await compare("closed")
                        value.closed = false; try await store.saveAccount(value)
                    case "category-hide-delete":
                        var value = try #require(categories.first { $0.name == "食費" })
                        value.hidden = true; try await store.saveCategory(value)
                        let temporaryCategory = KMCategory(id: "parity-temporary", name: "Parity Temporary")
                        try await store.saveCategory(temporaryCategory)
                        try await store.deleteCategory(id: temporaryCategory.id)
                    case "budget-change":
                        let settings = try await store.budgetSettings()
                        try await store.saveBudgetSettings(settings.applyingDefaultPlan(totalYen: 90000, breakdownEnabled: false, allocations: [:]))
                    case "reconciliation-confirm-cancel":
                        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-15T03:00:00Z"))
                        let run = try await store.runReconciliation(id: "parity-run", at: now)
                        let statement = try #require(try await store.statementTransactions().first { $0.merchant == "青空食堂" })
                        let candidate = try #require(run.candidates.first { $0.statementTransactionId == statement.id })
                        let resolution = try await store.confirmSameExpense(runId: run.runId, statementId: statement.id, receiptId: candidate.receiptId, at: now)
                        try await compare("confirmed")
                        try await store.undoSameExpense(id: resolution.id, at: now)
                        _ = try await store.runReconciliation(id: "parity-after-undo", at: now.addingTimeInterval(60))
                    default: Issue.record("Missing replay: \(id)")
                    }
                    try await compare()
                } catch { operationDifferences.append("replay failed: \(error)") }
                #expect(operationDifferences.isEmpty, "\(id) replay: \(operationDifferences.joined(separator: "; "))")
            }
            results.append(["id": id,
                "import": ["match": importDifferences.isEmpty, "differences": importDifferences],
                "replay": ["status": gap != nil ? "unimplemented" : operationDifferences.isEmpty ? "match" : "different", "differences": operationDifferences, "reason": gap as Any? ?? NSNull()]])
        }
        let report: [String: Any] = ["format": "kakeimatch-parity-report", "version": 1, "scenarios": results]
        let reportURL = temporary.appendingPathComponent("parity-report.json")
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: reportURL)
        // CI exports this actual test result from xcresult, not a hard-coded scenario manifest.
        try Attachment.record(contentsOf: reportURL, named: "parity-report.json")
    }
}

private final class ParityBundleMarker: NSObject {}

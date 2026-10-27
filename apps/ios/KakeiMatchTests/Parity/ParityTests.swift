import Foundation
import Testing
@testable import KakeiMatch

struct ParityTests {
    @MainActor
    @Test func baselineKMBProjectionProducesParityReport() async throws {
        let repositories = try KMFixtureLoader.load(named: "migration")
        let home = try await repositories.transactions.home(month: KMYearMonth("2026-10"))
        #expect(home.summary.expenseYen == 24730)
        #expect(home.summary.incomeYen == 248000)
        #expect(home.budget.budgetYen == 80000)

        let known: [(String, String)] = [
            ("manual-expense-income-retry", "PWA UIからの操作後snapshot出力が未実装"),
            ("receipt-single-and-split", "receipt posting serviceが未実装"),
            ("transfer-edit-delete", "振替片側編集時の対取引更新サービスが未実装"),
            ("transaction-delete-undo", "transaction deletion undo serviceが未実装"),
            ("statement-import-duplicate", "statement CSV write/import serviceが未実装"),
            ("account-close-reopen", "PWA操作後の比較goldenが未生成"),
            ("category-hide-delete", "PWA操作後の比較goldenが未生成"),
            ("budget-change", "PWA操作後の比較goldenが未生成"),
            ("reconciliation-confirm-cancel", "PWA操作後の比較goldenが未生成")
        ]
        for (id, reason) in known {
            withKnownIssue("既知の差: \(reason)") {
                Issue.record("\(id): \(reason)")
            }
        }
    }
}

import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct ReconciliationModelTests {
    @Test func fixtureSummaryMatchesPWAGoldenAndManualMatchUndo() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        #expect(model.errorMessage == nil)
        #expect(model.presentation.needsReview == 1 && model.presentation.unmatched == 2 && model.presentation.matched.count == 4 && model.presentation.waiting == 2)
        let row = try #require(model.presentation.pending.first)
        #expect(row.statement.merchant == "青空食堂" && row.reason == "金額が¥20違います")
        let candidate = try #require(row.candidates.first)
        await model.perform(.confirm(statement: row.id, receipt: candidate.receiptId), repositories: repositories)
        #expect(model.errorMessage == nil)
        #expect(model.presentation.needsReview == 0 && model.presentation.matched.count == 5)
        let manual = try #require(model.presentation.matched.first { $0.source == .user })
        #expect(try await repositories.transactions.transaction(id: candidate.transaction.id)?.amountYen == -880)
        await model.perform(.undo(manual.id), repositories: repositories)
        #expect(model.errorMessage == nil)
        #expect(model.presentation.needsReview == 1 && model.presentation.matched.count == 4)
        #expect(try await repositories.transactions.transaction(id: candidate.transaction.id)?.amountYen == -860)
    }
    @Test func rejectRerunsBeforeIgnoreAndNeverMutatesCandidate() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        let row = try #require(model.presentation.pending.first), candidate = try #require(row.candidates.first)
        await model.perform(.reject(statement: row.id, receipt: candidate.receiptId), repositories: repositories)
        #expect(model.errorMessage == nil)
        #expect(model.presentation.pending.first { $0.id == row.id }?.hasCandidates == false)
        await model.perform(.ignore(row.id), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.ignored.count == 1)
        #expect(try await repositories.transactions.transaction(id: candidate.transaction.id)?.amountYen == -860)
    }
    @Test func markAndClearReturnsToPendingWithoutAutomaticRegistration() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        let row = try #require(model.presentation.pending.first { $0.status == .unmatchedStatement })
        await model.perform(.suspect(row.id), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.suspected.count == 1 && model.presentation.unmatched == 1)
        await model.perform(.clearSuspected(row.id), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.suspected.isEmpty && model.presentation.unmatched == 2)
        #expect(try await repositories.reconciliation.resolutions().count == 4)
    }
    @Test func registerNoReceiptAndMissingCategoryDoesNotWrite() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        let row = try #require(model.presentation.pending.first { $0.status == .unmatchedStatement })
        await model.perform(.register(statement: row.id, category: "", destination: nil, excluded: false), repositories: repositories)
        #expect(model.errorMessage == "カテゴリを選択してください。")
        #expect(try await repositories.reconciliation.resolutions().count == 4)
        let category = try #require(model.categories.first)
        await model.perform(.register(statement: row.id, category: category.id, destination: nil, excluded: true), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.unmatched == 1)
        let resolution = try #require(try await repositories.reconciliation.resolutions().first { $0.statementId == row.id })
        let id = try #require(resolution.actualTransactionId)
        #expect(try await repositories.transactions.transaction(id: id)?.excludedFromSpending == true)
        // PWA does not add no_receipt decisions to the same_expense history.
        #expect(model.presentation.matched.count == 4)
    }
    @Test func staleCandidateCannotOverwriteEditedRecordAndRetryIsVisible() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        let row = try #require(model.presentation.pending.first), candidate = try #require(row.candidates.first)
        let original = candidate.transaction
        _ = try await repositories.transactions.saveManual(.init(kind: .expense, amountYen: 900, date: original.date,
            payeeName: original.payeeName ?? "", categoryId: try #require(original.categoryId), accountId: original.accountId,
            importedId: original.importedId ?? "test-edit"), id: original.id)
        await model.perform(.confirm(statement: row.id, receipt: candidate.receiptId), repositories: repositories)
        #expect(model.errorMessage == "照合の後に記録が変更されました。もう一度照合してから確認してください。")
        #expect(try await repositories.transactions.transaction(id: original.id)?.amountYen == -900)
        var decision = try #require(try await repositories.reconciliation.resolutions().first)
        decision.status = .failed
        try await repositories.reconciliation.saveResolution(decision)
        await model.load(repositories)
        #expect(model.presentation.failures.count == 1 && model.presentation.matched.count == 3)
        await model.perform(.retry(decision), repositories: repositories)
        #expect(model.errorMessage == nil && model.presentation.failures.isEmpty && model.presentation.matched.count == 4)
    }
    @Test func csvImportExplicitlyRunsAndDuplicateReimportStillRuns() async throws {
        let repositories = try KMFixtureLoader.load(named: "empty")
        let model = KMReconciliationModel(); await model.load(repositories)
        let csv = Data(("利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日\n"
            + "2026/10/01,合成店,本人,PayPayクレジット,1回,1000,0,1000,1000,0,0,2026/11/27\n").utf8)
        await model.importCSV(csv, provider: .paypayCard, repositories: repositories)
        #expect(model.errorMessage == nil)
        #expect(model.statements.count == 1 && model.presentation.unmatched == 1)
        #expect(model.message == "1件を取り込み、照合しました。重複 0件。対象外 0件、要確認 0件。")
        let first = try #require(model.run?.runId)
        await model.importCSV(csv, provider: .paypayCard, repositories: repositories)
        #expect(model.errorMessage == nil && model.run?.runId != first)
        #expect(model.statements.count == 1 && model.imports.count == 1)
        #expect(model.message == "0件を取り込み、照合しました。重複 1件。対象外 0件、要確認 0件。")
        await model.importCSV(Data("不正なCSV".utf8), provider: .paypayCard, repositories: repositories)
        #expect(model.errorMessage != nil)
        #expect(model.statements.count == 1 && model.imports.count == 1)
    }
    @Test func rerunAndConfigurationFailureAreVisible() async throws {
        let model = KMReconciliationModel(); await model.load(nil)
        #expect(model.errorMessage != nil && !model.isLoading)
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        await model.load(repositories); await model.rerun(repositories)
        #expect(model.errorMessage == nil)
        #expect(model.runFeedback == "照合しました。新しく一致したものはありません。")
    }
    @Test func unmatchedEntryInitialValuesUseMerchantCategoryRuleAndStayEmptyWithoutRule() async throws {
        let repositories = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMReconciliationModel(); await model.load(repositories)
        let unmatchedRows = model.presentation.pending.filter { $0.status == .unmatchedStatement && !$0.hasCandidates }
        #expect(unmatchedRows.count >= 2)
        let rowWithRule = unmatchedRows[0]
        let rowWithoutRule = unmatchedRows[1]

        let initialWithoutRule = await model.entryInitialValues(for: rowWithRule.statement, repositories: repositories)
        #expect(initialWithoutRule.categoryId == nil)
        let formWithoutRule = KMEntryFormModel(kind: .expense, initialValues: initialWithoutRule)
        await formWithoutRule.load(repositories)
        #expect(formWithoutRule.error == nil && formWithoutRule.categoryId.isEmpty)

        let targetCategory = try #require(model.categories.first)
        let alternativeCategory = try #require(model.categories.dropFirst().first)
        let normalizedMerchant = KMCategoryLearningService.normalizeName(rowWithRule.statement.merchant)
        for index in 1...3 {
            try await repositories.categoryLearning.saveCategoryObservation(KMCategoryLearningObservation(
                targetType: .categoryLearning, receiptId: "unmatched-rule-obs-\(index)",
                normalizedMerchant: normalizedMerchant, merchantCategoryId: targetCategory.id,
                items: [], confirmedAt: repositories.referenceDate))
        }
        await model.load(repositories)

        let initialWithRule = await model.entryInitialValues(for: rowWithRule.statement, repositories: repositories)
        #expect(initialWithRule.categoryId == targetCategory.id)
        let formWithRule = KMEntryFormModel(kind: .expense, initialValues: initialWithRule)
        await formWithRule.load(repositories)
        #expect(formWithRule.error == nil && formWithRule.categoryId == targetCategory.id)

        formWithRule.categoryId = alternativeCategory.id
        #expect(formWithRule.categoryId == alternativeCategory.id)

        let otherInitial = await model.entryInitialValues(for: rowWithoutRule.statement, repositories: repositories)
        #expect(otherInitial.categoryId == nil)
        let otherForm = KMEntryFormModel(kind: .expense, initialValues: otherInitial)
        await otherForm.load(repositories)
        #expect(otherForm.error == nil && otherForm.categoryId.isEmpty)
    }
    @Test func unmatchedEntryInitialValuesResolveStandardAccountNameAndPersistProvider() async throws {
        let repositories = try KMFixtureLoader.load(named: "empty")
        let card = KMAccount(id: "paypay-card-standard", name: "PayPayカード", accountType: .creditCard, statementProvider: nil)
        try await repositories.accounts.createAccount(card, startingBalanceYen: 0, startingDate: KMDate(instant: repositories.referenceDate))
        let model = KMReconciliationModel(); await model.load(repositories)
        let csv = Data(("利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日\n"
            + "2026/10/01,合成店,本人,PayPayクレジット,1回,1000,0,1000,1000,0,0,2026/11/27\n").utf8)
        await model.importCSV(csv, provider: .paypayCard, repositories: repositories)
        #expect(model.errorMessage == nil)
        let row = try #require(model.presentation.pending.first { $0.status == .unmatchedStatement })
        #expect(try await repositories.accounts.accounts(includeClosed: true).first { $0.id == card.id }?.statementProvider == nil)

        let initial = await model.entryInitialValues(for: row.statement, repositories: repositories)
        #expect(initial.accountId == card.id)
        let form = KMEntryFormModel(kind: .expense, initialValues: initial)
        await form.load(repositories)
        #expect(form.error == nil && form.accountId == card.id)

        let savedAccounts = try await repositories.accounts.accounts(includeClosed: true)
        #expect(savedAccounts.count == 1)
        #expect(savedAccounts[0].statementProvider == .paypayCard)
        #expect(model.accounts.first { $0.id == card.id }?.statementProvider == .paypayCard)

        // Once saved, renaming the account still resolves via statementProvider (step 1).
        var renamed = savedAccounts[0]
        renamed.name = "メインカード"
        try await repositories.accounts.saveAccount(renamed)
        await model.load(repositories)
        let secondInitial = await model.entryInitialValues(for: row.statement, repositories: repositories)
        #expect(secondInitial.accountId == card.id)
    }
    @Test func unmatchedEntryInitialValuesLeaveAccountEmptyWithoutMatchingAccount() async throws {
        let repositories = try KMFixtureLoader.load(named: "empty")
        let other = KMAccount(id: "other-card", name: "別名カード", accountType: .creditCard, statementProvider: nil)
        try await repositories.accounts.createAccount(other, startingBalanceYen: 0, startingDate: KMDate(instant: repositories.referenceDate))
        let model = KMReconciliationModel(); await model.load(repositories)
        let csv = Data(("利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日\n"
            + "2026/10/01,合成店,本人,PayPayクレジット,1回,1000,0,1000,1000,0,0,2026/11/27\n").utf8)
        await model.importCSV(csv, provider: .paypayCard, repositories: repositories)
        #expect(model.errorMessage == nil)
        let row = try #require(model.presentation.pending.first { $0.status == .unmatchedStatement })

        let initial = await model.entryInitialValues(for: row.statement, repositories: repositories)
        #expect(initial.accountId == nil)
        let form = KMEntryFormModel(kind: .expense, initialValues: initial)
        await form.load(repositories)
        #expect(form.error == nil && form.accountId.isEmpty)

        let savedAccounts = try await repositories.accounts.accounts(includeClosed: true)
        #expect(savedAccounts.count == 1)
        #expect(savedAccounts[0].statementProvider == nil)
    }
}

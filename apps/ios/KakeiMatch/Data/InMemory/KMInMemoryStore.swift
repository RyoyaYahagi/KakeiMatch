import Foundation

/// One actor-isolated, device-local fixture store shared by every repository in a container.
/// Nothing survives process exit. No network or database I/O is performed.
@MainActor final class KMInMemoryStore: TransactionRepository, AccountRepository, CategoryRepository, PayeeRepository,
    ReceiptRepository, StatementRepository, ReconciliationRepository, BudgetRepository, RecurringRepository,
    PayrollRepository, CategoryLearningRepository, SettingsRepository {
    var transactionValues: [KMTransaction]
    var accountValues: [KMAccount]
    var categoryValues: [KMCategory]
    var groupValues: [KMCategoryGroup]
    var receiptValues: [KMReceipt]
    /// Native IDs are preserved on import; fixture-only names are synthesized below.
    var payeeValues: [KMPayee] = []
    var imageValues: [String: Data] = [:]
    /// Unfinished editor input keyed by receipt ID; never part of the confirmed snapshot.
    var receiptDraftValues: [String: KMLocalRecord<KMReceiptDraft>] = [:]
    var importValues: [KMLocalRecord<KMStatementImport>] = []
    var statementValues: [KMStatementTransaction] = []
    var runValues: [KMReconciliationRun] = []
    var resolutionValues: [KMReconciliationResolution] = []
    var serviceState = KMServiceState()
    var ledgerWriteState = KMLedgerWriteState()
    var masterWriteState = KMMasterWriteState()
    /// New CSV originals are staged here and committed with their metadata and rows.
    var pendingArtifacts: [KMBackupArtifact] = []
    var reconciliationState: KMLocalReconciliation? {
        get { serviceState.reconciliation }
        set { serviceState.reconciliation = newValue }
    }
    var suspectedValues: [KMSuspectedStatement] = []
    var recurringValues: [KMRecurringTransaction] = []
    var payrollValues: [KMPayrollRecord] = []
    var payrollWriteFailureForTesting: Error?
    var ruleValues: [KMCategoryLearningRule] = []
    var ruleOverrides: [KMCategoryRuleOverride] = []
    var settingsValue = KMAppSettings()
    var monthlySettings: KMMonthlyBudgetSettings
    /// Untouched native Actual amounts are separate from KakeiMatch overrides.
    var nativeBudgets: [String: [String: Int]] = [:]

    init(transactions: [KMTransaction] = [], accounts: [KMAccount] = [], categories: [KMCategory] = [],
         groups: [KMCategoryGroup] = [], receipts: [KMReceipt] = [], budgetId: String = "fixture-budget") {
        transactionValues = transactions; accountValues = accounts; categoryValues = categories
        groupValues = groups; receiptValues = receipts; monthlySettings = .empty(budgetId: budgetId)
    }

    func transactions(matching query: KMTransactionQuery) async throws -> [KMTransaction] {
        try filteredTransactions(query, recentOrder: false)
    }
    private func filteredTransactions(_ query: KMTransactionQuery, recentOrder: Bool, includeIncomingTransfers: Bool = false) throws -> [KMTransaction] {
        if let start = query.startDate, let end = query.endDate, start > end { throw KMDataError.invalidData("開始日は終了日以前にしてください。") }
        if let min = query.minAmountYen, min < 0 { throw KMDataError.invalidData("最低金額を確認してください。") }
        if let max = query.maxAmountYen, max < 0 { throw KMDataError.invalidData("最高金額を確認してください。") }
        if let min = query.minAmountYen, let max = query.maxAmountYen, min > max { throw KMDataError.invalidData("最低金額は最高金額以下にしてください。") }
        guard query.keyword.count <= 200, query.limit.map({ $0 >= 0 }) ?? true else { throw KMDataError.invalidData("検索条件を確認してください。") }
        let keyword = normalize(query.keyword)
        let rows = try orderedTransactions(recentOrder: recentOrder, includeIncomingTransfers: includeIncomingTransfers).filter { row in
            let amount = abs(try KMYen.checked(row.amountYen))
            let receipt = receiptValues.first { $0.registration.status == .applied && $0.registration.actualTransactionId == row.id }
            let itemNames = receipt?.confirmedValue?.items?.map(\.name) ?? receipt?.extraction?.items.map(\.name) ?? []
            let childValues = (row.splits ?? []).flatMap { [$0.memo ?? "", $0.payeeName ?? ""] }
            let values = [row.payeeName ?? "", row.memo ?? ""] + itemNames + childValues
            return (query.kind == nil || row.kind == query.kind)
                && (query.startDate == nil || row.date >= query.startDate!) && (query.endDate == nil || row.date <= query.endDate!)
                && (query.accountId == nil || row.accountId == query.accountId || row.kind == .transfer && row.transferAccountId == query.accountId)
                && (query.categoryId == nil || row.categoryId == query.categoryId || (row.splits ?? []).contains { $0.categoryId == query.categoryId })
                && (keyword.isEmpty || values.contains { normalize($0).contains(keyword) })
                && (query.minAmountYen == nil || amount >= query.minAmountYen!)
                && (query.maxAmountYen == nil || amount <= query.maxAmountYen!)
        }
        return query.limit.map { Array(rows.prefix($0)) } ?? rows
    }
    func transaction(id: String) async throws -> KMTransaction? { transactionValues.first { $0.id == id } }
    func recordDays(matching query: KMTransactionQuery) async throws -> [KMRecordDay] {
        // PWA records-list filters the 100 most recent rows; search is a separate all-history query.
        var allKinds = query; allKinds.kind = nil
        let recent = try filteredTransactions(allKinds, recentOrder: true, includeIncomingTransfers: true)
        let visible = recent.filter { $0.kind != .transfer || $0.amountYen < 0 }
        return try KMTransactionAggregation.recordDays(visible, kind: query.kind)
    }
    func home(month: KMYearMonth) async throws -> KMHomeSnapshot {
        let summary = try monthly(month)
        return KMHomeSnapshot(summary: summary, budget: try await budgetSummary(month: month), recentRecords: Array(orderedTransactions().filter { $0.date.yearMonth == month }.prefix(3)))
    }
    func homeDashboard(month: KMYearMonth, today: KMDate) async throws -> KMHomeDashboard {
        KMHomeAggregation.make(snapshot: try await home(month: month), run: try await latestRun(),
            resolutions: try await resolutions(), suspected: try await suspectedStatements(),
            statements: try await statementTransactions(), today: today)
    }
    private func orderedTransactions(recentOrder: Bool = true, includeIncomingTransfers: Bool = false) -> [KMTransaction] {
        // PWA recent rows tie-break by ID descending; search results use ID ascending.
        transactionValues.filter { includeIncomingTransfers || $0.kind != .transfer || $0.amountYen < 0 }.sorted {
            if $0.date != $1.date { return $0.date > $1.date }
            return recentOrder ? $0.id > $1.id : $0.id < $1.id
        }
    }
    private func monthly(_ month: KMYearMonth) throws -> KMMonthlySummary {
        try KMTransactionAggregation.monthly(transactions: transactionValues, accounts: accountValues, categories: categoryValues, month: month)
    }
    private func normalize(_ value: String) -> String {
        value.precomposedStringWithCompatibilityMapping.lowercased(with: Locale(identifier: "ja_JP"))
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
    func openAccount(_ id: String) throws {
        guard accountValues.contains(where: { $0.id == id && !$0.closed }) else { throw KMDataError.invalidData("利用中の口座を選んでください。") }
    }
    func validCategory(_ id: String, income: Bool) throws {
        guard let category = categoryValues.first(where: { $0.id == id && !$0.hidden && $0.isIncome == income }),
              !groupValues.contains(where: { $0.id == category.groupId && $0.hidden }) else { throw KMDataError.invalidData("カテゴリを選んでください。") }
    }
    func validAmount(_ amount: Int) throws {
        guard try KMYen.checked(amount) > 0 else { throw KMDataError.invalidData("金額は1円以上で入力してください。") }
    }
    func setSpendingExclusion(id: String, excluded: Bool) async throws {
        guard let index = transactionValues.firstIndex(where: { $0.id == id }), transactionValues[index].kind == .expense else { throw KMDataError.invalidData("支出の記録を選んでください。") }
        transactionValues[index].excludedFromSpending = excluded
    }
    func deleteTransaction(id: String) async throws {
        _ = try await deleteTransaction(id: id, expected: nil, at: Date())
    }

    func accounts(includeClosed: Bool = true) async throws -> [KMAccount] {
        try await accounts(asOf: KMDate(instant: Date()), includeClosed: includeClosed)
    }
    func categories(includeHidden: Bool = true) async throws -> [KMCategory] {
        var usage: [String: Int] = [:]
        for row in transactionValues where row.kind != .transfer {
            let ids = Set(([row.categoryId] + (row.splits ?? []).map(\.categoryId)).compactMap { $0 })
            for id in ids { usage[id, default: 0] += 1 }
        }
        return categoryValues.enumerated().map { index, category in
            var value = category; value.usageCount = usage[value.id] ?? 0
            value.hidden = value.hidden || groupValues.contains { $0.id == value.groupId && $0.hidden }
            return (index, value)
        }.sorted {
            if $0.1.usageCount != $1.1.usageCount { return $0.1.usageCount > $1.1.usageCount }
            let left = KMCategoryOrdering.rank($0.1.name), right = KMCategoryOrdering.rank($1.1.name)
            return left == right ? $0.0 < $1.0 : left < right
        }.map(\.1).filter { includeHidden || !$0.hidden }
    }
    func categoryGroups() async throws -> [KMCategoryGroup] { groupValues }
    func payees() async throws -> [KMPayee] {
        let known = Set(payeeValues.map(\.name))
        return payeeValues + Array(Set(transactionValues.compactMap(\.payeeName)).subtracting(known)).sorted().map { KMPayee(id: "fixture-payee:" + $0, name: $0) }
    }
    func receipts() async throws -> [KMReceipt] { receiptValues.sorted { $0.createdAt > $1.createdAt } }
    func receipt(id: String) async throws -> KMReceipt? { receiptValues.first { $0.id == id } }
    func saveReceipt(_ receipt: KMReceipt) async throws {
        if let old = receiptValues.first(where: { $0.id == receipt.id }), old.registration.status != .pending, old != receipt {
            throw KMDataError.invalidData("登録済み・登録結果確認中のレシートは専用サービスで変更してください。")
        }
        receiptValues.removeAll { $0.id == receipt.id }; receiptValues.append(receipt)
    }
    func receiptImage(blobId: String) async throws -> Data? { imageValues[blobId] }
    /// Validation happens before any mutation. The caller commits receipt, bytes and metadata together.
    func saveReceiptImage(data: Data, contentType: String, replacingReceiptId: String?, at timestamp: Date) async throws -> KMReceipt {
        var validated = try KMReceiptImageValidation.validate(data, declaredContentType: contentType)
        var replaceBlobId: String?
        if let replacingReceiptId {
            guard let old = receiptValues.first(where: { $0.id == replacingReceiptId }) else {
                throw KMDataError.notFound("レシートがありません。")
            }
            guard old.registration.status == .pending, old.registration.actualTransactionId == nil else {
                throw KMDataError.invalidData("登録処理中、登録済み、または結果の確認が必要なレシートの画像は置き換えられません。")
            }
            replaceBlobId = old.image?.blobId
        }
        let id = "receipt:\(UUID().uuidString)"
        validated.blobId = "receipt-image:\(id.dropFirst("receipt:".count))"
        let receipt = KMReceipt(id: id, createdAt: timestamp, updatedAt: timestamp, image: validated,
            extraction: nil, aiSuggestion: .init(source: .unclassified),
            confirmedValue: nil, registration: .init(status: .pending, actualTransactionId: nil, lastError: nil))
        if let oldId = replacingReceiptId {
            receiptValues.removeAll { $0.id == oldId }
            receiptDraftValues.removeValue(forKey: oldId)
            if let blobId = replaceBlobId {
                imageValues.removeValue(forKey: blobId)
                pendingArtifacts.removeAll { $0.metadata.id == blobId }
            }
        }
        receiptValues.removeAll { $0.id == id }; receiptValues.append(receipt)
        imageValues[validated.blobId] = data
        pendingArtifacts.removeAll { $0.metadata.id == validated.blobId }
        pendingArtifacts.append(.init(metadata: .init(id: validated.blobId, ownerKind: "receipt", ownerId: id,
            contentType: validated.contentType, createdAt: timestamp, present: true, entry: nil,
            size: data.count, sha256: Self.sha256(data)), data: data))
        return receipt
    }
    func receiptDraft(receiptId: String) async throws -> KMReceiptDraft? { receiptDraftValues[receiptId]?.value }
    func saveReceiptDraft(_ draft: KMReceiptDraft, receiptId: String, at timestamp: Date) async throws {
        // PWA local-ui.ts uses putIfRecordExists: a deleted pending receipt is not recreated.
        guard receiptValues.contains(where: { $0.id == receiptId }) else {
            throw KMDataError.notFound("この確認待ちレシートは削除されています。画面を開き直してください。")
        }
        receiptDraftValues[receiptId] = .init(id: receiptId, kind: .categoryState, value: draft, updatedAt: timestamp)
    }
    func deleteReceiptDraft(receiptId: String) async throws { receiptDraftValues.removeValue(forKey: receiptId) }
    func deleteReceipt(id: String) async throws {
        guard let receipt = receiptValues.first(where: { $0.id == id }) else { throw KMDataError.notFound("レシートがありません。") }
        guard receipt.registration.status != .applied else { throw KMDataError.unsupported("登録済みレシートの削除サービスは後続PRで提供します。") }
        receiptValues.removeAll { $0.id == id }
        receiptDraftValues.removeValue(forKey: id)
        if let blobId = receipt.image?.blobId, !receiptValues.contains(where: { $0.image?.blobId == blobId }) {
            imageValues.removeValue(forKey: blobId)
            pendingArtifacts.removeAll { $0.metadata.id == blobId }
        }
    }
    func statementImports() async throws -> [KMLocalRecord<KMStatementImport>] { importValues }
    func statementTransactions() async throws -> [KMStatementTransaction] { statementValues }
    func latestRun() async throws -> KMReconciliationRun? { runValues.max { $0.createdAt < $1.createdAt } }
    func resolutions() async throws -> [KMReconciliationResolution] { resolutionValues }
    func saveResolution(_ resolution: KMReconciliationResolution) async throws {
        resolutionValues.removeAll { $0.id == resolution.id }; resolutionValues.append(resolution)
    }
    func suspectedStatements() async throws -> [KMSuspectedStatement] { suspectedValues }
    func setSuspected(statementId: String, markedAt: Date?) async throws {
        guard statementValues.contains(where: { $0.id == statementId }) else { throw KMDataError.notFound("明細がありません。") }
        suspectedValues.removeAll { $0.statementId == statementId }
        if let markedAt {
            suspectedValues.append(KMSuspectedStatement(statementId: statementId, markedAt: markedAt))
            recordManualReview(statementId: statementId)
        } else {
            clearSuspectedReview(statementId: statementId)
        }
    }
    func budgetSummary(month: KMYearMonth) async throws -> KMMonthlyBudgetSummary {
        let summary = try monthly(month)
        let categories = categoryValues.filter { !$0.isIncome }.map { category in
            KMBudgetAggregation.NativeCategory(categoryId: category.id, categoryName: category.name,
                nativeBudgetYen: nativeBudgets[month.rawValue]?[category.id] ?? 0,
                spentYen: summary.categories.first(where: { $0.categoryId == category.id })?.amountYen ?? 0)
        }
        return try KMBudgetAggregation.summarize(categories: categories, settings: monthlySettings, yearMonth: month)
    }
    func budgetSettings() async throws -> KMMonthlyBudgetSettings { monthlySettings }
    func saveBudgetSettings(_ settings: KMMonthlyBudgetSettings) async throws {
        let next = try settings.validated(for: monthlySettings.budgetId)
        let expenseIds = Set(categoryValues.filter { !$0.isIncome }.map(\.id))
        let allocationIds = Set(next.defaults.keys).union(next.monthlyOverrides.values.flatMap(\.keys))
        guard allocationIds.isSubset(of: expenseIds) else { throw KMDataError.invalidData("支出カテゴリを選んでください。") }
        monthlySettings = next
    }
    func recurringTransactions() async throws -> [KMRecurringTransaction] { recurringValues }
    func payrollRecords() async throws -> [KMPayrollRecord] { payrollValues }
    func savePayrollRecord(_ record: KMPayrollRecord) async throws {
        if let payrollWriteFailureForTesting { throw payrollWriteFailureForTesting }
        payrollValues.removeAll { $0.id == record.id }; payrollValues.append(record)
    }
    func registerPayrollRecord(_ record: KMPayrollRecord, income: KMManualTransactionInput) async throws -> KMPayrollRecord {
        if let existing = payrollValues.first(where: { $0.id == record.id }), existing.status == .applied {
            guard existing.confirmed == record.confirmed, existing.categoryId == record.categoryId,
                  existing.accountId == record.accountId,
                  existing.actualTransactionId == transactionValues.first(where: { $0.importedId == income.importedId })?.id else {
                throw KMDataError.invalidData("給与の登録内容が一致しません。")
            }
            return existing
        }
        let oldTransactions = transactionValues, oldPayroll = payrollValues, oldPayees = payeeValues
        let oldLedgerWrites = ledgerWriteState
        do {
            let transaction = try await saveManual(income, id: nil)
            var applied = payrollValues.first(where: { $0.id == record.id }) ?? record
            guard applied.confirmed == record.confirmed, applied.categoryId == record.categoryId,
                  applied.accountId == record.accountId else {
                throw KMDataError.invalidData("給与の登録内容が一致しません。")
            }
            applied.status = .applied
            applied.actualTransactionId = transaction.id
            try await savePayrollRecord(applied)
            return applied
        } catch {
            transactionValues = oldTransactions; payrollValues = oldPayroll; payeeValues = oldPayees
            ledgerWriteState = oldLedgerWrites
            throw error
        }
    }
    func categoryRules() async throws -> [KMCategoryLearningRule] {
        let available = Set(categoryValues.filter { !$0.isIncome }.map(\.id))
        let stats = KMCategoryLearningService.deriveStats(observations: serviceState.observations, availableCategoryIds: available)
        let derived = KMCategoryLearningService.applyingOverrides(stats, overrides: ruleOverrides, availableCategoryIds: available)
        if !serviceState.observations.isEmpty { return derived }
        return ruleValues.map { value in
            guard let override = ruleOverrides.first(where: { $0.targetType == value.targetType && $0.normalizedName == value.normalizedName }) else { return value }
            var result = value
            result.categoryId = override.categoryId ?? result.categoryId
            result.deleted = override.deleted == true; result.enabled = !result.deleted && override.disabled != true
            return result
        }
    }
    func setCategoryRuleOverride(_ value: KMCategoryRuleOverride) async throws {
        if let categoryId = value.categoryId { try validCategory(categoryId, income: false) }
        let old = ruleOverrides.first { $0.targetType == value.targetType && $0.normalizedName == value.normalizedName }
        let merged = KMCategoryRuleOverride(targetType: value.targetType, normalizedName: value.normalizedName,
            disabled: value.disabled ?? old?.disabled, deleted: value.deleted ?? old?.deleted, categoryId: value.categoryId ?? old?.categoryId)
        ruleOverrides.removeAll { $0.targetType == value.targetType && $0.normalizedName == value.normalizedName }; ruleOverrides.append(merged)
    }
    func resetCategoryRuleOverride(targetType: KMCategoryRuleStats.TargetType, normalizedName: String) async throws {
        ruleOverrides.removeAll { $0.targetType == targetType && $0.normalizedName == normalizedName }
    }
    func resetCategoryRuleOverrides() async throws { ruleOverrides = [] }
    func categoryObservations() async throws -> [KMCategoryLearningObservation] { serviceState.observations }
    func saveCategoryObservation(_ value: KMCategoryLearningObservation) async throws {
        guard !value.receiptId.isEmpty, !value.normalizedMerchant.isEmpty else { throw KMDataError.invalidData("分類履歴を確認してください。") }
        if let old = serviceState.observations.first(where: { $0.receiptId == value.receiptId }), old.confirmedAt > value.confirmedAt { return }
        if let index = serviceState.observations.firstIndex(where: { $0.receiptId == value.receiptId }) { serviceState.observations[index] = value }
        else { serviceState.observations.append(value) }
    }
    func recurringInput(_ value: KMRecurringTransaction) -> KMRecurringScheduleInput {
        .init(name: value.name, kind: value.kind, amountYen: value.amountYen, categoryId: value.categoryId, accountId: value.accountId,
            frequency: value.frequency, startDate: value.startDate, postsTransaction: value.postsTransaction)
    }
    func recurringOccurrences(scheduleId: String) async throws -> [KMRecurringProcessedOccurrence] {
        serviceState.occurrences.filter { $0.scheduleId == scheduleId }
    }
    func settings() async throws -> KMAppSettings { settingsValue }
    func saveSettings(_ settings: KMAppSettings) async throws { settingsValue = settings }
}
